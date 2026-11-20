import { Router } from 'express';
import { z } from 'zod';
import { createId, store } from '../data/store.js';
import { authenticate } from '../middleware/auth.js';
import {
  activeSubscriptionsForUser,
  persistPushSubscription,
  revokePushSubscription,
  subscriptionByEndpoint,
} from '../db/pushSubscriptionsRepo.js';
import { pushConfig } from '../services/pushNotifications.js';

/**
 * Customer app Web Push (2026-11-20, approved recommendation B1).
 *
 * A sibling router mounted at /api/v1 in server.js, so the paths read
 * /app/push/*. `authenticate` is applied PER ROUTE — never as a
 * router-wide use() — per the shared-prefix rule in ~/AGENTS.md.
 *
 * The opt-in contract:
 *   - GET  /app/push/status      — { available, publicKey, subscribed,
 *     subscriptions }: available is false whenever the VAPID keys are
 *     not configured on the server (the feature is cleanly OFF and
 *     the app hides its toggle — the pepper-console honesty idiom).
 *   - POST /app/push/subscribe   — body { subscription: { endpoint,
 *     keys: { p256dh, auth } }, userAgent? }. Stores the device
 *     subscription for the SIGNED-IN account only. An endpoint is one
 *     device: re-subscribing an endpoint this account already holds
 *     refreshes its keys; an endpoint held by another account is
 *     reassigned to the signer (the newest sign-in on a shared device
 *     owns its notifications). 503 while push is not configured.
 *   - POST /app/push/unsubscribe — body { endpoint }. Revokes the
 *     caller's OWN subscription for that device; another account's
 *     endpoint answers 404, exactly like it doesn't exist.
 *
 * Subscriptions are per-device: one account can hold several (phone,
 * tablet, desktop), and booking pushes fan out to all of them.
 */
const router = Router();

const subscribeSchema = z.object({
  subscription: z.object({
    endpoint: z.string().trim().url().max(2048),
    keys: z.object({
      p256dh: z.string().trim().min(1).max(512),
      auth: z.string().trim().min(1).max(512),
    }),
  }),
  userAgent: z.string().trim().max(400).optional(),
});

const unsubscribeSchema = z.object({
  endpoint: z.string().trim().url().max(2048),
});

function statusFor(userId) {
  const config = pushConfig();
  const mine = activeSubscriptionsForUser(userId);
  return {
    available: config.available,
    publicKey: config.available ? config.publicKey : null,
    subscribed: mine.length > 0,
    subscriptions: mine.length,
  };
}

router.get('/app/push/status', authenticate, (req, res) => {
  return res.json({ data: statusFor(req.user.id) });
});

router.post('/app/push/subscribe', authenticate, async (req, res) => {
  const config = pushConfig();
  if (!config.available) {
    return res.status(503).json({ error: 'push_not_configured', available: false });
  }
  const parsed = subscribeSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid push subscription', details: parsed.error.flatten() });
  }
  const { endpoint, keys } = parsed.data.subscription;
  if (!endpoint.startsWith('https://')) {
    return res.status(400).json({ error: 'Push endpoint must be an https URL' });
  }
  const userAgent = parsed.data.userAgent || String(req.headers['user-agent'] || '').slice(0, 400) || null;

  const existing = subscriptionByEndpoint(endpoint);
  let record;
  if (existing) {
    // Refresh / reassign: same device, newest sign-in owns it, and a
    // re-subscribe always clears a prior revocation.
    record = {
      ...existing,
      userId: req.user.id,
      p256dh: keys.p256dh,
      auth: keys.auth,
      userAgent,
      revokedAt: null,
    };
  } else {
    record = {
      id: createId(),
      userId: req.user.id,
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
      userAgent,
      createdAt: new Date().toISOString(),
      revokedAt: null,
    };
  }
  store.pushSubscriptions.set(record.id, record);
  await persistPushSubscription(record).catch((error) => {
    console.error(JSON.stringify({ level: 'error', message: 'push subscription persist failed', error: String(error?.message || error) }));
  });
  return res.status(existing ? 200 : 201).json({ data: { subscribed: true, subscriptionId: record.id, ...statusFor(req.user.id) } });
});

router.post('/app/push/unsubscribe', authenticate, async (req, res) => {
  const parsed = unsubscribeSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid unsubscribe request', details: parsed.error.flatten() });
  }
  const existing = subscriptionByEndpoint(parsed.data.endpoint);
  // Own-only: another account's subscription is indistinguishable
  // from one that doesn't exist.
  if (!existing || existing.userId !== req.user.id) {
    return res.status(404).json({ error: 'Subscription not found' });
  }
  await revokePushSubscription(existing.id);
  return res.json({ data: { subscribed: activeSubscriptionsForUser(req.user.id).length > 0, ...statusFor(req.user.id) } });
});

export default router;
