# Money Vault

Personal money tracker. Node 18+, zero runtime npm deps (Prettier and ESLint are dev-only).
Every user's data is private to their account.

## Local

    ADMIN_KEY=something npm start     # http://localhost:3001

Data: data/db.json unless SUPABASE_URL + SUPABASE_SERVICE_KEY are set.

## Env

- APP_TITLE (default "Money Vault"), e.g. "Chumplee's Money Vault"
- ADMIN_KEY: required in production; only used to reset a user's password:
  curl -X POST https://<host>/api/admin/users/<username>/password -H 'Content-Type: application/json' -d '{"adminKey":"...","password":"newtemp1"}'
- SUPABASE_URL, SUPABASE_SERVICE_KEY: Supabase project (same one as the raid site is fine)
- STATE_ROW_ID (default money-main): row in public.app_state; keep different from the raid site's 'main'
- BANK_LINK_KEY: 32 random bytes as base64 (`openssl rand -base64 32`). Encrypts linked-bank secrets. Without it in production, bank linking shows as off. Don't change it once people have linked (they'd have to relink).
- BANK_SYNC_HOURS (default 6): background sync interval
- Optional: TELLER_APP_ID / TELLER_ENV / TELLER_CERT / TELLER_KEY, PLAID_CLIENT_ID / PLAID_SECRET / PLAID_ENV (see bank-link/README.md)
- NODE_ENV=production (secure cookies, ADMIN_KEY check)

## Deploy (Render free)

New > Blueprint > this repo. Fill ADMIN_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY (APP_TITLE optional). Check /healthz.

## Automatic bank linking

See bank-link/README.md. Tests (mock providers, no real data): `npm test`.

## Development

`npm install`, then `npm run format`, `npm run lint`, `npm test`. Changes go in through pull requests;
see [CONTRIBUTING.md](CONTRIBUTING.md).
