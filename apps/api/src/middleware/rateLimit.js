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

export const generalRateLimit = createRateLimiter(SECURITY_DEFAULTS.rateLimits.general, 'general');
export const authRateLimit = createRateLimiter(SECURITY_DEFAULTS.rateLimits.auth, 'auth');
