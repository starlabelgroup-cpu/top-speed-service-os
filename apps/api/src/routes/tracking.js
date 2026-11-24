import { Router } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { addBookingEvent, appendEvent, createId, store } from '../data/store.js';
import { persistAssignment, persistAssignmentsForBooking, persistBooking } from '../db/bookingsRepo.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { ROLES, STAFF_ROLES } from '../config/security.js';
import { approveDispatch, matchProviders } from '../services/dispatch.js';
import { activeAssignmentFor, computeTracking, enrichTrackingWithMap, photoReportOf, providerById, techPhotoFor } from '../services/tracking.js';
import { priorityTierOf } from '../services/dispatchOps.js';
import { notifyBookingAssigned, notifyDispatchApproved, notifyTechEnRoute, notifyTrackingUpdate } from '../services/notifications.js';
import { emitReport } from '../services/managementReports.js';
import { bookingDetailOf } from '../services/bookingDetail.js';
import { persistTrackingToken, revokeTrackingTokensForBooking } from '../db/trackingRepo.js';
import { paymentSummary } from '../db/paymentsRepo.js';
import { issueReferralForBooking } from '../services/flywheel.js';
import { advanceReferralOnCompletion } from '../services/referrals.js';

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
router.get('/tracking/mine', authenticate, async (req, res) => {
  const jobs = [];
  for (const b of bookingsForUser(req.user)) {
    // Google Maps enrichment (2026-11-23): attaches the Track My
    // Tech map block (tech GPS + job pin + labeled drive-time ETA)
    // only when the Maps key is set and the tech is live en route;
    // a no-op otherwise, so the payload is unchanged.
    const tracking = await enrichTrackingWithMap(b, computeTracking(b));
    jobs.push({
      ...tracking,
      id: b.id,
      issue: b.issue ?? null,
      zip: b.zip ?? null,
      createdAt: b.createdAt,
      photoReport: photoReportOf(b),
    });
  }
  jobs.sort((a, b) => {
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
    priorityTier: priorityTierOf(booking),
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
router.get('/tracking/console', ...staffOnly, async (req, res) => {
  const jobs = [...store.bookings.values()]
    .filter((b) => staffCanSee(req, b))
    .map(consoleJob)
    .sort((a, b) => {
      const rank = (j) => (j.stageIndex >= 3 && j.stageIndex <= 6 ? 0 : j.stageIndex === 2 ? 1 : j.stageIndex === 1 ? 2 : j.stageIndex === 0 ? 3 : 4);
      return rank(a) - rank(b) || String(b.createdAt).localeCompare(String(a.createdAt));
    })
    .slice(0, 100);
  // Google Maps enrichment (2026-11-23): the board consumes the
  // same map data the customer sees (tech GPS + job pin + labeled
  // drive-time ETA) on en-route jobs — data wiring only; the
  // console's own rendering is unchanged. No-op without the key.
  for (const job of jobs) {
    const booking = store.bookings.get(job.id);
    if (booking) await enrichTrackingWithMap(booking, job);
  }
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
    const current = activeAssignmentFor(booking.id);
    if (current && current.providerId === provider.id) {
      // Idempotent re-assign (2026-11-23): this provider already holds
      // the approved assignment — a double-tap, a retry, or a second
      // setter repeating the same assignment. Reuse the existing
      // assignment. Minting a fresh one here also minted a SECOND
      // DISPATCH_APPROVED management report under a new eventKey
      // (the duplicate cards Ramone photographed on 2026-11-23), and
      // left booking.dispatch pointing at an assignment the board did
      // not show. With reuse, the notifications below dedupe on their
      // eventKeys and the repeat call is a true no-op.
      assignment = current;
    } else {
    const now = new Date().toISOString();
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
  }

  booking.updatedAt = new Date().toISOString();
  await persistBooking(booking);
  await persistAssignmentsForBooking(booking.id);
  notifyDispatchApproved(booking, assignment, 'TRACKING_CONSOLE');
  notifyBookingAssigned(booking, assignment, 'TRACKING_CONSOLE');
  await appendEvent('TRACKING_ASSIGN', {
    source: 'TRACKING_CONSOLE',
    actor: req.user.email,
    entityType: 'BOOKING',
    entityId: booking.id,
    referenceCode: booking.referenceCode,
    details: { providerId: provider.id },
  });
  return res.status(201).json({ data: consoleJob(booking) });
});

/**
 * Full detail for one console job (2026-11-23, the dispatch cards'
 * View / More-info): the console job plus the full booking record and
 * its tracking sources — attribution exactly as recorded on the
 * booking; fields the record does not carry read null and the console
 * renders them "Not recorded".
 */
router.get('/tracking/console/:reference/detail', ...staffOnly, async (req, res) => {
  const booking = findBookingByReference(req.params.reference);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (!staffCanSee(req, booking)) return res.status(403).json({ error: 'Cannot manage another company booking' });
  const job = await enrichTrackingWithMap(booking, consoleJob(booking));
  return res.json({ data: { job, booking: bookingDetailOf(booking) } });
});

/**
 * Reset a job's dispatch (2026-11-23, the dispatch cards' Reset):
 * the active assignment is retired (REPLACED — the same terminal
 * state a reassignment leaves), open proposals are cleared, the
 * booking's dispatch stamp is wiped, and a job that was CONFIRMED by
 * the approval returns to PENDING_DISPATCH — the setter queue — so it
 * can be matched and assigned fresh. The job's history is NOT
 * rewritten: the reset itself is recorded as a DISPATCH_RESET event,
 * and stage dots derived from past stage events stay truthful. A
 * closed job (completed / cancelled) refuses with 409.
 */
router.post('/tracking/console/:reference/reset-dispatch', ...staffOnly, async (req, res) => {
  const booking = findBookingByReference(req.params.reference);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (!staffCanSee(req, booking)) return res.status(403).json({ error: 'Cannot manage another company booking' });
  if (booking.status === 'COMPLETED' || booking.status === 'CANCELLED') {
    return res.status(409).json({ error: 'This job is closed — its dispatch cannot be reset.' });
  }
  const active = activeAssignmentFor(booking.id);
  if (active) {
    active.status = 'REPLACED';
    await persistAssignment(active);
  }
  for (const other of store.dispatchAssignments.values()) {
    if (other.bookingId === booking.id && other.status === 'PROPOSED') {
      other.status = 'NOT_SELECTED';
      await persistAssignment(other);
    }
  }
  booking.dispatch = {
    ...(booking.dispatch || {}),
    stage: 'AWAITING_ASSIGNMENT',
    assignmentId: null,
    providerId: null,
    approvedBy: null,
    approvedAt: null,
  };
  if (booking.status === 'CONFIRMED') booking.status = 'PENDING_DISPATCH';
  addBookingEvent(booking, 'DISPATCH_RESET', req.user.email, {
    assignmentId: active?.id || null,
    providerId: active?.providerId || null,
    via: 'TRACKING_CONSOLE',
  });
  booking.updatedAt = new Date().toISOString();
  await persistBooking(booking);
  await persistAssignmentsForBooking(booking.id);
  emitReport({
    department: 'dispatch',
    type: 'DISPATCH_RESET',
    title: `Dispatch reset — ${booking.referenceCode || booking.id} returned to the setter queue`,
    detail: { bookingId: booking.id, bookingReference: booking.referenceCode || null, service: booking.appliance || null, city: booking.city || null, assignmentId: active?.id || null, resetBy: req.user.email },
    source: 'TRACKING_CONSOLE',
    reference: booking.referenceCode || null,
    eventKey: `booking:${booking.id}:dispatch-reset:${booking.updatedAt}`,
  });
  await appendEvent('TRACKING_DISPATCH_RESET', {
    source: 'TRACKING_CONSOLE',
    actor: req.user.email,
    entityType: 'BOOKING',
    entityId: booking.id,
    referenceCode: booking.referenceCode,
    details: { assignmentId: active?.id || null, providerId: active?.providerId || null },
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
  // Lifecycle updates: the customer hears about stage changes as they
  // happen (en route / arrived / diagnosis / estimate), not only when
  // a setter presses the manual notify button.
  if (action === 'EN_ROUTE') {
    // A setter advancing the stage on the tech's behalf has no tech
    // identity/photo to snapshot — the alert goes out with the window
    // and ETA only (A3); the tech's own tap adds name + photo.
    notifyTechEnRoute(booking, 'TRACKING_CONSOLE', { etaMinutes: etaMinutes ?? null });
  } else if (action === 'ARRIVED' || action === 'DIAGNOSIS' || action === 'ESTIMATE') {
    notifyTrackingUpdate(booking, computeTracking(booking).stageLabel8, 'TRACKING_CONSOLE', `booking:${booking.id}:stage:${action}:${booking.updatedAt}`);
  }
  if (action !== 'COMPLETE') {
    emitReport({
      department: 'field',
      type: 'JOB_STAGE_UPDATE',
      title: `Job stage: ${action} — ${booking.referenceCode || booking.id}`,
      detail: { bookingId: booking.id, bookingReference: booking.referenceCode || null, service: booking.appliance || null, city: booking.city || null, action, stage: computeTracking(booking).stageLabel8 || null },
      source: 'TRACKING_CONSOLE',
      reference: booking.referenceCode || null,
      eventKey: `booking:${booking.id}:stage:${action}:${booking.updatedAt}:report`,
    });
  }
  if (action === 'COMPLETE') {
    emitReport({
      department: 'field',
      type: 'JOB_COMPLETED',
      title: `Job completed — ${booking.referenceCode || booking.id}`,
      detail: { bookingId: booking.id, bookingReference: booking.referenceCode || null, customerName: booking.customer?.name || null, service: booking.appliance || null, city: booking.city || null, completedBy: req.user.email, completedAt: booking.completedAt || null },
      source: 'TRACKING_CONSOLE',
      reference: booking.referenceCode || null,
      eventKey: `booking:${booking.id}:completed:report`,
    });
    try {
      // Unify with POST /bookings/:id/complete: a console completion runs
      // the same completion side-effects — stamp completedAt/completedBy
      // when unset, issue the customer's own referral code, and advance
      // the ApplianceReferral journey when this was a referred booking.
      if (!booking.completedAt) {
        booking.completedAt = new Date().toISOString();
        booking.completedBy = req.user.email;
        await persistBooking(booking);
      }
      issueReferralForBooking(booking, 'TRACKING_CONSOLE');
      await advanceReferralOnCompletion(booking, 'TRACKING_CONSOLE');
    } catch {
      // Referral issuance/advancement must never block a completion.
    }
  }
  await appendEvent('TRACKING_STAGE', {
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
  await appendEvent('TRACKING_LINK_ISSUED', {
    source: 'TRACK_CONSOLE',
    actor: req.user.email,
    entityType: 'BOOKING',
    entityId: booking.id,
    referenceCode: booking.referenceCode,
    details: { expiresAt: record.expiresAt },
  });
  return res.status(201).json({ data: { url: `/track?t=${raw}`, expiresAt: record.expiresAt } });
});

/** Shared token gate for the public tracking reads: resolves the
 * booking behind a tracking token, or answers the error itself and
 * returns null. */
function bookingForTrackingToken(req, res) {
  const tokenHash = createHash('sha256').update(String(req.params.token || '')).digest('hex');
  const record = store.trackingTokens.get(tokenHash);
  if (!record || record.revokedAt) {
    res.status(404).json({ error: 'Tracking link not found' });
    return null;
  }
  if (new Date(record.expiresAt).getTime() < Date.now()) {
    res.status(410).json({ error: 'This tracking link has expired' });
    return null;
  }
  const booking = store.bookings.get(record.bookingId);
  if (!booking) {
    res.status(404).json({ error: 'Booking not found' });
    return null;
  }
  if (
    booking.status === 'COMPLETED' &&
    booking.completedAt &&
    Date.now() - new Date(booking.completedAt).getTime() > 24 * 3600 * 1000
  ) {
    res.status(410).json({ error: 'This tracking link has expired' });
    return null;
  }
  return booking;
}

function serveTechPhoto(req, res, booking) {
  const photo = techPhotoFor(booking);
  if (!photo) return res.status(404).json({ error: 'No technician photo on this job' });
  res.set({
    'Content-Type': photo.mime,
    'Cache-Control': 'private, no-store',
    'Content-Length': photo.bytes.length,
    'Content-Disposition': 'inline; filename="your-technician"',
  });
  return res.end(photo.bytes);
}

/** Public tracking via a secure per-job token — no phone number needed. */
router.get('/tracking/by-token/:token', async (req, res) => {
  const booking = bookingForTrackingToken(req, res);
  if (!booking) return undefined;
  const tracking = await enrichTrackingWithMap(booking, computeTracking(booking));
  return res.json({ data: { ...tracking, payment: paymentSummary(booking.id), photoReport: photoReportOf(booking) } });
});

/** The tech's real profile photo for a token-tracked job (A3) — the
 * "On My Way" MMS and the tracking page read it here. 404 when the
 * tech has no photo on their profile: never a placeholder. */
router.get('/tracking/by-token/:token/tech-photo', (req, res) => {
  const booking = bookingForTrackingToken(req, res);
  if (!booking) return undefined;
  return serveTechPhoto(req, res, booking);
});

/** The same photo for the signed-in customer who owns the booking. */
router.get('/tracking/bookings/:bookingId/tech-photo', authenticate, (req, res) => {
  const booking = bookingsForUser(req.user).find((b) => b.id === req.params.bookingId);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  return serveTechPhoto(req, res, booking);
});

/** And for the guest lookup: same reference + phone proof the public
 * tracking read requires (routes/bookings.js /bookings/track). */
router.get('/tracking/by-reference/:reference/tech-photo', (req, res) => {
  const phoneDigits = digits10(req.query.phone || '');
  if (phoneDigits.length < 10) {
    return res.status(400).json({ error: 'Booking reference and the phone number on the booking are required' });
  }
  const booking = findBookingByReference(req.params.reference);
  if (!booking) return res.status(404).json({ error: 'No booking found with that reference' });
  const bookingPhone = digits10(booking.customer?.phone || booking.phone || '');
  if (!bookingPhone || bookingPhone !== phoneDigits) {
    return res.status(403).json({ error: 'That phone number does not match this booking' });
  }
  return serveTechPhoto(req, res, booking);
});

export default router;