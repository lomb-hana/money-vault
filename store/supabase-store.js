// Supabase backend via PostgREST (Node 18 global fetch, no deps). Table: see supabase/schema.sql.
module.exports = function supabaseBackend(
  url,
  key,
  rowId = process.env.STATE_ROW_ID || 'money-main',
) {
  const base = url.replace(/\/+$/, '') + '/rest/v1/app_state';
  const h = { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
  const ok = async r => {
    if (!r.ok) {
      throw new Error(`Supabase ${r.status}: ${await r.text()}`);
    }
    return r;
  };
  const backend = {
    name: 'supabase',
    async load() {
      const rows = await (
        await ok(
          await fetch(`${base}?id=eq.${encodeURIComponent(rowId)}&select=data`, { headers: h }),
        )
      ).json();
      if (rows.length) {
        return rows[0].data;
      }
      const init = {};
      await backend.save(init);
      return init;
    },
    async save(db) {
      await ok(
        await fetch(base + '?on_conflict=id', {
          method: 'POST',
          headers: { ...h, Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify({ id: rowId, data: db, updated_at: new Date().toISOString() }),
        }),
      );
    },
  };
  return backend;
};
