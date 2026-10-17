const http = require('http'), fs = require('fs'), path = require('path');
const PORT = process.env.PORT || 3001, PROD = process.env.NODE_ENV === 'production';
const ADMIN_KEY = process.env.ADMIN_KEY || '', APP_TITLE = (process.env.APP_TITLE || 'Money Vault').slice(0, 60);
if (PROD && ADMIN_KEY.length < 8) { console.error('Refusing to start: set ADMIN_KEY (8+ chars) in production.'); process.exit(1); }
const backend = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
  ? require('./store/supabase-store')(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, process.env.STATE_ROW_ID || 'money-main')
  : require('./store/json-store')(process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json'));
const EXPENSE = ['Food', 'Gas', 'Games', 'Bills', 'Rent', 'Fun', 'Shopping', 'Subscriptions', 'Other'];
const INCOME = ['Paycheck', 'Side hustle', 'Other income'];
const FREQS = ['weekly', 'biweekly', 'monthly'];
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const send = (res, code, obj, type = 'application/json', extra = {}) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra }); res.end(type === 'application/json' ? JSON.stringify(obj) : obj); };
const body = req => new Promise(r => { let d = '', n = 0; req.on('data', c => { n += c.length; if (n < 1e6) d += c; }); req.on('end', () => { try { r(JSON.parse(d || '{}')); } catch { r({}); } }); });
const clean = (v, n = 60) => String(v ?? '').trim().slice(0, n);
const money = v => { const n = Math.round(Number(v) * 100) / 100; return Number.isFinite(n) && n >= 0 && n < 1e9 ? n : NaN; };
const isDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '') && !isNaN(Date.parse(d));
let store, auth;
const vault = uid => { const d = store.read(); return d.vaults[uid] ||= { tx: [], budgets: {}, bills: [], goals: [], pay: { freq: 'biweekly', amount: 0, anchor: null } }; };

function validTx(b) {
  const type = b.type === 'income' ? 'income' : b.type === 'expense' ? 'expense' : null, amount = money(b.amount);
  const cats = type === 'income' ? INCOME : EXPENSE;
  if (!type || !(amount > 0) || !cats.includes(b.category) || !isDate(b.date)) return null;
  return { type, amount, category: b.category, date: b.date, note: clean(b.note, 120) };
}
const csvCell = v => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

async function api(req, res, p, u) {
  const m = req.method, uid = req.user.id, r = p.slice(1);
  const V = () => vault(uid), mut = fn => store.mutate(() => fn(V()));
  const find = (list, id) => V()[list].find(x => x.id === id);
  if (r[0] === 'state' && m === 'GET') return send(res, 200, { ...V(), user: { username: req.user.username }, EXPENSE, INCOME, FREQS });
  if (r[0] === 'export.csv' && m === 'GET') {
    const rows = [['date', 'type', 'category', 'amount', 'note']].concat(V().tx.slice().sort((a, b) => a.date.localeCompare(b.date)).map(t => [t.date, t.type, t.category, t.amount.toFixed(2), t.note]));
    return send(res, 200, rows.map(x => x.map(csvCell).join(',')).join('\r\n') + '\r\n', 'text/csv; charset=utf-8', { 'Content-Disposition': 'attachment; filename="transactions.csv"' });
  }
  const b = m === 'GET' ? {} : await body(req);
  // transactions
  if (r[0] === 'tx' && !r[1] && m === 'POST') { const v = validTx(b); if (!v) return send(res, 400, { error: 'Need type, amount > 0, category and date' }); return send(res, 201, await mut(V => { const t = { id: store.newId(), ...v, createdAt: new Date().toISOString() }; V.tx.push(t); return t; })); }
  if (r[0] === 'tx' && r[1]) {
    const t = find('tx', r[1]); if (!t) return send(res, 404, { error: 'Not found' });
    if (m === 'PUT') { const v = validTx(b); if (!v) return send(res, 400, { error: 'Invalid transaction' }); return send(res, 200, await mut(() => Object.assign(t, v))); }
    if (m === 'DELETE') { await mut(V => { V.tx = V.tx.filter(x => x.id !== t.id); }); return send(res, 200, { ok: true }); }
  }
  // budgets: {category: limit} (0 or empty removes)
  if (r[0] === 'budgets' && m === 'PUT') {
    const out = {}; for (const [k, v] of Object.entries(b.budgets || {})) { if (!EXPENSE.includes(k)) continue; const n = money(v); if (n > 0) out[k] = n; }
    return send(res, 200, await mut(V => (V.budgets = out)));
  }
  // paycheck
  if (r[0] === 'pay' && m === 'PUT') {
    const amount = money(b.amount); if (!FREQS.includes(b.freq) || !(amount >= 0) || (b.anchor && !isDate(b.anchor))) return send(res, 400, { error: 'Pick a frequency, amount and a recent payday' });
    return send(res, 200, await mut(V => (V.pay = { freq: b.freq, amount, anchor: b.anchor || null })));
  }
  // bills
  const validBill = () => { const amount = money(b.amount), day = Math.round(Number(b.dueDay)), name = clean(b.name, 40); return name && amount >= 0 && day >= 1 && day <= 31 ? { name, amount, dueDay: day, recurring: b.recurring !== false } : null; };
  if (r[0] === 'bills' && !r[1] && m === 'POST') { const v = validBill(); if (!v) return send(res, 400, { error: 'Need name, amount and due day 1-31' }); return send(res, 201, await mut(V => { const x = { id: store.newId(), ...v, paid: [] }; V.bills.push(x); return x; })); }
  if (r[0] === 'bills' && r[1]) {
    const x = find('bills', r[1]); if (!x) return send(res, 404, { error: 'Not found' });
    if (r[2] === 'paid' && m === 'POST') { if (!/^\d{4}-\d{2}$/.test(b.month || '')) return send(res, 400, { error: 'month YYYY-MM' }); return send(res, 200, await mut(() => { x.paid = x.paid.filter(mm => mm !== b.month); if (b.paid !== false) x.paid.push(b.month); x.paid = x.paid.slice(-36); return x; })); }
    if (m === 'PUT') { const v = validBill(); if (!v) return send(res, 400, { error: 'Invalid bill' }); return send(res, 200, await mut(() => Object.assign(x, v))); }
    if (m === 'DELETE') { await mut(V => { V.bills = V.bills.filter(y => y.id !== x.id); }); return send(res, 200, { ok: true }); }
  }
  // goals
  const validGoal = () => { const target = money(b.target), saved = money(b.saved ?? 0), name = clean(b.name, 40); return name && target > 0 && saved >= 0 ? { name, target, saved } : null; };
  if (r[0] === 'goals' && !r[1] && m === 'POST') { const v = validGoal(); if (!v) return send(res, 400, { error: 'Need a name and target' }); return send(res, 201, await mut(V => { const g = { id: store.newId(), ...v, createdAt: new Date().toISOString() }; V.goals.push(g); return g; })); }
  if (r[0] === 'goals' && r[1]) {
    const g = find('goals', r[1]); if (!g) return send(res, 404, { error: 'Not found' });
    if (r[2] === 'add' && m === 'POST') { const a = Math.round(Number(b.amount) * 100) / 100; if (!Number.isFinite(a) || !a) return send(res, 400, { error: 'Amount?' }); return send(res, 200, await mut(() => { g.saved = Math.max(0, Math.round((g.saved + a) * 100) / 100); return g; })); }
    if (m === 'PUT') { const v = validGoal(); if (!v) return send(res, 400, { error: 'Invalid goal' }); return send(res, 200, await mut(() => Object.assign(g, v))); }
    if (m === 'DELETE') { await mut(V => { V.goals = V.goals.filter(y => y.id !== g.id); }); return send(res, 200, { ok: true }); }
  }
  return send(res, 404, { error: 'Not found' });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'), p = u.pathname.split('/').filter(Boolean);
  try {
    if (u.pathname === '/healthz') return send(res, 200, { ok: true, store: store.backendName.split(':')[0] });
    if (p[0] === 'api') {
      if (p[1] === 'config') return send(res, 200, { title: APP_TITLE });
      if (await auth.handle(req, res, p)) return;
      req.user = auth.userFor(req); if (!req.user) return send(res, 401, { error: 'Please log in' });
      return await api(req, res, p, u);
    }
    let f = path.join(__dirname, 'public', path.normalize(u.pathname).replace(/^(\.\.[\/\\])+/, ''));
    if (!f.startsWith(path.join(__dirname, 'public')) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(__dirname, 'public', 'index.html');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' });
    fs.createReadStream(f).pipe(res);
  } catch (e) { console.error(e); send(res, 500, { error: 'Server error' }); }
});
(async () => {
  store = await require('./store/state-store')(backend);
  auth = require('./auth')({ store, ADMIN_KEY, send, body });
  server.listen(PORT, '0.0.0.0', () => console.log(`${APP_TITLE} on :${PORT} (store: ${store.backendName.split(':')[0]})`));
})().catch(e => { console.error('Startup failed:', e.message); process.exit(1); });
