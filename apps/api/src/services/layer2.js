import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { createId, store } from '../data/store.js';
import { DATABASE_ENABLED, db } from '../db/client.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { isMasterAccount } from './speedyVerify.js';
import { queueNotification } from './notifications.js';
import { channelConfigured, drainEntries, normalizePhone, twilioTrialState } from './senders.js';

/**
 * Layer 2 — 2-step sign-in (2026-11-16, Ramone's directive: "add
 * security sign in layer 2 step authentication for text and email
 * verification for all logins with Gmail or standard email access").
 *
 * After ANY successful first factor — standard email/password login
 * OR Google sign-in — an account with Layer 2 on must complete a
 * second step: a one-time 6-digit code sent by EMAIL or TEXT (SMS)
 * before a session is granted. The challenge is PER LOGIN: a fresh
 * code every sign-in, 10-minute window, single use.
 *
 * This is a different layer from Speedy Verify (services/
 * speedyVerify.js): Speedy Verify is a PER-ACCOUNT standing access
 * code issued under the Master's authority; Layer 2 is a per-login
 * possession check on the account's own email/phone. The sign-in
 * pipeline order is fixed and implemented in the routes:
 *
 *   factor 1 (password / Google)
 *     → Speedy Verify (when the account's gate applies)
 *       → Layer 2 (when the account's flag is on)
 *         → session
 *
 * Rollout mirrors the Speedy Verify precedent Ramone approved:
 * User.layer2Required defaults false, so every account that existed
 * at launch is GRANDFATHERED (sign-in unchanged). NEW accounts are
 * created with the flag on (routes/auth.js) — all roles, customers
 * included — using their account email as the always-available
 * channel. Existing accounts opt in via POST /auth/layer2/enroll.
 *
 * RULE ZERO: the Master (COMPANY_OWNER) can never be locked out.
 * layer2Applies() short-circuits for the Master before any flag is
 * read, lockout counters never apply to him, and the owner-email
 * recovery path (Speedy Verify recover/confirm) invalidates any
 * pending Layer 2 challenge for the account it recovers — see
 * routes/speedyVerify.js. The Master is exempt by construction, not
 * by a flag someone could flip.
 *
 * Codes are 6 digits, stored ONLY as a scrypt hash (services/
 * passwords format) on the LoginChallenge row, and never logged.
 * Delivery goes through the real notification outbox + senders
 * (Resend for email, Twilio for SMS) and the send result is read
 * back truthfully: if the provider is unconfigured or errors, the
 * API says the channel is unavailable and the UI offers the other
 * channel. A code is only recorded as sent when the provider
 * accepted it — nothing ever fakes a successful send. (If an SMS
 * send ever fails — provider down, number unreachable — the failure
 * is reported truthfully and email remains available, so nobody
 * locks out.)
 */
export const LAYER2 = {
  codeDigits: 6,
  challengeTtlSeconds: 600,
  codeTtlSeconds: 600,
  maxAttempts: 5,
  maxSends: 5,
  resendCooldownSeconds: 60,
};

export function layer2Applies(user) {
  return Boolean(user) && !isMasterAccount(user) && user.layer2Required === true;
}

/** New accounts start with Layer 2 on — every role except the Master tier. */
export function registrationLayer2Required(draft) {
  return !isMasterAccount(draft);
}

export function maskEmail(email) {
  const value = String(email || '');
  const at = value.indexOf('@');
  if (at <= 0) return value ? '•••' : null;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  const shown = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
  return `${shown}•••@${domain}`;
}

export function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return null;
  return `•••${digits.slice(-4)}`;
}

export function smsDestination(user) {
  return user?.layer2Phone || user?.phone || null;
}

/** Channels this account can actually receive a code on right now. */
export function availableChannels(user) {
  const smsTo = smsDestination(user);
  return [
    { channel: 'EMAIL', destination: maskEmail(user?.email), available: Boolean(user?.email) },
    { channel: 'SMS', destination: maskPhone(smsTo), available: Boolean(smsTo) },
  ];
}

export function preferredChannel(user) {
  const pref = String(user?.layer2Channel || '').toUpperCase();
  if (pref === 'SMS' && smsDestination(user)) return 'SMS';
  return 'EMAIL';
}

// ---------------------------------------------------------------------------
// Repositories: Prisma (database) or the in-memory skeleton — same shape
// as the verifyCodesRepo pattern in services/speedyVerify.js.
// ---------------------------------------------------------------------------
const challengesRepo = DATABASE_ENABLED
  ? {
      async create(record) {
        return db().loginChallenge.create({
          data: {
            id: record.id, userId: record.userId, channel: record.channel ?? null,
            codeHash: record.codeHash ?? null, status: record.status,
            attempts: record.attempts ?? 0, sends: record.sends ?? 0,
            lastSentAt: record.lastSentAt ?? null, expiresAt: record.expiresAt,
            consumedAt: record.consumedAt ?? null,
            ip: record.ip ?? null, userAgent: record.userAgent ?? null,
          },
        });
      },
      async findById(id) {
        return db().loginChallenge.findUnique({ where: { id } });
      },
      async update(id, fields) {
        return db().loginChallenge.update({ where: { id }, data: fields });
      },
      async supersedePendingForUser(userId, exceptId) {
        await db().loginChallenge.updateMany({
          where: { userId, status: 'PENDING', ...(exceptId ? { id: { not: exceptId } } : {}) },
          data: { status: 'SUPERSEDED' },
        });
      },
      async invalidatePendingForUser(userId) {
        await db().loginChallenge.updateMany({
          where: { userId, status: 'PENDING' },
          data: { status: 'INVALIDATED', consumedAt: new Date() },
        });
      },
    }
  : {
      async create(record) {
        store.loginChallenges.set(record.id, { ...record });
        return store.loginChallenges.get(record.id);
      },
      async findById(id) {
        return store.loginChallenges.get(id) ?? null;
      },
      async update(id, fields) {
        const record = store.loginChallenges.get(id);
        if (!record) return null;
        Object.assign(record, fields, { updatedAt: new Date().toISOString() });
        store.loginChallenges.set(id, record);
        return record;
      },
      async supersedePendingForUser(userId, exceptId) {
        for (const record of store.loginChallenges.values()) {
          if (record.userId === userId && record.status === 'PENDING' && record.id !== exceptId) {
            record.status = 'SUPERSEDED';
            store.loginChallenges.set(record.id, record);
          }
        }
      },
      async invalidatePendingForUser(userId) {
        for (const record of store.loginChallenges.values()) {
          if (record.userId === userId && record.status === 'PENDING') {
            record.status = 'INVALIDATED';
            record.consumedAt = new Date().toISOString();
            store.loginChallenges.set(record.id, record);
          }
        }
      },
    };

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

export { challengesRepo as layer2ChallengesRepo, usersRepo as layer2UsersRepo };

// ---------------------------------------------------------------------------
// Challenge tokens: a short-lived HS256 JWT in the exact shape
// middleware/auth.js verifies, plus purpose + challenge-id claims.
// The purpose claim makes it good for the Layer 2 step ONLY:
// middleware/auth.js refuses purpose-carrying tokens as sessions, so
// a challenge token cannot call normal authenticated endpoints.
// ---------------------------------------------------------------------------
function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function jwtSecret() {
  return process.env.JWT_SECRET;
}

export function signLayer2Challenge(user, challengeId, { speedyVerified, tempAuth } = {}) {
  const secret = jwtSecret();
  if (!secret) throw new Error('JWT_SECRET is not configured');
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    sub: user.id,
    companyId: user.companyId,
    email: user.email,
    roles: Array.isArray(user.roles) ? user.roles : [],
    purpose: 'layer2',
    cid: challengeId,
    // True when this sign-in already passed the Speedy Verify code
    // step upstream; the final session inherits it as the sv claim.
    sv: speedyVerified === true,
    // Temporary-password sign-ins (2026-11-17): true when factor 1
    // was an office-issued temporary password — the pipeline then
    // ends in the forced password change, never a direct session.
    ta: tempAuth === true,
    iat: now,
    exp: now + LAYER2.challengeTtlSeconds,
  };
  const unsigned = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  const signature = createHmac('sha256', secret).update(unsigned).digest('base64url');
  return { challenge: `${unsigned}.${signature}`, expiresInSeconds: LAYER2.challengeTtlSeconds };
}

export function readLayer2Challenge(challenge) {
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
  if (payload.purpose !== 'layer2') throw new Error('Not a Layer 2 challenge');
  if (!payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) throw new Error('Challenge expired');
  return payload;
}

function fail(status, code, message, extra = {}) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  Object.assign(error, extra);
  throw error;
}

function challengeView(user, challenge, expiresInSeconds) {
  return {
    layer2Required: true,
    code: 'LAYER2_REQUIRED',
    challenge,
    expiresInSeconds,
    channels: availableChannels(user),
    preferredChannel: preferredChannel(user),
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName ?? null,
      lastName: user.lastName ?? null,
    },
  };
}

/**
 * Open a Layer 2 challenge for a sign-in that passed everything
 * upstream. Any older pending challenge for the account is
 * superseded — only the newest sign-in can complete. Returns the
 * response payload the routes merge into their sign-in response.
 */
export async function beginLayer2Challenge(user, { speedyVerified = false, tempAuth = false, req = null } = {}) {
  await challengesRepo.supersedePendingForUser(user.id, null);
  const record = {
    id: createId(),
    userId: user.id,
    channel: null,
    codeHash: null,
    status: 'PENDING',
    attempts: 0,
    sends: 0,
    lastSentAt: null,
    expiresAt: new Date(Date.now() + LAYER2.challengeTtlSeconds * 1000),
    consumedAt: null,
    ip: req?.ip ? String(req.ip).slice(0, 64) : null,
    userAgent: req?.get ? String(req.get('user-agent') || '').slice(0, 300) || null : null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await challengesRepo.create(record);
  const { challenge, expiresInSeconds } = signLayer2Challenge(user, record.id, { speedyVerified, tempAuth });
  return challengeView(user, challenge, expiresInSeconds);
}

/** Load + validate the challenge behind a challenge token. */
async function loadChallenge(challengeToken) {
  let payload;
  try {
    payload = readLayer2Challenge(challengeToken);
  } catch {
    fail(401, 'LAYER2_CHALLENGE_INVALID', 'This sign-in session has expired — sign in again to get a fresh code.');
  }
  const record = await challengesRepo.findById(payload.cid);
  if (!record || record.userId !== payload.sub) {
    fail(401, 'LAYER2_CHALLENGE_INVALID', 'This sign-in session has expired — sign in again to get a fresh code.');
  }
  if (record.status === 'CONSUMED') {
    fail(410, 'LAYER2_CHALLENGE_USED', 'That code was already used — sign in again for a fresh one.');
  }
  if (record.status !== 'PENDING') {
    fail(401, 'LAYER2_CHALLENGE_INVALID', 'This sign-in session has expired — sign in again to get a fresh code.');
  }
  if (new Date(record.expiresAt).getTime() <= Date.now()) {
    await challengesRepo.update(record.id, { status: 'INVALIDATED', consumedAt: new Date() });
    fail(410, 'LAYER2_CHALLENGE_EXPIRED', 'That code has expired — sign in again to get a fresh code.');
  }
  const user = await usersRepo.findById(record.userId);
  if (!user || !user.active) {
    fail(401, 'LAYER2_CHALLENGE_INVALID', 'This sign-in session has expired — sign in again to get a fresh code.');
  }
  return { payload, record, user };
}

function generateCode() {
  return String(randomInt(0, 1_000_000)).padStart(LAYER2.codeDigits, '0');
}

/**
 * Send (or resend) the code for a live challenge on the chosen
 * channel. Delivery truth is read back from the outbox entry after a
 * real drain attempt: only a provider-accepted send is recorded.
 * Throws .status/.code errors in the codebase style.
 */
export async function sendLayer2Code(challengeToken, rawChannel) {
  const { record, user } = await loadChallenge(challengeToken);
  const channel = String(rawChannel || preferredChannel(user)).toUpperCase();
  if (channel !== 'EMAIL' && channel !== 'SMS') {
    fail(400, 'LAYER2_CHANNEL_INVALID', 'Choose email or text for your code.');
  }
  const now = Date.now();
  if (record.lastSentAt && now - new Date(record.lastSentAt).getTime() < LAYER2.resendCooldownSeconds * 1000) {
    fail(429, 'LAYER2_RESEND_COOLDOWN', 'A code was just sent — wait a few seconds before asking for another.', {
      retryAfterSeconds: Math.ceil((LAYER2.resendCooldownSeconds * 1000 - (now - new Date(record.lastSentAt).getTime())) / 1000),
    });
  }
  if ((record.sends || 0) >= LAYER2.maxSends) {
    fail(429, 'LAYER2_SEND_LIMIT', 'Too many codes sent for this sign-in — sign in again to start a fresh one.');
  }

  let destination;
  let maskedDestination;
  if (channel === 'EMAIL') {
    destination = user.email;
    maskedDestination = maskEmail(user.email);
  } else {
    destination = smsDestination(user);
    if (!destination) {
      fail(400, 'LAYER2_NO_PHONE', 'No phone number is on file for text codes — use the email code instead, or add a phone in your account settings.', {
        channels: availableChannels(user),
      });
    }
    maskedDestination = maskPhone(destination);
  }

  const code = generateCode();
  const firstName = user.firstName || 'there';
  const entry = queueNotification({
    channel: channel === 'EMAIL' ? 'email' : 'sms',
    template: 'LAYER2_SIGNIN_CODE',
    to: channel === 'SMS' ? normalizePhone(destination) : destination,
    payload: channel === 'EMAIL'
      ? {
          subject: 'Your Top Speed sign-in code',
          message:
            `Hi ${firstName},\n\n` +
            `Your Top Speed 2-step sign-in code is: ${code}\n\n` +
            `It expires in 10 minutes and works once. If you didn't try to sign in, ignore this email — your password was entered correctly, so consider changing it.\n\n` +
            `— Top Speed Appliance`,
        }
      : { message: `Top Speed sign-in code: ${code} — expires in 10 minutes, works once. If this wasn't you, ignore this text.` },
    source: 'LAYER2_SIGNIN',
  });
  await drainEntries([entry]);

  if (entry.status === 'GATED') {
    fail(503, 'LAYER2_CHANNEL_UNAVAILABLE',
      channel === 'EMAIL'
        ? 'Email codes are not available right now — try the text code instead.'
        : 'Text codes are not available right now — use the email code instead.',
      { channels: availableChannels(user), channel });
  }
  if (entry.status !== 'SENT') {
    // The trial-plan caveat is used only while Twilio itself reports
    // the account as a trial; on the upgraded account a failure is a
    // plain failure, worded as one.
    const smsTrial = channel === 'SMS' ? await twilioTrialState() : null;
    fail(502, 'LAYER2_SEND_FAILED',
      channel === 'EMAIL'
        ? "We couldn't send the email code just now — try again, or use the text code instead."
        : smsTrial === true
          ? "We couldn't send the text code just now — text delivery can be limited on our current messaging plan. Use the email code instead."
          : "We couldn't send the text code just now — try again, or use the email code instead.",
      { channels: availableChannels(user), channel });
  }

  await challengesRepo.update(record.id, {
    channel,
    codeHash: await hashPassword(code),
    sends: (record.sends || 0) + 1,
    lastSentAt: new Date(),
    attempts: 0,
  });
  return {
    sent: true,
    channel,
    destination: maskedDestination,
    expiresInSeconds: LAYER2.codeTtlSeconds,
    resendCooldownSeconds: LAYER2.resendCooldownSeconds,
    sendsRemaining: LAYER2.maxSends - ((record.sends || 0) + 1),
  };
}

/**
 * Exchange a challenge + entered code for the account. On success the
 * caller issues the real session token, inheriting the sv flag the
 * challenge carried from the Speedy Verify step upstream.
 */
export async function verifyLayer2Code(challengeToken, rawCode) {
  const { payload, record, user } = await loadChallenge(challengeToken);
  if (!layer2Applies(user)) {
    // The account's Layer 2 changed mid-challenge (turned off, or the
    // Master): the honest outcome is a normal session, not a code
    // demand. (Same contract as Speedy Verify's verifyChallengeCode.)
    await challengesRepo.update(record.id, { status: 'CONSUMED', consumedAt: new Date() });
    return { user, speedyVerified: payload.sv === true, alreadySatisfied: true, tempAuth: payload.ta === true };
  }
  if (!record.codeHash) {
    fail(400, 'LAYER2_CODE_NOT_SENT', 'Request a code first — choose email or text and we will send one.');
  }
  const code = String(rawCode ?? '').replace(/[\s-]/g, '');
  const ok = /^\d{6}$/.test(code) && (await verifyPassword(code, record.codeHash));
  if (!ok) {
    const attempts = (record.attempts || 0) + 1;
    if (attempts >= LAYER2.maxAttempts) {
      await challengesRepo.update(record.id, {
        attempts, status: 'INVALIDATED', consumedAt: new Date(),
      });
      fail(403, 'LAYER2_CHALLENGE_INVALIDATED', 'Too many wrong codes — this sign-in was cancelled. Sign in again to get a fresh code.');
    }
    await challengesRepo.update(record.id, { attempts });
    fail(401, 'LAYER2_INVALID_CODE', "That code isn't right — check it and try again.", {
      attemptsRemaining: LAYER2.maxAttempts - attempts,
    });
  }
  await challengesRepo.update(record.id, { status: 'CONSUMED', consumedAt: new Date() });
  return { user, speedyVerified: payload.sv === true, alreadySatisfied: false, tempAuth: payload.ta === true };
}

/**
 * Recovery hygiene: the owner-email recovery path (Speedy Verify
 * recover/confirm) kills any pending Layer 2 challenge for the
 * recovered account, so a recovered sign-in never meets a stale
 * challenge. The Master is exempt from Layer 2 by construction, so
 * for his account this is belt-and-braces; it is called for whichever
 * account completes recovery.
 */
export async function invalidatePendingChallenges(userId) {
  await challengesRepo.invalidatePendingForUser(userId);
}

// ---------------------------------------------------------------------------
// Account settings: status view + enroll / update / disable.
// ---------------------------------------------------------------------------
export function layer2StatusView(user) {
  const master = isMasterAccount(user);
  return {
    required: layer2Applies(user),
    flagOn: user.layer2Required === true,
    master,
    exempt: master,
    channels: availableChannels(user),
    preferredChannel: preferredChannel(user),
    phone: maskPhone(smsDestination(user)),
    smsConfigured: channelConfigured('sms'),
    emailConfigured: channelConfigured('email'),
  };
}

export async function updateLayer2Settings(user, { required, phone, channel } = {}) {
  const fields = {};
  if (typeof required === 'boolean') {
    if (required && isMasterAccount(user)) {
      fail(400, 'LAYER2_MASTER_EXEMPT', 'The Master account is exempt from Layer 2 by Rule Zero — it can never be switched on.');
    }
    fields.layer2Required = required;
  }
  if (phone !== undefined) {
    if (phone === null || phone === '') {
      fields.layer2Phone = null;
    } else {
      const digits = String(phone).replace(/\D/g, '');
      if (digits.length < 7 || digits.length > 15) {
        fail(400, 'LAYER2_PHONE_INVALID', 'That phone number does not look right — check it and try again.');
      }
      fields.layer2Phone = String(phone).trim().slice(0, 30);
    }
  }
  if (channel !== undefined && channel !== null && channel !== '') {
    const normalized = String(channel).toUpperCase();
    if (normalized !== 'EMAIL' && normalized !== 'SMS') {
      fail(400, 'LAYER2_CHANNEL_INVALID', 'Choose email or text for your code.');
    }
    fields.layer2Channel = normalized;
  }
  const nextPhone = fields.layer2Phone !== undefined ? fields.layer2Phone : user.layer2Phone;
  const nextChannel = fields.layer2Channel !== undefined ? fields.layer2Channel : user.layer2Channel;
  if (String(nextChannel || '').toUpperCase() === 'SMS' && !(nextPhone || user.phone)) {
    fail(400, 'LAYER2_NO_PHONE', 'Add a phone number before choosing text codes.');
  }
  const updated = Object.keys(fields).length ? await usersRepo.update(user.id, fields) : user;
  return layer2StatusView(updated || { ...user, ...fields });
}
