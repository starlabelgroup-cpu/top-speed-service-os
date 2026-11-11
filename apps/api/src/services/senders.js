import { store } from '../data/store.js';
import { persistNotification } from '../db/flywheelRepo.js';

/**
 * Notification senders — the live drain for the notification outbox.
 *
 * services/notifications.js queues every customer message (booking
 * confirmation, reminder, tech en route, review request, ...) into
 * store.notificationOutbox with a ready-to-send `payload.message`. This
 * module delivers those entries through the real providers:
 *
 *   email → Resend   (RESEND_API_KEY, EMAIL_FROM)
 *   sms   → Twilio   (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER)
 *
 * With a provider unconfigured, its entries stay queued — nothing is lost
 * and nothing pretends to send. Delivery is triggered by
 * POST /notifications/send (staff) or GET /notifications/cron-drain
 * (Vercel Cron, CRON_SECRET-guarded). Entries record SENT/FAILED with the
 * provider's message id or the error, and stay visible in the outbox.
 */

const SUBJECTS = {
  BOOKING_CONFIRMATION: 'Your Top Speed Appliance booking is confirmed',
  APPOINTMENT_REMINDER: 'Reminder: your Top Speed appointment is tomorrow',
  TECH_EN_ROUTE: 'Your Top Speed technician is on the way',
  TRACKING_UPDATE: 'An update on your Top Speed service visit',
  DISPATCH_MATCHED: 'We are assigning your Top Speed technician',
  DISPATCH_APPROVED: 'Your Top Speed technician is assigned',
  REVIEW_REQUEST: 'How did we do? Review your Top Speed service',
  REFERRAL_CODE: 'Your Top Speed Appliance referral code',
  COMMERCIAL_WORK_ORDER_RECEIVED: 'Top Speed commercial work order received',
  PAYMENT_RECEIVED: 'Payment received — Top Speed Appliance',
};

function resendConfig() {
  return {
    configured: Boolean(process.env.RESEND_API_KEY),
    apiKey: process.env.RESEND_API_KEY,
    from: process.env.EMAIL_FROM || 'Top Speed Appliance <service@topspeedappliance.net>',
    base: process.env.RESEND_API_BASE || 'https://api.resend.com',
  };
}

function twilioConfig() {
  return {
    configured: Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER),
    sid: process.env.TWILIO_ACCOUNT_SID,
    token: process.env.TWILIO_AUTH_TOKEN,
    from: process.env.TWILIO_PHONE_NUMBER,
    base: process.env.TWILIO_API_BASE || 'https://api.twilio.com',
  };
}

export function providersStatus() {
  return {
    email: { provider: 'resend', configured: resendConfig().configured },
    sms: { provider: 'twilio', configured: twilioConfig().configured },
  };
}

/** Normalize a US phone number to E.164 (+1XXXXXXXXXX) for Twilio. */
export function normalizePhone(to) {
  const digits = String(to || '').replace(/\D/g, '');
  if (String(to || '').trim().startsWith('+')) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return digits ? `+${digits}` : to;
}

async function sendEmail(entry) {
  const config = resendConfig();
  const subject = SUBJECTS[entry.template] || 'Top Speed Appliance';
  const text = entry.payload?.message || '';
  const response = await fetch(`${config.base}/emails`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: config.from, to: [entry.to], subject, text }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.message || `Resend error ${response.status}`);
  }
  return body.id || null;
}

async function sendSms(entry) {
  const config = twilioConfig();
  const form = new URLSearchParams({
    From: config.from,
    To: normalizePhone(entry.to),
    Body: entry.payload?.message || '',
  });
  const response = await fetch(`${config.base}/2010-04-01/Accounts/${config.sid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.sid}:${config.token}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.message || `Twilio error ${response.status}`);
  }
  return body.sid || null;
}

/** Attempt delivery of one outbox entry. Mutates the entry's status fields. */
export async function deliverEntry(entry) {
  const isEmail = entry.channel === 'email';
  const configured = isEmail ? resendConfig().configured : twilioConfig().configured;
  if (!configured) return { result: 'skipped', reason: `${isEmail ? 'Resend' : 'Twilio'} not configured` };

  entry.attempts = (entry.attempts || 0) + 1;
  try {
    const providerId = isEmail ? await sendEmail(entry) : await sendSms(entry);
    entry.status = 'SENT';
    entry.sentAt = new Date().toISOString();
    entry.providerId = providerId;
    entry.error = null;
    return { result: 'sent', providerId };
  } catch (error) {
    entry.status = 'FAILED';
    entry.error = String(error?.message || error);
    return { result: 'failed', error: entry.error };
  }
}

const QUEUED_STATUSES = new Set(['QUEUED_SIMULATED', 'QUEUED']);

/** Deliver every queued outbox entry whose provider is configured. */
export async function drainOutbox() {
  const summary = { sent: 0, failed: 0, skipped: 0 };
  for (const entry of store.notificationOutbox) {
    if (!QUEUED_STATUSES.has(entry.status)) continue;
    const outcome = await deliverEntry(entry);
    // Persist the delivery outcome (SENT/FAILED + provider id) so the
    // outbox record in the database matches what actually happened.
    await persistNotification(entry).catch(() => {});
    summary[outcome.result] = (summary[outcome.result] || 0) + 1;
  }
  return summary;
}
