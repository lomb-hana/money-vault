// Plaid adapter + end-to-end Plaid flow, against a local mock that returns Plaid-sandbox-shaped
// responses (test/mocks/plaid-mock.js). Never touches the real Plaid API.
const test = require('node:test');
const assert = require('node:assert');
const { startPlaidMock, CLIENT_ID, SECRET } = require('./mocks/plaid-mock');
const { startApp, freePort } = require('./helpers/app');

const plaid = require('../bank-link/providers/plaid');
const { LinkError } = require('../bank-link/providers/util');

const ENV_KEYS = ['PLAID_CLIENT_ID', 'PLAID_SECRET', 'PLAID_ENV', 'PLAID_API_BASE', 'NODE_ENV'];
let mock;
let savedEnv;

function useMock(m) {
  process.env.PLAID_CLIENT_ID = CLIENT_ID;
  process.env.PLAID_SECRET = SECRET;
  process.env.PLAID_API_BASE = m.url;
  delete process.env.PLAID_ENV;
  delete process.env.NODE_ENV;
}
async function linkedItem(m, name = 'ins109508') {
  const { secret } = await plaid.link({
    publicToken: `public-sandbox-${name}`,
    institution: 'First Platypus Bank',
  });
  return { secret, item: m.items.get(secret.accessToken) };
}
const byId = (list, id) => list.find(t => t.id === id);

test.before(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  mock = await startPlaidMock({ pageSize: 4 });
  useMock(mock);
});
test.after(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  await mock.close();
});

test.describe('Plaid adapter (unit, mocked sandbox)', () => {
  test('enabled() and info() follow the env', () => {
    assert.strictEqual(plaid.enabled(), true);
    assert.strictEqual(plaid.info().environment, 'sandbox');
    const id = process.env.PLAID_CLIENT_ID;
    delete process.env.PLAID_CLIENT_ID;
    assert.strictEqual(plaid.enabled(), false);
    process.env.PLAID_CLIENT_ID = id;
  });

  test('PLAID_API_BASE is ignored in production (always the real Plaid host)', async () => {
    const realFetch = global.fetch;
    const urls = [];
    global.fetch = async url => {
      urls.push(String(url));
      return new Response(JSON.stringify({ link_token: 'link-production-x' }), { status: 200 });
    };
    try {
      process.env.NODE_ENV = 'production';
      process.env.PLAID_ENV = 'production';
      await plaid.linkToken('u1');
      delete process.env.PLAID_ENV;
      await plaid.linkToken('u1');
    } finally {
      global.fetch = realFetch;
      delete process.env.NODE_ENV;
      delete process.env.PLAID_ENV;
    }
    assert.deepStrictEqual(urls, [
      'https://production.plaid.com/link/token/create',
      'https://sandbox.plaid.com/link/token/create',
    ]);
  });

  test('/link/token/create: sends the user id, product and country; returns link_token', async () => {
    const token = await plaid.linkToken('user-42');
    assert.match(token, /^link-sandbox-/);
    const hit = mock.hits.filter(h => h.path === '/link/token/create').pop();
    assert.deepStrictEqual(hit.body.user, { client_user_id: 'user-42' });
    assert.deepStrictEqual(hit.body.products, ['transactions']);
    assert.deepStrictEqual(hit.body.country_codes, ['US']);
  });

  test('credentials go in the request body, and bad credentials surface as a Plaid error', async () => {
    process.env.PLAID_SECRET = 'wrong';
    await assert.rejects(
      plaid.linkToken('u1'),
      e => e instanceof LinkError && e.plaidCode === 'INVALID_API_KEYS',
    );
    process.env.PLAID_SECRET = SECRET;
  });

  test('/item/public_token/exchange: validates the public token before calling Plaid', async () => {
    const before = mock.hits.length;
    for (const bad of ['', 'access-sandbox-123', 'public-sandbox-<script>', 'public-']) {
      await assert.rejects(plaid.link({ publicToken: bad }), /Missing Plaid public token/);
    }
    assert.strictEqual(mock.hits.length, before, 'no request sent for malformed tokens');
  });

  test('/item/public_token/exchange: stores access token, item id, empty cursor and institution', async () => {
    const r = await plaid.link({
      publicToken: 'public-sandbox-abc',
      institution: '<b>First Platypus</b> Bank',
    });
    assert.match(r.secret.accessToken, /^access-sandbox-abc-/);
    assert.match(r.secret.itemId, /^item-abc-/);
    assert.strictEqual(r.secret.cursor, null);
    assert.strictEqual(r.label, 'First Platypus Bank', 'institution name sanitized');
  });

  test('/item/public_token/exchange: Plaid rejecting the token is a user-safe error', async () => {
    mock.failNext('/item/public_token/exchange', 400, {
      error_type: 'INVALID_INPUT',
      error_code: 'INVALID_PUBLIC_TOKEN',
      error_message:
        'provided public token is expired. Public tokens expire 30 minutes after creation',
      display_message: null,
    });
    await assert.rejects(plaid.link({ publicToken: 'public-sandbox-late' }), e => {
      assert.strictEqual(e.plaidCode, 'INVALID_PUBLIC_TOKEN');
      assert.match(e.message, /^Plaid error: provided public token is expired/);
      return true;
    });
  });

  test('/transactions/sync first pull: pages through has_more with next_cursor', async () => {
    const { secret } = await linkedItem(mock, 'first');
    const start = mock.syncCursors().length;
    const r = await plaid.pull(secret);
    // 13 log entries, mock page size 4 -> 4 pages: no cursor, c4, c8, c12
    assert.deepStrictEqual(mock.syncCursors().slice(start), [undefined, 'c4', 'c8', 'c12']);
    assert.strictEqual(r.secret.cursor, 'c13', 'final cursor handed back to be sealed');
    assert.strictEqual(r.secret.accessToken, secret.accessToken);
    assert.strictEqual(r.transactions.length, 12, 'pending transaction skipped');
    assert.ok(!byId(r.transactions, 'tx-pending'));
    assert.deepStrictEqual(r.removed, []);
    assert.deepStrictEqual(r.errors, []);
  });

  test('/transactions/sync: Plaid +out amounts flip to our +in/-out; dates and names', async () => {
    const { secret } = await linkedItem(mock, 'signs');
    const r = await plaid.pull(secret);
    const pay = byId(r.transactions, 'tx-pay-1');
    const heb = byId(r.transactions, 'tx-heb');
    assert.strictEqual(pay.amount, 1500, 'direct deposit (Plaid -1500) is money in');
    assert.strictEqual(heb.amount, -86.12, 'purchase (Plaid 86.12) is money out');
    assert.strictEqual(heb.desc, 'H-E-B', 'merchant_name preferred over raw name');
    assert.strictEqual(pay.desc, 'ACME CORP PAYROLL PPD', 'falls back to name');
    const raw = mock.items
      .get(secret.accessToken)
      .log.find(e => e.tx.transaction_id === 'tx-heb').tx;
    assert.strictEqual(heb.date, raw.authorized_date, 'authorized_date preferred over posted date');
  });

  test('/accounts/get: kinds, masks, credit balances stored as owed (negative)', async () => {
    const { secret } = await linkedItem(mock, 'accts');
    const r = await plaid.pull(secret);
    const chk = r.accounts.find(a => a.id === 'acc-chk-9Xyz');
    const cc = r.accounts.find(a => a.id === 'acc-cc-7Tsr');
    assert.deepStrictEqual(
      {
        kind: chk.kind,
        balance: chk.balance,
        available: chk.available,
        name: chk.name,
        org: chk.org,
      },
      {
        kind: 'depository',
        balance: 1340.5,
        available: 1290.5,
        name: 'Plaid Checking ••0000',
        org: 'First Platypus Bank',
      },
    );
    assert.strictEqual(cc.kind, 'credit');
    assert.strictEqual(cc.balance, -410);
  });

  test('/transactions/sync incremental: only new updates, with added/modified/removed', async () => {
    const { secret } = await linkedItem(mock, 'incr');
    const first = await plaid.pull(secret);
    const T = mock.tx;
    mock.push(first.secret.accessToken, {
      added: [
        T('tx-new-taco', 'acc-cc-7Tsr', 1, 23.8, 'TACO BELL #3321', { merchant_name: 'Taco Bell' }),
      ],
      modified: [
        T('tx-heb', 'acc-chk-9Xyz', 10, 91.45, 'H-E-B #622 HOUSTON TX', { merchant_name: 'H-E-B' }),
      ],
      removed: [T('tx-nflx', 'acc-cc-7Tsr', 18, 15.49, 'NETFLIX.COM')],
    });
    const start = mock.syncCursors().length;
    const second = await plaid.pull(first.secret);
    assert.deepStrictEqual(
      mock.syncCursors().slice(start),
      ['c13'],
      'resumes from the saved cursor',
    );
    assert.strictEqual(second.secret.cursor, 'c16');
    assert.deepStrictEqual(
      second.transactions.map(t => [t.id, t.amount, t.modified]),
      [
        ['tx-new-taco', -23.8, false],
        ['tx-heb', -91.45, true],
      ],
    );
    assert.deepStrictEqual(second.removed, [{ accountId: 'acc-cc-7Tsr', id: 'tx-nflx' }]);
    // nothing new: one call, same cursor
    const third = await plaid.pull(second.secret);
    assert.strictEqual(third.transactions.length, 0);
    assert.strictEqual(third.secret.cursor, 'c16');
  });

  test('TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION restarts from the first cursor', async () => {
    const { secret } = await linkedItem(mock, 'mutate');
    mock.failNext(
      '/transactions/sync',
      400,
      {
        error_type: 'TRANSACTIONS_ERROR',
        error_code: 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION',
        error_message:
          'Underlying transaction data changed since last page was fetched. Please restart pagination from last update.',
      },
      { skip: 2 }, // fail on the 3rd page
    );
    const start = mock.syncCursors().length;
    const r = await plaid.pull(secret);
    assert.deepStrictEqual(
      mock.syncCursors().slice(start),
      [undefined, 'c4', 'c8', undefined, 'c4', 'c8', 'c12'],
      'whole loop restarted from the original (empty) cursor',
    );
    assert.strictEqual(r.transactions.length, 12, 'no duplicates from the aborted run');
    assert.strictEqual(new Set(r.transactions.map(t => t.id)).size, 12);
  });

  test('mutation errors that never stop give up after a few restarts', async () => {
    const { secret } = await linkedItem(mock, 'mutateforever');
    const body = {
      error_type: 'TRANSACTIONS_ERROR',
      error_code: 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION',
    };
    for (let i = 0; i < 4; i++) {
      mock.failNext('/transactions/sync', 400, body);
    }
    await assert.rejects(plaid.pull(secret), e => e.code === 'mutation');
  });

  test('ITEM_LOGIN_REQUIRED (and other relink errors) map to code "revoked"', async () => {
    const { secret } = await linkedItem(mock, 'relogin');
    for (const code of [
      'ITEM_LOGIN_REQUIRED',
      'ITEM_LOCKED',
      'USER_PERMISSION_REVOKED',
      'INVALID_ACCESS_TOKEN',
    ]) {
      mock.failNext('/accounts/get', 400, {
        error_type: 'ITEM_ERROR',
        error_code: code,
        error_message: 'the login details of this item have changed',
        display_message: 'Please update your credentials.',
      });
      await assert.rejects(plaid.pull(secret), e => {
        assert.ok(e instanceof LinkError);
        assert.strictEqual(e.code, 'revoked', code);
        assert.strictEqual(e.plaidCode, code);
        assert.match(e.message, /log in again/);
        return true;
      });
    }
  });

  test('rate limits (HTTP 429 / RATE_LIMIT_EXCEEDED) map to a 429 "rate_limit" error', async () => {
    const { secret } = await linkedItem(mock, 'ratelimit');
    mock.failNext('/transactions/sync', 429, {
      error_type: 'RATE_LIMIT_EXCEEDED',
      error_code: 'TRANSACTIONS_SYNC_LIMIT',
      error_message: 'rate limit exceeded for attempts to access this item. please try again later',
    });
    await assert.rejects(plaid.pull(secret), e => {
      assert.strictEqual(e.code, 'rate_limit');
      assert.strictEqual(e.status, 429);
      assert.strictEqual(e.plaidCode, 'TRANSACTIONS_SYNC_LIMIT');
      return true;
    });
  });

  test('institution down, product not ready, and unknown errors get safe messages', async () => {
    const { secret } = await linkedItem(mock, 'errs');
    mock.failNext('/accounts/get', 400, {
      error_type: 'INSTITUTION_ERROR',
      error_code: 'INSTITUTION_DOWN',
    });
    await assert.rejects(plaid.pull(secret), /isn't answering Plaid/);
    mock.failNext('/transactions/sync', 400, {
      error_type: 'ITEM_ERROR',
      error_code: 'PRODUCT_NOT_READY',
    });
    await assert.rejects(plaid.pull(secret), e => e.code === 'not_ready');
    mock.failNext('/accounts/get', 500, {
      error_type: 'API_ERROR',
      error_code: 'INTERNAL_SERVER_ERROR',
      display_message: '<img src=x> see https://evil.example/phish now',
    });
    await assert.rejects(plaid.pull(secret), e => {
      assert.strictEqual(e.message, 'Plaid error: see [link] now', 'HTML and URLs stripped');
      return true;
    });
  });

  test('NOT_READY update status: warning, and an empty next_cursor is not saved', async () => {
    const { secret, item } = await linkedItem(mock, 'notready');
    item.status = 'NOT_READY';
    const r = await plaid.pull(secret);
    assert.strictEqual(r.transactions.length, 0);
    assert.strictEqual(r.secret.cursor, null);
    assert.match(r.errors[0], /still pulling your history/);
  });

  test('unreadable or unreachable Plaid responses', async () => {
    const { secret } = await linkedItem(mock, 'junk');
    mock.failNext('/accounts/get', 200, '<html>gateway</html>');
    await assert.rejects(plaid.pull(secret), /unreadable/);
    process.env.PLAID_API_BASE = `http://127.0.0.1:${await freePort()}`; // nothing listening
    await assert.rejects(plaid.pull(secret), e => e.code === 'network');
    process.env.PLAID_API_BASE = mock.url;
  });

  test('unlink calls /item/remove (ends billing) and never throws', async () => {
    const { secret } = await linkedItem(mock, 'bye');
    await plaid.unlink(secret);
    assert.ok(
      mock.hits.some(h => h.path === '/item/remove' && h.body.access_token === secret.accessToken),
    );
    assert.ok(!mock.items.has(secret.accessToken));
    await plaid.unlink(secret); // now invalid upstream: still resolves
  });
});

test.describe('Plaid end to end through the server (mocked sandbox)', () => {
  let app;
  let pm;
  test.before(async () => {
    pm = await startPlaidMock({ pageSize: 5 });
    app = await startApp({
      PLAID_CLIENT_ID: CLIENT_ID,
      PLAID_SECRET: SECRET,
      PLAID_API_BASE: pm.url,
    });
  });
  test.after(async () => {
    app.stop();
    await pm.close();
  });

  test('link, sync, categorize, transfers, incremental updates, errors, privacy, unlink', async () => {
    const A = app.client();
    const B = app.client();
    await A('/api/auth/register', 'POST', { username: 'plaid_a', password: 'plaidpass1' });
    await B('/api/auth/register', 'POST', { username: 'plaid_b', password: 'plaidpass2' });

    const provs = (await A('/api/bank/providers')).j;
    assert.strictEqual(provs.providers.find(p => p.id === 'plaid').enabled, true);
    const lt = await A('/api/bank/plaid/link-token', 'POST', {});
    assert.strictEqual(lt.status, 200);
    assert.match(lt.j.linkToken, /^link-sandbox-/);

    // A CSV imported before linking: the matching Plaid row must dedupe against it
    const heb = pm.tx('x', 'x', 10, 0, 'x');
    const csv = `Date,Description,Amount\n${heb.authorized_date},H-E-B,-86.12\n`;
    const prev = await A('/api/import/preview', 'POST', { text: csv, filename: 'chase.csv' });
    await A('/api/import/commit', 'POST', { rows: prev.j.rows });

    const r = await A('/api/bank/links', 'POST', {
      provider: 'plaid',
      publicToken: 'public-sandbox-e2e',
      institution: 'First Platypus Bank',
    });
    assert.strictEqual(r.status, 201, r.text);
    const L = r.j.link;
    assert.strictEqual(L.provider, 'plaid');
    assert.strictEqual(L.status, 'ok');
    assert.strictEqual(L.accounts.length, 3);
    // 12 posted: 4 transfer rows ignored, H-E-B already in from the CSV
    assert.deepStrictEqual(
      { ...r.j.first, at: undefined },
      {
        fetched: 12,
        added: 7,
        dupes: 1,
        transfers: 4,
        removed: 0,
        updated: 0,
        deleted: 0,
        billsPaid: 0,
        at: undefined,
      },
    );

    let S = (await A('/api/state')).j;
    const by = d => S.tx.filter(t => (t.desc || '').includes(d));
    assert.strictEqual(by('PAYROLL').length, 2);
    assert.ok(
      by('PAYROLL').every(
        t => t.type === 'income' && t.category === 'Paycheck' && t.amount === 1500,
      ),
    );
    assert.strictEqual(by('Netflix')[0].category, 'Subscriptions');
    assert.strictEqual(by('Shell')[0].category, 'Gas');
    assert.strictEqual(by('Starbucks').length, 2, 'two identical real purchases both kept');
    assert.strictEqual(by('TRANSFER').length + by('AUTOPAY').length + by('THANK YOU').length, 0);
    assert.strictEqual(by('H-E-B').length, 1, 'CSV row and Plaid row deduped');
    assert.ok(!('links' in S), 'state never exposes link secrets');

    // the access token and cursor are only stored sealed
    const onDisk = app.readData();
    const accessToken = [...pm.items.keys()].find(k => k.startsWith('access-sandbox-e2e-'));
    assert.ok(
      accessToken && !onDisk.includes(accessToken),
      'access token not on disk in clear text',
    );
    assert.ok(!onDisk.includes('"cursor"'));

    // incremental: Plaid modifies a row, removes one, adds one
    pm.push(accessToken, {
      added: [
        pm.tx('tx-new-taco', 'acc-cc-7Tsr', 1, 23.8, 'TACO BELL #3321', {
          merchant_name: 'Taco Bell',
        }),
      ],
      modified: [
        pm.tx('tx-shell', 'acc-cc-7Tsr', 9, 44.6, 'SHELL OIL 57444', { merchant_name: 'Shell' }),
      ],
      removed: [pm.tx('tx-nflx', 'acc-cc-7Tsr', 18, 15.49, 'NETFLIX.COM')],
    });
    const s2 = await A(`/api/bank/links/${L.id}/sync`, 'POST', {});
    assert.strictEqual(s2.status, 200, s2.text);
    assert.deepStrictEqual(
      { added: s2.j.added, updated: s2.j.updated, deleted: s2.j.deleted, fetched: s2.j.fetched },
      { added: 2, updated: 1, deleted: 1, fetched: 2 },
    );
    S = (await A('/api/state')).j;
    assert.strictEqual(by('Netflix').length, 0, 'removed upstream -> removed here');
    assert.deepStrictEqual(
      by('Shell').map(t => t.amount),
      [44.6],
      'modified row replaced, not duplicated',
    );
    assert.strictEqual(by('Taco Bell')[0].category, 'Food');

    // a nothing-new sync is cheap: one /transactions/sync from the saved cursor
    const n = pm.syncCursors().length;
    const s3 = await A(`/api/bank/links/${L.id}/sync`, 'POST', {});
    assert.strictEqual(s3.j.added, 0);
    assert.deepStrictEqual(pm.syncCursors().slice(n), ['c16']);

    // other users can't see or touch it
    assert.deepStrictEqual((await B('/api/bank/links')).j, []);
    assert.strictEqual((await B(`/api/bank/links/${L.id}/sync`, 'POST', {})).status, 404);
    assert.strictEqual((await B(`/api/bank/links/${L.id}`, 'DELETE')).status, 404);

    // rate limited: 429 to the client, link marked error (not needs_attention)
    pm.failNext('/accounts/get', 429, {
      error_type: 'RATE_LIMIT_EXCEEDED',
      error_code: 'RATE_LIMIT',
    });
    const rl = await A(`/api/bank/links/${L.id}/sync`, 'POST', {});
    assert.strictEqual(rl.status, 429);
    assert.match(rl.j.error, /rate limiting/);
    assert.strictEqual((await A('/api/bank/links')).j[0].status, 'error');

    // bank wants a re-login: link needs attention, message says so
    pm.failNext('/accounts/get', 400, {
      error_type: 'ITEM_ERROR',
      error_code: 'ITEM_LOGIN_REQUIRED',
    });
    const relog = await A(`/api/bank/links/${L.id}/sync`, 'POST', {});
    assert.strictEqual(relog.status, 502);
    const after = (await A('/api/bank/links')).j[0];
    assert.strictEqual(after.status, 'needs_attention');
    assert.match(after.error, /log in again/);

    // unlink: removes the Item upstream and (optionally) its transactions here
    const d = await A(`/api/bank/links/${L.id}?dropTx=1`, 'DELETE');
    assert.strictEqual(d.status, 200);
    assert.strictEqual(d.j.dropped, 7, '7 first sync + 2 new - 1 removed - 1 replaced');
    assert.ok(pm.hits.some(h => h.path === '/item/remove' && h.body.access_token === accessToken));
    S = (await A('/api/state')).j;
    assert.deepStrictEqual(
      S.tx.map(t => t.source),
      ['import'],
      'only the CSV row is left',
    );
  });

  test('bad public token from the browser is rejected with 400 and nothing is stored', async () => {
    const A = app.client();
    await A('/api/auth/register', 'POST', { username: 'plaid_c', password: 'plaidpass3' });
    const r = await A('/api/bank/links', 'POST', { provider: 'plaid', publicToken: 'nope' });
    assert.strictEqual(r.status, 400);
    assert.deepStrictEqual((await A('/api/bank/links')).j, []);
  });
});
