import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const publishableKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Actor = {
  type: "leadership" | "staff";
  userId?: string;
  profileId?: string;
  name: string;
};

type TerminalAction = "ban" | "kick" | "unban";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await request.json();
    const actor = await requireActor(request, body);

    if (body.action === "submit") {
      return json(await submitCommand(actor, String(body.command ?? "")));
    }
    if (body.action === "history") {
      return json(await commandHistory(actor));
    }

    return json({ error: "Unknown action" }, 400);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Request failed" }, 400);
  }
});

async function requireActor(request: Request, body: Record<string, unknown>): Promise<Actor> {
  const authorization = request.headers.get("Authorization");
  if (authorization) {
    const userClient = createClient(supabaseUrl, publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: authorization } },
    });

    const { data, error } = await userClient.auth.getUser();
    if (!error && data.user?.app_metadata?.fri_role === "leadership") {
      const { data: leadershipRow, error: leadershipError } = await admin
        .from("leadership_users")
        .select("name")
        .eq("user_id", data.user.id)
        .maybeSingle();
      if (leadershipError) throw leadershipError;
      if (leadershipRow) {
        return {
          type: "leadership",
          userId: data.user.id,
          name: leadershipRow.name || data.user.email || "Leadership",
        };
      }
    }
  }

  const profileId = String(body.profileId ?? "");
  const sessionToken = String(body.sessionToken ?? "");
  if (!profileId || !sessionToken) throw new Error("Leadership or staff session required");

  const tokenHash = await sha256Hex(sessionToken);
  const { data: session, error: sessionError } = await admin
    .from("staff_sessions")
    .select("profile_id")
    .eq("profile_id", profileId)
    .eq("token_hash", tokenHash)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (sessionError) throw sessionError;
  if (!session) throw new Error("Invalid staff session");

  const { data: profile, error: profileError } = await admin
    .from("staff_profiles")
    .select("id, full_name, status")
    .eq("id", profileId)
    .maybeSingle();
  if (profileError) throw profileError;
  if (!profile || profile.status === "Suspended" || profile.status === "Archived") {
    throw new Error("Staff profile is not permitted to use Terminal");
  }

  return { type: "staff", profileId, name: profile.full_name || "Staff" };
}

async function submitCommand(actor: Actor, rawCommand: string) {
  const parsed = parseTerminalCommand(rawCommand);
  const resolved = await resolveRobloxUser(parsed.robloxUsername);

  const commandRecord = {
    action: parsed.action,
    roblox_username: resolved.username || parsed.robloxUsername,
    roblox_user_id: resolved.userId,
    raw_command: rawCommand.trim(),
    reason: parsed.reason,
    actor_type: actor.type,
    actor_user_id: actor.userId ?? null,
    actor_profile_id: actor.profileId ?? null,
    issued_by: actor.name,
    status: "queued",
  };

  const { data: command, error } = await admin
    .from("terminal_commands")
    .insert(commandRecord)
    .select()
    .single();
  if (error) throw error;

  if (resolved.userId) {
    if (parsed.action === "ban") {
      await admin
        .from("terminal_bans")
        .upsert(
          {
            roblox_user_id: resolved.userId,
            roblox_username: resolved.username || parsed.robloxUsername,
            reason: parsed.reason || "Outbound Terminal ban",
            command_id: command.id,
            issued_by: actor.name,
            actor_type: actor.type,
            actor_user_id: actor.userId ?? null,
            actor_profile_id: actor.profileId ?? null,
            active: true,
            banned_at: new Date().toISOString(),
          },
          { onConflict: "roblox_user_id" },
        );
    }

    if (parsed.action === "unban") {
      await admin
        .from("terminal_bans")
        .update({
          active: false,
          command_id: command.id,
        })
        .eq("roblox_user_id", resolved.userId);
    }
  }

  await Promise.all([
    admin.from("terminal_logs").insert({
      command_id: command.id,
      level: "info",
      message: `${actor.name} queued ${parsed.action} for ${command.roblox_username}`,
    }),
    admin.from("audit_logs").insert({
      actor_user_id: actor.userId ?? null,
      profile_id: actor.profileId ?? null,
      action: `terminal_${parsed.action}_queued`,
      target_table: "terminal_commands",
      target_id: command.id,
      details: { command: rawCommand.trim(), roblox_username: command.roblox_username, roblox_user_id: command.roblox_user_id },
    }),
  ]);

  return {
    ok: true,
    command: mapCommand(command),
    message: resolved.userId
      ? `${parsed.action.toUpperCase()} queued for ${command.roblox_username} (${resolved.userId})`
      : `${parsed.action.toUpperCase()} queued for ${command.roblox_username}; Roblox server will resolve the user ID`,
  };
}

async function commandHistory(actor: Actor) {
  let query = admin.from("terminal_commands").select("*").order("created_at", { ascending: false }).limit(50);
  if (actor.type === "staff") query = query.eq("actor_profile_id", actor.profileId);

  const { data: commandRows, error: commandError } = await query;
  if (commandError) throw commandError;

  const commandIds = (commandRows ?? []).map((command) => command.id);
  const logsQuery =
    actor.type === "leadership"
      ? admin.from("terminal_logs").select("*").order("created_at", { ascending: false }).limit(50)
      : commandIds.length
        ? admin.from("terminal_logs").select("*").in("command_id", commandIds).order("created_at", { ascending: false }).limit(50)
        : Promise.resolve({ data: [], error: null });

  const bansQuery =
    actor.type === "leadership"
      ? admin.from("terminal_bans").select("*").eq("active", true).order("banned_at", { ascending: false }).limit(50)
      : Promise.resolve({ data: [], error: null });

  const [logs, bans] = await Promise.all([logsQuery, bansQuery]);
  if (logs.error) throw logs.error;
  if (bans.error) throw bans.error;

  return {
    ok: true,
    commands: (commandRows ?? []).map(mapCommand),
    logs: logs.data ?? [],
    bans: bans.data ?? [],
  };
}

function parseTerminalCommand(command: string) {
  const clean = command.trim();
  const match = clean.match(/^\/(ban|kick|unban)\s+([A-Za-z0-9_]{3,20})(?:\s+(.{1,240}))?$/i);
  if (!match) throw new Error("Use /ban, /kick, or /unban RobloxUsername");
  return {
    action: match[1].toLowerCase() as TerminalAction,
    robloxUsername: match[2],
    reason: match[3]?.trim() || null,
  };
}

async function resolveRobloxUser(username: string): Promise<{ userId: number | null; username: string }> {
  try {
    const response = await fetch("https://users.roblox.com/v1/usernames/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }),
    });
    if (!response.ok) return { userId: null, username };
    const data = await response.json();
    const user = data?.data?.[0];
    if (!user?.id) return { userId: null, username };
    return { userId: Number(user.id), username: String(user.name || username) };
  } catch {
    return { userId: null, username };
  }
}

function mapCommand(row: Record<string, unknown>) {
  return {
    id: row.id,
    action: row.action,
    robloxUsername: row.roblox_username,
    robloxUserId: row.roblox_user_id,
    rawCommand: row.raw_command,
    reason: row.reason,
    status: row.status,
    actorType: row.actor_type,
    actorProfileId: row.actor_profile_id,
    actorUserId: row.actor_user_id,
    issuedBy: row.issued_by,
    resultMessage: row.result_message,
    serverJobId: row.server_job_id,
    placeId: row.place_id,
    createdAt: row.created_at,
    dispatchedAt: row.dispatched_at,
    completedAt: row.completed_at,
  };
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
