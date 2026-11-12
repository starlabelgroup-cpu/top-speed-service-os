import { store } from '../data/store.js';
import { activeAssignmentFor, computeTracking, providerById } from './tracking.js';

/**
 * Super Apps — the department-store layer (2026-11-12).
 *
 * One Service OS, many storefronts: the flagship, topspeedappliance.net,
 * the referral program, Appliance Connect Pro (home) and Appliance Pro
 * (commercial) all read and write the SAME records. This service is the
 * customer's window into that: a unified activity feed, a per-job order
 * trail that walks the departments (Booking → Service Setters dispatch →
 * Field Service → Parts Supply → Billing → Referrals), and the live
 * department board. Everything here is derived from real records only —
 * no counters are invented, and staff-only fields (parts unit costs,
 * setter internals) never cross into these customer responses.
 */
const digits10 = (value) => String(value || '').replace(/\D/g, '').slice(-10);
const money = (cents) => (typeof cents === 'number' ? `$${(cents / 100).toFixed(2)}` : null);

/** Resolve the signed-in user to their customer footprint (same matching
 *  the Connect summary and referral dashboard use: account link, then
 *  email, then phone — a customer gains a record per booking). */
export function resolveCustomerContext(user) {
  const record = store.users.get(user.id) || {};
  const email = String(record.email || user.email || '').toLowerCase();
  const phoneDigits = digits10(record.phone || user.phone);
  const bookings = [...store.bookings.values()]
    .filter((booking) => {
      const c = booking.customer || {};
      if (c.userId && c.userId === user.id) return true;
      if (email && String(c.email || '').toLowerCase() === email) return true;
      if (phoneDigits && digits10(c.phone) === phoneDigits) return true;
      return false;
    })
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const customerIds = new Set(bookings.map((b) => b.customerId).filter(Boolean));
  for (const customer of store.customers.values()) {
    if ((phoneDigits && digits10(customer.phone) === phoneDigits) || (email && String(customer.email || '').toLowerCase() === email)) {
      customerIds.add(customer.id);
    }
  }
  return { email, phoneDigits, bookings, customerIds };
}

export const SOURCE_LABELS = {
  SPEEDY_CHAT: 'Booked with Speedy (chat)',
  WEB_FORM: 'Booked on the Smart Booking form',
  FLAGSHIP_NET: 'Booked on topspeedappliance.net',
  COMMERCIAL: 'Commercial service request',
  REFERRAL: 'Booked through a referral',
  PHONE: 'Booked by phone with the team',
};

const HISTORY_MAP = {
  BOOKING_CREATED: ['Booking', 'Service request received'],
  APPOINTMENT_SET: ['Booking', 'Appointment window set'],
  APPOINTMENT_CONFIRMED: ['Booking', 'Appointment confirmed'],
  APPOINTMENT_RESCHEDULED: ['Booking', 'Appointment rescheduled'],
  DISPATCH_MATCHED: ['Service Setters — Dispatch', 'The system matched a technician'],
  DISPATCH_APPROVED: ['Service Setters — Dispatch', 'Dispatch approved by a Service Setter'],
  ASSIGNMENT_ACCEPTED: ['Service Setters — Dispatch', 'Your technician accepted the job'],
  ASSIGNMENT_DECLINED: ['Service Setters — Dispatch', 'A technician passed — the setters are re-matching'],
  TECH_EN_ROUTE: ['Field Service', 'Technician en route'],
  TECH_ARRIVED: ['Field Service', 'Technician arrived'],
  DIAGNOSIS_STARTED: ['Field Service', 'Diagnosis in progress'],
  ESTIMATE_APPROVED: ['Field Service', 'Estimate approved'],
  TECH_NOTE: ['Field Service', 'Your technician updated the job'],
  PAYMENT_RECEIVED: ['Billing', 'Payment recorded'],
  REPAIR_COMPLETED: ['Field Service', 'Repair completed'],
  JOB_COMPLETED: ['Field Service', 'Job completed'],
};

function paymentsForBooking(bookingId) {
  return [...store.payments.values()]
    .filter((p) => p.bookingId === bookingId)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    .map((p) => ({
      id: p.id,
      purpose: p.purpose,
      amountCents: p.amountCents,
      amount: money(p.amountCents),
      status: p.status,
      paidAt: p.paidAt || null,
      createdAt: p.createdAt,
    }));
}

function partsForBooking(referenceCode) {
  const partById = new Map(store.parts.map((p) => [p.id, p]));
  return store.partUsages
    .filter((u) => u.bookingReference === referenceCode)
    .map((u) => {
      const part = partById.get(u.partId);
      // Customer view: what was used and how many. Unit costs are a
      // staff-only field and deliberately never leave through here.
      return { name: part?.name || 'Part', sku: part?.sku || null, qty: u.qty, usedAt: u.createdAt };
    });
}

/** The full department trail for one of the customer's own jobs. */
export function buildOrderTrail(context, reference) {
  const wanted = String(reference || '').trim().toUpperCase();
  const booking = context.bookings.find((b) => String(b.referenceCode || '').toUpperCase() === wanted);
  if (!booking) return null;

  const tracking = computeTracking(booking);
  const assignment = activeAssignmentFor(booking.id);
  const provider = assignment ? providerById(assignment.providerId) : null;
  const payments = paymentsForBooking(booking.id);
  const parts = partsForBooking(booking.referenceCode);
  const attribution = booking.attribution || {};

  const steps = [];
  steps.push({
    department: 'Booking',
    title: SOURCE_LABELS[booking.source] || 'Service request received',
    detail: [
      `${booking.appliance} — ${booking.issue}`,
      attribution.viaTag ? `Came in via ${attribution.viaTag}` : null,
      attribution.sourcePage ? `Page: ${attribution.sourcePage}` : null,
      attribution.utmCampaign ? `Campaign: ${attribution.utmCampaign}` : null,
    ].filter(Boolean).join(' · '),
    at: booking.createdAt,
    state: 'done',
  });

  const dispatchDetail = assignment
    ? `${provider?.businessName || 'Your Top Speed technician'} — dispatch ${String(assignment.status || '').toLowerCase()} by the Service Setters`
    : booking.status === 'PENDING_DISPATCH'
      ? 'Waiting in the Service Setters queue — a human approves every dispatch'
      : 'Handled by the Service Setters';
  steps.push({
    department: 'Service Setters — Dispatch',
    title: assignment ? 'Technician assigned' : 'With the Service Setters',
    detail: dispatchDetail,
    at: assignment?.updatedAt || assignment?.createdAt || booking.updatedAt || booking.createdAt,
    state: assignment ? 'done' : 'current',
  });

  steps.push({
    department: 'Field Service',
    title: tracking.stageLabel8,
    detail: tracking.technician.assigned
      ? `Technician: ${tracking.technician.name}${tracking.stageIndex === 3 && tracking.etaMinutes ? ` · ETA ${tracking.etaMinutes} min (set by your technician)` : ''}`
      : 'Your technician step starts once dispatch assigns the job',
    at: booking.updatedAt || booking.createdAt,
    state: booking.status === 'COMPLETED' ? 'done' : tracking.stageIndex >= 2 ? 'current' : 'pending',
  });

  if (parts.length) {
    steps.push({
      department: 'Parts Supply',
      title: `${parts.reduce((sum, p) => sum + (p.qty || 0), 0)} part${parts.length === 1 ? '' : 's'} used on this job`,
      detail: parts.map((p) => `${p.name} ×${p.qty}`).join(' · '),
      at: parts[parts.length - 1].usedAt,
      state: 'done',
    });
  }

  const paid = payments.filter((p) => p.status === 'PAID');
  steps.push({
    department: 'Billing',
    title: paid.length ? 'Payment on record' : 'No payment recorded yet',
    detail: payments.length
      ? payments.map((p) => `${p.purpose === 'DIAGNOSTIC' ? 'Diagnostic' : p.purpose} ${p.amount} — ${p.status.toLowerCase()}`).join(' · ')
      : booking.source === 'COMMERCIAL'
        ? 'Commercial work is custom-quoted and invoiced on your consolidated monthly invoice.'
        : 'The $99 diagnostic is collected at booking and credited toward your repair.',
    at: paid[0]?.paidAt || payments[payments.length - 1]?.createdAt || null,
    state: paid.length ? 'done' : 'pending',
    receiptAvailable: paid.length > 0,
  });

  // Referral connections, both directions — only ever the viewer's own.
  const asReferee = store.referralJourneys.find((j) => j.bookingId === booking.id);
  if (asReferee) {
    steps.push({
      department: 'Referrals & Rewards',
      title: 'This job came through a referral',
      detail: 'Booked with a friend\'s referral code — their reward follows this job\'s completion, after a Service Setter approves it.',
      at: asReferee.createdAt,
      state: 'done',
    });
  }
  const earnedHere = store.referralJourneys.find(
    (j) => j.bookingId === booking.id && context.customerIds.has(j.referrerCustomerId),
  );
  const creditHere = store.referralCredits.find(
    (c) => context.customerIds.has(c.customerId) && store.referralJourneys.some((j) => j.id === c.journeyId && j.bookingId === booking.id),
  );
  if (creditHere) {
    steps.push({
      department: 'Referrals & Rewards',
      title: `Referral credit ${creditHere.status === 'AVAILABLE' ? 'issued' : creditHere.status.toLowerCase()}`,
      detail: `${money(creditHere.amountCents)} service credit from this job${creditHere.expiresAt ? ` · expires ${String(creditHere.expiresAt).slice(0, 10)}` : ''}`,
      at: creditHere.createdAt,
      state: 'done',
    });
  } else if (earnedHere) {
    steps.push({
      department: 'Referrals & Rewards',
      title: 'A referral reward is tied to this job',
      detail: 'It moves when this job completes and a Service Setter approves it.',
      at: earnedHere.createdAt,
      state: 'current',
    });
  }

  return {
    reference: booking.referenceCode,
    appliance: booking.appliance,
    issue: booking.issue,
    city: booking.city,
    status: booking.status,
    source: booking.source,
    createdAt: booking.createdAt,
    tracking,
    parts,
    payments,
    trail: steps,
  };
}

/** One chronological feed across every department, for the signed-in customer. */
export function buildActivityFeed(context, { limit = 60 } = {}) {
  const events = [];
  const push = (event) => events.push(event);

  for (const booking of context.bookings) {
    const history = Array.isArray(booking.history) ? booking.history : [];
    if (!history.length) {
      push({
        at: booking.createdAt, kind: 'booking', department: 'Booking',
        title: `${booking.appliance} service booked`,
        detail: `Reference ${booking.referenceCode} · ${booking.city || ''}`.trim(),
        reference: booking.referenceCode,
      });
    }
    for (const entry of history) {
      const mapped = HISTORY_MAP[entry.type];
      if (!mapped) continue;
      push({
        at: entry.at || booking.createdAt, kind: 'job', department: mapped[0],
        title: mapped[1],
        detail: `${booking.appliance} · Ref ${booking.referenceCode}`,
        reference: booking.referenceCode,
      });
    }
    for (const payment of paymentsForBooking(booking.id)) {
      if (payment.status !== 'PAID') continue;
      push({
        at: payment.paidAt || payment.createdAt, kind: 'payment', department: 'Billing',
        title: `Payment recorded — ${payment.amount}`,
        detail: `${payment.purpose === 'DIAGNOSTIC' ? 'Diagnostic fee' : payment.purpose} · Ref ${booking.referenceCode}`,
        reference: booking.referenceCode,
      });
    }
  }

  const journeys = store.referralJourneys.filter((j) => context.customerIds.has(j.referrerCustomerId));
  for (const journey of journeys) {
    const friend = journey.refereeName ? ` for ${journey.refereeName}` : '';
    if (journey.status === 'INVITED' || journey.status === 'CLICKED') {
      push({ at: journey.createdAt, kind: 'referral', department: 'Referrals & Rewards', title: `Referral invite sent${friend}`, detail: `Code ${journey.code}`, reference: null });
    } else if (journey.status === 'BOOKED') {
      push({ at: journey.updatedAt || journey.createdAt, kind: 'referral', department: 'Referrals & Rewards', title: `Your referral booked service${friend}`, detail: `Code ${journey.code}`, reference: journey.bookingReference || null });
    } else if (['COMPLETED', 'REWARD_PENDING_APPROVAL'].includes(journey.status)) {
      push({ at: journey.updatedAt || journey.createdAt, kind: 'referral', department: 'Referrals & Rewards', title: `Referral job completed${friend} — reward in review`, detail: 'A Service Setter approves referral credits.', reference: journey.bookingReference || null });
    }
  }
  for (const credit of store.referralCredits.filter((c) => context.customerIds.has(c.customerId))) {
    push({
      at: credit.createdAt, kind: 'referral', department: 'Referrals & Rewards',
      title: credit.status === 'REDEEMED' ? `Referral credit redeemed — ${money(credit.amountCents)}` : `Referral credit issued — ${money(credit.amountCents)}`,
      detail: credit.status === 'AVAILABLE' ? 'Available toward future service in your Refer & Earn hub.' : `Status: ${credit.status.toLowerCase()}`,
      reference: credit.redeemedReference || null,
    });
  }

  // Customer-facing notification events (their own inbox trail).
  for (const entry of store.notificationOutbox) {
    const toEmail = String(entry.to || '').toLowerCase();
    const toPhone = digits10(entry.to);
    const mine = (context.email && toEmail === context.email) || (context.phoneDigits && toPhone === context.phoneDigits);
    if (!mine || entry.channel === 'internal') continue;
    if (String(entry.template || '').startsWith('STAFF')) continue;
    push({
      at: entry.sentAt || entry.createdAt, kind: 'message', department: 'Notifications',
      title: entry.payload?.subject || 'Update from Top Speed',
      detail: `${entry.channel === 'sms' ? 'Text' : 'Email'} · ${String(entry.status || '').toLowerCase()}`,
      reference: entry.payload?.reference || null,
    });
  }

  return events
    .filter((e) => e.at)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, limit);
}

/** The customer's jobs with tracking + billing summaries (app tiles, receipts). */
export function listCustomerJobs(context) {
  return context.bookings.map((booking) => {
    const tracking = computeTracking(booking);
    const payments = paymentsForBooking(booking.id);
    return {
      reference: booking.referenceCode,
      appliance: booking.appliance,
      issue: booking.issue,
      city: booking.city,
      status: booking.status,
      source: booking.source,
      createdAt: booking.createdAt,
      stageIndex: tracking.stageIndex,
      stageLabel: tracking.stageLabel8,
      technician: tracking.technician,
      payments,
      hasReceipt: payments.some((p) => p.status === 'PAID'),
    };
  });
}

/** The signed-in business's commercial file, when one matches their contact. */
export function commercialSummaryFor(context) {
  const account = [...store.commercialAccounts.values()].find((a) => {
    if (context.email && String(a.email || '').toLowerCase() === context.email) return true;
    if (context.phoneDigits && digits10(a.phone) === context.phoneDigits) return true;
    return false;
  });
  if (!account) return { account: null };
  const facilities = [...store.commercialFacilities.values()].filter((f) => f.accountId === account.id);
  const facilityIds = new Set(facilities.map((f) => f.id));
  const equipment = [...store.commercialEquipment.values()].filter((e) => facilityIds.has(e.facilityId));
  const workOrders = [...store.commercialWorkOrders.values()]
    .filter((w) => w.accountId === account.id)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .map((w) => ({
      referenceCode: w.referenceCode, issue: w.issue, priority: w.priority,
      status: w.effectiveStatus || w.status, bookingReferenceCode: w.bookingReferenceCode || null,
      assetTag: w.assetTag || null, createdAt: w.createdAt,
    }));
  return {
    account: {
      referenceCode: account.referenceCode,
      companyName: account.companyName,
      accountType: account.accountType,
      serviceAgreement: account.slaTier || null,
      status: account.status,
    },
    facilities: facilities.map((f) => ({ name: f.name, city: f.city })),
    equipmentCount: equipment.length,
    workOrders,
  };
}

/** Live department board — real aggregates only, honest zeros. */
export function departmentBoard() {
  const today = new Date().toISOString().slice(0, 10);
  const bookings = [...store.bookings.values()];
  const bookedToday = bookings.filter((b) => String(b.createdAt).slice(0, 10) === today).length;
  const waitingReview = bookings.filter((b) => b.status === 'PENDING_DISPATCH').length;
  const assignments = [...store.dispatchAssignments.values()];
  const assigned = assignments.filter((a) => a.status === 'APPROVED' || a.status === 'ACCEPTED').length;
  let enRoute = 0;
  let completedToday = 0;
  for (const booking of bookings) {
    if (booking.status === 'COMPLETED' && String(booking.updatedAt || '').slice(0, 10) === today) completedToday += 1;
    if (booking.status !== 'COMPLETED' && computeTracking(booking).stageIndex === 3) enRoute += 1;
  }
  const lowStock = store.parts.filter((p) => (p.stockOnHand || 0) <= (p.reorderPoint || 0)).length;
  const creditsIssued = store.referralCredits.filter((c) => c.status === 'AVAILABLE' || c.status === 'REDEEMED').length;
  const referralsCompleted = store.referralJourneys.filter((j) => ['COMPLETED', 'REWARD_PENDING_APPROVAL', 'REWARD_APPROVED', 'CREDIT_ISSUED', 'REDEEMED'].includes(j.status)).length;
  const paidCount = [...store.payments.values()].filter((p) => p.status === 'PAID').length;

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  return {
    generatedAt: new Date().toISOString(),
    departments: [
      { id: 'booking', name: 'Booking', icon: '📅', statusLine: `${plural(bookedToday, 'job', 'jobs')} booked today · ${plural(waitingReview, 'request', 'requests')} waiting for review`, counts: { bookedToday, waitingReview } },
      { id: 'dispatch', name: 'Service Setters — Dispatch', icon: '🎧', statusLine: `${plural(assigned, 'job', 'jobs')} with a technician assigned — a Service Setter approves every dispatch`, counts: { assigned } },
      { id: 'field', name: 'Field Service', icon: '🔧', statusLine: `${plural(enRoute, 'technician', 'technicians')} en route right now · ${plural(completedToday, 'job', 'jobs')} completed today`, counts: { enRoute, completedToday } },
      { id: 'parts', name: 'Parts Supply', icon: '🧩', statusLine: `${plural(store.parts.length, 'part', 'parts')} in the catalog · ${plural(store.partUsages.length, 'part use', 'part uses')} recorded on jobs · ${plural(lowStock, 'part', 'parts')} at reorder point`, counts: { catalogued: store.parts.length, usedOnJobs: store.partUsages.length, lowStock } },
      { id: 'billing', name: 'Billing', icon: '🧾', statusLine: `${plural(paidCount, 'payment', 'payments')} recorded on the platform`, counts: { paymentsRecorded: paidCount } },
      { id: 'referrals', name: 'Referrals & Rewards', icon: '🎁', statusLine: `${plural(referralsCompleted, 'referral', 'referrals')} completed · ${plural(creditsIssued, 'credit', 'credits')} issued to customers`, counts: { referralsCompleted, creditsIssued } },
    ],
  };
}
