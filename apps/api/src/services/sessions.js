import { createHash } from 'node:crypto';
import { createId, store } from '../data/store.js';
import { DATABASE_ENABLED, db } from '../db/client.js';
import { STAFF_ROLES } from '../config/security.js';
import { NOTIFICATION_TEMPLATES, queueNotification } from './notifications.js';
import { signAccessToken } from './tokens.js';

/**
 * Device sessions + sign-in alerts (2026-11-20, Wave 3 item F3).
 *
 * Every completed sign-in (password, passkey, Google, and the
 * Speedy Verify / Layer 2 exchanges that finish one) records a
 * UserSession row — the device, when it signed in, when it was last
 * seen — and the JWT for that sign-in carries the row's id as its
 * `sid` claim. The account holder lists these rows in the session
 * manager (routes/sessions.js) and can sign a device out, which sets
 * revokedAt; the session guard below then refuses that token.
 *
 * RULE ZERO discipline: this layer can only ever refuse a token that
 * (a) carries an sid and (b) whose row is confirmed revoked. Tokens
 * minted before this system have no sid and are never checked; any
 * error in the check fails OPEN. The password path, Speedy Verify,
 * Layer 2 and the Master's access are exactly as they were — signing
 * out a device never changes an account, only that one session.
 *
 * New-device alerts: when a STAFF account signs in from a device
 * fingerprint it has never used before (and it has signed in before,
 * so a first-ever sign-in just establishes the baseline), an email
 * alert goes out through the notification outbox. Customers never
 * get these alerts. The alert is informational only — it never
 * blocks or delays the sign-in.
 */

const REVOCATION_CACHE_TTL_MS = 20 * 1000;
const TOUCH_THROTTLE_MS = 5 * 60 * 1000;

const revocationCache = new Map(); // sid -> { revoked, at }
const touchLog = new Map(); // sid -> epoch ms of last lastSeenAt write

export function deviceLabelFromUserAgent(userAgent) {
  const ua = String(userAgent || '');
  if (!ua) return 'Unknown device';
  let device = 'Computer';
  if (/iphone/i.test(ua)) device = 'iPhone';
  else if (/ipad/i.test(ua)) device = 'iPad';
  else if (/android/i.test(ua)) device = /mobile/i.test(ua) ? 'Android phone' : 'Android tablet';
  else if (/windows/i.test(ua)) device = 'Windows PC';
  else if (/macintosh|mac os/i.test(ua)) device = 'Mac';
  else if (/linux/i.test(ua)) device = 'Linux computer';
  let browser = '';
  if (/edg\//i.test(ua)) browser = 'Edge';
  else if (/opr\/|opera/i.test(ua)) browser = 'Opera';
  else if (/chrome\//i.test(ua)) browser = 'Chrome';
  else if (/firefox\//i.test(ua)) browser = 'Firefox';
  else if (/safari\//i.test(ua)) browser = 'Safari';
  return browser ? `${device} · ${browser}` : device;
}

export function fingerprintFromRequest(req) {
  const ua = String(req?.get?.('user-agent') || '');
  return createHash('sha256').update(`ua:${ua}`).digest('hex');
}

function clientIp(req) {
  const forwarded = String(req?.get?.('x-forwarded-for') || '').split(',')[0].trim();
  return forwarded || req?.ip || null;
}

function isStaffUser(user) {
  const roles = Array.isArray(user?.roles) ? user.roles : [];
  return roles.some((role) => STAFF_ROLES.includes(role));
}

async function listSessionRows(userId) {
  if (DATABASE_ENABLED) {
    return db().userSession.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
  }
  return [...store.userSessions.values()]
    .filter((row) => row.userId === userId)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

async function createSessionRow(user, req) {
  const now = new Date();
  const record = {
    id: createId(),
    userId: user.id,
    companyId: user.companyId,
    deviceLabel: deviceLabelFromUserAgent(req?.get?.('user-agent')),
    fingerprint: fingerprintFromRequest(req),
    ipAddress: clientIp(req),
    userAgent: String(req?.get?.('user-agent') || '').slice(0, 500) || null,
    createdAt: now,
    lastSeenAt: now,
    revokedAt: null,
  };
  if (DATABASE_ENABLED) {
    await db().userSession.create({
      data: {
        id: record.id, userId: record.userId, companyId: record.companyId,
        deviceLabel: record.deviceLabel, fingerprint: record.fingerprint,
        ipAddress: record.ipAddress, userAgent: record.userAgent,
      },
    });
  } else {
    store.userSessions.set(record.id, {
      ...record,
      createdAt: record.createdAt.toISOString(),
      lastSeenAt: record.lastSeenAt.toISOString(),
      revokedAt: null,
    });
  }
  return record;
}

function queueNewDeviceAlert(user, record) {
  if (!user.email) return;
  const when = new Date(record.createdAt).toLocaleString('en-US', { timeZone: 'America/New_York' });
  const message =
    `Hi ${user.firstName || 'there'} — a new device just signed in to your Top Speed staff account.\n\n` +
    `Device: ${record.deviceLabel || 'Unknown device'}\n` +
    `When: ${when} (Eastern)\n` +
    (record.ipAddress ? `Network address: ${record.ipAddress}\n` : '') +
    `\nIf this was you, no action is needed. If it was NOT you, open the session manager in the app, sign out the device you don't recognize, and change your password right away.`;
  queueNotification({
    channel: 'email',
    template: NOTIFICATION_TEMPLATES.SIGN_IN_ALERT,
    to: user.email,
    payload: { message, subject: 'New device signed in to your Top Speed staff account' },
    source: 'auth',
    eventKey: `sign-in-alert:${user.id}:${record.fingerprint}`,
    eventType: 'SIGN_IN_ALERT',
  });
}

/**
 * Record the device session for a completed sign-in and mint its
 * token. Returns exactly the signAccessToken shape the login routes
 * already return, with the session id folded into the JWT.
 * `alertOnNewDevice` is set by real sign-in completions (password,
 * passkey, Google, code-step exchanges) — not by registration or
 * cross-host handoff redemption, which are continuations, not new
 * sign-ins.
 */
export async function recordSignInSession(req, user, { speedyVerified, alertOnNewDevice = false } = {}) {
  let record = null;
  try {
    const prior = await listSessionRows(user.id);
    record = await createSessionRow(user, req);
    const isNewDevice = prior.length > 0 && !prior.some((row) => row.fingerprint === record.fingerprint);
    if (alertOnNewDevice && isNewDevice && isStaffUser(user)) {
      try { queueNewDeviceAlert(user, record); } catch { /* alerts never break sign-in */ }
    }
  } catch { /* session recording never breaks sign-in */ }
  return signAccessToken(user, { speedyVerified, sessionId: record?.id });
}

export function sessionView(row, currentSessionId) {
  return {
    id: row.id,
    deviceLabel: row.deviceLabel || 'Unknown device',
    ipAddress: row.ipAddress || null,
    createdAt: new Date(row.createdAt).toISOString(),
    lastSeenAt: new Date(row.lastSeenAt).toISOString(),
    revokedAt: row.revokedAt ? new Date(row.revokedAt).toISOString() : null,
    current: Boolean(currentSessionId) && row.id === currentSessionId,
  };
}

export async function listSessionsForUser(userId, currentSessionId) {
  const rows = await listSessionRows(userId);
  return rows.map((row) => sessionView(row, currentSessionId));
}

export async function revokeSession(userId, sessionId) {
  const now = new Date();
  let revoked = false;
  if (DATABASE_ENABLED) {
    const result = await db().userSession.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data: { revokedAt: now },
    });
    revoked = result.count > 0;
  } else {
    const row = store.userSessions.get(sessionId);
    if (row && row.userId === userId && !row.revokedAt) {
      row.revokedAt = now.toISOString();
      store.userSessions.set(sessionId, row);
      revoked = true;
    }
  }
  if (revoked) revocationCache.set(sessionId, { revoked: true, at: Date.now() });
  return revoked;
}

export async function revokeOtherSessions(userId, keepSessionId) {
  const rows = await listSessionRows(userId);
  let count = 0;
  for (const row of rows) {
    if (row.id === keepSessionId || row.revokedAt) continue;
    if (await revokeSession(userId, row.id)) count += 1;
  }
  return count;
}

export async function isSessionRevoked(sessionId) {
  const cached = revocationCache.get(sessionId);
  if (cached && Date.now() - cached.at < REVOCATION_CACHE_TTL_MS) return cached.revoked;
  let revoked = false;
  if (DATABASE_ENABLED) {
    const row = await db().userSession.findUnique({ where: { id: sessionId }, select: { revokedAt: true } });
    revoked = Boolean(row?.revokedAt);
  } else {
    revoked = Boolean(store.userSessions.get(sessionId)?.revokedAt);
  }
  revocationCache.set(sessionId, { revoked, at: Date.now() });
  return revoked;
}

function touchSession(sessionId) {
  const last = touchLog.get(sessionId) || 0;
  if (Date.now() - last < TOUCH_THROTTLE_MS) return;
  touchLog.set(sessionId, Date.now());
  const now = new Date();
  const write = DATABASE_ENABLED
    ? db().userSession.updateMany({ where: { id: sessionId, revokedAt: null }, data: { lastSeenAt: now } })
    : Promise.resolve().then(() => {
        const row = store.userSessions.get(sessionId);
        if (row && !row.revokedAt) {
          row.lastSeenAt = now.toISOString();
          store.userSessions.set(sessionId, row);
        }
      });
  Promise.resolve(write).catch(() => { /* last-seen is cosmetic */ });
}

function payloadOf(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Global guard mounted in server.js ahead of the routers. It reads
 * ONLY the sid claim of a presented bearer token (validity/signature
 * remain `authenticate`'s job, per route) and refuses the request
 * when that session is confirmed revoked. Fail-open by construction:
 * no token, no sid, or any error → the request proceeds untouched.
 */
export async function sessionGuard(req, res, next) {
  try {
    const header = req.get('authorization');
    if (!header) return next();
    const [, token] = header.split(' ');
    if (!token) return next();
    const payload = payloadOf(token);
    if (!payload?.sid || payload.purpose) return next();
    if (await isSessionRevoked(payload.sid)) {
      return res.status(401).json({ error: 'This session was signed out from the session manager. Sign in again to continue.' });
    }
    touchSession(payload.sid);
    return next();
  } catch {
    return next();
  }
}
