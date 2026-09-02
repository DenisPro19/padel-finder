'use strict';
/**
 * Shared-passphrase gate for public deployments.
 *
 * Off by default: with no PADEL_PASSPHRASE set the app behaves exactly as it does
 * locally. When the variable is present every request needs a signed session cookie,
 * which is issued only in exchange for the passphrase.
 *
 * The passphrase is never written to disk and never leaves the server; the cookie
 * carries an expiry plus an HMAC of it, so changing the passphrase invalidates every
 * outstanding session.
 */
const crypto = require('crypto');

const PASSPHRASE = process.env.PADEL_PASSPHRASE || '';
const enabled = PASSPHRASE.length > 0;
const TTL_MS = 30 * 24 * 60 * 60 * 1000;      // stay signed in for a month
const COOKIE = 'padel_session';

// Signing key is derived from the passphrase, so it needs no separate secret and
// rotating the passphrase logs everyone out.
const KEY = enabled
  ? crypto.createHash('sha256').update(`padel-finder:${PASSPHRASE}`).digest()
  : null;

const b64 = (b) => Buffer.from(b).toString('base64url');
const sign = (msg) => b64(crypto.createHmac('sha256', KEY).update(msg).digest());

function issue() {
  const exp = String(Date.now() + TTL_MS);
  return `${b64(exp)}.${sign(exp)}`;
}

function valid(token) {
  if (!token || typeof token !== 'string') return false;
  const [encExp, sig] = token.split('.');
  if (!encExp || !sig) return false;
  let exp;
  try { exp = Buffer.from(encExp, 'base64url').toString(); } catch { return false; }
  const expected = sign(exp);
  if (sig.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  return Number(exp) > Date.now();
}

function checkPassphrase(candidate) {
  if (!enabled || typeof candidate !== 'string') return false;
  // Compare digests so the comparison is constant-time regardless of input length.
  const a = crypto.createHash('sha256').update(candidate).digest();
  const b = crypto.createHash('sha256').update(PASSPHRASE).digest();
  return crypto.timingSafeEqual(a, b);
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const isSecure = (req) =>
  (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';

function cookieHeader(token, req) {
  const bits = [
    `${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax',
    `Max-Age=${Math.floor(TTL_MS / 1000)}`,
  ];
  if (isSecure(req)) bits.push('Secure');
  return bits.join('; ');
}

const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

const authorized = (req) => !enabled || valid(parseCookies(req.headers.cookie)[COOKIE]);

/* ---------- brute-force throttle ----------
 * A shared passphrase on a public URL is only as good as the guess rate, so failures
 * are counted per client and the delay grows with each one.
 */
const attempts = new Map();

function clientKey(req) {
  const fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket.remoteAddress || 'unknown';
}

function lockoutMs(req) {
  const rec = attempts.get(clientKey(req));
  if (!rec) return 0;
  return Math.max(0, rec.until - Date.now());
}

function noteFailure(req) {
  const key = clientKey(req);
  const rec = attempts.get(key) || { count: 0, until: 0 };
  rec.count++;
  // Free for the first three tries, then 2s, 4s, 8s … capped at five minutes.
  const penalty = rec.count <= 3 ? 0 : Math.min(2000 * 2 ** (rec.count - 4), 300000);
  rec.until = Date.now() + penalty;
  attempts.set(key, rec);
  return penalty;
}

const noteSuccess = (req) => attempts.delete(clientKey(req));

module.exports = {
  enabled, COOKIE,
  issue, authorized, checkPassphrase,
  cookieHeader, clearCookie,
  lockoutMs, noteFailure, noteSuccess,
};
