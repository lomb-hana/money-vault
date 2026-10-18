// Provider registry. Adapter interface:
//   id, name, enabled(): bool, info(): public config for the UI
//   link(input, ctx) -> { secret, label }            (secret gets sealed server-side, never sent to the browser)
//   pull(secret, { since }) -> { accounts, transactions, errors, secret? }   (secret returned = updated, e.g. Plaid cursor)
//   unlink?(secret)                                    (revoke upstream when the provider supports it)
// accounts:     { id, name, org, kind: 'credit'|'depository', balance (credit owed = negative), available, currency, balanceDate }
// transactions: { accountId, id, date 'YYYY-MM-DD', desc, amount (+ money in, - money out), pending }
const list = [require('./simplefin'), require('./teller'), require('./plaid')];
module.exports = Object.fromEntries(list.map(p => [p.id, p]));
