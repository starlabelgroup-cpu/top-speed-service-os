import { createHash, randomBytes } from 'node:crypto';
import { createId, store } from '../data/store.js';
import { DATABASE_ENABLED, db } from '../db/client.js';

/**
 * Multi-account cross-host session handoffs (2026-11-17).
 *
 * A holder of a FINAL session (every applicable sign-in gate already
 * passed — the minting route sits behind `authenticate`, which refuses
 * Speedy Verify / Layer 2 challenge tokens) mints a one-time code and
 * lands on another platform host already signed in as the SAME account.
 * This is how an account holder moves between topspeedserviceos.com,
 * appliance-connect.vercel.app and the other platform domains without
 * signing in again, while each browser keeps every account's session
 * separate in its local vault.
 *
 * Discipline, mirroring services/handoff.js: codes are random 32-byte
 * secrets; only their SHA-256 hash is stored; single-use (atomic
 * claim); 60-second lifetime. The record also carries the minting
 * session's Speedy Verify state (`sv`) so the redeemed session is
 * minted with identical claims — /auth/me requires sv: true for
 * verify-activated accounts.
 *
 * Redemption failures are deliberately uniform: unknown, expired and
 * already-used codes all surface as the same 401, so the endpoint
 * never reveals which case a guessed code hit.
 */

export const SESSION_HANDOFF_TTL_MS = 60 * 1000;
export const SESSION_HANDOFF_TTL_SECONDS = Math.floor(SESSION_HANDOFF_TTL_MS / 1000);

// Minting is rate-limited per user (the route is also behind the
// shared /api/v1/auth IP limiter): at most 10 codes per minute.
const MINT_LIMIT = 10;
const MINT_WINDOW_MS = 60 * 1000;
const mintLog = new Map(); // userId -> number[] (epoch ms)

function hashCode(code) {
  return createHash('sha256').update(String(code)).digest('hex');
}

function invalidCodeError() {
  const error = new Error('That sign-in link is invalid or has expired. Sign in with your email and password instead.');
  error.status = 401;
  error.code = 'SESSION_HANDOFF_INVALID';
  return error;
}

export async function createSessionHandoff(userId, { sv = false } = {}) {
  const now = Date.now();
  const recent = (mintLog.get(userId) || []).filter((t) => now - t < MINT_WINDOW_MS);
  if (recent.length >= MINT_LIMIT) {
    const error = new Error('Too many sign-in links minted — wait a minute and try again.');
    error.status = 429;
    error.code = 'SESSION_HANDOFF_RATE_LIMITED';
    throw error;
  }
  recent.push(now);
  mintLog.set(userId, recent);

  const code = randomBytes(32).toString('base64url');
  const record = {
    id: createId(),
    codeHash: hashCode(code),
    userId,
    sv: sv === true,
    expiresAt: new Date(now + SESSION_HANDOFF_TTL_MS),
    usedAt: null,
    createdAt: new Date(now),
  };
  if (DATABASE_ENABLED) {
    await db().sessionHandoff.create({
      data: {
        id: record.id, codeHash: record.codeHash, userId: record.userId,
        sv: record.sv, expiresAt: record.expiresAt,
      },
    });
  } else {
    store.sessionHandoffs.set(record.codeHash, {
      ...record, expiresAt: record.expiresAt.toISOString(), createdAt: record.createdAt.toISOString(), usedAt: null,
    });
  }
  return { code, expiresInSec: SESSION_HANDOFF_TTL_SECONDS, expiresAt: record.expiresAt.toISOString() };
}

export async function redeemSessionHandoff(code) {
  const codeHash = hashCode(code || '');
  let record = null;
  if (DATABASE_ENABLED) {
    record = await db().sessionHandoff.findUnique({ where: { codeHash } });
  } else {
    record = store.sessionHandoffs.get(codeHash) || null;
  }
  if (!record) throw invalidCodeError();
  if (record.usedAt) throw invalidCodeError();
  if (new Date(record.expiresAt).getTime() <= Date.now()) throw invalidCodeError();
  if (DATABASE_ENABLED) {
    // Atomic single-use claim: only the first redemption wins.
    const claimed = await db().sessionHandoff.updateMany({
      where: { id: record.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (!claimed.count) throw invalidCodeError();
  } else {
    record.usedAt = new Date().toISOString();
    store.sessionHandoffs.set(codeHash, record);
  }
  return { userId: record.userId, sv: record.sv === true };
}
