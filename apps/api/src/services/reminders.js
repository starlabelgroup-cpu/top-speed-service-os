import { appendEvent, store } from '../data/store.js';
import { ROLES } from '../config/security.js';
import { notifyAppointmentReminderWithReply } from './notifications.js';
import { drainEntries } from './senders.js';
import { appendOutboundToThread, todayInNewYork } from './messageThreads.js';

/**
 * Automated appointment reminders (2026-11-20, Wave 1 setter comms
 * D2) — the sweep behind POST /bookos/reminders/sweep (staff) and
 * GET /bookos/reminders/cron-sweep (CRON_SECRET-guarded, for an
 * external scheduler / Vercel Cron — the same trigger pattern as
 * GET /notifications/cron-drain; no scheduler is configured in
 * vercel.json today, so until one is wired the sweep runs when a
 * setter presses the button or an external scheduler calls the
 * cron endpoint).
 *
 * Due selection, relative to the business day (America/New_York):
 *  - DAY_BEFORE: appointment SET for tomorrow, job not completed /
 *    cancelled.
 *  - MORNING_OF: appointment SET for today, job not completed /
 *    cancelled.
 * Each target is reminded on every channel the customer gave us
 * (email always when an address is on file; SMS when a phone is —
 * its delivery state is whatever Twilio records, toll-free
 * verification caveat included: a blocked text lands FAILED on the
 * outbox entry and on the thread, never dressed up as sent).
 *
 * Idempotent by construction: reminder entries carry per-kind
 * eventKeys and queueNotification dedupes on them, and the thread
 * record is appended only for entries a sweep actually created —
 * running the sweep twice sends nothing twice.
 */

function addDays(dateString, days) {
  const parsed = new Date(`${dateString}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

export function reminderTargets(bookings, today) {
  const tomorrow = addDays(today, 1);
  const eligible = (booking) =>
    booking.appointment?.status === 'SET' && !['COMPLETED', 'CANCELLED'].includes(booking.status);
  return {
    dayBefore: bookings.filter((booking) => eligible(booking) && booking.appointment.date === tomorrow),
    morningOf: bookings.filter((booking) => eligible(booking) && booking.appointment.date === today),
  };
}

export async function runReminderSweep({ today = null, companyId = null, source = 'reminder-sweep' } = {}) {
  const businessToday = today || todayInNewYork();
  const pool = [...store.bookings.values()].filter(
    (booking) => !companyId || booking.companyId === companyId,
  );
  const targets = reminderTargets(pool, businessToday);
  const summary = {
    today: businessToday,
    dayBefore: { bookings: 0, queued: 0 },
    morningOf: { bookings: 0, queued: 0 },
    entries: [],
  };

  const runKind = async (bookings, kind, bucket) => {
    for (const booking of bookings) {
      const results = notifyAppointmentReminderWithReply(booking, kind, booking.source || null);
      const fresh = results.filter((result) => result.created);
      if (!fresh.length) continue;
      bucket.bookings += 1;
      // One awaited drain for this booking's fresh entries, so the
      // thread records the providers' true outcomes, not QUEUED.
      await drainEntries(fresh.map((result) => result.entry)).catch(() => {});
      for (const result of fresh) {
        bucket.queued += 1;
        await appendOutboundToThread({
          booking,
          channel: result.channel === 'sms' ? 'SMS' : 'EMAIL',
          kind: 'REMINDER',
          body: result.entry.payload?.message || '',
          entry: result.entry,
          author: 'system-reminder',
        });
        summary.entries.push({
          bookingId: booking.id,
          kind,
          channel: result.channel,
          to: result.to,
          notificationId: result.entry.id,
          status: result.entry.status,
        });
      }
    }
  };

  await runKind(targets.dayBefore, 'DAY_BEFORE', summary.dayBefore);
  await runKind(targets.morningOf, 'MORNING_OF', summary.morningOf);

  await appendEvent('APPOINTMENT_REMINDER_SWEEP', {
    source,
    actor: ROLES.DISPATCHER,
    entityType: 'BOOKING',
    details: {
      team: 'Service Setters',
      today: businessToday,
      dayBeforeBookings: summary.dayBefore.bookings,
      morningOfBookings: summary.morningOf.bookings,
      notificationsQueued: summary.dayBefore.queued + summary.morningOf.queued,
    },
  });
  return summary;
}
