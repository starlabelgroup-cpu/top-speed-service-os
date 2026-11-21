import { createHmac, timingSafeEqual } from 'node:crypto';
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
  // Media OS creator applications (POST /creator/signup, 2026-11-19):
  // same posture as register — a public account-creating door gets
  // the hourly per-IP cap plus the honeypot + NANP phone checks.
  creatorSignup: { limit: 10, windowMs: 60 * 60 * 1000 },
  // Username (email) change requests (POST /auth/email-change/request,
  // 2026-11-20): an authenticated door that sends real email to a
  // NEW address, so it gets the same hourly per-IP cap as register.
  // Enforced inside the handler via consumeIntakeAttempt (the route
  // requires a session, so the anonymous-skip middleware does not
  // apply); on limit the route answers 429 RATE_LIMITED.
  emailChange: { limit: 10, windowMs: 60 * 60 * 1000 },
  // Estimate approval links (GET /estimate-approval + POST
  // /estimate-approval/decide, 2026-11-20): a public token door — the
  // token is a 32-byte secret, so this cap is a guessing brake, sized
  // for a customer on a phone (page loads, a retry or two, the
  // decision) rather than an intake form.
  estimateApproval: { limit: 60, windowMs: 60 * 60 * 1000 },
  // Pepper Lists buyer–seller messaging (2026-11-20, C18): signed-in
  // message sends are consumed per ACCOUNT via consumeIntakeAttempt
  // in routes/pepperListsGrowth.js (the intake middleware skips
  // authenticated requests, so the cap is enforced in-handler). A
  // generous hourly cap: real conversation is fine, floods are not.
  pepperListsMessage: { limit: 30, windowMs: 60 * 60 * 1000 },
  // Customer feedback (POST /feedback, 2026-11-20): the review
  // funnel's private "tell the office first" door — a public form
  // that files to the staff report queue, so it gets the same hourly
  // per-IP cap plus the honeypot as the other public doors.
  feedback: { limit: 10, windowMs: 60 * 60 * 1000 },
  // Pepper Lists Trust & Growth (2026-11-20): signed-in listing
  // actions (comments, listing reports) are consumed per ACCOUNT via
  // consumeIntakeAttempt in routes/pepperListsTrust.js — the intake
  // middleware skips authenticated requests, so the cap is enforced
  // in-handler. A generous hourly cap: real conversation is fine,
  // scripted spam is not.
  listingActions: { limit: 30, windowMs: 60 * 60 * 1000 },
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

// ---------------------------------------------------------------------------
// Intake Shield Phase 2 (2026-11-20, Ramone's directive after the
// morning's slow-single fake signups — "Xdaurllj" / haydn_philipp@
// web.de, "Pruihue" / a heavily dotted gmail, two more — slipped the
// Phase 1 layers: one at a time, valid-format NANP phones, honeypot
// left empty). Three ADDITIVE layers on the account-creation doors
// (POST /auth/register, POST /connections, POST /creator/signup,
// POST /auth/ad-specialist/apply). Every discard uses honeypot
// semantics: the route answers with the SAME success shape a real
// submission gets, persists NOTHING, and queues NO notification.
//
//  4. Form-timing token — GET /auth/form-token issues a short-lived
//     HMAC-signed token when a public form renders; the wired forms
//     attach it on submit. A submission whose token is FORGED or
//     EXPIRED (> 2h) or returns INHUMANLY FAST (< 3s from issuance)
//     is discarded on that ground alone — a direct-API bot that
//     never renders the form, or fires the instant it fetches one,
//     cannot pass. A MISSING token never hard-blocks on its own
//     (older cached forms and not-yet-updated satellite pages must
//     not lock out real customers); it is scored with layer 5.
//  5. Gibberish scoring — tight, documented signal set (below). One
//     weak signal alone NEVER blocks a submission that carries a
//     valid token; two or more discard even then. With a missing
//     token, one or more signals discard. Real names are too varied
//     to judge from any single quirk — the thresholds are set so
//     ordinary international names and ordinary email habits score
//     ZERO (drilled: "Haydn Philipp", "Giuseppe Szczepan",
//     john.smith1985@gmail.com all score 0).
//  6. Cloudflare Turnstile — enforced ONLY when TURNSTILE_SECRET_KEY
//     is set in the API environment; until then the layer is inert
//     and layers 4+5 carry. When configured, the wired forms render
//     the widget (site key served by GET /auth/form-token from
//     TURNSTILE_SITE_KEY) and a missing or failed Turnstile token
//     discards. A siteverify TRANSPORT error fails OPEN with an
//     error log — the Phase 1 rule: a public form must never die
//     because a protection service hiccuped.
//     CREDENTIAL errors are NOT bot signals (2026-11-21, Ramone's
//     approval-free customer signup directive): when siteverify
//     answers success:false with a secret-side error code
//     (invalid-input-secret / missing-input-secret), Cloudflare is
//     rejecting OUR stored secret, not the visitor's token — the
//     2026-11-20 key entry put a wrong secret in the API env, and
//     every genuine signup was silently discarded as a bot while
//     the widget itself showed "Success!". That failure is logged
//     distinctly (level error) and the submission rides the scored
//     layers 4+5 exactly like a transport failure — it is never
//     discarded on Turnstile grounds. A token-side failure
//     (invalid-input-response and friends) keeps the discard.
//
// Signal set (layer 5) — evaluated on the name fields and the email
// local part of the submission:
//   name-no-vowels        a name word of 5+ letters with no a/e/i/o/u
//   name-consonant-cluster a run of 5+ consecutive consonants in a
//                         name word (real German/Polish surnames top
//                         out at 4 — "Schwartz", "Szczepan" — so 5 is
//                         the false-positive-safe line)
//   name-case-mash        3+ interior upper/lower case transitions
//                         in one name word ("xDaUrLlJ" style)
//   email-heavily-dotted  4+ dots in the email local part
//   email-digit-stuffed   digits in 2+ dot-separated segments of a
//                         local part with 3+ dots (awe.so.m…den2.5);
//                         a birth-year suffix (john.smith1985) is ONE
//                         segment and scores nothing
// Name≈email similarity is deliberately NOT a signal — people do
// that. Free-mail domains are NOT a signal — most real customers
// use one.
// ---------------------------------------------------------------------------

export const FORM_TOKEN_FIELD = 'formToken';
export const TURNSTILE_TOKEN_FIELD = 'turnstileToken';
export const FORM_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
export const FORM_TOKEN_MIN_AGE_MS = 3000;
const FORM_TOKEN_PURPOSE = 'intake-form';
const TURNSTILE_DEFAULT_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

function formTokenSecret() {
  return process.env.INTAKE_SHIELD_SECRET || process.env.JWT_SECRET || null;
}

function signFormPayload(payloadPart) {
  return createHmac('sha256', formTokenSecret()).update(payloadPart).digest('base64url');
}

/**
 * Issue a form-timing token. Returns null when no signing secret is
 * configured (the endpoint then serves formToken: null and the token
 * layer scores exactly like a missing token — fail-soft, Phase 1
 * discipline). `issuedAtMs` exists for drills; production callers
 * pass nothing.
 */
export function issueFormToken({ issuedAtMs } = {}) {
  if (!formTokenSecret()) return null;
  const payload = { p: FORM_TOKEN_PURPOSE, iat: Number.isFinite(issuedAtMs) ? issuedAtMs : Date.now() };
  const payloadPart = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${payloadPart}.${signFormPayload(payloadPart)}`;
}

/**
 * Judge a submitted form token:
 *   'missing'     no token arrived
 *   'unavailable' no signing secret configured (scores as missing)
 *   'forged'      malformed, wrong purpose, bad signature, or an
 *                 issued-at implausibly in the future
 *   'expired'     older than FORM_TOKEN_TTL_MS
 *   'too-fast'    younger than FORM_TOKEN_MIN_AGE_MS
 *   'ok'          signed, in window, human-paced
 */
export function inspectFormToken(token, nowMs = Date.now()) {
  if (typeof token !== 'string' || token.trim().length === 0) return 'missing';
  if (!formTokenSecret()) return 'unavailable';
  const parts = token.split('.');
  if (parts.length !== 2) return 'forged';
  const [payloadPart, signature] = parts;
  const expected = signFormPayload(payloadPart);
  const givenBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  if (givenBuf.length !== expectedBuf.length || !timingSafeEqual(givenBuf, expectedBuf)) return 'forged';
  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
  } catch {
    return 'forged';
  }
  if (!payload || payload.p !== FORM_TOKEN_PURPOSE || !Number.isFinite(payload.iat)) return 'forged';
  const ageMs = nowMs - payload.iat;
  if (ageMs < -60 * 1000) return 'forged';
  if (ageMs > FORM_TOKEN_TTL_MS) return 'expired';
  if (ageMs < FORM_TOKEN_MIN_AGE_MS) return 'too-fast';
  return 'ok';
}

function stripDiacritics(value) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function nameSignals(name) {
  const signals = new Set();
  for (const word of String(name || '').split(/\s+/)) {
    const letters = stripDiacritics(word).replace(/[^A-Za-z]/g, '');
    if (letters.length < 5) continue;
    if (!/[aeiouAEIOU]/.test(letters)) signals.add('name-no-vowels');
    let run = 0;
    let maxRun = 0;
    for (const ch of letters.toLowerCase()) {
      if ('aeiou'.includes(ch)) run = 0;
      else { run += 1; if (run > maxRun) maxRun = run; }
    }
    if (maxRun >= 5) signals.add('name-consonant-cluster');
    let transitions = 0;
    for (let i = 2; i < letters.length; i += 1) {
      const prevUp = letters[i - 1] >= 'A' && letters[i - 1] <= 'Z';
      const curUp = letters[i] >= 'A' && letters[i] <= 'Z';
      if (prevUp !== curUp) transitions += 1;
    }
    if (transitions >= 3) signals.add('name-case-mash');
  }
  return signals;
}

function emailSignals(email) {
  const signals = new Set();
  const local = String(email || '').split('@')[0] || '';
  const dotCount = (local.match(/\./g) || []).length;
  if (dotCount >= 4) signals.add('email-heavily-dotted');
  const segments = local.split('.');
  if (segments.length >= 4 && segments.filter((s) => /\d/.test(s)).length >= 2) {
    signals.add('email-digit-stuffed');
  }
  return signals;
}

/** The layer-5 signal list for a submission (names + email). */
export function gibberishSignals({ names = [], email = null } = {}) {
  const signals = new Set();
  for (const name of names) for (const s of nameSignals(name)) signals.add(s);
  if (email) for (const s of emailSignals(email)) signals.add(s);
  return [...signals];
}

export function turnstileConfigured() {
  return Boolean(process.env.TURNSTILE_SECRET_KEY);
}

export function turnstileSiteKey() {
  return process.env.TURNSTILE_SITE_KEY || null;
}

/**
 * Verify a Turnstile token with Cloudflare's siteverify. Inert
 * ({ enforced: false, ok: true }) until TURNSTILE_SECRET_KEY exists.
 * TURNSTILE_SITEVERIFY_URL overrides the endpoint (drills point it
 * at a local mock — production leaves it unset). A transport error
 * fails OPEN with an error log (Phase 1 discipline); an answered
 * success:false or a missing token does not pass. One exception: a
 * success:false whose error codes blame the SECRET
 * (invalid-input-secret / missing-input-secret) is a server-side
 * credential problem, not a bot verdict — it returns
 * credentialError: true (and logs at error level) so the caller can
 * fail soft instead of eating genuine signups.
 */
export async function verifyTurnstileToken(token, remoteIp) {
  if (!turnstileConfigured()) return { enforced: false, ok: true };
  if (typeof token !== 'string' || token.trim().length === 0) return { enforced: true, ok: false };
  const url = process.env.TURNSTILE_SITEVERIFY_URL || TURNSTILE_DEFAULT_VERIFY_URL;
  try {
    const form = new URLSearchParams({
      secret: process.env.TURNSTILE_SECRET_KEY,
      response: token,
      ...(remoteIp ? { remoteip: String(remoteIp) } : {}),
    });
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: AbortSignal.timeout(5000),
    });
    const data = await response.json().catch(() => null);
    if (data?.success === true) return { enforced: true, ok: true };
    const errorCodes = Array.isArray(data?.['error-codes']) ? data['error-codes'] : [];
    if (errorCodes.includes('invalid-input-secret') || errorCodes.includes('missing-input-secret')) {
      console.error(JSON.stringify({
        level: 'error',
        message: 'turnstile siteverify rejected the server secret — TURNSTILE_SECRET_KEY does not match the widget; failing soft so genuine signups are not discarded',
        errorCodes,
      }));
      return { enforced: true, ok: false, credentialError: true, errorCodes };
    }
    return { enforced: true, ok: false, errorCodes };
  } catch (error) {
    console.error(JSON.stringify({
      level: 'error',
      message: 'turnstile siteverify unreachable — failing open',
      error: String(error?.message || error),
    }));
    return { enforced: true, ok: true, transportError: true };
  }
}

/**
 * The Phase 2 verdict for one public-door submission.
 *   token forged / expired / too-fast        → discard
 *   token ok + 2 or more gibberish signals   → discard
 *   token missing/unavailable + 1 or more    → discard
 *   token ok + 0–1 signals                   → pass to Turnstile
 *   token missing + 0 signals                → pass to Turnstile
 *   Turnstile configured + missing/failed    → discard
 *   Turnstile secret rejected by Cloudflare  → NO discard (credential
 *     error: the submission rides the scored verdict above; the
 *     failure is logged at error level inside verifyTurnstileToken)
 * Returns { discard, tokenState, signals, reasons, turnstileCredentialError }.
 */
export async function evaluateFormShield(body, { names = [], email = null, ip = null, door = 'intake', enforceTurnstile = true } = {}) {
  const tokenState = inspectFormToken(body?.[FORM_TOKEN_FIELD]);
  const signals = gibberishSignals({ names, email });
  const reasons = [];
  let discard = false;
  if (tokenState === 'forged' || tokenState === 'expired' || tokenState === 'too-fast') {
    discard = true;
    reasons.push(`form-token-${tokenState}`);
  } else if (tokenState === 'ok') {
    if (signals.length >= 2) { discard = true; reasons.push('gibberish-signals>=2'); }
  } else if (signals.length >= 1) {
    discard = true;
    reasons.push('form-token-missing+gibberish');
  }
  let turnstileCredentialError = false;
  if (!discard && enforceTurnstile) {
    const turnstile = await verifyTurnstileToken(body?.[TURNSTILE_TOKEN_FIELD], ip);
    if (turnstile.credentialError) {
      // Cloudflare rejected OUR secret, not this visitor's token:
      // never discard on Turnstile grounds (see layer 6 above). The
      // scored verdict from layers 4+5 stands as-is.
      turnstileCredentialError = true;
      reasons.push('turnstile-credential-error');
    } else if (turnstile.enforced && !turnstile.ok) { discard = true; reasons.push('turnstile-failed'); }
  }
  if (discard) {
    console.info(JSON.stringify({
      level: 'info', message: 'intake shield phase 2 discard', door, tokenState, signals, reasons,
    }));
  }
  return { discard, tokenState, signals, reasons, turnstileCredentialError };
}
