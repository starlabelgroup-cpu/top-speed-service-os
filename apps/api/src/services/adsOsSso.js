import { createHash, randomBytes } from 'node:crypto';
import { createId, store } from '../data/store.js';
import { DATABASE_ENABLED, db } from '../db/client.js';
import { ROLES } from '../config/security.js';
import { isMasterAccount } from './speedyVerify.js';

/**
 * Sign in with Top Speed Service OS — the Ads OS connect code
 * (2026-11-20, Ramone's direction: "Integrate it top speed service
 * os platform with service@topspeedappliance.net login" — he signs
 * into the Top Speed Ads OS console with his Service OS account
 * instead of the console's demo sign-in).
 *
 * The flow: a signed-in Service OS user opens /ads-os-connect,
 * taps "Generate Ads OS connect code", and pastes the one-time
 * code into the Ads OS console's "Sign in with Service OS" door.
 * The console exchanges the code at the public exchange endpoint
 * and receives back ONLY the account identity — email, display
 * name, role. No session token, password, or any other credential
 * ever crosses to the console; the code is the whole credential,
 * and it dies on first use.
 *
 * The discipline mirrors services/emailSignIn.js exactly: a random
 * 32-byte code whose SHA-256 hash is all that is stored; the raw
 * code is returned ONCE by the mint response and never logged.
 * Codes live 10 minutes, are single-use (atomic claim in database
 * mode), and minting a new one supersedes every still-unused code
 * for the account.
 *
 * Identity binding (the security core of this door): a code is
 * minted ONLY for the account on the caller's own session — the
 * mint endpoint takes no email or account parameter, so there is
 * no way to mint a code for someone else. The exchange returns
 * the identity of the account the code was minted for.
 *
 * Rule Zero (owner access): the Master account is exempt from
 * this door's mint cap, so the owner can never be locked out of
 * generating a code for himself. Every other account keeps at
 * most 5 codes per hour. The public exchange carries a per-IP
 * attempt cap (20/hour, the email door's bucket idiom) — identity
 * does not exist yet on that side, so the cap binds guessers; a
 * legitimate exchange is a single attempt, and the owner mints
 * fresh codes without limit regardless.
 */
export const ADS_OS_SSO_TTL_MS = 10 * 60 * 1000;
export const ADS_OS_SSO_INVALID_MESSAGE = 'This connect code is invalid or has expired';

const RATE_WINDOW_MS = 60 * 60 * 1000;
const MAX_MINTS_PER_ACCOUNT_PER_HOUR = 5;
const MAX_EXCHANGE_ATTEMPTS_PER_IP_PER_HOUR = 20;

function hashCode(code) {
  return createHash('sha256').update(String(code)).digest('hex');
}

function fail(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  throw error;
}

// ---------------------------------------------------------------------------
// Per-IP exchange attempt buckets (emailSignIn.js pattern).
// ---------------------------------------------------------------------------
const ipBuckets = new Map();

function ipLimitReached(ip) {
  if (!ip) return false;
  const bucket = ipBuckets.get(ip);
  if (!bucket || bucket.resetAt <= Date.now()) return false;
  return bucket.count >= MAX_EXCHANGE_ATTEMPTS_PER_IP_PER_HOUR;
}

function recordIpAttempt(ip) {
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
async function findUserById(id) {
  if (DATABASE_ENABLED) {
    return db().user.findUnique({ where: { id } });
  }
  return store.users.get(id) || null;
}

async function recentIssuanceCount(userId) {
  const since = new Date(Date.now() - RATE_WINDOW_MS);
  if (DATABASE_ENABLED) {
    return db().adsOsConnectCode.count({ where: { userId, createdAt: { gt: since } } });
  }
  let count = 0;
  for (const record of store.adsOsConnectCodes.values()) {
    if (record.userId === userId && new Date(record.createdAt).getTime() > since.getTime()) count += 1;
  }
  return count;
}

async function supersedeOutstanding(userId) {
  if (DATABASE_ENABLED) {
    await db().adsOsConnectCode.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt: new Date() },
    });
    return;
  }
  for (const [key, record] of store.adsOsConnectCodes.entries()) {
    if (record.userId === userId && !record.usedAt) {
      record.usedAt = new Date().toISOString();
      store.adsOsConnectCodes.set(key, record);
    }
  }
}

/**
 * Mint a one-time connect code for the account on the caller's
 * session. The route passes the account record it loaded for the
 * session's user id — this function never accepts an email or an
 * account id from the request, so a code can only ever be minted
 * for oneself. Returns the plaintext code ONCE, plus its expiry;
 * only the code's SHA-256 hash is stored.
 */
export async function mintAdsOsConnectCode(user) {
  if (!user || user.active === false) {
    fail(401, 'ACCOUNT_NOT_FOUND', 'Account not found');
  }
  // The per-account mint cap binds every account except the
  // Master's (Rule Zero, above).
  if (!isMasterAccount(user) && (await recentIssuanceCount(user.id)) >= MAX_MINTS_PER_ACCOUNT_PER_HOUR) {
    fail(429, 'ADS_OS_SSO_MINT_LIMIT', 'Too many connect codes — wait a bit and generate a fresh one.');
  }

  const code = randomBytes(32).toString('base64url');
  const record = {
    id: createId(),
    codeHash: hashCode(code),
    userId: user.id,
    expiresAt: new Date(Date.now() + ADS_OS_SSO_TTL_MS),
    usedAt: null,
    createdAt: new Date(),
  };
  // One live code per account: supersede any still-unused ones.
  await supersedeOutstanding(user.id);
  if (DATABASE_ENABLED) {
    await db().adsOsConnectCode.create({
      data: {
        id: record.id, codeHash: record.codeHash, userId: record.userId,
        expiresAt: record.expiresAt,
      },
    });
  } else {
    store.adsOsConnectCodes.set(record.codeHash, {
      ...record,
      expiresAt: record.expiresAt.toISOString(),
      createdAt: record.createdAt.toISOString(),
      usedAt: null,
    });
  }
  return { code, expiresAt: record.expiresAt.toISOString() };
}

/**
 * The identity the exchange hands the Ads OS console for the
 * account a code was minted for: email, display name, and the
 * account's role. The Master tier always reports COMPANY_OWNER —
 * it is the account's defining role (only Ramone Williams holds
 * decision authority in the console); every other account reports
 * its first role. Nothing else about the account crosses.
 */
export function adsOsIdentity(user) {
  const roles = Array.isArray(user.roles) ? user.roles : [];
  const displayName = [user.firstName, user.lastName]
    .filter((part) => typeof part === 'string' && part.trim())
    .join(' ')
    .trim();
  return {
    email: user.email,
    displayName: displayName || user.email,
    role: roles.includes(ROLES.COMPANY_OWNER) ? ROLES.COMPANY_OWNER : (roles[0] ?? null),
  };
}

/**
 * Exchange a raw connect code for its account identity. Every
 * failure — unknown code, already used, expired, inactive
 * account — throws the SAME generic 401 so the endpoint never
 * confirms which case it was. On success the code is consumed
 * (atomically in database mode), the account's other outstanding
 * codes die, and the identity is returned.
 */
export async function exchangeAdsOsConnectCode(code, { ip = null } = {}) {
  if (ipLimitReached(ip)) {
    fail(429, 'ADS_OS_SSO_EXCHANGE_LIMIT', 'Too many attempts — wait a bit and try again.');
  }
  recordIpAttempt(ip);

  const codeHash = hashCode(code || '');
  let record = null;
  if (DATABASE_ENABLED) {
    record = await db().adsOsConnectCode.findUnique({ where: { codeHash } });
  } else {
    record = store.adsOsConnectCodes.get(codeHash) || null;
  }
  if (!record) fail(401, 'ADS_OS_SSO_INVALID', ADS_OS_SSO_INVALID_MESSAGE);
  if (record.usedAt) fail(401, 'ADS_OS_SSO_INVALID', ADS_OS_SSO_INVALID_MESSAGE);
  if (new Date(record.expiresAt).getTime() <= Date.now()) fail(401, 'ADS_OS_SSO_INVALID', ADS_OS_SSO_INVALID_MESSAGE);

  const now = new Date();
  if (DATABASE_ENABLED) {
    // Atomic claim: exactly one concurrent exchange can win.
    const claimed = await db().adsOsConnectCode.updateMany({
      where: { id: record.id, usedAt: null },
      data: { usedAt: now },
    });
    if (!claimed.count) fail(401, 'ADS_OS_SSO_INVALID', ADS_OS_SSO_INVALID_MESSAGE);
  } else {
    record.usedAt = now.toISOString();
    store.adsOsConnectCodes.set(codeHash, record);
  }

  const user = await findUserById(record.userId);
  if (!user || user.active === false) fail(401, 'ADS_OS_SSO_INVALID', ADS_OS_SSO_INVALID_MESSAGE);

  // Any other outstanding connect codes for this account die too.
  await supersedeOutstanding(user.id);
  return { user, identity: adsOsIdentity(user) };
}
