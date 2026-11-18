import { createHash, randomBytes } from 'node:crypto';
import { createId, store } from '../data/store.js';
import { DATABASE_ENABLED, db } from '../db/client.js';
import { hashPassword } from './passwords.js';
import { notifyPasswordReset } from './notifications.js';
import { drainEntries } from './senders.js';

/**
 * Password reset (2026-11-18, Ramone's directive: the Master changes
 * his own password privately — "a reset prompt to my email to reset
 * password in privacy"). Built as the platform's general
 * forgot-password flow for every account.
 *
 * The discipline mirrors services/emailVerification.js exactly: a
 * random 32-byte token whose SHA-256 hash is all that is stored; the
 * raw token travels only inside the emailed link and is never logged.
 * Tokens live 30 minutes, are single-use (atomic claim in database
 * mode), and issuing a new one supersedes every still-unused token
 * for the account.
 *
 * Privacy / enumeration: POST /auth/forgot-password answers with the
 * same generic 200 whether the account exists or not, and whether a
 * rate limit quietly stopped the send. Rate limits: at most 5 reset
 * emails per account per hour (counted on issued tokens, database or
 * store) and at most 20 requests per IP per hour (in-memory buckets,
 * the middleware/rateLimit.js pattern — a serverless cold start
 * resets the IP buckets, never the per-account count).
 *
 * A completed reset replaces the password hash (the platform scrypt,
 * services/passwords), marks the token used, kills the account's
 * other outstanding reset tokens, and clears any temporary-password
 * state (the 2026-11-17 temp credential, its forced-change flag and
 * its lockout counters) — the same field set
 * services/tempPasswords.completePasswordChange clears. No session
 * is issued by the reset: the holder signs in fresh through the
 * normal pipeline (Speedy Verify / Layer 2 included) afterwards.
 */
export const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;
export const PASSWORD_RESET_GENERIC_MESSAGE = 'If an account with that email exists, a password reset email is on its way.';
export const PASSWORD_RESET_INVALID_MESSAGE = 'This reset link is invalid or has expired';

const RATE_WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_ACCOUNT_PER_HOUR = 5;
const MAX_PER_IP_PER_HOUR = 20;

const webOrigin = () => process.env.WEB_ORIGIN || 'https://topspeedserviceos.com';

function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

function resetUrl(token) {
  return `${webOrigin()}/reset-password?token=${encodeURIComponent(token)}`;
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
    return db().passwordResetToken.count({ where: { userId, createdAt: { gt: since } } });
  }
  let count = 0;
  for (const record of store.passwordResetTokens.values()) {
    if (record.userId === userId && new Date(record.createdAt).getTime() > since.getTime()) count += 1;
  }
  return count;
}

async function supersedeOutstanding(userId) {
  if (DATABASE_ENABLED) {
    await db().passwordResetToken.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt: new Date() },
    });
    return;
  }
  for (const [key, record] of store.passwordResetTokens.entries()) {
    if (record.userId === userId && !record.usedAt) {
      record.usedAt = new Date().toISOString();
      store.passwordResetTokens.set(key, record);
    }
  }
}

/**
 * Handle one forgot-password request. Never throws for unknown
 * emails or rate limits — the route's generic 200 must be identical
 * in every case. Returns { accountsMatched, emailsQueued } for
 * internal observability only; the route never exposes it.
 */
export async function requestPasswordReset({ email, ip, source = null }) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return { accountsMatched: 0, emailsQueued: 0 };
  if (ipLimitReached(ip)) return { accountsMatched: 0, emailsQueued: 0 };
  recordIpRequest(ip);

  const accounts = (await findAccountsByEmail(normalized)).filter((user) => user && user.active !== false);
  let emailsQueued = 0;
  const resetEntries = [];
  for (const user of accounts) {
    if ((await recentIssuanceCount(user.id)) >= MAX_PER_ACCOUNT_PER_HOUR) continue;
    const token = randomBytes(32).toString('base64url');
    const record = {
      id: createId(),
      tokenHash: hashToken(token),
      userId: user.id,
      expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
      usedAt: null,
      createdAt: new Date(),
    };
    // One live token per account: supersede any still-unused ones.
    await supersedeOutstanding(user.id);
    if (DATABASE_ENABLED) {
      await db().passwordResetToken.create({
        data: {
          id: record.id, tokenHash: record.tokenHash, userId: record.userId,
          expiresAt: record.expiresAt,
        },
      });
    } else {
      store.passwordResetTokens.set(record.tokenHash, {
        ...record,
        expiresAt: record.expiresAt.toISOString(),
        createdAt: record.createdAt.toISOString(),
        usedAt: null,
      });
    }
    // The raw token leaves the server only inside this email's link.
    const entries = notifyPasswordReset(
      user,
      { tokenId: record.id, resetUrl: resetUrl(token), expiresAt: record.expiresAt.toISOString() },
      source,
    );
    if (entries.length) emailsQueued += 1;
    resetEntries.push(...entries);
  }
  // A reset link is worthless if the email never leaves. The outbox's
  // opportunistic drain is fire-and-forget and can die with the HTTP
  // response on serverless (it stranded this flow's first production
  // emails as QUEUED on 2026-11-18), so deliver this batch NOW,
  // awaited, inside the request lifecycle. drainEntries only attempts
  // QUEUED entries — a settings-GATED entry stays gated — and the
  // opportunistic pass that queueing also scheduled finds these
  // entries already settled, so nothing sends twice. A drain failure
  // is recorded on the entries themselves and logged here; it must
  // never change the route's generic answer, so it is not thrown.
  if (resetEntries.length) {
    await drainEntries(resetEntries).catch((error) => {
      console.error(JSON.stringify({ level: 'error', message: 'password reset drain failed', error: String(error?.message || error) }));
    });
  }
  return { accountsMatched: accounts.length, emailsQueued };
}

/**
 * Exchange a raw reset token + a new password for a changed account.
 * Every failure — unknown token, already used, expired — throws the
 * SAME generic 400 so the endpoint never confirms which case it was.
 * On success: password replaced, token consumed, the account's other
 * outstanding tokens killed, temporary-password state cleared. No
 * session is created here.
 */
export async function consumePasswordReset(token, newPassword) {
  const tokenHash = hashToken(token || '');
  let record = null;
  if (DATABASE_ENABLED) {
    record = await db().passwordResetToken.findUnique({ where: { tokenHash } });
  } else {
    record = store.passwordResetTokens.get(tokenHash) || null;
  }
  if (!record) fail(400, 'PASSWORD_RESET_INVALID', PASSWORD_RESET_INVALID_MESSAGE);
  if (record.usedAt) fail(400, 'PASSWORD_RESET_INVALID', PASSWORD_RESET_INVALID_MESSAGE);
  if (new Date(record.expiresAt).getTime() <= Date.now()) fail(400, 'PASSWORD_RESET_INVALID', PASSWORD_RESET_INVALID_MESSAGE);

  const passwordHash = await hashPassword(newPassword);
  const now = new Date();
  // The temporary-password state a completed reset clears — the same
  // field set completePasswordChange clears in services/tempPasswords.
  const clearedTempState = {
    tempPasswordHash: null,
    tempPasswordExpiresAt: null,
    mustChangePassword: false,
    tempFailedAttempts: 0,
    tempLockedUntil: null,
    tempChangeJti: null,
    passwordChangedAt: now,
  };

  if (DATABASE_ENABLED) {
    // Atomic claim: exactly one concurrent exchange can win.
    const claimed = await db().passwordResetToken.updateMany({
      where: { id: record.id, usedAt: null },
      data: { usedAt: now },
    });
    if (!claimed.count) fail(400, 'PASSWORD_RESET_INVALID', PASSWORD_RESET_INVALID_MESSAGE);
    const user = await db().user.update({
      where: { id: record.userId },
      data: { passwordHash, ...clearedTempState },
    });
    // Any other outstanding reset links for this account die too.
    await db().passwordResetToken.updateMany({
      where: { userId: record.userId, usedAt: null },
      data: { usedAt: now },
    });
    return user;
  }

  record.usedAt = now.toISOString();
  store.passwordResetTokens.set(tokenHash, record);
  const user = store.users.get(record.userId);
  if (!user) fail(400, 'PASSWORD_RESET_INVALID', PASSWORD_RESET_INVALID_MESSAGE);
  Object.assign(user, {
    passwordHash,
    tempPasswordHash: null,
    tempPasswordExpiresAt: null,
    mustChangePassword: false,
    tempFailedAttempts: 0,
    tempLockedUntil: null,
    tempChangeJti: null,
    passwordChangedAt: now.toISOString(),
    updatedAt: now.toISOString(),
  });
  store.users.set(user.id, user);
  for (const [key, other] of store.passwordResetTokens.entries()) {
    if (other.userId === user.id && !other.usedAt) {
      other.usedAt = now.toISOString();
      store.passwordResetTokens.set(key, other);
    }
  }
  return user;
}
