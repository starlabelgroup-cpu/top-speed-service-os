import { Router } from 'express';
import { z } from 'zod';
import { ROLES, STAFF_ROLES } from '../config/security.js';
import { store } from '../data/store.js';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { openThreadFor, sendStaffMessage, serializeBookingOnlyThread, serializeThread } from '../services/messageThreads.js';

/**
 * Setter–customer messaging API (2026-11-20, Wave 1 setter comms D1)
 * — the backend of the two-way composer inside the Book OS job
 * pop-up and the CRM customer 360.
 *
 *   GET  /messages/thread?bookingId=… | ?customerId=…
 *        The conversation for one booking or customer (null thread
 *        when nobody has messaged yet), with the booking's comms
 *        flags (customer confirmed / reschedule requested / no-show).
 *   POST /messages/send { bookingId | customerId, channel, body,
 *        subject? }
 *        One staff message, sent through the notification outbox
 *        (SMS via the 844, email via Resend) with one awaited drain
 *        attempt — the response carries the TRUE delivery state:
 *        SENT only on provider acceptance, FAILED/GATED with the
 *        provider's reason otherwise. Nothing pretends to send.
 *
 * Staff-gated per route (STAFF_ROLES), like every working console —
 * customers get a 403, anonymous callers a 401.
 */
const router = Router();

const staffOnly = [authenticate, requireCompany, requireRole(...STAFF_ROLES)];

function visibleBooking(req, bookingId) {
  const booking = store.bookings.get(bookingId);
  if (!booking) return null;
  if (req.user.roles.includes(ROLES.PLATFORM_ADMIN) || booking.companyId === req.companyId) return booking;
  return null;
}

function visibleCustomer(req, customerId) {
  const customer = store.customers.get(customerId);
  if (!customer) return null;
  if (req.user.roles.includes(ROLES.PLATFORM_ADMIN) || customer.companyId === req.companyId) return customer;
  return null;
}

router.get('/messages/thread', ...staffOnly, (req, res) => {
  const bookingId = String(req.query.bookingId || '').trim() || null;
  const customerId = String(req.query.customerId || '').trim() || null;
  if (!bookingId && !customerId) {
    return res.status(400).json({ error: 'bookingId or customerId is required' });
  }
  let booking = null;
  let customer = null;
  if (bookingId) {
    booking = visibleBooking(req, bookingId);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    customer = booking.customerId ? store.customers.get(booking.customerId) || null : null;
  } else {
    customer = visibleCustomer(req, customerId);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
  }
  const thread = openThreadFor({
    companyId: req.companyId,
    bookingId: booking?.id || null,
    customerId: customer?.id || null,
  });
  // Convergence with B2 message-the-office: when the booking's
  // conversation lives only in the shared BookingMessage store so
  // far (customer wrote from /app, staff from Chats), the composer
  // still shows that one conversation, not an empty thread.
  const serialized = serializeThread(thread)
    || (booking ? serializeBookingOnlyThread(booking) : null);
  return res.json({
    data: {
      thread: serialized,
      target: {
        bookingId: booking?.id || null,
        referenceCode: booking?.referenceCode || null,
        customerId: customer?.id || booking?.customerId || null,
        customerName: booking?.customer?.name || customer?.name || null,
        phone: booking?.customer?.phone || customer?.phone || null,
        email: booking?.customer?.email || customer?.email || null,
      },
    },
  });
});

const sendSchema = z.object({
  bookingId: z.string().uuid().optional().nullable(),
  customerId: z.string().uuid().optional().nullable(),
  channel: z.enum(['SMS', 'EMAIL']),
  body: z.string().trim().min(1).max(2000),
  subject: z.string().trim().min(1).max(200).optional().nullable(),
});

router.post('/messages/send', ...staffOnly, async (req, res) => {
  const parsed = sendSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid message', details: parsed.error.flatten() });
  }
  const { bookingId, customerId, channel, body, subject } = parsed.data;
  if (!bookingId && !customerId) {
    return res.status(400).json({ error: 'bookingId or customerId is required' });
  }
  if (bookingId && !visibleBooking(req, bookingId)) {
    return res.status(404).json({ error: 'Booking not found' });
  }
  if (!bookingId && customerId && !visibleCustomer(req, customerId)) {
    return res.status(404).json({ error: 'Customer not found' });
  }
  try {
    const actorRecord = store.users.get(req.user.id) || {};
    const actorName = [actorRecord.firstName, actorRecord.lastName].filter(Boolean).join(' ').trim() || null;
    const result = await sendStaffMessage({
      companyId: req.companyId,
      actorEmail: req.user.email,
      actorId: req.user.id,
      actorName,
      bookingId: bookingId || null,
      customerId: customerId || null,
      channel,
      body,
      subject: subject || null,
    });
    return res.status(201).json({
      data: {
        thread: serializeThread(result.thread),
        message: {
          id: result.message.id,
          direction: result.message.direction,
          channel: result.message.channel,
          kind: result.message.kind,
          body: result.message.body,
          deliveryStatus: result.message.deliveryStatus,
          deliveryError: result.message.deliveryError || null,
          createdAt: result.message.createdAt,
        },
        delivery: result.delivery,
      },
    });
  } catch (error) {
    if (error?.status) return res.status(error.status).json({ error: error.message, code: error.code || null });
    throw error;
  }
});

export default router;
