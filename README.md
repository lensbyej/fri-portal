# First Response Interactive Staff Portal

Premium dark staff operations portal for First Response Interactive. The app is configured for the First Response Interactive Supabase project and includes schema and Edge Functions for authentication, profile storage, activity tracking, documents, payouts, discipline history, and audit logs.

## Run Locally

```powershell
python -m http.server 8080
```

Open `http://localhost:8080`.

## Supabase Setup

The project is wired to `https://flwtzlcccumejmhbfjlh.supabase.co`.

1. Run `supabase/schema.sql` in your Supabase SQL editor or convert it into a reviewed migration.
2. Deploy the Edge Functions:

```powershell
supabase functions deploy staff-pin-auth
supabase functions deploy staff-activity
supabase functions deploy document-ack
supabase functions deploy leadership-admin
```

3. Add `SUPABASE_SERVICE_ROLE_KEY` to Edge Function secrets. Do not expose it in browser code.
4. Set leadership authorization in `auth.users.raw_app_meta_data`, for example:

```json
{ "fri_role": "leadership" }
```

5. Confirm the project publishable key in `config.js`:

```js
window.FRI_CONFIG = {
  supabaseUrl: "https://flwtzlcccumejmhbfjlh.supabase.co",
  supabasePublishableKey: "sb_publishable_FmtKCT5w9hIgXV2iBo74vw_mqsu1WLu",
  demoMode: false,
};
```

The public staff lookup uses Edge Functions for PIN verification so PIN hashes stay server-side. Leadership users authenticate with Supabase Auth and are authorized through `app_metadata`, not user-editable metadata. The app will show a launch-blocking "Supabase Key Missing" status until the publishable key is set.

## First Leadership Account

Supabase Auth users are required for leadership access. Create the first user in Supabase Auth, then set their app metadata to:

```json
{ "fri_role": "leadership" }
```

Then insert the matching leadership profile row:

```sql
insert into public.leadership_users (user_id, name, email, role)
values (
  'AUTH_USER_ID_HERE',
  'First Leadership User',
  'leader@example.com',
  'Director'
);
```

After the first leadership user signs in, additional leadership accounts and password resets can be managed from System Settings through the protected `leadership-admin` Edge Function.

## Optional Local Demo

For isolated UI testing only, set `demoMode: true` in `config.js`. Do not deploy internal production with demo mode enabled.

## Files

- `index.html` - Portal shell and screens.
- `styles.css` - Dark enterprise dashboard styling.
- `app.js` - Lookup, staff profile, activity tracker, documents, leadership dashboard, demo store, and Supabase adapter.
- `assets/summer-26-logo.png` - Temporary Summer '26 Content Drop logo.
- `supabase/schema.sql` - Tables, indexes, RLS policies, storage buckets, and grants.
- `supabase/functions/*` - Staff PIN auth, activity session, document acknowledgement, and leadership admin Edge Functions.
