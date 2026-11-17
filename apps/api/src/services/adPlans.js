import { appendEvent } from '../data/store.js';
import { DATABASE_ENABLED, db } from '../db/client.js';
import { ROLES, STAFF_ROLES } from '../config/security.js';
import {
  getBillingSetting, getPlanById, getPlanByKey, getSubscriptionByStripeSubscriptionId,
  getSubscriptionByUserId, upsertSubscription,
} from '../db/adPlansRepo.js';
import { emitReport } from './managementReports.js';
import { cancelStripeSubscription, retrieveStripeSubscription } from './stripe.js';

/**
 * Flywheel Advertiser Plans — access resolution + billing lifecycle
 * (2026-11-17).
 *
 * The rules Ramone's plan system runs on:
 *  - NO INVENTED PRICES. Plans are structure; a price exists only
 *    because the owner set it in Ad Studio. This file never writes a
 *    price or a Stripe object.
 *  - GRANDFATHERED BASELINE. Advertiser accounts that existed before
 *    plans launched — and office-issued accounts (Work Time, signup
 *    source ACCESS_CONTROL), whose access the office manages — keep
 *    exactly the access they have today: unlimited campaigns on the
 *    display network. Plan gating applies to new signups and to
 *    features above that baseline.
 *  - The owner (COMPANY_OWNER) and staff are NEVER plan-gated.
 *  - Billing lifecycle: ACTIVE → PAST_DUE (failed invoice) → GRACE
 *    (inside the owner-configured grace window, access continues) →
 *    SUSPENDED (read-only). GRACE/SUSPENDED are computed at read time
 *    from the stored PAST_DUE + pastDueAt, so the transition needs no
 *    cron and drills can time-travel by moving pastDueAt.
 */

export const PLAN_FEATURES = [
  { key: 'campaigns', label: 'Campaigns — create, edit & submit for approval' },
  { key: 'display', label: 'Display placements — the mini banner network' },
  { key: 'streaming', label: 'Streaming Ads channel' },
  { key: 'aiDrafter', label: 'AI copy drafter — Speedy drafts, you approve' },
  { key: 'attribution', label: 'Attribution view — which ads bring bookings' },
  { key: 'loopView', label: 'Flywheel loop view' },
  { key: 'creativePicker', label: 'Creative picker — the house creative library' },
];
export const PLAN_FEATURE_KEYS = PLAN_FEATURES.map((f) => f.key);
export const PLAN_CHANNELS = ['DISPLAY', 'STREAMING'];

/** The grandfathered baseline: exactly the access advertisers have today. */
export const BASELINE_FEATURES = {
  campaigns: true, display: true, streaming: false,
  aiDrafter: false, attribution: false, loopView: false, creativePicker: false,
};
export const BASELINE_LIMITS = { maxCampaigns: null, channels: ['DISPLAY'] };

/**
 * Accounts created before this instant predate the plans system and
 * are grandfathered. 2026-11-17 05:00 UTC = midnight EST on launch
 * day — every advertiser account that existed when Ramone directed
 * the build (the console launched 2026-11-16) predates it.
 */
export const PLANS_LAUNCH_CUTOFF = new Date('2026-11-17T05:00:00.000Z');

const BYPASS_ROLES = [...STAFF_ROLES, ROLES.MARKETING_MANAGER];

export function isPlanBypass(roles) {
  return (roles || []).some((role) => BYPASS_ROLES.includes(role));
}

function noFeatures() {
  return Object.fromEntries(PLAN_FEATURE_KEYS.map((key) => [key, false]));
}

function planFeatures(plan) {
  const out = noFeatures();
  for (const key of PLAN_FEATURE_KEYS) out[key] = Boolean(plan?.features?.[key]);
  return out;
}

function planLimits(plan) {
  const limits = plan?.limits && typeof plan.limits === 'object' ? plan.limits : {};
  return {
    maxCampaigns: 'maxCampaigns' in limits ? limits.maxCampaigns : null,
    channels: Array.isArray(limits.channels) ? limits.channels : ['DISPLAY'],
  };
}

export function grandfatherEligible(facts) {
  if (!facts) return false;
  if (facts.signupSource === 'ACCESS_CONTROL') return true;
  if (facts.createdAt && new Date(facts.createdAt) < PLANS_LAUNCH_CUTOFF) return true;
  return false;
}

async function getUserFacts(userId) {
  if (!DATABASE_ENABLED || !userId) return null;
  try {
    return await db().user.findUnique({
      where: { id: userId },
      select: { createdAt: true, signupSource: true, roles: true, email: true },
    });
  } catch {
    return null;
  }
}

/** Get the advertiser's subscription row, initializing it (grandfather check) on first sight. */
export async function ensureSubscription(reqUser) {
  let row = await getSubscriptionByUserId(reqUser.id);
  if (row) return row;
  let status = 'NONE';
  if (DATABASE_ENABLED) {
    const facts = await getUserFacts(reqUser.id);
    if (grandfatherEligible(facts)) status = 'GRANDFATHERED';
  }
  row = await upsertSubscription(reqUser.id, { status });
  return row;
}

export function effectiveStatusOf(row, graceDays, now = new Date()) {
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
    readOnly: false,
    plan: null,
    planKey: null,
    features: Object.fromEntries(PLAN_FEATURE_KEYS.map((key) => [key, true])),
    maxCampaigns: null,
    channels: [...PLAN_CHANNELS],
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    pendingPlanKey: null,
    pastDueAt: null,
  };
}

/**
 * Resolve an account's effective plan access. Applies a scheduled
 * downgrade whose period has ended (lazy application — no cron).
 */
export async function resolveAccess(reqUser, now = new Date()) {
  if (!reqUser?.id) return null;
  if (isPlanBypass(reqUser.roles)) return bypassAccess(reqUser);
  if (!DATABASE_ENABLED) {
    // Phase-1 skeleton (no database): there are no real accounts to
    // gate — baseline access, exactly like the pre-plans platform.
    return {
      userId: reqUser.id, bypass: false, status: 'NONE', effectiveStatus: 'GRANDFATHERED',
      readOnly: false, plan: null, planKey: null,
      features: { ...BASELINE_FEATURES }, maxCampaigns: BASELINE_LIMITS.maxCampaigns,
      channels: [...BASELINE_LIMITS.channels],
      currentPeriodEnd: null, cancelAtPeriodEnd: false, pendingPlanKey: null, pastDueAt: null,
    };
  }

  const setting = await getBillingSetting();
  let row = await ensureSubscription(reqUser);

  if (row.pendingPlanId && (!row.stripeSubscriptionId || (row.currentPeriodEnd && new Date(row.currentPeriodEnd) <= now))) {
    row = await upsertSubscription(reqUser.id, {
      planId: row.pendingPlanId, pendingPlanId: null, pendingEffectiveAt: null, cancelAtPeriodEnd: false,
    });
  }

  const effectiveStatus = effectiveStatusOf(row, setting.graceDays, now);
  const plan = row.planId ? await getPlanById(row.planId) : null;
  const pendingPlan = row.pendingPlanId ? await getPlanById(row.pendingPlanId) : null;

  let features;
  let limits;
  let readOnly = false;
  if (['ACTIVE', 'TRIALING', 'OFFICE_GRANTED', 'GRACE'].includes(effectiveStatus) && plan) {
    features = planFeatures(plan);
    limits = planLimits(plan);
  } else if (effectiveStatus === 'GRANDFATHERED') {
    features = { ...BASELINE_FEATURES };
    limits = { ...BASELINE_LIMITS };
  } else if (['ACTIVE', 'TRIALING', 'OFFICE_GRANTED', 'GRACE'].includes(effectiveStatus)) {
    // Paid/grant state whose plan row is gone (deleted plan) — fall
    // back to the baseline rather than locking a paying advertiser out.
    features = { ...BASELINE_FEATURES };
    limits = { ...BASELINE_LIMITS };
  } else {
    features = noFeatures();
    limits = { maxCampaigns: 0, channels: [] };
    readOnly = true;
  }

  return {
    userId: reqUser.id,
    bypass: false,
    status: row.status,
    effectiveStatus,
    readOnly,
    plan,
    planKey: plan?.key ?? null,
    features,
    maxCampaigns: limits.maxCampaigns,
    channels: limits.channels,
    currentPeriodEnd: row.currentPeriodEnd,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    pendingPlanKey: pendingPlan?.key ?? null,
    pastDueAt: row.pastDueAt,
    subscription: row,
  };
}

export function accessHas(access, featureKey) {
  return Boolean(access?.features?.[featureKey]);
}

/**
 * Express gate for advertiser feature endpoints. Denials are always a
 * clear upgrade message with the way out — never a bare error.
 */
export function requirePlanFeature(featureKey) {
  return async (req, res, next) => {
    try {
      const access = await resolveAccess(req.user);
      req.planAccess = access;
      if (!access || access.bypass || accessHas(access, featureKey)) return next();
      const label = PLAN_FEATURES.find((f) => f.key === featureKey)?.label || featureKey;
      return res.status(403).json({
        error: 'plan_upgrade_required',
        feature: featureKey,
        message: access.readOnly
          ? `Your advertiser account is on the read-only baseline right now — ${label} needs a Flywheel plan. Open Plans & Billing in the Advertiser Console to pick one.`
          : `Your current Flywheel plan does not include: ${label}. Open Plans & Billing in the Advertiser Console to upgrade.`,
        upgradeUrl: '/advertiser',
      });
    } catch (error) {
      return next(error);
    }
  };
}

// ---------------------------------------------------------------------------
// Serializers
// ---------------------------------------------------------------------------

export function publicPlan(plan) {
  return {
    key: plan.key,
    name: plan.name,
    description: plan.description ?? null,
    monthlyPriceCents: plan.monthlyPriceCents ?? null,
    currency: plan.currency || 'usd',
    priced: plan.monthlyPriceCents != null,
    features: planFeatures(plan),
    limits: planLimits(plan),
    isActive: plan.isActive !== false,
    sortOrder: plan.sortOrder ?? 0,
  };
}

export function adminPlan(plan) {
  return {
    ...publicPlan(plan),
    id: plan.id,
    stripeProductId: plan.stripeProductId ?? null,
    stripePriceId: plan.stripePriceId ?? null,
    stripeSynced: Boolean(plan.stripePriceId),
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };
}

export function publicAccess(access) {
  if (!access) return null;
  return {
    status: access.status,
    effectiveStatus: access.effectiveStatus,
    readOnly: access.readOnly,
    bypass: access.bypass,
    planKey: access.planKey,
    features: access.features,
    maxCampaigns: access.maxCampaigns,
    channels: access.channels,
    currentPeriodEnd: access.currentPeriodEnd,
    cancelAtPeriodEnd: access.cancelAtPeriodEnd,
    pendingPlanKey: access.pendingPlanKey,
    pastDueAt: access.pastDueAt,
  };
}

// ---------------------------------------------------------------------------
// Stripe webhook lifecycle (called from routes/payments.js — the
// diagnostic handling there is untouched and runs first).
// ---------------------------------------------------------------------------

function reportBilling(type, title, detail, eventKey) {
  emitReport({ department: 'billing', type, title, detail, source: 'flywheel-plans', reference: detail?.userId || null, eventKey });
}

async function activateFromCheckout(session) {
  const userId = session.metadata?.userId || session.client_reference_id;
  const plan = session.metadata?.planKey ? await getPlanByKey(session.metadata.planKey) : null;
  if (!userId || !plan) return;
  const existing = await getSubscriptionByUserId(userId);

  let currentPeriodEnd = null;
  const stripeSubscriptionId = typeof session.subscription === 'string' ? session.subscription : null;
  if (stripeSubscriptionId) {
    try {
      const sub = await retrieveStripeSubscription(stripeSubscriptionId);
      const end = sub?.current_period_end || sub?.items?.data?.[0]?.current_period_end;
      if (end) currentPeriodEnd = new Date(end * 1000).toISOString();
    } catch { /* best effort — subscription.updated keeps the period current */ }
    // An upgrade supersedes the old subscription: cancel it so the
    // advertiser is never double-billed (best effort).
    if (existing?.stripeSubscriptionId && existing.stripeSubscriptionId !== stripeSubscriptionId) {
      try { await cancelStripeSubscription(existing.stripeSubscriptionId); } catch { /* best effort */ }
    }
  }

  await upsertSubscription(userId, {
    planId: plan.id,
    status: 'ACTIVE',
    stripeCustomerId: typeof session.customer === 'string' ? session.customer : existing?.stripeCustomerId ?? null,
    stripeSubscriptionId: stripeSubscriptionId || existing?.stripeSubscriptionId || null,
    currentPeriodEnd,
    pastDueAt: null,
    pendingPlanId: null,
    pendingEffectiveAt: null,
    cancelAtPeriodEnd: false,
    grantedById: null,
    grantedAt: null,
  });
  appendEvent('AD_PLAN_SUBSCRIBED', {
    source: 'stripe-webhook', entityType: 'ADVERTISER_SUBSCRIPTION', entityId: userId,
    details: { planKey: plan.key, stripeSubscriptionId },
  });
  reportBilling('AD_PLAN_SUBSCRIBED', `Advertiser plan started — ${plan.name}`, { userId, planKey: plan.key, stripeSubscriptionId }, `ad-plan:${userId}:subscribed:${stripeSubscriptionId || session.id}`);
}

async function onSubscriptionUpdated(sub) {
  const row = await getSubscriptionByStripeSubscriptionId(sub?.id);
  if (!row || row.status === 'OFFICE_GRANTED') return;
  const mapped = { active: 'ACTIVE', trialing: 'TRIALING', past_due: 'PAST_DUE', unpaid: 'PAST_DUE' }[sub.status] || null;
  const data = {};
  const end = sub.current_period_end || sub.items?.data?.[0]?.current_period_end;
  if (end) data.currentPeriodEnd = new Date(end * 1000).toISOString();
  if (typeof sub.cancel_at_period_end === 'boolean') data.cancelAtPeriodEnd = sub.cancel_at_period_end;
  if (mapped && mapped !== row.status) {
    data.status = mapped;
    if (mapped === 'PAST_DUE' && !row.pastDueAt) data.pastDueAt = new Date().toISOString();
    if (mapped === 'ACTIVE') data.pastDueAt = null;
  }
  if (Object.keys(data).length) await upsertSubscription(row.userId, data);
}

async function onSubscriptionDeleted(sub) {
  const row = await getSubscriptionByStripeSubscriptionId(sub?.id);
  if (!row) return;
  await upsertSubscription(row.userId, {
    status: 'NONE', planId: null, stripeSubscriptionId: null, currentPeriodEnd: null,
    pastDueAt: null, pendingPlanId: null, pendingEffectiveAt: null, cancelAtPeriodEnd: false,
  });
  appendEvent('AD_PLAN_SUBSCRIPTION_ENDED', {
    source: 'stripe-webhook', entityType: 'ADVERTISER_SUBSCRIPTION', entityId: row.userId,
    details: { stripeSubscriptionId: sub.id },
  });
  reportBilling('AD_PLAN_SUBSCRIPTION_ENDED', 'Advertiser plan subscription ended', { userId: row.userId }, `ad-plan:${row.userId}:ended:${sub.id}`);
}

async function onInvoicePaymentFailed(invoice) {
  const stripeSubscriptionId = invoice?.subscription || invoice?.parent?.subscription_details?.subscription || null;
  const row = await getSubscriptionByStripeSubscriptionId(stripeSubscriptionId);
  if (!row) return;
  if (row.status === 'ACTIVE' || row.status === 'TRIALING') {
    await upsertSubscription(row.userId, { status: 'PAST_DUE', pastDueAt: new Date().toISOString() });
    appendEvent('AD_PLAN_PAYMENT_FAILED', {
      source: 'stripe-webhook', entityType: 'ADVERTISER_SUBSCRIPTION', entityId: row.userId,
      details: { stripeSubscriptionId },
    });
    reportBilling('AD_PLAN_PAYMENT_FAILED', 'Advertiser plan payment failed — past due, grace window running', { userId: row.userId }, `ad-plan:${row.userId}:pastdue:${stripeSubscriptionId}`);
  }
}

/**
 * Plan-side Stripe webhook handling. Returns true when the event was
 * a plan event. Never throws — billing noise must not break the
 * diagnostic payment webhook it shares the endpoint with.
 */
export async function handleStripePlanEvent(event) {
  try {
    const object = event?.data?.object || {};
    if (event.type === 'checkout.session.completed' && object.metadata?.purpose === 'AD_PLAN') {
      await activateFromCheckout(object);
      return true;
    }
    if (event.type === 'customer.subscription.updated') { await onSubscriptionUpdated(object); return true; }
    if (event.type === 'customer.subscription.deleted') { await onSubscriptionDeleted(object); return true; }
    if (event.type === 'invoice.payment_failed') { await onInvoicePaymentFailed(object); return true; }
    return false;
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', message: 'ad plan webhook handling failed', error: String(error?.message || error) }));
    return false;
  }
}
