// Local JSON file backend.
const fs = require('fs'), path = require('path');
module.exports = function jsonBackend(file) {
  return {
    name: 'json:' + file,
    async load() { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null; },
    async save(db) { fs.mkdirSync(path.dirname(file), { recursive: true }); const t = file + '.tmp'; fs.writeFileSync(t, JSON.stringify(db, null, 2)); fs.renameSync(t, file); },
  };
};
