// Teller adapter (https://teller.io/docs). Free developer tier: 100 live enrollments.
// Works fully in Teller's sandbox with no account (public docs token test_token_ky6igyqi3qxa4), so it's exercised in tests.
// Live use needs TELLER_APP_ID (+ TELLER_CERT/TELLER_KEY PEMs for development/production; Teller requires mTLS there).
// Note: Teller credit-card amounts are positive for purchases, so we flip them to our + in / - out convention.
const https = require('https');
const { LinkError, num, sanitize } = require('./util');
const env = process.env;
const ENVS = ['sandbox', 'development', 'production'];
const tenv = () => (ENVS.includes(env.TELLER_ENV) ? env.TELLER_ENV : 'sandbox');
const pem = v => (v || '').replace(/\\n/g, '\n');
let agent = null;
function get(path, token) {
  const base = env.TELLER_API_BASE || 'https://api.teller.io';
  if (!agent && env.TELLER_CERT && env.TELLER_KEY) {
    agent = new https.Agent({
      cert: pem(env.TELLER_CERT),
      key: pem(env.TELLER_KEY),
      keepAlive: true,
    });
  }
  const u = new URL(path, base);
  return new Promise((ok, no) => {
    const lib = u.protocol === 'http:' ? require('http') : https;
    const req = lib.get(
      u,
      {
        agent: u.protocol === 'https:' ? agent || undefined : undefined,
        headers: {
          Authorization: 'Basic ' + Buffer.from(token + ':').toString('base64'),
          Accept: 'application/json',
        },
        timeout: 30000,
      },
      res => {
        let d = '';
        res.on('data', c => {
          d += c;
          if (d.length > 2e7) {
            req.destroy();
          }
        });
        res.on('end', () => {
          if (res.statusCode === 401 || res.statusCode === 403) {
            return no(
              new LinkError(
                'Teller access was revoked or expired. Unlink and connect again.',
                'revoked',
                403,
              ),
            );
          }
          if (res.statusCode >= 400) {
            let m = '';
            try {
              m = JSON.parse(d).error.message;
            } catch {}
            return no(
              new LinkError(
                `Teller error ${res.statusCode}${m ? ': ' + sanitize(m) : ''}`,
                'upstream',
                502,
              ),
            );
          }
          try {
            ok(JSON.parse(d));
          } catch {
            no(new LinkError('Teller sent something unreadable.', 'upstream', 502));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', e =>
      no(e instanceof LinkError ? e : new LinkError('Could not reach Teller.', 'network', 502)),
    );
  });
}
async function link(input) {
  const token = String(input.accessToken || '').trim();
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(token)) {
    throw new LinkError('Missing Teller access token.');
  }
  if (tenv() !== 'sandbox' && !(env.TELLER_CERT && env.TELLER_KEY)) {
    throw new LinkError(
      'Teller live mode needs the Teller client certificate configured on the server.',
      'config',
      503,
    );
  }
  const accts = await get('/accounts', token); // validates the token
  const inst = accts[0] && accts[0].institution ? sanitize(accts[0].institution.name) : 'Teller';
  return {
    secret: { accessToken: token, env: tenv() },
    label: `${inst} (Teller${tenv() === 'sandbox' ? ' sandbox' : ''})`,
  };
}
async function pull(secret, { since } = {}) {
  const token = secret.accessToken;
  const accounts = [];
  const transactions = [];
  const errors = [];
  const start = since ? new Date(since).toISOString().slice(0, 10) : null;
  for (const a of await get('/accounts', token)) {
    if (a.status && a.status !== 'open') {
      continue;
    }
    const credit = a.type === 'credit';
    const sign = credit ? -1 : 1;
    let bal = {};
    try {
      bal = await get(`/accounts/${encodeURIComponent(a.id)}/balances`, token);
    } catch (e) {
      errors.push(`${sanitize(a.name)}: balance unavailable`);
    }
    accounts.push({
      id: a.id,
      name: sanitize(`${a.name}${a.last_four ? ' ••' + a.last_four : ''}`),
      org: sanitize(a.institution && a.institution.name) || 'Bank',
      kind: credit ? 'credit' : 'depository',
      balance: bal.ledger != null ? num(bal.ledger) * sign : null,
      available: bal.available != null ? num(bal.available) : null,
      currency: a.currency || 'USD',
      balanceDate: new Date().toISOString(),
    });
    try {
      const q = start ? `?start_date=${start}` : '';
      for (const t of await get(`/accounts/${encodeURIComponent(a.id)}/transactions${q}`, token)) {
        if (t.status !== 'posted') {
          continue;
        }
        const amt = num(t.amount);
        if (!amt) {
          continue;
        }
        transactions.push({
          accountId: a.id,
          id: t.id,
          date: t.date,
          desc:
            sanitize(
              t.description || (t.details && t.details.counterparty && t.details.counterparty.name),
            ) || 'Transaction',
          amount: amt * sign,
          pending: false,
        });
      }
    } catch (e) {
      errors.push(`${sanitize(a.name)}: ${e.message}`);
    }
  }
  return { accounts, transactions, errors };
}
module.exports = {
  id: 'teller',
  name: 'Teller',
  enabled: () =>
    !!env.TELLER_APP_ID || (env.NODE_ENV !== 'production' && env.TELLER_SANDBOX_DEMO === '1'),
  info: () => ({
    appId: env.TELLER_APP_ID || null,
    environment: tenv(),
    cost: 'Free for 100 enrollments (developer tier), then $0.30/enrollment/month for Transactions',
  }),
  link,
  pull,
};
