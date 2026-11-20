import { store } from '../data/store.js';
import { listReviews } from '../db/reviewsRepo.js';
import { notifyReviewReminder } from './notifications.js';

/**
 * Automated review funnel — the reminder sweep (recommendations F1,
 * 2026-11-20; Ramone approved the full recommendations list).
 *
 * The funnel itself:
 *  - ASK: queued synchronously at the completion success point by
 *    notifyReviewRequest (routes/bookings.js office completion and
 *    routes/provider.js tech completion share it), eventKey-deduped
 *    so a completion replay can never re-send it.
 *  - REMINDER: this sweep — ONE reminder per booking, queued when the
 *    job has been COMPLETED for REVIEW_REMINDER_DELAY_MS and no
 *    Pepper Lists review exists for the booking yet.
 *  - FEEDBACK: the private "tell the office first" path
 *    (routes/feedback.js) files to the Pepper report queue. It is
 *    offered alongside the public ask and has NO effect here: this
 *    sweep never reads feedback, satisfaction, ratings, or any other
 *    signal — every completed job is asked, and reminded, equally.
 *
 * Serverless discipline mirrors sweepReferralCreditExpiry: the sweep
 * rides the outbox drains (staff POST /notifications/send and the
 * CRON_SECRET-guarded GET /notifications/cron-drain, both in
 * routes/integrations.js), scans the hydrated in-memory store, and
 * relies on the outbox eventKey for exactly-once queueing.
 */

/** One reminder, three days after completion, when no review exists. */
export const REVIEW_REMINDER_DELAY_MS = 3 * 24 * 3600 * 1000;

export async function sweepReviewReminders(now = Date.now()) {
  // Any review recorded for a booking — PENDING, PUBLISHED or HIDDEN —
  // means the customer answered the ask; the reminder stops there.
  const reviews = await listReviews({});
  const reviewedBookingIds = new Set(
    reviews.map((review) => review.bookingId).filter(Boolean),
  );
  // The reminder follows the ask: only bookings whose REVIEW_REQUEST
  // actually went out (the outbox hydrates from the database at boot,
  // so this holds across serverless instances) are eligible.
  const askedBookingIds = new Set(
    store.notificationOutbox
      .filter((entry) => entry.template === 'REVIEW_REQUEST' && entry.payload?.bookingId)
      .map((entry) => entry.payload.bookingId),
  );
  const remindedBookingIds = new Set(
    store.notificationOutbox
      .filter((entry) => entry.template === 'REVIEW_REMINDER' && entry.payload?.bookingId)
      .map((entry) => entry.payload.bookingId),
  );

  let reminded = 0;
  for (const booking of store.bookings.values()) {
    if (booking.status !== 'COMPLETED' || !booking.completedAt) continue;
    const completedMs = new Date(booking.completedAt).getTime();
    if (Number.isNaN(completedMs) || now - completedMs < REVIEW_REMINDER_DELAY_MS) continue;
    if (!askedBookingIds.has(booking.id)) continue;
    if (reviewedBookingIds.has(booking.id)) continue;
    if (remindedBookingIds.has(booking.id)) continue;
    const queued = notifyReviewReminder(booking, booking.source || null);
    if (Array.isArray(queued) && queued.length) reminded += 1;
  }
  return { reminded, scannedAt: new Date(now).toISOString() };
}
