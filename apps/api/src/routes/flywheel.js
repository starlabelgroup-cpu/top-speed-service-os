import { Router } from 'express';
import { z } from 'zod';
import { INTAKE_SOURCES, PLATFORM_CONSTANTS } from '../config/platform.js';
import { ROLES } from '../config/security.js';
import { areasForZip, SERVICE_CITIES, SERVICE_ZIPS } from '../config/serviceAreas.js';
import { addBookingEvent, appendEvent, createId, createReferenceCode, store } from '../data/store.js';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { NOTIFICATION_TEMPLATES, notifyBookingConfirmation } from '../services/notifications.js';
import { findReferralByCode } from '../services/flywheel.js';

const router = Router();

/**
 * Flywheel — the advertising growth loop as mechanics, not slogans:
 *
 *   ATTRACT  every surface feeds the universal intake (events by source)
 *   BOOK     requests become bookings ($99 collected at booking)
 *   SERVE    dispatch + job completion
 *   REVIEW   REVIEW_REQUEST queued automatically on completion
 *   REFER    completion issues the customer a TS-REF-XXXX code; a
 *            neighbor redeeming it creates a new booking (source
 *            REFERRAL) — and the loop turns again.
 *
 * Metrics are computed from the live in-memory store only. Nothing is
 * estimated, projected, or invented.
 */

const staffOnly = [authenticate, requireCompany, requireRole(ROLES.DISPATCHER, ROLES.PLATFORM_ADMIN)];

const redeemSchema = z.object({
  code: z.string().trim().min(4),
  name: z.string().trim().min(2),
  phone: z.string().trim().min(7),
  email: z.string().email().optional(),
  appliance: z.string().trim().min(2),
  zip: z.string().regex(/^\d{5}$/),
  city: z.string().trim().min(2).optional(),
  issue: z.string().trim().min(3),
  address: z.string().trim().min(5).optional(),
  preferredWindow: z.string().trim().optional(),
});

/** Referral codes issued so far, with their redemption history. */
router.get('/flywheel/referrals', ...staffOnly, (req, res) => {
  const referrals = [...store.referrals.values()]
    .sort((a, b) => a.issuedAt.localeCompare(b.issuedAt))
    .map((referral) => ({
      code: referral.code,
      status: referral.status,
      customerName: referral.customerName,
      issuedFromReferenceCode: referral.issuedFromReferenceCode,
      issuedAt: referral.issuedAt,
      redemptionCount: referral.redemptions.length,
      redemptions: referral.redemptions,
    }));
  return res.json({ data: referrals });
});

/**
 * Redeem a referral code: creates a new booking with source REFERRAL,
 * linked back to the code and the customer who earned it. Same ZIP/city
 * validation and $99 rules as every other booking.
 */
router.post('/flywheel/referrals/redeem', authenticate, requireCompany, (req, res) => {
  const parsed = redeemSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid referral redemption', details: parsed.error.flatten() });
  }
  const data = parsed.data;

  const referral = findReferralByCode(data.code);
  if (!referral) {
    return res.status(404).json({ error: 'Referral code not found' });
  }
  const city = data.city || areasForZip(data.zip)[0];
  if (!city || !SERVICE_CITIES.includes(city)) {
    return res.status(422).json({ error: 'City is outside the current service area', serviceCities: SERVICE_CITIES });
  }
  if (!SERVICE_ZIPS.has(data.zip)) {
    return res.status(422).json({ error: 'ZIP is outside the current service area', serviceCities: areasForZip(data.zip) });
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
    source: 'REFERRAL',
    referredByCode: referral.code,
    createdAt: new Date().toISOString(),
  };
  store.customers.set(customerRecord.id, customerRecord);

  const booking = {
    id: createId(),
    companyId: req.companyId,
    customerId: customerRecord.id,
    customer: customerRecord,
    referenceCode: createReferenceCode(),
    source: 'REFERRAL',
    referralCode: referral.code,
    referredByCustomerId: referral.customerId,
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
  addBookingEvent(booking, 'BOOKING_CREATED', 'flywheel:referral-redeem', {
    referralCode: referral.code,
    diagnosticFee: booking.diagnosticFee,
    feeStatus: booking.feeStatus,
  });
  store.bookings.set(booking.id, booking);

  referral.redemptions.push({
    bookingId: booking.id,
    referenceCode: booking.referenceCode,
    customerName: data.name,
    city,
    at: new Date().toISOString(),
  });

  appendEvent('REFERRAL_REDEEMED', {
    source: 'REFERRAL',
    actor: 'flywheel:referral-redeem',
    entityType: 'BOOKING',
    entityId: booking.id,
    referenceCode: booking.referenceCode,
    details: { referralCode: referral.code, referredByCustomerId: referral.customerId, city },
  });
  appendEvent('BOOKING_CREATED', {
    source: 'REFERRAL',
    actor: 'flywheel:referral-redeem',
    entityType: 'BOOKING',
    entityId: booking.id,
    referenceCode: booking.referenceCode,
    details: { appliance: booking.appliance, city: booking.city, status: booking.status, referralCode: referral.code },
  });
  notifyBookingConfirmation(booking, 'REFERRAL');

  return res.status(201).json({
    data: {
      referralCode: referral.code,
      referredByCustomerName: referral.customerName,
      referenceCode: booking.referenceCode,
      booking,
    },
  });
});

/** Review stage: every REVIEW_REQUEST the pipeline has queued. */
router.get('/flywheel/reviews', ...staffOnly, (req, res) => {
  const requests = [...store.notificationOutbox]
    .filter((entry) => entry.template === NOTIFICATION_TEMPLATES.REVIEW_REQUEST)
    .reverse();
  return res.json({
    data: {
      requested: requests.length,
      note: 'Phase 1 queues review requests in the simulated outbox; sent/delivered/review-received tracking arrives when Resend/Twilio and the Google review link are wired in.',
      requests,
    },
  });
});

/** The loop, measured: counts computed from live store state only. */
router.get('/flywheel/metrics', ...staffOnly, (req, res) => {
  const intakeEvents = store.events.filter((event) => event.type === 'INTAKE_RECEIVED');
  const bySource = {};
  for (const source of INTAKE_SOURCES) bySource[source] = 0;
  for (const event of intakeEvents) {
    if (event.source) bySource[event.source] = (bySource[event.source] || 0) + 1;
  }
  const referralBookings = [...store.bookings.values()].filter((booking) => booking.source === 'REFERRAL').length;
  if (referralBookings > 0) bySource.REFERRAL = referralBookings;

  const bookings = [...store.bookings.values()];
  const reviewRequests = store.notificationOutbox.filter(
    (entry) => entry.template === NOTIFICATION_TEMPLATES.REVIEW_REQUEST,
  ).length;
  const codesIssued = store.referrals.size;
  const redemptions = [...store.referrals.values()].reduce((sum, referral) => sum + referral.redemptions.length, 0);
  // Real PWA installs only (download-page views are tracked separately
  // in GET /app/installs and never counted as installs).
  const appInstalls = store.appInstalls.filter((entry) => entry.event === 'installed').length;

  return res.json({
    data: {
      attract: { totalIntakeEvents: intakeEvents.length, bySource },
      book: { totalBookings: bookings.length },
      serve: { completed: bookings.filter((booking) => booking.status === 'COMPLETED').length },
      review: { requestsQueued: reviewRequests },
      refer: { codesIssued, redemptions },
      appInstalls,
      generatedAt: new Date().toISOString(),
    },
  });
});

export default router;
