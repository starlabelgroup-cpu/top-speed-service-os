import { store } from '../data/store.js';
import { DATABASE_ENABLED, db } from './client.js';

/**
 * Web Push subscription persistence — the per-device opt-ins behind
 * the customer app's booking-update notifications (2026-11-20,
 * approved recommendation B1).
 *
 * The store Map is the runtime source (hydrated at cold start, kept
 * current by the subscribe/unsubscribe routes and by delivery-time
 * revocation); every mutation also writes through to the
 * PushSubscription table so subscriptions survive cold starts.
 *
 * A subscription belongs to exactly one account. The endpoint is the
 * push service's per-device URL and is unique: if a device that was
 * subscribed under one account is subscribed again under another
 * (shared family tablet, say), the newest sign-in takes ownership —
 * the row is reassigned rather than duplicated, so a device never
 * receives two copies of the same update.
 */

function iso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function toStoreSubscription(row) {
  return {
    id: row.id,
    userId: row.userId,
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
    userAgent: row.userAgent || null,
    createdAt: iso(row.createdAt),
    revokedAt: iso(row.revokedAt),
  };
}

/** Active (never-revoked) subscriptions for one account, oldest first. */
export function activeSubscriptionsForUser(userId) {
  if (!userId) return [];
  return [...store.pushSubscriptions.values()]
    .filter((s) => s.userId === userId && !s.revokedAt)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Any subscription (active or revoked) by id. */
export function subscriptionById(id) {
  return store.pushSubscriptions.get(id) || null;
}

/** Any subscription (active or revoked) by endpoint. */
export function subscriptionByEndpoint(endpoint) {
  return [...store.pushSubscriptions.values()].find((s) => s.endpoint === endpoint) || null;
}

export async function persistPushSubscription(subscription) {
  if (!DATABASE_ENABLED || !subscription?.id) return;
  const row = {
    id: subscription.id,
    userId: subscription.userId,
    endpoint: subscription.endpoint,
    p256dh: subscription.p256dh,
    auth: subscription.auth,
    userAgent: subscription.userAgent || null,
    createdAt: new Date(subscription.createdAt),
    revokedAt: subscription.revokedAt ? new Date(subscription.revokedAt) : null,
  };
  await db().pushSubscription.upsert({ where: { id: row.id }, update: row, create: row });
}

/**
 * Mark a subscription revoked (store + database). Idempotent: an
 * already-revoked row keeps its original revokedAt stamp.
 */
export async function revokePushSubscription(id) {
  const existing = store.pushSubscriptions.get(id);
  if (!existing || existing.revokedAt) return existing || null;
  existing.revokedAt = new Date().toISOString();
  await persistPushSubscription(existing).catch((error) => {
    console.error(JSON.stringify({ level: 'error', message: 'push subscription revoke persist failed', error: String(error?.message || error) }));
  });
  return existing;
}

export async function hydratePushSubscriptions() {
  if (!DATABASE_ENABLED) return 0;
  const rows = await db().pushSubscription.findMany({ orderBy: { createdAt: 'asc' } });
  store.pushSubscriptions = new Map(rows.map((row) => [row.id, toStoreSubscription(row)]));
  return rows.length;
}
