// Shared helpers for provider adapters.
class LinkError extends Error { constructor(msg, code = 'link', status = 400) { super(msg); this.code = code; this.status = status; } }
const TZ = 'America/Chicago';
const dayOf = epochSec => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(epochSec * 1000));
const num = v => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) / 100 : null; };
// Strip anything that looks like a URL/credential and clamp length: provider error text is shown to users.
const sanitize = s => String(s ?? '').replace(/<[^>]*>/g, '').replace(/https?:\/\/\S+/gi, '[link]').replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
const CREDIT_NAME = /credit|card|visa|master ?card|amex|american express|discover|sapphire|freedom|quicksilver|savor|venture|platinum|rewards|apple card|\bcc\b/i;
async function http(url, opts = {}, ms = 25000) {
  try { return await fetch(url, { redirect: 'error', ...opts, signal: AbortSignal.timeout(ms) }); }
  catch (e) { throw new LinkError(e.name === 'TimeoutError' ? 'The bank service took too long. Try again in a bit.' : 'Could not reach the bank service.', 'network', 502); }
}
module.exports = { LinkError, dayOf, num, sanitize, CREDIT_NAME, http };
