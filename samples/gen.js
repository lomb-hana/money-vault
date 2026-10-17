// Generates realistic bank exports (fake data) in several formats for testing.
const fs = require('fs'), path = require('path'); const out = __dirname;
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647; const pick = a => a[Math.floor(rnd() * a.length)];
const T = []; const add = (d, desc, amt) => T.push({ d, desc, amt: Math.round(amt * 100) / 100 });
const day = (s, n) => { const x = new Date(s + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
for (let d = '2026-06-05'; d <= '2026-10-16'; d = day(d, 14)) add(d, 'PERCEPTA LLC PAYROLL PPD ID: 1234567', 1418.62);
for (const m of ['06', '07', '08', '09', '10']) {
  add(`2026-${m}-01`, 'HOUSTON ROOMING HOUSES RENT ACH', -650);
  add(`2026-${m}-07`, 'NETFLIX.COM 866-579-7172 CA', -15.49); add(`2026-${m}-09`, 'Spotify USA', -11.99);
  add(`2026-${m}-12`, 'T-MOBILE AUTOPAY 800-937-8997 WA', -65); add(`2026-${m}-20`, 'GEICO *AUTO 800-841-3000 DC', -142.18);
  add(`2026-${m}-15`, 'SUNO INC SUBSCRIPTION', -10); if (m !== '10') add(`2026-${m}-25`, 'RELIANT ENERGY RETAIL HOUSTON TX', -98 - rnd() * 40);
}
for (let d = '2026-06-02'; d <= '2026-10-16'; d = day(d, 1)) {
  if (rnd() < 0.45) add(d, pick(['TACO BELL #031245 HOUSTON TX', "MCDONALD'S F12345 HOUSTON TX", 'DOORDASH*WHATABURGER SAN FRANCISCO CA', 'UBER *EATS PENDING', 'H-E-B #578 HOUSTON TX', 'WHATABURGER 123 HOUSTON TX', 'SQ *KOLACHE FACTORY']), -(8 + rnd() * 30));
  if (rnd() < 0.12) add(d, pick(['SHELL OIL 57444212 HOUSTON TX', 'EXXONMOBIL 4512 HOUSTON TX', "BUC-EE'S #22 KATY TX", 'VALERO 1234']), -(30 + rnd() * 25));
  if (rnd() < 0.05) add(d, pick(['STEAMGAMES.COM 4259522985 WA', 'PLAYSTATION NETWORK', 'BLIZZARD ENT*BATTLE.NET', 'Microsoft*Xbox']), -(10 + rnd() * 60));
  if (rnd() < 0.07) add(d, pick(['WAL-MART #1234 HOUSTON TX', 'TARGET 00012345 HOUSTON TX', 'AMZN Mktp US*2K4LM1', 'Amazon.com*RT5YH']), -(12 + rnd() * 70));
  if (rnd() < 0.03) add(d, pick(['AMC 4532 HOUSTON TX', 'TOPGOLF HOUSTON', 'DAVE&BUSTERS HOUSTON']), -(20 + rnd() * 40));
  if (rnd() < 0.02) add(d, 'VENMO CASHOUT FROM BROHEMIAN', 40 + rnd() * 60);
}
T.sort((a, b) => a.d.localeCompare(b.d));
const us = d => `${d.slice(5, 7)}/${d.slice(8)}/${d.slice(0, 4)}`, q = s => `"${String(s).replace(/"/g, '""')}"`;
const files = {
  'chase.csv': ['Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #', ...T.map(t => [t.amt < 0 ? 'DEBIT' : 'CREDIT', us(t.d), q(t.desc), t.amt.toFixed(2), t.amt < 0 ? 'DEBIT_CARD' : 'ACH_CREDIT', '', ''].join(','))],
  'bofa.csv': ['Description,,Summary Amt.', 'Beginning balance as of 06/01/2026,,"1,204.33"', 'Total credits,,"9,000.00"', '', 'Date,Description,Amount,Running Bal.', ...T.map(t => [us(t.d), q(t.desc), q(t.amt.toLocaleString('en-US', { minimumFractionDigits: 2 })), '""'].join(','))],
  'capitalone.csv': ['Transaction Date,Posted Date,Card No.,Description,Category,Debit,Credit', ...T.map(t => [t.d, day(t.d, 1), '1234', q(t.desc), 'Other', t.amt < 0 ? (-t.amt).toFixed(2) : '', t.amt > 0 ? t.amt.toFixed(2) : ''].join(','))],
  'varo.csv': ['Date,Description,Amount,Status', ...T.map(t => [q(`${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+t.d.slice(5, 7) - 1]} ${+t.d.slice(8)}, ${t.d.slice(0, 4)}`), q(t.desc), (t.amt < 0 ? '-$' : '$') + Math.abs(t.amt).toFixed(2), 'Posted'].join(',')), '"Oct 16, 2026","STARBUCKS STORE 123",-$6.45,Pending'],
  'cashapp.csv': ['Transaction ID,Date,Transaction Type,Currency,Amount,Fee,Net Amount,Asset Type,Asset Price,Asset Amount,Status,Notes,Name of sender/receiver,Account', ...T.filter((t, i) => i % 3 === 0).map((t, i) => [`tx${i}`, `${t.d} 12:0${i % 10}:00 CDT`, t.amt < 0 ? 'Cash Card Debit' : 'Received P2P', 'USD', (t.amt < 0 ? '-$' : '$') + Math.abs(t.amt).toFixed(2), '$0', (t.amt < 0 ? '-$' : '$') + Math.abs(t.amt).toFixed(2), '', '', '', 'COMPLETE', '', q(t.desc), 'Visa Debit 1234'].join(','))],
  'wellsfargo.csv': T.slice(0, 40).map(t => [q(us(t.d)), q(t.amt.toFixed(2)), '"*"', '""', q(t.desc)].join(',')),
};
for (const [f, lines] of Object.entries(files)) fs.writeFileSync(path.join(out, f), lines.join('\r\n') + '\r\n');
fs.writeFileSync(path.join(out, 'bank.qfx'), `OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\n\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>\n` + T.slice(-30).map((t, i) => `<STMTTRN><TRNTYPE>${t.amt < 0 ? 'DEBIT' : 'CREDIT'}<DTPOSTED>${t.d.replace(/-/g, '')}120000<TRNAMT>${t.amt.toFixed(2)}<FITID>F${i}<NAME>${t.desc.slice(0, 32).replace(/&/g, '&amp;')}</STMTTRN>`).join('\n') + `\n</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>\n`);
console.log(T.length, 'transactions');
