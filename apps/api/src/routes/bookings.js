import { Router } from 'express';
import { paymentSummary } from '../db/paymentsRepo.js';
import { z } from 'zod';
import { areasForZip, SERVICE_CITIES, SERVICE_ZIPS } from '../config/serviceAreas.js';
import { addBookingEvent, appendEvent, createId, createReferenceCode, store } from '../data/store.js';
import { persistAssignment, persistAssignmentsForBooking, persistBooking, persistCustomer } from '../db/bookingsRepo.js';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { ROLES, STAFF_ROLES } from '../config/security.js';
import { approveDispatch, matchProviders } from '../services/dispatch.js';
import {
  notifyBookingConfirmation,
  notifyDispatchApproved,
  notifyDispatchMatched,
  notifyReviewRequest,
} from '../services/notifications.js';
import { issueReferralForBooking } from '../services/flywheel.js';

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

router.post('/bookings', authenticate, requireCompany, async (req, res) => {
  const parsed = bookingSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid booking', details: parsed.error.flatten() });
  }

  const { customer, city, zip, appliance, issue, preferredWindow } = parsed.data;
  if (!SERVICE_CITIES.includes(city)) {
    return res.status(422).json({ error: 'City is outside the current service area', serviceCities: SERVICE_CITIES });
  }
  if (!SERVICE_ZIPS.has(zip)) {
    return res.status(422).json({ error: 'ZIP is outside the current service area', serviceCities: areasForZip(zip) });
  }

  const customerRecord = {
    id: createId(),
    companyId: req.companyId,
    ...customer,
    city,
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
    city,
    zip,
    appliance,
    issue,
    preferredWindow: preferredWindow || null,
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
  store.bookings.set(booking.id, booking);
  await persistCustomer(customerRecord);
  await persistBooking(booking);
  appendEvent('BOOKING_CREATED', {
    source: booking.source,
    actor: req.user.id,
    entityType: 'BOOKING',
    entityId: booking.id,
    referenceCode: booking.referenceCode,
    details: { appliance: booking.appliance, city: booking.city, status: booking.status },
  });
  notifyBookingConfirmation(booking, booking.source);

  return res.status(201).json({ data: publicBooking(booking) });
});

router.get('/bookings', authenticate, requireCompany, (req, res) => {
  const bookings = [...store.bookings.values()].filter(
    (booking) => req.user.roles.includes(ROLES.PLATFORM_ADMIN) || booking.companyId === req.companyId,
  );
  return res.json({ data: bookings.map(publicBooking) });
});


/**
 * PUBLIC job tracking (added 2026-11-10): a customer tracks a real booking
 * with the reference from their confirmation (TS-XXXXXX) plus the phone
 * number on the booking — no account needed. Returns status only: no
 * names, no addresses, no issue details. The phone must match the booking,
 * so a reference alone reveals nothing.
 */
const STAGE_LABELS = ['Request received — a Service Setter is reviewing it', 'Appointment confirmed', 'Technician assigned', 'Job completed'];
router.get('/bookings/track/:reference', (req, res) => {
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
  const assignments = [...store.dispatchAssignments.values()].filter((a) => a.bookingId === booking.id);
  const hasTech = assignments.some((a) => a.status === 'APPROVED' || a.status === 'ACCEPTED');
  let stage = 0;
  if (booking.status === 'COMPLETED') stage = 3;
  else if (hasTech) stage = 2;
  else if (booking.status === 'CONFIRMED' || booking.status === 'MATCH_PENDING_APPROVAL') stage = 1;
  return res.json({
    data: {
      reference: booking.referenceCode,
      status: booking.status,
      stage,
      stageLabel: STAGE_LABELS[stage],
      stages: STAGE_LABELS,
      appliance: booking.appliance,
      city: booking.city,
      preferredWindow: booking.preferredWindow ?? null,
      payment: paymentSummary(booking.id),
    },
  });
});

router.get('/bookings/:id', authenticate, requireCompany, (req, res) => {
  const booking = store.bookings.get(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
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
    appendEvent('DISPATCH_MATCHED', {
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
    appendEvent('DISPATCH_APPROVED', {
      source: booking.source || null,
      actor: parsed.data.approvedBy,
      entityType: 'BOOKING',
      entityId: booking.id,
      referenceCode: booking.referenceCode || null,
      details: { assignmentId: assignment.id, providerId: parsed.data.providerId, status: booking.status },
    });
    notifyDispatchApproved(booking, assignment, booking.source || null);
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
    appendEvent('JOB_COMPLETED', {
      source: booking.source || null,
      actor: parsed.data.completedBy,
      entityType: 'BOOKING',
      entityId: booking.id,
      referenceCode: booking.referenceCode || null,
      details: { status: booking.status },
    });
    const reviewRequests = notifyReviewRequest(booking, booking.source || null);
    // Flywheel "refer" stage: completion also issues the customer their
    // personal referral code (one active code per customer).
    const { referral, created: referralCreated } = issueReferralForBooking(booking, booking.source || null);
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
