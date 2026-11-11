import { Router } from 'express';
import { z } from 'zod';
import { speedyChat, speedyDiagnose, speedyExtractBooking, speedyExtractBulk, speedyStatus } from '../services/speedy.js';
import { areasForZip, SERVICE_CITIES, SERVICE_ZIPS } from '../config/serviceAreas.js';
import { addBookingEvent, appendEvent, createId, createReferenceCode, PLATFORM_COMPANY_ID, store } from '../data/store.js';
import { persistBooking, persistCustomer } from '../db/bookingsRepo.js';
import { notifyBookingConfirmation } from '../services/notifications.js';

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
});

const diagnoseSchema = z.object({
  imageDataUrl: z
    .string()
    .regex(/^data:image\/(jpeg|jpg|png|webp);base64,/, 'imageDataUrl must be a base64 image data URL')
    .max(4_500_000)
    .optional(),
  imageUrl: z.string().url().max(2000).optional(),
  note: z.string().trim().max(500).optional(),
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

router.post('/speedy/chat', async (req, res) => {
  if (!speedyStatus().configured) return notConfigured(res);
  const parsed = chatSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid chat message', details: parsed.error.flatten() });
  }
  try {
    const result = await speedyChat(parsed.data);
    return res.json({ data: result });
  } catch (error) {
    return res.status(502).json({ error: 'Speedy had a hiccup — try again, or call (954) 931-7997', detail: String(error?.message || error) });
  }
});

router.post('/speedy/diagnose', async (req, res) => {
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
    return res.json({ data: result });
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
  source: z.enum(['SPEEDY_CHAT', 'WEB_FORM']).optional(),
});

router.post('/speedy/book', async (req, res) => {
  const parsed = guestBookingSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid booking', details: parsed.error.flatten() });
  }
  const { customer, city, zip, appliance, issue, preferredWindow, source } = parsed.data;
  const canonicalCity = SERVICE_CITIES.find((c) => c.toLowerCase() === city.toLowerCase());
  if (!canonicalCity) {
    return res.status(422).json({ error: 'City is outside the current service area', serviceCities: SERVICE_CITIES });
  }
  if (!SERVICE_ZIPS.has(zip)) {
    return res.status(422).json({ error: 'ZIP is outside the current service area', serviceCities: areasForZip(zip) });
  }

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
    city: canonicalCity,
    zip,
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
  addBookingEvent(booking, 'BOOKING_CREATED', booking.source === 'WEB_FORM' ? 'web-form' : 'speedy-chat', { diagnosticFee: 99, feeStatus: booking.feeStatus });
  store.bookings.set(booking.id, booking);
  await persistCustomer(customerRecord);
  await persistBooking(booking);
  appendEvent('BOOKING_CREATED', {
    source: booking.source,
    actor: booking.source === 'WEB_FORM' ? 'web-form' : 'speedy-chat',
    entityType: 'BOOKING',
    entityId: booking.id,
    referenceCode: booking.referenceCode,
    details: { appliance: booking.appliance, city: booking.city, status: booking.status },
  });
  notifyBookingConfirmation(booking, booking.source);

  return res.status(201).json({
    data: {
      referenceCode: booking.referenceCode,
      status: booking.status,
      city: booking.city,
      appliance: booking.appliance,
      preferredWindow: booking.preferredWindow,
      diagnosticFee: 99,
    },
  });
});
