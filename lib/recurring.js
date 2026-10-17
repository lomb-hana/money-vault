// Detect repeating charges/deposits: same merchant, similar amount, regular interval.
const day = d => Date.parse(d + 'T12:00:00Z') / 864e5;
const median = a => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const iso = n => new Date(n * 864e5).toISOString().slice(0, 10);
function detect(tx, opts = {}) {
  const groups = {};
  for (const t of tx) { if (t.source === 'auto' || !t.merchant) continue; (groups[t.type + '|' + t.merchant] ||= []).push(t); }
  const out = [];
  for (const [key, list] of Object.entries(groups)) {
    // split by amount cluster (within 15% of the cluster median) so e.g. two different Netflix plans don't mix
    const sorted = list.slice().sort((a, b) => a.date.localeCompare(b.date));
    const med = median(sorted.map(t => t.amount)), cl = sorted.filter(t => Math.abs(t.amount - med) <= Math.max(2, med * 0.15));
    if (cl.length < 3 && !(cl.length === 2 && Math.abs(cl[0].amount - cl[1].amount) < 0.01 && Math.abs(day(cl[1].date) - day(cl[0].date) - 30) <= 4)) continue;
    const gaps = cl.slice(1).map((t, i) => day(t.date) - day(cl[i].date)).filter(g => g > 2);
    if (!gaps.length) continue;
    const g = median(gaps), freq = g >= 5 && g <= 9 ? 'weekly' : g >= 12 && g <= 17 ? 'biweekly' : g >= 26 && g <= 35 ? 'monthly' : null;
    if (!freq) continue;
    const regular = gaps.filter(x => Math.abs(x - g) <= (freq === 'monthly' ? 5 : 3)).length / gaps.length; if (regular < 0.7) continue;
    const last = cl[cl.length - 1], step = { weekly: 7, biweekly: 14, monthly: 30.44 }[freq], amount = Math.round(median(cl.map(t => t.amount)) * 100) / 100;
    if (day(opts.today || iso(Date.now() / 864e5)) - day(last.date) > step * 2.5) continue; // stopped
    const type = key.split('|')[0], category = last.category;
    const kind = type === 'income' ? 'paycheck' : category === 'Subscriptions' ? 'subscription' : 'bill';
    out.push({ key, merchant: last.merchant, name: last.merchantName || last.merchant, type, category, freq, amount, count: cl.length, last: last.date, next: iso(Math.round(day(last.date) + step)), dueDay: +last.date.slice(8), kind,
      monthly: Math.round(amount * { weekly: 52 / 12, biweekly: 26 / 12, monthly: 1 }[freq] * 100) / 100 });
  }
  return out.sort((a, b) => b.monthly - a.monthly);
}
module.exports = { detect };
