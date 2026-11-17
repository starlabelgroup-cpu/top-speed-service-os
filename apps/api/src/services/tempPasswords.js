import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { createId, store } from '../data/store.js';
import { DATABASE_ENABLED, db } from '../db/client.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { isMasterAccount } from './speedyVerify.js';

/**
 * Temporary passwords (2026-11-17, Ramone's directive: "Create
 * temporary login and password system to verify and change passwords
 * assigned by office with accounts and App Tools" — office-side only,
 * monitored by the Master and the office, covering employees,
 * contractors, customers and vendors alike).
 *
 * The model: Work Time Account Access (Master-only) issues an account
 * a TEMPORARY password. The holder signs in with it as the password
 * credential, passes the SAME gates as any sign-in — Speedy Verify
 * where the account requires it, then Layer 2 — and at the end of the
 * pipeline, instead of a session, receives a restricted change-only
 * state: { mustChangePassword: true, changeToken }. The changeToken
 * is a short-lived (10-minute), single-purpose, single-use HS256 JWT
 * (purpose 'temp-password-change', jti pinned on the account row) that
 * authorizes ONLY POST /auth/set-password. No full session token is
 * ever issued before the change. Setting the new password replaces
 * the account password entirely, clears every temp field, and only
 * then returns a normal login response (user + session token).
 *
 * The temporary credential gets the platform's lockout discipline —
 * the same shape as Speedy Verify: 5 wrong attempts → 15-minute lock
 * (the lock binds the temporary credential only; the account's real
 * password, when one exists, keeps working).
 *
 * The plain temporary password is generated here, hashed with the
 * platform scrypt (services/passwords), returned to the Master
 * exactly once in the issue response, and never stored or logged.
 * Expiry is 72 hours from issue; reissue replaces and invalidates
 * the previous temporary password.
 *
 * RULE ZERO: the Master (COMPANY_OWNER) is exempt by construction.
 * Issuing a temporary password FOR a Master account is refused, and
 * the login route never temp-matches a Master account, so this
 * system can never gate or lock out the owner.
 *
 * The issuing technology is office-side ONLY: the endpoints live in
 * routes/accessControl.js behind the Master gate, and no employee or
 * contractor surface links to them. The holder's experience is
 * receive-only: assigned account + temporary password → gates → set
 * own password → work.
 */
export const TEMP_PASSWORD = {
  ttlMs: 72 * 60 * 60 * 1000,
  changeTokenTtlSeconds: 600,
  maxFailedAttempts: 5,
  lockMs: 15 * 60 * 1000,
};

// ---------------------------------------------------------------------------
// User repository: Prisma (database) or the in-memory skeleton — same
// dual pattern as the other auth services.
// ---------------------------------------------------------------------------
const usersRepo = DATABASE_ENABLED
  ? {
      async findById(id) { return db().user.findUnique({ where: { id } }); },
      async update(id, fields) { return db().user.update({ where: { id }, data: fields }); },
    }
  : {
      async findById(id) { return store.users.get(id) ?? null; },
      async update(id, fields) {
        const user = store.users.get(id);
        if (user) {
          Object.assign(user, fields);
          user.updatedAt = new Date().toISOString();
          store.users.set(id, user);
        }
        return user;
      },
    };

export { usersRepo as tempUsersRepo };

function fail(status, code, message, extra = {}) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  Object.assign(error, extra);
  throw error;
}

function iso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

// ---------------------------------------------------------------------------
// Temporary password generation: readable on purpose — the office
// reads it to the holder or hands it over on paper. Two words, four
// digits, one symbol: easy to say, hard to guess, and the lockout +
// auth rate limit + 72-hour expiry bound the guessing window.
// ---------------------------------------------------------------------------
const TEMP_WORDS = [
  'Rapid', 'Falcon', 'Tiger', 'Summit', 'Harbor', 'Rocket', 'Comet', 'Viper',
  'Onyx', 'Maple', 'Cedar', 'Coral', 'Pearl', 'Amber', 'Ivory', 'Jasper',
  'Quartz', 'Sable', 'Tango', 'Umbra', 'Vivid', 'Willow', 'Zephyr', 'Bison',
  'Cobalt', 'Delta', 'Ember', 'Flint', 'Garnet', 'Heron', 'Indigo', 'Juniper',
];

export function generateTempPassword() {
  const word = () => TEMP_WORDS[randomInt(0, TEMP_WORDS.length)];
  const digits = String(randomInt(0, 10000)).padStart(4, '0');
  const symbols = ['!', '#', '*', '+', '='];
  const symbol = symbols[randomInt(0, symbols.length)];
  return `${word()}-${word()}-${digits}${symbol}`;
}

// ---------------------------------------------------------------------------
// Status view: what Work Time shows per account. Derived from the
// account row only — never includes the hash.
// ---------------------------------------------------------------------------
export function tempStatusView(user) {
  if (!user) return null;
  const now = Date.now();
  const hasTemp = Boolean(user.tempPasswordHash);
  const expiresAt = user.tempPasswordExpiresAt ? new Date(user.tempPasswordExpiresAt) : null;
  let status = 'NONE';
  if (hasTemp) {
    status = expiresAt && expiresAt.getTime() <= now ? 'EXPIRED' : 'ACTIVE';
  } else if (user.passwordChangedAt) {
    status = 'PASSWORD_SET_BY_USER';
  }
  return {
    status,
    mustChangePassword: user.mustChangePassword === true,
    expiresAt: iso(user.tempPasswordExpiresAt),
    issuedAt: iso(user.tempIssuedAt),
    issuedById: user.tempIssuedById ?? null,
    passwordChangedAt: iso(user.passwordChangedAt),
    passwordSetByUser: Boolean(user.passwordChangedAt),
    lockedUntil: iso(user.tempLockedUntil),
  };
}

/** The login route's read of one candidate's temporary credential. */
export function tempCredentialState(user) {
  if (!user || !user.tempPasswordHash) return { hasTemp: false, expired: false, locked: false, lockedUntil: null };
  const now = Date.now();
  const lockedUntil = user.tempLockedUntil ? new Date(user.tempLockedUntil) : null;
  const locked = Boolean(lockedUntil && lockedUntil.getTime() > now);
  const expired = Boolean(user.tempPasswordExpiresAt && new Date(user.tempPasswordExpiresAt).getTime() <= now);
  return { hasTemp: true, expired, locked, lockedUntil: locked ? lockedUntil : null };
}

// ---------------------------------------------------------------------------
// Office operations (routes enforce COMPANY_OWNER before calling).
// ---------------------------------------------------------------------------
export async function issueTempPassword(masterUser, targetUserId) {
  const target = await usersRepo.findById(targetUserId);
  if (!target) fail(404, 'ACCOUNT_NOT_FOUND', 'Account not found');
  if (isMasterAccount(target)) {
    fail(403, 'TEMP_PASSWORD_MASTER_EXEMPT', 'The Master account is exempt from temporary passwords by Rule Zero — it can never be temp-gated.');
  }
  const tempPassword = generateTempPassword();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + TEMP_PASSWORD.ttlMs);
  const updated = await usersRepo.update(target.id, {
    tempPasswordHash: await hashPassword(tempPassword),
    tempPasswordExpiresAt: expiresAt,
    mustChangePassword: true,
    tempIssuedAt: now,
    tempIssuedById: masterUser?.id ?? null,
    tempFailedAttempts: 0,
    tempLockedUntil: null,
    tempChangeJti: null,
  });
  // The plain temporary password is returned ONLY here, ONLY to the
  // Master, once — the same shown-once contract as a Speedy Verify code.
  return { tempPassword, expiresAt: expiresAt.toISOString(), temp: tempStatusView(updated || target) };
}

export async function revokeTempPassword(targetUserId) {
  const target = await usersRepo.findById(targetUserId);
  if (!target) fail(404, 'ACCOUNT_NOT_FOUND', 'Account not found');
  const updated = await usersRepo.update(target.id, {
    tempPasswordHash: null,
    tempPasswordExpiresAt: null,
    mustChangePassword: false,
    tempFailedAttempts: 0,
    tempLockedUntil: null,
    tempChangeJti: null,
  });
  return tempStatusView(updated || target);
}

/**
 * One wrong sign-in attempt against an account holding a live
 * temporary credential. Mirrors the Speedy Verify discipline:
 * 5 failures → 15-minute lock on the temporary credential.
 */
export async function recordTempLoginFailure(user) {
  const attempts = (user.tempFailedAttempts || 0) + 1;
  if (attempts >= TEMP_PASSWORD.maxFailedAttempts) {
    const lockedUntil = new Date(Date.now() + TEMP_PASSWORD.lockMs);
    await usersRepo.update(user.id, { tempFailedAttempts: 0, tempLockedUntil: lockedUntil });
    return { locked: true, lockedUntil };
  }
  await usersRepo.update(user.id, { tempFailedAttempts: attempts });
  return { locked: false, lockedUntil: null };
}

export async function clearTempLoginFailures(user) {
  if ((user.tempFailedAttempts || 0) > 0) {
    await usersRepo.update(user.id, { tempFailedAttempts: 0 });
  }
}

// ---------------------------------------------------------------------------
// Change tokens: a short-lived HS256 JWT in the exact shape
// middleware/auth.js verifies, plus a purpose claim that makes it
// good for POST /auth/set-password ONLY. middleware/auth.js refuses
// purpose-carrying tokens as sessions, so a change token can never
// call a normal authenticated endpoint. Single use is enforced by
// pinning the token's jti on the account row: issuing a new one (a
// fresh sign-in) supersedes the old, and completing the change
// clears it.
// ---------------------------------------------------------------------------
function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function jwtSecret() {
  return process.env.JWT_SECRET;
}

export async function signChangeToken(user, { speedyVerified = false } = {}) {
  const secret = jwtSecret();
  if (!secret) throw new Error('JWT_SECRET is not configured');
  const jti = createId();
  await usersRepo.update(user.id, { tempChangeJti: jti });
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    sub: user.id,
    companyId: user.companyId,
    email: user.email,
    roles: Array.isArray(user.roles) ? user.roles : [],
    purpose: 'temp-password-change',
    jti,
    // True when this sign-in already passed the Speedy Verify code
    // step upstream; the post-change session inherits it as the sv
    // claim, exactly like the Layer 2 challenge carries it.
    sv: speedyVerified === true,
    iat: now,
    exp: now + TEMP_PASSWORD.changeTokenTtlSeconds,
  };
  const unsigned = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  const signature = createHmac('sha256', secret).update(unsigned).digest('base64url');
  return { changeToken: `${unsigned}.${signature}`, expiresInSeconds: TEMP_PASSWORD.changeTokenTtlSeconds };
}

export function readChangeToken(changeToken) {
  const secret = jwtSecret();
  if (!secret) throw new Error('JWT_SECRET is not configured');
  const [headerPart, payloadPart, signaturePart] = String(changeToken || '').split('.');
  if (!headerPart || !payloadPart || !signaturePart) throw new Error('Malformed change token');
  const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8'));
  if (header.alg !== 'HS256') throw new Error('Unsupported change token algorithm');
  const expected = createHmac('sha256', secret).update(`${headerPart}.${payloadPart}`).digest();
  const actual = Buffer.from(signaturePart, 'base64url');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error('Invalid change token signature');
  }
  const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
  if (payload.purpose !== 'temp-password-change') throw new Error('Not a password-change token');
  if (!payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) throw new Error('Change token expired');
  return payload;
}

/**
 * The restricted state the sign-in pipeline returns when a temporary
 * password carried the sign-in: no session, just the change step.
 * Mirrors the challenge payload shapes (Speedy Verify / Layer 2).
 */
export async function changeStateJson(user, { speedyVerified = false } = {}) {
  const { changeToken, expiresInSeconds } = await signChangeToken(user, { speedyVerified });
  return {
    mustChangePassword: true,
    code: 'PASSWORD_CHANGE_REQUIRED',
    changeToken,
    expiresInSeconds,
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName ?? null,
      lastName: user.lastName ?? null,
    },
  };
}

/**
 * Complete the forced change: validate the change token, enforce the
 * password rules, replace the account password, clear every temp
 * field, and hand back the account so the route can issue the normal
 * login response. Throws .status/.code errors in the codebase style.
 */
export async function completePasswordChange(changeToken, newPassword) {
  let payload;
  try {
    payload = readChangeToken(changeToken);
  } catch {
    fail(401, 'CHANGE_TOKEN_INVALID', 'This password-change session has expired — sign in with your temporary password again to get a fresh one.');
  }
  const user = await usersRepo.findById(payload.sub);
  if (!user || !user.active) {
    fail(401, 'CHANGE_TOKEN_INVALID', 'This password-change session has expired — sign in with your temporary password again to get a fresh one.');
  }
  if (!user.tempChangeJti || user.tempChangeJti !== payload.jti) {
    fail(401, 'CHANGE_TOKEN_USED', 'This password-change session was already used or replaced — sign in again if you still need to set your password.');
  }
  if (user.mustChangePassword !== true || !user.tempPasswordHash) {
    fail(409, 'PASSWORD_CHANGE_NOT_PENDING', 'This account is not waiting on a password change — sign in with your password as usual.');
  }
  if (await verifyPassword(newPassword, user.tempPasswordHash)) {
    fail(400, 'PASSWORD_SAME_AS_TEMPORARY', 'Your new password must be different from the temporary password.');
  }
  if (await verifyPassword(newPassword, user.passwordHash)) {
    fail(400, 'PASSWORD_SAME_AS_CURRENT', 'Your new password must be different from the current password.');
  }
  const updated = await usersRepo.update(user.id, {
    passwordHash: await hashPassword(newPassword),
    tempPasswordHash: null,
    tempPasswordExpiresAt: null,
    mustChangePassword: false,
    tempFailedAttempts: 0,
    tempLockedUntil: null,
    tempChangeJti: null,
    passwordChangedAt: new Date(),
  });
  return { user: updated || user, speedyVerified: payload.sv === true };
}
