// AES-256-GCM sealing for provider secrets (SimpleFIN access URLs, Teller/Plaid access tokens).
// Key: BANK_LINK_KEY env, 32 bytes as base64 or hex. AAD binds each secret to its owner + link id,
// so a sealed blob copied into another user's vault will not decrypt.
const crypto = require('crypto');
function keyFrom(raw) {
  if (!raw) {
    return null;
  }
  const s = String(raw).trim();
  const b = /^[0-9a-f]{64}$/i.test(s) ? Buffer.from(s, 'hex') : Buffer.from(s, 'base64');
  if (b.length !== 32) {
    throw new Error('BANK_LINK_KEY must decode to 32 bytes (base64 or 64 hex chars)');
  }
  return b;
}
module.exports = function sealer(raw) {
  const key = keyFrom(raw);
  const b64 = x => x.toString('base64url');
  return {
    ready: !!key,
    fingerprint: key ? crypto.createHash('sha256').update(key).digest('hex').slice(0, 8) : null,
    seal(value, aad) {
      if (!key) {
        throw new Error('Bank linking is not configured (missing BANK_LINK_KEY)');
      }
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      c.setAAD(Buffer.from(String(aad)));
      const ct = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()]);
      return ['v1', b64(iv), b64(c.getAuthTag()), b64(ct)].join('.');
    },
    open(blob, aad) {
      if (!key) {
        throw new Error('Bank linking is not configured (missing BANK_LINK_KEY)');
      }
      const [v, iv, tag, ct] = String(blob || '').split('.');
      if (v !== 'v1' || !ct) {
        throw new Error('Bad sealed secret');
      }
      const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      d.setAAD(Buffer.from(String(aad)));
      d.setAuthTag(Buffer.from(tag, 'base64url'));
      return JSON.parse(
        Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8'),
      );
    },
  };
};
