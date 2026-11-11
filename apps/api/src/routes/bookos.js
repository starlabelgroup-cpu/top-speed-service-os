import { Router } from 'express';
import { paymentSummary } from '../db/paymentsRepo.js';
import { z } from 'zod';
import { ROLES, STAFF_ROLES } from '../config/security.js';
import { SERVICE_CITIES } from '../config/serviceAreas.js';
import { addBookingEvent, appendEvent, store } from '../data/store.js';
import { persistBooking } from '../db/bookingsRepo.js';
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

function visibleBookings(req) {
  return [...store.bookings.values()].filter(
    (booking) => req.user.roles.includes(ROLES.PLATFORM_ADMIN) || booking.companyId === req.companyId,
  );
}

function appointmentSummary(booking) {
  if (!booking.appointment) return null;
  const { date, window, status, setAt, setBy } = booking.appointment;
  return { date, window, windowLabel: windowById(window)?.label || window, status, setAt, setBy };
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
 * has not confirmed with the customer yet — oldest first.
 */
router.get('/bookos/setter-queue', ...staffOnly, (req, res) => {
  const now = Date.now();
  const queue = visibleBookings(req)
    .filter((booking) => booking.status === 'PENDING_DISPATCH')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((booking) => ({
      bookingId: booking.id,
      referenceCode: booking.referenceCode || null,
      source: booking.source || null,
      ageMinutes: Math.max(0, Math.floor((now - new Date(booking.createdAt).getTime()) / 60000)),
      createdAt: booking.createdAt,
      customerName: booking.customer?.name || null,
      customerPhone: booking.customer?.phone || null,
      city: booking.city,
      zip: booking.zip,
      appliance: booking.appliance,
      payment: paymentSummary(booking.id),
      issue: booking.issue,
      priority: booking.priority || false,
      preferredWindow: booking.preferredWindow || null,
      appointment: appointmentSummary(booking),
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
  if (booking.status === 'COMPLETED') {
    return res.status(409).json({ error: 'Booking is already completed' });
  }
  if (booking.appointment?.status === 'SET') {
    return res.status(409).json({ error: 'Appointment already set; use the reschedule endpoint to move it' });
  }
  const slot = slotForArea({ date, windowId: window, city: booking.city });
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
  appendEvent('APPOINTMENT_SET', {
    source: booking.source || null,
    actor: ROLES.DISPATCHER,
    entityType: 'BOOKING',
    entityId: booking.id,
    referenceCode: booking.referenceCode || null,
    details: { team: 'Service Setters', setBy, date, window, city: booking.city, status: booking.status },
  });
  const confirmations = notifyBookingConfirmation(booking, booking.source || null);
  await persistBooking(booking);

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
  if (booking.status === 'COMPLETED') {
    return res.status(409).json({ error: 'Booking is already completed' });
  }
  if (booking.appointment?.status !== 'SET') {
    return res.status(409).json({ error: 'No appointment is set yet; use POST /bookos/appointments to set one' });
  }
  const slot = slotForArea({ date, windowId: window, city: booking.city, excludeBookingId: booking.id });
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
  appendEvent('APPOINTMENT_RESCHEDULED', {
    source: booking.source || null,
    actor: ROLES.DISPATCHER,
    entityType: 'BOOKING',
    entityId: booking.id,
    referenceCode: booking.referenceCode || null,
    details: { team: 'Service Setters', rescheduledBy, from: previous, to: { date, window }, city: booking.city },
  });
  const confirmations = notifyBookingConfirmation(booking, booking.source || null);
  await persistBooking(booking);

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
router.post('/bookos/reminders/run', ...staffOnly, (req, res) => {
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
  appendEvent('APPOINTMENT_REMINDERS_RUN', {
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

const BOARD_STATUSES = ['PENDING_DISPATCH', 'MATCH_PENDING_APPROVAL', 'CONFIRMED', 'COMPLETED'];

/**
 * Dispatch board: today's pipeline grouped by status. Starter rule:
 * a booking is on today's board if it was created today or its
 * appointment is today (Phase 1 in-memory demo — every live record is
 * recent). Dispatch itself still runs through /dispatch/match + approve.
 */
router.get('/bookos/dispatch-board', ...staffOnly, (req, res) => {
  const date = todayDateString();
  const todays = visibleBookings(req).filter(
    (booking) =>
      BOARD_STATUSES.includes(booking.status) &&
      (booking.createdAt.slice(0, 10) === date || booking.appointment?.date === date),
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
        city: booking.city,
        appliance: booking.appliance,
        customerName: booking.customer?.name || null,
        payment: paymentSummary(booking.id),
        appointment: appointmentSummary(booking),
        providerId: booking.dispatch?.providerId || null,
        createdAt: booking.createdAt,
      }));
    groups[status] = items;
    counts[status] = items.length;
  }
  return res.json({ data: { date, counts, groups } });
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

export default router;
