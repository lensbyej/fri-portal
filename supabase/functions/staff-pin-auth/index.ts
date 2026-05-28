import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type StaffProfileRow = {
  id: string;
  kind: string;
  profile_photo_path: string | null;
  full_name: string;
  username: string | null;
  contractor_id: string | null;
  pin_salt: string;
  pin_hash: string;
  role: string | null;
  department: string | null;
  tags: string[];
  employment_type: string;
  join_date: string | null;
  status: string;
  notes: string | null;
  notes_visible: boolean;
  activity_status: string;
  service_type: string | null;
  contract_amount: number | null;
  payment_status: string | null;
  start_date: string | null;
  end_date: string | null;
};

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await request.json();
    if (body.action === "lookup") {
      return json(await lookupProfile(String(body.identifier ?? "")));
    }
    if (body.action === "verify") {
      return json(await verifyPin(String(body.profileId ?? ""), String(body.pin ?? "")));
    }
    return json({ error: "Unknown action" }, 400);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Request failed" }, 400);
  }
});

async function lookupProfile(identifier: string) {
  const clean = identifier.trim();
  if (!clean) return { found: false };

  const profile = await findByIdentifier(clean);
  if (!profile) return { found: false };

  return {
    found: true,
    profile: { id: profile.id },
  };
}

async function verifyPin(profileId: string, pin: string) {
  if (!/^\d{4}$/.test(pin)) return { authorized: false };

  const { data: profile, error } = await admin
    .from("staff_profiles")
    .select("*")
    .eq("id", profileId)
    .maybeSingle<StaffProfileRow>();

  if (error) throw error;
  if (!profile) return { authorized: false };

  const expected = await sha256Hex(`${profile.pin_salt}:${pin}`);
  if (expected !== profile.pin_hash) {
    await writeAudit("staff_pin_invalid", profile.id, { profile_id: profile.id });
    return { authorized: false };
  }

  const sessionToken = crypto.randomUUID();
  const tokenHash = await sha256Hex(sessionToken);
  const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();

  const { error: sessionError } = await admin.from("staff_sessions").insert({
    profile_id: profile.id,
    token_hash: tokenHash,
    expires_at: expiresAt,
  });
  if (sessionError) throw sessionError;

  await writeAudit("staff_pin_verified", profile.id, { profile_id: profile.id });

  return {
    authorized: true,
    profile: publicProfile(profile),
    context: await profileContext(profile.id),
    sessionToken,
  };
}

async function findByIdentifier(identifier: string): Promise<StaffProfileRow | null> {
  const byUsername = await admin
    .from("staff_profiles")
    .select("*")
    .ilike("username", identifier)
    .maybeSingle<StaffProfileRow>();
  if (byUsername.error) throw byUsername.error;
  if (byUsername.data) return byUsername.data;

  const byContractor = await admin
    .from("staff_profiles")
    .select("*")
    .ilike("contractor_id", identifier)
    .maybeSingle<StaffProfileRow>();
  if (byContractor.error) throw byContractor.error;
  return byContractor.data;
}

async function profileContext(profileId: string) {
  const [activities, payouts, discipline, assignments, acknowledgements] = await Promise.all([
    admin.from("activity_sessions").select("*").eq("profile_id", profileId).order("start_at", { ascending: false }),
    admin.from("payouts").select("*").eq("profile_id", profileId).order("paid_at", { ascending: false }),
    admin.from("discipline_entries").select("*").eq("profile_id", profileId).order("issued_at", { ascending: false }),
    admin.from("document_assignments").select("documents(*)").eq("profile_id", profileId),
    admin.from("document_acknowledgements").select("*").eq("profile_id", profileId),
  ]);

  for (const result of [activities, payouts, discipline, assignments, acknowledgements]) {
    if (result.error) throw result.error;
  }

  return {
    activities: (activities.data ?? []).map((row) => ({
      id: row.id,
      profileId: row.profile_id,
      startAt: row.start_at,
      endAt: row.end_at,
      durationMinutes: row.duration_minutes,
    })),
    payouts: (payouts.data ?? []).map((row) => ({
      id: row.id,
      profileId: row.profile_id,
      amount: Number(row.amount),
      date: row.paid_at,
      paymentType: row.payment_type,
      status: row.status,
      notes: row.notes,
    })),
    warnings: (discipline.data ?? [])
      .filter((row) => row.type === "Warning")
      .map(mapDiscipline),
    strikes: (discipline.data ?? [])
      .filter((row) => row.type === "Strike")
      .map(mapDiscipline),
    documents: (assignments.data ?? []).map((row) => mapDocument(row.documents)),
    acknowledgements: (acknowledgements.data ?? []).map((row) => ({
      id: row.id,
      documentId: row.document_id,
      profileId: row.profile_id,
      openedAt: row.opened_at,
      completedAt: row.completed_at,
    })),
  };
}

function publicProfile(row: StaffProfileRow) {
  const photo = row.profile_photo_path
    ? admin.storage.from("profile-photos").getPublicUrl(row.profile_photo_path).data.publicUrl
    : "";

  return {
    id: row.id,
    kind: row.kind,
    profilePhoto: photo,
    fullName: row.full_name,
    username: row.username,
    contractorId: row.contractor_id,
    role: row.role,
    department: row.department,
    tags: row.tags ?? [],
    employmentType: row.employment_type,
    joinDate: row.join_date,
    status: row.status,
    notes: row.notes_visible ? row.notes : "",
    notesVisible: row.notes_visible,
    activityStatus: row.activity_status,
    serviceType: row.service_type,
    contractAmount: row.contract_amount,
    paymentStatus: row.payment_status,
    startDate: row.start_date,
    endDate: row.end_date,
  };
}

function mapDiscipline(row: Record<string, unknown>) {
  return {
    id: row.id,
    profileId: row.profile_id,
    type: row.type,
    reason: row.reason,
    issuedBy: row.issued_by,
    date: row.issued_at,
    notes: row.notes,
  };
}

function mapDocument(row: Record<string, unknown>) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    fileUrl: "#",
    dueDate: row.due_date,
    completionRequired: row.completion_required,
    completionButtonText: row.completion_button_text,
  };
}

async function writeAudit(action: string, profileId: string, details: Record<string, unknown>) {
  await admin.from("audit_logs").insert({
    profile_id: profileId,
    action,
    target_table: "staff_profiles",
    target_id: profileId,
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
