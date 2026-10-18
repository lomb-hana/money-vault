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
const body = req => new Promise(r => { let d = '', n = 0; req.on('data', c => { n += c.length; if (n < 6e6) d += c; }); req.on('end', () => { try { r(JSON.parse(d || '{}')); } catch { r({}); } }); });
const clean = (v, n = 60) => String(v ?? '').trim().slice(0, n);
const money = v => { const n = Math.round(Number(v) * 100) / 100; return Number.isFinite(n) && n >= 0 && n < 1e9 ? n : NaN; };
const isDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '') && !isNaN(Date.parse(d));
let store, auth, bank;
const vault = uid => { const d = store.read(); const V = d.vaults[uid] ||= { tx: [], budgets: {}, bills: [], goals: [], pay: { freq: 'biweekly', amount: 0, anchor: null } };
  V.rules ||= []; V.dismissed ||= []; V.autoDone ||= []; return V; }; // additive migration
const sources = require('./lib/sources'), importer = require('./lib/importer'), auto = require('./lib/auto'), recurring = require('./lib/recurring');
const { categorize, merchantOf, titleCase } = require('./lib/categorize');
const BILL_CATS = ['Bills', 'Rent', 'Subscriptions'];

function validTx(b) {
  const type = b.type === 'income' ? 'income' : b.type === 'expense' ? 'expense' : null, amount = money(b.amount);
  const cats = type === 'income' ? INCOME : EXPENSE;
  if (!type || !(amount > 0) || !cats.includes(b.category) || !isDate(b.date)) return null;
  return { type, amount, category: b.category, date: b.date, note: clean(b.note, 120) };
}
// Shared by file import and bank sync: validate, dedupe (by key + provider ref), categorize, then reconcile bills/paychecks.
function commitRows(V, list, source) {
  // File imports: one tx per (date, amount, merchant) key. Bank sync: rows carry stable provider ids (ref), so two real
  // identical $5 coffees on one day both land; keys only match against file/manual entries, each consumed once.
  const live = source === 'bank', have = new Map(), refs = new Set(V.tx.map(t => t.ref).filter(Boolean)), added = []; let dupes = 0, bad = 0;
  for (const t of V.tx) if (t.source !== 'auto' && !(live && t.source === 'bank')) { const k = importer.txKey(t); have.set(k, (have.get(k) || 0) + 1); }
  for (const x of list) {
    const v = validTx({ ...x, note: '' }); if (!v) { bad++; continue; }
    const desc = clean(x.desc, 140), k = importer.dupKey(v.date, v.type === 'expense' ? -v.amount : v.amount, desc), ref = clean(x.ref, 80) || undefined;
    if ((ref && refs.has(ref)) || have.get(k) > 0) { dupes++; if (live && have.get(k) > 0) have.set(k, have.get(k) - 1); continue; }
    if (!live) have.set(k, 1); if (ref) refs.add(ref);
    const merchant = merchantOf(desc), t = { id: store.newId(), ...v, desc, merchant, merchantName: titleCase(merchant), ref, source, createdAt: new Date().toISOString() };
    V.tx.push(t); added.push(t);
  }
  const rec = auto.reconcile(V, added); auto.run(V, store.newId);
  return { added: added.length, dupes, bad, ...rec };
}
// bank rows {date, desc, amount signed, ref} -> same auto-categorize (incl. personal rules) as a file import
const ingest = (V, rows, source) => commitRows(V, rows.map(r => { const c = categorize(r.desc, r.amount, V.rules); return { ...r, amount: Math.abs(r.amount), type: c.type, category: c.category }; }), source);
const linkHits = new Map(), linkLimit = uid => { const t = Date.now(); let h = linkHits.get(uid); if (!h || h.reset < t) linkHits.set(uid, h = { n: 0, reset: t + 15 * 60e3 }); return ++h.n > 8 ? Math.ceil((h.reset - t) / 60e3) : 0; };
const addDay = d => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); };
const csvCell = v => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

async function api(req, res, p, u) {
  const m = req.method, uid = req.user.id, r = p.slice(1);
  const V = () => vault(uid), mut = fn => store.mutate(() => fn(V()));
  const find = (list, id) => V()[list].find(x => x.id === id);
  if (r[0] === 'state' && m === 'GET') {
    if (auto.run(JSON.parse(JSON.stringify(V())), store.newId)) await mut(V => auto.run(V, store.newId)); // only write when something is due
    bank.kick(uid); const { autoDone, links, ...pub } = V(); return send(res, 200, { ...pub, today: auto.today(), user: { username: req.user.username }, EXPENSE, INCOME, FREQS, BILL_CATS });
  }
  if (r[0] === 'export.csv' && m === 'GET') {
    const rows = [['date', 'type', 'category', 'amount', 'description', 'note', 'source']].concat(V().tx.slice().sort((a, b) => a.date.localeCompare(b.date)).map(t => [t.date, t.type, t.category, t.amount.toFixed(2), t.desc || '', t.note || '', t.source || 'manual']));
    return send(res, 200, rows.map(x => x.map(csvCell).join(',')).join('\r\n') + '\r\n', 'text/csv; charset=utf-8', { 'Content-Disposition': 'attachment; filename="transactions.csv"' });
  }
  const b = m === 'GET' ? {} : await body(req);
  // transactions
  if (r[0] === 'tx' && !r[1] && m === 'POST') { const v = validTx(b); if (!v) return send(res, 400, { error: 'Need type, amount > 0, category and date' }); return send(res, 201, await mut(V => { const t = { id: store.newId(), ...v, createdAt: new Date().toISOString() }; V.tx.push(t); return t; })); }
  if (r[0] === 'tx' && r[1]) {
    const t = find('tx', r[1]); if (!t) return send(res, 404, { error: 'Not found' });
    if (m === 'PUT') { const v = validTx(b); if (!v) return send(res, 400, { error: 'Invalid transaction' }); return send(res, 200, await mut(() => Object.assign(t, v, t.source === 'auto' ? { edited: true } : {}))); }
    if (m === 'DELETE') { await mut(V => { V.tx = V.tx.filter(x => x.id !== t.id); }); return send(res, 200, { ok: true }); }
  }
  // ---- import (file now; a live-sync source like SimpleFIN can produce the same rows later)
  if (r[0] === 'import' && r[1] === 'preview' && m === 'POST') {
    let parsed; try { parsed = sources.parseFile(String(b.text || '').slice(0, 5e6), clean(b.filename, 120)); } catch (e) { return send(res, 400, { error: e.message }); }
    const rows = importer.prepare(parsed.rows, V());
    return send(res, 200, { format: parsed.format, columns: parsed.columns, skipped: parsed.skipped, rows, dupes: rows.filter(x => x.dup).length });
  }
  if (r[0] === 'import' && r[1] === 'commit' && m === 'POST') {
    const list = Array.isArray(b.rows) ? b.rows.slice(0, 5000) : [];
    return send(res, 200, await mut(V => commitRows(V, list, 'import')));
  }
  // ---- automatic bank linking (bank-link/): SimpleFIN first, Teller + Plaid adapters
  if (r[0] === 'bank') {
    const bl = bank, q = (fn, code = 200) => fn.then(x => send(res, code, x), e => send(res, e.status || 500, { error: e.status ? e.message : 'Bank link error' }));
    if (r[1] === 'providers' && m === 'GET') return send(res, 200, bl.publicProviders());
    if (r[1] === 'links' && !r[2] && m === 'GET') return send(res, 200, bl.list(uid));
    if (r[1] === 'links' && !r[2] && m === 'POST') { const wait = linkLimit(uid); if (wait) return send(res, 429, { error: `Too many link attempts. Try again in ${wait} min.` }); return q(bl.create(uid, clean(b.provider, 20), { token: b.token, accessToken: b.accessToken, publicToken: b.publicToken, institution: clean(b.institution, 60) }), 201); }
    if (r[1] === 'links' && r[2] && r[3] === 'sync' && m === 'POST') return q(bl.sync(uid, r[2], { manual: true }));
    if (r[1] === 'links' && r[2] && r[3] === 'accounts' && r[4] && m === 'PUT') return q(bl.setAccount(uid, r[2], decodeURIComponent(r[4]), b));
    if (r[1] === 'links' && r[2] && !r[3] && m === 'DELETE') return q(bl.remove(uid, r[2], { dropTx: u.searchParams.get('dropTx') === '1' }));
    if (r[1] === 'plaid' && r[2] === 'link-token' && m === 'POST') { if (!bl.plaid.enabled()) return send(res, 404, { error: 'Plaid not configured' }); return q(bl.plaid.linkToken(uid).then(t => ({ linkToken: t }))); }
    return send(res, 404, { error: 'Not found' });
  }
  // ---- personal categorization rules
  if (r[0] === 'rules' && !r[1] && m === 'POST') {
    const merchant = clean(b.merchant, 60).toLowerCase(), type = b.type === 'income' ? 'income' : 'expense', cats = type === 'income' ? INCOME : EXPENSE;
    if (!merchant || !cats.includes(b.category)) return send(res, 400, { error: 'Need merchant and category' });
    return send(res, 200, await mut(V => { V.rules = V.rules.filter(x => !(x.merchant === merchant && x.type === type)); V.rules.unshift({ id: store.newId(), merchant, type, category: b.category });
      let fixed = 0; if (b.applyPast) for (const t of V.tx) if (t.type === type && t.merchant && (t.merchant === merchant || t.merchant.startsWith(merchant + ' ')) && t.category !== b.category) { t.category = b.category; fixed++; }
      return { ok: true, fixed, rules: V.rules }; }));
  }
  if (r[0] === 'rules' && r[1] && m === 'DELETE') { await mut(V => { V.rules = V.rules.filter(x => x.id !== r[1]); }); return send(res, 200, { ok: true }); }
  // ---- recurring detection
  if (r[0] === 'recurring' && !r[1] && m === 'GET') {
    const Vv = V(), list = recurring.detect(Vv.tx, { today: auto.today() }).filter(x => !Vv.dismissed.includes(x.key))
      .map(x => ({ ...x, name: titleCase(x.merchant), already: x.type === 'expense' ? Vv.bills.some(bb => bb.match === x.merchant) : !!(Vv.pay.auto && Math.abs(Vv.pay.amount - x.amount) <= x.amount * 0.2) }));
    return send(res, 200, list);
  }
  if (r[0] === 'recurring' && r[1] === 'dismiss' && m === 'POST') { await mut(V => { if (!V.dismissed.includes(b.key)) V.dismissed.push(clean(b.key, 120)); }); return send(res, 200, { ok: true }); }
  if (r[0] === 'recurring' && r[1] === 'accept' && m === 'POST') {
    const x = recurring.detect(V().tx, { today: auto.today() }).find(y => y.key === b.key); if (!x) return send(res, 404, { error: 'That pattern is gone' });
    const t = auto.today();
    if (x.type === 'income') { await mut(V => { V.pay = { freq: x.freq, amount: x.amount, anchor: x.last, auto: true, autoSince: addDay(t) }; }); return send(res, 200, { ok: true, as: 'paycheck' }); }
    const cat = b.as === 'subscription' ? 'Subscriptions' : BILL_CATS.includes(x.category) ? x.category : 'Bills';
    const bill = await mut(V => { const nb = { id: store.newId(), name: titleCase(x.merchant), amount: x.amount, dueDay: x.dueDay, recurring: true, category: cat, match: x.merchant, autoLog: true, autoSince: addDay(t), paid: [] };
      if (x.last.slice(0, 7) === t.slice(0, 7)) nb.paid.push(t.slice(0, 7)); V.bills.push(nb); return nb; });
    return send(res, 200, { ok: true, as: cat === 'Subscriptions' ? 'subscription' : 'bill', bill });
  }
  // ---- smart budgets: average of last 3 full months, rounded to $5, optional trim
  if (r[0] === 'budgets' && r[1] === 'auto' && m === 'POST') {
    const t = auto.today(); let [y, mo] = t.split('-').map(Number); const months = []; for (let i = 0; i < 3; i++) { mo--; if (mo < 1) { mo = 12; y--; } months.push(`${y}-${String(mo).padStart(2, '0')}`); }
    const tot = {}; for (const x of V().tx) if (x.type === 'expense' && months.includes(x.date.slice(0, 7))) tot[x.category] = (tot[x.category] || 0) + x.amount;
    const out = {}; for (const [c, v] of Object.entries(tot)) { const k = b.trim && !BILL_CATS.includes(c) ? 0.9 : 1, n = Math.round(v / 3 * k / 5) * 5; if (n >= 5 && EXPENSE.includes(c)) out[c] = n; }
    if (!Object.keys(out).length) return send(res, 400, { error: 'Need a few months of spending first. Import a statement!' });
    return send(res, 200, await mut(V => (V.budgets = out)));
  }
  // budgets: {category: limit} (0 or empty removes)
  if (r[0] === 'budgets' && m === 'PUT') {
    const out = {}; for (const [k, v] of Object.entries(b.budgets || {})) { if (!EXPENSE.includes(k)) continue; const n = money(v); if (n > 0) out[k] = n; }
    return send(res, 200, await mut(V => (V.budgets = out)));
  }
  // paycheck
  if (r[0] === 'pay' && m === 'PUT') {
    const amount = money(b.amount); if (!FREQS.includes(b.freq) || !(amount >= 0) || (b.anchor && !isDate(b.anchor))) return send(res, 400, { error: 'Pick a frequency, amount and a recent payday' });
    return send(res, 200, await mut(V => { const was = V.pay || {}, on = !!b.auto; V.pay = { freq: b.freq, amount, anchor: b.anchor || null, auto: on, autoSince: on ? (was.auto && was.autoSince) || auto.today() : null }; return V.pay; }));
  }
  // bills
  const validBill = () => { const amount = money(b.amount), day = Math.round(Number(b.dueDay)), name = clean(b.name, 40); return name && amount >= 0 && day >= 1 && day <= 31 ? { name, amount, dueDay: day, recurring: b.recurring !== false, category: BILL_CATS.includes(b.category) ? b.category : 'Bills', autoLog: !!b.autoLog } : null; };
  const autoSince = (x, on) => on ? (x && x.autoLog && x.autoSince) || addDay(auto.today()) : null;
  if (r[0] === 'bills' && !r[1] && m === 'POST') { const v = validBill(); if (!v) return send(res, 400, { error: 'Need name, amount and due day 1-31' }); return send(res, 201, await mut(V => { const x = { id: store.newId(), ...v, autoSince: autoSince(null, v.autoLog), paid: [] }; V.bills.push(x); return x; })); }
  if (r[0] === 'bills' && r[1]) {
    const x = find('bills', r[1]); if (!x) return send(res, 404, { error: 'Not found' });
    if (r[2] === 'paid' && m === 'POST') { if (!/^\d{4}-\d{2}$/.test(b.month || '')) return send(res, 400, { error: 'month YYYY-MM' }); return send(res, 200, await mut(() => { x.paid = x.paid.filter(mm => mm !== b.month); if (b.paid !== false) x.paid.push(b.month); x.paid = x.paid.slice(-36); return x; })); }
    if (m === 'PUT') { const v = validBill(); if (!v) return send(res, 400, { error: 'Invalid bill' }); return send(res, 200, await mut(() => Object.assign(x, v, { autoSince: autoSince(x, v.autoLog) }))); }
    if (r[2] === 'auto' && m === 'POST') return send(res, 200, await mut(() => Object.assign(x, { autoLog: !!b.on, autoSince: autoSince(x, !!b.on) })));
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
    if (u.pathname === '/healthz') return send(res, 200, { ok: true, store: store.backendName.split(':')[0], bankLink: bank && bank.publicProviders().configured ? 'on' : 'off' });
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
  const sealer = require('./bank-link/crypto')(process.env.BANK_LINK_KEY || (PROD ? '' : require('crypto').createHash('sha256').update('local-dev-only-bank-link-key').digest('hex')));
  if (!process.env.BANK_LINK_KEY) console.warn(PROD ? 'BANK_LINK_KEY not set: bank linking disabled.' : 'BANK_LINK_KEY not set: using a fixed DEV key (never in production).');
  bank = require('./bank-link/service')({ store, vault, ingest, sealer }); bank.start();
  server.listen(PORT, '0.0.0.0', () => console.log(`${APP_TITLE} on :${PORT} (store: ${store.backendName.split(':')[0]})`));
})().catch(e => { console.error('Startup failed:', e.message); process.exit(1); });
