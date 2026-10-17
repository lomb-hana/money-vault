const { parseDate } = require('./dates');
// OFX 1.x (SGML, unclosed tags) and 2.x (XML). Reads <STMTTRN> blocks.
function parse(text) {
  const blocks = text.split(/<STMTTRN>/i).slice(1).map(b => b.split(/<\/STMTTRN>/i)[0]);
  const tag = (b, t) => { const m = b.match(new RegExp('<' + t + '>([^<\\r\\n]*)', 'i')); return m ? m[1].trim().replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') : ''; };
  const rows = []; let skipped = 0;
  for (const b of blocks) {
    const date = parseDate(tag(b, 'DTPOSTED')), amount = parseFloat(tag(b, 'TRNAMT'));
    if (!date || !amount) { skipped++; continue; }
    const desc = [tag(b, 'NAME'), tag(b, 'MEMO')].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).join(' · ').slice(0, 140) || tag(b, 'TRNTYPE');
    rows.push({ date, desc, amount: Math.round(amount * 100) / 100, ref: tag(b, 'FITID') || undefined });
  }
  if (!blocks.length) throw new Error('No transactions found in that OFX/QFX file');
  return { format: 'ofx', columns: { date: 'DTPOSTED', description: 'NAME/MEMO', amount: 'TRNAMT' }, rows, skipped };
}
module.exports = { parse };
