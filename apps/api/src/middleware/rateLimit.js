import { SECURITY_DEFAULTS } from '../config/security.js';

function createRateLimiter({ limit, windowMs }, keyPrefix) {
  const buckets = new Map();

  return (req, res, next) => {
    const now = Date.now();
    const key = `${keyPrefix}:${req.ip}`;
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    bucket.count += 1;
    if (bucket.count > limit) {
      res.set('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
      return res.status(429).json({ error: 'Too many requests' });
    }
    return next();
  };
}

/* Auth bucket — FAILED credential attempts only (Master-protection fix,
 * 2026-11-20). The previous limiter counted EVERY request under
 * /auth/*, /speedy-verify/* and /access-control/* — including GET
 * /auth/me, which every console calls at boot, and including SUCCESSFUL
 * sign-ins — so the owner could rate-limit himself out of his own
 * system just by retrying a sign-in ("Too many requests" lockout,
 * 2026-11-20 00:51 EST). Rule Zero: the Master must never be walled
 * out by his own retries.
 *
 * New semantics, deliberately narrow:
 *  - Only a FAILED credential attempt consumes the budget: a POST that
 *    ends 401 or 403 (wrong password, wrong Verify/Layer 2 code,
 *    denied gate). Validation 400s and reads never count.
 *  - A SUCCESSFUL sign-in completion (2xx on a session-minting POST,
 *    or a completed Google/Apple callback) CLEARS the bucket for that
 *    IP — a legitimate holder who finally gets in is never punished
 *    for the attempts that got them there.
 *  - The budget itself is unchanged (SECURITY_DEFAULTS.rateLimits.auth:
 *    10 failed attempts per 15 minutes per IP), and the 429 body is
 *    byte-identical, so credential-guessing protection for every
 *    account — master and non-master alike — is exactly as strong as
 *    before. Non-master gates (Speedy Verify, Layer 2, temp-password
 *    locks) are untouched and still bind per account. */
const SESSION_SUCCESS_PATHS = [
  '/auth/login',
  '/auth/layer2/verify',
  '/auth/set-password',
  '/auth/passkeys/login/verify',
  '/auth/handoff/consume',
  '/auth/handoff/redeem',
  '/speedy-verify/verify',
  '/speedy-verify/recover/confirm',
];
const OAUTH_SUCCESS_PATHS = ['/auth/google/callback', '/auth/apple/callback'];

function createAuthRateLimiter({ limit, windowMs }, keyPrefix) {
  const buckets = new Map();

  return (req, res, next) => {
    const now = Date.now();
    const key = `${keyPrefix}:${req.ip}`;
    const bucket = buckets.get(key);

    if (bucket && bucket.resetAt > now && bucket.count >= limit) {
      res.set('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
      return res.status(429).json({ error: 'Too many requests' });
    }

    res.on('finish', () => {
      const path = String(req.originalUrl || req.url || '').split('?')[0];
      const status = res.statusCode;
      const isSessionSuccess =
        (req.method === 'POST' && status >= 200 && status < 300 && SESSION_SUCCESS_PATHS.some((p) => path.endsWith(p))) ||
        (req.method === 'GET' && status >= 200 && status < 400 && OAUTH_SUCCESS_PATHS.some((p) => path.endsWith(p)));
      if (isSessionSuccess) {
        buckets.delete(key);
        return;
      }
      if (req.method !== 'POST') return;
      if (status !== 401 && status !== 403) return;
      const t = Date.now();
      const current = buckets.get(key);
      if (!current || current.resetAt <= t) {
        buckets.set(key, { count: 1, resetAt: t + windowMs });
      } else {
        current.count += 1;
      }
    });
    return next();
  };
}

export const generalRateLimit = createRateLimiter(SECURITY_DEFAULTS.rateLimits.general, 'general');
export const authRateLimit = createAuthRateLimiter(SECURITY_DEFAULTS.rateLimits.auth, 'auth');
