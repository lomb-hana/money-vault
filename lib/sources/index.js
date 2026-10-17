// Import sources. Each returns { format, rows:[{date:'YYYY-MM-DD', desc, amount (signed: + in, - out), ref?}] }.
// To add live sync later (e.g. SimpleFIN), add sources/simplefin.js exposing fetchRows(credentials) with the same row shape,
// then feed its rows through importer.prepare() exactly like file imports.
const csv = require('./csv'), ofx = require('./ofx');
module.exports = { parseFile(text, filename = '') {
  const t = String(text || '').replace(/^\uFEFF/, '');
  if (/\.(ofx|qfx)$/i.test(filename) || /<OFX>|OFXHEADER/i.test(t.slice(0, 2000))) return ofx.parse(t);
  return csv.parse(t);
} };
