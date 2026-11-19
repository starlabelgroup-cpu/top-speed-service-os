import { consumeIntakeAttempt } from '../services/intakeShield.js';

/**
 * Route-level intake rate limiting (2026-11-19). Applied as a
 * per-route middleware argument on the public intake POSTs ONLY —
 * never as a router-wide use() — so it cannot wall any sibling route
 * on the shared /api/v1 prefix (the 2026-11-17 auth-trap rule).
 *
 * A request carrying a valid session (req.user, set by
 * optionalAuthenticate where the route runs it) is a known account,
 * not the anonymous bot vector this shield throttles — office staff
 * creating accounts from one office IP must never trip it.
 * Forgot-password does NOT use this middleware: its contract is an
 * enumeration-safe generic 200, so its (tighter) limit is enforced
 * inside the handler via consumeIntakeAttempt, quietly skipping the
 * send instead of answering 429.
 */
export function intakeRateLimit(family) {
  return async (req, res, next) => {
    if (req.user) return next();
    const verdict = await consumeIntakeAttempt(family, req.ip);
    if (verdict.allowed) return next();
    res.set('Retry-After', String(verdict.retryAfterSeconds));
    return res.status(429).json({
      error: 'Too many requests from this connection — please wait a little while and try again, or call us at 954-931-7997.',
      code: 'RATE_LIMITED',
    });
  };
}
