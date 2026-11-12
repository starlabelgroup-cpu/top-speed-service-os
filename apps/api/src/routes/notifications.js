import { Router } from 'express';
import { z } from 'zod';
import { store } from '../data/store.js';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { STAFF_ROLES } from '../config/security.js';
import {
  getNotificationSettings,
  NOTIFICATION_SETTING_KEYS,
} from '../services/notifications.js';
import { persistNotificationSetting } from '../db/notificationsRepo.js';
import { channelHealth } from '../services/senders.js';

/**
 * Notifications console API — the staff view of the unified email/SMS
 * alerts system. The legacy outbox/send/cron-drain endpoints live in
 * routes/integrations.js and are unchanged; this router adds the
 * console's list, summary, channel health, and settings.
 *
 * Health reports configuration PRESENCE only (booleans + the public
 * sender identity) — secret values never leave the server.
 */
const router = Router();

const staffOnly = [authenticate, requireCompany, requireRole(...STAFF_ROLES)];

function publicEntry(entry) {
  return {
    id: entry.id,
    channel: entry.channel,
    template: entry.template,
    to: entry.to,
    status: entry.status,
    reason: entry.reason || null,
    eventType: entry.eventType || entry.payload?.kind || null,
    reference: entry.payload?.referenceCode || entry.payload?.reference || null,
    subject: entry.payload?.subject || null,
    message: entry.payload?.message || null,
    attempts: entry.attempts || 0,
    providerId: entry.providerId || null,
    error: entry.error || null,
    sentAt: entry.sentAt || null,
    createdAt: entry.createdAt,
    source: entry.source || null,
  };
}

router.get('/notifications', ...staffOnly, (req, res) => {
  const { status, channel, template, eventType } = req.query;
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 100, 1), 500);
  const offset = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0);
  let entries = [...store.notificationOutbox].reverse();
  if (status) entries = entries.filter((entry) => entry.status === status);
  if (channel) entries = entries.filter((entry) => entry.channel === channel);
  if (template) entries = entries.filter((entry) => entry.template === template);
  if (eventType) entries = entries.filter((entry) => (entry.eventType || entry.payload?.kind) === eventType);
  const total = entries.length;
  return res.json({ data: entries.slice(offset, offset + limit).map(publicEntry), total, limit, offset });
});

router.get('/notifications/summary', ...staffOnly, (req, res) => {
  const entries = store.notificationOutbox;
  const byStatus = {};
  const byChannel = {};
  const gatedReasons = {};
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  let last24h = 0;
  for (const entry of entries) {
    byStatus[entry.status] = (byStatus[entry.status] || 0) + 1;
    byChannel[entry.channel] = (byChannel[entry.channel] || 0) + 1;
    if (entry.status === 'GATED' && entry.reason) {
      gatedReasons[entry.reason] = (gatedReasons[entry.reason] || 0) + 1;
    }
    if (entry.createdAt && new Date(entry.createdAt).getTime() >= dayAgo) last24h += 1;
  }
  return res.json({
    data: {
      total: entries.length,
      byStatus,
      byChannel,
      gatedReasons,
      last24h,
      queued: (byStatus.QUEUED || 0) + (byStatus.QUEUED_SIMULATED || 0),
      sent: byStatus.SENT || 0,
      failed: byStatus.FAILED || 0,
      gated: byStatus.GATED || 0,
    },
  });
});

router.get('/notifications/health', ...staffOnly, (req, res) => {
  const health = channelHealth();
  return res.json({
    data: {
      email: {
        ...health.email,
        note: health.email.configured
          ? (health.email.fromVerifiedDomain
            ? 'Sends from the verified updates subdomain.'
            : 'WARNING: the From address is not on the verified updates subdomain — Resend rejects sends from unverified domains (topspeedappliance.net failed SPF/DKIM). Set EMAIL_FROM to service@updates.topspeedapplianceservice.com in the API environment.')
          : 'RESEND_API_KEY is not set in the API environment — email entries gate as RESEND_NOT_CONFIGURED.',
      },
      sms: {
        ...health.sms,
        note: health.sms.configured
          ? 'Credentials are present, but the Twilio account is on a TRIAL plan: texts only reach verified recipient numbers, and the account balance must be positive. Trial/failed sends are recorded as FAILED with the provider error — never as sent. Full SMS goes live when the account is upgraded.'
          : 'Twilio credentials are not set in the API environment — SMS entries gate as TWILIO_NOT_CONFIGURED.',
      },
      settings: getNotificationSettings(),
      processing: {
        model: 'Entries queue to the persisted outbox at submission time; this process attempts delivery of newly queued entries shortly after queueing (opportunistic drain). Staff can drain the full queue any time with POST /notifications/send, and GET /notifications/cron-drain (CRON_SECRET-guarded) serves external schedulers — no scheduler is configured in vercel.json today.',
      },
    },
  });
});

router.get('/notifications/settings', ...staffOnly, (req, res) => {
  return res.json({ data: getNotificationSettings() });
});

const settingsSchema = z.object({
  staffEmailAlerts: z.boolean().optional(),
  staffSmsAlerts: z.boolean().optional(),
  customerEmailConfirmations: z.boolean().optional(),
  customerSmsConfirmations: z.boolean().optional(),
}).strict();

router.put('/notifications/settings', ...staffOnly, async (req, res) => {
  const parsed = settingsSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid settings', details: parsed.error.flatten() });
  }
  for (const key of NOTIFICATION_SETTING_KEYS) {
    if (parsed.data[key] !== undefined) {
      await persistNotificationSetting(key, parsed.data[key], req.user?.email || null);
    }
  }
  return res.json({ data: getNotificationSettings() });
});

export default router;
