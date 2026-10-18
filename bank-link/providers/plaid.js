// Plaid adapter (https://plaid.com/docs). Free Trial plan: 10 production Items, free Sandbox.
// Needs PLAID_CLIENT_ID + PLAID_SECRET (+ PLAID_ENV sandbox|production) from a Plaid dashboard signup.
//
// STATUS: written against Plaid's documented REST API and tested against a local mock that returns
// sandbox-shaped responses (test/mocks/plaid-mock.js). Not yet run against the real Plaid sandbox.
//
// Sign convention: Plaid amounts are positive when money LEAVES the account. We use + in / - out,
// so every amount is flipped.
const { LinkError, num, sanitize } = require('./util');

const env = process.env;
const PAGE_SIZE = 500; // Plaid's max `count` for /transactions/sync
const MAX_PAGES = 50; // safety valve: 25k updates per sync; the rest arrive next sync
const MAX_RESTARTS = 3; // TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION retries

// Error codes that mean the user has to go back through Plaid Link (re-login / relink).
const NEEDS_RELINK = new Set([
  'ITEM_LOGIN_REQUIRED',
  'INVALID_ACCESS_TOKEN',
  'ITEM_LOCKED',
  'ITEM_NOT_FOUND',
  'USER_PERMISSION_REVOKED',
  'ACCESS_NOT_GRANTED',
  'NO_ACCOUNTS',
]);
const BANK_DOWN = new Set([
  'INSTITUTION_DOWN',
  'INSTITUTION_NOT_RESPONDING',
  'INSTITUTION_NOT_AVAILABLE',
]);

function base() {
  // PLAID_API_BASE lets tests point at a local mock. Ignored in production.
  if (env.PLAID_API_BASE && env.NODE_ENV !== 'production') {
    return env.PLAID_API_BASE.replace(/\/+$/, '');
  }
  return env.PLAID_ENV === 'production'
    ? 'https://production.plaid.com'
    : 'https://sandbox.plaid.com';
}

// Turn a Plaid error body ({ error_type, error_code, error_message, display_message }) into a
// LinkError whose message is safe to show the user. `plaidCode` keeps the raw code for logs/tests.
function plaidError(status, body) {
  const code = String(body.error_code || '');
  const type = String(body.error_type || '');
  let err;
  if (NEEDS_RELINK.has(code)) {
    err = new LinkError(
      'Your bank wants you to log in again. Unlink and reconnect.',
      'revoked',
      502,
    );
  } else if (status === 429 || type === 'RATE_LIMIT_EXCEEDED') {
    err = new LinkError(
      'Plaid is rate limiting us. Try again in a few minutes.',
      'rate_limit',
      429,
    );
  } else if (code === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION') {
    err = new LinkError('Plaid data changed mid-sync. Try again.', 'mutation', 502);
  } else if (code === 'PRODUCT_NOT_READY') {
    err = new LinkError(
      'Plaid is still pulling your history. Try again in a few minutes.',
      'not_ready',
      502,
    );
  } else if (BANK_DOWN.has(code)) {
    err = new LinkError(
      "Your bank isn't answering Plaid right now. Try again later.",
      'upstream',
      502,
    );
  } else {
    const detail = sanitize(body.display_message || body.error_message || status);
    err = new LinkError(`Plaid error: ${detail}`, 'upstream', 502);
  }
  err.plaidCode = code || type || String(status);
  return err;
}

async function call(path, body) {
  let res;
  try {
    res = await fetch(base() + path, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: env.PLAID_CLIENT_ID, secret: env.PLAID_SECRET, ...body }),
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw new LinkError('Could not reach Plaid.', 'network', 502);
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw plaidError(res.status, json || {});
  }
  if (!json || typeof json !== 'object') {
    throw new LinkError('Plaid sent something unreadable.', 'upstream', 502);
  }
  return json;
}

function toAccount(a, institution) {
  const credit = a.type === 'credit';
  const balances = a.balances || {};
  return {
    id: a.account_id,
    name: sanitize(`${a.name}${a.mask ? ' ••' + a.mask : ''}`),
    org: sanitize(institution) || 'Plaid',
    kind: credit ? 'credit' : 'depository',
    // credit-card `current` is the amount owed, which we store as a negative balance
    balance: balances.current != null ? num(balances.current) * (credit ? -1 : 1) : null,
    available: num(balances.available),
    currency: balances.iso_currency_code || 'USD',
    balanceDate: new Date().toISOString(),
  };
}

function toTransaction(t, modified) {
  return {
    accountId: t.account_id,
    id: t.transaction_id,
    date: t.authorized_date || t.date,
    desc: sanitize(t.merchant_name || t.name) || 'Transaction',
    amount: -num(t.amount),
    pending: false,
    modified,
  };
}

// One full /transactions/sync pagination run starting at `startCursor`.
async function syncAll(accessToken, startCursor) {
  const added = [];
  const modified = [];
  const removed = [];
  let cursor = startCursor;
  let status = null;
  let more = true;
  let pages = 0;
  while (more && pages < MAX_PAGES) {
    const page = await call('/transactions/sync', {
      access_token: accessToken,
      cursor: cursor || undefined,
      count: PAGE_SIZE,
    });
    pages++;
    added.push(...(page.added || []));
    modified.push(...(page.modified || []));
    removed.push(...(page.removed || []));
    // An empty next_cursor means "no data yet"; keep the one we had.
    cursor = page.next_cursor || cursor;
    more = !!page.has_more;
    status = page.transactions_update_status || status;
  }
  return { added, modified, removed, cursor, status, truncated: more };
}

async function pull(secret) {
  const acc = await call('/accounts/get', { access_token: secret.accessToken }); // cached balances, no Balance fee
  if (!Array.isArray(acc.accounts)) {
    throw new LinkError('Plaid sent something unreadable.', 'upstream', 502);
  }
  const accounts = acc.accounts.map(a => toAccount(a, secret.institution));

  // Plaid's rule: if a page fails with MUTATION_DURING_PAGINATION, restart the whole loop
  // from the cursor we started with (not from the page that failed).
  let run;
  for (let attempt = 0; ; attempt++) {
    try {
      run = await syncAll(secret.accessToken, secret.cursor || null);
      break;
    } catch (e) {
      if (e.code !== 'mutation' || attempt >= MAX_RESTARTS) {
        throw e;
      }
    }
  }

  const transactions = [
    ...run.added.filter(t => !t.pending).map(t => toTransaction(t, false)),
    ...run.modified.filter(t => !t.pending).map(t => toTransaction(t, true)),
  ];
  const removed = run.removed
    .filter(r => r && r.transaction_id)
    .map(r => ({ accountId: r.account_id || null, id: r.transaction_id }));
  const errors = [];
  if (run.status === 'NOT_READY') {
    errors.push('Plaid is still pulling your history. It will show up on a later sync.');
  }
  if (run.truncated) {
    errors.push('Lots of history to catch up on. The rest comes in on the next sync.');
  }
  return { accounts, transactions, removed, errors, secret: { ...secret, cursor: run.cursor } };
}

module.exports = {
  id: 'plaid',
  name: 'Plaid',
  enabled: () => !!(env.PLAID_CLIENT_ID && env.PLAID_SECRET),
  info: () => ({
    environment: env.PLAID_ENV === 'production' ? 'production' : 'sandbox',
    cost: 'Free Trial: 10 Items total; then pay-as-you-go monthly per Item for Transactions',
  }),
  async linkToken(uid) {
    const j = await call('/link/token/create', {
      user: { client_user_id: String(uid) },
      client_name: (env.APP_TITLE || 'Money Vault').slice(0, 30),
      products: ['transactions'],
      country_codes: ['US'],
      language: 'en',
    });
    return j.link_token;
  },
  async link(input) {
    const publicToken = String(input.publicToken || '');
    if (!/^public-[a-z]+-[A-Za-z0-9-]+$/.test(publicToken)) {
      throw new LinkError('Missing Plaid public token.');
    }
    const j = await call('/item/public_token/exchange', { public_token: publicToken });
    if (!j.access_token) {
      throw new LinkError('Plaid did not return an access token.', 'upstream', 502);
    }
    const institution = sanitize(input.institution);
    return {
      secret: { accessToken: j.access_token, itemId: j.item_id, cursor: null, institution },
      label: institution || 'Plaid',
    };
  },
  pull,
  // Removing the Item upstream ends Plaid's monthly per-Item fee. Failures are ignored: we delete our copy anyway.
  async unlink(secret) {
    await call('/item/remove', { access_token: secret.accessToken }).catch(() => {});
  },
  _plaidError: plaidError, // exported for tests
};
