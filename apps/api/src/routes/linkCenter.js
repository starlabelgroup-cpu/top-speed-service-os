import { Router } from 'express';
import { z } from 'zod';
import { store } from '../data/store.js';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { STAFF_ROLES } from '../config/security.js';
import { NOTIFICATION_TEMPLATES, queueNotification } from '../services/notifications.js';
import { channelHealth, drainEntries, twilioTrialState } from '../services/senders.js';
import { LINK_CATALOG, LINK_TYPES, composeLinkMessage, resolveLinkUrl } from '../services/linkCenter.js';

/**
 * Link Center API (Ramone, 2026-11-18: "send links to SMS, email for
 * payment, booking, accounts, reviews") — the staff side of
 * topspeedserviceos.com/link-center.
 *
 * Every send is a human click in the console; there is no automatic
 * or bulk path. Sends queue through the notification outbox and this
 * route awaits one delivery attempt, so the response carries the
 * entry's TRUE state: SENT only when the provider accepted, FAILED
 * with the provider's error (e.g. a Twilio rejection), GATED when the
 * channel is not configured. Nothing pretends to send.
 */
const router = Router();

const staffOnly = [authenticate, requireCompany, requireRole(...STAFF_ROLES)];

router.get('/link-center/options', ...staffOnly, async (req, res) => {
  const health = channelHealth({ smsTrial: await twilioTrialState() });
  return res.json({
    data: {
      links: LINK_CATALOG,
      channels: {
        EMAIL: { configured: health.email.configured, provider: health.email.provider },
        // trial is Twilio's own report (true/false), or null when the
        // account type could not be confirmed — never a hardcoded guess.
        SMS: { configured: health.sms.configured, provider: health.sms.provider, trial: health.sms.trial },
      },
    },
  });
});

const sendSchema = z.object({
  linkType: z.enum([LINK_TYPES.BOOKING, LINK_TYPES.PAYMENT, LINK_TYPES.ACCOUNT, LINK_TYPES.REVIEW]),
  channel: z.enum(['EMAIL', 'SMS']),
  recipientName: z.string().trim().max(120).optional().nullable(),
  email: z.string().trim().email().max(200).optional().nullable(),
  phone: z.string().trim().max(40).optional().nullable(),
  bookingRef: z.string().trim().max(40).optional().nullable(),
});

router.post('/link-center/send', ...staffOnly, async (req, res, next) => {
  try {
    const parsed = sendSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid send request', details: parsed.error.flatten() });
    }
    const { linkType, channel, recipientName, email, phone, bookingRef } = parsed.data;

    if (linkType === LINK_TYPES.PAYMENT && !bookingRef) {
      return res.status(400).json({ error: 'bookingRef_required', message: 'A payment link needs the booking reference (e.g. TS-XXXXXX).' });
    }
    if (channel === 'EMAIL' && !email) {
      return res.status(400).json({ error: 'email_required', message: 'An email address is required for an email send.' });
    }
    if (channel === 'SMS') {
      const digits = String(phone || '').replace(/\D/g, '');
      if (digits.length < 10) {
        return res.status(400).json({ error: 'phone_required', message: 'A valid phone number is required for a text send.' });
      }
    }

    // Resolve the destination. PAYMENT mints/reuses the booking's real
    // Stripe checkout; a missing booking or unconfigured payments is an
    // honest error — never an invented URL.
    let resolved;
    try {
      resolved = await resolveLinkUrl(linkType, { bookingRef });
    } catch (error) {
      if (error?.code === 'stripe_error') return res.status(502).json({ error: 'stripe_error', message: error.message });
      if (error?.status) return res.status(error.status).json({ error: error.code || 'link_resolution_failed', message: error.message });
      throw error;
    }
    if (resolved.booking && resolved.booking.companyId !== req.companyId) {
      return res.status(404).json({ error: 'booking_not_found', message: 'No booking found with that reference.' });
    }

    const outChannel = channel === 'EMAIL' ? 'email' : 'sms';
    const to = channel === 'EMAIL' ? email : phone;
    const { subject, message } = composeLinkMessage({
      linkType,
      channel: outChannel,
      recipientName,
      url: resolved.url,
      booking: resolved.booking,
    });

    const entry = queueNotification({
      channel: outChannel,
      template: NOTIFICATION_TEMPLATES.LINK_SEND,
      to,
      source: 'link-center',
      eventType: 'LINK_CENTER',
      payload: {
        linkType,
        linkUrl: resolved.url,
        bookingRef: bookingRef || null,
        bookingId: resolved.booking?.id || null,
        paymentId: resolved.paymentId || null,
        recipientName: recipientName || null,
        sentBy: req.user?.email || null,
        subject,
        message,
      },
    });

    // One immediate delivery attempt (the same drain the password-reset
    // flow awaits), so the console reports the true outcome of THIS
    // send. The opportunistic background drain skips non-QUEUED
    // entries, so this cannot double-send.
    await drainEntries([entry]).catch(() => {});

    return res.status(201).json({
      data: {
        id: entry.id,
        linkType,
        channel,
        to,
        url: resolved.url,
        bookingRef: bookingRef || null,
        reused: resolved.reused || false,
        status: entry.status,
        reason: entry.reason || null,
        error: entry.error || null,
        provider: entry.provider || null,
        providerId: entry.providerId || null,
        sentAt: entry.sentAt || null,
        createdAt: entry.createdAt,
      },
    });
  } catch (error) {
    return next(error);
  }
});

function maskRecipient(entry) {
  const to = String(entry.to || '');
  if (entry.channel === 'email') {
    const at = to.indexOf('@');
    if (at > 0) {
      const local = to.slice(0, at);
      const shown = local.length <= 2 ? `${local.slice(0, 1)}***` : `${local.slice(0, 2)}***`;
      return `${shown}${to.slice(at)}`;
    }
    return '***';
  }
  const digits = to.replace(/\D/g, '');
  return digits.length >= 4 ? `***${digits.slice(-4)}` : '***';
}

function publicLogEntry(entry) {
  return {
    id: entry.id,
    linkType: entry.payload?.linkType || null,
    channel: entry.channel === 'email' ? 'EMAIL' : entry.channel === 'sms' ? 'SMS' : entry.channel,
    to: maskRecipient(entry),
    recipientName: entry.payload?.recipientName || null,
    bookingRef: entry.payload?.bookingRef || null,
    url: entry.payload?.linkUrl || null,
    status: entry.status,
    reason: entry.reason || null,
    error: entry.error || null,
    provider: entry.provider || null,
    sentBy: entry.payload?.sentBy || null,
    sentAt: entry.sentAt || null,
    createdAt: entry.createdAt,
  };
}

router.get('/link-center/log', ...staffOnly, (req, res) => {
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 200);
  const entries = [...store.notificationOutbox]
    .reverse()
    .filter((entry) => entry.eventType === 'LINK_CENTER' || entry.template === NOTIFICATION_TEMPLATES.LINK_SEND);
  return res.json({ data: entries.slice(0, limit).map(publicLogEntry), total: entries.length, limit });
});

export default router;
