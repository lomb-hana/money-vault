# bank-link: automatic bank linking for Money Vault

Self-contained module mounted inside the main server (one Render free service; no separate service needed,
traffic is tiny and Render free sleeps anyway). Live data from checking, savings and credit cards, read-only.

## Flow

1. User picks a provider on the Link & import screen.
2. Server exchanges the user's token (SimpleFIN setup token, Teller access token, Plaid public token) for a long-lived secret.
3. Secret is sealed with AES-256-GCM (`BANK_LINK_KEY`), AAD = user id + link id, stored in that user's vault (`V.links`). It is never sent to the browser.
4. Sync (on link, "Sync now", every `BANK_SYNC_HOURS` in the background, and lazily when the user opens the app since Render sleeps):
   pull accounts + posted transactions -> drop transfers between the user's own linked accounts (card payments, checking<->savings)
   -> same auto-categorize (incl. personal rules) + bill/paycheck reconcile as file imports. Dedupe by provider transaction id,
   and against CSV/manual entries by date+amount+merchant.
5. Unlink deletes our copy (optionally the pulled transactions too). Plaid items are also removed upstream to stop billing;
   SimpleFIN tokens should also be revoked by the user in SimpleFIN Bridge.

## Providers (providers/*.js, same interface, see providers/index.js)

| Provider         | Status                                                   | Needs                                                                                                    |
| ---------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| SimpleFIN Bridge | Live-ready, tested against a protocol mock               | Nothing on our side. Each user pays SimpleFIN $15/yr (or $1.50/mo), up to 25 institutions                |
| Teller           | Works against Teller's public sandbox; live needs an app | `TELLER_APP_ID` (+ `TELLER_CERT`/`TELLER_KEY` for development/production mTLS). Free for 100 enrollments |
| Plaid            | Written to the documented API, not live-tested           | `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV`. Free Trial = 10 Items                                    |

SimpleFIN safety per the protocol checklist: https only, TLS verified, no redirects, claim/access hosts allowlisted
(`SIMPLEFIN_HOSTS`, default beta-bridge.simplefin.org,bridge.simplefin.org), 403 on claim tells the user the token may be
compromised, 402/403 on /accounts surfaced, provider error text sanitized before display.

## API (all behind login, per user)

GET /api/bank/providers · GET /api/bank/links · POST /api/bank/links {provider, token|accessToken|publicToken}
POST /api/bank/links/:id/sync · PUT /api/bank/links/:id/accounts/:acc {include, kind} · DELETE /api/bank/links/:id[?dropTx=1]
POST /api/bank/plaid/link-token

## Local demo with fake data

    node test/mocks/simplefin-teller-mock.js 4555 &
    SIMPLEFIN_ALLOW_INSECURE_LOCAL=1 PORT=3050 node server.js
    # token: echo -n http://127.0.0.1:4555/simplefin/claim/demo | base64
