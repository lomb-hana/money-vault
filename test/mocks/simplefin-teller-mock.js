// Mock SimpleFIN server (+ a tiny Teller-shaped API) speaking the public protocol, with fake data only.
const http = require('http');
const DAY = 86400;
const now = Math.floor(Date.now() / 1000);
const ago = d => now - d * DAY;
const USER = 'demo-user';
const PASS = 'demo-pass-123';
function accountSet(startDate) {
  const tx = (id, d, amt, desc) => ({
    id,
    posted: ago(d),
    amount: amt,
    description: desc,
    transacted_at: ago(d),
  });
  const keep = list => list.filter(t => !startDate || t.posted >= startDate);
  return {
    errlist: [
      {
        code: 'act.missingdata',
        msg: 'Old Savings: <b>Incomplete</b> history, see https://secret.example/x',
        account_id: 'sav1',
      },
    ],
    connections: [
      {
        conn_id: 'CON-1',
        name: 'Demo Credit Union',
        org_id: 'ORG-1',
        org_name: 'Demo Credit Union',
        sfin_url: 'https://sfin.example',
      },
      { conn_id: 'CON-2', name: 'Capital Two', org_id: 'ORG-2', sfin_url: 'https://sfin.example' },
    ],
    accounts: [
      {
        id: 'chk1',
        name: 'Everyday Checking',
        conn_id: 'CON-1',
        currency: 'USD',
        balance: '1843.27',
        'available-balance': '1790.00',
        'balance-date': now,
        transactions: keep([
          tx('c1', 30, '1250.00', 'ACME CORP PAYROLL DIR DEP'),
          tx('c2', 16, '1250.00', 'ACME CORP PAYROLL DIR DEP'),
          tx('c3', 2, '1250.00', 'ACME CORP PAYROLL DIR DEP'),
          tx('c4', 20, '-15.49', 'NETFLIX.COM 866-579-7172 CA'),
          tx('c5', 12, '-86.12', 'H-E-B #622 HOUSTON TX'),
          tx('c6', 9, '-250.00', 'CAPITAL TWO CRD PMT WEB ID 99'),
          tx('c7', 8, '-100.00', 'ONLINE TRANSFER TO SAVINGS 5521'),
          tx('c8', 5, '-1200.00', 'ZILLOW RENT PAYMENT'),
          { id: 'cp', posted: 0, amount: '-9.99', description: 'PENDING THING', pending: true },
        ]),
      },
      {
        id: 'sav1',
        name: 'Old Savings',
        conn_id: 'CON-1',
        currency: 'USD',
        balance: '640.00',
        'balance-date': now,
        transactions: keep([tx('s1', 8, '100.00', 'ONLINE TRANSFER FROM CHECKING 1102')]),
      },
      {
        id: 'cc1',
        name: 'Quicksilver Card',
        conn_id: 'CON-2',
        currency: 'USD',
        balance: '-812.40',
        'balance-date': now,
        transactions: keep([
          tx('k1', 14, '-5.25', 'STARBUCKS STORE 1234'),
          tx('k2', 14, '-5.25', 'STARBUCKS STORE 1234'),
          tx('k3', 11, '-59.99', 'STEAMGAMES.COM 4259522985'),
          tx('k4', 7, '250.00', 'PAYMENT - THANK YOU'),
          tx('k5', 4, '-42.10', 'SHELL OIL 57444'),
          tx('k6', 3, '-23.80', 'TACO BELL #3321'),
        ]),
      },
    ],
  };
}
const teller = {
  accounts: [
    {
      id: 'acc_card',
      name: 'Platinum Card',
      last_four: '7857',
      type: 'credit',
      status: 'open',
      currency: 'USD',
      institution: { name: 'Mock CU', id: 'mock' },
    },
    {
      id: 'acc_chk',
      name: 'My Checking',
      last_four: '7346',
      type: 'depository',
      status: 'open',
      currency: 'USD',
      institution: { name: 'Mock CU', id: 'mock' },
    },
    {
      id: 'acc_old',
      name: 'Closed Savings',
      last_four: '0001',
      type: 'depository',
      status: 'closed',
      currency: 'USD',
      institution: { name: 'Mock CU', id: 'mock' },
    },
  ],
  balances: {
    acc_card: { ledger: '300.50', available: '4699.50' },
    acc_chk: { ledger: '106.19', available: '106.19' },
  },
  tx: {
    acc_card: [
      { id: 't1', date: '2026-10-10', amount: '58.83', description: 'Five Guys', status: 'posted' },
      { id: 't2', date: '2026-10-11', amount: '9.00', description: 'Pending', status: 'pending' },
    ],
    acc_chk: [
      { id: 't3', date: '2026-10-09', amount: '-28.98', description: 'Staples', status: 'posted' },
    ],
    acc_old: [
      { id: 't9', date: '2026-10-01', amount: '-5.00', description: 'Old fee', status: 'posted' },
    ],
  },
};
function start(port = 0) {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const j = (c, o) => {
      res.writeHead(c, { 'Content-Type': 'application/json' });
      res.end(typeof o === 'string' ? o : JSON.stringify(o));
    };
    srv.hits.push(req.method + ' ' + u.pathname + u.search);
    if (req.method === 'POST' && u.pathname.startsWith('/simplefin/claim/')) {
      const tok = u.pathname.split('/').pop();
      if (tok === 'used') {
        return j(403, 'Forbidden');
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end(
        `http://${USER}:${PASS}@127.0.0.1:${srv.address().port}/simplefin${tok === 'broke' ? '-402' : ''}`,
      );
    }
    const okAuth =
      req.headers.authorization === 'Basic ' + Buffer.from(USER + ':' + PASS).toString('base64');
    if (u.pathname === '/simplefin-402/accounts') {
      return j(402, 'Payment Required');
    }
    if (u.pathname === '/simplefin/accounts') {
      if (!okAuth) {
        return j(403, 'Forbidden');
      }
      return j(200, accountSet(Number(u.searchParams.get('start-date')) || 0));
    }
    const tok = Buffer.from(String(req.headers.authorization || '').replace('Basic ', ''), 'base64')
      .toString()
      .split(':')[0];
    if (u.pathname.startsWith('/accounts')) {
      // test_token_nobal1: same data, but the balances endpoint is broken
      if (tok !== 'test_token_mock123' && tok !== 'test_token_nobal1') {
        return j(401, { error: { code: 'unauthorized', message: 'bad token' } });
      }
      const p = u.pathname.split('/').filter(Boolean);
      if (p.length === 1) {
        return j(200, teller.accounts);
      }
      if (p[2] === 'balances') {
        if (tok === 'test_token_nobal1') {
          return j(500, { error: { code: 'internal', message: 'balances down' } });
        }
        return j(200, teller.balances[p[1]]);
      }
      if (p[2] === 'transactions') {
        return j(200, teller.tx[p[1]] || []);
      }
    }
    j(404, { error: 'nope' });
  });
  srv.hits = [];
  return new Promise(ok => srv.listen(port, '127.0.0.1', () => ok(srv)));
}
module.exports = { start, USER, PASS };
if (require.main === module) {
  start(Number(process.argv[2]) || 4555).then(s =>
    console.log('mock providers on', s.address().port),
  );
}
