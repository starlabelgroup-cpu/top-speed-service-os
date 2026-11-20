import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { createId, store } from '../data/store.js';
import { DATABASE_ENABLED, db } from '../db/client.js';

/**
 * Passkeys — WebAuthn sign-in (2026-11-20, Wave 3 item F2).
 *
 * A passkey replaces ONLY the password step of sign-in. Registration
 * happens inside an existing session (the account holder proves who
 * they are with the normal pipeline first); authentication verifies
 * the authenticator's assertion and then hands the account to the
 * EXACT same gate pipeline as a password: Speedy Verify, then
 * Layer 2, then the session (routes/passkeys.js). A flagged account
 * that signs in with a passkey still owes its access code and its
 * 2-step code — the passkey is a first factor, never a gate bypass.
 *
 * Storage discipline mirrors the platform's token systems: the
 * credential row holds only the PUBLIC key; ceremony challenges are
 * random, single-use, and live 5 minutes.
 *
 * Configuration is env-only:
 *   WEBAUTHN_RP_ID   — relying party id (default topspeedserviceos.com)
 *   WEBAUTHN_ORIGINS — comma-separated allowed origins (defaults to
 *                      the flagship + Pepper Lists hosts)
 */

export const PASSKEY_CHALLENGE_TTL_MS = 5 * 60 * 1000;

export function passkeyRpId() {
  return process.env.WEBAUTHN_RP_ID || 'topspeedserviceos.com';
}

export function passkeyRpName() {
  return 'Top Speed Service OS';
}

export function passkeyOrigins() {
  const raw = process.env.WEBAUTHN_ORIGINS
    || 'https://topspeedserviceos.com,https://www.topspeedserviceos.com,https://pepperlists.com,https://www.pepperlists.com';
  return raw.split(',').map((value) => value.trim()).filter(Boolean);
}

function passkeyError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

/* ------------------------- user lookup ------------------------- */

export async function findUsersByEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return [];
  if (DATABASE_ENABLED) {
    const rows = await db().user.findMany({ where: { email: normalized } });
    return rows;
  }
  return [...store.users.values()].filter((user) => String(user.email || '').toLowerCase() === normalized);
}

export async function findUserById(id) {
  if (!id) return null;
  if (DATABASE_ENABLED) return db().user.findUnique({ where: { id } });
  return store.users.get(id) || null;
}

/* ------------------------- challenges ------------------------- */

async function saveChallenge({ challenge, userId, purpose }) {
  const record = {
    id: createId(),
    challenge,
    userId: userId || null,
    purpose,
    expiresAt: new Date(Date.now() + PASSKEY_CHALLENGE_TTL_MS),
    usedAt: null,
    createdAt: new Date(),
  };
  if (DATABASE_ENABLED) {
    await db().passkeyChallenge.create({
      data: {
        id: record.id, challenge: record.challenge, userId: record.userId,
        purpose: record.purpose, expiresAt: record.expiresAt,
      },
    });
  } else {
    store.passkeyChallenges.set(record.challenge, {
      ...record,
      expiresAt: record.expiresAt.toISOString(),
      createdAt: record.createdAt.toISOString(),
      usedAt: null,
    });
  }
  return record;
}

/** Single-use claim: returns the row only when it is live and unused. */
async function claimChallenge(challenge, purpose) {
  if (!challenge) return null;
  let record = null;
  if (DATABASE_ENABLED) {
    record = await db().passkeyChallenge.findUnique({ where: { challenge } });
  } else {
    record = store.passkeyChallenges.get(challenge) || null;
  }
  if (!record || record.purpose !== purpose) return null;
  if (record.usedAt) return null;
  if (new Date(record.expiresAt).getTime() <= Date.now()) return null;
  if (DATABASE_ENABLED) {
    const claimed = await db().passkeyChallenge.updateMany({
      where: { id: record.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (!claimed.count) return null;
  } else {
    record.usedAt = new Date().toISOString();
    store.passkeyChallenges.set(challenge, record);
  }
  return record;
}

/* ------------------------- credentials ------------------------- */

function credentialView(row) {
  return {
    id: row.id,
    deviceLabel: row.deviceLabel || 'Passkey',
    createdAt: new Date(row.createdAt).toISOString(),
    lastUsedAt: row.lastUsedAt ? new Date(row.lastUsedAt).toISOString() : null,
  };
}

export async function listCredentialsForUser(userId) {
  if (DATABASE_ENABLED) {
    const rows = await db().passkeyCredential.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
    return rows.map(credentialView);
  }
  return [...store.passkeyCredentials.values()]
    .filter((row) => row.userId === userId)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .map(credentialView);
}

async function credentialRowsForUser(userId) {
  if (DATABASE_ENABLED) {
    return db().passkeyCredential.findMany({ where: { userId } });
  }
  return [...store.passkeyCredentials.values()].filter((row) => row.userId === userId);
}

async function findCredentialById(credentialId) {
  if (DATABASE_ENABLED) {
    return db().passkeyCredential.findUnique({ where: { credentialId } });
  }
  return store.passkeyCredentials.get(credentialId) || null;
}

export async function deleteCredential(userId, id) {
  if (DATABASE_ENABLED) {
    const result = await db().passkeyCredential.deleteMany({ where: { id, userId } });
    return result.count > 0;
  }
  for (const [key, row] of store.passkeyCredentials.entries()) {
    if (row.id === id && row.userId === userId) {
      store.passkeyCredentials.delete(key);
      return true;
    }
  }
  return false;
}

function transportsToString(transports) {
  return Array.isArray(transports) && transports.length ? transports.join(',') : null;
}

function transportsFromString(value) {
  return value ? String(value).split(',').filter(Boolean) : undefined;
}

/* ------------------------- ceremonies ------------------------- */

export async function beginRegistration(user, { deviceLabel } = {}) {
  const existing = await credentialRowsForUser(user.id);
  const options = await generateRegistrationOptions({
    rpName: passkeyRpName(),
    rpID: passkeyRpId(),
    userID: new TextEncoder().encode(user.id),
    userName: user.email,
    userDisplayName: [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email,
    attestationType: 'none',
    excludeCredentials: existing.map((row) => ({
      id: row.credentialId,
      transports: transportsFromString(row.transports),
    })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  });
  await saveChallenge({ challenge: options.challenge, userId: user.id, purpose: 'REGISTRATION' });
  return { options, deviceLabel: deviceLabel || null };
}

export async function completeRegistration(user, { response, deviceLabel } = {}) {
  const challenge = response?.response?.clientDataJSON
    ? JSON.parse(Buffer.from(response.response.clientDataJSON, 'base64url').toString('utf8')).challenge
    : null;
  const claimed = await claimChallenge(challenge, 'REGISTRATION');
  if (!claimed || claimed.userId !== user.id) {
    throw passkeyError(400, 'PASSKEY_CHALLENGE_INVALID', 'That passkey setup link has expired — start again.');
  }
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: claimed.challenge,
      expectedOrigin: passkeyOrigins(),
      expectedRPID: passkeyRpId(),
      requireUserVerification: false,
    });
  } catch (error) {
    throw passkeyError(400, 'PASSKEY_VERIFICATION_FAILED', `Passkey setup could not be verified: ${error.message}`);
  }
  if (!verification.verified || !verification.registrationInfo) {
    throw passkeyError(400, 'PASSKEY_VERIFICATION_FAILED', 'Passkey setup could not be verified.');
  }
  const credential = verification.registrationInfo.credential;
  const existing = await findCredentialById(credential.id);
  if (existing) {
    throw passkeyError(409, 'PASSKEY_ALREADY_REGISTERED', 'That passkey is already set up on this account.');
  }
  const record = {
    id: createId(),
    userId: user.id,
    companyId: user.companyId,
    credentialId: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString('base64url'),
    counter: credential.counter || 0,
    transports: transportsToString(credential.transports),
    deviceLabel: deviceLabel || 'Passkey',
    createdAt: new Date(),
    lastUsedAt: null,
  };
  if (DATABASE_ENABLED) {
    await db().passkeyCredential.create({
      data: {
        id: record.id, userId: record.userId, companyId: record.companyId,
        credentialId: record.credentialId, publicKey: record.publicKey,
        counter: record.counter, transports: record.transports, deviceLabel: record.deviceLabel,
      },
    });
  } else {
    store.passkeyCredentials.set(record.credentialId, {
      ...record,
      createdAt: record.createdAt.toISOString(),
      lastUsedAt: null,
    });
  }
  return credentialView(record);
}

export async function beginAuthentication(email) {
  const users = await findUsersByEmail(email);
  const allowCredentials = [];
  for (const user of users) {
    if (!user.active) continue;
    const rows = await credentialRowsForUser(user.id);
    for (const row of rows) {
      allowCredentials.push({ id: row.credentialId, transports: transportsFromString(row.transports) });
    }
  }
  if (!allowCredentials.length) {
    throw passkeyError(400, 'PASSKEY_NOT_AVAILABLE', 'No passkey is set up for that account — sign in with your password instead.');
  }
  const options = await generateAuthenticationOptions({
    rpID: passkeyRpId(),
    allowCredentials,
    userVerification: 'preferred',
  });
  await saveChallenge({ challenge: options.challenge, userId: null, purpose: 'AUTHENTICATION' });
  return { options };
}

export async function completeAuthentication({ response } = {}) {
  const credentialId = response?.id;
  if (!credentialId) {
    throw passkeyError(400, 'PASSKEY_VERIFICATION_FAILED', 'That passkey sign-in could not be verified.');
  }
  const stored = await findCredentialById(credentialId);
  if (!stored) {
    throw passkeyError(400, 'PASSKEY_NOT_AVAILABLE', 'That passkey is not registered here — sign in with your password instead.');
  }
  const challenge = response?.response?.clientDataJSON
    ? JSON.parse(Buffer.from(response.response.clientDataJSON, 'base64url').toString('utf8')).challenge
    : null;
  const claimed = await claimChallenge(challenge, 'AUTHENTICATION');
  if (!claimed) {
    throw passkeyError(400, 'PASSKEY_CHALLENGE_INVALID', 'That passkey sign-in has expired — try again.');
  }
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: claimed.challenge,
      expectedOrigin: passkeyOrigins(),
      expectedRPID: passkeyRpId(),
      credential: {
        id: stored.credentialId,
        publicKey: new Uint8Array(Buffer.from(stored.publicKey, 'base64url')),
        counter: stored.counter || 0,
        transports: transportsFromString(stored.transports),
      },
      requireUserVerification: false,
    });
  } catch (error) {
    throw passkeyError(400, 'PASSKEY_VERIFICATION_FAILED', `That passkey sign-in could not be verified: ${error.message}`);
  }
  if (!verification.verified) {
    throw passkeyError(400, 'PASSKEY_VERIFICATION_FAILED', 'That passkey sign-in could not be verified.');
  }
  const newCounter = verification.authenticationInfo.newCounter;
  if (DATABASE_ENABLED) {
    await db().passkeyCredential.update({
      where: { id: stored.id },
      data: { counter: newCounter, lastUsedAt: new Date() },
    });
  } else {
    stored.counter = newCounter;
    stored.lastUsedAt = new Date().toISOString();
    store.passkeyCredentials.set(stored.credentialId, stored);
  }
  const user = await findUserById(stored.userId);
  if (!user || !user.active) {
    throw passkeyError(403, 'ACCOUNT_INACTIVE', 'This account is inactive');
  }
  return user;
}
