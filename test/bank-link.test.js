// End-to-end tests for bank-link against mocked providers (no real bank data). Run: node --test test/
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const mock = require('./mock-providers');
const sealer = require('../bank-link/crypto');
const { findTransfers } = require('../bank-link/transfers');
let M;
let app;
let base;
let dir;
const KEY = crypto.randomBytes(32).toString('base64');
const tok = p =>
  Buffer.from(`http://127.0.0.1:${M.address().port}/simplefin/claim/${p}`).toString('base64');
async function client() {
  let cookie = '';
  const call = async (u, method = 'GET', body) => {
    const r = await fetch(base + u, {
      method,
      headers: { 'Content-Type': 'application/json', cookie },
      body: body && JSON.stringify(body),
    });
    const sc = r.headers.get('set-cookie');
    if (sc) {
      cookie = sc.split(';')[0];
    }
    const text = await r.text();
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      j = text;
    }
    return { status: r.status, j, text };
  };
  return call;
}
test.before(async () => {
  M = await mock.start();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-'));
  const port = 3900 + Math.floor(Math.random() * 90);
  base = `http://127.0.0.1:${port}`;
  app = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: port,
      DATA_FILE: path.join(dir, 'db.json'),
      BANK_LINK_KEY: KEY,
      SIMPLEFIN_ALLOW_INSECURE_LOCAL: '1',
      BANK_MANUAL_GAP_SEC: '0',
      TELLER_SANDBOX_DEMO: '1',
      TELLER_API_BASE: `http://127.0.0.1:${M.address().port}`,
      SUPABASE_URL: '',
      SUPABASE_SERVICE_KEY: '',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  app.stderr.on('data', d => process.stderr.write(d));
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(base + '/healthz')).ok) {
        return;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});
test.after(() => {
  app && app.kill();
  if (M) {
    M.closeAllConnections();
    M.close();
  }
});

test('crypto: round trip, AAD binding, tamper detection', () => {
  const s = sealer(KEY);
  const b = s.seal({ accessUrl: 'https://u:p@x/simplefin' }, 'u1:l1');
  assert.deepStrictEqual(s.open(b, 'u1:l1'), { accessUrl: 'https://u:p@x/simplefin' });
  assert.throws(() => s.open(b, 'u2:l1'));
  assert.throws(() => s.open(b.slice(0, -3) + 'AAA', 'u1:l1'));
  assert.throws(() => sealer('short'));
  assert.strictEqual(sealer('').ready, false);
});

test('transfers: card payments and own-account moves are not spending', () => {
  const acc = [
    { id: 'chk', kind: 'depository' },
    { id: 'sav', kind: 'depository' },
    { id: 'cc', kind: 'credit' },
  ];
  const t = (accountId, id, amount, desc, date = '2026-10-10') => ({
    accountId,
    id,
    amount,
    desc,
    date,
  });
  const out = findTransfers(
    [
      t('chk', 1, -250, 'CHASE CREDIT CRD AUTOPAY'),
      t('cc', 2, 250, 'AUTOMATIC PAYMENT - THANK YOU'),
      t('chk', 3, -100, 'TRANSFER TO SAV'),
      t('sav', 4, 100, 'TRANSFER FROM CHK', '2026-10-12'),
      t('chk', 5, -100, 'ZELLE TO MOM'),
      t('cc', 6, -40, 'SHELL'),
    ],
    acc,
  );
  assert.deepStrictEqual([...out.keys()].sort(), ['cc|2', 'chk|1', 'chk|3', 'sav|4']);
});

test('SimpleFIN: link, pull checking + savings + credit card, categorize, dedupe, privacy', async () => {
  const A = await client();
  const B = await client();
  assert.strictEqual(
    (await A('/api/auth/register', 'POST', { username: 'demo_a', password: 'demopass1' })).status,
    201,
  );
  assert.strictEqual(
    (await B('/api/auth/register', 'POST', { username: 'demo_b', password: 'demopass2' })).status,
    201,
  );
  const pv = await A('/api/bank/providers');
  assert.strictEqual(pv.j.configured, true);
  assert.ok(pv.j.providers.find(p => p.id === 'simplefin').enabled);
  const r = await A('/api/bank/links', 'POST', { provider: 'simplefin', token: tok('abc') });
  assert.strictEqual(r.status, 201, r.text);
  assert.ok(!r.text.includes(mock.PASS), 'secret never leaves the server');
  const L = r.j.link;
  assert.strictEqual(L.accounts.length, 3);
  assert.strictEqual(L.accounts.find(a => a.id === 'cc1').kind, 'credit');
  assert.strictEqual(L.accounts.find(a => a.id === 'cc1').balance, -812.4);
  assert.strictEqual(L.accounts.find(a => a.id === 'chk1').kind, 'depository');
  assert.deepStrictEqual(r.j.first, {
    fetched: 15,
    added: 11,
    dupes: 0,
    transfers: 4,
    removed: 0,
    billsPaid: 0,
    at: r.j.first.at,
  });
  assert.ok(
    L.warnings[0].includes('Incomplete') &&
      !L.warnings[0].includes('<b>') &&
      !L.warnings[0].includes('secret.example'),
    'provider errors sanitized',
  );
  const S = (await A('/api/state')).j;
  assert.ok(!('links' in S), 'state does not expose links');
  const by = d => S.tx.filter(t => t.desc.includes(d));
  assert.strictEqual(by('PAYROLL').length, 3);
  assert.ok(by('PAYROLL').every(t => t.type === 'income' && t.category === 'Paycheck'));
  assert.strictEqual(by('NETFLIX')[0].category, 'Subscriptions');
  assert.strictEqual(by('STEAM')[0].category, 'Games');
  assert.strictEqual(by('SHELL')[0].category, 'Gas');
  assert.strictEqual(by('STARBUCKS').length, 2, 'two identical real coffees both kept');
  assert.strictEqual(by('RENT')[0].category, 'Rent');
  assert.strictEqual(
    by('CRD PMT').length + by('TRANSFER').length + by('THANK YOU').length,
    0,
    'transfers skipped',
  );
  assert.ok(S.tx.every(t => t.source === 'bank'));
  // on disk the access URL is sealed
  const raw = fs.readFileSync(path.join(dir, 'db.json'), 'utf8');
  assert.ok(!raw.includes(mock.PASS) && !raw.includes(mock.USER) && raw.includes('"secret": "v1.'));
  // re-sync: nothing new; incremental start-date sent
  const s2 = await A(`/api/bank/links/${L.id}/sync`, 'POST', {});
  assert.strictEqual(s2.status, 200, s2.text);
  assert.strictEqual(s2.j.added, 0);
  assert.ok(
    M.hits
      .filter(h => h.startsWith('GET /simplefin/accounts'))
      .every(h => /start-date=\d+/.test(h) && h.includes('version=2')),
  );
  // CSV of the same stuff after linking -> dupes
  const csv =
    'Date,Description,Amount\n' +
    S.tx
      .filter(t => t.desc.includes('NETFLIX'))
      .map(t => `${t.date},${t.desc},-${t.amount}`)
      .join('\n');
  const prev = await A('/api/import/preview', 'POST', { text: csv, filename: 'x.csv' });
  assert.strictEqual(prev.j.dupes, 1);
  // other user: can't see or touch it
  assert.deepStrictEqual((await B('/api/bank/links')).j, []);
  assert.strictEqual((await B(`/api/bank/links/${L.id}/sync`, 'POST', {})).status, 404);
  assert.strictEqual((await B(`/api/bank/links/${L.id}`, 'DELETE')).status, 404);
  assert.strictEqual((await B('/api/state')).j.tx.length, 0);
  // exclude an account
  const ex = await A(`/api/bank/links/${L.id}/accounts/sav1`, 'PUT', { include: false });
  assert.strictEqual(ex.j.accounts.find(a => a.id === 'sav1').include, false);
  // unlink and drop its transactions
  const d = await A(`/api/bank/links/${L.id}?dropTx=1`, 'DELETE');
  assert.strictEqual(d.j.dropped, 11);
  assert.deepStrictEqual((await A('/api/bank/links')).j, []);
  assert.strictEqual((await A('/api/state')).j.tx.length, 0);
  // logged out: 401
  assert.strictEqual((await (await client())('/api/bank/links')).status, 401);
});

test('SimpleFIN: protocol error handling (403 claim, 402 payment, untrusted hosts, junk)', async () => {
  const A = await client();
  await A('/api/auth/register', 'POST', { username: 'demo_c', password: 'demopass3' });
  const used = await A('/api/bank/links', 'POST', { provider: 'simplefin', token: tok('used') });
  assert.strictEqual(used.status, 403);
  assert.match(used.j.error, /compromised/);
  const evil = await A('/api/bank/links', 'POST', {
    provider: 'simplefin',
    token: Buffer.from('https://evil.example/simplefin/claim/x').toString('base64'),
  });
  assert.strictEqual(evil.status, 400);
  assert.match(evil.j.error, /trust/);
  const http = await A('/api/bank/links', 'POST', {
    provider: 'simplefin',
    token: Buffer.from('http://10.0.0.5/simplefin/claim/x').toString('base64'),
  });
  assert.strictEqual(http.status, 400);
  assert.match(http.j.error, /https/);
  assert.strictEqual(
    (await A('/api/bank/links', 'POST', { provider: 'simplefin', token: 'lol' })).status,
    400,
  );
  assert.strictEqual(
    (await A('/api/bank/links', 'POST', { provider: 'nope', token: 'x' })).status,
    400,
  );
  const broke = await A('/api/bank/links', 'POST', { provider: 'simplefin', token: tok('broke') });
  assert.strictEqual(broke.status, 201);
  assert.match(broke.j.first.error, /payment is required/);
  assert.strictEqual(broke.j.link.status, 'needs_attention');
});

test('Teller adapter: credit card sign flip, pending skipped, balances', async () => {
  const A = await client();
  await A('/api/auth/register', 'POST', { username: 'demo_t', password: 'demopass4' });
  const bad = await A('/api/bank/links', 'POST', {
    provider: 'teller',
    accessToken: 'test_token_wrong99',
  });
  assert.strictEqual(bad.status, 403);
  const r = await A('/api/bank/links', 'POST', {
    provider: 'teller',
    accessToken: 'test_token_mock123',
  });
  assert.strictEqual(r.status, 201, r.text);
  assert.strictEqual(r.j.link.accounts.find(a => a.id === 'acc_card').balance, -300.5);
  const S = (await A('/api/state')).j;
  assert.strictEqual(S.tx.length, 2);
  const fg = S.tx.find(t => t.desc === 'Five Guys');
  assert.strictEqual(fg.type, 'expense');
  assert.strictEqual(fg.amount, 58.83);
  assert.strictEqual(fg.category, 'Food');
});
