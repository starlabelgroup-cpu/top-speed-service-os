import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { createId, store } from '../data/store.js';
import { DATABASE_ENABLED, db } from '../db/client.js';
import { ROLES, STAFF_ROLES } from '../config/security.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { consumeEmailVerification, issueEmailVerification } from './emailVerification.js';

/**
 * Speedy Verify — the Master's access-code system (Phase 1, 2026-11-16).
 *
 * Ramone's model: an access code verifies WHO you are, in addition to a
 * password; the Master's permission decides WHAT may run. No valid code →
 * access denied. Only the Master (COMPANY_OWNER) can issue, revoke, or
 * reset a code, or flip an account's requirement switch.
 *
 * Phase 1 covers STAFF accounts (STAFF_ROLES) and BUSINESS accounts
 * (signupAudience commercial / property-manager). Flywheel advertiser
 * accounts (ADVERTISER role) are business accounts and are covered the
 * same way (2026-11-16). Customers and providers are designed
 * (ACCESS-CODE-SYSTEM.md) but their sign-in is unchanged.
 *
 * Activation is PER ACCOUNT via User.verifyRequired (default false):
 * every account that existed at launch is grandfathered. Issuing an
 * account's first code turns its requirement on; new staff/business
 * accounts are created with it on and wait in the Master's approval
 * queue (verifyRequired = true, no live code = cannot sign in).
 *
 * The Master is exempt BY CONSTRUCTION (Rule Zero): every check in this
 * module short-circuits for COMPANY_OWNER before any code logic runs,
 * so the system can never lock him out. His recovery path is control of
 * his own account email (the platform's single-use verification mail).
 *
 * Codes are 8 digits, stored ONLY as a scrypt hash (services/passwords
 * format). The plain code is returned exactly once — in the issue
 * response to the Master — and never stored or logged.
 */
export const SPEEDY_VERIFY = {
  codeDigits: 8,
  challengeTtlSeconds: 600,
  maxFailedAttempts: 5,
  lockMs: 15 * 60 * 1000,
};

export const BUSINESS_AUDIENCES = ['commercial', 'property-manager'];

// Contractor accounts (providers / technicians). Their sign-in is NOT
// gated in Phase 1 — but when the Master creates one (e.g. from the
// Turbo Boss Accounts panel) it still starts flagged UNVERIFIED and is
// listed in his panel, so its code can be issued ahead of Phase 3,
// when the gate starts applying to provider sign-in too.
export const PROVIDER_ACCOUNT_ROLES = [ROLES.PROVIDER_OWNER, ROLES.PROVIDER_TECH, ROLES.TECHNICIAN];

/**
 * Does a freshly created account start UNVERIFIED (verifyRequired on,
 * waiting for the Master's code)? Covered accounts always do.
 * Contractor accounts do when an administrator created them (the
 * Turbo Boss / console creation path — accounts created outside the
 * public sign-up flow follow the same activation model). The Master
 * tier never does.
 */
export function registrationStartsUnverified(draft, adminCreated) {
  if (isMasterAccount(draft)) return false;
  if (isSpeedyVerifyCovered(draft)) return true;
  if (!adminCreated) return false;
  const roles = Array.isArray(draft.roles) ? draft.roles : [];
  return roles.some((role) => PROVIDER_ACCOUNT_ROLES.includes(role));
}

export function isMasterAccount(user) {
  return Boolean(user) && Array.isArray(user.roles) && user.roles.includes(ROLES.COMPANY_OWNER);
}

export function isSpeedyVerifyCovered(user) {
  if (!user) return false;
  const roles = Array.isArray(user.roles) ? user.roles : [];
  if (roles.some((role) => STAFF_ROLES.includes(role))) return true;
  // Flywheel Advertising (2026-11-16): advertiser accounts are business
  // accounts — a business's ADVERTISER account starts unverified and
  // waits for the Master's code exactly like a commercial / PM account.
  if (roles.includes(ROLES.ADVERTISER)) return true;
  return BUSINESS_AUDIENCES.includes(user.signupAudience || '');
}

/** The gate that actually applies: covered, activated, and not the Master. */
export function verifyGateApplies(user) {
  return Boolean(user) && !isMasterAccount(user) && isSpeedyVerifyCovered(user) && user.verifyRequired === true;
}

export function normalizeCode(raw) {
  return String(raw ?? '').replace(/[\s-]/g, '');
}

export function formatCode(code) {
  const digits = normalizeCode(code);
  return digits.length === 8 ? `${digits.slice(0, 4)} ${digits.slice(4)}` : digits;
}

function generateCode() {
  return String(randomInt(0, 100_000_000)).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// Repositories: Prisma (database) or the in-memory skeleton — same shape
// as the usersRepo pattern in routes/auth.js.
// ---------------------------------------------------------------------------
export const verifyCodesRepo = DATABASE_ENABLED
  ? {
      async findByUserId(userId) {
        return db().speedyVerifyCode.findUnique({ where: { userId } });
      },
      async upsert(record) {
        return db().speedyVerifyCode.upsert({
          where: { userId: record.userId },
          create: {
            id: record.id, userId: record.userId, codeHash: record.codeHash,
            status: record.status, issuedById: record.issuedById ?? null,
            issuedAt: record.issuedAt, revokedAt: record.revokedAt ?? null,
            lastUsedAt: record.lastUsedAt ?? null,
            failedAttempts: record.failedAttempts ?? 0,
            lockedUntil: record.lockedUntil ?? null,
          },
          update: {
            codeHash: record.codeHash, status: record.status,
            issuedById: record.issuedById ?? null, issuedAt: record.issuedAt,
            revokedAt: record.revokedAt ?? null, lastUsedAt: record.lastUsedAt ?? null,
            failedAttempts: record.failedAttempts ?? 0, lockedUntil: record.lockedUntil ?? null,
          },
        });
      },
      async update(userId, fields) {
        return db().speedyVerifyCode.update({ where: { userId }, data: fields });
      },
    }
  : {
      async findByUserId(userId) {
        return store.speedyVerifyCodes.get(userId) ?? null;
      },
      async upsert(record) {
        store.speedyVerifyCodes.set(record.userId, { ...record });
        return store.speedyVerifyCodes.get(record.userId);
      },
      async update(userId, fields) {
        const record = store.speedyVerifyCodes.get(userId);
        if (!record) return null;
        Object.assign(record, fields, { updatedAt: new Date().toISOString() });
        store.speedyVerifyCodes.set(userId, record);
        return record;
      },
    };

const usersRepo = DATABASE_ENABLED
  ? {
      async findById(id) { return db().user.findUnique({ where: { id } }); },
      async findAllByEmail(email) { return db().user.findMany({ where: { email } }); },
      async listAll() { return db().user.findMany({}); },
      async setVerifyRequired(id, required) {
        return db().user.update({ where: { id }, data: { verifyRequired: required } });
      },
    }
  : {
      async findById(id) { return store.users.get(id) ?? null; },
      async findAllByEmail(email) {
        return [...store.users.values()].filter((user) => user.email === email);
      },
      async listAll() { return [...store.users.values()]; },
      async setVerifyRequired(id, required) {
        const user = store.users.get(id);
        if (user) {
          user.verifyRequired = required;
          user.updatedAt = new Date().toISOString();
          store.users.set(id, user);
        }
        return user;
      },
    };

export { usersRepo as verifyUsersRepo };

function iso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

/** Public, code-free view of one account's Speedy Verify state. */
export function verifyStateView(user, record) {
  const hasActiveCode = Boolean(record && record.status === 'ACTIVE');
  return {
    covered: isSpeedyVerifyCovered(user),
    master: isMasterAccount(user),
    required: user.verifyRequired === true,
    hasActiveCode,
    codeStatus: record ? record.status : 'NONE',
    issuedAt: record ? iso(record.issuedAt) : null,
    issuedById: record?.issuedById ?? null,
    revokedAt: record ? iso(record.revokedAt) : null,
    lastUsedAt: record ? iso(record.lastUsedAt) : null,
    lockedUntil: record ? iso(record.lockedUntil) : null,
    // True when the code step is enforced at this account's sign-in
    // today (Phase 1: staff + business). Contractor accounts can be
    // flagged required + listed before their enforcement phase.
    enforced: verifyGateApplies(user),
    // Flagged as needing a code and none issued yet — includes
    // contractor accounts awaiting a Phase 3 code.
    awaitingCode: user.verifyRequired === true && !hasActiveCode && !isMasterAccount(user),
    // The Master's approval queue: sign-in is blocked until he acts.
    pendingApproval: verifyGateApplies(user) && !hasActiveCode,
  };
}

export async function getVerifyState(user) {
  if (!user) return null;
  const record = await verifyCodesRepo.findByUserId(user.id);
  return verifyStateView(user, record);
}

// ---------------------------------------------------------------------------
// Challenge tokens: a short-lived HS256 JWT in the exact shape
// middleware/auth.js verifies, plus a purpose claim that makes it good
// for the code step ONLY. It is never accepted as a session token
// (authenticate() ignores the purpose claim, so the routes below are
// the only consumers — and /auth/me's sv check rejects it as a session
// for gated accounts because it carries no sv claim).
// ---------------------------------------------------------------------------
function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function jwtSecret() {
  return process.env.JWT_SECRET;
}

export function signVerifyChallenge(user) {
  const secret = jwtSecret();
  if (!secret) throw new Error('JWT_SECRET is not configured');
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    sub: user.id,
    companyId: user.companyId,
    email: user.email,
    roles: Array.isArray(user.roles) ? user.roles : [],
    purpose: 'speedy-verify',
    iat: now,
    exp: now + SPEEDY_VERIFY.challengeTtlSeconds,
  };
  const unsigned = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  const signature = createHmac('sha256', secret).update(unsigned).digest('base64url');
  return { challenge: `${unsigned}.${signature}`, expiresInSeconds: SPEEDY_VERIFY.challengeTtlSeconds };
}

export function readVerifyChallenge(challenge) {
  const secret = jwtSecret();
  if (!secret) throw new Error('JWT_SECRET is not configured');
  const [headerPart, payloadPart, signaturePart] = String(challenge || '').split('.');
  if (!headerPart || !payloadPart || !signaturePart) throw new Error('Malformed challenge');
  const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8'));
  if (header.alg !== 'HS256') throw new Error('Unsupported challenge algorithm');
  const expected = createHmac('sha256', secret).update(`${headerPart}.${payloadPart}`).digest();
  const actual = Buffer.from(signaturePart, 'base64url');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error('Invalid challenge signature');
  }
  const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
  if (payload.purpose !== 'speedy-verify') throw new Error('Not a Speedy Verify challenge');
  if (!payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) throw new Error('Challenge expired');
  return payload;
}

// ---------------------------------------------------------------------------
// Login gate: called by POST /auth/login AFTER the password checks out.
// Returns one of:
//   { action: 'pass' }                                  — sign in as usual
//   { action: 'deny', state }                           — no live code
//   { action: 'challenge', challenge, expiresInSeconds, state }
// ---------------------------------------------------------------------------
export async function loginGate(user) {
  if (!verifyGateApplies(user)) return { action: 'pass' };
  const state = await getVerifyState(user);
  if (!state.hasActiveCode) return { action: 'deny', state };
  const { challenge, expiresInSeconds } = signVerifyChallenge(user);
  return { action: 'challenge', challenge, expiresInSeconds, state };
}

/**
 * Exchange a challenge + entered code for the account. On success the
 * caller issues the real session token (with the sv claim). Throws an
 * error with .status/.code on every failure, in the codebase's style.
 */
export async function verifyChallengeCode(challenge, rawCode) {
  const fail = (status, code, message, extra = {}) => {
    const error = new Error(message);
    error.status = status;
    error.code = code;
    Object.assign(error, extra);
    throw error;
  };
  let payload;
  try {
    payload = readVerifyChallenge(challenge);
  } catch (error) {
    fail(401, 'SPEEDY_VERIFY_CHALLENGE_INVALID', 'This sign-in session has expired — sign in again to get a fresh code step.');
  }
  const user = await usersRepo.findById(payload.sub);
  if (!user || !user.active) fail(401, 'SPEEDY_VERIFY_CHALLENGE_INVALID', 'This sign-in session has expired — sign in again to get a fresh code step.');
  if (!verifyGateApplies(user)) {
    // The account's gate changed mid-challenge (waived, or the Master):
    // the honest outcome is a normal session, not a code demand.
    return { user, alreadySatisfied: true };
  }
  const record = await verifyCodesRepo.findByUserId(user.id);
  if (!record || record.status !== 'ACTIVE') {
    fail(403, 'SPEEDY_VERIFY_NO_CODE', 'Speedy Verify required — no access code has been issued for this account yet. Contact the office.');
  }
  const now = Date.now();
  if (record.lockedUntil && new Date(record.lockedUntil).getTime() > now) {
    fail(403, 'SPEEDY_VERIFY_LOCKED', 'Too many wrong codes — code entry for this account is locked for a few minutes. Try again shortly, or contact the office.', {
      retryAfterSeconds: Math.ceil((new Date(record.lockedUntil).getTime() - now) / 1000),
    });
  }
  const code = normalizeCode(rawCode);
  const ok = /^\d{8}$/.test(code) && (await verifyPassword(code, record.codeHash));
  if (!ok) {
    const attempts = (record.failedAttempts || 0) + 1;
    const fields = { failedAttempts: attempts };
    if (attempts >= SPEEDY_VERIFY.maxFailedAttempts) {
      fields.lockedUntil = new Date(now + SPEEDY_VERIFY.lockMs);
      fields.failedAttempts = 0;
    }
    await verifyCodesRepo.update(user.id, fields);
    if (fields.lockedUntil) {
      fail(403, 'SPEEDY_VERIFY_LOCKED', 'Too many wrong codes — code entry for this account is locked for a few minutes. Try again shortly, or contact the office.', {
        retryAfterSeconds: Math.ceil(SPEEDY_VERIFY.lockMs / 1000),
      });
    }
    fail(401, 'SPEEDY_VERIFY_INVALID_CODE', "That access code isn't right — check it and try again.", {
      attemptsRemaining: SPEEDY_VERIFY.maxFailedAttempts - attempts,
    });
  }
  await verifyCodesRepo.update(user.id, {
    failedAttempts: 0,
    lockedUntil: null,
    lastUsedAt: new Date(),
  });
  return { user, alreadySatisfied: false };
}

// ---------------------------------------------------------------------------
// Master operations (routes enforce COMPANY_OWNER before calling these).
// ---------------------------------------------------------------------------
export async function issueCode(masterUser, targetUserId) {
  const target = await usersRepo.findById(targetUserId);
  if (!target) {
    const error = new Error('Account not found');
    error.status = 404;
    throw error;
  }
  const code = generateCode();
  const record = {
    id: createId(),
    userId: target.id,
    codeHash: await hashPassword(code),
    status: 'ACTIVE',
    issuedById: masterUser.id,
    issuedAt: new Date(),
    revokedAt: null,
    lastUsedAt: null,
    failedAttempts: 0,
    lockedUntil: null,
  };
  await verifyCodesRepo.upsert(record);
  // Issuing the first code is what activates the requirement.
  if (target.verifyRequired !== true && !isMasterAccount(target)) {
    await usersRepo.setVerifyRequired(target.id, true);
    target.verifyRequired = true;
  }
  const state = verifyStateView(target, await verifyCodesRepo.findByUserId(target.id));
  // The plain code is returned ONLY here, ONLY to the Master, once.
  return { code: formatCode(code), state };
}

export async function revokeCode(targetUserId) {
  const target = await usersRepo.findById(targetUserId);
  if (!target) {
    const error = new Error('Account not found');
    error.status = 404;
    throw error;
  }
  const record = await verifyCodesRepo.findByUserId(target.id);
  if (record && record.status === 'ACTIVE') {
    await verifyCodesRepo.update(target.id, { status: 'REVOKED', revokedAt: new Date() });
  }
  return verifyStateView(target, await verifyCodesRepo.findByUserId(target.id));
}

export async function setRequirement(targetUserId, required) {
  const target = await usersRepo.findById(targetUserId);
  if (!target) {
    const error = new Error('Account not found');
    error.status = 404;
    throw error;
  }
  if (isMasterAccount(target) && required) {
    const error = new Error('The Master account is exempt from Speedy Verify by Rule Zero — its requirement can never be switched on.');
    error.status = 400;
    throw error;
  }
  await usersRepo.setVerifyRequired(target.id, Boolean(required));
  target.verifyRequired = Boolean(required);
  return verifyStateView(target, await verifyCodesRepo.findByUserId(target.id));
}

/**
 * Every account the panel tracks: covered accounts, the Master (marked
 * exempt), and any account flagged verifyRequired — which is how
 * admin-created contractor accounts surface here before Phase 3.
 */
export async function listVerifyAccounts() {
  const users = await usersRepo.listAll();
  const covered = users.filter(
    (user) => isMasterAccount(user) || isSpeedyVerifyCovered(user) || user.verifyRequired === true,
  );
  const rows = [];
  for (const user of covered) {
    const record = await verifyCodesRepo.findByUserId(user.id);
    rows.push({
      user: {
        id: user.id,
        companyId: user.companyId,
        email: user.email,
        firstName: user.firstName ?? null,
        lastName: user.lastName ?? null,
        roles: user.roles,
        signupAudience: user.signupAudience ?? null,
        active: user.active,
        createdAt: iso(user.createdAt),
      },
      verify: verifyStateView(user, record),
    });
  }
  rows.sort((a, b) => {
    if (a.verify.pendingApproval !== b.verify.pendingApproval) return a.verify.pendingApproval ? -1 : 1;
    return String(a.user.email).localeCompare(String(b.user.email));
  });
  return rows;
}

// ---------------------------------------------------------------------------
// Master recovery: control of the Master's own account email is the key.
// Reuses the email-verification machinery (single-use, hashed, expiring
// token + emailed link). Only a COMPANY_OWNER account can complete it.
// ---------------------------------------------------------------------------
export async function requestMasterRecovery(email) {
  const candidates = await usersRepo.findAllByEmail(String(email || '').trim().toLowerCase());
  const master = candidates.find((user) => isMasterAccount(user) && user.active);
  if (!master) return { sent: false };
  await issueEmailVerification(master, 'SPEEDY_VERIFY_RECOVERY');
  return { sent: true };
}

export async function confirmMasterRecovery(token) {
  const user = await consumeEmailVerification(token);
  if (!isMasterAccount(user)) {
    const error = new Error('Speedy Verify recovery is reserved for the Master account.');
    error.status = 403;
    error.code = 'SPEEDY_VERIFY_RECOVERY_FORBIDDEN';
    throw error;
  }
  const record = await verifyCodesRepo.findByUserId(user.id);
  if (record) {
    await verifyCodesRepo.update(user.id, { failedAttempts: 0, lockedUntil: null });
  }
  return user;
}
