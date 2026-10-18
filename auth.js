// Username/password accounts with scrypt hashes and db-stored sessions (zero deps).
const crypto = require('crypto');
const COOKIE = 'mv_sid';
const TTL = 30 * 864e5;
const PROD = process.env.NODE_ENV === 'production';
const scrypt = (pw, salt) =>
  new Promise((ok, no) => crypto.scrypt(pw, salt, 64, (e, k) => (e ? no(e) : ok(k))));
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
module.exports = ({ store, ADMIN_KEY, send, body }) => {
  const db = () => store.read();
  const now = () => new Date().toISOString();
  const hits = new Map(); // ip -> {n, reset}
  const ipOf = req =>
    String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
      .split(',')
      .pop()
      .trim(); // rightmost = added by Render's proxy, not client-spoofable
  function limited(req) {
    const ip = ipOf(req);
    const t = Date.now();
    let h = hits.get(ip);
    if (!h || h.reset < t) {
      h = { n: 0, reset: t + 15 * 60e3 };
      hits.set(ip, h);
    }
    h.n++;
    if (hits.size > 5000) {
      for (const [k, v] of hits) {
        if (v.reset < t) {
          hits.delete(k);
        }
      }
    }
    return h.n > 10 ? Math.ceil((h.reset - t) / 60e3) : 0;
  }
  const cookieOf = req => {
    const m = String(req.headers.cookie || '').match(
      new RegExp('(?:^|;\\s*)' + COOKIE + '=([a-f0-9]{64})'),
    );
    return m && m[1];
  };
  const setCookie = (res, tok, maxAge) =>
    res.setHeader(
      'Set-Cookie',
      `${COOKIE}=${tok}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${PROD ? '; Secure' : ''}`,
    );
  const pubUser = u => ({ id: u.id, username: u.username, createdAt: u.createdAt });
  async function hashPw(pw) {
    const salt = crypto.randomBytes(16).toString('hex');
    return { salt, hash: (await scrypt(pw, salt)).toString('hex') };
  }
  async function checkPw(u, pw) {
    const k = await scrypt(pw, u.salt);
    const h = Buffer.from(u.hash, 'hex');
    return k.length === h.length && crypto.timingSafeEqual(k, h);
  }
  const validName = n => /^[A-Za-z0-9_-]{3,24}$/.test(n || '');
  async function startSession(res, u) {
    const tok = crypto.randomBytes(32).toString('hex');
    await store.mutate(d => {
      const t = Date.now();
      d.sessions = d.sessions.filter(s => Date.parse(s.expires) > t);
      d.sessions.push({
        id: sha(tok),
        userId: u.id,
        created: now(),
        expires: new Date(t + TTL).toISOString(),
      });
    });
    setCookie(res, tok, TTL / 1000);
  }
  function userFor(req) {
    const tok = cookieOf(req);
    if (!tok) {
      return null;
    }
    const id = sha(tok);
    const s = db().sessions.find(x => x.id === id);
    if (!s || Date.parse(s.expires) < Date.now()) {
      return null;
    }
    return db().users.find(u => u.id === s.userId) || null;
  }
  async function handle(req, res, p) {
    // returns true if handled
    const m = req.method;
    const r = p.slice(1).join('/');
    if (r === 'auth/me' && m === 'GET') {
      const u = userFor(req);
      return (send(res, u ? 200 : 401, u ? pubUser(u) : { error: 'Not logged in' }), true);
    }
    if ((r === 'auth/register' || r === 'auth/login') && m === 'POST') {
      const wait = limited(req);
      if (wait) {
        return (send(res, 429, { error: `Too many attempts. Try again in ${wait} min.` }), true);
      }
      const b = await body(req);
      const name = String(b.username || '').trim();
      const pw = String(b.password || '');
      const u = db().users.find(x => x.uname === name.toLowerCase());
      if (r === 'auth/register') {
        if (!validName(name)) {
          return (send(res, 400, { error: 'Username: 3-24 letters, numbers, _ or -' }), true);
        }
        if (pw.length < 6 || pw.length > 200) {
          return (send(res, 400, { error: 'Password must be at least 6 characters' }), true);
        }
        if (u) {
          return (send(res, 409, { error: 'That username is taken' }), true);
        }
        const nu = {
          id: store.newId(),
          username: name,
          uname: name.toLowerCase(),
          ...(await hashPw(pw)),
          createdAt: now(),
        };
        await store.mutate(d => d.users.push(nu));
        await startSession(res, nu);
        return (send(res, 201, pubUser(nu)), true);
      }
      if (!u || !(await checkPw(u, pw))) {
        if (!u) {
          await scrypt(pw, 'x'.repeat(32));
        }
        return (send(res, 401, { error: 'Wrong username or password' }), true);
      }
      await startSession(res, u);
      return (send(res, 200, pubUser(u)), true);
    }
    if (r === 'auth/logout' && m === 'POST') {
      const tok = cookieOf(req);
      if (tok) {
        await store.mutate(d => {
          d.sessions = d.sessions.filter(s => s.id !== sha(tok));
        });
      }
      setCookie(res, '', 0);
      return (send(res, 200, { ok: true }), true);
    }
    // Admin: password reset only (no email recovery). POST /api/admin/users/<username>/password {adminKey, password}
    if (p[1] === 'admin' && p[2] === 'users' && p[4] === 'password' && m === 'POST') {
      const wait = limited(req);
      if (wait) {
        return (send(res, 429, { error: `Too many attempts. Try again in ${wait} min.` }), true);
      }
      const b = await body(req);
      const k = Buffer.from(String(b.adminKey || ''));
      const a = Buffer.from(ADMIN_KEY || '');
      if (!ADMIN_KEY || k.length !== a.length || !crypto.timingSafeEqual(k, a)) {
        return (send(res, 403, { error: 'Wrong admin key' }), true);
      }
      const u = db().users.find(x => x.uname === String(p[3]).toLowerCase());
      if (!u) {
        return (send(res, 404, { error: 'No such user' }), true);
      }
      const pw = String(b.password || '');
      if (pw.length < 6) {
        return (send(res, 400, { error: 'Password must be at least 6 characters' }), true);
      }
      const h = await hashPw(pw);
      await store.mutate(d => {
        Object.assign(u, h, { pwResetAt: now() });
        d.sessions = d.sessions.filter(s => s.userId !== u.id);
      });
      return (send(res, 200, { ok: true }), true);
    }
    return false;
  }
  return { handle, userFor };
};
