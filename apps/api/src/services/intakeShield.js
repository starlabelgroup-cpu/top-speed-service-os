import { DATABASE_ENABLED, db } from '../db/client.js';
import { ASSIGNED_NANP_AREA_CODES } from './nanpAreaCodes.js';

/**
 * Intake shield (2026-11-19, Ramone's directive: "Stop all of them
 * fake emails"). Layered, additive protection for the public intake
 * endpoints — account registration, /connections, the PM bulk
 * requests that share the connection pipeline, the guest booking
 * endpoint, and forgot-password:
 *
 *  1. Honeypot — every flagship public form carries a hidden
 *     `companyWebsite` field that humans never see and never fill.
 *     A submission with it filled is an automated form-filler: the
 *     routes answer with the SAME success shape a real submission
 *     gets, but persist NOTHING and queue NO notification. (The
 *     owner-notification emails are the pain Ramone named — they
 *     only ever fire for submissions that are actually persisted.)
 *  2. Phone plausibility — register + connections (+ PM bulk): a
 *     supplied phone must normalize to a 10-digit NANP number whose
 *     area code is assigned (services/nanpAreaCodes.js). This kills
 *     the unassigned-code fakes (355…, 691…) at the door with a
 *     plain 400. Deliberately NO name/text heuristics — real names
 *     are too varied to judge safely.
 *  3. Durable per-IP rate limits — fixed hourly windows counted in
 *     the IntakeRateWindow table, so the limit holds across
 *     serverless instances (the middleware/rateLimit.js buckets are
 *     per-instance memory and reset on every cold start). Thresholds
 *     sit far above anything a real customer or office can hit by
 *     hand; a burst of bot submissions trips them in minutes.
 *
 * Failure discipline: if the counter store is unreachable the shield
 * fails OPEN (and logs) — a public form must never die because its
 * spam counter hiccuped, the same rule persistConnection follows.
 * In skeleton mode (no DATABASE_URL) the counter falls back to
 * per-process memory, exactly like the existing limiters; production
 * always runs on the database, so production counting is durable.
 */

export const HONEYPOT_FIELD = 'companyWebsite';

export const INVALID_PHONE_MESSAGE =
  'That phone number does not look like a valid US or Canadian phone number — please check it and try again.';

export const INTAKE_RATE_LIMITS = {
  register: { limit: 10, windowMs: 60 * 60 * 1000 },
  connections: { limit: 10, windowMs: 60 * 60 * 1000 },
  booking: { limit: 10, windowMs: 60 * 60 * 1000 },
  // Forgot-password is tighter: it sends real email, and its route
  // contract is an enumeration-safe generic 200 — when this limit is
  // hit the route quietly skips the send and still answers 200, the
  // same way services/passwordReset.js treats its own limits.
  forgotPassword: { limit: 5, windowMs: 60 * 60 * 1000 },
};

/** True when the hidden honeypot field arrived filled — a bot tell. */
export function honeypotTripped(body) {
  if (!body || typeof body !== 'object') return false;
  const value = body[HONEYPOT_FIELD];
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Normalize a submitted phone to its 10 NANP digits (a leading
 * country-code 1 is dropped) and judge plausibility: exactly 10
 * digits, area code starting 2-9, area code ASSIGNED. Returns
 * { ok: true, digits } or { ok: false }. Nothing about the stored
 * record changes — this is a gate, not a rewrite.
 */
export function validateNanpPhone(raw) {
  if (typeof raw !== 'string') return { ok: false };
  let digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  if (digits.length !== 10) return { ok: false };
  const areaFirst = digits[0];
  if (areaFirst < '2' || areaFirst > '9') return { ok: false };
  if (!ASSIGNED_NANP_AREA_CODES.has(Number(digits.slice(0, 3)))) return { ok: false };
  return { ok: true, digits };
}

// ---------------------------------------------------------------------------
// Durable fixed-window rate counter.
// ---------------------------------------------------------------------------
const memoryWindows = new Map();

export async function consumeIntakeAttempt(family, ip) {
  const config = INTAKE_RATE_LIMITS[family] || INTAKE_RATE_LIMITS.connections;
  const { limit, windowMs } = config;
  const now = Date.now();
  const windowStartMs = Math.floor(now / windowMs) * windowMs;
  const retryAfterSeconds = Math.max(1, Math.ceil((windowStartMs + windowMs - now) / 1000));
  const keyIp = String(ip || 'unknown').slice(0, 64);

  if (DATABASE_ENABLED) {
    try {
      const windowStart = new Date(windowStartMs);
      const row = await db().intakeRateWindow.upsert({
        where: { family_ip_windowStart: { family, ip: keyIp, windowStart } },
        create: { family, ip: keyIp, windowStart, count: 1 },
        update: { count: { increment: 1 } },
      });
      if (row.count === 1) {
        // A fresh window opened for this family+IP: sweep windows
        // older than the previous one. Fire-and-forget — cleanup
        // must never slow or fail an intake request.
        db().intakeRateWindow
          .deleteMany({ where: { windowStart: { lt: new Date(windowStartMs - windowMs) } } })
          .catch(() => {});
      }
      return { allowed: row.count <= limit, count: row.count, limit, retryAfterSeconds };
    } catch (error) {
      console.error(JSON.stringify({
        level: 'error',
        message: 'intake shield counter failed — failing open',
        family,
        error: String(error?.message || error),
      }));
      return { allowed: true, count: 0, limit, retryAfterSeconds };
    }
  }

  // Skeleton mode: per-process memory, the middleware/rateLimit.js
  // pattern. Never the production path (production sets DATABASE_URL).
  const key = `${family}:${keyIp}:${windowStartMs}`;
  const count = (memoryWindows.get(key) || 0) + 1;
  memoryWindows.set(key, count);
  return { allowed: count <= limit, count, limit, retryAfterSeconds };
}
