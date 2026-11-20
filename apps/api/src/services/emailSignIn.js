import { createHash, randomBytes } from 'node:crypto';
import { createId, store } from '../data/store.js';
import { DATABASE_ENABLED, db } from '../db/client.js';
import { notifyEmailSignIn } from './notifications.js';
import { drainEntries } from './senders.js';
import { isMasterAccount } from './speedyVerify.js';

/**
 * Email sign-in link (2026-11-20, Ramone's approved verification
 * method — he rejected tap-to-approve and the access-code pile-up
 * that locked him out of his own system that morning, and chose
 * this door himself: "Email sign-in link — no password").
 *
 * The flow: the holder enters their account email, receives a
 * one-time link, taps it, and is signed in. The discipline mirrors
 * services/passwordReset.js exactly: a random 32-byte token whose
 * SHA-256 hash is all that is stored; the raw token travels only
 * inside the emailed link and is never logged. Tokens live 30
 * minutes, are single-use (atomic claim in database mode), and
 * issuing a new one supersedes every still-unused token for the
 * account.
 *
 * What consuming a link mints: a normal device session through
 * recordSignInSession (routes/auth.js) with the email-link claim
 * (el) and a 30-day lifetime — the trusted-device session from the
 * approved brief. The mailbox IS the verification for this door:
 * the session satisfies the Speedy Verify gate at /auth/me through
 * the el claim, and neither the password, the access code, nor
 * Layer 2 applies to it. Account issuance is unchanged — accounts
 * are still created by the office and approved by the Master only;
 * this door signs in existing accounts, it creates none.
 *
 * Rule Zero (owner access): the Master account is exempt from
 * every rate limit on this door. When the requested email belongs
 * to a Master account (services/speedyVerify.js isMasterAccount —
 * the COMPANY_OWNER role), neither the per-IP bucket nor the
 * per-account send cap applies, so the owner can never be locked
 * out of his own system by requesting links. Every other account
 * keeps the reset flow's limits: at most 5 link emails per account
 * per hour and at most 20 requests per IP per hour.
 *
 * Privacy / enumeration: POST /auth/email-sign-in/request answers
 * with the same generic 200 whether the account exists or not,
 * and whether a rate limit quietly stopped the send.
 */
export const EMAIL_SIGN_IN_TTL_MS = 30 * 60 * 1000;
export const EMAIL_SIGN_IN_SESSION_SECONDS = 30 * 24 * 60 * 60;
export const EMAIL_SIGN_IN_GENERIC_MESSAGE = 'If an account with that email exists, a sign-in link is on its way.';
export const EMAIL_SIGN_IN_INVALID_MESSAGE = 'This sign-in link is invalid or has expired';

const RATE_WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_ACCOUNT_PER_HOUR = 5;
const MAX_PER_IP_PER_HOUR = 20;

const webOrigin = () => process.env.WEB_ORIGIN || 'https://topspeedserviceos.com';

function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

/**
 * The only paths an emailed link may forward to after sign-in:
 * same-origin console paths the caller names (e.g. /applianceman).
 * Anything else — absolute URLs, protocol-relative //host, backslash
 * tricks — is dropped, and the sign-in page lands on its default.
 */
export function sanitizeNextPath(next) {
  if (typeof next !== 'string') return null;
  const value = next.trim();
  if (!value || value.length > 120) return null;
  if (!value.startsWith('/') || value.startsWith('//')) return null;
  if (value.includes('\\') || /\s/.test(value)) return null;
  return value;
}

function signInUrl(rawToken, next) {
  const params = new URLSearchParams();
  params.set('token', rawToken);
  if (next) params.set('next', next);
  return `${webOrigin()}/sign-in?${params.toString()}`;
}

function fail(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  throw error;
}

// ---------------------------------------------------------------------------
// Per-IP request buckets (middleware/rateLimit.js pattern).
// ---------------------------------------------------------------------------
const ipBuckets = new Map();

function ipLimitReached(ip) {
  if (!ip) return false;
  const bucket = ipBuckets.get(ip);
  if (!bucket || bucket.resetAt <= Date.now()) return false;
  return bucket.count >= MAX_PER_IP_PER_HOUR;
}

function recordIpRequest(ip) {
  if (!ip) return;
  const now = Date.now();
  const bucket = ipBuckets.get(ip);
  if (!bucket || bucket.resetAt <= now) {
    ipBuckets.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return;
  }
  bucket.count += 1;
}

// ---------------------------------------------------------------------------
// Account lookup + per-account hourly issuance count. Both storage
// modes, the dual pattern the other auth services use.
// ---------------------------------------------------------------------------
async function findAccountsByEmail(email) {
  if (DATABASE_ENABLED) {
    return db().user.findMany({ where: { email } });
  }
  return [...store.users.values()].filter((user) => user.email === email);
}

async function recentIssuanceCount(userId) {
  const since = new Date(Date.now() - RATE_WINDOW_MS);
  if (DATABASE_ENABLED) {
    return db().emailSignInToken.count({ where: { userId, createdAt: { gt: since } } });
  }
  let count = 0;
  for (const record of store.emailSignInTokens.values()) {
    if (record.userId === userId && new Date(record.createdAt).getTime() > since.getTime()) count += 1;
  }
  return count;
}

async function supersedeOutstanding(userId) {
  if (DATABASE_ENABLED) {
    await db().emailSignInToken.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt: new Date() },
    });
    return;
  }
  for (const [key, record] of store.emailSignInTokens.entries()) {
    if (record.userId === userId && !record.usedAt) {
      record.usedAt = new Date().toISOString();
      store.emailSignInTokens.set(key, record);
    }
  }
}

/**
 * Handle one sign-in link request. Never throws for unknown emails
 * or rate limits — the route's generic 200 must be identical in
 * every case. Returns { accountsMatched, emailsQueued } for
 * internal observability only; the route never exposes it.
 */
export async function requestEmailSignIn({ email, ip, source = null, next = null }) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return { accountsMatched: 0, emailsQueued: 0 };

  const accounts = (await findAccountsByEmail(normalized)).filter((user) => user && user.active !== false);
  // Rule Zero: a request for the Master's own email bypasses the
  // IP bucket entirely — his retries can never wall him out.
  const masterRequest = accounts.some((user) => isMasterAccount(user));
  if (!masterRequest) {
    if (ipLimitReached(ip)) return { accountsMatched: 0, emailsQueued: 0 };
    recordIpRequest(ip);
  }

  const nextPath = sanitizeNextPath(next);
  let emailsQueued = 0;
  const signInEntries = [];
  for (const user of accounts) {
    // The per-account send cap binds every account except the
    // Master's (Rule Zero, above).
    if (!isMasterAccount(user) && (await recentIssuanceCount(user.id)) >= MAX_PER_ACCOUNT_PER_HOUR) continue;
    const token = randomBytes(32).toString('base64url');
    const record = {
      id: createId(),
      tokenHash: hashToken(token),
      userId: user.id,
      expiresAt: new Date(Date.now() + EMAIL_SIGN_IN_TTL_MS),
      usedAt: null,
      createdAt: new Date(),
    };
    // One live token per account: supersede any still-unused ones.
    await supersedeOutstanding(user.id);
    if (DATABASE_ENABLED) {
      await db().emailSignInToken.create({
        data: {
          id: record.id, tokenHash: record.tokenHash, userId: record.userId,
          expiresAt: record.expiresAt,
        },
      });
    } else {
      store.emailSignInTokens.set(record.tokenHash, {
        ...record,
        expiresAt: record.expiresAt.toISOString(),
        createdAt: record.createdAt.toISOString(),
        usedAt: null,
      });
    }
    // The raw token leaves the server only inside this email's link.
    const entries = notifyEmailSignIn(
      user,
      { tokenId: record.id, signInUrl: signInUrl(token, nextPath), expiresAt: record.expiresAt.toISOString() },
      source,
    );
    if (entries.length) emailsQueued += 1;
    signInEntries.push(...entries);
  }
  // A sign-in link is worthless if the email never leaves. The
  // outbox's opportunistic drain is fire-and-forget and can die
  // with the HTTP response on serverless (the password-reset
  // lesson, 2026-11-18), so deliver this batch NOW, awaited,
  // inside the request lifecycle. drainEntries only attempts
  // QUEUED entries — a settings-GATED entry stays gated — and the
  // opportunistic pass that queueing also scheduled finds these
  // entries already settled, so nothing sends twice. A drain
  // failure is recorded on the entries themselves and logged here;
  // it must never change the route's generic answer, so it is not
  // thrown.
  if (signInEntries.length) {
    await drainEntries(signInEntries).catch((error) => {
      console.error(JSON.stringify({ level: 'error', message: 'email sign-in drain failed', error: String(error?.message || error) }));
    });
  }
  return { accountsMatched: accounts.length, emailsQueued };
}

/**
 * Exchange a raw sign-in token for its account. Every failure —
 * unknown token, already used, expired, inactive account — throws
 * the SAME generic 400 so the endpoint never confirms which case
 * it was. On success the token is consumed (atomically in database
 * mode), the account's other outstanding links die, and the route
 * mints the session. No password, access code, or Layer 2 step is
 * involved on this door — the mailbox was the verification.
 */
export async function consumeEmailSignIn(token) {
  const tokenHash = hashToken(token || '');
  let record = null;
  if (DATABASE_ENABLED) {
    record = await db().emailSignInToken.findUnique({ where: { tokenHash } });
  } else {
    record = store.emailSignInTokens.get(tokenHash) || null;
  }
  if (!record) fail(400, 'EMAIL_SIGN_IN_INVALID', EMAIL_SIGN_IN_INVALID_MESSAGE);
  if (record.usedAt) fail(400, 'EMAIL_SIGN_IN_INVALID', EMAIL_SIGN_IN_INVALID_MESSAGE);
  if (new Date(record.expiresAt).getTime() <= Date.now()) fail(400, 'EMAIL_SIGN_IN_INVALID', EMAIL_SIGN_IN_INVALID_MESSAGE);

  const now = new Date();
  if (DATABASE_ENABLED) {
    // Atomic claim: exactly one concurrent exchange can win.
    const claimed = await db().emailSignInToken.updateMany({
      where: { id: record.id, usedAt: null },
      data: { usedAt: now },
    });
    if (!claimed.count) fail(400, 'EMAIL_SIGN_IN_INVALID', EMAIL_SIGN_IN_INVALID_MESSAGE);
  } else {
    record.usedAt = now.toISOString();
    store.emailSignInTokens.set(tokenHash, record);
  }

  let user = null;
  if (DATABASE_ENABLED) {
    user = await db().user.findUnique({ where: { id: record.userId } });
  } else {
    user = store.users.get(record.userId) || null;
  }
  if (!user || user.active === false) fail(400, 'EMAIL_SIGN_IN_INVALID', EMAIL_SIGN_IN_INVALID_MESSAGE);

  // Any other outstanding sign-in links for this account die too.
  await supersedeOutstanding(user.id);
  return { user };
}
