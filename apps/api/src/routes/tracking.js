import { Router } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { addBookingEvent, appendEvent, createId, store } from '../data/store.js';
import { persistAssignment, persistAssignmentsForBooking, persistBooking } from '../db/bookingsRepo.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { ROLES, STAFF_ROLES } from '../config/security.js';
import { approveDispatch, matchProviders } from '../services/dispatch.js';
import { activeAssignmentFor, computeTracking, providerById } from '../services/tracking.js';
import { notifyDispatchApproved, notifyTrackingUpdate } from '../services/notifications.js';
import { persistTrackingToken, revokeTrackingTokensForBooking } from '../db/trackingRepo.js';
import { paymentSummary } from '../db/paymentsRepo.js';
import { issueReferralForBooking } from '../services/flywheel.js';

/**
 * Track My Tech — account access + the staff back door (added 2026-11-11
 * at Ramone's direction).
 *
 * Customers sign in with the same Service OS account they use everywhere
 * else and see their own jobs' live tracking — no reference + phone
 * lookup needed (the public lookup stays for guests). Owners, managers,
 * Service Setters and dispatchers (STAFF_ROLES) get the console: every
 * active job's stage, technician and ETA, with the controls to run the
 * board — assign a technician, advance a stage on a technician's behalf
 * (recorded as a Service Setter action, never disguised as the tech's),
 * and send the customer a tracking update.
 */
const router = Router();

const digits10 = (value) => String(value || '').replace(/\D/g, '').slice(-10);

function findBookingByReference(reference) {
  const wanted = String(reference || '').trim().toUpperCase();
  return [...store.bookings.values()].find(
    (b) => String(b.referenceCode || '').toUpperCase() === wanted,
  ) || null;
}

function bookingsForUser(user) {
  const record = store.users.get(user.id) || {};
  const email = String(record.email || user.email || '').toLowerCase();
  const phone = digits10(record.phone || user.phone || '');
  return [...store.bookings.values()].filter((b) => {
    const c = b.customer || {};
    if (c.userId && c.userId === user.id) return true;
    if (email && String(c.email || '').toLowerCase() === email) return true;
    if (phone && digits10(c.phone || b.phone || '') === phone) return true;
    return false;
  });
}

/** The signed-in customer's own jobs, with full tracking state. */
router.get('/tracking/mine', authenticate, (req, res) => {
  const jobs = bookingsForUser(req.user)
    .map((b) => ({
      ...computeTracking(b),
      issue: b.issue ?? null,
      zip: b.zip ?? null,
      createdAt: b.createdAt,
    }))
    .sort((a, b) => {
      const rank = (j) => (j.stageIndex >= 7 ? 1 : 0);
      return rank(a) - rank(b) || String(b.createdAt).localeCompare(String(a.createdAt));
    });
  return res.json({ data: jobs });
});

function consoleJob(booking) {
  const assignment = activeAssignmentFor(booking.id);
  const c = booking.customer || {};
  return {
    ...computeTracking(booking),
    id: booking.id,
    customerName: c.name || booking.customerName || 'Customer',
    customerPhone: c.phone || booking.phone || null,
    customerEmail: c.email || booking.email || null,
    address: c.address || booking.address || null,
    zip: booking.zip ?? null,
    issue: booking.issue ?? null,
    feeStatus: booking.feeStatus ?? null,
    assignmentId: assignment?.id ?? null,
    providerId: assignment?.providerId ?? null,
    createdAt: booking.createdAt,
    updatedAt: booking.updatedAt ?? null,
  };
}

function staffCanSee(req, booking) {
  return req.user.roles.includes(ROLES.PLATFORM_ADMIN) || booking.companyId === req.user.companyId;
}

const staffOnly = [authenticate, requireRole(...STAFF_ROLES)];

/** The staff board: every active job with its tracking state. */
router.get('/tracking/console', ...staffOnly, (req, res) => {
  const jobs = [...store.bookings.values()]
    .filter((b) => staffCanSee(req, b))
    .map(consoleJob)
    .sort((a, b) => {
      const rank = (j) => (j.stageIndex >= 3 && j.stageIndex <= 6 ? 0 : j.stageIndex === 2 ? 1 : j.stageIndex === 1 ? 2 : j.stageIndex === 0 ? 3 : 4);
      return rank(a) - rank(b) || String(b.createdAt).localeCompare(String(a.createdAt));
    })
    .slice(0, 100);
  const providers = (Array.isArray(store.providers) ? store.providers : [])
    .filter((p) => p.active)
    .map((p) => ({ id: p.id, businessName: p.businessName, type: p.type }));
  const summary = {
    active: jobs.filter((j) => j.stageIndex < 7).length,
    awaitingAssignment: jobs.filter((j) => j.stageIndex < 2).length,
    enRoute: jobs.filter((j) => j.stageIndex === 3).length,
    onSite: jobs.filter((j) => j.stageIndex === 4 || j.stageIndex === 5).length,
    completed: jobs.filter((j) => j.stageIndex >= 7).length,
  };
  return res.json({ data: { jobs, providers, summary } });
});

const assignSchema = z.object({ providerId: z.string().trim().min(1) });

/** Assign (or reassign) a technician from the console. */
router.post('/tracking/console/:reference/assign', ...staffOnly, async (req, res) => {
  const booking = findBookingByReference(req.params.reference);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (!staffCanSee(req, booking)) return res.status(403).json({ error: 'Cannot manage another company booking' });
  if (booking.status === 'COMPLETED' || booking.status === 'CANCELLED') {
    return res.status(409).json({ error: 'This job is closed' });
  }
  const parsed = assignSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'A providerId is required' });
  const provider = providerById(parsed.data.providerId);
  if (!provider) return res.status(404).json({ error: 'Provider not found' });

  // Preferred path: the normal hybrid flow — auto-match proposes, the
  // setter approves. Falls back to a direct setter assignment when the
  // provider is outside the auto-match (or on a reassignment).
  let assignment = approveDispatch(booking, provider.id, req.user.email);
  if (!assignment && booking.status !== 'CONFIRMED') {
    matchProviders(booking);
    assignment = approveDispatch(booking, provider.id, req.user.email);
  }
  if (!assignment) {
    const now = new Date().toISOString();
    const current = activeAssignmentFor(booking.id);
    if (current && current.providerId !== provider.id) {
      current.status = 'REPLACED';
      await persistAssignment(current);
    }
    for (const other of store.dispatchAssignments.values()) {
      if (other.bookingId === booking.id && other.status === 'PROPOSED') other.status = 'NOT_SELECTED';
    }
    assignment = {
      id: createId(),
      companyId: booking.companyId,
      bookingId: booking.id,
      providerId: provider.id,
      providerCompanyId: provider.companyId ?? null,
      status: 'APPROVED',
      dispatchMode: 'HYBRID',
      approvalRequired: true,
      matchScore: null,
      createdAt: now,
      approvedBy: req.user.email,
      approvedAt: now,
    };
    store.dispatchAssignments.set(assignment.id, assignment);
    booking.status = 'CONFIRMED';
    booking.dispatch = {
      ...booking.dispatch,
      stage: 'APPROVED_BY_SERVICE_SETTERS',
      assignmentId: assignment.id,
      providerId: provider.id,
      approvedBy: req.user.email,
      approvedAt: now,
    };
    addBookingEvent(booking, 'DISPATCH_APPROVED', req.user.email, {
      assignmentId: assignment.id,
      providerId: provider.id,
      via: 'TRACKING_CONSOLE',
    });
  }

  booking.updatedAt = new Date().toISOString();
  await persistBooking(booking);
  await persistAssignmentsForBooking(booking.id);
  notifyDispatchApproved(booking, assignment, 'TRACKING_CONSOLE');
  appendEvent('TRACKING_ASSIGN', {
    source: 'TRACKING_CONSOLE',
    actor: req.user.email,
    entityType: 'BOOKING',
    entityId: booking.id,
    referenceCode: booking.referenceCode,
    details: { providerId: provider.id },
  });
  return res.status(201).json({ data: consoleJob(booking) });
});

const stageSchema = z.object({
  action: z.enum(['CONFIRM', 'EN_ROUTE', 'ARRIVED', 'DIAGNOSIS', 'ESTIMATE', 'COMPLETE']),
  etaMinutes: z.number().int().min(1).max(600).optional(),
});

const STAGE_ACTIONS = {
  EN_ROUTE: 'TECH_EN_ROUTE',
  ARRIVED: 'TECH_ARRIVED',
  DIAGNOSIS: 'DIAGNOSIS_STARTED',
  ESTIMATE: 'ESTIMATE_APPROVED',
};

/** Advance a job's stage from the console (e.g. the tech phoned it in). */
router.post('/tracking/console/:reference/stage', ...staffOnly, async (req, res) => {
  const booking = findBookingByReference(req.params.reference);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (!staffCanSee(req, booking)) return res.status(403).json({ error: 'Cannot manage another company booking' });
  const parsed = stageSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid stage action', details: parsed.error.flatten() });
  const { action, etaMinutes } = parsed.data;

  if (action === 'CONFIRM') {
    booking.status = 'CONFIRMED';
    addBookingEvent(booking, 'APPOINTMENT_CONFIRMED', req.user.email, { confirmedBy: 'SERVICE_SETTER' });
  } else if (action === 'COMPLETE') {
    booking.status = 'COMPLETED';
    addBookingEvent(booking, 'REPAIR_COMPLETED', req.user.email, { confirmedBy: 'SERVICE_SETTER' });
  } else {
    const type = STAGE_ACTIONS[action];
    addBookingEvent(booking, type, req.user.email, {
      etaMinutes: action === 'EN_ROUTE' ? etaMinutes ?? null : null,
      confirmedBy: 'SERVICE_SETTER',
    });
    if (action === 'EN_ROUTE' && etaMinutes) {
      const assignment = activeAssignmentFor(booking.id);
      if (assignment) {
        assignment.etaMinutes = etaMinutes;
        await persistAssignment(assignment);
      }
    }
  }

  booking.updatedAt = new Date().toISOString();
  await persistBooking(booking);
  if (action === 'COMPLETE') {
    try {
      issueReferralForBooking(booking, 'TRACKING_CONSOLE');
    } catch {
      // Referral issuance must never block a completion.
    }
  }
  appendEvent('TRACKING_STAGE', {
    source: 'TRACKING_CONSOLE',
    actor: req.user.email,
    entityType: 'BOOKING',
    entityId: booking.id,
    referenceCode: booking.referenceCode,
    details: { action, etaMinutes: etaMinutes ?? null },
  });
  return res.status(201).json({ data: consoleJob(booking) });
});

/** Send the customer a tracking update (queued to the outbox). */
router.post('/tracking/console/:reference/notify', ...staffOnly, async (req, res) => {
  const booking = findBookingByReference(req.params.reference);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (!staffCanSee(req, booking)) return res.status(403).json({ error: 'Cannot manage another company booking' });
  const tracking = computeTracking(booking);
  const queued = notifyTrackingUpdate(booking, tracking.stageLabel8, 'TRACKING_CONSOLE');
  return res.status(201).json({ data: { queued: queued.length, stageLabel: tracking.stageLabel8 } });
});

/**
 * Secure per-job tracking links (2026-11-11, pattern ported from the
 * tracking starter Ramone supplied): staff issue a link whose raw token
 * exists only in the customer's copy — the database stores its SHA-256
 * hash. Issuing a new link revokes the booking's previous links; links
 * expire after 7 days, and 24 hours after the job completes.
 */
router.post('/tracking/console/:reference/tracking-link', ...staffOnly, async (req, res) => {
  const booking = findBookingByReference(req.params.reference);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  const raw = randomBytes(24).toString('base64url');
  const tokenHash = createHash('sha256').update(raw).digest('hex');
  await revokeTrackingTokensForBooking(booking.id);
  const record = {
    id: createId(),
    tokenHash,
    bookingId: booking.id,
    issuedBy: req.user.email,
    expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    revokedAt: null,
    createdAt: new Date().toISOString(),
  };
  await persistTrackingToken(record);
  appendEvent('TRACKING_LINK_ISSUED', {
    source: 'TRACK_CONSOLE',
    actor: req.user.email,
    entityType: 'BOOKING',
    entityId: booking.id,
    referenceCode: booking.referenceCode,
    details: { expiresAt: record.expiresAt },
  });
  return res.status(201).json({ data: { url: `/track?t=${raw}`, expiresAt: record.expiresAt } });
});

/** Public tracking via a secure per-job token — no phone number needed. */
router.get('/tracking/by-token/:token', (req, res) => {
  const tokenHash = createHash('sha256').update(String(req.params.token || '')).digest('hex');
  const record = store.trackingTokens.get(tokenHash);
  if (!record || record.revokedAt) {
    return res.status(404).json({ error: 'Tracking link not found' });
  }
  if (new Date(record.expiresAt).getTime() < Date.now()) {
    return res.status(410).json({ error: 'This tracking link has expired' });
  }
  const booking = store.bookings.get(record.bookingId);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (
    booking.status === 'COMPLETED' &&
    booking.completedAt &&
    Date.now() - new Date(booking.completedAt).getTime() > 24 * 3600 * 1000
  ) {
    return res.status(410).json({ error: 'This tracking link has expired' });
  }
  return res.json({ data: { ...computeTracking(booking), payment: paymentSummary(booking.id) } });
});

export default router;