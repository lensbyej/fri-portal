-- Outbound Portal Supabase schema
-- Run in the Supabase SQL editor or through a reviewed migration.

create extension if not exists pgcrypto;

create table if not exists public.leadership_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  email text,
  role text not null default 'Leadership',
  permissions jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.portal_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.staff_profiles (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'staff' check (kind in ('staff', 'contractor')),
  profile_photo_path text,
  full_name text not null,
  username text unique,
  contractor_id text unique,
  pin_salt text not null,
  pin_hash text not null,
  role text,
  department text,
  tags text[] not null default '{}',
  employment_type text not null default 'Part Time',
  join_date date,
  status text not null default 'Active' check (status in ('Active', 'On Leave', 'Contractor', 'Suspended', 'Archived')),
  notes text,
  notes_visible boolean not null default false,
  activity_status text not null default 'Offline' check (activity_status in ('Active', 'Offline')),
  service_type text,
  contract_amount numeric(12, 2),
  payment_status text check (payment_status is null or payment_status in ('Pending', 'Complete', 'On Hold')),
  start_date date,
  end_date date,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint staff_profiles_identifier_check check (username is not null or contractor_id is not null)
);

create table if not exists public.activity_sessions (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.staff_profiles(id) on delete cascade,
  start_at timestamptz not null default now(),
  end_at timestamptz,
  duration_minutes integer,
  created_at timestamptz not null default now(),
  constraint activity_end_after_start check (end_at is null or end_at >= start_at)
);

create table if not exists public.discipline_entries (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.staff_profiles(id) on delete cascade,
  type text not null check (type in ('Warning', 'Strike')),
  reason text not null,
  issued_by text not null,
  issued_at date not null default current_date,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists public.payouts (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.staff_profiles(id) on delete cascade,
  amount numeric(12, 2) not null check (amount >= 0),
  paid_at date not null default current_date,
  payment_type text not null default 'Robux' check (payment_type = 'Robux'),
  status text not null default 'Pending' check (status in ('Pending', 'Complete', 'On Hold')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  file_path text,
  due_date date,
  completion_required boolean not null default true,
  completion_button_text text not null default 'Acknowledge',
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.document_assignments (
  document_id uuid not null references public.documents(id) on delete cascade,
  profile_id uuid not null references public.staff_profiles(id) on delete cascade,
  assigned_at timestamptz not null default now(),
  primary key (document_id, profile_id)
);

create table if not exists public.document_acknowledgements (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  profile_id uuid not null references public.staff_profiles(id) on delete cascade,
  opened_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (document_id, profile_id)
);

create table if not exists public.staff_sessions (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.staff_profiles(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references auth.users(id),
  profile_id uuid references public.staff_profiles(id),
  action text not null,
  target_table text,
  target_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.terminal_commands (
  id uuid primary key default gen_random_uuid(),
  action text not null check (action in ('ban', 'kick', 'unban')),
  roblox_username text not null,
  roblox_user_id bigint,
  raw_command text not null,
  reason text,
  status text not null default 'queued' check (status in ('queued', 'sent', 'completed', 'failed', 'cancelled')),
  actor_type text not null check (actor_type in ('leadership', 'staff')),
  actor_user_id uuid references auth.users(id),
  actor_profile_id uuid references public.staff_profiles(id),
  issued_by text not null,
  server_job_id text,
  place_id bigint,
  result_message text,
  created_at timestamptz not null default now(),
  dispatched_at timestamptz,
  completed_at timestamptz
);

create table if not exists public.terminal_bans (
  roblox_user_id bigint primary key,
  roblox_username text not null,
  reason text,
  command_id uuid references public.terminal_commands(id) on delete set null,
  issued_by text,
  actor_type text check (actor_type in ('leadership', 'staff')),
  actor_user_id uuid references auth.users(id),
  actor_profile_id uuid references public.staff_profiles(id),
  banned_at timestamptz not null default now(),
  active boolean not null default true
);

create table if not exists public.terminal_logs (
  id uuid primary key default gen_random_uuid(),
  command_id uuid references public.terminal_commands(id) on delete set null,
  level text not null default 'info' check (level in ('info', 'warn', 'error')),
  message text not null,
  server_job_id text,
  place_id bigint,
  created_at timestamptz not null default now()
);

create index if not exists staff_profiles_username_idx on public.staff_profiles (lower(username));
create index if not exists staff_profiles_contractor_id_idx on public.staff_profiles (lower(contractor_id));
create index if not exists activity_sessions_profile_start_idx on public.activity_sessions (profile_id, start_at desc);
create index if not exists discipline_entries_profile_type_idx on public.discipline_entries (profile_id, type, issued_at desc);
create index if not exists payouts_profile_paid_idx on public.payouts (profile_id, paid_at desc);
create index if not exists document_assignments_profile_idx on public.document_assignments (profile_id);
create index if not exists staff_sessions_profile_expires_idx on public.staff_sessions (profile_id, expires_at desc);
create index if not exists audit_logs_created_idx on public.audit_logs (created_at desc);
create index if not exists terminal_commands_status_created_idx on public.terminal_commands (status, created_at);
create index if not exists terminal_commands_actor_profile_idx on public.terminal_commands (actor_profile_id, created_at desc);
create index if not exists terminal_bans_active_idx on public.terminal_bans (active, banned_at desc);
create index if not exists terminal_logs_created_idx on public.terminal_logs (created_at desc);

alter table public.leadership_users enable row level security;
alter table public.portal_settings enable row level security;
alter table public.staff_profiles enable row level security;
alter table public.activity_sessions enable row level security;
alter table public.discipline_entries enable row level security;
alter table public.payouts enable row level security;
alter table public.documents enable row level security;
alter table public.document_assignments enable row level security;
alter table public.document_acknowledgements enable row level security;
alter table public.staff_sessions enable row level security;
alter table public.audit_logs enable row level security;
alter table public.terminal_commands enable row level security;
alter table public.terminal_bans enable row level security;
alter table public.terminal_logs enable row level security;

drop policy if exists "Leadership can read leadership users" on public.leadership_users;
drop policy if exists "Leadership can manage leadership users" on public.leadership_users;
drop policy if exists "Public can read portal branding" on public.portal_settings;
drop policy if exists "Leadership can manage portal settings" on public.portal_settings;
drop policy if exists "Leadership can manage staff profiles" on public.staff_profiles;
drop policy if exists "Leadership can manage activity" on public.activity_sessions;
drop policy if exists "Leadership can manage discipline" on public.discipline_entries;
drop policy if exists "Leadership can manage payouts" on public.payouts;
drop policy if exists "Leadership can manage documents" on public.documents;
drop policy if exists "Leadership can manage document assignments" on public.document_assignments;
drop policy if exists "Leadership can manage acknowledgements" on public.document_acknowledgements;
drop policy if exists "Leadership can read staff sessions" on public.staff_sessions;
drop policy if exists "Leadership can read audit logs" on public.audit_logs;
drop policy if exists "Leadership can insert audit logs" on public.audit_logs;
drop policy if exists "Leadership can read terminal commands" on public.terminal_commands;
drop policy if exists "Leadership can read terminal bans" on public.terminal_bans;
drop policy if exists "Leadership can read terminal logs" on public.terminal_logs;

-- Leadership authorization is read from app_metadata, not user_metadata.
-- Set auth.users.raw_app_meta_data.fri_role = 'leadership' for approved leadership accounts.
create policy "Leadership can read leadership users"
  on public.leadership_users for select
  to authenticated
  using ((select auth.jwt() -> 'app_metadata' ->> 'fri_role') = 'leadership');

create policy "Leadership can manage leadership users"
  on public.leadership_users for all
  to authenticated
  using ((select auth.jwt() -> 'app_metadata' ->> 'fri_role') = 'leadership')
  with check ((select auth.jwt() -> 'app_metadata' ->> 'fri_role') = 'leadership');

create policy "Public can read portal branding"
  on public.portal_settings for select
  to anon, authenticated
  using (key = 'branding');

create policy "Leadership can manage portal settings"
  on public.portal_settings for all
  to authenticated
  using ((select auth.jwt() -> 'app_metadata' ->> 'fri_role') = 'leadership')
  with check ((select auth.jwt() -> 'app_metadata' ->> 'fri_role') = 'leadership');

insert into public.portal_settings (key, value)
values (
  'branding',
  jsonb_build_object(
    'portalName', 'Outbound',
    'accentColor', '#f9f9f9',
    'logoUrl', 'assets/outbound-logo.png',
    'logoPath', ''
  )
)
on conflict (key) do nothing;

create policy "Leadership can manage staff profiles"
  on public.staff_profiles for all
  to authenticated
  using ((select auth.jwt() -> 'app_metadata' ->> 'fri_role') = 'leadership')
  with check ((select auth.jwt() -> 'app_metadata' ->> 'fri_role') = 'leadership');

create policy "Leadership can manage activity"
  on public.activity_sessions for all
  to authenticated
  using ((select auth.jwt() -> 'app_metadata' ->> 'fri_role') = 'leadership')
  with check ((select auth.jwt() -> 'app_metadata' ->> 'fri_role') = 'leadership');

create policy "Leadership can manage discipline"
  on public.discipline_entries for all
  to authenticated
  using ((select auth.jwt() -> 'app_metadata' ->> 'fri_role') = 'leadership')
  with check ((select auth.jwt() -> 'app_metadata' ->> 'fri_role') = 'leadership');

create policy "Leadership can manage payouts"
  on public.payouts for all
  to authenticated
  using ((select auth.jwt() -> 'app_metadata' ->> 'fri_role') = 'leadership')
  with check ((select auth.jwt() -> 'app_metadata' ->> 'fri_role') = 'leadership');

create policy "Leadership can manage documents"
  on public.documents for all
  to authenticated
  using ((select auth.jwt() -> 'app_metadata' ->> 'fri_role') = 'leadership')
  with check ((select auth.jwt() -> 'app_metadata' ->> 'fri_role') = 'leadership');

create policy "Leadership can manage document assignments"
  on public.document_assignments for all
  to authenticated
  using ((select auth.jwt() -> 'app_metadata' ->> 'fri_role') = 'leadership')
  with check ((select auth.jwt() -> 'app_metadata' ->> 'fri_role') = 'leadership');

create policy "Leadership can manage acknowledgements"
  on public.document_acknowledgements for all
  to authenticated
  using ((select auth.jwt() -> 'app_metadata' ->> 'fri_role') = 'leadership')
  with check ((select auth.jwt() -> 'app_metadata' ->> 'fri_role') = 'leadership');

create policy "Leadership can read staff sessions"
  on public.staff_sessions for select
  to authenticated
  using ((select auth.jwt() -> 'app_metadata' ->> 'fri_role') = 'leadership');

create policy "Leadership can read audit logs"
  on public.audit_logs for select
  to authenticated
  using ((select auth.jwt() -> 'app_metadata' ->> 'fri_role') = 'leadership');

create policy "Leadership can insert audit logs"
  on public.audit_logs for insert
  to authenticated
  with check ((select auth.jwt() -> 'app_metadata' ->> 'fri_role') = 'leadership');

create policy "Leadership can read terminal commands"
  on public.terminal_commands for select
  to authenticated
  using ((select auth.jwt() -> 'app_metadata' ->> 'fri_role') = 'leadership');

create policy "Leadership can read terminal bans"
  on public.terminal_bans for select
  to authenticated
  using ((select auth.jwt() -> 'app_metadata' ->> 'fri_role') = 'leadership');

create policy "Leadership can read terminal logs"
  on public.terminal_logs for select
  to authenticated
  using ((select auth.jwt() -> 'app_metadata' ->> 'fri_role') = 'leadership');

grant usage on schema public to anon, authenticated;
grant select on public.portal_settings to anon;
grant select, insert, update, delete on
  public.leadership_users,
  public.portal_settings,
  public.staff_profiles,
  public.activity_sessions,
  public.discipline_entries,
  public.payouts,
  public.documents,
  public.document_assignments,
  public.document_acknowledgements,
  public.audit_logs,
  public.terminal_commands,
  public.terminal_bans,
  public.terminal_logs
to authenticated;

insert into storage.buckets (id, name, public, file_size_limit)
values
  ('portal-assets', 'portal-assets', true, 5242880),
  ('profile-photos', 'profile-photos', true, 5242880),
  ('staff-documents', 'staff-documents', false, 52428800)
on conflict (id) do nothing;

drop policy if exists "Portal assets are readable" on storage.objects;
drop policy if exists "Leadership can upload portal assets" on storage.objects;
drop policy if exists "Leadership can update portal assets" on storage.objects;
drop policy if exists "Leadership can delete portal assets" on storage.objects;
drop policy if exists "Profile photos are readable" on storage.objects;
drop policy if exists "Leadership can upload profile photos" on storage.objects;
drop policy if exists "Leadership can update profile photos" on storage.objects;
drop policy if exists "Leadership can delete profile photos" on storage.objects;
drop policy if exists "Leadership can manage staff documents" on storage.objects;

create policy "Portal assets are readable"
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'portal-assets');

create policy "Leadership can upload portal assets"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'portal-assets'
    and (select auth.jwt() -> 'app_metadata' ->> 'fri_role') = 'leadership'
  );

create policy "Leadership can update portal assets"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'portal-assets'
    and (select auth.jwt() -> 'app_metadata' ->> 'fri_role') = 'leadership'
  )
  with check (
    bucket_id = 'portal-assets'
    and (select auth.jwt() -> 'app_metadata' ->> 'fri_role') = 'leadership'
  );

create policy "Leadership can delete portal assets"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'portal-assets'
    and (select auth.jwt() -> 'app_metadata' ->> 'fri_role') = 'leadership'
  );

create policy "Profile photos are readable"
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'profile-photos');

create policy "Leadership can upload profile photos"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'profile-photos'
    and (select auth.jwt() -> 'app_metadata' ->> 'fri_role') = 'leadership'
  );

create policy "Leadership can update profile photos"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'profile-photos'
    and (select auth.jwt() -> 'app_metadata' ->> 'fri_role') = 'leadership'
  )
  with check (
    bucket_id = 'profile-photos'
    and (select auth.jwt() -> 'app_metadata' ->> 'fri_role') = 'leadership'
  );

create policy "Leadership can delete profile photos"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'profile-photos'
    and (select auth.jwt() -> 'app_metadata' ->> 'fri_role') = 'leadership'
  );

create policy "Leadership can manage staff documents"
  on storage.objects for all
  to authenticated
  using (
    bucket_id = 'staff-documents'
    and (select auth.jwt() -> 'app_metadata' ->> 'fri_role') = 'leadership'
  )
  with check (
    bucket_id = 'staff-documents'
    and (select auth.jwt() -> 'app_metadata' ->> 'fri_role') = 'leadership'
  );
