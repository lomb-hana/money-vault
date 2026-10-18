// Bank-link service: link / list / sync / unlink + background schedule. Mounted inside the main server
// (one Render free service) but self-contained: it only needs the store, a per-user vault getter, and the
// app's ingest(V, rows, source) which runs rows through the same dedupe + auto-categorize + reconcile as file imports.
const providers = require('./providers');
const { LinkError, sanitize } = require('./providers/util');
const { findTransfers, keyOf } = require('./transfers');
const H = 3600e3;
const MAX_LINKS = 10;
module.exports = function bankLink({ store, vault, ingest, sealer, log = console }) {
  const EVERY = Math.max(1, Number(process.env.BANK_SYNC_HOURS) || 6) * H;
  const MANUAL_GAP =
    (process.env.BANK_MANUAL_GAP_SEC != null ? Number(process.env.BANK_MANUAL_GAP_SEC) : 120) * 1e3;
  const FIRST_DAYS = 90;
  const OVERLAP_DAYS = 10;
  const busy = new Map(); // uid:linkId -> promise
  const aad = (uid, id) => `mv-bank:${uid}:${id}`;
  const links = uid => (vault(uid).links ||= []);
  const pub = l => ({
    id: l.id,
    provider: l.provider,
    providerName: (providers[l.provider] || {}).name || l.provider,
    label: l.label,
    createdAt: l.createdAt,
    lastSync: l.lastSync,
    lastAttempt: l.lastAttempt,
    status: l.status,
    error: l.error || null,
    warnings: l.warnings || [],
    lastResult: l.lastResult || null,
    accounts: l.accounts || [],
  });
  const publicProviders = () => ({
    configured: sealer.ready,
    syncEveryHours: EVERY / H,
    providers: Object.values(providers).map(p => ({
      id: p.id,
      name: p.name,
      enabled: sealer.ready && p.enabled(),
      ...p.info(),
    })),
  });
  const need = (uid, id) => {
    const l = links(uid).find(x => x.id === id);
    if (!l) {
      throw new LinkError('Linked bank not found', 'notfound', 404);
    }
    return l;
  };

  async function create(uid, providerId, input) {
    const p = providers[providerId];
    if (!p || !p.enabled()) {
      throw new LinkError('That bank provider is not available.', 'provider', 400);
    }
    if (!sealer.ready) {
      throw new LinkError(
        'Bank linking is not switched on yet (server is missing its encryption key).',
        'config',
        503,
      );
    }
    if (links(uid).length >= MAX_LINKS) {
      throw new LinkError(`Max ${MAX_LINKS} linked connections.`, 'limit', 400);
    }
    const { secret, label } = await p.link(input || {}, { uid });
    const id = store.newId();
    await store.mutate(() =>
      links(uid).push({
        id,
        provider: p.id,
        label: sanitize(label) || p.name,
        createdAt: new Date().toISOString(),
        secret: sealer.seal(secret, aad(uid, id)),
        accounts: [],
        lastSync: null,
        status: 'new',
      }),
    );
    let first = null;
    try {
      first = await sync(uid, id, { force: true });
    } catch (e) {
      first = { error: e.message };
    }
    return { link: pub(need(uid, id)), first };
  }

  function sync(uid, id, { manual = false, force = false } = {}) {
    const k = uid + ':' + id;
    if (busy.has(k)) {
      return busy.get(k);
    }
    let l;
    try {
      l = need(uid, id);
    } catch (e) {
      return Promise.reject(e);
    }
    if (manual && !force && l.lastAttempt && Date.now() - Date.parse(l.lastAttempt) < MANUAL_GAP) {
      return Promise.reject(
        new LinkError('Just synced. Give it a couple minutes.', 'throttle', 429),
      );
    }
    const run = (async () => {
      const p = providers[l.provider];
      if (!p) {
        throw new LinkError('Provider removed', 'provider', 400);
      }
      await store.mutate(() => {
        l.lastAttempt = new Date().toISOString();
        l.status = 'syncing';
      });
      let secret;
      let res;
      try {
        secret = sealer.open(l.secret, aad(uid, id));
        const since = new Date(
          l.lastSync
            ? Date.parse(l.lastSync) - OVERLAP_DAYS * 864e5
            : Date.now() - FIRST_DAYS * 864e5,
        ).toISOString();
        res = await p.pull(secret, { since });
      } catch (e) {
        const msg = e instanceof LinkError ? e.message : 'Sync failed. Try again later.';
        if (!(e instanceof LinkError)) {
          log.error('bank sync', l.provider, e.message);
        }
        await store.mutate(() => {
          l.status =
            e.code === 'revoked' || e.code === 'payment' || e.code === 'claim_403'
              ? 'needs_attention'
              : 'error';
          l.error = msg;
        });
        throw e instanceof LinkError ? e : new LinkError(msg, 'sync', 502);
      }
      return store.mutate(() => {
        if (!links(uid).includes(l)) {
          return { removed: true };
        } // unlinked mid-sync
        const V = vault(uid);
        const prev = new Map((l.accounts || []).map(a => [a.id, a]));
        l.accounts = res.accounts.map(a => {
          const o = prev.get(a.id);
          return {
            ...a,
            kind: o && o.kindSet ? o.kind : a.kind,
            kindSet: !!(o && o.kindSet),
            include: o ? o.include !== false : true,
          };
        });
        const inc = new Set(l.accounts.filter(a => a.include).map(a => a.id));
        const txs = res.transactions.filter(t => inc.has(t.accountId));
        const xfer = findTransfers(
          txs,
          l.accounts.filter(a => inc.has(a.id)),
        );
        const ref = t => `${l.provider}:${l.id}:${keyOf(t)}`.slice(0, 80);
        // a transfer whose other half only showed up now: pull the half we already imported
        const xrefs = new Set(txs.filter(t => xfer.has(keyOf(t))).map(ref));
        const before = V.tx.length;
        V.tx = V.tx.filter(t => !(t.source === 'bank' && t.ref && xrefs.has(t.ref)));
        const removed = before - V.tx.length;
        const rows = txs
          .filter(t => !xfer.has(keyOf(t)))
          .map(t => ({ date: t.date, desc: t.desc, amount: t.amount, ref: ref(t) }));
        const r = ingest(V, rows, 'bank');
        if (res.secret) {
          l.secret = sealer.seal(res.secret, aad(uid, id));
        } // e.g. Plaid cursor
        l.lastSync = new Date().toISOString();
        l.status = 'ok';
        l.error = null;
        l.warnings = (res.errors || []).slice(0, 8);
        l.lastResult = {
          fetched: res.transactions.length,
          added: r.added,
          dupes: r.dupes,
          transfers: xfer.size,
          removed,
          billsPaid: r.paid || 0,
          at: l.lastSync,
        };
        return l.lastResult;
      });
    })().finally(() => busy.delete(k));
    busy.set(k, run);
    return run;
  }

  async function setAccount(uid, id, accId, b) {
    const l = need(uid, id);
    const a = (l.accounts || []).find(x => x.id === accId);
    if (!a) {
      throw new LinkError('Account not found', 'notfound', 404);
    }
    await store.mutate(() => {
      if (typeof b.include === 'boolean') {
        a.include = b.include;
      }
      if (b.kind === 'credit' || b.kind === 'depository') {
        a.kind = b.kind;
        a.kindSet = true;
      }
    });
    return pub(l);
  }
  async function remove(uid, id, { dropTx = false } = {}) {
    const l = need(uid, id);
    const p = providers[l.provider];
    if (p && p.unlink) {
      try {
        await p.unlink(sealer.open(l.secret, aad(uid, id)));
      } catch (e) {
        log.error('unlink', e.message);
      }
    }
    let dropped = 0;
    await store.mutate(() => {
      const V = vault(uid);
      V.links = V.links.filter(x => x.id !== id);
      if (dropTx) {
        const pre = `${l.provider}:${l.id}:`;
        const n = V.tx.length;
        V.tx = V.tx.filter(t => !(t.source === 'bank' && String(t.ref || '').startsWith(pre)));
        dropped = n - V.tx.length;
      }
    });
    return { ok: true, dropped };
  }
  // Background: Render free sleeps when idle, so we also sync lazily when a user opens the app (kick()).
  const stale = l =>
    l.status !== 'needs_attention' &&
    (!l.lastAttempt || Date.now() - Date.parse(l.lastAttempt) > EVERY);
  function kick(uid) {
    for (const l of links(uid)) {
      if (stale(l)) {
        sync(uid, l.id).catch(() => {});
      }
    }
  }
  async function tick() {
    for (const [uid, V] of Object.entries(store.read().vaults || {})) {
      for (const l of V.links || []) {
        if (stale(l)) {
          try {
            await sync(uid, l.id);
          } catch {}
        }
      }
    }
  }
  let timer = null;
  const start = () => {
    if (!timer && sealer.ready) {
      timer = setInterval(() => tick().catch(e => log.error('bank tick', e.message)), 15 * 60e3);
      timer.unref();
      setTimeout(() => tick().catch(() => {}), 20e3).unref();
    }
  };
  return {
    create,
    sync,
    setAccount,
    remove,
    list: uid => links(uid).map(pub),
    publicProviders,
    kick,
    tick,
    start,
    plaid: providers.plaid,
  };
};
