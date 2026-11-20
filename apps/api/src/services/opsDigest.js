import { store } from '../data/store.js';
import { deriveExceptions, deriveRecoveryQueues } from './dispatchOps.js';
import { listReviewComments, listReviews } from '../db/reviewsRepo.js';

/**
 * Pepper morning ops digest (2026-11-20, recommendations D14).
 *
 * A DRAFT for the office, computed fresh from the same real sources
 * the consoles read — the booking store, the dispatch-ops
 * derivations (exception queue + recovery queues, services/
 * dispatchOps.js) and the review pipeline's escalation signal. It
 * invents nothing and stores nothing: GET /pepper-console/digest
 * returns the computed digest; saving it as a draft is a separate,
 * deliberate staff action (POST /pepper-console/digest/draft) that
 * files it in the Pepper report log as a STATUS report. The digest
 * is NEVER sent anywhere — no notification, no email, no SMS path
 * exists in this module.
 *
 * Honesty idiom matches the Pepper board: every section is read
 * independently and a section that cannot be read comes back
 * { available: false, reason } — never a guessed number.
 */

const UNAVAILABLE_REASON = 'This section could not be read from this server right now — open its own console for the live state.';
const ROW_CAP = 8;

const etDateFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** 'YYYY-MM-DD' in America/New_York (the business's timezone). */
export function etDateString(date) {
  return etDateFormat.format(date);
}

function shiftDate(dateStr, days) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isEtDate(iso, dateStr) {
  if (!iso) return false;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  return etDateString(new Date(t)) === dateStr;
}

const minutesBetween = (fromIso, nowMs) =>
  fromIso ? Math.max(0, Math.floor((nowMs - Date.parse(fromIso)) / 60000)) : null;

function allBookings() {
  return [...store.bookings.values()];
}

function activeAssignmentBookingIds() {
  const ids = new Set();
  for (const a of store.dispatchAssignments.values()) {
    if (a.status === 'APPROVED' || a.status === 'ACCEPTED') ids.add(a.bookingId);
  }
  return ids;
}

/** The review pipeline's open complaint signal — Book OS's own rule. */
async function openComplaints(bookings) {
  const byId = new Map(bookings.map((b) => [b.id, b]));
  const escalated = await listReviews({ escalatedOnly: true });
  const open = [];
  for (const review of escalated) {
    if (!review.bookingId || !byId.has(review.bookingId)) continue;
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

const defaultReaders = {
  async unassigned(now) {
    const nowMs = now.getTime();
    const assigned = activeAssignmentBookingIds();
    const rows = allBookings()
      .filter(
        (b) =>
          b.status !== 'COMPLETED' &&
          b.status !== 'CANCELLED' &&
          !assigned.has(b.id) &&
          !b.dispatch?.providerId,
      )
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    return {
      count: rows.length,
      items: rows.slice(0, ROW_CAP).map((b) => ({
        bookingId: b.id,
        referenceCode: b.referenceCode || null,
        appliance: b.appliance,
        city: b.city,
        issue: b.issue,
        status: b.status,
        createdAt: b.createdAt || null,
        ageMinutes: minutesBetween(b.createdAt, nowMs),
      })),
    };
  },

  async exceptions(now) {
    const bookings = allBookings();
    const complaints = await openComplaints(bookings);
    const items = deriveExceptions(bookings, { complaints, now });
    const byType = {};
    for (const item of items) byType[item.type] = (byType[item.type] || 0) + 1;
    return {
      count: items.length,
      byType,
      items: items.slice(0, ROW_CAP).map((item) => ({
        type: item.type,
        typeLabel: item.typeLabel,
        referenceCode: item.referenceCode,
        appliance: item.appliance,
        city: item.city,
        nextAction: item.nextAction,
        dueAt: item.dueAt || null,
        overdueMinutes: item.overdueMinutes ?? null,
      })),
    };
  },

  async partsDelays(now) {
    const nowMs = now.getTime();
    const queues = deriveRecoveryQueues(allBookings(), { now });
    const rows = queues.awaitingParts || [];
    return {
      count: rows.length,
      items: rows.slice(0, ROW_CAP).map((row) => ({
        bookingId: row.bookingId,
        referenceCode: row.referenceCode,
        appliance: row.appliance,
        city: row.city,
        providerName: row.providerName || null,
        sinceAt: row.sinceAt || null,
        ageMinutes: row.ageMinutes ?? minutesBetween(row.sinceAt, nowMs),
        // Past the blueprint's 48h parts-delay threshold (the same
        // threshold the exception queue escalates on).
        overdue: (row.ageMinutes ?? 0) > 48 * 60,
      })),
    };
  },

  async yesterday(now) {
    const date = shiftDate(etDateString(now), -1);
    const bookings = allBookings();
    const created = bookings.filter((b) => isEtDate(b.createdAt, date)).length;
    const completed = bookings.filter(
      (b) => b.status === 'COMPLETED' && isEtDate(b.completedAt, date),
    ).length;
    let assignmentsApproved = 0;
    for (const a of store.dispatchAssignments.values()) {
      if (a.approvedAt && isEtDate(a.approvedAt, date)) assignmentsApproved += 1;
    }
    return { date, bookingsCreated: created, jobsCompleted: completed, assignmentsApproved };
  },
};

async function readSection(reader, now) {
  try {
    return { available: true, ...(await reader(now)) };
  } catch {
    return { available: false, reason: UNAVAILABLE_REASON };
  }
}

/**
 * Build the digest. `now` and `readers` are injectable so the drills
 * can pin the clock and exercise the honest-unavailable path;
 * production calls this with no argument.
 */
export async function buildOpsDigest({ now = new Date(), readers = defaultReaders } = {}) {
  const [unassigned, exceptions, partsDelays, yesterday] = await Promise.all([
    readSection(readers.unassigned, now),
    readSection(readers.exceptions, now),
    readSection(readers.partsDelays, now),
    readSection(readers.yesterday, now),
  ]);
  return {
    generatedAt: now.toISOString(),
    dateEt: etDateString(now),
    draftOnly: true,
    sections: { unassigned, exceptions, partsDelays, yesterday },
  };
}

/** Plain-text rendering for the report-log draft. */
export function formatDigestDraft(digest) {
  const s = digest.sections || {};
  const lines = [`Morning ops digest — ${digest.dateEt} (draft, computed ${digest.generatedAt}).`];
  const section = (label, sec, render) => {
    if (!sec || sec.available !== true) {
      lines.push(`\n${label}: could not be read — open its own console for the live state.`);
      return;
    }
    render(sec);
  };
  section('Unassigned jobs', s.unassigned, (sec) => {
    lines.push(`\nUnassigned jobs: ${sec.count}`);
    for (const item of sec.items || []) {
      lines.push(`- ${item.referenceCode || item.bookingId} · ${item.appliance} · ${item.city} · waiting ${item.ageMinutes ?? '?'} min`);
    }
  });
  section('Exception queue', s.exceptions, (sec) => {
    const byType = Object.entries(sec.byType || {}).map(([k, v]) => `${k} ${v}`).join(', ');
    lines.push(`\nException queue: ${sec.count}${byType ? ` (${byType})` : ''}`);
    for (const item of sec.items || []) {
      lines.push(`- [${item.typeLabel}] ${item.referenceCode || ''} · ${item.appliance} · ${item.city} — ${item.nextAction}`);
    }
  });
  section('Parts delays', s.partsDelays, (sec) => {
    lines.push(`\nJobs awaiting parts: ${sec.count}`);
    for (const item of sec.items || []) {
      lines.push(`- ${item.referenceCode || item.bookingId} · ${item.appliance} · ${item.city}${item.overdue ? ' · OVER the 48h delay threshold' : ''}`);
    }
  });
  section('Yesterday', s.yesterday, (sec) => {
    lines.push(`\nYesterday (${sec.date}): ${sec.bookingsCreated} bookings created, ${sec.jobsCompleted} jobs completed, ${sec.assignmentsApproved} assignments approved.`);
  });
  lines.push('\nDraft only — prepared for the office in the Pepper console. Nothing was sent anywhere.');
  return lines.join('\n');
}
