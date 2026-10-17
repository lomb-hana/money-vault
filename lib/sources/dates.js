const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = n => String(n).padStart(2, '0');
const mk = (y, m, d) => { y = +y; if (y < 100) y += 2000; m = +m; d = +d; if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31 && y > 1990 && y < 2100)) return null; const s = `${y}-${pad(m)}-${pad(d)}`; return isNaN(Date.parse(s)) ? null : s; };
// dayFirst: true for DD/MM, false for MM/DD, undefined = guess per value (US default)
function parseDate(v, dayFirst) {
  v = String(v || '').trim().replace(/^"|"$/g, ''); let m;
  if ((m = v.match(/^(\d{4})(\d{2})(\d{2})/))) return mk(m[1], m[2], m[3]); // OFX 20261003120000
  if ((m = v.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) return mk(m[1], m[2], m[3]);
  if ((m = v.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/))) { const a = +m[1], b = +m[2]; const df = dayFirst ?? (a > 12 && b <= 12); return df ? mk(m[3], b, a) : mk(m[3], a, b); }
  if ((m = v.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/))) return MON[m[1].toLowerCase().slice(0, m[1].toLowerCase() === 'sept' ? 4 : 3)] ? mk(m[3], MON[m[1].toLowerCase().slice(0, 3)], m[2]) : null;
  if ((m = v.match(/^(\d{1,2})[\s-]([A-Za-z]{3,9})[\s-,]+(\d{2,4})/))) return MON[m[2].toLowerCase().slice(0, 3)] ? mk(m[3], MON[m[2].toLowerCase().slice(0, 3)], m[1]) : null;
  return null;
}
module.exports = { parseDate };
