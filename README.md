# Outbound Staff Portal

Premium light bento staff operations portal for Outbound. The app is configured for Supabase and includes schema and Edge Functions for authentication, profile storage, activity tracking, Roblox operations, documents, payouts, discipline history, and audit logs.

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
supabase functions deploy roblox-status
supabase functions deploy terminal-command --no-verify-jwt
supabase functions deploy roblox-terminal --no-verify-jwt
```

3. Add `SUPABASE_SERVICE_ROLE_KEY` to Edge Function secrets. Do not expose it in browser code.
4. Set leadership authorization in `auth.users.raw_app_meta_data`, for example:

```json
{ "fri_role": "leadership" }
```

5. Confirm the project publishable key in `config.js`:

```js
window.OUTBOUND_CONFIG = {
  supabaseUrl: "https://flwtzlcccumejmhbfjlh.supabase.co",
  supabasePublishableKey: "sb_publishable_FmtKCT5w9hIgXV2iBo74vw_mqsu1WLu",
  demoMode: false,
};
```

The public staff lookup uses Edge Functions for PIN verification so PIN hashes stay server-side. Leadership users authenticate with Supabase Auth and are authorized through `app_metadata`, not user-editable metadata. The app will show a launch-blocking "Supabase Key Missing" status until the publishable key is set.

## Roblox Terminal

The Leadership and staff profile screens include an Outbound Terminal for Roblox moderation commands:

```text
/ban RobloxUsername optional reason
/kick RobloxUsername optional reason
/unban RobloxUsername optional reason
```

`terminal-command` validates the leadership auth session or staff PIN session, writes the command to Supabase, and records audit logs. `roblox-terminal` is called by Roblox servers with `x-outbound-engine-key`; it polls pending commands, checks active bans, and stores command acknowledgements.

Place `roblox/OutboundEngineTerminal.server.lua` in Roblox `ServerScriptService`, enable HTTP requests in Game Settings, and set `ENGINE_API_KEY` in that script to the private Outbound engine key configured for this project. The key is verified by hash through `portal_settings.key = 'terminal_engine'`, so the plaintext key is not stored in browser code or committed source.

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
- `styles.css` - Light bento dashboard styling.
- `app.js` - Lookup, staff profile, activity tracker, Roblox operations, documents, leadership dashboard, demo store, and Supabase adapter.
- `assets/outbound-logo.png` - Outbound logo.
- `supabase/schema.sql` - Tables, indexes, RLS policies, storage buckets, and grants.
- `supabase/functions/*` - Staff PIN auth, activity session, document acknowledgement, Roblox status, Terminal moderation, and leadership admin Edge Functions.
- `roblox/OutboundEngineTerminal.server.lua` - Roblox ServerScriptService bridge for Terminal bans and kicks.
