import { appendEvent, store } from '../data/store.js';
import { DATABASE_ENABLED, db } from '../db/client.js';
import { STAFF_ROLES } from '../config/security.js';
import {
  getCareBillingSetting, getCarePlanById, getCarePlanByKey,
  getCareSubscriptionByStripeSubscriptionId, getCareSubscriptionByUserId,
  upsertCareSubscription,
} from '../db/carePlansRepo.js';
import { emitReport } from './managementReports.js';
import { cancelStripeSubscription, retrieveStripeSubscription } from './stripe.js';

/**
 * Appliance Care Plan (membership) — access resolution + billing
 * lifecycle (2026-11-20, B4 of the approved recommendations program).
 * The advertiser-plan rules (services/adPlans.js) applied to a
 * customer membership:
 *
 *  - NO INVENTED PRICES. The plan is structure; a price exists only
 *    because the owner set it in the admin surface. This file never
 *    writes a price or a Stripe object.
 *  - Billing lifecycle: ACTIVE → PAST_DUE (failed invoice) → GRACE
 *    (inside the owner-configured grace window, benefits continue) →
 *    SUSPENDED. GRACE/SUSPENDED are computed at read time from the
 *    stored PAST_DUE + pastDueAt — no cron, and drills can
 *    time-travel by moving pastDueAt.
 *  - PRIORITY BOOKING IS A REAL FLAG. A member's bookings are stamped
 *    priority + priorityReasons at creation (applyCarePriority below,
 *    called from the booking create paths), which is exactly what the
 *    Service Setters queue already renders — not a promise in copy.
 *  - The owner and staff are never membership-gated.
 */

export const CARE_FEATURES = [
  { key: 'annualCheckup', label: 'Annual check-up — one full appliance check-up visit included each membership year' },
  { key: 'priorityBooking', label: 'Priority booking — your service requests move to the front of the Service Setters queue' },
];
export const CARE_FEATURE_KEYS = CARE_FEATURES.map((f) => f.key);

const ACTIVE_LIKE = ['ACTIVE', 'TRIALING', 'OFFICE_GRANTED', 'GRACE'];

export function isCareBypass(roles) {
  return (roles || []).some((role) => STAFF_ROLES.includes(role));
}

function noFeatures() {
  return Object.fromEntries(CARE_FEATURE_KEYS.map((key) => [key, false]));
}

function planFeatures(plan) {
  const out = noFeatures();
  for (const key of CARE_FEATURE_KEYS) out[key] = Boolean(plan?.features?.[key]);
  return out;
}

export function effectiveCareStatusOf(row, graceDays, now = new Date()) {
  if (!row) return 'NONE';
  if (row.status === 'PAST_DUE') {
    if (!row.pastDueAt) return 'SUSPENDED';
    const elapsed = now.getTime() - new Date(row.pastDueAt).getTime();
    return elapsed <= graceDays * 24 * 60 * 60 * 1000 ? 'GRACE' : 'SUSPENDED';
  }
  return row.status;
}

function bypassAccess(reqUser) {
  return {
    userId: reqUser.id,
    bypass: true,
    status: 'STAFF',
    effectiveStatus: 'STAFF',
    plan: null,
    planKey: null,
    features: Object.fromEntries(CARE_FEATURE_KEYS.map((key) => [key, true])),
    currentPeriodStart: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    pastDueAt: null,
    checkupBookedForPeriodEnd: null,
    checkupBookingRef: null,
  };
}

/** Resolve an account's effective Care Plan membership. */
export async function resolveCareAccess(reqUser, now = new Date()) {
  if (!reqUser?.id) return null;
  if (isCareBypass(reqUser.roles)) return bypassAccess(reqUser);
  if (!DATABASE_ENABLED) {
    // Phase-1 skeleton (no database): no real memberships to read.
    return {
      userId: reqUser.id, bypass: false, status: 'NONE', effectiveStatus: 'NONE',
      plan: null, planKey: null, features: noFeatures(),
      currentPeriodStart: null, currentPeriodEnd: null, cancelAtPeriodEnd: false,
      pastDueAt: null, checkupBookedForPeriodEnd: null, checkupBookingRef: null,
    };
  }

  const setting = await getCareBillingSetting();
  const row = await getCareSubscriptionByUserId(reqUser.id);
  const effectiveStatus = effectiveCareStatusOf(row, setting.graceDays, now);
  const plan = row?.planId ? await getCarePlanById(row.planId) : null;

  return {
    userId: reqUser.id,
    bypass: false,
    status: row?.status || 'NONE',
    effectiveStatus,
    plan,
    planKey: plan?.key ?? null,
    features: ACTIVE_LIKE.includes(effectiveStatus) && plan ? planFeatures(plan) : noFeatures(),
    currentPeriodStart: row?.currentPeriodStart ?? null,
    currentPeriodEnd: row?.currentPeriodEnd ?? null,
    cancelAtPeriodEnd: Boolean(row?.cancelAtPeriodEnd),
    pastDueAt: row?.pastDueAt ?? null,
    checkupBookedForPeriodEnd: row?.checkupBookedForPeriodEnd ?? null,
    checkupBookingRef: row?.checkupBookingRef ?? null,
    grantedAt: row?.grantedAt ?? null,
    subscription: row || null,
  };
}

export function careAccessHas(access, featureKey) {
  return Boolean(access?.features?.[featureKey]);
}

/** The annual check-up is still owed for the current period. */
export function checkupAvailable(access) {
  if (!access || !careAccessHas(access, 'annualCheckup')) return false;
  if (access.currentPeriodEnd) {
    return access.checkupBookedForPeriodEnd !== access.currentPeriodEnd;
  }
  // Office-granted memberships carry no Stripe period: one check-up
  // per grant, recorded against the grant itself.
  return !access.checkupBookedForPeriodEnd;
}

// ---------------------------------------------------------------------------
// Serializers
// ---------------------------------------------------------------------------

export function publicCarePlan(plan) {
  return {
    key: plan.key,
    name: plan.name,
    description: plan.description ?? null,
    annualPriceCents: plan.annualPriceCents ?? null,
    currency: plan.currency || 'usd',
    priced: plan.annualPriceCents != null,
    features: (() => { const out = noFeatures(); for (const key of CARE_FEATURE_KEYS) out[key] = Boolean(plan?.features?.[key]); return out; })(),
    isActive: plan.isActive !== false,
    sortOrder: plan.sortOrder ?? 0,
  };
}

export function adminCarePlan(plan) {
  return {
    ...publicCarePlan(plan),
    id: plan.id,
    stripeProductId: plan.stripeProductId ?? null,
    stripePriceId: plan.stripePriceId ?? null,
    stripeSynced: Boolean(plan.stripePriceId),
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };
}

export function publicCareAccess(access) {
  if (!access) return null;
  return {
    status: access.status,
    effectiveStatus: access.effectiveStatus,
    bypass: access.bypass,
    planKey: access.planKey,
    features: access.features,
    currentPeriodStart: access.currentPeriodStart,
    currentPeriodEnd: access.currentPeriodEnd,
    cancelAtPeriodEnd: access.cancelAtPeriodEnd,
    pastDueAt: access.pastDueAt,
    checkupAvailable: checkupAvailable(access),
    checkupBookingRef: access.checkupBookingRef,
  };
}

// ---------------------------------------------------------------------------
// Priority booking — the flag the booking flow reads.
// ---------------------------------------------------------------------------

function digitsOf(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-10);
}

async function candidateUserIds({ userId, email, phone }) {
  const ids = new Set();
  if (userId) ids.add(userId);
  const wantedEmail = String(email || '').trim().toLowerCase();
  const wantedPhone = digitsOf(phone);
  if (!wantedEmail && !wantedPhone) return [...ids];
  if (DATABASE_ENABLED) {
    try {
      if (wantedEmail) {
        const rows = await db().user.findMany({ where: { email: wantedEmail }, select: { id: true } });
        for (const row of rows) ids.add(row.id);
      }
      if (wantedPhone) {
        const rows = await db().user.findMany({
          where: { phone: { not: null } },
          select: { id: true, phone: true },
        });
        for (const row of rows) if (digitsOf(row.phone) === wantedPhone) ids.add(row.id);
      }
    } catch { /* fail-soft: priority lookup never breaks a booking */ }
  } else {
    for (const user of store.users.values()) {
      if (wantedEmail && String(user.email || '').toLowerCase() === wantedEmail) ids.add(user.id);
      if (wantedPhone && digitsOf(user.phone) === wantedPhone) ids.add(user.id);
    }
  }
  return [...ids];
}

/**
 * Does this person hold a Care Plan membership with priority booking
 * in force right now? Returns { userId, planKey } or null.
 */
export async function resolveCarePriority(hints = {}) {
  const ids = await candidateUserIds(hints);
  if (!ids.length) return null;
  const setting = DATABASE_ENABLED ? await getCareBillingSetting() : { graceDays: 7 };
  for (const id of ids) {
    const row = await getCareSubscriptionByUserId(id);
    if (!row) continue;
    const effectiveStatus = effectiveCareStatusOf(row, setting.graceDays);
    if (!ACTIVE_LIKE.includes(effectiveStatus)) continue;
    const plan = row.planId ? await getCarePlanById(row.planId) : null;
    if (plan && planFeatures(plan).priorityBooking) {
      return { userId: id, planKey: plan.key };
    }
  }
  return null;
}

/**
 * Stamp a freshly built booking with the Care Plan priority flag.
 * Called by the booking create paths (Speedy/web-form intake and the
 * office work-order create) BEFORE the booking is stored, so the
 * flag is part of the record the setter queue reads. Never removes
 * an existing priority (commercial SLA priority stands on its own),
 * and never throws — a lookup problem must not fail a booking (the
 * referral-attach idiom).
 */
export async function applyCarePriority(booking, hints = {}) {
  try {
    const customer = booking?.customer || {};
    const hit = await resolveCarePriority({
      userId: hints.userId || customer.userId || null,
      email: hints.email || customer.email || null,
      phone: hints.phone || customer.phone || booking?.phone || null,
    });
    if (!hit) return null;
    if (!booking.priority) booking.priority = true;
    const reasons = Array.isArray(booking.priorityReasons) ? booking.priorityReasons : [];
    const reason = 'Care Plan member — priority booking';
    if (!reasons.includes(reason)) reasons.push(reason);
    booking.priorityReasons = reasons;
    booking.carePlan = { userId: hit.userId, planKey: hit.planKey };
    return hit;
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', message: 'care plan priority lookup failed', error: String(error?.message || error) }));
    return null;
  }
}

// ---------------------------------------------------------------------------
// Stripe webhook lifecycle (called from routes/payments.js — the
// diagnostic + advertiser-plan handling there is untouched and runs
// first; this handler answers only purpose CARE_PLAN events).
// ---------------------------------------------------------------------------

function reportBilling(type, title, detail, eventKey) {
  emitReport({ department: 'billing', type, title, detail, source: 'care-plans', reference: detail?.userId || null, eventKey });
}

async function activateFromCheckout(session) {
  const userId = session.metadata?.userId || session.client_reference_id;
  const plan = session.metadata?.planKey ? await getCarePlanByKey(session.metadata.planKey) : null;
  if (!userId || !plan) return;
  const existing = await getCareSubscriptionByUserId(userId);

  let currentPeriodStart = null;
  let currentPeriodEnd = null;
  const stripeSubscriptionId = typeof session.subscription === 'string' ? session.subscription : null;
  if (stripeSubscriptionId) {
    try {
      const sub = await retrieveStripeSubscription(stripeSubscriptionId);
      const start = sub?.current_period_start || sub?.items?.data?.[0]?.current_period_start;
      const end = sub?.current_period_end || sub?.items?.data?.[0]?.current_period_end;
      if (start) currentPeriodStart = new Date(start * 1000).toISOString();
      if (end) currentPeriodEnd = new Date(end * 1000).toISOString();
    } catch { /* best effort — subscription.updated keeps the period current */ }
    // A re-subscribe supersedes the old subscription: cancel it so
    // the member is never double-billed (best effort).
    if (existing?.stripeSubscriptionId && existing.stripeSubscriptionId !== stripeSubscriptionId) {
      try { await cancelStripeSubscription(existing.stripeSubscriptionId); } catch { /* best effort */ }
    }
  }

  await upsertCareSubscription(userId, {
    planId: plan.id,
    status: 'ACTIVE',
    stripeCustomerId: typeof session.customer === 'string' ? session.customer : existing?.stripeCustomerId ?? null,
    stripeSubscriptionId: stripeSubscriptionId || existing?.stripeSubscriptionId || null,
    currentPeriodStart,
    currentPeriodEnd,
    pastDueAt: null,
    cancelAtPeriodEnd: false,
    grantedById: null,
    grantedAt: null,
  });
  await appendEvent('CARE_PLAN_SUBSCRIBED', {
    source: 'stripe-webhook', entityType: 'CARE_SUBSCRIPTION', entityId: userId,
    details: { planKey: plan.key, stripeSubscriptionId },
  });
  reportBilling('CARE_PLAN_SUBSCRIBED', `Care Plan membership started — ${plan.name}`, { userId, planKey: plan.key, stripeSubscriptionId }, `care-plan:${userId}:subscribed:${stripeSubscriptionId || session.id}`);
}

async function onSubscriptionUpdated(sub) {
  const row = await getCareSubscriptionByStripeSubscriptionId(sub?.id);
  if (!row || row.status === 'OFFICE_GRANTED') return;
  const mapped = { active: 'ACTIVE', trialing: 'TRIALING', past_due: 'PAST_DUE', unpaid: 'PAST_DUE' }[sub.status] || null;
  const data = {};
  const start = sub.current_period_start || sub.items?.data?.[0]?.current_period_start;
  const end = sub.current_period_end || sub.items?.data?.[0]?.current_period_end;
  if (start) data.currentPeriodStart = new Date(start * 1000).toISOString();
  if (end) data.currentPeriodEnd = new Date(end * 1000).toISOString();
  if (typeof sub.cancel_at_period_end === 'boolean') data.cancelAtPeriodEnd = sub.cancel_at_period_end;
  if (mapped && mapped !== row.status) {
    data.status = mapped;
    if (mapped === 'PAST_DUE' && !row.pastDueAt) data.pastDueAt = new Date().toISOString();
    if (mapped === 'ACTIVE') data.pastDueAt = null;
  }
  if (Object.keys(data).length) await upsertCareSubscription(row.userId, data);
}

async function onSubscriptionDeleted(sub) {
  const row = await getCareSubscriptionByStripeSubscriptionId(sub?.id);
  if (!row) return;
  await upsertCareSubscription(row.userId, {
    status: 'NONE', planId: null, stripeSubscriptionId: null,
    currentPeriodStart: null, currentPeriodEnd: null,
    pastDueAt: null, cancelAtPeriodEnd: false,
    checkupBookedForPeriodEnd: null, checkupBookingRef: null,
  });
  await appendEvent('CARE_PLAN_SUBSCRIPTION_ENDED', {
    source: 'stripe-webhook', entityType: 'CARE_SUBSCRIPTION', entityId: row.userId,
    details: { stripeSubscriptionId: sub.id },
  });
  reportBilling('CARE_PLAN_SUBSCRIPTION_ENDED', 'Care Plan membership ended', { userId: row.userId }, `care-plan:${row.userId}:ended:${sub.id}`);
}

async function onInvoicePaymentFailed(invoice) {
  const stripeSubscriptionId = invoice?.subscription || invoice?.parent?.subscription_details?.subscription || null;
  const row = await getCareSubscriptionByStripeSubscriptionId(stripeSubscriptionId);
  if (!row) return;
  if (row.status === 'ACTIVE' || row.status === 'TRIALING') {
    await upsertCareSubscription(row.userId, { status: 'PAST_DUE', pastDueAt: new Date().toISOString() });
    await appendEvent('CARE_PLAN_PAYMENT_FAILED', {
      source: 'stripe-webhook', entityType: 'CARE_SUBSCRIPTION', entityId: row.userId,
      details: { stripeSubscriptionId },
    });
    reportBilling('CARE_PLAN_PAYMENT_FAILED', 'Care Plan payment failed — past due, grace window running', { userId: row.userId }, `care-plan:${row.userId}:pastdue:${stripeSubscriptionId}`);
  }
}

/**
 * Care-plan Stripe webhook handling. Returns true when the event was
 * a care-plan event. Never throws — billing noise must not break the
 * diagnostic payment webhook it shares the endpoint with.
 */
export async function handleStripeCarePlanEvent(event) {
  try {
    const object = event?.data?.object || {};
    if (event.type === 'checkout.session.completed' && object.metadata?.purpose === 'CARE_PLAN') {
      await activateFromCheckout(object);
      return true;
    }
    // Subscription/invoice events carry no purpose metadata on the
    // object itself; ownership is resolved by subscription id inside
    // each handler (an advertiser subscription id simply finds no
    // care row and returns).
    if (event.type === 'customer.subscription.updated') { await onSubscriptionUpdated(object); return true; }
    if (event.type === 'customer.subscription.deleted') { await onSubscriptionDeleted(object); return true; }
    if (event.type === 'invoice.payment_failed') { await onInvoicePaymentFailed(object); return true; }
    return false;
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', message: 'care plan webhook handling failed', error: String(error?.message || error) }));
    return false;
  }
}
