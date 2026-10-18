// Plaid adapter (https://plaid.com/docs). Free Trial plan: 10 production Items (teams created on/after 2026-04-15),
// free Sandbox. Needs PLAID_CLIENT_ID + PLAID_SECRET (+ PLAID_ENV sandbox|production) from a Plaid dashboard signup.
// STATUS: written against Plaid's documented REST API but NOT live-tested (no Plaid keys on this server yet).
// Plaid amounts are positive when money leaves the account, so we flip them.
const { LinkError, num, sanitize } = require('./util');
const env = process.env;
const base = () => env.PLAID_ENV === 'production' ? 'https://production.plaid.com' : 'https://sandbox.plaid.com';
async function call(path, body) {
  let r; try { r = await fetch(base() + path, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: env.PLAID_CLIENT_ID, secret: env.PLAID_SECRET, ...body }), signal: AbortSignal.timeout(30000) }); }
  catch { throw new LinkError('Could not reach Plaid.', 'network', 502); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const code = j.error_code || ''; throw new LinkError(code === 'ITEM_LOGIN_REQUIRED' ? 'Your bank wants you to log in again. Unlink and reconnect.' : `Plaid error: ${sanitize(j.display_message || j.error_message || r.status)}`, code === 'ITEM_LOGIN_REQUIRED' ? 'revoked' : 'upstream', 502); }
  return j;
}
module.exports = {
  id: 'plaid', name: 'Plaid', enabled: () => !!(env.PLAID_CLIENT_ID && env.PLAID_SECRET),
  info: () => ({ environment: env.PLAID_ENV === 'production' ? 'production' : 'sandbox', cost: 'Free Trial: 10 Items total; then pay-as-you-go monthly per Item for Transactions' }),
  async linkToken(uid) { const j = await call('/link/token/create', { user: { client_user_id: String(uid) }, client_name: (env.APP_TITLE || 'Money Vault').slice(0, 30), products: ['transactions'], country_codes: ['US'], language: 'en' }); return j.link_token; },
  async link(input) {
    const pt = String(input.publicToken || ''); if (!/^public-[a-z]+-[A-Za-z0-9-]+$/.test(pt)) throw new LinkError('Missing Plaid public token.');
    const j = await call('/item/public_token/exchange', { public_token: pt });
    return { secret: { accessToken: j.access_token, itemId: j.item_id, cursor: null }, label: sanitize(input.institution) || 'Plaid' };
  },
  async pull(secret) { // /transactions/sync with a cursor; the service persists secret.cursor back (sealed).
    const acc = await call('/accounts/get', { access_token: secret.accessToken }); // cached balances (no per-call Balance fee)
    const kinds = new Map(acc.accounts.map(a => [a.account_id, a.type]));
    const accounts = acc.accounts.map(a => ({ id: a.account_id, name: sanitize(`${a.name}${a.mask ? ' ••' + a.mask : ''}`), org: 'Plaid', kind: a.type === 'credit' ? 'credit' : 'depository',
      balance: a.balances.current != null ? num(a.balances.current) * (a.type === 'credit' ? -1 : 1) : null, available: num(a.balances.available), currency: a.balances.iso_currency_code || 'USD', balanceDate: new Date().toISOString() }));
    const transactions = []; let cursor = secret.cursor || undefined, more = true, guard = 0;
    while (more && guard++ < 50) {
      const j = await call('/transactions/sync', { access_token: secret.accessToken, cursor, count: 500 });
      for (const t of j.added.concat(j.modified)) if (!t.pending) transactions.push({ accountId: t.account_id, id: t.transaction_id, date: t.authorized_date || t.date, desc: sanitize(t.merchant_name || t.name) || 'Transaction', amount: -num(t.amount), pending: false });
      cursor = j.next_cursor; more = j.has_more;
    }
    void kinds; return { accounts, transactions, errors: [], secret: { ...secret, cursor } };
  },
  async unlink(secret) { await call('/item/remove', { access_token: secret.accessToken }).catch(() => {}); }, // ends the monthly subscription fee
};
