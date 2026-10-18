# Contributing to Money Vault

Thanks for taking a look. The repo is public, so anyone can read the code, open issues,
comment on pull requests, or fork it and send a PR.

## Run it

Node 18 or newer. The app itself has **zero runtime dependencies**; `npm install` only pulls
dev tools (Prettier, ESLint).

```sh
npm install
ADMIN_KEY=something-long npm start   # http://localhost:3001, data in data/db.json
```

Without `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` it uses a local JSON file. See `README.md` for
all env vars and `bank-link/README.md` for bank linking.

## Format, lint, test

```sh
npm run format        # Prettier rewrites files in place
npm run format:check  # what CI runs: fails if anything isn't formatted
npm run lint          # ESLint (npm run lint -- --fix for the auto-fixable rules)
npm test              # node:test, everything mocked, no network or real bank data
```

- Prettier settings are in `.prettierrc.json`: 2 spaces, 100 columns, single quotes, trailing commas.
- ESLint rules are in `eslint.config.js` with a comment for each group. Node globals apply to
  everything except `public/`, which gets browser globals.
- Tests live in `test/`. Providers are faked by local HTTP mocks in `test/mocks/` (SimpleFIN,
  Teller, and a Plaid mock with sandbox-shaped responses). `test/helpers/app.js` starts the real
  server on a free port with a throwaway data file. No test calls a real bank or provider API.

## Pull requests

`main` is protected: every change goes through a pull request, and CI (format check, lint and
tests on Node 18, 20 and 22) has to pass before it can merge.

1. Branch from `main` (or fork, if you don't have write access).
2. Make the change. Keep behavior changes and pure cleanups in separate commits when you can.
3. `npm run format && npm run lint && npm test`
4. Open a PR against `main` and say what changed, why, and how you tested it.
5. Review happens in the PR. Anyone can leave comments; a maintainer merges (squash).

## Ground rules

- No runtime dependencies. Dev-only tooling is fine.
- Never commit secrets, `.env` files, or real bank data. `data/` is gitignored.
- Bank secrets (SimpleFIN access URLs, Teller/Plaid tokens) are only ever stored sealed with
  `BANK_LINK_KEY` and never sent to the browser. Keep it that way.
- Error text from providers is shown to users, so it goes through `sanitize()` first.
