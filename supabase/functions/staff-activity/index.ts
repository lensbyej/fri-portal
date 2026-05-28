import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
  auth: { persistSession: false, autoRefreshToken: false },
});

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await request.json();
    const profileId = String(body.profileId ?? "");
    await assertStaffSession(profileId, String(body.sessionToken ?? ""));

    if (body.action === "start") {
      const { data, error } = await admin
        .from("activity_sessions")
        .insert({ profile_id: profileId, start_at: new Date().toISOString() })
        .select()
        .single();
      if (error) throw error;

      await admin.from("staff_profiles").update({ activity_status: "Active", updated_at: new Date().toISOString() }).eq("id", profileId);
      await writeAudit("activity_started", profileId, { activity_session_id: data.id });
      return json({ ok: true, session: data });
    }

    if (body.action === "end") {
      const sessionId = String(body.sessionId ?? "");
      const endedAt = new Date().toISOString();
      const { data: session, error: readError } = await admin
        .from("activity_sessions")
        .select("*")
        .eq("id", sessionId)
        .eq("profile_id", profileId)
        .is("end_at", null)
        .single();
      if (readError) throw readError;

      const durationMinutes = Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(session.start_at)) / 60000));
      const { error } = await admin
        .from("activity_sessions")
        .update({ end_at: endedAt, duration_minutes: durationMinutes })
        .eq("id", sessionId);
      if (error) throw error;

      await admin.from("staff_profiles").update({ activity_status: "Offline", updated_at: new Date().toISOString() }).eq("id", profileId);
      await writeAudit("activity_ended", profileId, { activity_session_id: sessionId, duration_minutes: durationMinutes });
      return json({ ok: true });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Request failed" }, 400);
  }
});

async function assertStaffSession(profileId: string, token: string) {
  if (!profileId || !token) throw new Error("Missing staff session");
  const tokenHash = await sha256Hex(token);
  const { data, error } = await admin
    .from("staff_sessions")
    .select("id")
    .eq("profile_id", profileId)
    .eq("token_hash", tokenHash)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Invalid staff session");
}

async function writeAudit(action: string, profileId: string, details: Record<string, unknown>) {
  await admin.from("audit_logs").insert({
    profile_id: profileId,
    action,
    target_table: "activity_sessions",
    details,
  });
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
