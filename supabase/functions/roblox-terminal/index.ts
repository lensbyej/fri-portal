import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-outbound-engine-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const engineKey = Deno.env.get("OUTBOUND_ENGINE_KEY") ?? "";
let cachedEngineKeyHash: string | null | undefined;
let cachedEngineKeyHashAt = 0;

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    await requireEngine(request);
    const body = await request.json();
    const action = String(body.action ?? "");

    if (action === "poll") return json(await pollCommands(body));
    if (action === "ack") return json(await acknowledgeCommand(body));
    if (action === "banned-users") return json(await bannedUsers());
    if (action === "check-ban") return json(await checkBan(body));
    if (action === "heartbeat") return json({ ok: true, checkedAt: new Date().toISOString() });

    return json({ error: "Unknown action" }, 400);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Request failed" }, 400);
  }
});

async function requireEngine(request: Request) {
  const provided = request.headers.get("x-outbound-engine-key") || "";
  if (!provided) throw new Error("Missing engine key");
  if (engineKey && provided === engineKey) return;

  const expectedHash = await loadEngineKeyHash();
  if (!expectedHash) throw new Error("Terminal engine key is not configured");

  const providedHash = await sha256Hex(provided);
  if (providedHash !== expectedHash) throw new Error("Invalid engine key");
}

async function loadEngineKeyHash() {
  if (cachedEngineKeyHash !== undefined && Date.now() - cachedEngineKeyHashAt < 60_000) {
    return cachedEngineKeyHash;
  }

  const { data, error } = await admin
    .from("portal_settings")
    .select("value")
    .eq("key", "terminal_engine")
    .maybeSingle();
  if (error) throw error;

  const value = data?.value as { keyHash?: string } | null;
  cachedEngineKeyHash = typeof value?.keyHash === "string" ? value.keyHash : null;
  cachedEngineKeyHashAt = Date.now();
  return cachedEngineKeyHash;
}

async function pollCommands(body: Record<string, unknown>) {
  const serverJobId = String(body.serverJobId ?? "");
  const placeId = Number(body.placeId ?? 0) || null;
  const staleCutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  await admin
    .from("terminal_commands")
    .update({
      status: "failed",
      result_message: "No Roblox server completed this command within 5 minutes",
      completed_at: new Date().toISOString(),
    })
    .eq("status", "sent")
    .lt("created_at", staleCutoff);

  const { data: commands, error } = await admin
    .from("terminal_commands")
    .select("*")
    .in("status", ["queued", "sent"])
    .gte("created_at", staleCutoff)
    .order("created_at", { ascending: true })
    .limit(20);
  if (error) throw error;

  const ids = (commands ?? []).filter((command) => command.status === "queued").map((command) => command.id);
  if (ids.length) {
    const { error: updateError } = await admin
      .from("terminal_commands")
      .update({
        status: "sent",
        dispatched_at: new Date().toISOString(),
        result_message: "Broadcast to Roblox servers",
        place_id: placeId,
      })
      .in("id", ids)
      .eq("status", "queued");
    if (updateError) throw updateError;
  }

  if (ids.length) {
    await admin.from("terminal_logs").insert({
      level: "info",
      message: `Broadcast ${ids.length} command(s) to Roblox servers`,
      server_job_id: serverJobId || null,
      place_id: placeId,
    });
  }

  return {
    ok: true,
    checkedAt: new Date().toISOString(),
    commands: (commands ?? []).map((row) => ({
      id: row.id,
      action: row.action,
      robloxUsername: row.roblox_username,
      robloxUserId: row.roblox_user_id,
      reason: row.reason,
      rawCommand: row.raw_command,
      issuedBy: row.issued_by,
    })),
  };
}

async function acknowledgeCommand(body: Record<string, unknown>) {
  const commandId = String(body.commandId ?? "");
  const status = String(body.status ?? "completed");
  const message = String(body.message ?? "");
  const robloxUserId = body.robloxUserId ? Number(body.robloxUserId) : null;
  const robloxUsername = String(body.robloxUsername ?? "");
  const serverJobId = String(body.serverJobId ?? "");
  const placeId = Number(body.placeId ?? 0) || null;

  if (!commandId || !["completed", "failed"].includes(status)) throw new Error("Invalid acknowledgement");

  const { data: command, error: readError } = await admin
    .from("terminal_commands")
    .select("*")
    .eq("id", commandId)
    .maybeSingle();
  if (readError) throw readError;
  if (!command) throw new Error("Command not found");
  if (command.status === "completed") return { ok: true, ignored: true };

  const { error: updateError } = await admin
    .from("terminal_commands")
    .update({
      status,
      result_message: message || null,
      roblox_user_id: robloxUserId ?? command.roblox_user_id,
      roblox_username: robloxUsername || command.roblox_username,
      server_job_id: serverJobId || command.server_job_id,
      place_id: placeId ?? command.place_id,
      completed_at: new Date().toISOString(),
    })
    .eq("id", commandId);
  if (updateError) throw updateError;

  if (status === "completed" && command.action === "ban" && (robloxUserId || command.roblox_user_id)) {
    await admin
      .from("terminal_bans")
      .upsert(
        {
          roblox_user_id: robloxUserId || command.roblox_user_id,
          roblox_username: robloxUsername || command.roblox_username,
          reason: command.reason || "Outbound Terminal ban",
          command_id: commandId,
          issued_by: command.issued_by,
          actor_type: command.actor_type,
          actor_user_id: command.actor_user_id,
          actor_profile_id: command.actor_profile_id,
          active: true,
          banned_at: new Date().toISOString(),
        },
        { onConflict: "roblox_user_id" },
      );
  }

  if (status === "completed" && command.action === "unban" && (robloxUserId || command.roblox_user_id)) {
    await admin
      .from("terminal_bans")
      .update({
        active: false,
        command_id: commandId,
      })
      .eq("roblox_user_id", robloxUserId || command.roblox_user_id);
  }

  await admin.from("terminal_logs").insert({
    command_id: commandId,
    level: status === "completed" ? "info" : "error",
    message: message || `Command ${status}`,
    server_job_id: serverJobId || null,
    place_id: placeId,
  });

  return { ok: true };
}

async function bannedUsers() {
  const { data, error } = await admin
    .from("terminal_bans")
    .select("*")
    .eq("active", true)
    .order("banned_at", { ascending: false });
  if (error) throw error;

  const bans = data ?? [];
  return {
    ok: true,
    count: bans.length,
    bannedUserIds: bans.map((ban) => tostring(ban.roblox_user_id)),
    bans: bans.map((ban) => ({
      userId: ban.roblox_user_id,
      username: ban.roblox_username,
      reason: ban.reason,
      banDate: ban.banned_at,
    })),
  };
}

async function checkBan(body: Record<string, unknown>) {
  const userId = Number(body.userId ?? 0);
  if (!userId) return { banned: false, message: "Missing userId" };

  const { data, error } = await admin
    .from("terminal_bans")
    .select("*")
    .eq("roblox_user_id", userId)
    .eq("active", true)
    .maybeSingle();
  if (error) throw error;
  if (!data) return { banned: false };

  return {
    banned: true,
    userId: data.roblox_user_id,
    username: data.roblox_username,
    reason: data.reason,
    banDate: data.banned_at,
  };
}

function tostring(value: unknown) {
  return String(value ?? "");
}

async function sha256Hex(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
