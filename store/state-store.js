// Whole db kept in memory, persisted via backend {load, save}. Writes serialized.
const crypto = require('crypto');
module.exports = async function stateStore(backend) {
  const db = (await backend.load()) || {};
  db.users ||= [];
  db.sessions ||= [];
  db.vaults ||= {}; // vaults[userId] = that user's private data
  let chain = Promise.resolve();
  const save = () => {
    const snap = JSON.stringify(db);
    const p = chain.then(() => backend.save(JSON.parse(snap)));
    chain = p.catch(e => console.error('persist failed:', e.message));
    return p;
  };
  return {
    backendName: backend.name,
    read() {
      return db;
    },
    async mutate(fn) {
      const r = fn(db);
      await save();
      return r;
    },
    newId: () => crypto.randomBytes(6).toString('hex'),
  };
};
