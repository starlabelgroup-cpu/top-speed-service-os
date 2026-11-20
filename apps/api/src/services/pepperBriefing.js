import { store } from '../data/store.js';
import { effectiveAreaStatus } from '../config/serviceAreas.js';
import { buildPepperStatus } from './pepperConsole.js';
import { buildOpsDigest, etDateString } from './opsDigest.js';
import { buildCallsBySource } from './insights.js';
import { pipelineBoard } from './crmPipeline.js';
import { campaignOutcomeReport } from './adOutcomes.js';
import { reminderTargets } from './reminders.js';
import { todayInNewYork } from './messageThreads.js';
import { listReviews } from '../db/reviewsRepo.js';
import { listCarePlans } from '../db/carePlansRepo.js';
import { listSellerPlans } from '../db/sellerPlansRepo.js';
import { EXPANSION_RING2_CITIES } from '../data/expansionCities.js';

/**
 * Pepper — live operations briefing for ApplianceMan (2026-11-20).
 *
 * Ramone's direction: "You must be live with insights and
 * recommendations, analytics, reports and more to my virtual office
 * appliance man." ApplianceMan is the owner's virtual office; this
 * module is the aggregate behind its Pepper section — ONE read that
 * assembles the live picture from the same services and repos the
 * consoles themselves use:
 *
 *   operations   bookings today / last 7 days, jobs by status, and
 *                the setter-queue depth — the booking store, with
 *                the Book OS queue's own area filter.
 *   digest       the D14 morning ops digest sections (unassigned,
 *                exceptions, parts delays, yesterday) verbatim.
 *   calls        the Tracking Number System's 28-day calls/texts
 *                totals (GET /insights/calls' own builder).
 *   platform     the Pepper duty-post board sections (payments,
 *                Speedy, outbox, Google connections, Ad Studio,
 *                Pepper Lists) from services/pepperConsole.js.
 *   pipeline     the CRM pipeline board's stage counts + known
 *                values (services/crmPipeline.js).
 *   outcomes     the 28-day attributed leads / estimates / won /
 *                collected totals + the cost-per-won state from
 *                services/adOutcomes.js — NO_COST_RECORDED stays
 *                labeled exactly that.
 *   reviews      the review funnel's real counters: asks + reminders
 *                queued in the outbox, reviews received, escalated.
 *
 * RECOMMENDATIONS are derived from REAL states only — each rule
 * below names the state it reads and the one move that resolves it.
 * A state with no readable source produces no recommendation, never
 * a guess. (Two states Ramone has open have NO runtime source in
 * this codebase and are deliberately absent: Stripe payout state —
 * no platform-account read exists here — and the Twilio toll-free
 * messaging verification state, which lives only in the Twilio
 * console.)
 *
 * Honesty idiom matches the Pepper board and the digest: every
 * section is read independently and a section that cannot be read
 * comes back { available: false, reason } — never a guessed number,
 * never a silent zero. `readers` is injectable so the drills can
 * exercise the honest-unavailable path and the recommendation rules
 * without a database.
 */

const UNAVAILABLE_REASON = 'This section could not be read from this server right now — open its own console for the live state.';
const DAY_MS = 24 * 60 * 60 * 1000;

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

function countByStatus(rows) {
  const byStatus = {};
  for (const row of rows) {
    const status = row?.status || 'UNKNOWN';
    byStatus[status] = (byStatus[status] || 0) + 1;
  }
  return byStatus;
}

const defaultReaders = {
  // Bookings picture — the booking store the consoles read, with
  // the setter-queue depth computed by Book OS's own rule (pending
  // dispatch, not out of area).
  async operations(now) {
    const bookings = [...store.bookings.values()];
    const today = etDateString(now);
    const windowDates = new Set([...Array(7)].map((_, i) => shiftDate(today, -i)));
    const inWindow = (iso) => {
      if (!iso) return false;
      const t = Date.parse(iso);
      return !Number.isNaN(t) && windowDates.has(etDateString(new Date(t)));
    };
    return {
      dateEt: today,
      windowDays: 7,
      bookingsCreatedToday: bookings.filter((b) => isEtDate(b.createdAt, today)).length,
      bookingsCreatedLast7Days: bookings.filter((b) => inWindow(b.createdAt)).length,
      jobsCompletedToday: bookings.filter(
        (b) => b.status === 'COMPLETED' && isEtDate(b.completedAt, today),
      ).length,
      jobsCompletedLast7Days: bookings.filter(
        (b) => b.status === 'COMPLETED' && inWindow(b.completedAt),
      ).length,
      jobsByStatus: countByStatus(bookings),
      setterQueueDepth: bookings.filter(
        (b) => b.status === 'PENDING_DISPATCH' && effectiveAreaStatus(b) !== 'OUT_OF_AREA',
      ).length,
    };
  },

  // The D14 digest, verbatim — unassigned / exceptions / parts
  // delays / yesterday from services/opsDigest.js.
  async digest(now) {
    const digest = await buildOpsDigest({ now });
    return { dateEt: digest.dateEt, sections: digest.sections };
  },

  // Calls & texts — the same builder as GET /insights/calls.
  async calls() {
    const calls = await buildCallsBySource();
    return {
      windowDays: calls.windowDays,
      totals: calls.totals,
      unattributed: calls.unattributed,
      bySurface: (calls.bySurface || []).slice(0, 5),
    };
  },

  // Platform health markers — the Pepper duty-post board sections.
  async platform() {
    const status = await buildPepperStatus();
    return { sections: status.sections };
  },

  // CRM pipeline — the board's stage counts and known values. The
  // board is the CURRENT pipeline (not windowed); the client labels
  // it as such next to the 28-day outcomes.
  async pipeline() {
    const board = pipelineBoard();
    return {
      totalLeads: board.totalLeads,
      columns: board.columns.map((c) => ({
        stage: c.stage,
        label: c.label,
        count: c.count,
        valueCents: c.valueCents,
      })),
    };
  },

  // 28-day attributed outcomes + cost-per-won state.
  async outcomes() {
    const report = campaignOutcomeReport({ days: 28 });
    const recorded = report.rows.filter((r) => r.cost && r.cost.status !== 'NO_COST_RECORDED');
    return {
      windowDays: report.windowDays,
      totals: report.totals,
      costStatus: recorded.length ? 'RECORDED' : 'NO_COST_RECORDED',
      campaignsWithRecordedCost: recorded.length,
      costNote: report.costNote,
    };
  },

  // Review funnel counters — asks and reminders are outbox entries
  // (the funnel's own records); reviews received come from the
  // review pipeline's repo, escalations from its own filter.
  async reviews() {
    const entries = store.notificationOutbox || [];
    const rows = await listReviews({});
    const escalated = await listReviews({ escalatedOnly: true });
    return {
      asksQueued: entries.filter((e) => e.template === 'REVIEW_REQUEST').length,
      remindersQueued: entries.filter((e) => e.template === 'REVIEW_REMINDER').length,
      reviewsReceived: rows.length,
      reviewsByStatus: countByStatus(rows),
      escalated: escalated.length,
    };
  },

  // Recommendation source: Care Plan pricing (owner-set only).
  async carePlans() {
    const plans = await listCarePlans();
    return {
      plans: plans.map((p) => ({ key: p.key, name: p.name, priced: p.annualPriceCents != null })),
    };
  },

  // Recommendation source: Pepper Lists seller plan pricing. The
  // Free tier carries no price by design — only the paid tiers can
  // be "unset".
  async sellerPlans() {
    const plans = await listSellerPlans();
    return {
      plans: plans.map((p) => ({
        key: p.key,
        name: p.name,
        priced: p.monthlyPriceCents != null,
      })),
    };
  },

  // Recommendation source: Expander Phase 5 — how many of the
  // next-ring cities carry a PUBLISHED city page in the Marketing
  // OS pipeline (taxonomy city → CITY landing page).
  async phase5() {
    const slugByCityId = new Map((store.marketingCities || []).map((c) => [c.id, c.slug]));
    const publishedSlugs = new Set();
    for (const page of store.landingPages || []) {
      if (page.type !== 'CITY' || page.status !== 'PUBLISHED') continue;
      const slug = slugByCityId.get(page.cityId);
      if (slug) publishedSlugs.add(slug);
    }
    const published = EXPANSION_RING2_CITIES.filter((c) => publishedSlugs.has(c.slug)).length;
    return { published, total: EXPANSION_RING2_CITIES.length, pending: EXPANSION_RING2_CITIES.length - published };
  },

  // Recommendation source: appointment reminders due today (the
  // sweep's own target derivation) vs reminder activity in the
  // outbox over the last 24 hours.
  async reminders(now) {
    const targets = reminderTargets([...store.bookings.values()], todayInNewYork());
    const entries = (store.notificationOutbox || []).filter(
      (e) => e.template === 'APPOINTMENT_REMINDER',
    );
    const cutoff = now.getTime() - DAY_MS;
    let queuedLast24h = 0;
    let lastQueuedAt = null;
    for (const entry of entries) {
      const t = Date.parse(entry.createdAt);
      if (Number.isNaN(t)) continue;
      if (t >= cutoff) queuedLast24h += 1;
      if (lastQueuedAt == null || t > Date.parse(lastQueuedAt)) {
        lastQueuedAt = new Date(t).toISOString();
      }
    }
    return {
      dueDayBefore: targets.dayBefore.length,
      dueMorningOf: targets.morningOf.length,
      dueTotal: targets.dayBefore.length + targets.morningOf.length,
      queuedLast24h,
      lastQueuedAt,
    };
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
 * The recommendation rules — a pure function of the read states.
 * Each item states the fact and the one move that resolves it, in
 * a fixed priority order: live operational pressure first, then
 * the owner-set configuration states. A source that failed to read
 * contributes nothing.
 */
export function buildRecommendations(states) {
  const items = [];
  const digestSections = states.digest?.available ? states.digest.sections : null;

  const exceptions = digestSections?.exceptions;
  if (exceptions?.available && exceptions.count > 0) {
    const byType = Object.entries(exceptions.byType || {})
      .map(([k, v]) => `${k} ${v}`)
      .join(', ');
    items.push({
      id: 'exceptions-open',
      fact: `${exceptions.count} item${exceptions.count === 1 ? '' : 's'} in the exception queue need a Service Setter's attention${byType ? ` (${byType})` : ''}.`,
      action: 'Work the exception queue in Book OS.',
      href: '/book-os',
    });
  }

  const unassigned = digestSections?.unassigned;
  if (unassigned?.available && unassigned.count > 0) {
    const oldest = unassigned.items?.[0]?.ageMinutes;
    items.push({
      id: 'jobs-unassigned',
      fact: `${unassigned.count} job${unassigned.count === 1 ? '' : 's'} waiting for a tech${oldest != null ? ` — the oldest has waited ${oldest} minutes` : ''}.`,
      action: 'Assign from the Book OS dispatch board.',
      href: '/book-os',
    });
  }

  const platformSections = states.platform?.available ? states.platform.sections : null;
  const outbox = platformSections?.notifications;
  if (outbox?.available && outbox.failed > 0) {
    items.push({
      id: 'notifications-failed',
      fact: `${outbox.failed} notification${outbox.failed === 1 ? '' : 's'} in the outbox failed delivery.`,
      action: 'Review the failures in Notifications.',
      href: '/notifications',
    });
  }

  const reminders = states.reminders;
  if (reminders?.available && reminders.dueTotal > 0 && reminders.queuedLast24h === 0) {
    items.push({
      id: 'reminders-due',
      fact: `${reminders.dueTotal} appointment${reminders.dueTotal === 1 ? '' : 's'} due a reminder (${reminders.dueDayBefore} day-before, ${reminders.dueMorningOf} morning-of) and no reminder has gone out in the last 24 hours.`,
      action: 'Run the reminder sweep in Book OS — reminders go out only when a setter runs the sweep; no automatic schedule is wired yet.',
      href: '/book-os',
    });
  }

  if (states.carePlans?.available) {
    const unpriced = states.carePlans.plans.filter((p) => !p.priced);
    if (unpriced.length) {
      items.push({
        id: 'care-price-unset',
        fact: 'The Appliance Care Plan has no annual price set, so customers can see the plan but cannot check out.',
        action: 'Set the price in the Care Plans section of this page — an owner step.',
        href: '#sec-care',
      });
    }
  }

  if (states.sellerPlans?.available) {
    const unpriced = states.sellerPlans.plans.filter((p) => p.key !== 'free' && !p.priced);
    if (unpriced.length) {
      items.push({
        id: 'seller-prices-unset',
        fact: `Pepper Lists seller upgrade plans have no prices set (${unpriced.map((p) => p.name).join(', ')}), so sellers cannot upgrade.`,
        action: 'Set the plan prices in Ad Studio — an owner step.',
        href: '/ad-studio',
      });
    }
  }

  if (states.phase5?.available && states.phase5.pending > 0) {
    items.push({
      id: 'phase5-pending',
      fact: `${states.phase5.pending} of ${states.phase5.total} next-ring city pages are still unpublished — the cities are built in the Marketing OS pipeline, the publish run has not happened.`,
      action: 'Run Phase 5 in the Marketing OS Expander.',
      href: '/marketing-os/expander',
    });
  }

  const connections = platformSections?.insights?.available
    ? platformSections.insights.connections || []
    : [];
  const gbp = connections.find((c) => c.id === 'google-business-profile');
  if (gbp && gbp.status !== 'connected') {
    items.push({
      id: 'gbp-not-connected',
      fact: 'Google Business Profile is not connected, so Google reviews and profile stats cannot appear in the OS.',
      action: 'Connect it in Insights with the Google account that manages the profile — an owner step.',
      href: '/insights',
    });
  }

  return items;
}

/**
 * Build the full briefing. `now` and `readers` are injectable so
 * the drills can pin the clock, exercise the honest-unavailable
 * path and drive the recommendation rules; production calls this
 * with no argument.
 */
export async function buildPepperBriefing({ now = new Date(), readers = {} } = {}) {
  const r = { ...defaultReaders, ...readers };
  const [operations, digest, calls, platform, pipeline, outcomes, reviews, carePlans, sellerPlans, phase5, reminders] =
    await Promise.all([
      readSection(r.operations, now),
      readSection(r.digest, now),
      readSection(r.calls, now),
      readSection(r.platform, now),
      readSection(r.pipeline, now),
      readSection(r.outcomes, now),
      readSection(r.reviews, now),
      readSection(r.carePlans, now),
      readSection(r.sellerPlans, now),
      readSection(r.phase5, now),
      readSection(r.reminders, now),
    ]);
  return {
    generatedAt: now.toISOString(),
    dateEt: etDateString(now),
    sections: { operations, digest, calls, platform, pipeline, outcomes, reviews },
    recommendations: buildRecommendations({
      digest, platform, reminders, carePlans, sellerPlans, phase5,
    }),
    recommendationStates: { carePlans, sellerPlans, phase5, reminders },
  };
}

export { defaultReaders as PEPPER_BRIEFING_READERS };
