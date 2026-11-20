import { store } from '../data/store.js';
import { listContactEvents } from '../db/trackingNumbersRepo.js';
import { listReviews } from '../db/reviewsRepo.js';
import { jobReceipts } from './jobMoney.js';

/**
 * CRM depth D4 (2026-11-20, Ramone approved): ONE timeline per
 * customer — every record the platform actually holds about them, in
 * a single chronological feed on the CRM customer detail:
 *
 *   BOOKING / BOOKING_COMPLETED — the Service Book records.
 *   PAYMENT — PAID rows of the Payment table (online money).
 *   RECEIPT — field receipts recorded on a job's history
 *     (cash / check / Zelle taken in person).
 *   CALL / inbound MESSAGE — ContactEvent rows from the Tracking
 *     Number System. These exist ONLY for contacts that arrived on a
 *     Twilio-routed tracking number; the phone's own call log is not
 *     a platform source and is never synthesized. The source label on
 *     every such entry says so.
 *   MESSAGE (outbound) — notification outbox entries, with the
 *     outbox's own recorded status (QUEUED / SENT / FAILED …),
 *     staff-alert templates excluded exactly as the communications
 *     log excludes them.
 *   EMAIL — Book OS Inbox thread messages matched to the customer.
 *   REVIEW — Pepper Lists Reviews written by the customer's linked
 *     account, with their real moderation status.
 *
 * Honesty rule: an entry exists only where a real record exists. A
 * kind with no records simply never appears — nothing is synthesized,
 * backfilled, or dressed up. Records of duplicate customers merged
 * into this one (D5 tombstones) count as this customer's records:
 * their phones / emails / account ids join the match sets, so the
 * pre-merge history shows on the survivor's timeline.
 */

function digits(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-10);
}

const TIMELINE_CAP = 200;

/** Tombstone customer records merged into this customer (D5). */
export function mergedRecordsOf(customerId) {
  return [...store.customers.values()].filter((c) => c.mergedIntoId && c.mergedIntoId === customerId);
}

/** Every identifier that reaches this customer: their own plus the
 * merged duplicates' — the alias sets timeline matching runs on. */
export function aliasContactsOf(customer) {
  const phones = new Set();
  const emails = new Set();
  const userIds = [];
  const add = (record) => {
    const phone = digits(record.phone);
    if (phone) phones.add(phone);
    if (record.email) emails.add(String(record.email).toLowerCase());
    if (record.userId) userIds.push(record.userId);
  };
  add(customer);
  for (const tombstone of mergedRecordsOf(customer.id)) add(tombstone);
  return { phones, emails, userIds };
}

function money(cents) {
  return `$${((cents || 0) / 100).toFixed(2)}`;
}

export async function buildCustomerTimeline(customer) {
  const { phones, emails, userIds } = aliasContactsOf(customer);
  const bookings = [...store.bookings.values()]
    .filter((b) => b.customerId === customer.id)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const bookingById = new Map(bookings.map((b) => [b.id, b]));
  const entries = [];
  const push = (kind, at, title, detail, source, extra = {}) => {
    if (!at) return;
    entries.push({ kind, at: String(at), title, detail: detail || null, source, ...extra });
  };

  for (const booking of bookings) {
    const ref = booking.referenceCode || 'Booking';
    push(
      'BOOKING',
      booking.createdAt,
      `${ref} — ${booking.appliance} (${booking.issue})`,
      `Status ${booking.status} · ${booking.city || ''}${booking.source ? ` · source ${booking.source}` : ''}`,
      'Service Book',
      { referenceCode: booking.referenceCode || null },
    );
    if (booking.completedAt) {
      push('BOOKING_COMPLETED', booking.completedAt, `${ref} completed`, `${booking.appliance} · ${booking.city || ''}`, 'Service Book', {
        referenceCode: booking.referenceCode || null,
      });
    }
    for (const receipt of jobReceipts(booking)) {
      push(
        'RECEIPT',
        receipt.at,
        `Receipt recorded — ${money(receipt.amountCents)}${receipt.method ? ` (${receipt.method})` : ''}`,
        `On ${ref}${receipt.recordedBy ? ` · recorded by ${receipt.recordedBy}` : ''}`,
        'Job record — field receipt',
        { referenceCode: booking.referenceCode || null, amountCents: receipt.amountCents || 0 },
      );
    }
  }

  for (const payment of store.payments.values()) {
    if (payment.status !== 'PAID') continue;
    const booking = bookingById.get(payment.bookingId);
    if (!booking) continue;
    push(
      'PAYMENT',
      payment.paidAt || payment.createdAt,
      `Payment received — ${money(payment.amountCents)}`,
      `${payment.purpose || 'DIAGNOSTIC'} · on ${booking.referenceCode || 'booking'}`,
      'Payments',
      { referenceCode: booking.referenceCode || null, amountCents: payment.amountCents || 0 },
    );
  }

  // Tracked contacts: only Twilio-routed tracking-number contacts
  // exist as records — matched by the caller's number against every
  // phone this customer is known by (theirs + merged duplicates').
  const contactEvents = await listContactEvents().catch(() => []);
  for (const event of contactEvents) {
    if (!phones.has(digits(event.fromNumber))) continue;
    if (event.channel === 'VOICE') {
      push(
        'CALL',
        event.createdAt,
        'Inbound call',
        `Called the ${event.surfaceKey || 'platform'} tracking number (${event.toNumber})`,
        'Tracking Number System — Twilio-routed calls only',
        {},
      );
    } else if (event.channel === 'SMS') {
      push(
        'MESSAGE',
        event.createdAt,
        'Inbound text',
        `Texted the ${event.surfaceKey || 'platform'} tracking number (${event.toNumber})`,
        'Tracking Number System — Twilio-routed texts only',
        {},
      );
    }
  }

  const bookingIds = new Set(bookings.map((b) => b.id));
  for (const entry of store.notificationOutbox) {
    if (entry.template === 'STAFF_SUBMISSION_ALERT') continue;
    const hit =
      (entry.payload?.bookingId && bookingIds.has(entry.payload.bookingId)) ||
      (entry.to && phones.has(digits(entry.to))) ||
      (entry.to && emails.has(String(entry.to).toLowerCase()));
    if (!hit) continue;
    push(
      'MESSAGE',
      entry.createdAt,
      `${entry.channel || 'Message'} · ${entry.template || 'notification'}`,
      `To ${entry.to || ''} · status ${entry.status || ''}${entry.reason ? ` · ${entry.reason}` : ''}`,
      'Notification outbox',
      {},
    );
  }

  for (const message of store.inboxMessages || []) {
    if (message.customerId !== customer.id) continue;
    push(
      'EMAIL',
      message.createdAt,
      message.subject || '(no subject)',
      `${message.direction || 'INBOUND'} · ${message.direction === 'OUTBOUND' ? `to ${message.toEmail || ''}` : `from ${message.fromEmail || ''}`}`,
      'Book OS Inbox',
      {},
    );
  }

  for (const userId of userIds) {
    const reviews = await listReviews({ customerId: userId }).catch(() => []);
    for (const review of reviews) {
      const booking = review.bookingId ? bookingById.get(review.bookingId) : null;
      push(
        'REVIEW',
        review.createdAt,
        `Rated ${review.rating}/5 — ${review.title || 'Review'}`,
        `Status ${review.status}${review.verifiedRepair ? ' · verified repair' : ''}${booking ? ` · on ${booking.referenceCode}` : ''}`,
        'Pepper Lists Reviews',
        { referenceCode: booking?.referenceCode || null },
      );
    }
  }

  entries.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return { entries: entries.slice(0, TIMELINE_CAP), total: entries.length };
}
