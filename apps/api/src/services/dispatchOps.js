import { store } from '../data/store.js';
import { windowById } from './bookos.js';
import { certificationFactor } from './academyCerts.js';

/**
 * Service Setters operations layer (2026-11-17, Operations Blueprint
 * §§3/5/7/12) — the exception queue, P1–P4 priority tiers, the ranked
 * assignment aid, the recovery queues and the capacity ceiling.
 *
 * Everything here is DERIVED from records the platform already keeps —
 * the booking's audited history, its dispatch assignments, the field
 * record the Tech App writes — so these views can never drift from the
 * job itself the way a parallel hand-maintained list would. Nothing in
 * this module assigns, dispatches or messages anyone: ranking is
 * advice, and a Service Setter makes every assignment, exactly as the
 * platform has always worked.
 */

/* ---------------- thresholds (the one place they live) ----------------
 * Sensible office defaults, stated here so the whole build agrees:
 *  - an approved offer the tech has not accepted within 60 minutes is
 *    a missed acceptance;
 *  - an estimate with no recorded authorization 24 hours after it was
 *    saved is unresolved;
 *  - a job flagged awaiting-parts for more than 48 hours is a parts
 *    delay;
 *  - an escalated customer review with no office reply within 24
 *    hours is an unanswered complaint.
 */
export const OPS_THRESHOLDS = {
  ACCEPTANCE_MINUTES: 60,
  ESTIMATE_UNRESOLVED_HOURS: 24,
  PARTS_DELAY_HOURS: 48,
  COMPLAINT_RESPONSE_HOURS: 24,
};

/* ----------------------------- priorities ---------------------------- */

export const PRIORITY_TIERS = ['P1', 'P2', 'P3', 'P4'];

export const PRIORITY_LABELS = {
  P1: 'P1 — Critical commercial failure',
  P2: 'P2 — Urgent household loss / active leak',
  P3: 'P3 — Routine repair',
  P4: 'P4 — Planned installation / maintenance',
};

function isInstallation(booking) {
  const appliance = String(booking?.appliance || '').trim().toLowerCase();
  return appliance === 'installation' || appliance.startsWith('installation');
}

/** The tier a booking carries when no setter has set one. */
export function defaultTierFor(booking) {
  return isInstallation(booking) ? 'P4' : 'P3';
}

/**
 * The booking's effective priority tier: a tier a setter deliberately
 * stored wins; otherwise the default derives from the work itself
 * (installations → P4, everything else → P3).
 */
export function priorityTierOf(booking) {
  const stored = String(booking?.priorityTier || '').toUpperCase();
  if (PRIORITY_TIERS.includes(stored)) return stored;
  return defaultTierFor(booking);
}

/* ------------------------- booking state folds ------------------------ */

function segmentOf(booking) {
  if (booking.segment) return booking.segment;
  return booking.source === 'COMMERCIAL' || booking.commercial ? 'COMMERCIAL' : 'RESIDENTIAL';
}

/**
 * Fold the booking's audited history into its current field state —
 * the same event semantics the Tech App workspace reads (routes/
 * provider.js jobFlags + the Tech Pro field record), plus the
 * timestamps the exception thresholds measure from and the return-
 * visit flag the recovery queue reads.
 */
export function foldJobState(booking) {
  const state = {
    workStarted: false,
    awaitingParts: false,
    awaitingPartsSince: null,
    awaitingDiagnosis: false,
    arrivedAt: null,
    latestEstimate: null,
    latestEstimateAt: null,
    estimateAuthorizedAt: null,
    receiptsTotalCents: 0,
    receiptsCount: 0,
    returnVisitNeeded: false,
    returnVisitSince: null,
    returnVisitNote: null,
    cancelledAt: null,
    cancelReason: null,
  };
  for (const event of booking?.history || []) {
    switch (event.type) {
      case 'TECH_WORK_STARTED':
        state.workStarted = true;
        state.awaitingParts = false;
        state.awaitingPartsSince = null;
        state.awaitingDiagnosis = false;
        break;
      case 'JOB_AWAITING_PARTS':
        state.awaitingParts = true;
        state.awaitingPartsSince = event.at || null;
        break;
      case 'JOB_AWAITING_DIAGNOSIS':
        state.awaitingDiagnosis = true;
        break;
      case 'DIAGNOSIS_STARTED':
      case 'DIAGNOSIS_RECORDED':
        state.awaitingDiagnosis = false;
        break;
      case 'PART_USED_FROM_VAN':
      case 'PLUG_ORDER_CREATED':
        state.awaitingParts = false;
        state.awaitingPartsSince = null;
        break;
      case 'TECH_ARRIVED':
        state.arrivedAt = event.at || null;
        break;
      case 'ESTIMATE_SAVED':
        if (event.estimate) {
          state.latestEstimate = event.estimate;
          state.latestEstimateAt = event.at || null;
        }
        break;
      case 'ESTIMATE_APPROVED':
        state.estimateAuthorizedAt = event.at || state.estimateAuthorizedAt;
        break;
      case 'RECEIPT_RECORDED':
        if (event.receipt) {
          state.receiptsTotalCents += event.receipt.amountCents || 0;
          state.receiptsCount += 1;
        }
        break;
      case 'RETURN_VISIT_FLAGGED':
        state.returnVisitNeeded = true;
        state.returnVisitSince = event.at || null;
        state.returnVisitNote = event.note || null;
        break;
      case 'RETURN_VISIT_CLEARED':
        state.returnVisitNeeded = false;
        state.returnVisitSince = null;
        state.returnVisitNote = null;
        break;
      case 'BOOKING_CANCELLED':
        state.cancelledAt = event.at || null;
        state.cancelReason = event.reason || null;
        break;
      default:
        break;
    }
  }
  return state;
}

/** Estimate vs. recorded receipts — the Tech Pro balance model. */
export function balanceOf(booking, state = foldJobState(booking)) {
  const estimateTotalCents = state.latestEstimate ? state.latestEstimate.totalCents ?? null : null;
  return {
    estimateTotalCents,
    receiptsTotalCents: state.receiptsTotalCents,
    balanceDueCents:
      estimateTotalCents == null ? null : Math.max(0, estimateTotalCents - state.receiptsTotalCents),
  };
}

/** An estimate is resolved once an authorization is recorded at/after it. */
function estimateResolved(state) {
  if (!state.latestEstimate) return true;
  if (!state.estimateAuthorizedAt) return false;
  if (!state.latestEstimateAt) return true;
  return state.estimateAuthorizedAt >= state.latestEstimateAt;
}

function assignmentsFor(bookingId) {
  return [...store.dispatchAssignments.values()].filter((a) => a.bookingId === bookingId);
}

function activeAssignmentFor(bookingId) {
  return (
    assignmentsFor(bookingId).find((a) => a.status === 'APPROVED' || a.status === 'ACCEPTED') || null
  );
}

function providerName(providerId) {
  if (!providerId) return null;
  const provider = (store.providers || []).find((p) => p.id === providerId);
  return provider?.businessName || null;
}

function appointmentStart(booking) {
  const a = booking.appointment;
  if (!a || a.status !== 'SET' || !a.date) return null;
  const w = windowById(a.window);
  if (!w) return null;
  const t = Date.parse(`${a.date}T${w.start}:00Z`);
  return Number.isNaN(t) ? null : t;
}

function appointmentEnd(booking) {
  const a = booking.appointment;
  if (!a || a.status !== 'SET' || !a.date) return null;
  const w = windowById(a.window);
  if (!w) return null;
  const t = Date.parse(`${a.date}T${w.end}:00Z`);
  return Number.isNaN(t) ? null : t;
}

function briefRow(booking, state) {
  return {
    bookingId: booking.id,
    referenceCode: booking.referenceCode || null,
    customerName: booking.customer?.name || null,
    customerPhone: booking.customer?.phone || null,
    city: booking.city,
    zip: booking.zip,
    appliance: booking.appliance,
    issue: booking.issue,
    segment: segmentOf(booking),
    priorityTier: priorityTierOf(booking),
    status: booking.status,
    appointment:
      booking.appointment?.status === 'SET'
        ? {
            date: booking.appointment.date,
            window: booking.appointment.window,
            windowLabel: windowById(booking.appointment.window)?.label || booking.appointment.window,
          }
        : null,
    providerId: booking.dispatch?.providerId || activeAssignmentFor(booking.id)?.providerId || null,
    providerName: providerName(booking.dispatch?.providerId || activeAssignmentFor(booking.id)?.providerId),
  };
}

const minutesBetween = (fromMs, toMs) => Math.max(0, Math.floor((toMs - fromMs) / 60000));

/* --------------------------- exception queue -------------------------- */

export const EXCEPTION_TYPES = {
  MISSED_ACCEPTANCE: 'Missed acceptance',
  LATE_ARRIVAL: 'Late arrival',
  PARTS_DELAY: 'Parts delay',
  UNRESOLVED_ESTIMATE: 'Unresolved estimate',
  COMPLAINT: 'Complaint',
};

/**
 * Derive the exception queue for a set of (already company-scoped)
 * bookings. `complaints` is the caller-fetched list of escalated,
 * not-yet-answered reviews: { reviewId, bookingId, rating,
 * escalationReason, createdAt }. Every row names its accountable
 * owner, the next action, and the time that action is due.
 */
export function deriveExceptions(bookings, { complaints = [], now = new Date() } = {}) {
  const nowMs = now.getTime();
  const rows = [];
  const push = (booking, state, type, fields) => {
    const base = briefRow(booking, state);
    rows.push({
      key: `${booking.id}:${type}`,
      type,
      typeLabel: EXCEPTION_TYPES[type],
      ...base,
      ageMinutes: fields.sinceAt ? minutesBetween(Date.parse(fields.sinceAt), nowMs) : null,
      overdueMinutes: fields.dueAt ? Math.floor((nowMs - Date.parse(fields.dueAt)) / 60000) : null,
      ...fields,
    });
  };

  for (const booking of bookings) {
    if (booking.status === 'CANCELLED') continue;
    const state = foldJobState(booking);
    const assignment = activeAssignmentFor(booking.id);
    const setterName = booking.appointment?.setBy || booking.dispatch?.approvedBy || null;
    const ownerFor = (a) => ({
      providerId: a?.providerId || null,
      providerName: providerName(a?.providerId),
      setterName,
    });

    // Missed acceptance — an approved offer the tech has not accepted
    // within the acceptance window (job still open).
    if (booking.status !== 'COMPLETED' && assignment && assignment.status === 'APPROVED') {
      const offeredAt = assignment.approvedAt || assignment.createdAt;
      const offeredMs = offeredAt ? Date.parse(offeredAt) : NaN;
      if (!Number.isNaN(offeredMs) && nowMs - offeredMs > OPS_THRESHOLDS.ACCEPTANCE_MINUTES * 60000) {
        const start = appointmentStart(booking);
        push(booking, state, 'MISSED_ACCEPTANCE', {
          owner: ownerFor(assignment),
          nextAction: 'Call or text the provider to accept the job — or reassign it to another provider.',
          sinceAt: offeredAt,
          dueAt: start ? new Date(start).toISOString() : new Date(offeredMs + 2 * 3600000).toISOString(),
          detail: { offeredAt, assignmentId: assignment.id },
        });
      }
    }

    // Late arrival — the appointment window has fully passed and no
    // arrival was ever recorded for the job.
    if (booking.status !== 'COMPLETED' && assignment && booking.appointment?.status === 'SET') {
      const end = appointmentEnd(booking);
      if (end && nowMs > end && !state.arrivedAt) {
        push(booking, state, 'LATE_ARRIVAL', {
          owner: ownerFor(assignment),
          nextAction: 'Call the technician for a live ETA, then update the customer with the new arrival time.',
          sinceAt: new Date(end).toISOString(),
          dueAt: new Date(end).toISOString(),
          detail: { appointmentDate: booking.appointment.date, window: booking.appointment.window },
        });
      }
    }

    // Parts delay — the job has sat in Awaiting Parts past the delay
    // threshold.
    if (
      booking.status !== 'COMPLETED' &&
      state.awaitingParts &&
      state.awaitingPartsSince &&
      nowMs - Date.parse(state.awaitingPartsSince) > OPS_THRESHOLDS.PARTS_DELAY_HOURS * 3600000
    ) {
      push(booking, state, 'PARTS_DELAY', {
        owner: ownerFor(assignment),
        nextAction: 'Confirm the part’s supplier ETA (or source it elsewhere), then rebook the return visit with the customer.',
        sinceAt: state.awaitingPartsSince,
        dueAt: new Date(Date.parse(state.awaitingPartsSince) + OPS_THRESHOLDS.PARTS_DELAY_HOURS * 3600000).toISOString(),
        detail: {},
      });
    }

    // Unresolved estimate — an estimate is on record with no customer
    // authorization recorded a day later.
    if (
      booking.status !== 'COMPLETED' &&
      state.latestEstimate &&
      state.latestEstimateAt &&
      !estimateResolved(state) &&
      nowMs - Date.parse(state.latestEstimateAt) > OPS_THRESHOLDS.ESTIMATE_UNRESOLVED_HOURS * 3600000
    ) {
      push(booking, state, 'UNRESOLVED_ESTIMATE', {
        owner: ownerFor(assignment),
        nextAction: 'Follow up with the customer for the estimate decision — approve, decline, or reschedule.',
        sinceAt: state.latestEstimateAt,
        dueAt: new Date(Date.parse(state.latestEstimateAt) + OPS_THRESHOLDS.ESTIMATE_UNRESOLVED_HOURS * 3600000).toISOString(),
        detail: { estimateTotalCents: state.latestEstimate.totalCents ?? null },
      });
    }
  }

  // Complaints — escalated customer reviews with no office reply yet.
  // The signal is real platform data (Review.escalated, set by the
  // review pipeline's own escalation rules); the office reply in the
  // review queue is what clears it.
  const byId = new Map(bookings.map((b) => [b.id, b]));
  for (const complaint of complaints) {
    const booking = complaint.bookingId ? byId.get(complaint.bookingId) : null;
    if (!booking) continue;
    const state = foldJobState(booking);
    push(booking, state, 'COMPLAINT', {
      owner: { providerId: null, providerName: null, setterName: null },
      nextAction: 'Work the service recovery: reply to the customer from the Pepper Lists review queue and make the job right.',
      sinceAt: complaint.createdAt,
      dueAt: new Date(Date.parse(complaint.createdAt) + OPS_THRESHOLDS.COMPLAINT_RESPONSE_HOURS * 3600000).toISOString(),
      detail: {
        reviewId: complaint.reviewId,
        rating: complaint.rating ?? null,
        escalationReason: complaint.escalationReason || null,
      },
    });
  }

  rows.sort((a, b) => String(a.dueAt).localeCompare(String(b.dueAt)));
  return rows;
}

/* --------------------------- recovery queues -------------------------- */

/**
 * The blueprint §12 recovery queues, each fed from the same folded
 * state — no hand-kept lists. Missed calls are deliberately absent:
 * the platform keeps no call log (Twilio voice forwards calls and
 * alerts on voicemail only), so there is no honest source for one.
 */
export function deriveRecoveryQueues(bookings, { now = new Date() } = {}) {
  const nowMs = now.getTime();
  const queues = {
    awaitingParts: [],
    pendingEstimates: [],
    returnVisits: [],
    cancellations: [],
    unpaid: [],
  };
  for (const booking of bookings) {
    const state = foldJobState(booking);
    const base = briefRow(booking, state);
    const age = (sinceAt) => (sinceAt ? minutesBetween(Date.parse(sinceAt), nowMs) : null);

    if (booking.status === 'CANCELLED') {
      queues.cancellations.push({
        ...base,
        sinceAt: state.cancelledAt || booking.updatedAt || null,
        ageMinutes: age(state.cancelledAt || booking.updatedAt),
        detail: { reason: state.cancelReason },
      });
      continue;
    }
    if (state.awaitingParts) {
      queues.awaitingParts.push({
        ...base,
        sinceAt: state.awaitingPartsSince,
        ageMinutes: age(state.awaitingPartsSince),
        detail: {},
      });
    }
    if (state.latestEstimate && !estimateResolved(state) && booking.status !== 'COMPLETED') {
      queues.pendingEstimates.push({
        ...base,
        sinceAt: state.latestEstimateAt,
        ageMinutes: age(state.latestEstimateAt),
        detail: { estimateTotalCents: state.latestEstimate.totalCents ?? null },
      });
    }
    if (state.returnVisitNeeded) {
      queues.returnVisits.push({
        ...base,
        sinceAt: state.returnVisitSince,
        ageMinutes: age(state.returnVisitSince),
        detail: { note: state.returnVisitNote },
      });
    }
    if (booking.status === 'COMPLETED') {
      const balance = balanceOf(booking, state);
      if (balance.balanceDueCents != null && balance.balanceDueCents > 0) {
        queues.unpaid.push({
          ...base,
          sinceAt: booking.completedAt || null,
          ageMinutes: age(booking.completedAt),
          detail: { ...balance },
        });
      }
    }
  }
  const byAge = (a, b) => (b.ageMinutes ?? 0) - (a.ageMinutes ?? 0);
  for (const key of Object.keys(queues)) queues[key].sort(byAge);
  return queues;
}

/* ------------------------- ranked assignment aid ---------------------- */

/**
 * Ranked assignment suggestions for one booking — the blueprint §5
 * ranking (skill, credentials, availability, route proximity, parts,
 * service history) computed from live platform state. READ-ONLY
 * advice for the setter: it creates no assignment and touches no
 * booking. A setter still picks the provider and confirms through the
 * normal approval step; nothing here can dispatch on its own.
 *
 * Scoring keeps the matcher's long-standing base (specialty 60 /
 * service area 30 / rating ×2) so the aid and the auto-match agree,
 * then adds the operational signals: open load, van stock, completed
 * history — and, since 2026-11-20 (D12), the team's verified Academy
 * certifications as one more weighed factor (services/
 * academyCerts.js). "Valid credentials" is the platform's real
 * gate — a provider is team-verified before activation, and only
 * active providers are ranked at all.
 */
export function rankAssignmentCandidates(booking, { limit = 8 } = {}) {
  const area = booking.area || booking.city;
  const openByProvider = new Map();
  const doneByProvider = new Map();
  for (const a of store.dispatchAssignments.values()) {
    if (a.status === 'APPROVED' || a.status === 'ACCEPTED') {
      openByProvider.set(a.providerId, (openByProvider.get(a.providerId) || 0) + 1);
    }
    if (a.status === 'COMPLETED') {
      doneByProvider.set(a.providerId, (doneByProvider.get(a.providerId) || 0) + 1);
    }
  }
  const vanLinesByProvider = new Map();
  for (const line of store.vanStock || []) {
    if ((line.qty || 0) > 0) vanLinesByProvider.set(line.providerId, (vanLinesByProvider.get(line.providerId) || 0) + 1);
  }

  const ranked = (store.providers || [])
    .filter((provider) => provider.active)
    .map((provider) => {
      const reasons = [];
      let score = 0;
      const specialty = (provider.specialties || []).includes(booking.appliance);
      const servesArea = (provider.serviceCities || []).includes(area);
      if (specialty) {
        score += 60;
        reasons.push({ kind: 'pro', label: `Specialty match — ${booking.appliance}` });
      } else {
        reasons.push({ kind: 'con', label: `No listed ${booking.appliance} specialty — general coverage` });
      }
      if (servesArea) {
        score += 30;
        reasons.push({ kind: 'pro', label: `Serves the ${area} area` });
      } else {
        reasons.push({ kind: 'con', label: `Outside the listed service cities (${area} not covered)` });
      }
      const rating = provider.rating == null ? null : Number(provider.rating);
      if (rating != null) {
        score += Math.round(rating * 2);
        reasons.push({ kind: 'info', label: `Rated ${rating} from real completed jobs` });
      }
      reasons.push({ kind: 'info', label: 'Active, team-verified provider' });

      const open = openByProvider.get(provider.id) || 0;
      if (open === 0) {
        score += 10;
        reasons.push({ kind: 'pro', label: 'Available now — no open jobs' });
      } else if (open <= 2) {
        score += 5;
        reasons.push({ kind: 'info', label: `Light load — ${open} open job${open === 1 ? '' : 's'}` });
      } else {
        reasons.push({ kind: 'con', label: `Heavy load — ${open} open jobs` });
      }

      const vanLines = vanLinesByProvider.get(provider.id) || 0;
      if (vanLines > 0) {
        score += 5;
        reasons.push({ kind: 'pro', label: `Van stocked — ${vanLines} part line${vanLines === 1 ? '' : 's'} on board` });
      } else {
        reasons.push({ kind: 'info', label: 'No van stock recorded' });
      }

      const done = doneByProvider.get(provider.id) || 0;
      if (done >= 10) {
        score += 5;
        reasons.push({ kind: 'pro', label: `Proven record — ${done} completed jobs` });
      } else if (done > 0) {
        score += 2;
        reasons.push({ kind: 'info', label: `${done} completed job${done === 1 ? '' : 's'} on record` });
      } else {
        reasons.push({ kind: 'info', label: 'No completed jobs on record yet' });
      }

      // Academy certifications (2026-11-20, D12): verified track
      // certifications held by the provider's own techs weigh as ONE
      // factor among the ones above — the field certification
      // (Technician Track) weighs on every job and extra on its
      // specialty appliance (Refrigerator, the sealed-system end of
      // the trade); Foundation weighs a little. The policy and the
      // derivation live in services/academyCerts.js +
      // data/academyTracks.js. Certifications never touch
      // eligibility (still the base-score bar below) and never
      // dispatch: this stays ranked advice for a human setter.
      const certFactor = certificationFactor(provider, booking);
      if (certFactor.points > 0) {
        score += certFactor.points;
        reasons.push(...certFactor.reasons);
      } else if (certFactor.certifications.length) {
        reasons.push({
          kind: 'info',
          label: `Academy certified — ${certFactor.certifications.map((c) => c.track).join(', ')} (office tracks — no field weight)`,
        });
      }

      const baseScore =
        (specialty ? 60 : 0) + (servesArea ? 30 : 0) + (rating != null ? Math.round(rating * 2) : 0);
      return {
        providerId: provider.id,
        providerCompanyId: provider.companyId,
        businessName: provider.businessName,
        // Two tech systems (2026-11-19): which side of the one
        // dispatch pipeline this target belongs to — setters see the
        // side on every assignment target.
        system: provider.companyCrew ? 'COMPANY' : 'NETWORK',
        type: provider.type,
        rating,
        specialties: provider.specialties || [],
        serviceCities: provider.serviceCities || [],
        score,
        // Eligible mirrors the matcher's own bar (base score ≥ 65) so
        // the aid never talks a setter into a pick the matcher itself
        // would not propose.
        eligible: baseScore >= 65,
        openJobs: open,
        completedJobs: done,
        vanLines,
        // Academy certifications held by this provider's techs
        // (D12): names + certified-tech counts, derived from real
        // completion records — empty when none are held.
        certifications: certFactor.certifications,
        reasons,
      };
    })
    .sort((a, b) => b.score - a.score || String(a.businessName).localeCompare(String(b.businessName)))
    .slice(0, limit);
  return ranked;
}

/* ------------------------------ capacity ------------------------------ */

export const CAPACITY_DEFAULTS = {
  bufferPercent: 25,
  minutesPerJob: 120,
  workingHoursPerDay: 8,
};

/**
 * The blueprint §7 ceiling: technicians × working hours × 60 ×
 * (1 − buffer) ÷ expected minutes per job (incl. travel). A planning
 * estimate — it informs the office; it never blocks a booking.
 */
export function capacityCeiling({ technicians, settings }) {
  const s = { ...CAPACITY_DEFAULTS, ...(settings || {}) };
  const raw =
    (technicians * s.workingHoursPerDay * 60 * (1 - s.bufferPercent / 100)) / s.minutesPerJob;
  return Math.max(0, Math.floor(raw));
}
