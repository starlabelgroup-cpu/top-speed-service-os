import { createHash, randomBytes } from 'node:crypto';
import { createId, store } from '../data/store.js';
import { DATABASE_ENABLED, db } from '../db/client.js';
import { notifyEmailVerification } from './notifications.js';

/**
 * Email verification (2026-11-12) — real, single-use, expiring.
 *
 * Every new registration issues a verification token: a random
 * 32-byte secret whose SHA-256 hash is all that is stored (the same
 * discipline as services/handoff.js). The raw token travels only in
 * the emailed link, which points at the flagship /verify-email page;
 * that page exchanges it at POST /auth/verify-email, which marks
 * User.emailVerifiedAt. Tokens live 24 hours, are single-use
 * (atomic claim in database mode), and issuing a new one supersedes
 * every still-unused token for the account (resend = fresh link,
 * old links die).
 *
 * Verification is a SOFT state: an unverified account books, signs
 * in, and uses its app exactly like a verified one — the surfaces
 * show an honest "email not verified yet" prompt with a resend
 * button until the click lands. It is never a lockout.
 */
export const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

const webOrigin = () => process.env.WEB_ORIGIN || 'https://topspeedserviceos.com';

function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

function verifyUrl(token) {
  return `${webOrigin()}/verify-email?token=${encodeURIComponent(token)}`;
}

/**
 * Issue a fresh token for the user and queue the verification email
 * through the notification outbox. Returns { expiresAt, entries } —
 * the raw token never leaves this function except inside the queued
 * email's link. Queueing is best-effort by design (a registration
 * must never fail because an email could not be queued); the outbox
 * entry records the truthful status either way.
 */
export async function issueEmailVerification(user, source = null) {
  const token = randomBytes(32).toString('base64url');
  const record = {
    id: createId(),
    tokenHash: hashToken(token),
    userId: user.id,
    expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS),
    usedAt: null,
    createdAt: new Date(),
  };
  if (DATABASE_ENABLED) {
    // One live token per account: supersede any still-unused ones.
    await db().emailVerificationToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    await db().emailVerificationToken.create({
      data: {
        id: record.id, tokenHash: record.tokenHash, userId: record.userId,
        expiresAt: record.expiresAt,
      },
    });
  } else {
    for (const [key, existing] of store.emailVerificationTokens.entries()) {
      if (existing.userId === user.id && !existing.usedAt) {
        existing.usedAt = new Date().toISOString();
        store.emailVerificationTokens.set(key, existing);
      }
    }
    store.emailVerificationTokens.set(record.tokenHash, {
      ...record,
      expiresAt: record.expiresAt.toISOString(),
      createdAt: record.createdAt.toISOString(),
      usedAt: null,
    });
  }
  const entries = notifyEmailVerification(
    user,
    { tokenId: record.id, verifyUrl: verifyUrl(token), expiresAt: record.expiresAt.toISOString() },
    source,
  );
  return { expiresAt: record.expiresAt.toISOString(), entries };
}

/**
 * Exchange a raw token for a verified account. Throws an
 * error with .status/.code on any failure (same contract as
 * consumeHandoff). On success returns the updated user row.
 */
export async function consumeEmailVerification(token) {
  const tokenHash = hashToken(token || '');
  let record = null;
  if (DATABASE_ENABLED) {
    record = await db().emailVerificationToken.findUnique({ where: { tokenHash } });
  } else {
    record = store.emailVerificationTokens.get(tokenHash) || null;
  }
  const fail = (status, code, message) => {
    const error = new Error(message);
    error.status = status;
    error.code = code;
    throw error;
  };
  if (!record) fail(404, 'VERIFICATION_NOT_FOUND', 'That verification link was not found. Sign in and use the resend button in your account to get a fresh one.');
  if (record.usedAt) fail(410, 'VERIFICATION_USED', 'That verification link was already used or replaced by a newer one. Sign in and use the resend button in your account if you still need one.');
  if (new Date(record.expiresAt).getTime() <= Date.now()) fail(410, 'VERIFICATION_EXPIRED', 'That verification link has expired. Sign in and use the resend button in your account to get a fresh one.');
  if (DATABASE_ENABLED) {
    const claimed = await db().emailVerificationToken.updateMany({
      where: { id: record.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (!claimed.count) fail(410, 'VERIFICATION_USED', 'That verification link was already used or replaced by a newer one. Sign in and use the resend button in your account if you still need one.');
    const user = await db().user.update({
      where: { id: record.userId },
      data: { emailVerifiedAt: new Date() },
    });
    return user;
  }
  record.usedAt = new Date().toISOString();
  store.emailVerificationTokens.set(tokenHash, record);
  const user = store.users.get(record.userId);
  if (!user) fail(404, 'VERIFICATION_USER_MISSING', 'That verification link points at an account that no longer exists.');
  user.emailVerifiedAt = new Date().toISOString();
  user.updatedAt = new Date().toISOString();
  store.users.set(user.id, user);
  return user;
}

/** 'verified' | 'pending' for a user row, as surfaces display it. */
export function emailVerificationState(user) {
  return user?.emailVerifiedAt ? 'verified' : 'pending';
}
