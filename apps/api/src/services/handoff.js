import { createHash, randomBytes } from 'node:crypto';
import { createId, store } from '../data/store.js';
import { DATABASE_ENABLED, db } from '../db/client.js';

/**
 * Super Apps sign-in handoff — one account across every surface.
 *
 * A customer signed in on one surface (the flagship, the customer app,
 * Connect Pro, Appliance Pro) mints a one-time token for a target
 * surface ("audience") and lands there already signed in. Tokens are
 * random 32-byte secrets; only their SHA-256 hash is stored. They are
 * single-use, bound to one audience, and expire after five minutes.
 *
 * The same primitive backs the emailed sign-in link a topspeedappliance
 * .net booking customer can claim: the link carries a handoff token for
 * the Connect Pro audience, minted only after the booking reference +
 * phone check the public tracker already uses.
 */
export const HANDOFF_AUDIENCES = ['connect-pro', 'appliance-pro', 'customer-app', 'flagship'];
export const HANDOFF_TTL_MS = 5 * 60 * 1000;

function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

export async function createHandoff(userId, audience) {
  if (!HANDOFF_AUDIENCES.includes(audience)) {
    const error = new Error(`Unknown handoff audience: ${audience}`);
    error.status = 400;
    error.code = 'BAD_AUDIENCE';
    throw error;
  }
  const token = randomBytes(32).toString('base64url');
  const record = {
    id: createId(),
    tokenHash: hashToken(token),
    userId,
    audience,
    expiresAt: new Date(Date.now() + HANDOFF_TTL_MS),
    usedAt: null,
    createdAt: new Date(),
  };
  if (DATABASE_ENABLED) {
    await db().authHandoff.create({
      data: {
        id: record.id, tokenHash: record.tokenHash, userId: record.userId,
        audience: record.audience, expiresAt: record.expiresAt,
      },
    });
  } else {
    store.authHandoffs.set(record.tokenHash, { ...record, expiresAt: record.expiresAt.toISOString(), createdAt: record.createdAt.toISOString(), usedAt: null });
  }
  return { token, audience, expiresAt: record.expiresAt.toISOString() };
}

export async function consumeHandoff(token, audience) {
  const tokenHash = hashToken(token || '');
  let record = null;
  if (DATABASE_ENABLED) {
    record = await db().authHandoff.findUnique({ where: { tokenHash } });
  } else {
    record = store.authHandoffs.get(tokenHash) || null;
  }
  const fail = (status, code, message) => {
    const error = new Error(message);
    error.status = status;
    error.code = code;
    throw error;
  };
  if (!record) fail(404, 'HANDOFF_NOT_FOUND', 'That sign-in link was not found. Sign in with your email and password instead.');
  if (record.usedAt) fail(410, 'HANDOFF_USED', 'That sign-in link was already used. Sign in with your email and password instead.');
  if (new Date(record.expiresAt).getTime() <= Date.now()) fail(410, 'HANDOFF_EXPIRED', 'That sign-in link has expired. Sign in with your email and password instead.');
  if (audience && record.audience !== audience) {
    fail(403, 'HANDOFF_AUDIENCE', 'That sign-in link was issued for a different app.');
  }
  if (DATABASE_ENABLED) {
    // Atomic single-use claim: only the first consume wins the update.
    const claimed = await db().authHandoff.updateMany({
      where: { id: record.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (!claimed.count) fail(410, 'HANDOFF_USED', 'That sign-in link was already used. Sign in with your email and password instead.');
  } else {
    record.usedAt = new Date().toISOString();
    store.authHandoffs.set(tokenHash, record);
  }
  return { userId: record.userId, audience: record.audience };
}

export async function findUserById(id) {
  if (DATABASE_ENABLED) return db().user.findUnique({ where: { id } });
  return store.users.get(id) ?? null;
}

export async function findUsersByEmailOrPhone(email, phoneDigits) {
  const normalizedEmail = String(email || '').toLowerCase();
  if (DATABASE_ENABLED) {
    const byEmail = normalizedEmail ? await db().user.findMany({ where: { email: normalizedEmail } }) : [];
    if (byEmail.length) return byEmail;
    if (phoneDigits) {
      const all = await db().user.findMany({ where: { phone: { not: null } } });
      return all.filter((u) => String(u.phone || '').replace(/\D/g, '').slice(-10) === phoneDigits);
    }
    return [];
  }
  const users = [...store.users.values()];
  const byEmail = normalizedEmail ? users.filter((u) => String(u.email || '').toLowerCase() === normalizedEmail) : [];
  if (byEmail.length) return byEmail;
  if (phoneDigits) return users.filter((u) => String(u.phone || '').replace(/\D/g, '').slice(-10) === phoneDigits);
  return [];
}
