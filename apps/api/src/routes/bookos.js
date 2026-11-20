import { Router } from 'express';
import { paymentSummary } from '../db/paymentsRepo.js';
import { z } from 'zod';
import { ROLES, STAFF_ROLES } from '../config/security.js';
import { areasForZip, effectiveArea, effectiveAreaStatus, normalizePublishedCityName, PUBLISHED_CITY_NAMES, SERVICE_CITIES } from '../config/serviceAreas.js';
import { addBookingEvent, appendEvent, store } from '../data/store.js';
import { persistAssignment, persistBooking } from '../db/bookingsRepo.js';
import {
  OPS_THRESHOLDS,
  capacityCeiling,
  deriveExceptions,
  deriveRecoveryQueues,
  priorityTierOf,
  rankAssignmentCandidates,
} from '../services/dispatchOps.js';
import { loadDispatchSettings, saveDispatchSettings } from '../db/dispatchOpsRepo.js';
import { DISTANCE_NOTE, byDistanceAsc, jobPosition, providerPosition } from '../services/dispatchMap.js';
import { listReviewComments, listReviews } from '../db/reviewsRepo.js';
import { db, DATABASE_ENABLED } from '../db/client.js';
import { stripeConfigured } from '../services/stripe.js';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import {
  APPOINTMENT_WINDOWS,
  APPOINTMENT_WINDOW_IDS,
  isValidDateString,
  slotForArea,
  todayDateString,
  windowById,
} from '../services/bookos.js';
import { notifyAppointmentReminder, notifyBookingConfirmation } from '../services/notifications.js';
import { clearAvailabilityCache } from '../services/availability.js';
import { runReminderSweep } from '../services/reminders.js';
import { bookingCommsFlags } from '../services/messageThreads.js';
import { countSubmissionMedia } from '../db/submissionMediaRepo.js';
import { emitReport } from '../services/managementReports.js';
import {
  estimateDecisionSchema,
  estimateSchema,
  generateInvoiceForJob,
  jobMoneyView,
  recordEstimateDecisionForJob,
  recordReceiptForJob,
  receiptSchema,
  saveEstimateForJob,
} from '../services/jobMoney.js';
import { createWorkOrder, findCustomersForCreate, workOrderCreateSchema } from '../services/workOrders.js';
import { surfaceOfBooking, leadConnectionOf } from '../services/trackingNumbers.js';

const router = Router();

/**
 * Book OS — the Service Setters appointment book and dispatch board.
 *
 * Daily rhythm: new bookings land in the setter queue (PENDING_DISPATCH)
 * → a setter confirms the appointment (date + window) → dispatch matches
 * and Service Setters approve (existing /dispatch routes) → day-before
 * reminder run → job completes. All setter actions append to the
 * platform event feed with actor role DISPATCHER (team: Service Setters).
 */

const staffOnly = [authenticate, requireCompany, requireRole(...STAFF_ROLES)];

const dateParam = z.string().refine(isValidDateString, { message: 'date must be a valid YYYY-MM-DD' });

const setAppointmentSchema = z.object({
  bookingId: z.string().uuid(),
  date: dateParam,
  window: z.enum(APPOINTMENT_WINDOW_IDS),
  setBy: z.string().trim().min(2).default('Service Setters'),
});

const rescheduleSchema = z.object({
  date: dateParam,
  window: z.enum(APPOINTMENT_WINDOW_IDS),
  rescheduledBy: z.string().trim().min(2).default('Service Setters'),
  reason: z.string().trim().optional(),
});

const remindersSchema = z.object({
  date: dateParam,
});

/**
 * Today in the business timezone (America/New_York) as YYYY-MM-DD.
 * Appointment setting refuses past dates against THIS clock — the
 * setters work Eastern days, and a UTC "today" would wrongly refuse
 * same-day evening appointments (and wrongly allow yesterday's).
 */
function todayInNewYork() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function visibleBookings(req) {
  return [...store.bookings.values()].filter(
    (booking) => req.user.roles.includes(ROLES.PLATFORM_ADMIN) || booking.companyId === req.companyId,
  );
}

/* ================= Create flows (2026-11-19) =================
 * Origination inside Book OS: Service Setters create phone / walk-in
 * work orders into the SAME intake the web form feeds (source OFFICE,
 * via book-os), and run the money chain from the booking — estimate,
 * decision, invoice, receipt — through services/jobMoney.js, the one
 * implementation the Tech App also uses. A setter confirming an
 * estimate or recording a receipt is recorded as SERVICE_SETTERS,
 * never as the technician.
 */

function loadVisibleBooking(req, res) {
  const booking = store.bookings.get(req.params.id);
  const visible = booking
    && (req.user.roles.includes(ROLES.PLATFORM_ADMIN) || booking.companyId === req.companyId);
  if (!visible) {
    res.status(404).json({ error: 'Booking not found' });
    return null;
  }
  return booking;
}

const moneyCtx = (req) => ({
  actor: req.user.email,
  source: 'BOOK_OS',
  confirmedBy: 'SERVICE_SETTERS',
});

router.post('/bookos/work-orders', ...staffOnly, async (req, res) => {
  const parsed = workOrderCreateSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid work order', details: parsed.error.flatten() });
  }
  let assignProvider = null;
  if (parsed.data.providerId) {
    assignProvider = store.providers.find((provider) => provider.id === parsed.data.providerId) || null;
    if (!assignProvider) {
      return res.status(400).json({ error: 'That provider is not on the network roster — leave the job unassigned or pick another provider' });
    }
  }
  const result = await createWorkOrder({
    actor: req.user.email,
    source: 'OFFICE',
    via: 'book-os',
    input: parsed.data,
    assignProvider,
    assignmentStatus: 'APPROVED',
  });
  if (!result.ok) return res.status(result.status).json({ error: result.error, ...(result.code ? { code: result.code } : {}) });
  return res.status(201).json({
    data: {
      booking: {
        id: result.booking.id,
        referenceCode: result.booking.referenceCode,
        status: result.booking.status,
        source: result.booking.source,
        appliance: result.booking.appliance,
        issue: result.booking.issue,
        city: result.booking.city,
        areaStatus: result.booking.areaStatus,
        customer: { name: result.booking.customer.name, phone: result.booking.customer.phone },
      },
      assignment: result.assignment
        ? { id: result.assignment.id, providerId: result.assignment.providerId, status: result.assignment.status }
        : null,
      customerCreated: result.customerCreated,
    },
  });
});

/* The dispatch roster (2026-11-19, Directive 8): every active
 * provider on the ONE pipeline, tagged with its tech system —
 * setters dispatch to company techs and network providers from the
 * same board, and the side is attributed on every target. */
router.get('/bookos/providers', ...staffOnly, (req, res) => {
  const data = (store.providers || [])
    .filter((provider) => provider.active !== false)
    .map((provider) => ({
      id: provider.id,
      businessName: provider.businessName,
      type: provider.type,
      system: provider.companyCrew ? 'COMPANY' : 'NETWORK',
      serviceCities: provider.serviceCities || [],
      specialties: provider.specialties || [],
    }))
    .sort((a, b) => String(a.businessName).localeCompare(String(b.businessName)));
  return res.json({ data });
});

router.get('/bookos/customers', ...staffOnly, (req, res) => {
  return res.json({ data: findCustomersForCreate(req.query.q, null) });
});

router.get('/bookos/bookings/:id/money', ...staffOnly, (req, res) => {
  const booking = loadVisibleBooking(req, res);
  if (!booking) return;
  return res.json({ data: jobMoneyView(booking) });
});

router.post('/bookos/bookings/:id/estimate', ...staffOnly, async (req, res) => {
  const booking = loadVisibleBooking(req, res);
  if (!booking) return;
  const parsed = estimateSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid estimate', details: parsed.error.flatten() });
  }
  const result = await saveEstimateForJob(booking, parsed.data, moneyCtx(req));
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  return res.status(201).json({ data: { estimate: result.estimate } });
});

router.post('/bookos/bookings/:id/estimate/decision', ...staffOnly, async (req, res) => {
  const booking = loadVisibleBooking(req, res);
  if (!booking) return;
  const parsed = estimateDecisionSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid estimate decision', details: parsed.error.flatten() });
  }
  const result = await recordEstimateDecisionForJob(booking, parsed.data, moneyCtx(req));
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  return res.status(201).json({
    data: { estimateDecision: result.estimateDecision, authorizationLog: result.authorizationLog },
  });
});

router.post('/bookos/bookings/:id/invoice', ...staffOnly, async (req, res) => {
  const booking = loadVisibleBooking(req, res);
  if (!booking) return;
  const result = await generateInvoiceForJob(booking, moneyCtx(req));
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  if (!result.created) return res.json({ data: { invoice: result.invoice, created: false } });
  return res.status(201).json({ data: { invoice: result.invoice, created: true } });
});

router.post('/bookos/bookings/:id/receipts', ...staffOnly, async (req, res) => {
  const booking = loadVisibleBooking(req, res);
  if (!booking) return;
  const parsed = receiptSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid receipt', details: parsed.error.flatten() });
  }
  const result = await recordReceiptForJob(booking, parsed.data, moneyCtx(req));
  if (!result.ok) {
    return res.status(result.status).json({
      error: result.error,
      ...(result.balanceDueCents != null ? { balanceDueCents: result.balanceDueCents } : {}),
    });
  }
  return res.status(201).json({
    data: { receipt: result.receipt, receipts: result.receipts, payments: result.payments },
  });
});

function appointmentSummary(booking) {
  if (!booking.appointment) return null;
  const { date, window, status, setAt, setBy } = booking.appointment;
  return { date, window, windowLabel: windowById(window)?.label || window, status, setAt, setBy };
}

/**
 * Residential/commercial segment for queue + board rows. New bookings
 * record `segment` at creation; it is derived from the persisted
 * `source` when absent (records written before the field existed, and
 * records rehydrated from the database, where only `source` is a
 * column) so every row carries the distinction setters filter by.
 */
function segmentOf(booking) {
  if (booking.segment) return booking.segment;
  return booking.source === 'COMMERCIAL' || booking.commercial ? 'COMMERCIAL' : 'RESIDENTIAL';
}

/** The day's windows with per-area capacity, derived from live bookings. */
router.get('/bookos/slots', ...staffOnly, (req, res) => {
  const parsed = z.object({ date: dateParam }).safeParse({ date: req.query.date });
  if (!parsed.success) {
    return res.status(400).json({ error: 'A valid date query (?date=YYYY-MM-DD) is required', details: parsed.error.flatten() });
  }
  const { date } = parsed.data;
  const windows = APPOINTMENT_WINDOWS.map((window) => ({
    window: window.id,
    start: window.start,
    end: window.end,
    label: window.label,
    areas: SERVICE_CITIES.map((city) => slotForArea({ date, windowId: window.id, city })),
  }));
  return res.json({ data: { date, windows } });
});

/**
 * Setter queue: bookings still PENDING_DISPATCH — new requests a setter
 * has not confirmed with the customer yet — oldest first. Service Book
 * area rules: out-of-area requests never enter this queue (they sit on
 * the expansion waitlist); area-review requests appear flagged so a
 * setter resolves the area first. ?area=<city> narrows to one area.
 */
/**
 * The lead link for a queue row: which intake connection created this
 * booking. Live bookings carry it on `booking.lead`; after a cold
 * restart the booking is rehydrated without it (it is not a database
 * column), but the BOOKING_CREATED history entry IS persisted and
 * carries the connection id / reference / type — resolve from there,
 * and from the reference to the connection record when needed.
 */
function leadLinkOf(booking) {
  if (booking.lead?.connectionId) {
    return {
      connectionId: booking.lead.connectionId,
      connectionReference: booking.lead.connectionReference || null,
      connectionType: booking.lead.connectionType || null,
    };
  }
  const created = (booking.history || []).find((h) => (h.type || h.event) === 'BOOKING_CREATED' && (h.connectionId || h.connectionReference));
  if (!created) return null;
  let connectionId = created.connectionId || null;
  if (!connectionId && created.connectionReference) {
    const conn = store.connections.find((c) => c.reference === created.connectionReference);
    if (conn) connectionId = conn.id;
  }
  if (!connectionId && !created.connectionReference) return null;
  return {
    connectionId,
    connectionReference: created.connectionReference || null,
    connectionType: created.connectionType || null,
  };
}

const MEDIA_LEAD_TYPES = ['PEPPER_LISTS_SCAN', 'PEPPER_LISTS_LIVE_VIDEO'];

router.get('/bookos/setter-queue', ...staffOnly, async (req, res) => {
  const now = Date.now();
  const areaFilter = String(req.query.area || '').trim();
  const rows = visibleBookings(req)
    .filter((booking) => booking.status === 'PENDING_DISPATCH' && effectiveAreaStatus(booking) !== 'OUT_OF_AREA')
    .filter((booking) => !areaFilter || effectiveArea(booking) === areaFilter || booking.city === areaFilter)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const queue = await Promise.all(rows.map(async (booking) => {
    const lead = leadLinkOf(booking);
    // Media count only for Pepper Lists submissions (the only intake
    // that carries SubmissionMedia) — a COUNT query, never the bytes.
    const mediaCount = lead?.connectionId && MEDIA_LEAD_TYPES.includes(lead.connectionType)
      ? await countSubmissionMedia(lead.connectionId)
      : null;
    return {
      bookingId: booking.id,
      referenceCode: booking.referenceCode || null,
      source: booking.source || null,
      // Tracking numbers (2026-11-19): originating surface, resolved
      // from via/source — null when unknown. Additive fields.
      ...surfaceOfBooking(booking, leadConnectionOf(booking, store.connections)),
      segment: segmentOf(booking),
      ageMinutes: Math.max(0, Math.floor((now - new Date(booking.createdAt).getTime()) / 60000)),
      createdAt: booking.createdAt,
      customerName: booking.customer?.name || null,
      customerPhone: booking.customer?.phone || null,
      city: booking.city,
      zip: booking.zip,
      area: effectiveArea(booking),
      areaStatus: effectiveAreaStatus(booking),
      needsAreaReview: effectiveAreaStatus(booking) === 'AREA_REVIEW',
      serviceAddress: booking.serviceAddress || booking.customer?.address || null,
      appliance: booking.appliance,
      payment: paymentSummary(booking.id),
      issue: booking.issue,
      priority: booking.priority || false,
      priorityTier: priorityTierOf(booking),
      preferredWindow: booking.preferredWindow || null,
      preferredDate: booking.preferredDate || null,
      appointment: appointmentSummary(booking),
      lead,
      mediaCount,
    };
  }));
  return res.json({ data: { count: queue.length, queue } });
});

/** Confirm an appointment with the customer: date + window on a booking. */
router.post('/bookos/appointments', ...staffOnly, async (req, res) => {
  const parsed = setAppointmentSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid appointment request', details: parsed.error.flatten() });
  }
  const { bookingId, date, window, setBy } = parsed.data;

  const booking = store.bookings.get(bookingId);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (date < todayInNewYork()) {
    return res.status(400).json({ error: 'Appointment date cannot be in the past' });
  }
  if (booking.status === 'COMPLETED') {
    return res.status(409).json({ error: 'Booking is already completed' });
  }
  if (booking.appointment?.status === 'SET') {
    return res.status(409).json({ error: 'Appointment already set; use the reschedule endpoint to move it' });
  }
  const areaStatus = effectiveAreaStatus(booking);
  if (areaStatus === 'OUT_OF_AREA') {
    return res.status(409).json({ error: 'This request is outside the service area — it is on the expansion waitlist and cannot take an appointment' });
  }
  const area = effectiveArea(booking);
  if (areaStatus !== 'IN_AREA' || !area) {
    return res.status(409).json({ error: 'Resolve the service area first (POST /bookos/bookings/:id/resolve-area), then set the appointment' });
  }
  const slot = slotForArea({ date, windowId: window, city: area });
  if (slot.remaining <= 0) {
    return res.status(409).json({ error: 'That window is full for this service area', slot });
  }

  const windowInfo = windowById(window);
  booking.appointment = {
    date,
    window,
    windowLabel: windowInfo.label,
    status: 'SET',
    setAt: new Date().toISOString(),
    setBy,
    history: [],
  };
  booking.updatedAt = booking.appointment.setAt;
  addBookingEvent(booking, 'APPOINTMENT_SET', setBy, { date, window });
  await appendEvent('APPOINTMENT_SET', {
    source: booking.source || null,
    actor: ROLES.DISPATCHER,
    entityType: 'BOOKING',
    entityId: booking.id,
    referenceCode: booking.referenceCode || null,
    details: { team: 'Service Setters', setBy, date, window, city: booking.city, status: booking.status },
  });
  const confirmations = notifyBookingConfirmation(booking, booking.source || null);
  emitReport({
    department: 'dispatch',
    type: 'JOB_APPOINTMENT_SET',
    title: `Appointment set — ${booking.referenceCode || booking.id}`,
    detail: { bookingId: booking.id, bookingReference: booking.referenceCode || null, customerName: booking.customer?.name || null, service: booking.appliance || null, city: booking.city || null, date, window, setBy },
    source: booking.source || null,
    reference: booking.referenceCode || null,
    eventKey: `booking:${booking.id}:appointment-set:${booking.appointment.setAt}:report`,
  });
  await persistBooking(booking);
  // A SET appointment moves the public window-availability counts.
  clearAvailabilityCache();

  return res.status(201).json({
    data: {
      bookingId: booking.id,
      referenceCode: booking.referenceCode || null,
      appointment: appointmentSummary(booking),
      bookingStatus: booking.status,
      notificationsQueued: confirmations.map((entry) => ({ id: entry.id, channel: entry.channel, template: entry.template, to: entry.to })),
    },
  });
});

/** Move an already-set appointment to a new date/window. */
router.post('/bookos/appointments/:bookingId/reschedule', ...staffOnly, async (req, res) => {
  const parsed = rescheduleSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid reschedule request', details: parsed.error.flatten() });
  }
  const { date, window, rescheduledBy, reason } = parsed.data;

  const booking = store.bookings.get(req.params.bookingId);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (date < todayInNewYork()) {
    return res.status(400).json({ error: 'Appointment date cannot be in the past' });
  }
  if (booking.status === 'COMPLETED') {
    return res.status(409).json({ error: 'Booking is already completed' });
  }
  if (booking.appointment?.status !== 'SET') {
    return res.status(409).json({ error: 'No appointment is set yet; use POST /bookos/appointments to set one' });
  }
  const slot = slotForArea({ date, windowId: window, city: effectiveArea(booking) || booking.city, excludeBookingId: booking.id });
  if (slot.remaining <= 0) {
    return res.status(409).json({ error: 'That window is full for this service area', slot });
  }

  const previous = { date: booking.appointment.date, window: booking.appointment.window };
  const windowInfo = windowById(window);
  booking.appointment = {
    ...booking.appointment,
    date,
    window,
    windowLabel: windowInfo.label,
    status: 'SET',
    setAt: new Date().toISOString(),
    setBy: rescheduledBy,
    history: [...(booking.appointment.history || []), { ...previous, movedAt: new Date().toISOString(), movedBy: rescheduledBy, reason: reason || null }],
  };
  booking.updatedAt = booking.appointment.setAt;
  addBookingEvent(booking, 'APPOINTMENT_RESCHEDULED', rescheduledBy, { from: previous, to: { date, window }, reason: reason || null });
  await appendEvent('APPOINTMENT_RESCHEDULED', {
    source: booking.source || null,
    actor: ROLES.DISPATCHER,
    entityType: 'BOOKING',
    entityId: booking.id,
    referenceCode: booking.referenceCode || null,
    details: { team: 'Service Setters', rescheduledBy, from: previous, to: { date, window }, city: booking.city },
  });
  const confirmations = notifyBookingConfirmation(booking, booking.source || null);
  await persistBooking(booking);
  // A SET appointment moves the public window-availability counts.
  clearAvailabilityCache();

  return res.json({
    data: {
      bookingId: booking.id,
      referenceCode: booking.referenceCode || null,
      previousAppointment: previous,
      appointment: appointmentSummary(booking),
      bookingStatus: booking.status,
      notificationsQueued: confirmations.map((entry) => ({ id: entry.id, channel: entry.channel, template: entry.template, to: entry.to })),
    },
  });
});

/**
 * Day-before reminder run (simulation): queues an APPOINTMENT_REMINDER
 * for every booking with an appointment SET on the given date whose job
 * is not completed yet.
 */
router.post('/bookos/reminders/run', ...staffOnly, async (req, res) => {
  const parsed = remindersSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid reminder run', details: parsed.error.flatten() });
  }
  const { date } = parsed.data;

  const targets = visibleBookings(req).filter(
    (booking) =>
      booking.appointment?.status === 'SET' &&
      booking.appointment.date === date &&
      booking.status !== 'COMPLETED',
  );
  const queued = [];
  for (const booking of targets) {
    for (const entry of notifyAppointmentReminder(booking, booking.source || null)) {
      queued.push({ bookingId: booking.id, notificationId: entry.id, channel: entry.channel, to: entry.to });
    }
  }
  await appendEvent('APPOINTMENT_REMINDERS_RUN', {
    actor: ROLES.DISPATCHER,
    entityType: 'BOOKING',
    details: { team: 'Service Setters', date, bookingsReminded: targets.length, notificationsQueued: queued.length },
  });

  return res.json({
    data: {
      date,
      bookingsReminded: targets.length,
      bookingIds: targets.map((booking) => booking.id),
      notificationsQueued: queued,
    },
  });
});

const sweepSchema = z.object({
  today: dateParam.optional(),
});

/**
 * Automated reminder sweep (2026-11-20, Wave 1 setter comms D2):
 * queues the reply-able day-before + morning-of reminders for every
 * appointment due relative to the business day (or the given `today`
 * for a catch-up run) and records them on each booking's message
 * thread. Idempotent — re-running sends nothing twice. The same
 * sweep is reachable by an external scheduler through
 * GET /bookos/reminders/cron-sweep (CRON_SECRET-guarded).
 */
router.post('/bookos/reminders/sweep', ...staffOnly, async (req, res) => {
  const parsed = sweepSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid reminder sweep', details: parsed.error.flatten() });
  }
  const summary = await runReminderSweep({
    today: parsed.data.today || null,
    companyId: req.companyId,
    source: 'bookos-sweep',
  });
  return res.json({ data: summary });
});

const noShowSchema = z.object({
  note: z.string().trim().max(500).optional(),
  markedBy: z.string().trim().min(2).default('Service Setters'),
});

/**
 * Mark a booking as a customer no-show (2026-11-20, Wave 1 setter
 * comms D2): the customer did not answer the door for a set
 * appointment. The mark is a booking history event; it derives into
 * the Book OS exception queue (type NO_SHOW) until the job is
 * rebooked (a later appointment set / reschedule clears it) or
 * completed.
 */
router.post('/bookos/bookings/:id/no-show', ...staffOnly, async (req, res) => {
  const parsed = noShowSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid no-show request', details: parsed.error.flatten() });
  }
  const booking = loadVisibleBooking(req, res);
  if (!booking) return;
  if (booking.status === 'COMPLETED') {
    return res.status(409).json({ error: 'A completed job cannot be marked as a no-show' });
  }
  if (booking.status === 'CANCELLED') {
    return res.status(409).json({ error: 'A cancelled booking cannot be marked as a no-show' });
  }
  if (booking.appointment?.status !== 'SET') {
    return res.status(409).json({ error: 'No appointment is set on this booking — a no-show needs a set appointment' });
  }
  if (bookingCommsFlags(booking).noShowAt) {
    return res.status(409).json({ error: 'This booking is already marked as a no-show' });
  }
  booking.updatedAt = new Date().toISOString();
  addBookingEvent(booking, 'CUSTOMER_NO_SHOW', parsed.data.markedBy, {
    note: parsed.data.note || null,
    date: booking.appointment.date,
    window: booking.appointment.window,
  });
  await appendEvent('CUSTOMER_NO_SHOW', {
    source: booking.source || null,
    actor: ROLES.DISPATCHER,
    entityType: 'BOOKING',
    entityId: booking.id,
    referenceCode: booking.referenceCode || null,
    details: { team: 'Service Setters', markedBy: parsed.data.markedBy, note: parsed.data.note || null, date: booking.appointment.date, window: booking.appointment.window },
  });
  await persistBooking(booking);
  return res.json({
    data: { bookingId: booking.id, referenceCode: booking.referenceCode || null, noShowAt: bookingCommsFlags(booking).noShowAt },
  });
});

const BOARD_STATUSES = ['PENDING_DISPATCH', 'MATCH_PENDING_APPROVAL', 'CONFIRMED', 'COMPLETED'];

/**
 * Dispatch board: today's pipeline grouped by status. Starter rule:
 * a booking is on today's board if it was created today or its
 * appointment is today (Phase 1 in-memory demo — every live record is
 * recent). Dispatch itself still runs through /dispatch/match + approve.
 */
router.get('/bookos/dispatch-board', ...staffOnly, (req, res) => {
  const date = todayDateString();
  // Service Book Pro area-first working views: ?area=<city> narrows the
  // whole board to one service area; ?window=<id> narrows to bookings
  // whose set appointment (or preferred window, before one is set)
  // falls in that window. Out-of-area requests are never on the board.
  const areaFilter = String(req.query.area || '').trim();
  const windowFilter = String(req.query.window || '').trim();
  const todays = visibleBookings(req).filter(
    (booking) =>
      BOARD_STATUSES.includes(booking.status) &&
      effectiveAreaStatus(booking) !== 'OUT_OF_AREA' &&
      (booking.createdAt.slice(0, 10) === date || booking.appointment?.date === date) &&
      (!areaFilter || effectiveArea(booking) === areaFilter) &&
      (!windowFilter || booking.appointment?.window === windowFilter || (!booking.appointment && booking.preferredWindow === windowFilter)),
  );
  const groups = {};
  const counts = {};
  for (const status of BOARD_STATUSES) {
    const items = todays
      .filter((booking) => booking.status === status)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((booking) => ({
        bookingId: booking.id,
        referenceCode: booking.referenceCode || null,
        source: booking.source || null,
        // Tracking numbers (2026-11-19): originating surface. Additive.
        ...surfaceOfBooking(booking, leadConnectionOf(booking, store.connections)),
        segment: segmentOf(booking),
        city: booking.city,
        area: effectiveArea(booking),
        areaStatus: effectiveAreaStatus(booking),
        serviceAddress: booking.serviceAddress || booking.customer?.address || null,
        appliance: booking.appliance,
        priorityTier: priorityTierOf(booking),
        customerName: booking.customer?.name || null,
        payment: paymentSummary(booking.id),
        appointment: appointmentSummary(booking),
        providerId: booking.dispatch?.providerId || null,
        createdAt: booking.createdAt,
      }));
    groups[status] = items;
    counts[status] = items.length;
  }
  return res.json({ data: { date, filters: { area: areaFilter || null, window: windowFilter || null }, counts, groups } });
});

/**
 * Service Book Pro — area day view. One service area, one day: the jobs
 * holding appointments in window order (route sanity for the setter
 * working that area), plus the area's still-unappointed requests.
 */
router.get('/bookos/area-day', ...staffOnly, (req, res) => {
  const parsed = z
    .object({ date: dateParam, area: z.string().trim().min(2) })
    .safeParse({ date: req.query.date, area: req.query.area });
  if (!parsed.success) {
    return res.status(400).json({ error: 'Query ?date=YYYY-MM-DD and ?area=<covered city> are required', details: parsed.error.flatten() });
  }
  const { date } = parsed.data;
  // Widened 2026-11-20 (A6): the day view accepts any of the 65
  // published cities, canonicalized — not just the 12 core crew areas.
  const area = normalizePublishedCityName(parsed.data.area);
  if (!area) {
    return res.status(422).json({ error: 'Unknown service area', serviceAreas: PUBLISHED_CITY_NAMES });
  }
  const inArea = visibleBookings(req).filter(
    (booking) => effectiveArea(booking) === area && effectiveAreaStatus(booking) === 'IN_AREA' && booking.status !== 'CANCELLED',
  );
  const brief = (booking) => ({
    bookingId: booking.id,
    referenceCode: booking.referenceCode || null,
    status: booking.status,
    customerName: booking.customer?.name || null,
    customerPhone: booking.customer?.phone || null,
    serviceAddress: booking.serviceAddress || booking.customer?.address || null,
    zip: booking.zip,
    appliance: booking.appliance,
    issue: booking.issue,
    priorityTier: priorityTierOf(booking),
    appointment: appointmentSummary(booking),
    providerId: booking.dispatch?.providerId || null,
  });
  const windows = APPOINTMENT_WINDOWS.map((window) => ({
    window: window.id,
    label: window.label,
    slot: slotForArea({ date, windowId: window.id, city: area }),
    jobs: inArea
      .filter((booking) => booking.appointment?.status === 'SET' && booking.appointment.date === date && booking.appointment.window === window.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(brief),
  }));
  const unappointed = inArea
    .filter((booking) => booking.appointment?.status !== 'SET' && booking.status === 'PENDING_DISPATCH')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map(brief);
  return res.json({ data: { date, area, windows, unappointed } });
});

/**
 * Expansion waitlist — every request the area model could not place:
 * OUT_OF_AREA (outside the covered footprint entirely) and AREA_REVIEW
 * (covered ZIP, ambiguous area). These are demand signals for expansion
 * decisions; nobody on this list has been promised service.
 */
router.get('/bookos/waitlist', ...staffOnly, (req, res) => {
  const items = visibleBookings(req)
    .filter((booking) => ['OUT_OF_AREA', 'AREA_REVIEW'].includes(effectiveAreaStatus(booking)) && booking.status !== 'CANCELLED')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((booking) => ({
      bookingId: booking.id,
      referenceCode: booking.referenceCode || null,
      source: booking.source || null,
      createdAt: booking.createdAt,
      customerName: booking.customer?.name || null,
      customerPhone: booking.customer?.phone || null,
      customerEmail: booking.customer?.email || null,
      city: booking.city,
      zip: booking.zip,
      serviceAddress: booking.serviceAddress || booking.customer?.address || null,
      areaStatus: effectiveAreaStatus(booking),
      candidateAreas: effectiveAreaStatus(booking) === 'AREA_REVIEW' ? areasForZip(booking.zip) : [],
      appliance: booking.appliance,
      issue: booking.issue,
      status: booking.status,
    }));
  return res.json({
    data: {
      count: items.length,
      outOfArea: items.filter((i) => i.areaStatus === 'OUT_OF_AREA').length,
      needsReview: items.filter((i) => i.areaStatus === 'AREA_REVIEW').length,
      items,
    },
  });
});

const resolveAreaSchema = z.object({
  area: z.string().trim().min(2),
  resolvedBy: z.string().trim().min(2).default('Service Setters'),
});

/**
 * A Service Setter resolves an AREA_REVIEW booking into its true area
 * (the customer confirms the city on the call). Human decision only —
 * Speedy can flag ambiguity, it never picks the area.
 */
router.post('/bookos/bookings/:id/resolve-area', ...staffOnly, async (req, res) => {
  const parsed = resolveAreaSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid area resolution', details: parsed.error.flatten() });
  }
  const booking = store.bookings.get(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  const area = normalizePublishedCityName(parsed.data.area);
  if (!area) {
    return res.status(422).json({ error: 'Area must be one of the covered service areas', serviceAreas: PUBLISHED_CITY_NAMES });
  }
  if (effectiveAreaStatus(booking) === 'OUT_OF_AREA') {
    return res.status(409).json({ error: 'This request is outside the service footprint entirely — it stays on the expansion waitlist' });
  }
  booking.area = area;
  booking.areaStatus = 'IN_AREA';
  booking.updatedAt = new Date().toISOString();
  addBookingEvent(booking, 'AREA_RESOLVED_BY_SETTER', parsed.data.resolvedBy, { area, previousStatus: 'AREA_REVIEW' });
  await appendEvent('AREA_RESOLVED_BY_SETTER', {
    source: booking.source || null,
    actor: ROLES.DISPATCHER,
    entityType: 'BOOKING',
    entityId: booking.id,
    referenceCode: booking.referenceCode || null,
    details: { team: 'Service Setters', resolvedBy: parsed.data.resolvedBy, area },
  });
  emitReport({
    department: 'dispatch',
    type: 'JOB_AREA_RESOLVED',
    title: `Service area resolved — ${booking.referenceCode || booking.id}`,
    detail: { bookingId: booking.id, bookingReference: booking.referenceCode || null, customerName: booking.customer?.name || null, service: booking.appliance || null, city: booking.city || null, area, resolvedBy: parsed.data.resolvedBy },
    source: booking.source || null,
    reference: booking.referenceCode || null,
    eventKey: `booking:${booking.id}:area-resolved:${booking.updatedAt}:report`,
  });
  await persistBooking(booking);
  return res.json({ data: { bookingId: booking.id, referenceCode: booking.referenceCode || null, area: booking.area, areaStatus: booking.areaStatus } });
});


/**
 * Launch Scorecard — live scoring for the network/platform launch.
 * Confirmation rate = setter-confirmed / customers reached. A booking is
 * "reached" once a setter has acted on it (appointment set or moved, or
 * the job has moved past the untouched queue state) and "confirmed" once
 * its appointment is set. On a clean board both counts are 0 and the rate
 * reads 0% — the launch baseline.
 */
router.get('/bookos/scorecard', ...staffOnly, async (req, res) => {
  const bookings = visibleBookings(req);
  const today = todayDateString();
  const hasEvent = (b, types) => (b.history || []).some((h) => types.includes(h.type || h.event));
  const isConfirmed = (b) =>
    b.appointment?.status === 'SET' ||
    b.status === 'CONFIRMED' ||
    b.status === 'COMPLETED' ||
    hasEvent(b, ['APPOINTMENT_CONFIRMED', 'APPOINTMENT_SET']);
  const isReached = (b) =>
    isConfirmed(b) || (b.appointment?.history?.length || 0) > 0 || b.status !== 'PENDING_DISPATCH';
  const confirmed = bookings.filter(isConfirmed).length;
  const reached = bookings.filter(isReached).length;
  const ratePct = reached > 0 ? Math.round((confirmed / reached) * 100) : 0;

  const byStatus = {};
  const bySource = {};
  for (const b of bookings) {
    byStatus[b.status] = (byStatus[b.status] || 0) + 1;
    const src = b.source || 'WEBSITE';
    bySource[src] = (bySource[src] || 0) + 1;
  }
  const cities = new Set();
  for (const p of store.providers) for (const c of p.serviceCities || []) cities.add(c);
  const byType = {};
  for (const c of store.connections) byType[c.type] = (byType[c.type] || 0) + 1;
  const customers = [...store.customers.values()].filter(
    (c) => req.user.roles.includes(ROLES.PLATFORM_ADMIN) || c.companyId === req.companyId,
  );
  let accounts = null;
  if (DATABASE_ENABLED) {
    try { accounts = await db().user.count({ where: { companyId: req.companyId } }); } catch { accounts = null; }
  }
  const referrals = [...store.referrals.values()];
  const videos = [...store.videoRequests.values()];

  return res.json({
    data: {
      generatedAt: new Date().toISOString(),
      confirmation: { confirmed, reached, ratePct },
      bookings: {
        total: bookings.length,
        today: bookings.filter((b) => String(b.createdAt).slice(0, 10) === today).length,
        byStatus,
        bySource,
      },
      dispatch: {
        dispatched: bookings.filter((b) => b.status === 'CONFIRMED' || b.status === 'COMPLETED').length,
        awaitingApproval: bookings.filter((b) => b.status === 'MATCH_PENDING_APPROVAL').length,
        queueWaiting: bookings.filter((b) => b.status === 'PENDING_DISPATCH').length,
      },
      network: { providersActive: store.providers.filter((p) => p.active).length, citiesCovered: cities.size },
      intake: { connectionsTotal: store.connections.length, byType },
      customers: { total: customers.length, accounts },
      flywheel: {
        referralsIssued: referrals.length,
        referralsRedeemed: referrals.reduce((n, r) => n + (r.redemptions?.length || 0), 0),
        videoRequests: videos.length,
        videoPending: videos.filter((v) => v.status === 'PENDING').length,
      },
      payments: {
        paidOnline: [...store.payments.values()].filter((p) => p.status === 'PAID').length,
        configured: stripeConfigured(),
      },
    },
  });
});

/* =====================================================================
 * Service Setters operations (2026-11-17, Operations Blueprint
 * §§3/5/7/12): the exception queue, P1–P4 priority tiers with the
 * ranked assignment aid, the recovery queues, and the capacity view.
 * Every read here is derived from live job state by
 * services/dispatchOps.js — no parallel lists to drift. Staff-gated,
 * like everything else in Book OS. The only writes are a setter's own
 * audited decisions: setting a tier, flagging a return visit, and
 * cancelling a booking (the lifecycle state the recovery queue reads
 * had no setter action that could reach it before this build).
 * ===================================================================== */

/**
 * The platform's real complaint signal: a customer review the review
 * pipeline escalated (Review.escalated) that the office has not
 * answered yet — an office reply is a STAFF comment in the review
 * queue, and it is what clears the signal.
 */
async function complaintSignals(req) {
  const escalated = await listReviews({ escalatedOnly: true });
  const mine = escalated.filter(
    (review) =>
      review.bookingId &&
      (req.user.roles.includes(ROLES.PLATFORM_ADMIN) || review.companyId === req.companyId),
  );
  const open = [];
  for (const review of mine) {
    const comments = await listReviewComments(review.id);
    if (comments.some((comment) => comment.authorKind === 'STAFF')) continue;
    open.push({
      reviewId: review.id,
      bookingId: review.bookingId,
      rating: review.rating,
      escalationReason: review.escalationReason || null,
      createdAt: review.createdAt,
    });
  }
  return open;
}

/**
 * Exception queue: every open work order that needs office
 * intervention — missed acceptance, late arrival, parts delay,
 * unresolved estimate, unanswered complaint — each with its owner,
 * next action and due time. Derived per request; nothing is stored.
 */
router.get('/bookos/exceptions', ...staffOnly, async (req, res) => {
  const complaints = await complaintSignals(req);
  const items = deriveExceptions(visibleBookings(req), { complaints });
  const counts = {};
  for (const item of items) counts[item.type] = (counts[item.type] || 0) + 1;
  return res.json({
    data: {
      generatedAt: new Date().toISOString(),
      thresholds: OPS_THRESHOLDS,
      counts,
      total: items.length,
      items,
    },
  });
});

/**
 * Recovery queues (blueprint §12): awaiting parts, pending estimates,
 * return visits, cancellations (the win-back list) and unpaid
 * balances. Missed calls are reported as null with the reason: the
 * platform keeps no call log to derive them from honestly.
 */
router.get('/bookos/recovery-queues', ...staffOnly, (req, res) => {
  const queues = deriveRecoveryQueues(visibleBookings(req));
  const counts = {};
  for (const [key, rows] of Object.entries(queues)) counts[key] = rows.length;
  return res.json({
    data: {
      generatedAt: new Date().toISOString(),
      counts,
      queues,
      missedCalls: null,
      notes: {
        missedCalls:
          'No missed-call queue: the platform keeps no call log (Twilio voice forwards calls and alerts the office on voicemail only), so there is no honest source to derive one from yet.',
      },
    },
  });
});

const prioritySchema = z.object({
  tier: z.enum(['P1', 'P2', 'P3', 'P4']),
  setBy: z.string().trim().min(2).default('Service Setters'),
});

/**
 * A setter sets a booking's priority tier (blueprint §5). The stored
 * tier wins over the derived default (installations → P4, everything
 * else → P3) everywhere the tier is shown.
 */
router.post('/bookos/bookings/:id/priority', ...staffOnly, async (req, res) => {
  const parsed = prioritySchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid priority request', details: parsed.error.flatten() });
  }
  const booking = store.bookings.get(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  const previous = priorityTierOf(booking);
  booking.priorityTier = parsed.data.tier;
  booking.updatedAt = new Date().toISOString();
  addBookingEvent(booking, 'PRIORITY_SET', parsed.data.setBy, { tier: parsed.data.tier, previous });
  await appendEvent('PRIORITY_SET', {
    source: booking.source || null,
    actor: ROLES.DISPATCHER,
    entityType: 'BOOKING',
    entityId: booking.id,
    referenceCode: booking.referenceCode || null,
    details: { team: 'Service Setters', setBy: parsed.data.setBy, tier: parsed.data.tier, previous },
  });
  await persistBooking(booking);
  return res.json({
    data: {
      bookingId: booking.id,
      referenceCode: booking.referenceCode || null,
      priorityTier: booking.priorityTier,
      previousTier: previous,
    },
  });
});

const returnVisitSchema = z.object({
  needed: z.boolean(),
  note: z.string().trim().max(500).optional(),
  flaggedBy: z.string().trim().min(2).default('Service Setters'),
});

/**
 * Flag (or clear) a booking as needing a return visit — the explicit
 * signal the Return Visits recovery queue reads. The flag rides the
 * booking's audited history like every other field state.
 */
router.post('/bookos/bookings/:id/return-visit', ...staffOnly, async (req, res) => {
  const parsed = returnVisitSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid return-visit request', details: parsed.error.flatten() });
  }
  const booking = store.bookings.get(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (parsed.data.needed && booking.status === 'CANCELLED') {
    return res.status(409).json({ error: 'A cancelled booking cannot need a return visit' });
  }
  booking.updatedAt = new Date().toISOString();
  addBookingEvent(booking, parsed.data.needed ? 'RETURN_VISIT_FLAGGED' : 'RETURN_VISIT_CLEARED', parsed.data.flaggedBy, {
    note: parsed.data.note || null,
  });
  await appendEvent(parsed.data.needed ? 'RETURN_VISIT_FLAGGED' : 'RETURN_VISIT_CLEARED', {
    source: booking.source || null,
    actor: ROLES.DISPATCHER,
    entityType: 'BOOKING',
    entityId: booking.id,
    referenceCode: booking.referenceCode || null,
    details: { team: 'Service Setters', flaggedBy: parsed.data.flaggedBy, note: parsed.data.note || null },
  });
  await persistBooking(booking);
  return res.json({
    data: { bookingId: booking.id, referenceCode: booking.referenceCode || null, returnVisitNeeded: parsed.data.needed },
  });
});

const cancelSchema = z.object({
  reason: z.string().trim().max(500).optional(),
  cancelledBy: z.string().trim().min(2).default('Service Setters'),
});

/**
 * A setter cancels a booking (customer cancelled, unreachable, booked
 * in error…). The job leaves every working queue and lands on the
 * Cancellations recovery list as a win-back candidate; any live
 * assignment is released. Completed jobs cannot be cancelled.
 */
router.post('/bookos/bookings/:id/cancel', ...staffOnly, async (req, res) => {
  const parsed = cancelSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid cancellation request', details: parsed.error.flatten() });
  }
  const booking = store.bookings.get(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.status === 'COMPLETED') {
    return res.status(409).json({ error: 'A completed job cannot be cancelled' });
  }
  if (booking.status === 'CANCELLED') {
    return res.status(409).json({ error: 'Booking is already cancelled' });
  }
  booking.status = 'CANCELLED';
  booking.updatedAt = new Date().toISOString();
  addBookingEvent(booking, 'BOOKING_CANCELLED', parsed.data.cancelledBy, { reason: parsed.data.reason || null });
  await appendEvent('BOOKING_CANCELLED', {
    source: booking.source || null,
    actor: ROLES.DISPATCHER,
    entityType: 'BOOKING',
    entityId: booking.id,
    referenceCode: booking.referenceCode || null,
    details: { team: 'Service Setters', cancelledBy: parsed.data.cancelledBy, reason: parsed.data.reason || null },
  });
  for (const assignment of store.dispatchAssignments.values()) {
    if (
      assignment.bookingId === booking.id &&
      ['PROPOSED', 'APPROVED', 'ACCEPTED'].includes(assignment.status)
    ) {
      assignment.status = 'CANCELLED';
      await persistAssignment(assignment);
    }
  }
  await persistBooking(booking);
  return res.json({
    data: { bookingId: booking.id, referenceCode: booking.referenceCode || null, status: booking.status },
  });
});

/**
 * Ranked assignment aid (blueprint §5): eligible providers ranked by
 * skill, credentials, availability, route proximity, van parts and
 * service history, each with its reasons. READ-ONLY — the setter
 * still picks the provider and confirms through the normal approval
 * step. Nothing here dispatches, ever.
 */
router.get('/bookos/bookings/:id/assignment-suggestions', ...staffOnly, (req, res) => {
  const booking = store.bookings.get(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  const candidates = rankAssignmentCandidates(booking);
  return res.json({
    data: {
      bookingId: booking.id,
      referenceCode: booking.referenceCode || null,
      appliance: booking.appliance,
      area: booking.area || booking.city,
      priorityTier: priorityTierOf(booking),
      candidates,
      // D7 (2026-11-20): the same candidates ordered by straight-line
      // distance instead of score — a second lens for the setter, not
      // a second ranking of record. Candidates with no position
      // evidence sort last. Still advice only.
      candidatesByDistance: [...candidates].sort(byDistanceAsc),
      distanceNote: DISTANCE_NOTE,
      note: 'Suggestions only — a Service Setter still picks the provider and confirms the assignment. Nothing here dispatches on its own.',
    },
  });
});

/**
 * Dispatch map (2026-11-20, D7): today's board as positions. Jobs are
 * placed at their service-area center (jobs carry no coordinates —
 * the area is the honest placement, and the response says so); techs
 * are placed at their latest device-reported GPS when one exists,
 * else at the area of the job they are on, else listed as
 * unpositioned. Jobs whose area is unresolved are listed as
 * unpositioned rather than pinned anywhere invented. READ-ONLY —
 * nothing here assigns or dispatches.
 */
router.get('/bookos/dispatch-map', ...staffOnly, (req, res) => {
  const date = todayDateString();
  const areaFilter = String(req.query.area || '').trim();
  const windowFilter = String(req.query.window || '').trim();
  const todays = visibleBookings(req).filter(
    (booking) =>
      BOARD_STATUSES.includes(booking.status) &&
      effectiveAreaStatus(booking) !== 'OUT_OF_AREA' &&
      (booking.createdAt.slice(0, 10) === date || booking.appointment?.date === date) &&
      (!areaFilter || effectiveArea(booking) === areaFilter) &&
      (!windowFilter || booking.appointment?.window === windowFilter || (!booking.appointment && booking.preferredWindow === windowFilter)),
  );
  const jobs = [];
  const unpositionedJobs = [];
  for (const booking of todays) {
    const brief = {
      bookingId: booking.id,
      referenceCode: booking.referenceCode || null,
      status: booking.status,
      city: booking.city,
      area: effectiveArea(booking),
      areaStatus: effectiveAreaStatus(booking),
      appliance: booking.appliance,
      priorityTier: priorityTierOf(booking),
      customerName: booking.customer?.name || null,
      appointment: appointmentSummary(booking),
      providerId: booking.dispatch?.providerId || null,
    };
    const position = jobPosition(booking);
    if (position) jobs.push({ ...brief, position });
    else unpositionedJobs.push(brief);
  }
  const techs = (store.providers || [])
    .filter((provider) => provider.active)
    .map((provider) => ({
      providerId: provider.id,
      businessName: provider.businessName,
      system: provider.companyCrew ? 'COMPANY' : 'NETWORK',
      type: provider.type,
      position: providerPosition(provider.id),
    }));
  return res.json({
    data: {
      date,
      filters: { area: areaFilter || null, window: windowFilter || null },
      jobs,
      unpositionedJobs,
      techs,
      positionedTechs: techs.filter((t) => t.position).length,
      note:
        'Jobs are placed at their service-area center, not the customer\u2019s address \u2014 jobs carry no stored coordinates. Verified centers exist for the 12 core crew areas; jobs in the other published cities (auto-match widened 2026-11-20, A6) are listed below the map until a verified center is recorded for their city \u2014 never pinned at a guessed point. Tech pins show live GPS only when a device has reported a position; otherwise the area of the job the tech is on. Distances on this board are straight-line miles, not drive time.',
    },
  });
});

/**
 * Capacity view (blueprint §7): today's booking ceiling from the
 * office's planning inputs, with the day's appointed jobs counted
 * against it. A planning estimate — it never blocks a booking.
 */
router.get('/bookos/capacity', ...staffOnly, async (req, res) => {
  const parsed = z.object({ date: dateParam.optional() }).safeParse({ date: req.query.date });
  if (!parsed.success) {
    return res.status(400).json({ error: 'A valid date query (?date=YYYY-MM-DD) is required', details: parsed.error.flatten() });
  }
  const date = parsed.data.date || todayDateString();
  const settings = await loadDispatchSettings(req.companyId);
  const technicians = (store.providers || []).filter((provider) => provider.active).length;
  const bookedToday = visibleBookings(req).filter(
    (booking) =>
      booking.appointment?.status === 'SET' && booking.appointment.date === date && booking.status !== 'CANCELLED',
  ).length;
  const ceilingJobs = capacityCeiling({ technicians, settings });
  return res.json({
    data: {
      date,
      settings,
      technicians,
      ceilingJobs,
      bookedToday,
      remainingJobs: Math.max(0, ceilingJobs - bookedToday),
      label:
        'Planning estimate — technicians × working hours × 60 × (1 − buffer) ÷ minutes per job incl. travel (Operations Blueprint §7). It informs the office; it never blocks a booking.',
    },
  });
});

const capacitySettingsSchema = z.object({
  bufferPercent: z.number().int().min(0).max(90),
  minutesPerJob: z.number().int().min(30).max(480),
  workingHoursPerDay: z.number().min(1).max(16),
});

/** The office tunes its own capacity planning inputs. */
router.put('/bookos/capacity-settings', ...staffOnly, async (req, res) => {
  const parsed = capacitySettingsSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid capacity settings', details: parsed.error.flatten() });
  }
  const settings = await saveDispatchSettings(req.companyId, parsed.data, req.user.email);
  // New planning inputs re-size every public window picker at once.
  clearAvailabilityCache();
  return res.json({ data: { settings } });
});

export default router;
