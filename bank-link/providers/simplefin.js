// SimpleFIN adapter (protocol: https://www.simplefin.org/protocol.html). No company approval needed:
// the user subscribes to SimpleFIN Bridge, connects banks/cards there, and pastes a one-time setup token here.
// Token = base64(claim URL). We POST it once to get an Access URL (https://user:pass@host/simplefin), seal it,
// and later GET {access}/accounts with Basic auth.
const { LinkError, dayOf, num, sanitize, CREDIT_NAME, http } = require('./util');
const env = process.env;
const hosts = () =>
  (env.SIMPLEFIN_HOSTS || 'beta-bridge.simplefin.org,bridge.simplefin.org')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
// Local tests/demo may point at a mock on 127.0.0.1 over http; never allowed in production.
const insecureOk = () =>
  env.NODE_ENV !== 'production' && env.SIMPLEFIN_ALLOW_INSECURE_LOCAL === '1';
function checkUrl(u, what) {
  let x;
  try {
    x = new URL(u);
  } catch {
    throw new LinkError(`That ${what} isn't a valid SimpleFIN link.`);
  }
  const local =
    insecureOk() && x.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(x.hostname);
  if (x.protocol !== 'https:' && !local) {
    throw new LinkError(`SimpleFIN ${what} must use https.`);
  }
  if (!local && !hosts().includes(x.hostname.toLowerCase())) {
    throw new LinkError(
      `That ${what} points at ${sanitize(x.hostname)}, which isn't a SimpleFIN server we trust.`,
    );
  }
  return x;
}
async function claim(rawToken) {
  const token = String(rawToken || '').replace(/\s+/g, '');
  if (!token || token.length > 2000) {
    throw new LinkError('Paste the SimpleFIN setup token first.');
  }
  let claimUrl;
  try {
    claimUrl = Buffer.from(token, 'base64').toString('utf8').trim();
  } catch {
    claimUrl = '';
  }
  if (!/^https?:\/\//i.test(claimUrl)) {
    throw new LinkError(
      "That doesn't look like a SimpleFIN setup token. Copy the whole token from SimpleFIN Bridge.",
    );
  }
  checkUrl(claimUrl, 'setup token');
  const r = await http(claimUrl, { method: 'POST', headers: { 'Content-Length': '0' } });
  if (r.status === 403) {
    throw new LinkError(
      'SimpleFIN says this token was already used or is invalid. If you did not use it yourself, disable it in SimpleFIN Bridge right away, it may be compromised. Then make a fresh token.',
      'claim_403',
      403,
    );
  }
  if (!r.ok) {
    throw new LinkError(`SimpleFIN claim failed (${r.status}). Try a fresh token.`, 'claim', 502);
  }
  const access = (await r.text()).trim();
  const a = checkUrl(access, 'access URL');
  if (!a.username || !a.password) {
    throw new LinkError('SimpleFIN returned an access URL without credentials.', 'claim', 502);
  }
  return { secret: { accessUrl: access }, label: 'SimpleFIN Bridge' };
}
function normalize(set) {
  const conns = new Map((set.connections || []).map(c => [c.conn_id, c]));
  const errors = (set.errlist || [])
    .map(e => sanitize(e.msg || e.code))
    .concat((set.errors || []).map(sanitize))
    .filter(Boolean);
  const accounts = [];
  const transactions = [];
  for (const a of set.accounts || []) {
    const c = conns.get(a.conn_id) || {};
    const org = sanitize(
      (a.org && (a.org.name || a.org.domain)) || c.org_name || c.name || a.conn_name || 'Bank',
    );
    const balance = num(a.balance);
    const name = sanitize(a.name) || 'Account';
    const kind =
      CREDIT_NAME.test(name) || (balance != null && balance < 0) ? 'credit' : 'depository';
    accounts.push({
      id: String(a.id).slice(0, 80),
      name,
      org,
      kind,
      balance,
      available: num(a['available-balance']),
      currency: /^[A-Z]{3}$/.test(a.currency) ? a.currency : 'USD',
      balanceDate: a['balance-date'] ? new Date(a['balance-date'] * 1000).toISOString() : null,
    });
    for (const t of a.transactions || []) {
      const when = t.posted || t.transacted_at;
      if (t.pending || !when) {
        continue;
      }
      const amount = num(t.amount);
      if (amount == null || amount === 0) {
        continue;
      }
      transactions.push({
        accountId: String(a.id).slice(0, 80),
        id: String(t.id).slice(0, 80),
        date: dayOf(t.transacted_at || t.posted),
        desc: sanitize(t.description || t.payee || t.memo) || 'Transaction',
        amount,
        pending: false,
      });
    }
  }
  return { accounts, transactions, errors };
}
async function pull(secret, { since } = {}) {
  const a = checkUrl(secret.accessUrl, 'access URL');
  const auth =
    'Basic ' +
    Buffer.from(decodeURIComponent(a.username) + ':' + decodeURIComponent(a.password)).toString(
      'base64',
    );
  a.username = '';
  a.password = '';
  const u = new URL(a.toString().replace(/\/+$/, '') + '/accounts');
  u.searchParams.set('version', '2');
  if (since) {
    u.searchParams.set('start-date', String(Math.floor(Date.parse(since) / 1000)));
  }
  const r = await http(u, { headers: { Authorization: auth, Accept: 'application/json' } }, 60000);
  if (r.status === 402) {
    throw new LinkError(
      'SimpleFIN says payment is required. Renew your SimpleFIN Bridge subscription, then sync again.',
      'payment',
      402,
    );
  }
  if (r.status === 403) {
    throw new LinkError(
      'SimpleFIN access was revoked or expired. Unlink and link again with a fresh token.',
      'revoked',
      403,
    );
  }
  if (!r.ok) {
    throw new LinkError(`SimpleFIN error ${r.status}. Try again later.`, 'upstream', 502);
  }
  let set;
  try {
    set = await r.json();
  } catch {
    throw new LinkError('SimpleFIN sent something unreadable.', 'upstream', 502);
  }
  return normalize(set);
}
module.exports = {
  id: 'simplefin',
  name: 'SimpleFIN Bridge',
  enabled: () => true,
  info: () => ({
    createUrl: 'https://beta-bridge.simplefin.org/simplefin/create',
    cost: '$15/yr or $1.50/mo per person, paid to SimpleFIN',
  }),
  link: input => claim(input.token),
  pull,
  normalize, // unlink: access is revoked by the user in SimpleFIN Bridge; we just delete our copy.
};
