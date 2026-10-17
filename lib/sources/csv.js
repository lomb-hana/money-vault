const { parseDate } = require('./dates');
function splitCSV(text) { // RFC4180-ish, handles quotes, commas/semicolons/tabs
  const first = text.split(/\r?\n/).slice(0, 15).join('\n'); const delim = [',', ';', '\t'].map(d => [d, (first.match(new RegExp(d === '\t' ? '\t' : '\\' + d, 'g')) || []).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) { const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true; else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c; }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.map(r => r.map(x => x.trim())).filter(r => r.some(Boolean));
}
const num = v => { if (v == null) return NaN; let s = String(v).trim(); if (!s) return NaN; const neg = /^\(.*\)$/.test(s) || /^-/.test(s.replace(/[$\s]/g, '')) || /-$/.test(s) || /\bDR\b/i.test(s);
  s = s.replace(/[^0-9.,]/g, ''); if (/,\d{2}$/.test(s) && !/\.\d{2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.'); else s = s.replace(/,/g, ''); const n = parseFloat(s); return isNaN(n) ? NaN : (neg ? -n : n); };
const H = { date: /^(transaction |trans\.? |posting |posted |post )?date$|^date( posted)?$|^datetime$|^date\b/i, desc: /description|payee|merchant|memo|details|name|narrative|transaction$|^notes?$/i,
  amount: /^(net )?amount|^amount \(?usd\)?$|^value$|^total/i, debit: /debit|withdraw|money out|paid out|outflow|^spent$/i, credit: /credit|deposit|money in|paid in|inflow|received/i, type: /^(transaction )?type$|^details$|credit\/debit|^dr\/cr$/i, status: /^status$/i };
function detect(rows) {
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const h = rows[i].map(x => x.toLowerCase()), find = (re, skip = []) => h.findIndex((x, j) => re.test(x) && !skip.includes(j));
    const date = find(H.date); if (date < 0) continue;
    let amount = find(H.amount, [date]); const debit = find(H.debit, [date]), credit = find(H.credit, [date]);
    if (amount < 0 && (debit < 0 || credit < 0)) continue;
    const used = [date, amount, debit, credit];
    let desc = -1; for (const re of [/description|payee|merchant/i, /name|narrative|details/i, /memo|notes?/i, /transaction$/i]) { desc = find(re, used); if (desc >= 0) break; }
    const memo = h.findIndex((x, j) => /memo|notes?/.test(x) && j !== desc && !used.includes(j));
    return { header: i, date, desc, memo, amount, debit, credit, type: find(H.type, [date, desc, amount, debit, credit]), status: find(H.status), names: rows[i] };
  }
  // headerless (e.g. Wells Fargo): date, amount, *, *, description
  const r = rows[0] || []; const date = r.findIndex(x => parseDate(x)), amount = r.findIndex((x, j) => j !== date && /^-?\$?[\d,]+\.\d{2}$/.test(x.replace(/"/g, '')));
  if (date >= 0 && amount >= 0) { const desc = r.reduce((b, x, j) => (j !== date && j !== amount && x.length > (r[b] || '').length ? j : b), -1); return { header: -1, date, desc, memo: -1, amount, debit: -1, credit: -1, type: -1, status: -1, names: null }; }
  return null;
}
function parse(text) {
  const rows = splitCSV(text), c = detect(rows); if (!c) throw new Error("Couldn't find date and amount columns in that file");
  const body = rows.slice(c.header + 1);
  // date order: if any first-field > 12 in an a/b/c date, it's day-first
  const dayFirst = body.some(r => { const m = String(r[c.date] || '').match(/^(\d{1,2})[/.-](\d{1,2})[/.-]/); return m && +m[1] > 12; }) ? true : undefined;
  const out = [], skipped = [];
  for (const r of body) {
    if (c.status >= 0 && /pending|declined|failed|cancel/i.test(r[c.status] || '')) { skipped.push('pending'); continue; }
    const date = parseDate(r[c.date], dayFirst); if (!date) { skipped.push('bad date'); continue; }
    let amount;
    if (c.amount >= 0) { amount = num(r[c.amount]); if (c.type >= 0 && amount > 0 && /debit|withdraw|purchase|payment sent|^dr$|sent|card/i.test(r[c.type] || '') && !/credit|deposit|received/i.test(r[c.type] || '')) amount = -amount; }
    else { const d = num(r[c.debit]), cr = num(r[c.credit]); amount = (isNaN(cr) ? 0 : Math.abs(cr)) - (isNaN(d) ? 0 : Math.abs(d)); if (isNaN(d) && isNaN(cr)) amount = NaN; }
    if (!amount || isNaN(amount)) { skipped.push('no amount'); continue; }
    const desc = [r[c.desc], c.memo >= 0 ? r[c.memo] : ''].filter(Boolean).join(' · ').slice(0, 140) || (c.type >= 0 ? r[c.type] : '') || 'Transaction';
    out.push({ date, desc, amount: Math.round(amount * 100) / 100 });
  }
  return { format: 'csv', columns: c.names ? { date: c.names[c.date], description: c.names[c.desc], amount: c.amount >= 0 ? c.names[c.amount] : `${c.names[c.debit]} / ${c.names[c.credit]}` } : { headerless: true }, rows: out, skipped: skipped.length };
}
module.exports = { parse, splitCSV, num, detect };
