const { categorize, merchantOf, titleCase } = require('./categorize');
const norm = s => merchantOf(s).replace(/[^a-z0-9]/g, '');
const dupKey = (date, amount, desc) =>
  `${date}|${Math.abs(amount).toFixed(2)}|${amount < 0 ? '-' : '+'}|${norm(desc)}`;
const txKey = t =>
  dupKey(t.date, t.type === 'expense' ? -t.amount : t.amount, t.desc || t.note || t.category);
// rows -> preview rows with category guesses and duplicate flags
function prepare(rows, V) {
  const have = new Set(V.tx.filter(t => t.source !== 'auto').map(txKey));
  const refs = new Set(V.tx.map(t => t.ref).filter(Boolean));
  const seen = new Set();
  return rows.map(r => {
    const c = categorize(r.desc, r.amount, V.rules);
    const k = dupKey(r.date, r.amount, r.desc);
    const dup =
      (r.ref && refs.has(r.ref)) || have.has(k) ? 'existing' : seen.has(k) ? 'in-file' : null;
    seen.add(k);
    return {
      date: r.date,
      desc: r.desc,
      amount: Math.abs(r.amount),
      type: c.type,
      category: c.category,
      merchant: c.merchant,
      merchantName: titleCase(c.merchant),
      by: c.by,
      ref: r.ref,
      dup,
    };
  });
}
module.exports = { prepare, dupKey, txKey, norm };
