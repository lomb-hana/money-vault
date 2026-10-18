// Lazy, idempotent auto-logging of scheduled paychecks and recurring bills, plus reconciliation with imports.
const today = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
const addDays = (d, n) => {
  const x = new Date(d + 'T12:00:00Z');
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};
const diff = (a, b) =>
  Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 864e5);
const dim = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const dueIn = (b, ym) => {
  const [y, m] = ym.split('-').map(Number);
  return `${ym}-${String(Math.min(b.dueDay, dim(y, m))).padStart(2, '0')}`;
};
const nextYM = ym => {
  let [y, m] = ym.split('-').map(Number);
  m++;
  if (m > 12) {
    m = 1;
    y++;
  }
  return `${y}-${String(m).padStart(2, '0')}`;
};
const near = (a, b, pct = 0.12, abs = 3) => Math.abs(a - b) <= Math.max(abs, b * pct);
const billMatches = (b, t) =>
  t.type === 'expense' &&
  near(t.amount, b.amount) &&
  ((b.match &&
    t.merchant &&
    (t.merchant === b.match || t.merchant.startsWith(b.match) || b.match.startsWith(t.merchant))) ||
    (t.desc || '').toLowerCase().includes(b.name.toLowerCase()));
function payDates(p, until) {
  const out = [];
  if (!p.anchor) {
    return out;
  }
  if (p.freq === 'monthly') {
    const day = +p.anchor.slice(8);
    let ym = p.anchor.slice(0, 7);
    for (let i = 0; i < 60; i++) {
      const [y, m] = ym.split('-').map(Number);
      const d = `${ym}-${String(Math.min(day, dim(y, m))).padStart(2, '0')}`;
      if (d > until) {
        break;
      }
      out.push(d);
      ym = nextYM(ym);
    }
  } else {
    const step = p.freq === 'weekly' ? 7 : 14;
    let d = p.anchor;
    for (let i = 0; i < 400 && d <= until; i++) {
      out.push(d);
      d = addDays(d, step);
    }
  }
  return out;
}
function run(V, newId, t = today()) {
  V.autoDone ||= [];
  const done = new Set(V.autoDone);
  let created = 0;
  const p = V.pay || {};
  if (p.auto && p.amount > 0 && p.anchor) {
    for (const d of payDates(p, t)) {
      const key = 'pay:' + d;
      if (d < (p.autoSince || p.anchor) || done.has(key)) {
        continue;
      }
      done.add(key);
      if (
        V.tx.some(
          x =>
            x.type === 'income' &&
            x.source !== 'auto' &&
            Math.abs(diff(x.date, d)) <= 3 &&
            near(x.amount, p.amount, 0.2, 5),
        )
      ) {
        continue;
      } // already imported
      V.tx.push({
        id: newId(),
        type: 'income',
        amount: p.amount,
        category: 'Paycheck',
        date: d,
        note: 'Scheduled paycheck',
        source: 'auto',
        autoKey: key,
        createdAt: new Date().toISOString(),
      });
      created++;
    }
  }
  for (const b of V.bills) {
    if (!b.autoLog || !b.autoSince) {
      continue;
    }
    for (
      let ym = b.autoSince.slice(0, 7), i = 0;
      ym <= t.slice(0, 7) && i < 60;
      ym = nextYM(ym), i++
    ) {
      const d = dueIn(b, ym);
      const key = `bill:${b.id}:${ym}`;
      if (d < b.autoSince || d > t || done.has(key)) {
        continue;
      }
      done.add(key);
      if (b.paid.includes(ym)) {
        continue;
      }
      V.tx.push({
        id: newId(),
        type: 'expense',
        amount: b.amount,
        category: b.category || 'Bills',
        date: d,
        note: b.name,
        merchant: b.match || null,
        source: 'auto',
        autoKey: key,
        createdAt: new Date().toISOString(),
      });
      b.paid.push(ym);
      created++;
    }
  }
  V.autoDone = [...done].slice(-3000);
  return created;
}
// After an import: mark bills paid, and drop auto entries that the real transaction replaces.
function reconcile(V, imported) {
  let paid = 0;
  let replaced = 0;
  const drop = new Set();
  for (const t of imported) {
    if (t.type === 'expense') {
      for (const b of V.bills) {
        const ym = t.date.slice(0, 7);
        if (!billMatches(b, t) || Math.abs(diff(t.date, dueIn(b, ym))) > 12) {
          continue;
        }
        const a = V.tx.find(x => x.autoKey === `bill:${b.id}:${ym}`);
        if (a) {
          drop.add(a.id);
          replaced++;
        }
        if (!b.paid.includes(ym)) {
          b.paid.push(ym);
          paid++;
        }
      }
    }
    if (t.type === 'income') {
      const a = V.tx.find(
        x =>
          x.source === 'auto' &&
          x.type === 'income' &&
          !drop.has(x.id) &&
          Math.abs(diff(x.date, t.date)) <= 4 &&
          near(t.amount, x.amount, 0.2, 5),
      );
      if (a) {
        drop.add(a.id);
        replaced++;
      }
    }
  }
  V.tx = V.tx.filter(x => !drop.has(x.id));
  return { paid, replaced };
}
module.exports = { run, reconcile, today, payDates };
