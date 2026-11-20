import { Router } from 'express';
import { z } from 'zod';
import { appendEvent, createId, store } from '../data/store.js';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { STAFF_ROLES } from '../config/security.js';
import { persistBookingMessage, persistThreadRead } from '../db/bookingMessagesRepo.js';

/**
 * Message the office (2026-11-20, recommendations B2) — the
 * per-booking human thread. The customer writes from /app on their
 * own booking; staff answer from the Chats console (and, when the
 * Wave 1 D1 setter composer lands, from Book OS / CRM against these
 * SAME rows — this router is the shared thread store, deliberately
 * surface-agnostic: one thread per booking, two sides).
 *
 * Access mirrors the booking read rule (2026-11-16): staff roles see
 * their company's threads; a customer sees only a booking that
 * belongs to them (the bookingBelongsToUser test every surface
 * agrees on). senderKind is derived from the caller's roles —
 * a client can never post as the other side.
 *
 * Platform events carry the fact of a message only (side + booking
 * reference), never the message text — the reviews-event discipline.
 */
const router = Router();

const staffOnly = [authenticate, requireCompany, requireRole(...STAFF_ROLES)];
const signedIn = [authenticate, requireCompany];

const digits10 = (value) => String(value || '').replace(/\D/g, '').slice(-10);

/** The booking ownership linkage every surface agrees on. */
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

function isStaff(user) {
  return (user.roles || []).some((role) => STAFF_ROLES.includes(role));
}

function loadThreadBooking(req, res) {
  const booking = store.bookings.get(req.params.bookingId);
  if (!booking || booking.companyId !== req.companyId) {
    res.status(404).json({ error: 'Booking not found' });
    return null;
  }
  if (!isStaff(req.user) && !bookingBelongsToUser(booking, req.user)) {
    res.status(404).json({ error: 'Booking not found' });
    return null;
  }
  return booking;
}

function threadMessages(bookingId) {
  return store.bookingMessages
    .filter((m) => m.bookingId === bookingId)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

function serializeMessage(m) {
  return {
    id: m.id,
    senderKind: m.senderKind,
    senderName: m.senderName || null,
    body: m.body,
    readAt: m.readAt || null,
    createdAt: m.createdAt,
  };
}

function senderDisplayName(req, booking, kind) {
  if (kind === 'STAFF') {
    const record = store.users.get(req.user.id) || {};
    const name = [record.firstName, record.lastName].filter(Boolean).join(' ').trim();
    return name || 'Top Speed office';
  }
  return booking.customer?.name || 'Customer';
}

/* ------------------------- thread read ------------------------- */

router.get('/bookings/:bookingId/messages', ...signedIn, (req, res) => {
  const booking = loadThreadBooking(req, res);
  if (!booking) return;
  const mine = isStaff(req.user) ? 'STAFF' : 'CUSTOMER';
  const messages = threadMessages(booking.id);
  const unreadForMe = messages.filter((m) => m.senderKind !== mine && !m.readAt).length;
  return res.json({
    data: {
      bookingId: booking.id,
      referenceCode: booking.referenceCode || null,
      messages: messages.map(serializeMessage),
      unreadForMe,
    },
  });
});

/* ------------------------- thread write ------------------------ */

const postSchema = z.object({
  body: z.string().trim().min(1).max(2000),
});

router.post('/bookings/:bookingId/messages', ...signedIn, async (req, res) => {
  const booking = loadThreadBooking(req, res);
  if (!booking) return;
  const parsed = postSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid message', details: parsed.error.flatten() });
  }
  const kind = isStaff(req.user) ? 'STAFF' : 'CUSTOMER';
  const message = {
    id: createId(),
    companyId: booking.companyId,
    bookingId: booking.id,
    senderKind: kind,
    senderUserId: req.user.id,
    senderName: senderDisplayName(req, booking, kind),
    body: parsed.data.body,
    readAt: null,
    createdAt: new Date().toISOString(),
  };
  store.bookingMessages.push(message);
  await persistBookingMessage(message);
  await appendEvent('BOOKING_MESSAGE_POSTED', {
    source: 'office-thread',
    actor: kind === 'STAFF' ? 'staff' : 'customer',
    entityType: 'BOOKING',
    entityId: booking.id,
    referenceCode: booking.referenceCode || null,
    details: { senderKind: kind },
  });
  return res.status(201).json({ data: serializeMessage(message) });
});

/* --------------------------- read mark -------------------------- */

router.post('/bookings/:bookingId/messages/read', ...signedIn, async (req, res) => {
  const booking = loadThreadBooking(req, res);
  if (!booking) return;
  const mine = isStaff(req.user) ? 'STAFF' : 'CUSTOMER';
  const now = new Date().toISOString();
  let marked = 0;
  for (const m of store.bookingMessages) {
    if (m.bookingId === booking.id && m.senderKind !== mine && !m.readAt) {
      m.readAt = now;
      marked += 1;
    }
  }
  if (marked) await persistThreadRead(booking.id, mine, now);
  return res.json({ data: { marked } });
});

/* ---------------------- staff thread inbox ---------------------- */

/**
 * Every thread in the company, newest activity first — the Chats
 * console's Office messages panel. Previews are staff-side only
 * (this whole lane is staff-gated); customers never see another
 * booking's thread anywhere.
 */
router.get('/office-messages/threads', ...staffOnly, (req, res) => {
  const byBooking = new Map();
  for (const m of store.bookingMessages) {
    if (m.companyId !== req.companyId) continue;
    const entry = byBooking.get(m.bookingId) || { messages: [], unreadForStaff: 0 };
    entry.messages.push(m);
    if (m.senderKind === 'CUSTOMER' && !m.readAt) entry.unreadForStaff += 1;
    byBooking.set(m.bookingId, entry);
  }
  const threads = [];
  for (const [bookingId, entry] of byBooking) {
    const booking = store.bookings.get(bookingId);
    if (!booking) continue;
    const sorted = entry.messages.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const last = sorted[sorted.length - 1];
    threads.push({
      bookingId,
      referenceCode: booking.referenceCode || null,
      appliance: booking.appliance || null,
      issue: booking.issue || null,
      status: booking.status || null,
      customerName: booking.customer?.name || null,
      messageCount: sorted.length,
      unreadForStaff: entry.unreadForStaff,
      lastMessage: last
        ? { senderKind: last.senderKind, preview: last.body.slice(0, 140), createdAt: last.createdAt }
        : null,
      lastActivityAt: last ? last.createdAt : null,
    });
  }
  threads.sort((a, b) => String(b.lastActivityAt || '').localeCompare(String(a.lastActivityAt || '')));
  const unreadTotal = threads.reduce((sum, t) => sum + t.unreadForStaff, 0);
  return res.json({ data: { threads, unreadTotal } });
});

export default router;
