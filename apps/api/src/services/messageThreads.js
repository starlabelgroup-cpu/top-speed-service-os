import { addBookingEvent, appendEvent, createId, store } from '../data/store.js';
import { persistBooking } from '../db/bookingsRepo.js';
import { persistBookingMessage } from '../db/bookingMessagesRepo.js';
import { persistMessageThread, persistThreadMessage } from '../db/messageThreadsRepo.js';
import { NOTIFICATION_TEMPLATES, queueNotification } from './notifications.js';
import { drainEntries } from './senders.js';

/**
 * Setter–customer message threads (2026-11-20, Wave 1 setter comms
 * D1/D2) — the two-way conversation record behind the Book OS + CRM
 * composer.
 *
 * One OPEN thread per booking (or per customer when no booking is in
 * play). Every message on it is a ThreadMessage:
 *  - OUTBOUND staff messages, composed in Book OS / CRM and sent
 *    through the notification outbox (SMS via the 844 Twilio path,
 *    email via Resend). The row records the outbox entry's TRUE
 *    delivery state after one awaited drain attempt — SENT only when
 *    the provider accepted, FAILED/GATED with the reason otherwise.
 *    Nothing here ever dresses a queued or failed send up as sent.
 *  - OUTBOUND automated appointment reminders (services/reminders.js
 *    appends them through appendOutboundToThread).
 *  - INBOUND customer replies: SMS replies arrive from the Twilio
 *    webhook (routes/twilioSms.js calls recordInboundSms — additively;
 *    the owner's forward + the TwiML thank-you are untouched), email
 *    replies from the Resend inbox ingest when the customer already
 *    has an open thread (the Book OS Inbox stays the system of record
 *    for cold email).
 *
 * Reminder replies: a bare "C" / "CONFIRM" text confirms the
 * customer's upcoming appointment on the booking record; a bare "R" /
 * "RESCHEDULE" flags the booking for a setter to call — it derives
 * into the Book OS exception queue as a task and NEVER moves the
 * appointment on its own.
 *
 * CONVERGENCE with B2 message-the-office (landed 2026-11-20,
 * routes/bookingMessages.js): BookingMessage is THE per-booking
 * human thread store — /app, the Chats console, Book OS and CRM all
 * read the same conversation. This service owns the EXTERNAL
 * channels (SMS/email outbox, reminders, inbound SMS replies), and
 * the two stores are joined, not duplicated:
 *  - a staff composer message for a booking that the provider
 *    actually ACCEPTED (delivery state SENT) is also written as a
 *    BookingMessage (senderKind STAFF), so the customer sees the
 *    office's message in /app and staff see it in Chats. The mirror
 *    carries the SAME id as its ThreadMessage row, so the merged
 *    read below dedupes exactly. A FAILED/GATED send is NOT
 *    mirrored: it never reached the customer, so it stays
 *    staff-side with its true delivery state. An inbound SMS reply
 *    is mirrored the same way (senderKind CUSTOMER) when the
 *    customer record links a user account — BookingMessage's
 *    senderUserId must be a real account; unlinked texters' replies
 *    stay on this external thread, visible in the merged staff view.
 *  - serializeThread MERGES the booking's BookingMessage rows into
 *    the composer's thread view (channel APP), so a customer who
 *    writes from /app appears in the Book OS / CRM conversation and
 *    vice versa — one thread per booking on every surface.
 *  - automated reminders are NOT mirrored into BookingMessage: they
 *    are system notifications, not office conversation; they remain
 *    on this external-channel thread (and on the merged staff view).
 *  - composer sends with no booking (CRM customer-level) have no
 *    BookingMessage home — BookingMessage is per-booking by design —
 *    and live on this thread store only.
 */

export function digits10(value) {
  return String(value || '').replace(/\D/g, '').slice(-10);
}

function samePhone(a, b) {
  const da = digits10(a);
  return da.length >= 10 && da === digits10(b);
}

/** Today in the business timezone (America/New_York) as YYYY-MM-DD. */
export function todayInNewYork(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/* ------------------------------------------------------------------ */
/* Thread lookup / creation                                            */
/* ------------------------------------------------------------------ */

function openThreads() {
  return (store.messageThreads || []).filter((thread) => thread.status === 'OPEN');
}

export function openThreadFor({ companyId, bookingId = null, customerId = null }) {
  const threads = openThreads().filter((thread) => thread.companyId === companyId);
  if (bookingId) {
    const byBooking = threads
      .filter((thread) => thread.bookingId === bookingId)
      .sort((a, b) => String(b.lastMessageAt || b.createdAt).localeCompare(String(a.lastMessageAt || a.createdAt)));
    if (byBooking.length) return byBooking[0];
  }
  if (customerId) {
    const byCustomer = threads
      .filter((thread) => thread.customerId === customerId)
      .sort((a, b) => String(b.lastMessageAt || b.createdAt).localeCompare(String(a.lastMessageAt || a.createdAt)));
    if (byCustomer.length) return byCustomer[0];
  }
  return null;
}

export async function getOrCreateThread({ companyId, customerId = null, bookingId = null }) {
  const existing = openThreadFor({ companyId, bookingId, customerId });
  if (existing) {
    // A booking-scoped conversation found through the customer joins
    // the booking the composer is looking at.
    if (bookingId && !existing.bookingId) {
      existing.bookingId = bookingId;
      existing.updatedAt = new Date().toISOString();
      await persistMessageThread(existing).catch(() => {});
    }
    return existing;
  }
  const now = new Date().toISOString();
  const thread = {
    id: createId(),
    companyId,
    customerId: customerId || null,
    bookingId: bookingId || null,
    status: 'OPEN',
    createdAt: now,
    updatedAt: now,
    lastMessageAt: null,
  };
  store.messageThreads.push(thread);
  await persistMessageThread(thread).catch((error) => {
    console.error(JSON.stringify({ level: 'error', message: 'message thread persist failed', error: String(error?.message || error) }));
  });
  return thread;
}

export async function appendThreadMessage(thread, fields) {
  const now = new Date().toISOString();
  const message = {
    id: createId(),
    threadId: thread.id,
    companyId: thread.companyId,
    kind: 'MESSAGE',
    subject: null,
    author: null,
    outboxEntryId: null,
    deliveryError: null,
    externalId: null,
    ...fields,
    createdAt: now,
  };
  store.threadMessages.push(message);
  thread.lastMessageAt = now;
  thread.updatedAt = now;
  await persistThreadMessage(message).catch((error) => {
    console.error(JSON.stringify({ level: 'error', message: 'thread message persist failed', error: String(error?.message || error) }));
  });
  await persistMessageThread(thread).catch(() => {});
  return message;
}

export function threadMessages(threadId) {
  return (store.threadMessages || [])
    .filter((message) => message.threadId === threadId)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

/**
 * Booking flags the consoles render beside the thread: whether the
 * customer confirmed the current appointment by reply, whether a
 * reschedule request is still open (asked, not yet acted on), and
 * whether a no-show was marked and not since rebooked. All derived
 * from the booking's own record — no parallel state.
 */
export function bookingCommsFlags(booking) {
  if (!booking) return { customerConfirmedAt: null, rescheduleRequestedAt: null, noShowAt: null };
  let rescheduleRequestedAt = null;
  let noShowAt = null;
  for (const event of booking.history || []) {
    if (event.type === 'RESCHEDULE_REQUESTED_BY_CUSTOMER') rescheduleRequestedAt = event.at || null;
    if (event.type === 'APPOINTMENT_SET' || event.type === 'APPOINTMENT_RESCHEDULED') {
      rescheduleRequestedAt = null;
      noShowAt = null;
    }
    if (event.type === 'CUSTOMER_NO_SHOW') noShowAt = event.at || null;
  }
  return {
    customerConfirmedAt: booking.appointment?.customerConfirmedAt || null,
    rescheduleRequestedAt,
    noShowAt,
  };
}

/**
 * The booking's BookingMessage rows (B2 message-the-office) in this
 * thread's message shape, minus the ones this service mirrored there
 * itself (their ThreadMessage rows carry externalId `bm:<id>` and
 * already render from the external-channel record, delivery state
 * included). Customer rows arrive as INBOUND / APP; staff rows
 * written from /app or Chats arrive as OUTBOUND / APP with delivery
 * state SENT — they were posted straight into the customer's thread.
 */
export function bookingMessageRows(bookingId, mirroredIds = new Set()) {
  if (!bookingId) return [];
  return (store.bookingMessages || [])
    .filter((row) => row.bookingId === bookingId && !mirroredIds.has(row.id))
    .map((row) => ({
      id: row.id,
      direction: row.senderKind === 'CUSTOMER' ? 'INBOUND' : 'OUTBOUND',
      channel: 'APP',
      kind: 'MESSAGE',
      body: row.body,
      subject: null,
      author: row.senderName || (row.senderKind === 'CUSTOMER' ? 'customer' : null),
      deliveryStatus: row.senderKind === 'CUSTOMER' ? 'RECEIVED' : 'SENT',
      deliveryError: null,
      outboxEntryId: null,
      createdAt: row.createdAt,
    }));
}

function mergedMessages(thread) {
  const own = threadMessages(thread.id);
  // Mirrored rows share their ThreadMessage id (see the convergence
  // note above) — dedupe is exact, by id.
  const mirroredIds = new Set(own.map((message) => message.id));
  return [...own.map((message) => ({
    id: message.id,
    direction: message.direction,
    channel: message.channel,
    kind: message.kind,
    body: message.body,
    subject: message.subject || null,
    author: message.author || null,
    deliveryStatus: message.deliveryStatus,
    deliveryError: message.deliveryError || null,
    outboxEntryId: message.outboxEntryId || null,
    createdAt: message.createdAt,
  })), ...bookingMessageRows(thread.bookingId, mirroredIds)]
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

export function serializeThread(thread) {
  if (!thread) return null;
  const booking = thread.bookingId ? store.bookings.get(thread.bookingId) : null;
  return {
    id: thread.id,
    companyId: thread.companyId,
    customerId: thread.customerId,
    bookingId: thread.bookingId,
    status: thread.status,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    lastMessageAt: thread.lastMessageAt,
    flags: bookingCommsFlags(booking),
    messages: mergedMessages(thread),
  };
}

/**
 * The merged conversation for a booking that has BookingMessage rows
 * (the customer wrote from /app, or staff from Chats) but no
 * external-channel thread yet — the composer still shows the one
 * conversation instead of "no messages yet".
 */
export function serializeBookingOnlyThread(booking) {
  if (!booking) return null;
  const messages = bookingMessageRows(booking.id)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  if (!messages.length) return null;
  return {
    id: null,
    companyId: booking.companyId,
    customerId: booking.customerId || null,
    bookingId: booking.id,
    status: 'OPEN',
    createdAt: messages[0].createdAt,
    updatedAt: messages[messages.length - 1].createdAt,
    lastMessageAt: messages[messages.length - 1].createdAt,
    flags: bookingCommsFlags(booking),
    messages,
  };
}

/* ------------------------------------------------------------------ */
/* Customer / booking resolution                                       */
/* ------------------------------------------------------------------ */

export function customerForBooking(booking) {
  if (!booking) return null;
  if (booking.customerId && store.customers.has(booking.customerId)) {
    return store.customers.get(booking.customerId);
  }
  return null;
}

export function findCustomerByPhone(phone) {
  if (digits10(phone).length < 10) return null;
  for (const customer of store.customers.values()) {
    if (customer.phone && samePhone(customer.phone, phone)) return customer;
  }
  return null;
}

/** The booking an inbound message most likely belongs to. */
export function mostRelevantBooking(customer) {
  if (!customer) return null;
  const mine = [...store.bookings.values()]
    .filter((booking) => booking.customerId === customer.id && !['COMPLETED', 'CANCELLED'].includes(booking.status));
  if (!mine.length) return null;
  const today = todayInNewYork();
  const upcoming = mine
    .filter((booking) => booking.appointment?.status === 'SET' && booking.appointment.date >= today)
    .sort((a, b) => String(a.appointment.date).localeCompare(String(b.appointment.date)));
  if (upcoming.length) return upcoming[0];
  return mine.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
}

/* ------------------------------------------------------------------ */
/* Outbound (staff composer + reminders)                               */
/* ------------------------------------------------------------------ */

function deliveryErrorOf(entry) {
  if (!entry) return null;
  if (entry.error) return String(entry.error);
  if (entry.reason) return String(entry.reason);
  return null;
}

/**
 * Send one staff-composed message through the outbox and record it on
 * the thread with its true delivery state. Throws an Error carrying
 * { status, code } for caller-fixable problems (unknown record, no
 * recipient on the chosen channel).
 */
export async function sendStaffMessage({ companyId, actorEmail, actorId = null, actorName = null, bookingId = null, customerId = null, channel, body, subject = null }) {
  let booking = null;
  let customer = null;
  if (bookingId) {
    booking = store.bookings.get(bookingId) || null;
    if (!booking || booking.companyId !== companyId) {
      const error = new Error('Booking not found');
      error.status = 404; error.code = 'booking_not_found';
      throw error;
    }
    customer = customerForBooking(booking);
    customerId = customer?.id || booking.customerId || null;
  } else if (customerId) {
    customer = store.customers.get(customerId) || null;
    if (!customer || customer.companyId !== companyId) {
      const error = new Error('Customer not found');
      error.status = 404; error.code = 'customer_not_found';
      throw error;
    }
  }
  const to = channel === 'SMS'
    ? booking?.customer?.phone || customer?.phone || null
    : booking?.customer?.email || customer?.email || null;
  if (!to) {
    const error = new Error(channel === 'SMS'
      ? 'No phone number on this record — email the message instead, or add a phone first.'
      : 'No email address on this record — text the message instead, or add an email first.');
    error.status = 422; error.code = 'no_recipient';
    throw error;
  }

  const thread = await getOrCreateThread({ companyId, customerId, bookingId: booking?.id || null });
  const entry = queueNotification({
    channel: channel === 'SMS' ? 'sms' : 'email',
    template: NOTIFICATION_TEMPLATES.STAFF_MESSAGE,
    to,
    source: 'setter-composer',
    eventType: 'MESSAGE_THREAD',
    payload: {
      bookingId: booking?.id || null,
      customerId: customerId || null,
      threadId: thread.id,
      customerName: booking?.customer?.name || customer?.name || null,
      sentBy: actorEmail || null,
      ...(channel === 'EMAIL' ? { subject: subject || 'A message from Top Speed Appliance' } : {}),
      message: body,
    },
  });
  // One immediate delivery attempt (the Link Center idiom), so the
  // thread records THIS send's true outcome. The opportunistic
  // background drain skips non-QUEUED entries, so no double-send.
  await drainEntries([entry]).catch(() => {});

  // Convergence with B2 message-the-office: a booking message the
  // provider ACCEPTED joins the shared BookingMessage thread under
  // the SAME id as its ThreadMessage row, so the customer reads it
  // in /app and staff read it in Chats — one conversation per
  // booking, deduped exactly on the merged read. A failed/gated
  // send is not mirrored (it never reached the customer).
  const sharedId = createId();
  if (booking && entry.status === 'SENT' && actorId) {
    const mirror = {
      id: sharedId,
      companyId,
      bookingId: booking.id,
      senderKind: 'STAFF',
      senderUserId: actorId,
      senderName: actorName || actorEmail || 'Top Speed office',
      body,
      readAt: null,
      createdAt: new Date().toISOString(),
    };
    (store.bookingMessages ||= []).push(mirror);
    await persistBookingMessage(mirror);
  }

  const message = await appendThreadMessage(thread, {
    id: sharedId,
    direction: 'OUTBOUND',
    channel,
    kind: 'MESSAGE',
    body,
    subject: channel === 'EMAIL' ? (subject || 'A message from Top Speed Appliance') : null,
    author: actorEmail || null,
    outboxEntryId: entry.id,
    deliveryStatus: entry.status,
    deliveryError: deliveryErrorOf(entry),
  });
  await appendEvent('STAFF_MESSAGE_SENT', {
    source: 'setter-composer',
    actor: actorEmail || null,
    entityType: 'BOOKING',
    entityId: booking?.id || null,
    referenceCode: booking?.referenceCode || null,
    details: { threadId: thread.id, channel, status: entry.status },
  });
  return {
    thread,
    message,
    delivery: {
      outboxEntryId: entry.id,
      status: entry.status,
      reason: entry.reason || null,
      error: entry.error || null,
      provider: entry.provider || null,
      providerId: entry.providerId || null,
      sentAt: entry.sentAt || null,
      to,
    },
  };
}

/**
 * Append an already-queued outbound entry (an automated reminder)
 * to the booking's thread with the entry's true delivery state.
 * Called by services/reminders.js only when the entry was newly
 * created, so a re-run sweep never duplicates the thread record.
 */
export async function appendOutboundToThread({ booking, channel, kind, body, entry, author }) {
  const customer = customerForBooking(booking);
  const thread = await getOrCreateThread({
    companyId: booking.companyId,
    customerId: customer?.id || booking.customerId || null,
    bookingId: booking.id,
  });
  return appendThreadMessage(thread, {
    direction: 'OUTBOUND',
    channel,
    kind,
    body,
    author: author || null,
    outboxEntryId: entry?.id || null,
    deliveryStatus: entry?.status || 'QUEUED',
    deliveryError: deliveryErrorOf(entry),
  });
}

/* ------------------------------------------------------------------ */
/* Inbound replies                                                     */
/* ------------------------------------------------------------------ */

/** Bare reminder replies: "C" / "CONFIRM" and "R" / "RESCHEDULE". */
export function parseReminderReply(text) {
  const word = String(text || '').trim().toUpperCase().replace(/[.!]+$/, '');
  if (word === 'C' || word === 'CONFIRM' || word === 'CONFIRMED') return 'CONFIRM';
  if (word === 'R' || word === 'RESCHEDULE') return 'RESCHEDULE';
  return null;
}

async function applyReminderReply(booking, replyKind, via) {
  const now = new Date().toISOString();
  if (replyKind === 'CONFIRM') {
    const appointment = booking.appointment;
    if (appointment?.customerConfirmedForSetAt && appointment.customerConfirmedForSetAt === appointment.setAt) {
      return false; // already confirmed for this exact appointment
    }
    booking.appointment = {
      ...appointment,
      customerConfirmedAt: now,
      customerConfirmedForSetAt: appointment.setAt || null,
    };
    booking.updatedAt = now;
    addBookingEvent(booking, 'APPOINTMENT_CONFIRMED_BY_CUSTOMER', 'customer', {
      via, date: appointment.date, window: appointment.window,
    });
    await appendEvent('APPOINTMENT_CONFIRMED_BY_CUSTOMER', {
      source: booking.source || null,
      actor: 'customer',
      entityType: 'BOOKING',
      entityId: booking.id,
      referenceCode: booking.referenceCode || null,
      details: { via, date: appointment.date, window: appointment.window },
    });
    await persistBooking(booking);
    return true;
  }
  // RESCHEDULE: flag it for a setter — the appointment itself is
  // never moved by a text. A second R while one is open adds nothing.
  if (bookingCommsFlags(booking).rescheduleRequestedAt) return false;
  booking.updatedAt = now;
  addBookingEvent(booking, 'RESCHEDULE_REQUESTED_BY_CUSTOMER', 'customer', {
    via, date: booking.appointment?.date || null, window: booking.appointment?.window || null,
  });
  await appendEvent('RESCHEDULE_REQUESTED_BY_CUSTOMER', {
    source: booking.source || null,
    actor: 'customer',
    entityType: 'BOOKING',
    entityId: booking.id,
    referenceCode: booking.referenceCode || null,
    details: { via, date: booking.appointment?.date || null, window: booking.appointment?.window || null },
  });
  await persistBooking(booking);
  return true;
}

/**
 * File one inbound customer SMS on its thread. Additive beside the
 * Twilio forwarder: the caller (routes/twilioSms.js) wraps this in
 * try/catch, and the forward + TwiML reply proceed exactly as before
 * whatever happens here. Returns what was done for tests/logging.
 */
export async function recordInboundSms({ from, text, externalId = null }) {
  if (externalId && (store.threadMessages || []).some((message) => message.externalId === externalId)) {
    return { matched: true, duplicate: true };
  }
  const customer = findCustomerByPhone(from);
  if (!customer) return { matched: false };
  const booking = mostRelevantBooking(customer);
  const thread = await getOrCreateThread({
    companyId: customer.companyId,
    customerId: customer.id,
    bookingId: booking?.id || null,
  });

  let kind = 'MESSAGE';
  let replyKind = parseReminderReply(text);
  if (replyKind && booking?.appointment?.status === 'SET'
    && booking.appointment.date >= todayInNewYork()
    && !['COMPLETED', 'CANCELLED'].includes(booking.status)) {
    const acted = await applyReminderReply(booking, replyKind, 'SMS');
    kind = replyKind === 'CONFIRM' ? 'CONFIRM' : 'RESCHEDULE_REQUEST';
    if (!acted) replyKind = null;
  } else {
    replyKind = null;
  }

  const message = await appendThreadMessage(thread, {
    direction: 'INBOUND',
    channel: 'SMS',
    kind,
    body: String(text || ''),
    author: 'customer',
    deliveryStatus: 'RECEIVED',
    externalId,
  });
  // Convergence mirror (same id, see the header note): when the
  // texting customer links a user account, their reply also joins
  // the shared BookingMessage thread so /app + Chats carry the same
  // conversation. Unlinked texters stay on this external thread.
  if (booking && customer.userId) {
    const mirror = {
      id: message.id,
      companyId: customer.companyId,
      bookingId: booking.id,
      senderKind: 'CUSTOMER',
      senderUserId: customer.userId,
      senderName: customer.name || 'Customer',
      body: String(text || ''),
      readAt: null,
      createdAt: message.createdAt,
    };
    (store.bookingMessages ||= []).push(mirror);
    await persistBookingMessage(mirror);
  }
  return { matched: true, duplicate: false, thread, message, replyKind, bookingId: booking?.id || null };
}

/**
 * File one inbound customer email on their open thread, when they
 * have one. The Book OS Inbox remains the system of record for email;
 * this only mirrors a reply into an existing conversation so the
 * composer thread reads two-way. No open thread → nothing mirrored.
 */
export async function recordInboundEmail({ customerId, body, subject = null, externalId = null }) {
  if (!customerId) return { matched: false };
  if (externalId && (store.threadMessages || []).some((message) => message.externalId === externalId)) {
    return { matched: true, duplicate: true };
  }
  const customer = store.customers.get(customerId);
  if (!customer) return { matched: false };
  const thread = openThreadFor({ companyId: customer.companyId, customerId });
  if (!thread) return { matched: false, reason: 'no_open_thread' };
  const message = await appendThreadMessage(thread, {
    direction: 'INBOUND',
    channel: 'EMAIL',
    kind: 'MESSAGE',
    body: String(body || ''),
    subject: subject || null,
    author: 'customer',
    deliveryStatus: 'RECEIVED',
    externalId,
  });
  return { matched: true, duplicate: false, thread, message };
}
