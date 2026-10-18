// Local stand-in for the Plaid API. Responses follow the shapes in Plaid's API reference
// (sandbox-style ids like access-sandbox-..., public-sandbox-...). Fake data only, no network.
//
// Each Item has an update log. /transactions/sync cursors are positions in that log, so tests can
// push new added/modified/removed updates and watch the adapter page through them.
//
//   const plaid = await startPlaidMock({ pageSize: 4 });
//   plaid.items.get('access-sandbox-item1').push({ removed: [...] })
//   plaid.failNext('/transactions/sync', 400, { error_code: 'ITEM_LOGIN_REQUIRED', ... }, { skip: 1 })
const http = require('http');

const CLIENT_ID = 'test-client-id';
const SECRET = 'test-plaid-secret';

const day = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

const ACCOUNTS = [
  {
    account_id: 'acc-chk-9Xyz',
    balances: { available: 1290.5, current: 1340.5, iso_currency_code: 'USD', limit: null },
    mask: '0000',
    name: 'Plaid Checking',
    official_name: 'Plaid Gold Standard 0% Interest Checking',
    subtype: 'checking',
    type: 'depository',
  },
  {
    account_id: 'acc-sav-8Wvu',
    balances: { available: 200, current: 210, iso_currency_code: 'USD', limit: null },
    mask: '1111',
    name: 'Plaid Saving',
    subtype: 'savings',
    type: 'depository',
  },
  {
    account_id: 'acc-cc-7Tsr',
    balances: { available: 3590, current: 410, iso_currency_code: 'USD', limit: 4000 },
    mask: '3333',
    name: 'Plaid Credit Card',
    subtype: 'credit card',
    type: 'credit',
  },
];

// Plaid convention: positive amount = money out of the account.
function tx(id, accountId, daysAgo, amount, name, extra = {}) {
  return {
    account_id: accountId,
    amount,
    iso_currency_code: 'USD',
    date: day(daysAgo),
    authorized_date: day(daysAgo + 1),
    name,
    merchant_name: extra.merchant_name === undefined ? null : extra.merchant_name,
    pending: false,
    pending_transaction_id: null,
    payment_channel: 'other',
    transaction_id: id,
    ...extra,
  };
}

function initialHistory() {
  const chk = 'acc-chk-9Xyz';
  const sav = 'acc-sav-8Wvu';
  const cc = 'acc-cc-7Tsr';
  return [
    tx('tx-pay-1', chk, 28, -1500, 'ACME CORP PAYROLL PPD'),
    tx('tx-pay-2', chk, 14, -1500, 'ACME CORP PAYROLL PPD'),
    tx('tx-rent', chk, 20, 1200, 'ZILLOW RENT PAYMENT'),
    tx('tx-heb', chk, 10, 86.12, 'H-E-B #622 HOUSTON TX', { merchant_name: 'H-E-B' }),
    tx('tx-nflx', cc, 18, 15.49, 'NETFLIX.COM', { merchant_name: 'Netflix' }),
    tx('tx-shell', cc, 9, 42.1, 'SHELL OIL 57444', { merchant_name: 'Shell' }),
    tx('tx-sbux-1', cc, 6, 5.25, 'STARBUCKS STORE 1234', { merchant_name: 'Starbucks' }),
    tx('tx-sbux-2', cc, 6, 5.25, 'STARBUCKS STORE 1234', { merchant_name: 'Starbucks' }),
    // card payment: out of checking, into the card
    tx('tx-ccpay-chk', chk, 5, 250, 'CAPITAL ONE AUTOPAY PYMT'),
    tx('tx-ccpay-cc', cc, 5, -250, 'PAYMENT - THANK YOU'),
    // checking -> savings
    tx('tx-xfer-out', chk, 4, 100, 'ONLINE TRANSFER TO SAV 1111'),
    tx('tx-xfer-in', sav, 4, -100, 'ONLINE TRANSFER FROM CHK 0000'),
    // still pending: must be skipped
    tx('tx-pending', cc, 0, 9.99, 'PENDING COFFEE', { pending: true }),
  ].map(t => ({ kind: 'added', tx: t }));
}

function startPlaidMock({ pageSize = 500, updateStatus = 'HISTORICAL_UPDATE_COMPLETE' } = {}) {
  const items = new Map(); // access_token -> { itemId, log: [{kind, tx}] , status }
  const hits = []; // { path, body } with credentials stripped
  const failures = []; // { path, status, body, skip }
  let seq = 0;

  function newItem(name) {
    const accessToken = `access-sandbox-${name}-${++seq}`;
    const item = { itemId: `item-${name}-${seq}`, log: initialHistory(), status: updateStatus };
    items.set(accessToken, item);
    return accessToken;
  }

  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => {
      raw += c;
    });
    req.on('end', () => {
      const send = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
      };
      const err = (code, type, errorCode, message, display = null) =>
        send(code, {
          error_type: type,
          error_code: errorCode,
          error_message: message,
          display_message: display,
          request_id: 'req-' + seq,
        });
      let body = {};
      try {
        body = JSON.parse(raw || '{}');
      } catch {}
      const path = req.url;
      const { client_id: clientId, secret, ...rest } = body;
      hits.push({ path, body: rest });

      if (req.method !== 'POST') {
        return err(405, 'INVALID_REQUEST', 'INVALID_METHOD', 'POST only');
      }
      if (clientId !== CLIENT_ID || secret !== SECRET) {
        return err(
          400,
          'INVALID_INPUT',
          'INVALID_API_KEYS',
          'invalid client_id or secret provided',
        );
      }
      const fi = failures.findIndex(f => f.path === path);
      if (fi >= 0) {
        const f = failures[fi];
        if (f.skip > 0) {
          f.skip--;
        } else {
          failures.splice(fi, 1);
          return send(f.status, f.body);
        }
      }

      if (path === '/link/token/create') {
        if (!body.user || !body.user.client_user_id) {
          return err(400, 'INVALID_REQUEST', 'MISSING_FIELDS', 'user.client_user_id is required');
        }
        return send(200, {
          link_token: `link-sandbox-${++seq}-abc`,
          expiration: new Date(Date.now() + 4 * 3600e3).toISOString(),
          request_id: 'req-' + seq,
        });
      }
      if (path === '/item/public_token/exchange') {
        const m = /^public-sandbox-([a-z0-9]+)$/.exec(body.public_token || '');
        if (!m) {
          return err(
            400,
            'INVALID_INPUT',
            'INVALID_PUBLIC_TOKEN',
            'provided public token is in an invalid format',
          );
        }
        const accessToken = newItem(m[1]);
        return send(200, {
          access_token: accessToken,
          item_id: items.get(accessToken).itemId,
          request_id: 'req-' + seq,
        });
      }
      const item = items.get(body.access_token);
      if (!item) {
        return err(
          400,
          'INVALID_INPUT',
          'INVALID_ACCESS_TOKEN',
          'provided access token is invalid',
        );
      }
      if (path === '/accounts/get') {
        return send(200, {
          accounts: ACCOUNTS,
          item: { item_id: item.itemId, institution_id: 'ins_109508' },
          request_id: 'req-' + seq,
        });
      }
      if (path === '/transactions/sync') {
        const count = Math.min(Number(body.count) || 100, 500, pageSize);
        if (body.cursor !== undefined && !/^c\d+$/.test(body.cursor)) {
          return err(400, 'INVALID_INPUT', 'INVALID_FIELD', 'cursor is invalid');
        }
        const start = body.cursor ? Number(body.cursor.slice(1)) : 0;
        if (item.status === 'NOT_READY') {
          return send(200, {
            accounts: [],
            added: [],
            modified: [],
            removed: [],
            next_cursor: '',
            has_more: false,
            transactions_update_status: 'NOT_READY',
            request_id: 'req-' + seq,
          });
        }
        const slice = item.log.slice(start, start + count);
        const pick = kind => slice.filter(e => e.kind === kind).map(e => e.tx);
        return send(200, {
          accounts: ACCOUNTS,
          added: pick('added'),
          modified: pick('modified'),
          removed: pick('removed').map(t => ({
            transaction_id: t.transaction_id,
            account_id: t.account_id,
          })),
          next_cursor: 'c' + (start + slice.length),
          has_more: start + slice.length < item.log.length,
          transactions_update_status: item.status,
          request_id: 'req-' + seq,
        });
      }
      if (path === '/item/remove') {
        items.delete(body.access_token);
        return send(200, { request_id: 'req-' + seq });
      }
      return err(404, 'INVALID_REQUEST', 'NOT_FOUND', 'unknown endpoint');
    });
  });

  const api = {
    CLIENT_ID,
    SECRET,
    hits,
    items,
    tx,
    // Queue an error response for the next call to `path` (after skipping `skip` matching calls).
    failNext(path, status, body, { skip = 0 } = {}) {
      failures.push({ path, status, body, skip });
    },
    // Append updates to an Item's log: { added: [tx], modified: [tx], removed: [tx] }
    push(accessToken, { added = [], modified = [], removed = [] }) {
      const item = items.get(accessToken);
      for (const t of added) {
        item.log.push({ kind: 'added', tx: t });
      }
      for (const t of modified) {
        item.log.push({ kind: 'modified', tx: t });
      }
      for (const t of removed) {
        item.log.push({ kind: 'removed', tx: t });
      }
    },
    newItem,
    syncCursors: () => hits.filter(h => h.path === '/transactions/sync').map(h => h.body.cursor),
    close: () =>
      new Promise(resolve => {
        srv.closeAllConnections();
        srv.close(resolve);
      }),
  };
  return new Promise(resolve =>
    srv.listen(0, '127.0.0.1', () => {
      api.url = `http://127.0.0.1:${srv.address().port}`;
      resolve(api);
    }),
  );
}

module.exports = { startPlaidMock, CLIENT_ID, SECRET, ACCOUNTS };
