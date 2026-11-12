import { Router } from 'express';
import { z } from 'zod';
import { areasForZip, SERVICE_CITIES, SERVICE_ZIPS } from '../config/serviceAreas.js';
import { INTAKE_SOURCES, PLATFORM_CONSTANTS, SURFACES } from '../config/platform.js';
import { ROLES, STAFF_ROLES } from '../config/security.js';
import { appendEvent, createId, createReferenceCode, store } from '../data/store.js';
import { persistBooking, persistCustomer } from '../db/bookingsRepo.js';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { notifyBookingConfirmation, notifyNewBooking, notifySubmission } from '../services/notifications.js';
import { drainOutbox, providersStatus } from '../services/senders.js';
import { sweepReferralCreditExpiry } from '../services/referrals.js';

/**
 * Referral credit expiry enforcement rides the outbox drains (Phase 2):
 * every staff drain and every cron drain first lapses stale referral
 * credits and queues their expiry/reminder notices, so the drain that
 * follows delivers them. A sweep failure never blocks the drain.
 */
async function sweepReferralExpiryQuietly() {
  try {
    return await sweepReferralCreditExpiry();
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', message: 'referral expiry sweep failed', error: String(error?.message || error) }));
    return null;
  }
}

const router = Router();

/**
 * Universal intake.
 *
 * ONE endpoint accepts work from every surface — both domains, the three
 * landing pages, the interim Google Form, and phone-entered records — and
 * normalizes it into the right record type:
 *
 *   BOOKING               -> a booking in the dispatch pipeline ($99 rules)
 *   PROVIDER_APPLICATION  -> a provider application for Service Setters review
 *   PM_LEAD               -> a property-manager lead for follow-up
 *
 * The record type is chosen explicitly via `type`, or inferred from the
 * payload/source (PROVIDER_LANDING -> application, PM_LANDING -> PM lead,
 * provider/PM fields present -> matching type, otherwise booking).
 *
 * Auth follows the starter's existing pattern (authenticate ->
 * requireCompany, demo auth locally). Production note: before this
 * endpoint is exposed publicly, each surface gets its own shared-secret
 * or signed-webhook credential; the payload contract stays the same.
 */

const listFromInput = (value) => {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean);
  return [];
};

const intakeSchema = z.object({
  source: z.enum(INTAKE_SOURCES),
  type: z.enum(['BOOKING', 'PROVIDER_APPLICATION', 'PM_LEAD']).optional(),
  // Contact (all record types)
  name: z.string().trim().min(2),
  phone: z.string().trim().min(7),
  email: z.string().email().optional(),
  // Booking fields
  appliance: z.string().trim().min(2).optional(),
  zip: z.string().regex(/^\d{5}$/).optional(),
  city: z.string().trim().min(2).optional(),
  issue: z.string().trim().min(3).optional(),
  address: z.string().trim().min(5).optional(),
  preferredWindow: z.string().trim().optional(),
  // Provider application fields
  businessName: z.string().trim().min(2).optional(),
  business: z.string().trim().min(2).optional(),
  serviceAreas: z.union([z.array(z.string()), z.string()]).optional(),
  areas: z.union([z.array(z.string()), z.string()]).optional(),
  appliances: z.union([z.array(z.string()), z.string()]).optional(),
  yearsInBusiness: z.union([z.number(), z.string()]).optional(),
  // Property-manager lead fields
  company: z.string().trim().min(2).optional(),
  units: z.union([z.number().int().positive(), z.string()]).optional(),
  message: z.string().trim().optional(),
});

function inferRecordType(data) {
  if (data.type) return data.type;
  const hasProviderFields = Boolean(data.businessName || data.business || data.serviceAreas || data.areas || data.appliances);
  const hasPmFields = Boolean(data.company || data.units);
  if (data.source === 'PROVIDER_LANDING' || hasProviderFields) return 'PROVIDER_APPLICATION';
  if (data.source === 'PM_LANDING' || hasPmFields) return 'PM_LEAD';
  return 'BOOKING';
}

async function createIntakeBooking(req, data, referenceCode) {
  const city = data.city || areasForZip(data.zip)[0];
  if (!city || !SERVICE_CITIES.includes(city)) {
    return { error: { status: 422, body: { error: 'City is outside the current service area', serviceCities: SERVICE_CITIES } } };
  }
  if (!SERVICE_ZIPS.has(data.zip)) {
    return { error: { status: 422, body: { error: 'ZIP is outside the current service area', serviceCities: areasForZip(data.zip) } } };
  }
  if (!data.appliance || !data.issue) {
    return { error: { status: 400, body: { error: 'Bookings require appliance and issue', source: data.source } } };
  }

  const customerRecord = {
    id: createId(),
    companyId: req.companyId,
    name: data.name,
    phone: data.phone,
    email: data.email,
    address: data.address,
    city,
    zip: data.zip,
    source: data.source,
    createdAt: new Date().toISOString(),
  };
  store.customers.set(customerRecord.id, customerRecord);

  const booking = {
    id: createId(),
    companyId: req.companyId,
    customerId: customerRecord.id,
    customer: customerRecord,
    referenceCode,
    source: data.source,
    city,
    zip: data.zip,
    appliance: data.appliance,
    issue: data.issue,
    preferredWindow: data.preferredWindow || null,
    diagnosticFee: PLATFORM_CONSTANTS.diagnosticFee,
    diagnosticFeeCurrency: PLATFORM_CONSTANTS.diagnosticFeeCurrency,
    diagnosticFeeCreditedTowardRepair: true,
    feeStatus: PLATFORM_CONSTANTS.feeStatus,
    status: 'PENDING_DISPATCH',
    dispatch: {
      mode: PLATFORM_CONSTANTS.dispatchMode,
      stage: 'AWAITING_MATCH',
      candidateProviderIds: [],
      assignmentIds: [],
    },
    history: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  booking.history.push({
    type: 'BOOKING_CREATED',
    actor: `intake:${data.source}`,
    at: new Date().toISOString(),
    referenceCode,
    diagnosticFee: booking.diagnosticFee,
    feeStatus: booking.feeStatus,
  });
  store.bookings.set(booking.id, booking);
  await persistCustomer(customerRecord);
  await persistBooking(booking);
  return { record: booking };
}

router.post('/intake/webhook', authenticate, requireCompany, async (req, res) => {
  const parsed = intakeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid intake payload', details: parsed.error.flatten() });
  }
  const data = parsed.data;
  const recordType = inferRecordType(data);
  const referenceCode = createReferenceCode();
  const now = new Date().toISOString();

  appendEvent('INTAKE_RECEIVED', {
    source: data.source,
    actor: req.user.id,
    referenceCode,
    details: { recordType },
  });

  if (recordType === 'BOOKING') {
    if (!data.zip) {
      return res.status(400).json({ error: 'Bookings require a ZIP code', source: data.source });
    }
    const result = await createIntakeBooking(req, data, referenceCode);
    if (result.error) return res.status(result.error.status).json(result.error.body);
    const booking = result.record;
    appendEvent('BOOKING_CREATED', {
      source: data.source,
      actor: `intake:${data.source}`,
      entityType: 'BOOKING',
      entityId: booking.id,
      referenceCode,
      details: { appliance: booking.appliance, city: booking.city, status: booking.status },
    });
    notifyBookingConfirmation(booking, data.source);
    notifyNewBooking(booking, data.source);
    return res.status(201).json({
      data: { recordType, referenceCode, booking },
    });
  }

  if (recordType === 'PROVIDER_APPLICATION') {
    const serviceAreas = listFromInput(data.serviceAreas ?? data.areas);
    const appliances = listFromInput(data.appliances);
    const businessName = data.businessName || data.business;
    if (!businessName || serviceAreas.length === 0 || appliances.length === 0) {
      return res.status(400).json({
        error: 'Provider applications require businessName, at least one service area, and at least one appliance',
        source: data.source,
      });
    }
    const application = {
      id: createId(),
      companyId: req.companyId,
      referenceCode,
      source: data.source,
      status: 'PENDING_REVIEW',
      reviewedBy: null,
      contactName: data.name,
      phone: data.phone,
      email: data.email || null,
      businessName,
      serviceAreas,
      appliances,
      yearsInBusiness: data.yearsInBusiness ?? null,
      createdAt: now,
      updatedAt: now,
    };
    store.providerApplications.set(application.id, application);
    appendEvent('PROVIDER_APPLICATION_RECEIVED', {
      source: data.source,
      actor: `intake:${data.source}`,
      entityType: 'PROVIDER_APPLICATION',
      entityId: application.id,
      referenceCode,
      details: { businessName, serviceAreas, appliances },
    });
    notifySubmission({
      kind: 'PROVIDER_APPLICATION',
      reference: referenceCode,
      submitter: { name: data.name, phone: data.phone, email: data.email },
      lines: [
        `Business: ${businessName}`,
        `Service areas: ${serviceAreas.join(', ')}`,
        `Appliances: ${appliances.join(', ')}`,
        ...(data.yearsInBusiness ? [`Years in business: ${data.yearsInBusiness}`] : []),
      ],
      source: data.source,
    });
    return res.status(201).json({
      data: { recordType, referenceCode, application },
    });
  }

  // PM_LEAD
  if (!data.company || data.units === undefined) {
    return res.status(400).json({
      error: 'Property-manager leads require company and units',
      source: data.source,
    });
  }
  const units = typeof data.units === 'string' ? Number.parseInt(data.units, 10) : data.units;
  if (!Number.isInteger(units) || units <= 0) {
    return res.status(400).json({ error: 'units must be a positive whole number', source: data.source });
  }
  const lead = {
    id: createId(),
    companyId: req.companyId,
    referenceCode,
    source: data.source,
    status: 'NEW',
    contactName: data.name,
    phone: data.phone,
    email: data.email || null,
    company: data.company,
    units,
    message: data.message || null,
    createdAt: now,
    updatedAt: now,
  };
  store.pmLeads.set(lead.id, lead);
  appendEvent('PM_LEAD_RECEIVED', {
    source: data.source,
    actor: `intake:${data.source}`,
    entityType: 'PM_LEAD',
    entityId: lead.id,
    referenceCode,
    details: { company: lead.company, units },
  });
  notifySubmission({
    kind: 'PM_LEAD',
    reference: referenceCode,
    submitter: { name: data.name, phone: data.phone, email: data.email },
    lines: [
      `Company: ${lead.company}`,
      `Units: ${units}`,
      ...(data.message ? [`Message: ${String(data.message).slice(0, 240)}`] : []),
    ],
    source: data.source,
  });
  return res.status(201).json({
    data: { recordType, referenceCode, lead },
  });
});

router.get(
  '/intake/provider-applications',
  authenticate,
  requireCompany,
  requireRole(...STAFF_ROLES),
  (req, res) => {
    const applications = [...store.providerApplications.values()].filter(
      (item) => req.user.roles.includes(ROLES.PLATFORM_ADMIN) || item.companyId === req.companyId,
    );
    return res.json({ data: applications });
  },
);

router.get(
  '/intake/pm-leads',
  authenticate,
  requireCompany,
  requireRole(...STAFF_ROLES),
  (req, res) => {
    const leads = [...store.pmLeads.values()].filter(
      (item) => req.user.roles.includes(ROLES.PLATFORM_ADMIN) || item.companyId === req.companyId,
    );
    return res.json({ data: leads });
  },
);

/**
 * Cross-surface config: one source of truth every surface renders from.
 * Same auth pattern as the rest of the starter; in production this read
 * can be served to the public sites from a cached copy of this payload.
 */
router.get('/platform/surfaces', authenticate, requireCompany, (req, res) => {
  return res.json({
    data: {
      constants: PLATFORM_CONSTANTS,
      surfaces: SURFACES,
      intake: {
        endpoint: '/api/v1/intake/webhook',
        sources: INTAKE_SOURCES,
        recordTypes: ['BOOKING', 'PROVIDER_APPLICATION', 'PM_LEAD'],
      },
      operations: {
        eventsFeed: '/api/v1/platform/events',
        notificationOutbox: '/api/v1/notifications/outbox',
      },
    },
  });
});

/** The single operational timeline connecting all surfaces. */
router.get(
  '/platform/events',
  authenticate,
  requireCompany,
  requireRole(...STAFF_ROLES),
  (req, res) => {
    const events = [...store.events].reverse();
    const filtered = req.query.source ? events.filter((event) => event.source === req.query.source) : events;
    return res.json({ data: filtered });
  },
);

/** Simulated notification outbox — what the pipeline would send, per event. */
router.get(
  '/notifications/outbox',
  authenticate,
  requireCompany,
  requireRole(...STAFF_ROLES),
  (req, res) => {
    const outbox = [...store.notificationOutbox].reverse();
    const filtered = req.query.template ? outbox.filter((entry) => entry.template === req.query.template) : outbox;
    return res.json({ data: filtered });
  },
);

/**
 * Deliver queued notifications through the live providers (Resend email,
 * Twilio SMS). Entries whose provider is not configured stay queued.
 */
router.post(
  '/notifications/send',
  authenticate,
  requireCompany,
  requireRole(...STAFF_ROLES),
  async (req, res) => {
    const referralExpiry = await sweepReferralExpiryQuietly();
    const summary = await drainOutbox();
    return res.json({ data: { ...summary, referralExpiry, providers: providersStatus() } });
  },
);

/**
 * Cron drain — called by Vercel Cron (or any scheduler). Guarded by the
 * CRON_SECRET env var: Vercel sends it as a Bearer token automatically.
 * Refuses to run when CRON_SECRET is not set, so it is never an open door.
 */
router.get('/notifications/cron-drain', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(403).json({ error: 'Cron drain is not enabled' });
  if (req.get('authorization') !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Invalid cron secret' });
  }
  const referralExpiry = await sweepReferralExpiryQuietly();
  const summary = await drainOutbox();
  return res.json({ data: { ...summary, referralExpiry } });
});

export default router;
