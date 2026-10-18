// Unit tests for bank-link pieces that don't need the HTTP server: SimpleFIN normalization and URL
// safety, the Teller adapter against the local mock, sealing (encryption tied to user + link),
// transfer detection, and the service's handling of tampered or moved secrets.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const sealer = require('../bank-link/crypto');
const { findTransfers } = require('../bank-link/transfers');
const simplefin = require('../bank-link/providers/simplefin');
const teller = require('../bank-link/providers/teller');
const bankLink = require('../bank-link/service');
const { dayOf } = require('../bank-link/providers/util');
const mock = require('./mocks/simplefin-teller-mock');

const ENV_KEYS = [
  'NODE_ENV',
  'SIMPLEFIN_ALLOW_INSECURE_LOCAL',
  'SIMPLEFIN_HOSTS',
  'TELLER_API_BASE',
  'TELLER_ENV',
  'TELLER_SANDBOX_DEMO',
  'TELLER_CERT',
  'TELLER_KEY',
];
let saved;
let M;
test.before(async () => {
  saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  M = await mock.start();
  process.env.TELLER_API_BASE = `http://127.0.0.1:${M.address().port}`;
  process.env.TELLER_SANDBOX_DEMO = '1';
  delete process.env.NODE_ENV;
  delete process.env.TELLER_ENV;
});
test.after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  M.closeAllConnections();
  M.close();
});

test.describe('SimpleFIN', () => {
  const at = iso => Date.parse(iso) / 1000;
  const set = {
    errlist: [{ code: 'gen.auth', msg: 'Login needed at <a href="https://bank.example">bank</a>' }],
    errors: ['legacy error string'],
    connections: [{ conn_id: 'C1', name: 'Conn Name', org_name: 'Houston Credit Union' }],
    accounts: [
      {
        id: 'A1',
        name: 'Checking',
        conn_id: 'C1',
        currency: 'USD',
        balance: '100.005',
        'available-balance': '90',
        'balance-date': at('2026-10-17T12:00:00Z'),
        transactions: [
          // 03:00 UTC on the 17th is still the 16th in Houston
          { id: 't1', posted: at('2026-10-17T03:00:00Z'), amount: '-12.34', description: 'COFFEE' },
          { id: 't2', posted: at('2026-10-15T12:00:00Z'), amount: '0.00', description: 'zero' },
          { id: 't3', posted: 0, amount: '-1', description: 'no date', pending: false },
          {
            id: 't4',
            posted: at('2026-10-15T12:00:00Z'),
            amount: '-5',
            description: 'p',
            pending: true,
          },
          { id: 't5', posted: at('2026-10-14T12:00:00Z'), amount: '50', payee: 'Venmo <b>Bob</b>' },
          { id: 't6', posted: at('2026-10-14T12:00:00Z'), amount: 'abc', description: 'junk' },
        ],
      },
      {
        id: 'A2',
        name: 'Sapphire Preferred',
        org: { name: 'Chase' },
        currency: 'usd',
        balance: '25',
      },
      { id: 'A3', name: 'Mystery', conn_id: 'nope', currency: 'EUR', balance: '-40' },
    ],
  };

  test('normalize: accounts, kinds, org names, currency, balances', () => {
    const r = simplefin.normalize(set);
    const [chk, card, other] = r.accounts;
    assert.deepStrictEqual(
      { id: chk.id, org: chk.org, kind: chk.kind, balance: chk.balance, available: chk.available },
      { id: 'A1', org: 'Houston Credit Union', kind: 'depository', balance: 100.01, available: 90 },
    );
    assert.strictEqual(chk.balanceDate, '2026-10-17T12:00:00.000Z');
    assert.strictEqual(card.kind, 'credit', 'credit detected from the card name');
    assert.strictEqual(card.org, 'Chase');
    assert.strictEqual(card.currency, 'USD', 'lowercase currency rejected -> USD');
    assert.strictEqual(other.kind, 'credit', 'negative balance means money owed');
    assert.strictEqual(other.org, 'Bank');
    assert.strictEqual(other.currency, 'EUR');
  });

  test('normalize: transactions skip pending, zero, undated and junk amounts; dates in Houston time', () => {
    const r = simplefin.normalize(set);
    assert.deepStrictEqual(
      r.transactions.map(t => [t.id, t.date, t.amount, t.desc]),
      [
        ['t1', '2026-10-16', -12.34, 'COFFEE'],
        ['t5', '2026-10-14', 50, 'Venmo Bob'],
      ],
    );
    assert.strictEqual(dayOf(at('2026-10-17T05:30:00Z')), '2026-10-17');
  });

  test('normalize: provider error text is sanitized', () => {
    const r = simplefin.normalize(set);
    assert.deepStrictEqual(r.errors, ['Login needed at bank', 'legacy error string']);
  });

  test('setup tokens: must be base64 of an https URL on an allowlisted host', async () => {
    const b64 = s => Buffer.from(s).toString('base64');
    await assert.rejects(simplefin.link({ token: '' }), /Paste the SimpleFIN setup token/);
    await assert.rejects(
      simplefin.link({ token: b64('not a url') }),
      /doesn't look like a SimpleFIN/,
    );
    await assert.rejects(
      simplefin.link({ token: b64('http://beta-bridge.simplefin.org/claim/x') }),
      /https/,
    );
    await assert.rejects(simplefin.link({ token: b64('https://evil.example/claim/x') }), /trust/);
    process.env.SIMPLEFIN_HOSTS = 'my-bridge.example';
    await assert.rejects(
      simplefin.link({ token: b64('https://beta-bridge.simplefin.org/claim/x') }),
      /trust/,
    );
    delete process.env.SIMPLEFIN_HOSTS;
  });

  test('the local-http escape hatch is ignored in production', async () => {
    process.env.SIMPLEFIN_ALLOW_INSECURE_LOCAL = '1';
    process.env.NODE_ENV = 'production';
    const token = Buffer.from(`http://127.0.0.1:${M.address().port}/simplefin/claim/demo`).toString(
      'base64',
    );
    try {
      await assert.rejects(simplefin.link({ token }), /must use https/);
    } finally {
      delete process.env.NODE_ENV;
      delete process.env.SIMPLEFIN_ALLOW_INSECURE_LOCAL;
    }
  });
});

test.describe('Teller adapter (against the local mock)', () => {
  test('link validates the token shape and the token itself', async () => {
    await assert.rejects(teller.link({ accessToken: 'x' }), /Missing Teller access token/);
    await assert.rejects(
      teller.link({ accessToken: 'test_token_wrong99' }),
      e => e.code === 'revoked',
    );
    const r = await teller.link({ accessToken: 'test_token_mock123' });
    assert.strictEqual(r.label, 'Mock CU (Teller sandbox)');
    assert.deepStrictEqual(r.secret, { accessToken: 'test_token_mock123', env: 'sandbox' });
  });

  test('live Teller modes refuse to link without the mTLS client certificate', async () => {
    process.env.TELLER_ENV = 'development';
    try {
      await assert.rejects(
        teller.link({ accessToken: 'test_token_mock123' }),
        e => e.code === 'config' && e.status === 503,
      );
    } finally {
      delete process.env.TELLER_ENV;
    }
  });

  test('pull: closed accounts skipped, card amounts flipped, pending skipped, start_date sent', async () => {
    const before = M.hits.length;
    const r = await teller.pull(
      { accessToken: 'test_token_mock123' },
      { since: '2026-10-01T05:00:00Z' },
    );
    assert.deepStrictEqual(
      r.accounts.map(a => a.id),
      ['acc_card', 'acc_chk'],
    );
    assert.strictEqual(r.accounts[0].name, 'Platinum Card ••7857');
    assert.strictEqual(r.accounts[0].balance, -300.5, 'card balance owed is negative');
    assert.deepStrictEqual(
      r.transactions.map(t => [t.id, t.amount]),
      [
        ['t1', -58.83],
        ['t3', -28.98],
      ],
    );
    assert.ok(M.hits.slice(before).some(h => h.includes('/transactions?start_date=2026-10-01')));
    assert.deepStrictEqual(r.errors, []);
  });

  test('pull: a broken balances endpoint is a warning, transactions still come through', async () => {
    const r = await teller.pull({ accessToken: 'test_token_nobal1' });
    assert.strictEqual(r.transactions.length, 2);
    assert.ok(r.accounts.every(a => a.balance === null));
    assert.deepStrictEqual(r.errors, [
      'Platinum Card: balance unavailable',
      'My Checking: balance unavailable',
    ]);
  });
});

test.describe('sealing secrets (AES-256-GCM, AAD = user + link)', () => {
  const raw = crypto.randomBytes(32);
  const s = sealer(raw.toString('base64'));

  test('hex and base64 forms of the same key are interchangeable', () => {
    const hex = sealer(raw.toString('hex'));
    assert.strictEqual(hex.fingerprint, s.fingerprint);
    assert.match(s.fingerprint, /^[0-9a-f]{8}$/);
    assert.deepStrictEqual(hex.open(s.seal({ a: 1 }, 'mv-bank:u1:l1'), 'mv-bank:u1:l1'), { a: 1 });
  });

  test('fresh IV every time; format v1.iv.tag.ciphertext; no plaintext inside', () => {
    const a = s.seal({ accessToken: 'access-sandbox-secret' }, 'x');
    const b = s.seal({ accessToken: 'access-sandbox-secret' }, 'x');
    assert.notStrictEqual(a, b);
    assert.match(a, /^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    assert.ok(
      !a.includes('access-sandbox') &&
        !Buffer.from(a.split('.')[3], 'base64url').includes('access'),
    );
  });

  test('a sealed secret only opens for the same user AND the same link', () => {
    const blob = s.seal({ t: 'secret' }, 'mv-bank:alice:link1');
    assert.deepStrictEqual(s.open(blob, 'mv-bank:alice:link1'), { t: 'secret' });
    assert.throws(() => s.open(blob, 'mv-bank:bob:link1'), 'other user');
    assert.throws(() => s.open(blob, 'mv-bank:alice:link2'), 'other link');
    assert.throws(
      () => sealer(crypto.randomBytes(32).toString('base64')).open(blob, 'mv-bank:alice:link1'),
      'other key',
    );
  });

  test('tampering, bad formats and missing keys all fail closed', () => {
    const blob = s.seal({ t: 1 }, 'aad');
    const parts = blob.split('.');
    const flip = str => (str[0] === 'A' ? 'B' : 'A') + str.slice(1);
    assert.throws(() => s.open([parts[0], parts[1], parts[2], flip(parts[3])].join('.'), 'aad'));
    assert.throws(() => s.open([parts[0], parts[1], flip(parts[2]), parts[3]].join('.'), 'aad'));
    assert.throws(() => s.open('v2.' + parts.slice(1).join('.'), 'aad'), /Bad sealed secret/);
    assert.throws(() => s.open('', 'aad'), /Bad sealed secret/);
    assert.throws(() => sealer('too-short'), /32 bytes/);
    const off = sealer('');
    assert.strictEqual(off.ready, false);
    assert.throws(() => off.seal({}, 'x'), /not configured/);
  });
});

test.describe('service: moved or tampered secrets never decrypt', () => {
  // Minimal in-memory store + vault, same interface server.js passes in.
  function harness() {
    const db = { vaults: {} };
    let n = 0;
    const store = { read: () => db, mutate: async fn => fn(), newId: () => 'id' + ++n };
    const vault = uid => (db.vaults[uid] ||= { tx: [], rules: [] });
    const ingest = (V, rows) => {
      for (const r of rows) {
        V.tx.push({ ...r, source: 'bank' });
      }
      return { added: rows.length, dupes: 0 };
    };
    const svc = bankLink({
      store,
      vault,
      ingest,
      sealer: sealer(crypto.randomBytes(32).toString('base64')),
      log: { error() {} },
    });
    return { db, svc, vault };
  }

  test('a link copied into another user vault fails to sync and is flagged', async () => {
    const { svc, vault } = harness();
    const { link } = await svc.create('alice', 'teller', { accessToken: 'test_token_mock123' });
    assert.strictEqual(link.status, 'ok');
    assert.strictEqual(vault('alice').tx.length, 2);
    // attacker copies alice's sealed link (same id and blob) into their own vault
    const stolen = JSON.parse(JSON.stringify(vault('alice').links[0]));
    vault('mallory').links = [stolen];
    await assert.rejects(
      svc.sync('mallory', stolen.id),
      e => e.status === 502 && /Sync failed/.test(e.message),
    );
    assert.strictEqual(vault('mallory').links[0].status, 'error');
    assert.strictEqual(vault('mallory').tx.length, 0, 'nothing pulled with a stolen secret');
    // and re-labelled under a different link id in the same vault also fails
    vault('alice').links.push({ ...stolen, id: 'other-link' });
    await assert.rejects(svc.sync('alice', 'other-link'));
  });

  test('list() never exposes the sealed secret', async () => {
    const { svc } = harness();
    await svc.create('u1', 'teller', { accessToken: 'test_token_mock123' });
    const listed = svc.list('u1');
    assert.strictEqual(listed.length, 1);
    assert.ok(!('secret' in listed[0]));
    assert.ok(!JSON.stringify(listed).includes('test_token'));
  });
});

test.describe('transfer detection', () => {
  const acct = [
    { id: 'chk', kind: 'depository' },
    { id: 'sav', kind: 'depository' },
    { id: 'cc', kind: 'credit' },
  ];
  const t = (id, accountId, date, amount, desc) => ({ id, accountId, date, amount, desc });
  const keys = m => [...m.keys()].sort();

  test('card-side payment credits are transfers; card purchases and refunds are not', () => {
    const m = findTransfers(
      [
        t('1', 'cc', '2026-10-05', 250, 'PAYMENT - THANK YOU'),
        t('2', 'cc', '2026-10-05', 19.99, 'AMAZON REFUND'),
        t('3', 'cc', '2026-10-05', -19.99, 'AMAZON MKTPLACE'),
      ],
      acct,
    );
    assert.deepStrictEqual(keys(m), ['cc|1']);
    assert.strictEqual(m.get('cc|1'), 'card payment');
  });

  test('same amount out of one account and into another within 4 days pairs up', () => {
    const m = findTransfers(
      [
        t('o', 'chk', '2026-10-01', -100, 'ONLINE TRANSFER'),
        t('i', 'sav', '2026-10-05', 100, 'ONLINE TRANSFER'),
        t('o2', 'chk', '2026-10-01', -60, 'X'),
        t('i2', 'sav', '2026-10-06', 60, 'X'), // 5 days later: not a pair
        t('o3', 'chk', '2026-10-01', -70, 'Y'),
        t('i3', 'chk', '2026-10-01', 70, 'Y'), // same account: not a transfer
        t('o4', 'chk', '2026-10-01', -80, 'Z'),
        t('i4', 'sav', '2026-10-01', 80.01, 'Z'), // a cent off: not a pair
      ],
      acct,
    );
    assert.deepStrictEqual(keys(m), ['chk|o', 'sav|i']);
  });

  test('each incoming half is used once', () => {
    const m = findTransfers(
      [
        t('o1', 'chk', '2026-10-01', -50, 'A'),
        t('o2', 'chk', '2026-10-01', -50, 'B'),
        t('i1', 'sav', '2026-10-01', 50, 'C'),
      ],
      acct,
    );
    assert.strictEqual(m.size, 2);
  });

  test('checking-side card payments count as transfers only when a card is linked', () => {
    const rows = [t('p', 'chk', '2026-10-03', -250, 'CAPITAL ONE CRD PMT WEB ID 99')];
    assert.deepStrictEqual(keys(findTransfers(rows, acct)), ['chk|p']);
    assert.strictEqual(
      findTransfers(
        rows,
        acct.filter(a => a.kind !== 'credit'),
      ).size,
      0,
    );
    assert.strictEqual(
      findTransfers([t('r', 'chk', '2026-10-03', -1200, 'ZILLOW RENT PAYMENT')], acct).size,
      0,
    );
  });
});
