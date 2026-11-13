import { Router } from 'express';
import { z } from 'zod';
import { speedyChat, speedyDiagnose, speedyExtractBooking, speedyExtractBulk, speedyStatus } from '../services/speedy.js';
import { normalizeCityName, resolveArea } from '../config/serviceAreas.js';
import { addBookingEvent, appendEvent, createId, createReferenceCode, PLATFORM_COMPANY_ID, store } from '../data/store.js';
import { persistBooking, persistCustomer } from '../db/bookingsRepo.js';
import { notifyBookingConfirmation, notifyBookingReceipt, notifyNewBooking } from '../services/notifications.js';
import { attributionFields, normalizeAttribution } from '../services/attribution.js';
import { attachReferralToBooking } from '../services/referrals.js';
import { providersStatus } from '../services/senders.js';
import { optionalAuthenticate } from '../middleware/auth.js';
import {
  captureBookingConversion,
  captureChatDiagnosis,
  captureChatExchange,
  captureSafely,
  normalizeChatSessionId,
} from '../services/chatCapture.js';

/**
 * Speedy AI endpoints — public on purpose: the website's Ask Speedy chat
 * serves signed-out customers. Guardrails: the global rate limit, strict
 * input caps, no account data is ever returned, and the OpenAI key stays
 * on the server. When OPENAI_API_KEY is not configured the endpoints say
 * so honestly (503) instead of faking an answer.
 */
const router = Router();

const historyTurn = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().trim().min(1).max(2000),
});

const chatSchema = z.object({
  message: z.string().trim().min(1, 'Message is required').max(2000),
  history: z.array(historyTurn).max(10).optional(),
  // Chat capture (services/chatCapture.js): a client-issued session id
  // + surface tag so the conversation lands in the database for staff
  // analysis. Both optional — a chat is never rejected over them.
  sessionId: z.string().trim().max(64).optional(),
  source: z.string().trim().max(40).optional(),
});

const diagnoseSchema = z.object({
  imageDataUrl: z
    .string()
    .regex(/^data:image\/(jpeg|jpg|png|webp);base64,/, 'imageDataUrl must be a base64 image data URL')
    .max(4_500_000)
    .optional(),
  imageUrl: z.string().url().max(2000).optional(),
  note: z.string().trim().max(500).optional(),
  sessionId: z.string().trim().max(64).optional(),
  source: z.string().trim().max(40).optional(),
}).refine((data) => data.imageDataUrl || data.imageUrl, {
  message: 'Provide imageDataUrl or imageUrl',
});

function notConfigured(res) {
  return res.status(503).json({
    error: 'Speedy is not configured yet',
    hint: 'Set OPENAI_API_KEY on the API server to enable the AI assistant.',
  });
}

router.get('/speedy/status', (req, res) => {
  return res.json({ data: speedyStatus() });
});

router.post('/speedy/chat', optionalAuthenticate, async (req, res) => {
  if (!speedyStatus().configured) return notConfigured(res);
  const parsed = chatSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid chat message', details: parsed.error.flatten() });
  }
  const { message, sessionId, source } = parsed.data;
  const userId = req.user?.id || null;
  try {
    const result = await speedyChat(parsed.data);
    // Capture AFTER the reply is composed, bounded + error-swallowed:
    // a capture failure can never break or noticeably slow the chat.
    const session = await captureSafely(() =>
      captureChatExchange({ sessionId, source, userId, userMessage: message, assistantReply: result.reply }),
    );
    return res.json({
      data: { ...result, sessionId: session?.id || normalizeChatSessionId(sessionId) || undefined },
    });
  } catch (error) {
    // The snag is itself analysis data (an unanswered exchange).
    await captureSafely(() =>
      captureChatExchange({ sessionId, source, userId, userMessage: message, error: true }),
    );
    return res.status(502).json({ error: 'Speedy had a hiccup — try again, or call (954) 931-7997', detail: String(error?.message || error) });
  }
});

router.post('/speedy/diagnose', optionalAuthenticate, async (req, res) => {
  if (!speedyStatus().configured) return notConfigured(res);
  const parsed = diagnoseSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid diagnosis request', details: parsed.error.flatten() });
  }
  try {
    const result = await speedyDiagnose({
      imageUrl: parsed.data.imageDataUrl || parsed.data.imageUrl,
      note: parsed.data.note || '',
    });
    // Record that a diagnosis happened in this chat session (+ the
    // note text). The image itself is never stored.
    const session = await captureSafely(() =>
      captureChatDiagnosis({
        sessionId: parsed.data.sessionId,
        source: parsed.data.source,
        userId: req.user?.id || null,
        note: parsed.data.note || '',
        reply: result.reply,
      }),
    );
    return res.json({
      data: { ...result, sessionId: session?.id || normalizeChatSessionId(parsed.data.sessionId) || undefined },
    });
  } catch (error) {
    return res.status(502).json({ error: 'Speedy could not read that photo — try again, or call (954) 931-7997', detail: String(error?.message || error) });
  }
});

export default router;

/* ------------- Conversation-first booking (customers only) -------------
 * The chat collects the details; the extractor structures them; the
 * customer taps confirm; THIS endpoint creates the real booking — the
 * same record, queue and notifications as the form path. Signed-in app
 * customers book through POST /bookings; this is the guest twin.
 */

const extractSchema = z.object({
  text: z.string().trim().min(3).max(8000),
});

router.post('/speedy/extract-booking', async (req, res) => {
  if (!speedyStatus().configured) return notConfigured(res);
  const parsed = extractSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid extraction request' });
  try {
    const data = await speedyExtractBooking(parsed.data.text);
    return res.json({ data });
  } catch (error) {
    return res.status(502).json({ error: 'Speedy could not read that yet — keep chatting, or call (954) 931-7997', detail: String(error?.message || error) });
  }
});

router.post('/speedy/extract-bulk', async (req, res) => {
  if (!speedyStatus().configured) return notConfigured(res);
  const parsed = extractSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid extraction request' });
  try {
    const data = await speedyExtractBulk(parsed.data.text);
    return res.json({ data });
  } catch (error) {
    return res.status(502).json({ error: 'Speedy could not sort that list yet — try splitting it into shorter lines', detail: String(error?.message || error) });
  }
});

const guestBookingSchema = z.object({
  customer: z.object({
    name: z.string().trim().min(2),
    phone: z.string().trim().min(7),
    email: z.string().email().optional(),
    address: z.string().trim().min(5).optional(),
  }),
  city: z.string().trim().min(2),
  zip: z.string().regex(/^\d{5}$/),
  appliance: z.string().trim().min(2),
  issue: z.string().trim().min(3),
  preferredWindow: z.string().trim().optional(),
  // Which coordinated booking surface created this: the Speedy chat or
  // the five-step Smart Booking form. Attribution only — same pipeline.
  source: z.enum(['SPEEDY_CHAT', 'WEB_FORM', 'FLAGSHIP_NET']).optional(),
  // ApplianceReferral: the referrer's personal TS-REF-XXXX code, when the
  // guest arrived through a referral link/invite. Normalized (trim +
  // uppercase) and resolved after the booking is created — an unknown
  // code never blocks a booking.
  referralCode: z.string().trim().max(32).transform((value) => value.toUpperCase()).optional(),
  // Chat capture: when this booking came out of a Speedy conversation,
  // the client passes the chat sessionId so the session is marked
  // converted in Chat Insights. Optional; never blocks a booking.
  sessionId: z.string().trim().max(64).optional(),
  // Finer-grained attribution (Fusion absorb Stage 3): landing page,
  // [via:] surface tag, UTM campaign fields. Optional — see
  // services/attribution.js for the accepted shapes.
  ...attributionFields,
});

router.post('/speedy/book', async (req, res) => {
  const parsed = guestBookingSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid booking', details: parsed.error.flatten() });
  }
  const { customer, city, zip, appliance, issue, preferredWindow, source } = parsed.data;
  const attribution = normalizeAttribution(parsed.data);
  // Service Book book-by-area: resolve the address into the area model
  // instead of rejecting at the border. Out-of-area requests are
  // recorded on the expansion waitlist — flagged, honestly messaged,
  // never promised service and never sent a booking confirmation with
  // service terms.
  const resolution = resolveArea({ city, zip });
  const canonicalCity = normalizeCityName(city) || resolution.area || city.trim();

  const customerRecord = {
    id: createId(),
    companyId: PLATFORM_COMPANY_ID,
    ...customer,
    city: canonicalCity,
    zip,
    createdAt: new Date().toISOString(),
  };
  store.customers.set(customerRecord.id, customerRecord);

  const booking = {
    id: createId(),
    companyId: PLATFORM_COMPANY_ID,
    customerId: customerRecord.id,
    customer: customerRecord,
    referenceCode: createReferenceCode(),
    source: source || 'SPEEDY_CHAT',
    ...(attribution ? { attribution } : {}),
    city: canonicalCity,
    zip,
    area: resolution.area,
    areaStatus: resolution.areaStatus,
    serviceAddress: customer.address || null,
    appliance,
    issue,
    preferredWindow: preferredWindow || null,
    diagnosticFee: 99,
    diagnosticFeeCurrency: 'USD',
    diagnosticFeeCreditedTowardRepair: true,
    feeStatus: 'collected_at_booking',
    status: 'PENDING_DISPATCH',
    dispatch: { mode: 'HYBRID', stage: 'AWAITING_MATCH', candidateProviderIds: [], assignmentIds: [] },
    history: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  addBookingEvent(booking, 'BOOKING_CREATED', booking.source === 'SPEEDY_CHAT' ? 'speedy-chat' : 'web-form', { diagnosticFee: 99, feeStatus: booking.feeStatus });
  addBookingEvent(booking, 'AREA_RESOLVED', 'service-book', {
    area: resolution.area,
    areaStatus: resolution.areaStatus,
    areaSource: resolution.areaSource,
    zipAreas: resolution.zipAreas,
  });
  store.bookings.set(booking.id, booking);
  await persistCustomer(customerRecord);
  await persistBooking(booking);
  appendEvent('BOOKING_CREATED', {
    source: booking.source,
    actor: booking.source === 'SPEEDY_CHAT' ? 'speedy-chat' : 'web-form',
    entityType: 'BOOKING',
    entityId: booking.id,
    referenceCode: booking.referenceCode,
    details: { appliance: booking.appliance, city: booking.city, area: booking.area, areaStatus: booking.areaStatus, status: booking.status },
  });
  if (booking.areaStatus !== 'OUT_OF_AREA') {
    notifyBookingConfirmation(booking, booking.source);
  }
  notifyNewBooking(booking, booking.source);
  // ApplianceReferral attribution: tag the booking + open the reward
  // track. Wrapped so a referral problem can never fail a booking.
  if (parsed.data.referralCode) {
    try {
      const result = await attachReferralToBooking({
        code: parsed.data.referralCode,
        booking,
        refereeCustomer: customerRecord,
        source: booking.source,
      });
      if (!result.attached) {
        console.error(JSON.stringify({ level: 'warn', message: 'referral attach skipped', reason: result.reason, code: parsed.data.referralCode }));
      }
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', message: 'referral attach failed', error: String(error?.message || error) }));
    }
  }

  // Chat Insights conversion: mark the originating Speedy session as
  // converted to this booking. Best-effort like every capture step.
  if (parsed.data.sessionId) {
    await captureSafely(() =>
      captureBookingConversion({ sessionId: parsed.data.sessionId, referenceCode: booking.referenceCode }),
    );
  }

  return res.status(201).json({
    data: {
      referenceCode: booking.referenceCode,
      status: booking.status,
      city: booking.city,
      area: booking.area,
      areaStatus: booking.areaStatus,
      appliance: booking.appliance,
      preferredWindow: booking.preferredWindow,
      diagnosticFee: 99,
      ...(booking.areaStatus === 'OUT_OF_AREA'
        ? {
            areaMessage:
              'That address is outside our current service area, so we have not booked a visit. We saved your request on our expansion list and will reach out if we start serving your area — no charge and no appointment has been made.',
          }
        : {}),
      ...(booking.areaStatus === 'AREA_REVIEW'
        ? {
            areaMessage:
              'We have your request. A Service Setter will confirm the exact service area for your address when they call to set your appointment.',
          }
        : {}),
    },
  });
});

/* ------------- Booking receipt / details by message (Phase D+) -------------
 * Verified exactly like public tracking: reference + the phone on the
 * booking. Email is real today (Resend via the outbox). SMS queues
 * through Twilio, but the account is a limited trial — the response
 * NEVER claims a text was sent; it says queued + not-guaranteed, or
 * plainly unavailable when Twilio is not configured.
 */
const receiptSchema = z.object({
  reference: z.string().trim().min(4).max(24),
  phone: z.string().trim().min(7).max(24),
  channel: z.enum(['email', 'sms']),
});

router.post('/speedy/send-receipt', async (req, res) => {
  const parsed = receiptSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid receipt request', details: parsed.error.flatten() });
  }
  const ref = parsed.data.reference.toUpperCase();
  const digits = (v) => String(v || '').replace(/\D/g, '').slice(-10);
  const booking = [...store.bookings.values()].find((b) => String(b.referenceCode || '').toUpperCase() === ref);
  if (!booking || digits(booking.customer?.phone) !== digits(parsed.data.phone)) {
    return res.status(404).json({ error: 'No booking found for that reference and phone number' });
  }
  const { channel } = parsed.data;
  if (channel === 'email') {
    if (!booking.customer?.email) {
      return res.status(422).json({ error: 'No email address is on file for this booking', canSms: Boolean(booking.customer?.phone) });
    }
    const entry = notifyBookingReceipt(booking, 'email', 'speedy-receipt');
    const masked = booking.customer.email.replace(/^(.).*(@.*)$/, '$1***$2');
    return res.status(202).json({
      data: { queued: Boolean(entry), channel: 'email', to: masked, status: 'queued', message: `Receipt queued to ${masked} \u2014 it should arrive within a few minutes.` },
    });
  }
  // SMS
  if (!providersStatus().sms.configured) {
    return res.status(200).json({
      data: { queued: false, channel: 'sms', unavailable: true, message: 'Texting isn\'t available yet \u2014 email is the reliable option for your receipt and tracking details.' },
    });
  }
  const entry = notifyBookingReceipt(booking, 'sms', 'speedy-receipt');
  return res.status(202).json({
    data: {
      queued: Boolean(entry),
      channel: 'sms',
      status: 'queued',
      message: 'Your text is queued \u2014 texting is still in limited trial mode, so delivery isn\'t guaranteed yet. If it doesn\'t arrive shortly, email always works.',
    },
  });
});
