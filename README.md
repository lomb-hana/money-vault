# Money Vault
Personal money tracker. Node 18+, zero npm deps. Every user's data is private to their account.

## Local
    ADMIN_KEY=something npm start     # http://localhost:3001
Data: data/db.json unless SUPABASE_URL + SUPABASE_SERVICE_KEY are set.

## Env
- APP_TITLE (default "Money Vault"), e.g. "Chumplee's Money Vault"
- ADMIN_KEY: required in production; only used to reset a user's password:
  curl -X POST https://<host>/api/admin/users/<username>/password -H 'Content-Type: application/json' -d '{"adminKey":"...","password":"newtemp1"}'
- SUPABASE_URL, SUPABASE_SERVICE_KEY: Supabase project (same one as the raid site is fine)
- STATE_ROW_ID (default money-main): row in public.app_state; keep different from the raid site's 'main'
- NODE_ENV=production (secure cookies, ADMIN_KEY check)

## Deploy (Render free)
New > Blueprint > this repo. Fill ADMIN_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY (APP_TITLE optional). Check /healthz.
