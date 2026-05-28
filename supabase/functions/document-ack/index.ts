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
    const documentId = String(body.documentId ?? "");
    await assertStaffSession(profileId, String(body.sessionToken ?? ""));

    const { error } = await admin.from("document_acknowledgements").upsert(
      {
        document_id: documentId,
        profile_id: profileId,
        opened_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
      },
      { onConflict: "document_id,profile_id" },
    );
    if (error) throw error;

    await admin.from("audit_logs").insert({
      profile_id: profileId,
      action: "document_completed",
      target_table: "documents",
      target_id: documentId,
      details: { document_id: documentId },
    });

    return json({ ok: true });
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
