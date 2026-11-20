import { Router } from 'express';
import { z } from 'zod';
import { store } from '../data/store.js';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { ROLES, STAFF_ROLES } from '../config/security.js';
import {
  getNotificationSettings,
  notifyWhatsAppOfficeMessage,
  NOTIFICATION_SETTING_KEYS,
  whatsappEnabled,
} from '../services/notifications.js';
import { persistNotificationSetting } from '../db/notificationsRepo.js';
import { channelHealth, twilioTrialState } from '../services/senders.js';

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
    provider: entry.provider || null,
    providerId: entry.providerId || null,
    providerAttempts: entry.providerAttempts || null,
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

router.get('/notifications/health', ...staffOnly, async (req, res) => {
  const health = channelHealth({ smsTrial: await twilioTrialState() });
  // Fallback sentence per channel, from the live provider chain: a
  // configured fallback delivers when the primary hard-fails; an
  // unconfigured one is stated plainly so nobody assumes it exists.
  const chainNote = (chain, fallbackProvider, fallbackKeys) => {
    const fallback = (chain || []).find((p) => p.provider === fallbackProvider);
    if (!fallback) return '';
    return fallback.configured
      ? ` ${fallbackProvider} fallback is configured — it delivers when the primary provider hard-fails (provider-side errors only, never for a bad recipient).`
      : ` ${fallbackProvider} fallback is NOT configured (no ${fallbackKeys} in the API environment) — the primary is the only route on this channel.`;
  };
  return res.json({
    data: {
      email: {
        ...health.email,
        note: (health.email.configured
          ? (health.email.fromVerifiedDomain
            ? 'Sends from the verified updates subdomain.'
            : 'WARNING: the From address is not on the verified updates subdomain — Resend rejects sends from unverified domains (topspeedappliance.net failed SPF/DKIM). Set EMAIL_FROM to service@updates.topspeedapplianceservice.com in the API environment.')
          : 'RESEND_API_KEY is not set in the API environment — email entries gate as RESEND_NOT_CONFIGURED.')
          + chainNote(health.email.chain, 'sendgrid', 'SENDGRID_API_KEY'),
      },
      sms: {
        ...health.sms,
        note: (health.sms.configured
          ? (health.sms.trial === true
            ? 'Credentials are present, but Twilio reports this account as a TRIAL: texts only reach verified recipient numbers, and the account balance must be positive. Trial/failed sends are recorded as FAILED with the provider error — never as sent. Full SMS goes live when the account is upgraded.'
            : health.sms.trial === false
              ? 'Twilio reports this account as a FULL (upgraded) account: texts can send to any valid number. Sends are recorded SENT only when Twilio accepts them; failures are recorded FAILED with the provider error — never as sent. (US toll-free numbers also need their Twilio messaging verification approved for reliable delivery.)'
              : 'Credentials are present; Twilio could not confirm the account type just now, so no trial state is claimed. Sends are recorded SENT only when Twilio accepts them; failures are recorded FAILED with the provider error — never as sent.')
          : 'Twilio credentials are not set in the API environment — SMS entries gate as TWILIO_NOT_CONFIGURED.')
          + chainNote(health.sms.chain, 'vonage', 'VONAGE_API_KEY + VONAGE_API_SECRET'),
      },
      whatsapp: {
        ...health.whatsapp,
        enabled: getNotificationSettings().whatsappEnabled === true,
        note: getNotificationSettings().whatsappEnabled !== true
          ? 'WhatsApp is OFF — the owner flag (whatsappEnabled) is off, so no WhatsApp entries are queued at all. Activation is Ramone\u2019s: Meta WhatsApp Business setup (number + utility-template approval) first, then the owner flips the flag in these settings.'
          : health.whatsapp.configured
            ? 'WhatsApp is ON and the Meta Cloud API is configured: booking confirmations and appointment reminders also send as Meta utility templates, and office replies (POST /notifications/whatsapp/send) send as session texts — Meta delivers those only inside the 24-hour window after the customer\u2019s own message; rejections record FAILED with Meta\u2019s error.'
            : 'The owner flag is ON but WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN are not set in the API environment — WhatsApp entries queue and gate as WHATSAPP_NOT_CONFIGURED until the Meta setup lands.',
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
  whatsappEnabled: z.boolean().optional(),
}).strict();

router.put('/notifications/settings', ...staffOnly, async (req, res) => {
  const parsed = settingsSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid settings', details: parsed.error.flatten() });
  }
  // The WhatsApp flag is the OWNER's switch (F7): staff may flip the
  // alert toggles, but turning a whole customer channel on or off is
  // reserved to the owner tier (COMPANY_OWNER / PLATFORM_ADMIN) —
  // Rule Zero posture, same as the other platform activations.
  if (parsed.data.whatsappEnabled !== undefined
    && parsed.data.whatsappEnabled !== getNotificationSettings().whatsappEnabled) {
    const roles = req.user?.roles || [];
    if (!roles.includes(ROLES.COMPANY_OWNER) && !roles.includes(ROLES.PLATFORM_ADMIN)) {
      return res.status(403).json({ error: 'whatsapp_owner_only', message: 'The WhatsApp channel flag can only be changed by the owner.' });
    }
  }
  for (const key of NOTIFICATION_SETTING_KEYS) {
    if (parsed.data[key] !== undefined) {
      await persistNotificationSetting(key, parsed.data[key], req.user?.email || null);
    }
  }
  return res.json({ data: getNotificationSettings() });
});

/* ------------------------------------------------------------------ */
/* WhatsApp office reply (F7, 2026-11-20). A staff member answers a   */
/* customer on WhatsApp: the message queues as a free-form session    */
/* text through the same outbox as everything else (Meta delivers     */
/* session texts only inside the 24-hour window after the customer's  */
/* own message — outside it the entry records FAILED with Meta's      */
/* error, never a fake send). With the owner flag off the channel     */
/* does not exist: a plain 403, nothing queued.                       */
/* ------------------------------------------------------------------ */
const whatsappSendSchema = z.object({
  to: z.string().trim().min(7).max(32),
  body: z.string().trim().min(1).max(1000),
  reference: z.string().trim().max(64).optional(),
}).strict();

router.post('/notifications/whatsapp/send', ...staffOnly, (req, res) => {
  if (!whatsappEnabled()) {
    return res.status(403).json({ error: 'whatsapp_disabled', message: 'WhatsApp is off — the owner has not activated the channel.' });
  }
  const parsed = whatsappSendSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid WhatsApp message', details: parsed.error.flatten() });
  }
  const entry = notifyWhatsAppOfficeMessage({
    to: parsed.data.to,
    body: parsed.data.body,
    reference: parsed.data.reference || null,
    source: 'NOTIFICATIONS_CONSOLE',
  });
  return res.status(201).json({ data: publicEntry(entry) });
});

export default router;
