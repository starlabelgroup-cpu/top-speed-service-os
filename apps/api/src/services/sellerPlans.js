import { appendEvent } from '../data/store.js';
import { DATABASE_ENABLED, db } from '../db/client.js';
import { ROLES, STAFF_ROLES } from '../config/security.js';
import { getBillingSetting } from '../db/adPlansRepo.js';
import {
  getSellerPlanById, getSellerPlanByKey, getSellerSubscriptionByStripeSubscriptionId,
  getSellerSubscriptionByUserId, listSellerPlans, upsertSellerSubscription,
} from '../db/sellerPlansRepo.js';
import { emitReport } from './managementReports.js';
import { cancelStripeSubscription, retrieveStripeSubscription } from './stripe.js';

/**
 * Pepper Lists Seller Plans — access resolution + billing lifecycle
 * (2026-11-20). The mirror of services/adPlans.js (Flywheel
 * Advertiser Plans), applied to Pepper Lists sellers:
 *
 *  - NO INVENTED PRICES. Plans are structure; a price exists only
 *    because the owner set it in the seller-plans admin. This file
 *    never writes a price or a Stripe object.
 *  - FREE IS THE BASELINE. The Free tier's limits are exactly today's
 *    Pepper Lists behavior (4 photos per listing, no featured
 *    placement, no bumps), so a seller who never touches plans — and
 *    every grandfathered account — sees no change at all. Paid tiers
 *    only ADD: featured placement, bumps, more photos, analytics,
 *    the public storefront.
 *  - GRANDFATHERED BASELINE. Seller accounts that existed before
 *    plans launched — and office-issued accounts (signup source
 *    ACCESS_CONTROL) — keep the Free baseline as a GRANDFATHERED
 *    status, exactly like the advertiser plans' rule.
 *  - The owner (COMPANY_OWNER) and staff are NEVER plan-gated.
 *  - Billing lifecycle mirrors the advertiser plans: ACTIVE →
 *    PAST_DUE (failed invoice) → GRACE (inside the shared
 *    AdBillingSetting grace window, paid features continue) →
 *    SUSPENDED. One seller-appropriate difference: a SUSPENDED
 *    seller falls back to the Free baseline instead of read-only —
 *    selling at the free level is never taken away; only the paid
 *    features pause until the payment method is fixed.
 *  - GRACE/SUSPENDED are computed at read time from the stored
 *    PAST_DUE + pastDueAt, so the transition needs no cron.
 */

export const SELLER_PLAN_FEATURES = [
  { key: 'featured', label: 'Featured placement — Featured badge and top-of-grid sorting for your listings' },
  { key: 'bump', label: 'Listing bumps — refresh a listing back to the top on a monthly credit' },
  { key: 'analytics', label: 'Seller analytics — real views, comments and sales per listing' },
  { key: 'storefront', label: 'Public seller storefront — your listings and reviews on one page' },
];
export const SELLER_PLAN_FEATURE_KEYS = SELLER_PLAN_FEATURES.map((f) => f.key);

/** Today's Pepper Lists behavior — the baseline nobody loses. */
export const SELLER_BASELINE_FEATURES = { featured: false, bump: false, analytics: false, storefront: false };
export const SELLER_BASELINE_LIMITS = { maxPhotos: 4, bumpsPerMonth: 0, featuredListings: 0 };

/**
 * Accounts created before this instant predate the seller plans and
 * are grandfathered onto the Free baseline. 2026-11-20 05:00 UTC =
 * midnight EST on launch day.
 */
export const SELLER_PLANS_LAUNCH_CUTOFF = new Date('2026-11-20T05:00:00.000Z');

const BYPASS_ROLES = [...STAFF_ROLES, ROLES.MARKETING_MANAGER];

export function isSellerPlanBypass(roles) {
  return (roles || []).some((role) => BYPASS_ROLES.includes(role));
}

function noFeatures() {
  return Object.fromEntries(SELLER_PLAN_FEATURE_KEYS.map((key) => [key, false]));
}

function planFeatures(plan) {
  const out = noFeatures();
  for (const key of SELLER_PLAN_FEATURE_KEYS) out[key] = Boolean(plan?.features?.[key]);
  return out;
}

function planLimits(plan) {
  const limits = plan?.limits && typeof plan.limits === 'object' ? plan.limits : {};
  return {
    maxPhotos: 'maxPhotos' in limits ? limits.maxPhotos : SELLER_BASELINE_LIMITS.maxPhotos,
    bumpsPerMonth: 'bumpsPerMonth' in limits ? limits.bumpsPerMonth : 0,
    featuredListings: 'featuredListings' in limits ? limits.featuredListings : 0,
  };
}

export function sellerGrandfatherEligible(facts) {
  if (!facts) return false;
  if (facts.signupSource === 'ACCESS_CONTROL') return true;
  if (facts.createdAt && new Date(facts.createdAt) < SELLER_PLANS_LAUNCH_CUTOFF) return true;
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

/** Get the seller's subscription row, initializing it (grandfather check) on first sight. */
export async function ensureSellerSubscription(reqUser) {
  let row = await getSellerSubscriptionByUserId(reqUser.id);
  if (row) return row;
  let status = 'NONE';
  if (DATABASE_ENABLED) {
    const facts = await getUserFacts(reqUser.id);
    if (sellerGrandfatherEligible(facts)) status = 'GRANDFATHERED';
  }
  row = await upsertSellerSubscription(reqUser.id, { status });
  return row;
}

export function sellerEffectiveStatusOf(row, graceDays, now = new Date()) {
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
    features: Object.fromEntries(SELLER_PLAN_FEATURE_KEYS.map((key) => [key, true])),
    limits: { maxPhotos: null, bumpsPerMonth: null, featuredListings: null },
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    pendingPlanKey: null,
    pastDueAt: null,
  };
}

async function freePlan() {
  const plans = await listSellerPlans();
  return plans.find((p) => p.key === 'free') || null;
}

/**
 * Resolve a seller's effective plan access. Applies a scheduled
 * downgrade whose period has ended (lazy application — no cron).
 * Everyone resolves to at least the Free baseline: the free tier is
 * a real plan here, not a lockout.
 */
export async function resolveSellerAccess(reqUser, now = new Date()) {
  if (!reqUser?.id) return null;
  if (isSellerPlanBypass(reqUser.roles)) return bypassAccess(reqUser);
  const free = await freePlan();
  if (!DATABASE_ENABLED) {
    // Phase-1 skeleton (no database): no real accounts to gate —
    // the Free baseline, exactly like the pre-plans platform.
    return {
      userId: reqUser.id, bypass: false, status: 'NONE', effectiveStatus: 'GRANDFATHERED',
      plan: free, planKey: 'free',
      features: free ? planFeatures(free) : { ...SELLER_BASELINE_FEATURES },
      limits: free ? planLimits(free) : { ...SELLER_BASELINE_LIMITS },
      currentPeriodEnd: null, cancelAtPeriodEnd: false, pendingPlanKey: null, pastDueAt: null,
    };
  }

  const setting = await getBillingSetting();
  let row = await ensureSellerSubscription(reqUser);

  if (row.pendingPlanId && (!row.stripeSubscriptionId || (row.currentPeriodEnd && new Date(row.currentPeriodEnd) <= now))) {
    row = await upsertSellerSubscription(reqUser.id, {
      planId: row.pendingPlanId, pendingPlanId: null, pendingEffectiveAt: null, cancelAtPeriodEnd: false,
    });
  }

  const effectiveStatus = sellerEffectiveStatusOf(row, setting.graceDays, now);
  const plan = row.planId ? await getSellerPlanById(row.planId) : null;
  const pendingPlan = row.pendingPlanId ? await getSellerPlanById(row.pendingPlanId) : null;

  let effectivePlan = free;
  if (['ACTIVE', 'TRIALING', 'OFFICE_GRANTED', 'GRACE'].includes(effectiveStatus) && plan) {
    effectivePlan = plan;
  } else if (['ACTIVE', 'TRIALING', 'OFFICE_GRANTED', 'GRACE'].includes(effectiveStatus) && !plan) {
    // Paid/grant state whose plan row is gone — fall back to Free
    // rather than taking selling away from a paying seller.
    effectivePlan = free;
  }

  return {
    userId: reqUser.id,
    bypass: false,
    status: row.status,
    effectiveStatus,
    plan: effectivePlan,
    planKey: effectivePlan?.key ?? 'free',
    features: effectivePlan ? planFeatures(effectivePlan) : { ...SELLER_BASELINE_FEATURES },
    limits: effectivePlan ? planLimits(effectivePlan) : { ...SELLER_BASELINE_LIMITS },
    currentPeriodEnd: row.currentPeriodEnd,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    pendingPlanKey: pendingPlan?.key ?? null,
    pastDueAt: row.pastDueAt,
    subscription: row,
  };
}

export function sellerAccessHas(access, featureKey) {
  return Boolean(access?.features?.[featureKey]);
}

/**
 * Express gate for seller-plan feature endpoints. Denials are always
 * a clear upgrade message with the way out — never a bare error.
 */
export function requireSellerPlanFeature(featureKey) {
  return async (req, res, next) => {
    try {
      const access = await resolveSellerAccess(req.user);
      req.sellerPlanAccess = access;
      if (!access || access.bypass || sellerAccessHas(access, featureKey)) return next();
      const label = SELLER_PLAN_FEATURES.find((f) => f.key === featureKey)?.label || featureKey;
      return res.status(403).json({
        error: 'plan_upgrade_required',
        feature: featureKey,
        message: `Your current seller plan does not include: ${label}. Open Seller Plans in Pepper Lists to upgrade.`,
        upgradeUrl: '/pepper-lists-site',
      });
    } catch (error) {
      return next(error);
    }
  };
}

// ---------------------------------------------------------------------------
// Serializers
// ---------------------------------------------------------------------------

export function publicSellerPlan(plan) {
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

export function adminSellerPlan(plan) {
  return {
    ...publicSellerPlan(plan),
    id: plan.id,
    stripeProductId: plan.stripeProductId ?? null,
    stripePriceId: plan.stripePriceId ?? null,
    stripeSynced: Boolean(plan.stripePriceId),
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };
}

export function publicSellerAccess(access) {
  if (!access) return null;
  return {
    status: access.status,
    effectiveStatus: access.effectiveStatus,
    bypass: access.bypass,
    planKey: access.planKey,
    features: access.features,
    limits: access.limits,
    currentPeriodEnd: access.currentPeriodEnd,
    cancelAtPeriodEnd: access.cancelAtPeriodEnd,
    pendingPlanKey: access.pendingPlanKey,
    pastDueAt: access.pastDueAt,
  };
}

// ---------------------------------------------------------------------------
// Stripe webhook lifecycle (called from routes/payments.js AFTER the
// diagnostic handling and the advertiser-plan handler — it never
// throws, and it only claims events whose checkout metadata purpose
// is SELLER_PLAN or whose subscription id belongs to a seller row).
// ---------------------------------------------------------------------------

function reportBilling(type, title, detail, eventKey) {
  emitReport({ department: 'billing', type, title, detail, source: 'pepper-lists-seller-plans', reference: detail?.userId || null, eventKey });
}

async function activateFromCheckout(session) {
  const userId = session.metadata?.userId || session.client_reference_id;
  const plan = session.metadata?.planKey ? await getSellerPlanByKey(session.metadata.planKey) : null;
  if (!userId || !plan) return;
  const existing = await getSellerSubscriptionByUserId(userId);

  let currentPeriodEnd = null;
  const stripeSubscriptionId = typeof session.subscription === 'string' ? session.subscription : null;
  if (stripeSubscriptionId) {
    try {
      const sub = await retrieveStripeSubscription(stripeSubscriptionId);
      const end = sub?.current_period_end || sub?.items?.data?.[0]?.current_period_end;
      if (end) currentPeriodEnd = new Date(end * 1000).toISOString();
    } catch { /* best effort — subscription.updated keeps the period current */ }
    // An upgrade supersedes the old subscription: cancel it so the
    // seller is never double-billed (best effort).
    if (existing?.stripeSubscriptionId && existing.stripeSubscriptionId !== stripeSubscriptionId) {
      try { await cancelStripeSubscription(existing.stripeSubscriptionId); } catch { /* best effort */ }
    }
  }

  await upsertSellerSubscription(userId, {
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
  await appendEvent('SELLER_PLAN_SUBSCRIBED', {
    source: 'stripe-webhook', entityType: 'SELLER_SUBSCRIPTION', entityId: userId,
    details: { planKey: plan.key, stripeSubscriptionId },
  });
  reportBilling('SELLER_PLAN_SUBSCRIBED', `Seller plan started — ${plan.name}`, { userId, planKey: plan.key, stripeSubscriptionId }, `seller-plan:${userId}:subscribed:${stripeSubscriptionId || session.id}`);
}

async function onSubscriptionUpdated(sub) {
  const row = await getSellerSubscriptionByStripeSubscriptionId(sub?.id);
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
  if (Object.keys(data).length) await upsertSellerSubscription(row.userId, data);
}

async function onSubscriptionDeleted(sub) {
  const row = await getSellerSubscriptionByStripeSubscriptionId(sub?.id);
  if (!row) return;
  await upsertSellerSubscription(row.userId, {
    status: 'NONE', planId: null, stripeSubscriptionId: null, currentPeriodEnd: null,
    pastDueAt: null, pendingPlanId: null, pendingEffectiveAt: null, cancelAtPeriodEnd: false,
  });
  await appendEvent('SELLER_PLAN_SUBSCRIPTION_ENDED', {
    source: 'stripe-webhook', entityType: 'SELLER_SUBSCRIPTION', entityId: row.userId,
    details: { stripeSubscriptionId: sub.id },
  });
  reportBilling('SELLER_PLAN_SUBSCRIPTION_ENDED', 'Seller plan subscription ended', { userId: row.userId }, `seller-plan:${row.userId}:ended:${sub.id}`);
}

async function onInvoicePaymentFailed(invoice) {
  const stripeSubscriptionId = invoice?.subscription || invoice?.parent?.subscription_details?.subscription || null;
  const row = await getSellerSubscriptionByStripeSubscriptionId(stripeSubscriptionId);
  if (!row) return;
  if (row.status === 'ACTIVE' || row.status === 'TRIALING') {
    await upsertSellerSubscription(row.userId, { status: 'PAST_DUE', pastDueAt: new Date().toISOString() });
    await appendEvent('SELLER_PLAN_PAYMENT_FAILED', {
      source: 'stripe-webhook', entityType: 'SELLER_SUBSCRIPTION', entityId: row.userId,
      details: { stripeSubscriptionId },
    });
    reportBilling('SELLER_PLAN_PAYMENT_FAILED', 'Seller plan payment failed — past due, grace window running', { userId: row.userId }, `seller-plan:${row.userId}:pastdue:${stripeSubscriptionId}`);
  }
}

/**
 * Seller-plan Stripe webhook handling. Returns true when the event
 * was a seller-plan event. Never throws — billing noise must not
 * break the diagnostic payment webhook it shares the endpoint with.
 */
export async function handleStripeSellerPlanEvent(event) {
  try {
    const object = event?.data?.object || {};
    if (event.type === 'checkout.session.completed' && object.metadata?.purpose === 'SELLER_PLAN') {
      await activateFromCheckout(object);
      return true;
    }
    if (event.type === 'customer.subscription.updated') { await onSubscriptionUpdated(object); return true; }
    if (event.type === 'customer.subscription.deleted') { await onSubscriptionDeleted(object); return true; }
    if (event.type === 'invoice.payment_failed') { await onInvoicePaymentFailed(object); return true; }
    return false;
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', message: 'seller plan webhook handling failed', error: String(error?.message || error) }));
    return false;
  }
}
