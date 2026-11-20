import { sendNotification, setVapidDetails } from 'web-push';
import { revokePushSubscription, subscriptionById } from '../db/pushSubscriptionsRepo.js';

/**
 * Web Push delivery — the third channel of the notification outbox
 * (2026-11-20, approved recommendation B1: push notifications in the
 * customer app).
 *
 * Push rides the SAME outbox as email/SMS: services/notifications.js
 * queues channel:'push' entries beside the email/SMS entries for a
 * booking event, and services/senders.js deliverEntry routes them
 * here. Statuses keep the outbox's truthful discipline — an entry is
 * SENT only when the push service accepted it.
 *
 * Configuration is env-only: VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY
 * (generate a pair with: npx web-push generate-vapid-keys). When
 * either is unset the feature is cleanly OFF — pushConfig() reports
 * { available: false }, the /app subscribe endpoints refuse with
 * 503, the customer app hides its opt-in toggle, and any queued push
 * entry gates as VAPID_NOT_CONFIGURED instead of pretending to send.
 * Keys are NEVER hardcoded or committed.
 *
 * Dead subscriptions self-clean: when the push service answers 404
 * or 410 the subscription is gone (browser removed, permission
 * revoked, app uninstalled), so the row is revoked at delivery time
 * and never sent to again. Every failure path is fail-soft — a push
 * problem can never break the booking flow that queued it.
 *
 * Test seam (the RESEND_API_BASE / TWILIO_API_BASE idiom): when
 * WEB_PUSH_STUB_URL is set, delivery POSTs { endpoint, payload } to
 * that local stub instead of the real push service, and the stub's
 * HTTP status decides the outcome (2xx sent, 404/410 gone, anything
 * else failed). Production never sets it.
 */

const DEFAULT_VAPID_SUBJECT = 'mailto:service@topspeedappliance.net';

export function pushConfig() {
  const publicKey = process.env.VAPID_PUBLIC_KEY || null;
  const privateKey = process.env.VAPID_PRIVATE_KEY || null;
  return {
    available: Boolean(publicKey && privateKey),
    publicKey,
    privateKey,
    subject: process.env.VAPID_SUBJECT || DEFAULT_VAPID_SUBJECT,
  };
}

export function pushAvailable() {
  return pushConfig().available;
}

let vapidAppliedFor = null;
function ensureVapid() {
  const config = pushConfig();
  if (!config.available) return false;
  const stamp = `${config.publicKey}:${config.subject}`;
  if (vapidAppliedFor !== stamp) {
    setVapidDetails(config.subject, config.publicKey, config.privateKey);
    vapidAppliedFor = stamp;
  }
  return true;
}

function devicePayload(entry) {
  const payload = entry.payload || {};
  return {
    title: payload.title || 'Top Speed Appliance',
    body: payload.body || payload.message || '',
    url: payload.url || '/app',
    tag: payload.tag || payload.referenceCode || 'booking-update',
    bookingId: payload.bookingId || null,
    referenceCode: payload.referenceCode || null,
  };
}

async function markSubscriptionGone(entry, subscription, why) {
  if (subscription) await revokePushSubscription(subscription.id);
  entry.status = 'FAILED';
  entry.reason = 'SUBSCRIPTION_GONE';
  entry.error = why;
  entry.provider = 'web-push';
  entry.providerId = null;
  return { result: 'failed', error: why, reason: entry.reason };
}

/**
 * Attempt delivery of one channel:'push' outbox entry. Mutates the
 * entry's status fields and returns the senders.js outcome shape.
 * Never throws — delivery problems land on the entry, not the caller.
 */
export async function deliverPushEntry(entry) {
  entry.attempts = (entry.attempts || 0) + 1;
  if (!ensureVapid()) {
    entry.status = 'GATED';
    entry.reason = 'VAPID_NOT_CONFIGURED';
    entry.error = null;
    return { result: 'gated', reason: entry.reason };
  }
  const subscription = entry.payload?.subscriptionId ? subscriptionById(entry.payload.subscriptionId) : null;
  if (!subscription) {
    return markSubscriptionGone(entry, null, 'Subscription record no longer exists');
  }
  if (subscription.revokedAt) {
    return markSubscriptionGone(entry, subscription, 'Subscription was revoked before delivery');
  }

  const payload = devicePayload(entry);
  const stubUrl = process.env.WEB_PUSH_STUB_URL || null;
  try {
    if (stubUrl) {
      const response = await fetch(stubUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: subscription.endpoint, subscriptionId: subscription.id, payload }),
      });
      if (response.status === 404 || response.status === 410) {
        return markSubscriptionGone(entry, subscription, `Push service reported the subscription gone (${response.status})`);
      }
      if (!response.ok) {
        throw new Error(`Push stub responded ${response.status}`);
      }
    } else {
      await sendNotification(
        { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
        JSON.stringify(payload),
        { TTL: 60 * 60 * 24 },
      );
    }
  } catch (error) {
    const statusCode = error?.statusCode || null;
    if (statusCode === 404 || statusCode === 410) {
      return markSubscriptionGone(entry, subscription, `Push service reported the subscription gone (${statusCode})`);
    }
    entry.status = 'FAILED';
    entry.provider = 'web-push';
    entry.providerId = null;
    entry.error = String(error?.message || error);
    return { result: 'failed', error: entry.error, provider: 'web-push' };
  }

  entry.status = 'SENT';
  entry.sentAt = new Date().toISOString();
  entry.provider = 'web-push';
  entry.providerId = null;
  entry.error = null;
  entry.reason = null;
  return { result: 'sent', provider: 'web-push' };
}
