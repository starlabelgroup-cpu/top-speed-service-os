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
 *           fallback: SendGrid (SENDGRID_API_KEY) when Resend hard-fails
 *   sms   → Twilio   (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER)
 *           fallback: Vonage (VONAGE_API_KEY + VONAGE_API_SECRET) when Twilio hard-fails
 *
 * Each channel delivers through an ordered provider chain: when a
 * provider fails provider-side (network, 5xx, auth, rate limit), the
 * next CONFIGURED provider is tried; a recipient-side validation
 * failure (4xx bad address/number) fails the entry at once — a
 * fallback cannot fix a bad destination. Unconfigured fallbacks are
 * skipped silently (no fallback existing is not an error). Entries
 * record the delivering provider (entry.provider + providerId); with
 * no provider configured on a channel, entries gate with the primary
 * provider's reason code.
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
  REFERRAL_INVITE: 'You have been invited to Top Speed Appliance',
  REFERRAL_BOOKED: 'Your friend booked with your Top Speed referral code',
  REFERRAL_COMPLETED: 'Your referral completed their Top Speed service',
  REFERRAL_REWARD_APPROVED: 'Your Top Speed referral reward credit is ready',
  REFERRAL_CREDIT_EXPIRING: 'Your Top Speed referral credit expires soon',
  REFERRAL_CREDIT_EXPIRED: 'Your Top Speed referral credit has expired',
  COMMERCIAL_WORK_ORDER_RECEIVED: 'Top Speed commercial work order received',
  PAYMENT_RECEIVED: 'Payment received — Top Speed Appliance',
  BOOKING_RECEIPT: 'Your Top Speed Appliance receipt',
  VIDEO_REQUEST: 'Your Top Speed video consultation',
  SUBMISSION_CONFIRMATION: 'Top Speed Appliance — we received your submission',
  STAFF_SUBMISSION_ALERT: 'Top Speed Appliance — new submission alert',
  ACCOUNT_WELCOME: 'Welcome to Top Speed Appliance',
  SIGNIN_LINK: 'Your Top Speed sign-in link',
  EMAIL_VERIFICATION: 'Verify your Top Speed Appliance account email',
  PHOTO_DIAGNOSIS: 'Your Top Speed photo diagnosis',
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

function sendgridConfig() {
  const apiKey = process.env['SENDGRID' + '_API_KEY'];
  return {
    configured: Boolean(apiKey),
    apiKey,
    from: process.env.EMAIL_FROM || 'Top Speed Appliance <service@topspeedappliance.net>',
    base: process.env['SENDGRID' + '_API_BASE'] || 'https://api.sendgrid.com',
  };
}

function vonageConfig() {
  const apiKey = process.env['VONAGE' + '_API_KEY'];
  const apiSecret = process.env['VONAGE' + '_API_SECRET'];
  return {
    configured: Boolean(apiKey && apiSecret),
    apiKey,
    apiSecret,
    from: process.env['VONAGE' + '_FROM'] || process.env.TWILIO_PHONE_NUMBER || '',
    base: process.env['VONAGE' + '_API_BASE'] || 'https://rest.nexmo.com',
  };
}

/** Bare email address out of a "Name <a@b>" sender identity. */
function extractEmailAddress(from) {
  const match = /<([^>]+)>/.exec(String(from || ''));
  return match ? match[1].trim() : String(from || '').trim();
}

/**
 * The ordered delivery chain per channel. A provider joins the chain
 * only when its credentials are configured — the fallback adapters
 * ship dark and are skipped silently until their keys exist.
 */
function emailChain() {
  return [
    { name: 'resend', configured: resendConfig().configured, send: sendEmail },
    { name: 'sendgrid', configured: sendgridConfig().configured, send: sendEmailViaSendGrid },
  ];
}

function smsChain() {
  return [
    { name: 'twilio', configured: twilioConfig().configured, send: sendSms },
    { name: 'vonage', configured: vonageConfig().configured, send: sendSmsViaVonage },
  ];
}

/** True when at least one provider on the channel is configured. */
export function channelConfigured(channel) {
  const chain = channel === 'email' ? emailChain() : channel === 'sms' ? smsChain() : [];
  return chain.some((provider) => provider.configured);
}

/**
 * The full provider chain per channel, in delivery order, as
 * [{ provider, configured }] — configuration PRESENCE only.
 */
export function providersStatus() {
  const chainView = (providers) => providers.map(({ name, configured }) => ({ provider: name, configured }));
  return { email: chainView(emailChain()), sms: chainView(smsChain()) };
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
  const subject = entry.payload?.subject || SUBJECTS[entry.template] || 'Top Speed Appliance';
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
    const providerError = new Error(body?.message || `Resend error ${response.status}`);
    providerError.httpStatus = response.status;
    throw providerError;
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
    const providerError = new Error(body?.message || `Twilio error ${response.status}`);
    providerError.httpStatus = response.status;
    // Twilio 21211 / 21401 mean the destination number itself is
    // invalid — recipient-side, no fallback can fix it. Other errors
    // (e.g. 21608, the trial verified-numbers restriction) are
    // provider-side and fall through to the next provider.
    if (body?.code === 21211 || body?.code === 21401) providerError.validation = true;
    throw providerError;
  }
  return body.sid || null;
}

async function sendEmailViaSendGrid(entry) {
  const config = sendgridConfig();
  const subject = entry.payload?.subject || SUBJECTS[entry.template] || 'Top Speed Appliance';
  const text = entry.payload?.message || '';
  const response = await fetch(`${config.base}/v3/mail/send`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + config.apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: entry.to }] }],
      from: { email: extractEmailAddress(config.from), name: 'Top Speed Appliance' },
      subject,
      content: [{ type: 'text/plain', value: text }],
    }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const providerError = new Error(body?.errors?.[0]?.message || `SendGrid error ${response.status}`);
    providerError.httpStatus = response.status;
    throw providerError;
  }
  return response.headers.get('x-message-id') || null;
}

async function sendSmsViaVonage(entry) {
  const config = vonageConfig();
  const response = await fetch(`${config.base}/sms/json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: config.apiKey,
      api_secret: config.apiSecret,
      from: config.from,
      to: normalizePhone(entry.to).replace(/^\+/, ''),
      text: entry.payload?.message || '',
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const providerError = new Error(body?.['error-text'] || `Vonage error ${response.status}`);
    providerError.httpStatus = response.status;
    throw providerError;
  }
  const message = body?.messages?.[0];
  if (!message || String(message.status) !== '0') {
    const providerError = new Error(message?.['error-text'] || 'Vonage rejected the message');
    // Vonage status 6 = invalid destination number: recipient-side.
    if (String(message?.status) === '6') providerError.validation = true;
    throw providerError;
  }
  return message['message-id'] || null;
}

/**
 * Whether a provider failure is recipient-side (bad address/number).
 * Those fail the entry immediately — no fallback provider can deliver
 * to an invalid destination. Everything else (network errors, 5xx,
 * auth 401/403, rate limit 429, provider restrictions) is
 * provider-side and falls through to the next configured provider.
 */
function isValidationFailure(error) {
  if (error?.validation === true) return true;
  if (error?.validation === false) return false;
  const status = error?.httpStatus;
  if (!status) return false;
  if (status === 401 || status === 403 || status === 429) return false;
  return status >= 400 && status < 500;
}

/** Attempt delivery of one outbox entry. Mutates the entry's status fields. */
export async function deliverEntry(entry) {
  const isEmail = entry.channel === 'email';
  const isSms = entry.channel === 'sms';
  if (!isEmail && !isSms) {
    // Internal feed entries (Service Setters' in-platform queue) are
    // never routed to a provider — they exist only in the outbox.
    return { result: 'skipped', reason: `channel ${entry.channel} is an internal feed entry` };
  }
  const chain = (isEmail ? emailChain() : smsChain()).filter((provider) => provider.configured);
  if (!chain.length) {
    // Truthful gating: with no provider configured on the channel, the
    // entry stays on record as GATED with the primary provider's
    // machine-readable reason — never marked sent, never dropped.
    entry.status = 'GATED';
    entry.reason = isEmail ? 'RESEND_NOT_CONFIGURED' : 'TWILIO_NOT_CONFIGURED';
    entry.error = null;
    return { result: 'gated', reason: entry.reason };
  }

  entry.attempts = (entry.attempts || 0) + 1;
  const tried = [];
  let lastError = null;
  let lastProvider = null;
  for (const provider of chain) {
    try {
      const providerId = await provider.send(entry);
      entry.status = 'SENT';
      entry.sentAt = new Date().toISOString();
      entry.provider = provider.name;
      entry.providerId = providerId;
      entry.error = null;
      entry.reason = null;
      if (tried.length) entry.providerAttempts = tried;
      return { result: 'sent', providerId, provider: provider.name };
    } catch (error) {
      lastError = error;
      lastProvider = provider.name;
      tried.push({ provider: provider.name, error: String(error?.message || error) });
      // A bad recipient fails at once — fallback cannot fix it.
      if (isValidationFailure(error)) break;
    }
  }
  entry.status = 'FAILED';
  entry.provider = lastProvider;
  entry.providerId = null;
  entry.error = String(lastError?.message || lastError);
  if (tried.length > 1) entry.providerAttempts = tried;
  return { result: 'failed', error: entry.error, provider: lastProvider };
}

const QUEUED_STATUSES = new Set(['QUEUED_SIMULATED', 'QUEUED']);

/** Deliver every queued outbox entry whose provider is configured. */
export async function drainOutbox() {
  const summary = { sent: 0, failed: 0, skipped: 0, gated: 0 };
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

/**
 * Deliver a specific batch of entries — used by the opportunistic
 * on-queue drain in services/notifications.js so alerts follow new
 * submissions immediately, without touching the historical backlog.
 */
export async function drainEntries(entries) {
  const summary = { sent: 0, failed: 0, skipped: 0, gated: 0 };
  for (const entry of entries || []) {
    if (!QUEUED_STATUSES.has(entry.status)) continue;
    const outcome = await deliverEntry(entry);
    await persistNotification(entry).catch(() => {});
    summary[outcome.result] = (summary[outcome.result] || 0) + 1;
  }
  return summary;
}

/**
 * Channel health for the staff Notifications console: configuration
 * PRESENCE only — no secret values ever leave the server. The email
 * `from` address is public sender identity, so it is reported as-is;
 * `fromVerifiedDomain` flags whether sends originate from the
 * SPF/DKIM-verified updates subdomain (the .net domain failed
 * verification, so a From on it means Resend will reject the send).
 * The SMS trial flag reflects the known account state: Ramone's
 * Twilio account is a trial (sends only reach verified numbers) until
 * he upgrades it — presence of credentials does not change that.
 */
export function channelHealth() {
  const email = resendConfig();
  const sms = twilioConfig();
  const eChain = emailChain();
  const sChain = smsChain();
  const chainView = (providers) => providers.map(({ name, configured }) => ({ provider: name, configured }));
  return {
    email: {
      provider: 'resend',
      configured: eChain.some((provider) => provider.configured),
      from: email.from,
      fromVerifiedDomain: /@updates\.topspeedapplianceservice\.com>?\s*$/.test(email.from || ''),
      chain: chainView(eChain),
    },
    sms: {
      provider: 'twilio',
      configured: sChain.some((provider) => provider.configured),
      from: sms.from || null,
      trial: true,
      chain: chainView(sChain),
    },
  };
}
