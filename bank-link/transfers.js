// Keep money moving between your own linked accounts from counting as spending or income.
// 1) credit-card side: incoming "payment / thank you" credits are transfers
// 2) any two linked accounts: same amount out of one and into another within 4 days = transfer
// 3) when a credit card is linked: checking-side "card payment / autopay" debits are transfers (the purchases already count on the card)
const CARD_SIDE = /payment|pymt|\bpmt\b|autopay|auto pay|thank you|online pay|mobile pay|epay/i;
const BANK_SIDE =
  /((card|crd|credit)\b.{0,25}(pmt|payment|pymt|autopay|epay))|((pmt|payment|autopay|epay)\b.{0,25}(card|crd|credit))|((apple ?card|amex|american express|discover|capital one|chase|citi|barclay|synchrony|wells fargo card|bank of america|bk of amer).{0,30}(pmt|payment|autopay|epay|pymt))/i;
const day = d => Date.parse(d + 'T12:00:00Z') / 864e5;
const keyOf = t => t.accountId + '|' + t.id;
function findTransfers(txs, accounts) {
  const kind = new Map(accounts.map(a => [a.id, a.kind]));
  const out = new Map();
  const hasCredit = accounts.some(a => a.kind === 'credit');
  for (const t of txs) {
    if (kind.get(t.accountId) === 'credit' && t.amount > 0 && CARD_SIDE.test(t.desc)) {
      out.set(keyOf(t), 'card payment');
    }
  }
  const ins = txs.filter(t => t.amount > 0);
  const used = new Set();
  for (const o of txs) {
    if (o.amount >= 0 || out.has(keyOf(o))) {
      continue;
    }
    const m = ins.find(
      i =>
        !used.has(keyOf(i)) &&
        i.accountId !== o.accountId &&
        Math.abs(i.amount + o.amount) < 0.005 &&
        Math.abs(day(i.date) - day(o.date)) <= 4,
    );
    if (m) {
      used.add(keyOf(m));
      out.set(keyOf(o), 'transfer');
      out.set(keyOf(m), 'transfer');
    }
  }
  if (hasCredit) {
    for (const t of txs) {
      if (
        t.amount < 0 &&
        kind.get(t.accountId) !== 'credit' &&
        BANK_SIDE.test(t.desc) &&
        !out.has(keyOf(t))
      ) {
        out.set(keyOf(t), 'card payment');
      }
    }
  }
  return out;
}
module.exports = { findTransfers, keyOf };
