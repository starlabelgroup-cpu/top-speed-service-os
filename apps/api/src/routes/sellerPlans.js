import { Router } from 'express';
import { z } from 'zod';
import { DATABASE_ENABLED, db } from '../db/client.js';
import { appendEvent } from '../data/store.js';
import {
  getSellerPlanByKey, getSellerSubscriptionByUserId, listSellerPlans, listSellerSubscriptions,
  updateSellerPlan, upsertSellerSubscription,
} from '../db/sellerPlansRepo.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import {
  createSellerPlanCheckout, createSellerStripeCustomer, createSellerStripeProduct,
  createStripePrice, stripeConfigured, updateStripeSubscription,
} from '../services/stripe.js';
import {
  SELLER_PLAN_FEATURES, adminSellerPlan, ensureSellerSubscription, publicSellerAccess,
  publicSellerPlan, resolveSellerAccess, sellerGrandfatherEligible,
} from '../services/sellerPlans.js';

/**
 * Pepper Lists Seller Plans (2026-11-20) — the seller twin of
 * routes/adPlans.js, same shape and same honesty rules:
 *
 * - GET    /pepper-lists/plans — the catalog + the caller's access
 *          (any signed-in Pepper Lists user; plans are open to
 *          every seller, not a staff surface).
 * - POST   /pepper-lists/plans/checkout — buy a priced plan through
 *          Stripe Checkout (subscription mode). An UNPRICED plan is
 *          refused with 422 pricing_not_set and Stripe is never
 *          called.
 * - POST   /pepper-lists/plans/change — upgrade = a fresh checkout
 *          (the webhook supersedes the old subscription); downgrade
 *          = scheduled for the end of the current period.
 * - POST   /pepper-lists/plans/cancel — cancel at period end; paid
 *          features run until the period closes.
 * - Owner admin (COMPANY_OWNER / PLATFORM_ADMIN only):
 *   GET    /pepper-lists/admin/plans, PATCH .../admin/plans/:key
 *          (name/description/visibility/features/limits — prices go
 *          through the price route so they always sync),
 *   POST   .../admin/plans/:key/price (creates the Stripe product +
 *          price and stores the ids; null unsets pricing),
 *   GET    /pepper-lists/admin/seller-subscriptions,
 *   POST   /pepper-lists/admin/seller-subscriptions/grant (office
 *          grant, no payment) and /revoke.
 *
 * The Stripe webhook (routes/payments.js) finalizes every state
 * change — services/sellerPlans.js handles checkout.session.completed
 * and the subscription/invoice lifecycle by metadata purpose
 * SELLER_PLAN and by known seller subscription ids.
 */
const router = Router();
const ownerOnly = [authenticate, requireRole('COMPANY_OWNER', 'PLATFORM_ADMIN')];

const ACTIVE_STATUSES = ['ACTIVE', 'TRIALING', 'OFFICE_GRANTED', 'GRACE'];

function planForSite(plan) {
  const view = publicSellerPlan(plan);
  return {
    key: view.key,
    name: view.name,
    tagline: view.description,
    description: view.description,
    active: view.isActive,
    isActive: view.isActive,
    price: view.monthlyPriceCents == null
      ? null
      : {
          amountCents: view.monthlyPriceCents,
          interval: 'month',
          formatted: `$${(view.monthlyPriceCents / 100).toLocaleString('en-US', { minimumFractionDigits: view.monthlyPriceCents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`,
        },
    features: SELLER_PLAN_FEATURES
      .filter((f) => view.features[f.key])
      .map((f) => ({ key: f.key, label: f.label })),
    limits: view.limits,
  };
}

function planForAdmin(plan) {
  const view = adminSellerPlan(plan);
  return {
    ...view,
    active: view.isActive,
    price: view.monthlyPriceCents == null
      ? null
      : { amountCents: view.monthlyPriceCents, interval: 'month' },
  };
}

function accessForSite(access) {
  if (!access) return null;
  const view = publicSellerAccess(access);
  return {
    ...view,
    grandfathered: access.status === 'GRANDFATHERED' || access.effectiveStatus === 'GRANDFATHERED',
    hasActiveSubscription: ACTIVE_STATUSES.includes(access.effectiveStatus)
      && Boolean(access.subscription?.stripeSubscriptionId),
  };
}

function pricingNotSet(res, plan) {
  return res.status(422).json({
    error: 'pricing_not_set',
    code: 'pricing_not_set',
    message: `Pricing for the ${plan.name} plan has not been set yet — check back soon, or ask us.`,
    planKey: plan.key,
  });
}

/* ------------------------------ catalog ------------------------------- */

router.get('/pepper-lists/plans', authenticate, async (req, res, next) => {
  try {
    const plans = await listSellerPlans();
    const access = await resolveSellerAccess(req.user);
    return res.json({
      data: {
        plans: plans.filter((p) => p.isActive).map(planForSite),
        access: accessForSite(access),
      },
    });
  } catch (error) {
    return next(error);
  }
});

/* ------------------------------ checkout ------------------------------ */

const planKeySchema = z.object({ planKey: z.string().trim().min(1).max(40) });

function checkoutUrls(req) {
  const origin = process.env.PEPPER_LISTS_PUBLIC_ORIGIN
    || (req.headers.origin && /^https?:\/\//.test(req.headers.origin) ? req.headers.origin : 'https://pepperlists.com');
  return {
    successUrl: `${origin}/#plSeller?plan=activated`,
    cancelUrl: `${origin}/#plSeller?plan=cancelled`,
  };
}

async function startCheckout(req, res, plan) {
  if (!stripeConfigured()) {
    return res.status(503).json({ error: 'payments_not_configured', message: 'Stripe is not configured on the API yet — checkout is unavailable.' });
  }
  // The owner's pricing discipline: an unpriced plan can never check
  // out. This return happens BEFORE any Stripe call.
  if (plan.monthlyPriceCents == null || !plan.stripePriceId) return pricingNotSet(res, plan);
  const row = await ensureSellerSubscription(req.user);
  let customerId = row.stripeCustomerId;
  if (!customerId) {
    const name = [req.user.firstName, req.user.lastName].filter(Boolean).join(' ') || undefined;
    const customer = await createSellerStripeCustomer({ email: req.user.email, name, userId: req.user.id });
    customerId = customer.id;
    await upsertSellerSubscription(req.user.id, { stripeCustomerId: customerId });
  }
  const { successUrl, cancelUrl } = checkoutUrls(req);
  const session = await createSellerPlanCheckout({
    customerId,
    priceId: plan.stripePriceId,
    userId: req.user.id,
    planKey: plan.key,
    successUrl,
    cancelUrl,
  });
  return res.status(201).json({ data: { checkoutUrl: session.url, url: session.url, sessionId: session.id, action: 'checkout' } });
}

router.post('/pepper-lists/plans/checkout', authenticate, async (req, res, next) => {
  try {
    const parsed = planKeySchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid plan selection' });
    const plan = await getSellerPlanByKey(parsed.data.planKey);
    if (!plan || !plan.isActive) return res.status(404).json({ error: 'Plan not found' });
    if (plan.key === 'free') return res.status(400).json({ error: 'free_plan', message: 'The Free plan needs no checkout — it is already yours.' });
    const access = await resolveSellerAccess(req.user);
    if (access?.bypass) return res.status(409).json({ error: 'plan_not_needed', message: 'Staff accounts already have every seller feature — no plan needed.' });
    if (access?.planKey === plan.key && ACTIVE_STATUSES.includes(access.effectiveStatus)) {
      return res.status(422).json({ error: 'already_on_plan', message: `You are already on the ${plan.name} plan.` });
    }
    return await startCheckout(req, res, plan);
  } catch (error) {
    if (error?.code === 'stripe_error') return res.status(502).json({ error: 'stripe_error', message: error.message });
    return next(error);
  }
});

router.post('/pepper-lists/plans/change', authenticate, async (req, res, next) => {
  try {
    const parsed = planKeySchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid plan selection' });
    const target = await getSellerPlanByKey(parsed.data.planKey);
    if (!target || !target.isActive) return res.status(404).json({ error: 'Plan not found' });
    if (target.key === 'free') {
      return res.status(400).json({ error: 'use_cancel', message: 'To move back to Free, cancel instead — paid features run to the end of the paid period.' });
    }
    const access = await resolveSellerAccess(req.user);
    if (access?.bypass) return res.status(409).json({ error: 'plan_not_needed', message: 'Staff accounts already have every seller feature — no plan needed.' });
    if (access?.planKey === target.key && ACTIVE_STATUSES.includes(access.effectiveStatus)) {
      return res.status(422).json({ error: 'already_on_plan', message: `You are already on the ${target.name} plan.` });
    }
    // No current paid/grant plan → changing means subscribing.
    if (!access || !ACTIVE_STATUSES.includes(access.effectiveStatus) || !access.plan || access.plan.key === 'free') {
      return await startCheckout(req, res, target);
    }
    if (target.monthlyPriceCents == null) return pricingNotSet(res, target);
    const currentPrice = access.plan.monthlyPriceCents ?? 0;
    if (target.monthlyPriceCents > currentPrice) {
      // Upgrade: checkout now; the webhook activates the new plan and
      // supersedes the old Stripe subscription.
      return await startCheckout(req, res, target);
    }
    // Downgrade: takes effect at the end of the current period.
    const row = await ensureSellerSubscription(req.user);
    await upsertSellerSubscription(req.user.id, {
      pendingPlanId: target.id,
      pendingEffectiveAt: row.currentPeriodEnd || new Date().toISOString(),
    });
    return res.json({
      data: {
        action: 'scheduled',
        planKey: target.key,
        effectiveAt: row.currentPeriodEnd || new Date().toISOString(),
        message: `Your plan changes to ${target.name} at the end of the current billing period. Nothing is charged or refunded today.`,
      },
    });
  } catch (error) {
    if (error?.code === 'stripe_error') return res.status(502).json({ error: 'stripe_error', message: error.message });
    return next(error);
  }
});

router.post('/pepper-lists/plans/cancel', authenticate, async (req, res, next) => {
  try {
    const row = await ensureSellerSubscription(req.user);
    if (row.stripeSubscriptionId) {
      if (!stripeConfigured()) {
        return res.status(503).json({ error: 'payments_not_configured', message: 'Stripe is not configured on the API yet — cancellation is unavailable.' });
      }
      await updateStripeSubscription(row.stripeSubscriptionId, { cancel_at_period_end: true });
      const updated = await upsertSellerSubscription(req.user.id, { cancelAtPeriodEnd: true });
      return res.json({
        data: {
          action: 'cancel_at_period_end',
          effectiveAt: updated.currentPeriodEnd,
          message: 'Your plan stays active until the end of the current billing period, then ends. Free selling never goes away.',
        },
      });
    }
    if (row.status === 'OFFICE_GRANTED') {
      await upsertSellerSubscription(req.user.id, { status: 'NONE', planId: null, grantedById: null, grantedAt: null });
      return res.json({ data: { action: 'ended', message: 'Your office-granted plan has been ended.' } });
    }
    return res.status(422).json({ error: 'no_active_subscription', message: 'There is no active seller plan subscription to cancel.' });
  } catch (error) {
    if (error?.code === 'stripe_error') return res.status(502).json({ error: 'stripe_error', message: error.message });
    return next(error);
  }
});

/* ---------------------------- owner admin ----------------------------- */

router.get('/pepper-lists/admin/plans', ...ownerOnly, async (req, res, next) => {
  try {
    const plans = await listSellerPlans();
    return res.json({ data: plans.map(planForAdmin) });
  } catch (error) {
    return next(error);
  }
});

const patchPlanSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  description: z.string().trim().max(400).nullable().optional(),
  tagline: z.string().trim().max(400).nullable().optional(),
  isActive: z.boolean().optional(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(100).optional(),
  features: z.record(z.string(), z.boolean()).optional(),
  limits: z.record(z.string(), z.number().int().min(0).nullable()).optional(),
});

router.patch('/pepper-lists/admin/plans/:key', ...ownerOnly, async (req, res, next) => {
  try {
    const plan = await getSellerPlanByKey(req.params.key);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    const parsed = patchPlanSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid plan update', details: parsed.error.flatten() });
    const data = {};
    if (parsed.data.name !== undefined) data.name = parsed.data.name;
    if (parsed.data.description !== undefined) data.description = parsed.data.description;
    if (parsed.data.tagline !== undefined) data.description = parsed.data.tagline;
    if (parsed.data.isActive !== undefined) data.isActive = parsed.data.isActive;
    if (parsed.data.active !== undefined) data.isActive = parsed.data.active;
    if (parsed.data.sortOrder !== undefined) data.sortOrder = parsed.data.sortOrder;
    if (parsed.data.features) {
      const known = SELLER_PLAN_FEATURES.map((f) => f.key);
      for (const key of Object.keys(parsed.data.features)) {
        if (!known.includes(key)) return res.status(400).json({ error: `Unknown feature key: ${key}`, featureKeys: known });
      }
      data.features = { ...plan.features, ...parsed.data.features };
    }
    if (parsed.data.limits) {
      const known = ['maxPhotos', 'bumpsPerMonth', 'featuredListings'];
      for (const key of Object.keys(parsed.data.limits)) {
        if (!known.includes(key)) return res.status(400).json({ error: `Unknown limit key: ${key}`, limitKeys: known });
      }
      data.limits = { ...plan.limits, ...parsed.data.limits };
    }
    const updated = await updateSellerPlan(plan.id, data);
    await appendEvent('SELLER_PLAN_UPDATED', {
      source: 'pepper-lists', actor: req.user.email || 'owner', entityType: 'SELLER_PLAN', entityId: plan.id,
      referenceCode: plan.key, details: { planKey: plan.key, fields: Object.keys(data) },
    });
    return res.json({ data: planForAdmin(updated) });
  } catch (error) {
    return next(error);
  }
});

const priceSchema = z.object({
  amountCents: z.number().int().min(100).max(1000000).nullable().optional(),
  monthlyPriceCents: z.number().int().min(100).max(1000000).nullable().optional(),
});

router.post('/pepper-lists/admin/plans/:key/price', ...ownerOnly, async (req, res, next) => {
  try {
    const plan = await getSellerPlanByKey(req.params.key);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    if (plan.key === 'free') return res.status(400).json({ error: 'free_plan', message: 'The Free plan stays $0 — it is never priced.' });
    const parsed = priceSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'A monthly price of at least 100 cents is required, or null to unset pricing' });
    }
    const amount = parsed.data.amountCents ?? parsed.data.monthlyPriceCents;
    if (amount === undefined) return res.status(400).json({ error: 'A monthly price is required, or null to unset pricing' });
    if (amount === null) {
      const updated = await updateSellerPlan(plan.id, { monthlyPriceCents: null, stripePriceId: null });
      await appendEvent('SELLER_PLAN_PRICE_UNSET', {
        source: 'pepper-lists', actor: req.user.email || 'owner', entityType: 'SELLER_PLAN', entityId: plan.id,
        referenceCode: plan.key, details: { planKey: plan.key },
      });
      return res.json({ data: planForAdmin(updated) });
    }
    if (!stripeConfigured()) {
      return res.status(503).json({ error: 'stripe_not_configured', message: 'Stripe is not configured on the API — the price was not saved.' });
    }
    // Sync to Stripe with the OWNER'S amount — the only place in the
    // system where a Stripe Product/Price for a seller plan is ever
    // created.
    let productId = plan.stripeProductId;
    if (!productId) {
      const product = await createSellerStripeProduct({ name: `Pepper Lists — ${plan.name} plan`, planKey: plan.key });
      productId = product.id;
      await updateSellerPlan(plan.id, { stripeProductId: productId });
    }
    const price = await createStripePrice({ productId, amountCents: amount, currency: plan.currency || 'usd' });
    const updated = await updateSellerPlan(plan.id, { monthlyPriceCents: amount, stripePriceId: price.id, stripeProductId: productId });
    await appendEvent('SELLER_PLAN_PRICE_SET', {
      source: 'pepper-lists', actor: req.user.email || 'owner', entityType: 'SELLER_PLAN', entityId: plan.id,
      referenceCode: plan.key, details: { planKey: plan.key, monthlyPriceCents: amount, stripePriceId: price.id },
    });
    return res.json({ data: planForAdmin(updated) });
  } catch (error) {
    if (error?.code === 'stripe_error') return res.status(502).json({ error: 'stripe_error', message: error.message });
    return next(error);
  }
});

router.get('/pepper-lists/admin/seller-subscriptions', ...ownerOnly, async (req, res, next) => {
  try {
    const rows = await listSellerSubscriptions();
    const plans = await listSellerPlans();
    const byId = new Map(plans.map((p) => [p.id, p]));
    const data = [];
    for (const row of rows) {
      const access = await resolveSellerAccess({ id: row.userId, roles: row.user?.roles || [] });
      const plan = row.planId ? byId.get(row.planId) : null;
      data.push({
        userId: row.userId,
        user: row.user || null,
        planKey: plan?.key ?? access?.planKey ?? null,
        planName: plan?.name ?? null,
        status: row.status,
        effectiveStatus: access?.effectiveStatus ?? row.status,
        grandfathered: row.status === 'GRANDFATHERED',
        currentPeriodEnd: row.currentPeriodEnd,
        pastDueAt: row.pastDueAt,
        cancelAtPeriodEnd: row.cancelAtPeriodEnd,
        grantedById: row.grantedById,
        grantedAt: row.grantedAt,
        hasStripeCustomer: Boolean(row.stripeCustomerId),
        hasStripeSubscription: Boolean(row.stripeSubscriptionId),
        updatedAt: row.updatedAt,
      });
    }
    return res.json({ data });
  } catch (error) {
    return next(error);
  }
});

const grantSchema = z.object({
  userId: z.string().min(1),
  planKey: z.string().trim().min(1).max(40),
});

router.post('/pepper-lists/admin/seller-subscriptions/grant', ...ownerOnly, async (req, res, next) => {
  try {
    const parsed = grantSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'A user id and plan key are required' });
    const plan = await getSellerPlanByKey(parsed.data.planKey);
    if (!plan || !plan.isActive) return res.status(404).json({ error: 'Plan not found' });
    if (DATABASE_ENABLED) {
      const target = await db().user.findUnique({ where: { id: parsed.data.userId }, select: { id: true } });
      if (!target) return res.status(404).json({ error: 'Seller account not found' });
    }
    const row = await upsertSellerSubscription(parsed.data.userId, {
      status: 'OFFICE_GRANTED',
      planId: plan.id,
      grantedById: req.user.id,
      grantedAt: new Date().toISOString(),
      pastDueAt: null,
      pendingPlanId: null,
      pendingEffectiveAt: null,
      cancelAtPeriodEnd: false,
    });
    await appendEvent('SELLER_PLAN_OFFICE_GRANTED', {
      source: 'pepper-lists', actor: req.user.email || 'owner', entityType: 'SELLER_SUBSCRIPTION', entityId: parsed.data.userId,
      referenceCode: plan.key, details: { planKey: plan.key },
    });
    return res.status(201).json({ data: { userId: row.userId, status: row.status, planKey: plan.key, grantedAt: row.grantedAt } });
  } catch (error) {
    return next(error);
  }
});

const revokeSchema = z.object({ userId: z.string().min(1) });

router.post('/pepper-lists/admin/seller-subscriptions/revoke', ...ownerOnly, async (req, res, next) => {
  try {
    const parsed = revokeSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'A user id is required' });
    const existing = await getSellerSubscriptionByUserId(parsed.data.userId);
    if (!existing) return res.status(404).json({ error: 'No seller subscription on file for that user' });
    let fallback = 'NONE';
    if (DATABASE_ENABLED) {
      const target = await db().user.findUnique({
        where: { id: parsed.data.userId },
        select: { createdAt: true, signupSource: true },
      });
      if (target && sellerGrandfatherEligible(target)) fallback = 'GRANDFATHERED';
    }
    const row = await upsertSellerSubscription(parsed.data.userId, {
      status: fallback, planId: null, grantedById: null, grantedAt: null,
      pendingPlanId: null, pendingEffectiveAt: null,
    });
    await appendEvent('SELLER_PLAN_OFFICE_REVOKED', {
      source: 'pepper-lists', actor: req.user.email || 'owner', entityType: 'SELLER_SUBSCRIPTION', entityId: parsed.data.userId,
      details: { fallbackStatus: fallback },
    });
    return res.json({ data: { userId: row.userId, status: row.status } });
  } catch (error) {
    return next(error);
  }
});

export default router;
