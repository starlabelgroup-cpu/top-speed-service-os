import { Router } from 'express';
import { z } from 'zod';
import { appendEvent } from '../data/store.js';
import { DATABASE_ENABLED, db } from '../db/client.js';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { MARKETING_ROLES, ROLES, STAFF_ROLES } from '../config/security.js';
import {
  getBillingSetting, getPlanById, getPlanByKey, listPlans, listSubscriptions,
  updateBillingSetting, updatePlan, upsertSubscription,
} from '../db/adPlansRepo.js';
import {
  PLAN_CHANNELS, PLAN_FEATURES, PLAN_FEATURE_KEYS, adminPlan, effectiveStatusOf, ensureSubscription,
  grandfatherEligible, publicAccess, publicPlan, resolveAccess,
} from '../services/adPlans.js';
import { emitReport } from '../services/managementReports.js';
import {
  createPlanCheckout, createStripeCustomer, createStripePrice, createStripeProduct,
  stripeConfigured, updateStripeSubscription,
} from '../services/stripe.js';

/**
 * Flywheel Advertiser Plans — routes (2026-11-17).
 *
 * Advertiser side (Advertiser Console → Plans & Billing):
 *   GET  /advertiser/plans           catalog + my effective access
 *   POST /advertiser/plans/checkout  Stripe subscription checkout
 *   POST /advertiser/plans/change    upgrade (checkout) / downgrade (period end)
 *   POST /advertiser/plans/cancel    cancel at period end
 *
 * Owner side (Ad Studio → Advertiser plans):
 *   GET   /ad-studio/plans                 plans + billing settings
 *   PATCH /ad-studio/plans/settings        grace window (owner)
 *   PATCH /ad-studio/plans/:key            structure edits (owner)
 *   POST  /ad-studio/plans/:key/price      set price → Stripe sync (owner)
 *   GET   /ad-studio/subscriptions         every advertiser's plan state
 *   POST  /ad-studio/subscriptions/:userId/grant   office grant (owner, audited)
 *   POST  /ad-studio/subscriptions/:userId/revoke  revoke grant (owner, audited)
 *
 * Prices are ONLY ever written by the owner's price route below —
 * with the owner's amount, synced to Stripe at that moment. An
 * unpriced plan refuses checkout with an honest pricing_not_set.
 */
const router = Router();

const APP_BASE = process.env.PUBLIC_WEB_BASE || 'https://topspeedserviceos.com';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const consoleRoles = [...MARKETING_ROLES, ...STAFF_ROLES];
const advertiserOnly = [authenticate, requireRole(ROLES.ADVERTISER)];
const plansView = [authenticate, requireRole(...consoleRoles)];
const staffOnly = [
  authenticate,
  requireCompany,
  requireRole(ROLES.MARKETING_MANAGER, ROLES.AD_SPECIALIST, ROLES.COMPANY_ADMIN, ROLES.COMPANY_OWNER, ROLES.PLATFORM_ADMIN),
];
const ownerOnly = [
  authenticate,
  requireCompany,
  requireRole(ROLES.COMPANY_OWNER, ROLES.PLATFORM_ADMIN),
];

function actorOf(req) {
  return req.user?.email || req.user?.id || 'ad-plans';
}

function actorIdOf(req) {
  const id = req.user?.id;
  return id && UUID_RE.test(id) ? id : null;
}

function pricingNotSet(res, plan) {
  return res.status(422).json({
    error: 'pricing_not_set',
    message: `Pricing for the ${plan.name} plan has not been set yet — checkout opens as soon as the office publishes it. Your current access is unchanged.`,
    planKey: plan.key,
  });
}

// ---------------------------------------------------------------------------
// Public side (Flywheel Upgrade #8, 2026-11-23)
// ---------------------------------------------------------------------------

/**
 * GET /advertise/plans — the PUBLIC plan catalog behind the
 * /advertise onboarding funnel. Catalog facts only (publicPlan:
 * name, description, the owner's recorded price, the feature matrix
 * and the limits) — no account data, no subscription state. Prices
 * come from the plan rows the owner priced in Ad Studio; an unpriced
 * plan reports priced:false and the funnel says so honestly instead
 * of inventing a number. Signup and checkout do NOT happen here —
 * the funnel deep-links into the Advertiser Console, whose Plans &
 * Billing view runs the existing checkout above.
 */
router.get('/advertise/plans', async (req, res, next) => {
  try {
    const plans = (await listPlans()).filter((p) => p.isActive);
    return res.json({
      data: {
        plans: plans.map(publicPlan),
        featuresCatalog: PLAN_FEATURES,
        consoleUrl: '/advertiser',
      },
    });
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Advertiser side
// ---------------------------------------------------------------------------

router.get('/advertiser/plans', ...plansView, async (req, res, next) => {
  try {
    const plans = (await listPlans()).filter((p) => p.isActive);
    const access = await resolveAccess(req.user);
    return res.json({
      data: {
        plans: plans.map(publicPlan),
        access: publicAccess(access),
        featuresCatalog: PLAN_FEATURE_KEYS,
      },
    });
  } catch (error) {
    return next(error);
  }
});

const planKeySchema = z.object({ planKey: z.string().trim().min(1).max(40) });

async function startCheckout(req, res, plan) {
  if (!stripeConfigured()) {
    return res.status(503).json({ error: 'payments_not_configured', message: 'Stripe is not configured on the API yet — checkout is unavailable.' });
  }
  if (plan.monthlyPriceCents == null || !plan.stripePriceId) return pricingNotSet(res, plan);
  const row = await ensureSubscription(req.user);
  let customerId = row.stripeCustomerId;
  if (!customerId) {
    const name = [req.user.firstName, req.user.lastName].filter(Boolean).join(' ') || undefined;
    const customer = await createStripeCustomer({ email: req.user.email, name, userId: req.user.id });
    customerId = customer.id;
    await upsertSubscription(req.user.id, { stripeCustomerId: customerId });
  }
  const session = await createPlanCheckout({
    customerId,
    priceId: plan.stripePriceId,
    userId: req.user.id,
    planKey: plan.key,
    successUrl: APP_BASE + '/advertiser?plan=success',
    cancelUrl: APP_BASE + '/advertiser?plan=cancelled',
  });
  return res.status(201).json({ data: { url: session.url, sessionId: session.id, action: 'checkout' } });
}

router.post('/advertiser/plans/checkout', ...advertiserOnly, async (req, res, next) => {
  try {
    const parsed = planKeySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid plan selection' });
    const plan = await getPlanByKey(parsed.data.planKey);
    if (!plan || !plan.isActive) return res.status(404).json({ error: 'Plan not found' });
    const access = await resolveAccess(req.user);
    if (access?.planKey === plan.key && ['ACTIVE', 'TRIALING', 'OFFICE_GRANTED'].includes(access.effectiveStatus)) {
      return res.status(422).json({ error: 'already_on_plan', message: `You are already on the ${plan.name} plan.` });
    }
    return await startCheckout(req, res, plan);
  } catch (error) {
    if (error?.code === 'stripe_error') return res.status(502).json({ error: 'stripe_error', message: error.message });
    return next(error);
  }
});

router.post('/advertiser/plans/change', ...advertiserOnly, async (req, res, next) => {
  try {
    const parsed = planKeySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid plan selection' });
    const target = await getPlanByKey(parsed.data.planKey);
    if (!target || !target.isActive) return res.status(404).json({ error: 'Plan not found' });
    const access = await resolveAccess(req.user);
    if (access?.planKey === target.key && ['ACTIVE', 'TRIALING', 'OFFICE_GRANTED', 'GRACE'].includes(access.effectiveStatus)) {
      return res.status(422).json({ error: 'already_on_plan', message: `You are already on the ${target.name} plan.` });
    }
    // No current paid/grant plan → changing means subscribing.
    if (!access || access.readOnly || access.effectiveStatus === 'GRANDFATHERED' || !access.plan) {
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
    const row = await ensureSubscription(req.user);
    await upsertSubscription(req.user.id, {
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

router.post('/advertiser/plans/cancel', ...advertiserOnly, async (req, res, next) => {
  try {
    const row = await ensureSubscription(req.user);
    if (row.stripeSubscriptionId) {
      if (!stripeConfigured()) {
        return res.status(503).json({ error: 'payments_not_configured', message: 'Stripe is not configured on the API yet — cancellation is unavailable.' });
      }
      await updateStripeSubscription(row.stripeSubscriptionId, { cancel_at_period_end: true });
      await upsertSubscription(req.user.id, { cancelAtPeriodEnd: true });
      return res.json({
        data: {
          action: 'cancel_at_period_end',
          effectiveAt: row.currentPeriodEnd,
          message: 'Your plan stays active until the end of the current billing period, then ends. Your campaigns stay visible (read-only) afterwards.',
        },
      });
    }
    if (row.status === 'OFFICE_GRANTED') {
      await upsertSubscription(req.user.id, { status: 'NONE', planId: null, grantedById: null, grantedAt: null });
      return res.json({ data: { action: 'ended', message: 'Your office-granted plan has been ended.' } });
    }
    return res.status(422).json({ error: 'no_active_subscription', message: 'There is no active plan subscription to cancel.' });
  } catch (error) {
    if (error?.code === 'stripe_error') return res.status(502).json({ error: 'stripe_error', message: error.message });
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Owner admin (Ad Studio)
// ---------------------------------------------------------------------------

router.get('/ad-studio/plans', ...staffOnly, async (req, res, next) => {
  try {
    const plans = await listPlans();
    const setting = await getBillingSetting();
    return res.json({ data: { plans: plans.map(adminPlan), settings: { graceDays: setting.graceDays } } });
  } catch (error) {
    return next(error);
  }
});

const settingsSchema = z.object({ graceDays: z.number().int().min(0).max(30) });
router.patch('/ad-studio/plans/settings', ...ownerOnly, async (req, res, next) => {
  try {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'graceDays must be a whole number of days between 0 and 30' });
    const setting = await updateBillingSetting(parsed.data.graceDays, actorOf(req));
    await appendEvent('AD_PLAN_SETTINGS_UPDATED', {
      source: 'ad-studio', actor: actorOf(req), entityType: 'AD_BILLING_SETTING', entityId: 'default',
      details: { graceDays: setting.graceDays },
    });
    return res.json({ data: { graceDays: setting.graceDays } });
  } catch (error) {
    return next(error);
  }
});

const planPatchSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  description: z.string().trim().max(400).nullable().optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(100).optional(),
  features: z.record(z.string(), z.boolean()).optional(),
  limits: z.object({
    maxCampaigns: z.number().int().min(1).max(1000).nullable().optional(),
    channels: z.array(z.enum(PLAN_CHANNELS)).max(PLAN_CHANNELS.length).optional(),
  }).optional(),
});

router.patch('/ad-studio/plans/:key', ...ownerOnly, async (req, res, next) => {
  try {
    const plan = await getPlanByKey(req.params.key);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    const parsed = planPatchSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid plan update', details: parsed.error.flatten() });
    const data = { ...parsed.data };
    if (data.features) {
      for (const key of Object.keys(data.features)) {
        if (!PLAN_FEATURE_KEYS.includes(key)) {
          return res.status(400).json({ error: `Unknown feature key: ${key}`, featureKeys: PLAN_FEATURE_KEYS });
        }
      }
      data.features = { ...plan.features, ...data.features };
    }
    if (data.limits) {
      data.limits = { ...plan.limits, ...data.limits };
    }
    const updated = await updatePlan(plan.id, data);
    await appendEvent('AD_PLAN_UPDATED', {
      source: 'ad-studio', actor: actorOf(req), entityType: 'AD_PLAN', entityId: plan.id,
      details: { planKey: plan.key, fields: Object.keys(parsed.data) },
    });
    return res.json({ data: adminPlan(updated) });
  } catch (error) {
    return next(error);
  }
});

const priceSchema = z.object({ monthlyPriceCents: z.number().int().min(100).max(1000000).nullable() });
router.post('/ad-studio/plans/:key/price', ...ownerOnly, async (req, res, next) => {
  try {
    const plan = await getPlanByKey(req.params.key);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    const parsed = priceSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'monthlyPriceCents must be a whole-cent amount of at least 100, or null to unset pricing' });
    }
    const amount = parsed.data.monthlyPriceCents;
    if (amount === null) {
      const updated = await updatePlan(plan.id, { monthlyPriceCents: null, stripePriceId: null });
      await appendEvent('AD_PLAN_PRICE_UNSET', {
        source: 'ad-studio', actor: actorOf(req), entityType: 'AD_PLAN', entityId: plan.id,
        details: { planKey: plan.key },
      });
      return res.json({ data: adminPlan(updated) });
    }
    if (!stripeConfigured()) {
      return res.status(503).json({ error: 'stripe_not_configured', message: 'Stripe is not configured on the API — the price was not saved.' });
    }
    // Sync to Stripe with the OWNER'S amount — the only place in the
    // system where a Stripe Product/Price for a plan is ever created.
    let productId = plan.stripeProductId;
    if (!productId) {
      const product = await createStripeProduct({ name: `Flywheel Advertising — ${plan.name} plan`, planKey: plan.key });
      productId = product.id;
      await updatePlan(plan.id, { stripeProductId: productId });
    }
    const price = await createStripePrice({ productId, amountCents: amount, currency: plan.currency || 'usd' });
    const updated = await updatePlan(plan.id, { monthlyPriceCents: amount, stripePriceId: price.id, stripeProductId: productId });
    await appendEvent('AD_PLAN_PRICE_SET', {
      source: 'ad-studio', actor: actorOf(req), entityType: 'AD_PLAN', entityId: plan.id,
      details: { planKey: plan.key, monthlyPriceCents: amount, stripePriceId: price.id },
    });
    emitReport({
      department: 'billing',
      type: 'AD_PLAN_PRICE_SET',
      title: `Advertiser plan price set — ${plan.name} at ${amount} cents/mo`,
      detail: { planKey: plan.key, monthlyPriceCents: amount, stripePriceId: price.id, actor: actorOf(req) },
      source: 'ad-studio',
      reference: plan.key,
      eventKey: `ad-plan:${plan.id}:price:${price.id}`,
    });
    return res.json({ data: adminPlan(updated) });
  } catch (error) {
    if (error?.code === 'stripe_error') return res.status(502).json({ error: 'stripe_error', message: error.message });
    return next(error);
  }
});

router.get('/ad-studio/subscriptions', ...staffOnly, async (req, res, next) => {
  try {
    const setting = await getBillingSetting();
    const rows = await listSubscriptions();
    const items = [];
    for (const row of rows) {
      const plan = row.planId ? await getPlanById(row.planId) : null;
      const pendingPlan = row.pendingPlanId ? await getPlanById(row.pendingPlanId) : null;
      items.push({
        userId: row.userId,
        user: row.user || null,
        planKey: plan?.key ?? null,
        planName: plan?.name ?? null,
        status: row.status,
        effectiveStatus: effectiveStatusOf(row, setting.graceDays),
        currentPeriodEnd: row.currentPeriodEnd,
        pastDueAt: row.pastDueAt,
        cancelAtPeriodEnd: row.cancelAtPeriodEnd,
        pendingPlanKey: pendingPlan?.key ?? null,
        grantedById: row.grantedById,
        grantedAt: row.grantedAt,
        hasStripeCustomer: Boolean(row.stripeCustomerId),
        hasStripeSubscription: Boolean(row.stripeSubscriptionId),
        updatedAt: row.updatedAt,
      });
    }
    const pastDue = items.filter((i) => i.effectiveStatus === 'GRACE' || i.effectiveStatus === 'SUSPENDED' || i.status === 'PAST_DUE');
    return res.json({ data: { subscriptions: items, pastDue, counts: { total: items.length, pastDue: pastDue.length } } });
  } catch (error) {
    return next(error);
  }
});

const grantSchema = z.object({ planKey: z.string().trim().min(1).max(40) });
router.post('/ad-studio/subscriptions/:userId/grant', ...ownerOnly, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.userId)) return res.status(400).json({ error: 'Invalid advertiser account id' });
    const parsed = grantSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid grant request' });
    const plan = await getPlanByKey(parsed.data.planKey);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    if (DATABASE_ENABLED) {
      const target = await db().user.findUnique({ where: { id: req.params.userId }, select: { roles: true, email: true } });
      if (!target) return res.status(404).json({ error: 'Advertiser account not found' });
      if (!(target.roles || []).includes(ROLES.ADVERTISER)) {
        return res.status(400).json({ error: 'That account is not an advertiser account — plans attach to advertiser accounts.' });
      }
    }
    const row = await upsertSubscription(req.params.userId, {
      status: 'OFFICE_GRANTED',
      planId: plan.id,
      grantedById: actorIdOf(req),
      grantedAt: new Date().toISOString(),
      pastDueAt: null,
      pendingPlanId: null,
      pendingEffectiveAt: null,
      cancelAtPeriodEnd: false,
    });
    await appendEvent('AD_PLAN_OFFICE_GRANTED', {
      source: 'ad-studio', actor: actorOf(req), entityType: 'ADVERTISER_SUBSCRIPTION', entityId: req.params.userId,
      details: { planKey: plan.key },
    });
    emitReport({
      department: 'billing',
      type: 'AD_PLAN_OFFICE_GRANTED',
      title: `Advertiser plan office-granted — ${plan.name}`,
      detail: { userId: req.params.userId, planKey: plan.key, grantedBy: actorOf(req) },
      source: 'ad-studio',
      reference: req.params.userId,
      eventKey: `ad-plan:${req.params.userId}:granted:${plan.key}:${row.updatedAt}`,
    });
    return res.json({ data: { userId: row.userId, status: row.status, planKey: plan.key, grantedAt: row.grantedAt } });
  } catch (error) {
    return next(error);
  }
});

router.post('/ad-studio/subscriptions/:userId/revoke', ...ownerOnly, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.userId)) return res.status(400).json({ error: 'Invalid advertiser account id' });
    let fallback = 'NONE';
    if (DATABASE_ENABLED) {
      const target = await db().user.findUnique({
        where: { id: req.params.userId },
        select: { createdAt: true, signupSource: true },
      });
      if (!target) return res.status(404).json({ error: 'Advertiser account not found' });
      if (grandfatherEligible(target)) fallback = 'GRANDFATHERED';
    }
    const row = await upsertSubscription(req.params.userId, {
      status: fallback, planId: null, grantedById: null, grantedAt: null,
      pendingPlanId: null, pendingEffectiveAt: null,
    });
    await appendEvent('AD_PLAN_OFFICE_REVOKED', {
      source: 'ad-studio', actor: actorOf(req), entityType: 'ADVERTISER_SUBSCRIPTION', entityId: req.params.userId,
      details: { fallbackStatus: fallback },
    });
    emitReport({
      department: 'billing',
      type: 'AD_PLAN_OFFICE_REVOKED',
      title: 'Advertiser plan office grant revoked',
      detail: { userId: req.params.userId, fallbackStatus: fallback, revokedBy: actorOf(req) },
      source: 'ad-studio',
      reference: req.params.userId,
      eventKey: `ad-plan:${req.params.userId}:revoked:${row.updatedAt}`,
    });
    return res.json({ data: { userId: row.userId, status: row.status } });
  } catch (error) {
    return next(error);
  }
});

export default router;
