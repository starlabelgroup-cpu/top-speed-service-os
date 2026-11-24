import { Router } from 'express';
import { paymentSummary } from '../db/paymentsRepo.js';
import { z } from 'zod';
import { resolveArea, SERVICE_CITIES } from '../config/serviceAreas.js';
import { geoFieldsFrom } from '../services/geoMatch.js';
import { enrichGeoFields } from '../services/googleMaps.js';
import { addBookingEvent, appendEvent, createId, createReferenceCode, store } from '../data/store.js';
import { persistAssignment, persistAssignmentsForBooking, persistBooking, persistCustomer } from '../db/bookingsRepo.js';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { ROLES, STAFF_ROLES } from '../config/security.js';
import { approveDispatch, matchProviders } from '../services/dispatch.js';
import { computeTracking, enrichTrackingWithMap, photoReportOf } from '../services/tracking.js';
import { isValidDateString } from '../services/bookos.js';
import {
  notifyBookingAssigned,
  notifyBookingConfirmation,
  notifyDispatchApproved,
  notifyDispatchMatched,
  notifyNewBooking,
  notifyReviewRequest,
} from '../services/notifications.js';
import { issueReferralForBooking } from '../services/flywheel.js';
import { advanceReferralOnCompletion } from '../services/referrals.js';
import { emitReport } from '../services/managementReports.js';
import { attributionFields, normalizeAttribution } from '../services/attribution.js';
import { displayCity } from '../services/cityDisplay.js';

const router = Router();

const bookingSchema = z.object({
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
  // Live arrival-window picker (2026-11-20, A1): the service day the
  // customer picked with their window (YYYY-MM-DD) — a stated
  // preference beside preferredWindow, never an appointment.
  preferredDate: z.string().refine(isValidDateString, { message: 'preferredDate must be a valid YYYY-MM-DD date' }).optional(),
  // Book by Location (2026-11-23): the same optional geo fields the
  // guest twin accepts — degrade-to-undefined on any malformed value,
  // re-derived server-side by geoFieldsFrom, never trusted as sent.
  geoCity: z.string().trim().max(80).optional().catch(undefined),
  geoTier: z.string().trim().max(24).optional().catch(undefined),
  geoLat: z.number().min(-90).max(90).optional().catch(undefined),
  geoLng: z.number().min(-180).max(180).optional().catch(undefined),
  // Top Speed Ads attribution (2026-11-17): the same optional
  // first-touch capture the guest twin (POST /speedy/book) accepts —
  // landing page, UTM fields and the platform click IDs. Absent or
  // malformed attribution never fails a booking; see
  // services/attribution.js for the accepted shapes.
  ...attributionFields,
});

const matchSchema = z.object({
  bookingId: z.string().uuid(),
});

const approveSchema = z.object({
  bookingId: z.string().uuid(),
  providerId: z.string().uuid(),
  approvedBy: z.string().trim().min(2).default('Service Setters'),
});

const completeSchema = z.object({
  completedBy: z.string().trim().min(2).default('Service Setters'),
  notes: z.string().trim().optional(),
});

function publicBooking(booking) {
  return { ...booking, payment: paymentSummary(booking.id) };
}

const digits10 = (value) => String(value || '').replace(/\D/g, '').slice(-10);

/**
 * Ownership test for one booking — the same linkage the signed-in
 * tracking view (routes/tracking.js bookingsForUser) already uses, so
 * every surface agrees on whose booking a job is: the booking's
 * customer record carries the account's userId when one is linked, and
 * otherwise the account's email or phone must match the contact details
 * on the booking. Commercial bookings embed the commercial account's
 * contact record as their customer, so a business / property-manager
 * account matches its own portfolio's jobs the same way.
 */
function bookingBelongsToUser(booking, user) {
  const record = store.users.get(user.id) || {};
  const email = String(record.email || user.email || '').toLowerCase();
  const phone = digits10(record.phone || user.phone || '');
  const c = booking.customer || {};
  if (c.userId && c.userId === user.id) return true;
  if (email && String(c.email || '').toLowerCase() === email) return true;
  if (phone && digits10(c.phone || booking.phone || '') === phone) return true;
  return false;
}

/**
 * Who may read a full booking (contact details included): staff
 * (STAFF_ROLES) or the booking's own customer. Decided by Ramone
 * 2026-11-16 — before this, any signed-in account presenting the
 * booking's ID received the full record.
 */
function canReadBooking(req, booking) {
  if ((req.user.roles || []).some((role) => STAFF_ROLES.includes(role))) return true;
  return bookingBelongsToUser(booking, req.user);
}

router.post('/bookings', authenticate, requireCompany, async (req, res) => {
  const parsed = bookingSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid booking', details: parsed.error.flatten() });
  }

  const { customer, city, zip, appliance, issue, preferredWindow, preferredDate } = parsed.data;
  const attribution = normalizeAttribution(parsed.data);
  // Service Book book-by-area: the address resolves into the area model
  // instead of being rejected at the border. Covered addresses book as
  // always; out-of-area leads are recorded on the expansion waitlist
  // (flagged, never promised service, no confirmation with service
  // terms is sent for them).
  const resolution = resolveArea({ city, zip });
  const canonicalCity = SERVICE_CITIES.includes(city) ? city : resolution.area || city;
  // Book by Location: server-derived geo fields (nulls without the
  // tap). The area model above stays authoritative for coverage.
  // Google Maps enrichment (2026-11-23): with the Maps key set, the
  // street address is geocoded and the real coordinates + place id
  // replace the device-tap ones; with no key (or any Google
  // failure) geoFinal IS geo, unchanged.
  const geo = await enrichGeoFields({
    geo: geoFieldsFrom(parsed.data),
    address: customer.address,
    city: canonicalCity,
    zip,
  });

  const customerRecord = {
    id: createId(),
    companyId: req.companyId,
    ...customer,
    city: canonicalCity,
    zip,
    createdAt: new Date().toISOString(),
  };
  store.customers.set(customerRecord.id, customerRecord);

  const booking = {
    id: createId(),
    companyId: req.companyId,
    customerId: customerRecord.id,
    customer: customerRecord,
    referenceCode: createReferenceCode(),
    source: 'API',
    segment: 'RESIDENTIAL',
    ...(attribution ? { attribution } : {}),
    city: canonicalCity,
    zip,
    area: resolution.area,
    areaStatus: resolution.areaStatus,
    serviceAddress: customer.address || null,
    ...geo,
    appliance,
    issue,
    preferredWindow: preferredWindow || null,
    preferredDate: preferredDate || null,
    diagnosticFee: 99,
    diagnosticFeeCurrency: 'USD',
    diagnosticFeeCreditedTowardRepair: true,
    feeStatus: 'collected_at_booking',
    status: 'PENDING_DISPATCH',
    dispatch: {
      mode: 'HYBRID',
      stage: 'AWAITING_MATCH',
      candidateProviderIds: [],
      assignmentIds: [],
    },
    history: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  addBookingEvent(booking, 'BOOKING_CREATED', req.user.id, {
    diagnosticFee: booking.diagnosticFee,
    feeStatus: booking.feeStatus,
  });
  addBookingEvent(booking, 'AREA_RESOLVED', 'service-book', {
    area: resolution.area,
    areaStatus: resolution.areaStatus,
    areaSource: resolution.areaSource,
    zipAreas: resolution.zipAreas,
  });
  if (geo.geoCity || geo.geoSource === 'GOOGLE_GEOCODE') {
    addBookingEvent(booking, 'GEO_VERIFIED', 'book-by-location', {
      geoCity: geo.geoCity,
      geoTier: geo.geoTier,
      geoLat: geo.geoLat,
      geoLng: geo.geoLng,
      // Where the stored coordinates came from: GOOGLE_GEOCODE when
      // the Maps enrichment verified the street address,
      // CENTROID_MATCH when they are the customer's device position
      // matched against the internal centroids, STATED when only a
      // city/tier was stated with no coordinates at all.
      geoSource:
        geo.geoSource ||
        (geo.geoLat != null && geo.geoLng != null ? 'CENTROID_MATCH' : 'STATED'),
      ...(geo.geoPlaceId ? { geoPlaceId: geo.geoPlaceId } : {}),
    });
  }
  store.bookings.set(booking.id, booking);
  await persistCustomer(customerRecord);
  await persistBooking(booking);
  await appendEvent('BOOKING_CREATED', {
    source: booking.source,
    actor: req.user.id,
    entityType: 'BOOKING',
    entityId: booking.id,
    referenceCode: booking.referenceCode,
    details: { appliance: booking.appliance, city: booking.city, area: booking.area, areaStatus: booking.areaStatus, status: booking.status },
  });
  if (booking.areaStatus !== 'OUT_OF_AREA') {
    notifyBookingConfirmation(booking, booking.source);
  }
  notifyNewBooking(booking, booking.source);

  return res.status(201).json({ data: publicBooking(booking) });
});

router.get('/bookings', authenticate, requireCompany, (req, res) => {
  // Customer-lockout audit (2026-11-18): this list used to return the
  // full company booking list — contact details included — to ANY
  // signed-in account in the platform company, so a CUSTOMER token
  // could enumerate every customer's bookings. The single-booking read
  // was scoped on 2026-11-16 (canReadBooking); the list now follows the
  // same rule: staff see the company list, everyone else sees only
  // bookings that belong to them (the customer app's "my booking" read
  // keeps working — it now actually receives only its own).
  const isStaff = (req.user.roles || []).some((role) => STAFF_ROLES.includes(role));
  const bookings = [...store.bookings.values()].filter((booking) => {
    if (req.user.roles.includes(ROLES.PLATFORM_ADMIN)) return true;
    if (booking.companyId !== req.companyId) return false;
    return isStaff || bookingBelongsToUser(booking, req.user);
  });
  return res.json({ data: bookings.map(publicBooking) });
});


/**
 * PUBLIC recent-completed feed (added 2026-11-15, flagship proof strip):
 * the most recent completed jobs as { city, appliance, completedDate }
 * ONLY — no names, addresses, phones, references or job IDs ever leave
 * the store on this route. An empty list is a valid, honest answer
 * (the homepage section that reads it simply stays hidden).
 */
router.get('/bookings/recent-completed', (req, res) => {
  const jobs = [...store.bookings.values()]
    .filter((b) => b.status === 'COMPLETED' && b.completedAt)
    .sort((a, b) => String(b.completedAt).localeCompare(String(a.completedAt)))
    .slice(0, 8)
    .map((b) => ({
      // Display-normalized (services/cityDisplay.js): the stored city
      // is free text and prints verbatim otherwise — a stored typo
      // ("lauderrhill") would show on the public feed. The record
      // itself is never rewritten by this layer.
      city: b.city ? displayCity(b.city) : null,
      appliance: b.appliance || null,
      completedDate: b.completedAt,
    }))
    .filter((job) => job.city && job.appliance);
  return res.json({ data: jobs });
});

/**
 * PUBLIC job tracking (added 2026-11-10): a customer tracks a real booking
 * with the reference from their confirmation (TS-XXXXXX) plus the phone
 * number on the booking — no account needed. Returns status only: no
 * names, no addresses, no issue details. The phone must match the booking,
 * so a reference alone reveals nothing.
 */
router.get('/bookings/track/:reference', async (req, res) => {
  const reference = String(req.params.reference || '').trim().toUpperCase();
  const phoneDigits = String(req.query.phone || '').replace(/\D/g, '').slice(-10);
  if (!reference || phoneDigits.length < 10) {
    return res.status(400).json({ error: 'Booking reference and the phone number on the booking are required' });
  }
  const booking = [...store.bookings.values()].find(
    (b) => String(b.referenceCode || '').toUpperCase() === reference,
  );
  if (!booking) return res.status(404).json({ error: 'No booking found with that reference' });
  const bookingPhone = String(booking.customer?.phone || booking.phone || '').replace(/\D/g, '').slice(-10);
  if (!bookingPhone || bookingPhone !== phoneDigits) {
    return res.status(403).json({ error: 'That phone number does not match this booking' });
  }
  // Stage math lives in services/tracking.js (shared with the signed-in
  // customer view and the staff console, so every surface agrees).
  // The Maps enrichment attaches the Track My Tech map block when
  // keyed and the tech is live en route; a no-op otherwise.
  const tracking = await enrichTrackingWithMap(booking, computeTracking(booking));
  return res.json({ data: { ...tracking, payment: paymentSummary(booking.id), photoReport: photoReportOf(booking) } });
});

router.get('/bookings/:id', authenticate, requireCompany, (req, res) => {
  const booking = store.bookings.get(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (!canReadBooking(req, booking)) {
    return res.status(403).json({ error: 'You do not have access to this booking' });
  }
  return res.json({ data: publicBooking(booking) });
});

router.post(
  '/dispatch/match',
  authenticate,
  requireCompany,
  requireRole(...STAFF_ROLES),
  async (req, res) => {
    const parsed = matchSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid match request', details: parsed.error.flatten() });
    }

    const booking = store.bookings.get(parsed.data.bookingId);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (booking.status === 'CONFIRMED') {
      return res.status(409).json({ error: 'Booking is already confirmed' });
    }

    const result = matchProviders(booking);
    booking.updatedAt = new Date().toISOString();
    await appendEvent('DISPATCH_MATCHED', {
      source: booking.source || null,
      actor: 'system:auto-match',
      entityType: 'BOOKING',
      entityId: booking.id,
      referenceCode: booking.referenceCode || null,
      details: { candidateCount: result.candidates.length, status: booking.status },
    });
    notifyDispatchMatched(booking, result.candidates.length, booking.source || null);
    await persistBooking(booking);
    for (const assignment of result.assignments) await persistAssignment(assignment);
    return res.json({
      data: {
        bookingId: booking.id,
        bookingStatus: booking.status,
        dispatchMode: 'HYBRID',
        approvalRequired: true,
        ...result,
      },
    });
  },
);

router.post(
  '/dispatch/approve',
  authenticate,
  requireCompany,
  requireRole(...STAFF_ROLES),
  async (req, res) => {
    const parsed = approveSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid approval request', details: parsed.error.flatten() });
    }

    const booking = store.bookings.get(parsed.data.bookingId);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (booking.status !== 'MATCH_PENDING_APPROVAL') {
      return res.status(409).json({ error: 'Run dispatch match before approval' });
    }

    const assignment = approveDispatch(booking, parsed.data.providerId, parsed.data.approvedBy);
    if (!assignment) {
      return res.status(422).json({ error: 'Provider is not a proposed candidate for this booking' });
    }

    booking.updatedAt = new Date().toISOString();
    await appendEvent('DISPATCH_APPROVED', {
      source: booking.source || null,
      actor: parsed.data.approvedBy,
      entityType: 'BOOKING',
      entityId: booking.id,
      referenceCode: booking.referenceCode || null,
      details: { assignmentId: assignment.id, providerId: parsed.data.providerId, status: booking.status },
    });
    notifyDispatchApproved(booking, assignment, booking.source || null);
    notifyBookingAssigned(booking, assignment, booking.source || null);
    await persistBooking(booking);
    await persistAssignmentsForBooking(booking.id);
    return res.json({
      data: {
        booking: publicBooking(booking),
        assignment,
      },
    });
  },
);

/**
 * Mark a job completed. Completion fires two flywheel stages at once:
 * the review engine (a REVIEW_REQUEST notification is queued for the
 * customer) and the referral engine (the customer is issued their
 * personal TS-REF-XXXX code — see routes/flywheel.js).
 */
router.post(
  '/bookings/:id/complete',
  authenticate,
  requireCompany,
  requireRole(...STAFF_ROLES),
  async (req, res) => {
    const parsed = completeSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid completion request', details: parsed.error.flatten() });
    }

    const booking = store.bookings.get(req.params.id);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (booking.status === 'COMPLETED') {
      return res.status(409).json({ error: 'Booking is already completed' });
    }

    booking.status = 'COMPLETED';
    booking.completedAt = new Date().toISOString();
    booking.completedBy = parsed.data.completedBy;
    booking.updatedAt = booking.completedAt;
    addBookingEvent(booking, 'JOB_COMPLETED', parsed.data.completedBy, {
      notes: parsed.data.notes || null,
    });
    await appendEvent('JOB_COMPLETED', {
      source: booking.source || null,
      actor: parsed.data.completedBy,
      entityType: 'BOOKING',
      entityId: booking.id,
      referenceCode: booking.referenceCode || null,
      details: { status: booking.status },
    });
    emitReport({
      department: 'field',
      type: 'JOB_COMPLETED',
      title: `Job completed — ${booking.referenceCode || booking.id}`,
      detail: { bookingId: booking.id, bookingReference: booking.referenceCode || null, customerName: booking.customer?.name || null, service: booking.appliance || null, city: booking.city || null, completedBy: parsed.data.completedBy, completedAt: booking.completedAt, notes: parsed.data.notes || null },
      source: booking.source || null,
      reference: booking.referenceCode || null,
      eventKey: `booking:${booking.id}:completed:report`,
    });
    const reviewRequests = notifyReviewRequest(booking, booking.source || null);
    // Flywheel "refer" stage: completion also issues the customer their
    // personal referral code (one active code per customer).
    const { referral, created: referralCreated } = issueReferralForBooking(booking, booking.source || null);
    // ApplianceReferral: if THIS booking was itself a referred booking,
    // advance its journey (COMPLETED → REWARD_PENDING_APPROVAL when a
    // payment is recorded) and notify the referrer. Never blocks the
    // completion response.
    try {
      await advanceReferralOnCompletion(booking, booking.source || null);
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', message: 'referral completion advance failed', error: String(error?.message || error) }));
    }
    await persistBooking(booking);

    return res.json({
      data: {
        booking: publicBooking(booking),
        notificationsQueued: reviewRequests.map((entry) => ({
          id: entry.id,
          channel: entry.channel,
          template: entry.template,
          to: entry.to,
        })),
        referral: {
          code: referral.code,
          created: referralCreated,
          customerName: referral.customerName,
        },
      },
    });
  },
);

export default router;
