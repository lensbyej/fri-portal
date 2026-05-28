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

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const caller = await requireLeadership(request);
    const body = await request.json();

    if (body.action === "createAccount") {
      return json(await createLeadershipAccount(body, caller.id));
    }
    if (body.action === "resetPassword") {
      return json(await resetLeadershipPassword(body, caller.id));
    }

    return json({ error: "Unknown action" }, 400);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Request failed" }, 400);
  }
});

async function requireLeadership(request: Request) {
  const authorization = request.headers.get("Authorization");
  if (!authorization) throw new Error("Missing authorization");

  const userClient = createClient(supabaseUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authorization } },
  });

  const { data, error } = await userClient.auth.getUser();
  if (error || !data.user) throw new Error("Invalid leadership session");

  const role = data.user.app_metadata?.fri_role;
  if (role !== "leadership") throw new Error("Leadership role required");

  const { data: leadershipRow, error: leadershipError } = await admin
    .from("leadership_users")
    .select("user_id")
    .eq("user_id", data.user.id)
    .maybeSingle();
  if (leadershipError) throw leadershipError;
  if (!leadershipRow) throw new Error("Leadership account not registered");

  return data.user;
}

async function createLeadershipAccount(body: Record<string, unknown>, actorUserId: string) {
  const email = String(body.email ?? "").trim().toLowerCase();
  const name = String(body.name ?? "").trim();
  const role = String(body.role ?? "Leadership").trim();
  const password = String(body.password ?? "");

  if (!email || !name || !password || password.length < 10) {
    throw new Error("Name, email, and a temporary password of at least 10 characters are required");
  }

  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { name },
    app_metadata: { fri_role: "leadership" },
  });
  if (error) throw error;
  if (!data.user) throw new Error("Unable to create user");

  const { error: profileError } = await admin.from("leadership_users").insert({
    user_id: data.user.id,
    name,
    email,
    role,
  });
  if (profileError) throw profileError;

  await writeAudit(actorUserId, "leadership_account_created", data.user.id, { email, role });

  return {
    ok: true,
    account: {
      id: data.user.id,
      name,
      email,
      role,
    },
  };
}

async function resetLeadershipPassword(body: Record<string, unknown>, actorUserId: string) {
  const userId = String(body.userId ?? "");
  const password = String(body.password ?? "");
  if (!userId || !password || password.length < 10) {
    throw new Error("User ID and a temporary password of at least 10 characters are required");
  }

  const { error } = await admin.auth.admin.updateUserById(userId, { password });
  if (error) throw error;

  await writeAudit(actorUserId, "leadership_password_reset", userId, { user_id: userId });
  return { ok: true };
}

async function writeAudit(actorUserId: string, action: string, targetId: string, details: Record<string, unknown>) {
  await admin.from("audit_logs").insert({
    actor_user_id: actorUserId,
    action,
    target_table: "leadership_users",
    target_id: targetId,
    details,
  });
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
