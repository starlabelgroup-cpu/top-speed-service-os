import { Router } from 'express';
import { z } from 'zod';
import { addBookingEvent, appendEvent, createId, createReferenceCode, PLATFORM_COMPANY_ID, store } from '../data/store.js';
import { DATABASE_ENABLED, db } from '../db/client.js';
import { persistBooking, persistCustomer } from '../db/bookingsRepo.js';
import { resolveArea } from '../config/serviceAreas.js';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { ROLES } from '../config/security.js';
import {
  getCareBillingSetting, getCarePlanById, getCarePlanByKey, getCareSubscriptionByUserId,
  listCarePlans, listCareSubscriptions, updateCareBillingSetting, updateCarePlan,
  upsertCareSubscription,
} from '../db/carePlansRepo.js';
import {
  CARE_FEATURE_KEYS, adminCarePlan, careAccessHas, checkupAvailable, effectiveCareStatusOf,
  publicCareAccess, publicCarePlan, resolveCareAccess,
} from '../services/carePlans.js';
import { emitReport } from '../services/managementReports.js';
import { notifyNewBooking } from '../services/notifications.js';
import {
  createPlanCheckout, createStripeCustomer, createStripePrice, createStripeProduct,
  stripeConfigured, updateStripeSubscription,
} from '../services/stripe.js';

/**
 * Appliance Care Plan (membership) — routes (2026-11-20, B4).
 *
 * Customer side (customer app → Care Plan):
 *   GET  /care/plans            catalog + my membership
 *   POST /care/plans/checkout   Stripe subscription checkout (annual)
 *   POST /care/plans/cancel     cancel at period end
 *   POST /care/checkup/book     book the included annual check-up
 *
 * Owner side (ApplianceMan → Care Plans):
 *   GET   /admin/care-plans                              plans + settings
 *   PATCH /admin/care-plans/settings                     grace window (owner)
 *   PATCH /admin/care-plans/:key                         structure edits (owner)
 *   POST  /admin/care-plans/:key/price                   set price → Stripe sync (owner)
 *   GET   /admin/care-plans/subscriptions                every member's state
 *   POST  /admin/care-plans/subscriptions/:userId/grant  office grant (owner, audited)
 *   POST  /admin/care-plans/subscriptions/:userId/revoke revoke grant (owner, audited)
 *
 * Prices are ONLY ever written by the owner's price route below —
 * with the owner's amount, synced to Stripe at that moment. An
 * unpriced plan refuses checkout with an honest pricing_not_set.
 * Every gate rides on its own route (the shared /api/v1 prefix rule).
 */
const router = Router();

const APP_BASE = process.env.PUBLIC_WEB_BASE || 'https://topspeedserviceos.com';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const signedIn = [authenticate];
const managerView = [
  authenticate,
  requireCompany,
  requireRole(ROLES.COMPANY_ADMIN, ROLES.COMPANY_OWNER, ROLES.PLATFORM_ADMIN),
];
const ownerOnly = [
  authenticate,
  requireCompany,
  requireRole(ROLES.COMPANY_OWNER, ROLES.PLATFORM_ADMIN),
];

function actorOf(req) {
  return req.user?.email || req.user?.id || 'care-plans';
}

function actorIdOf(req) {
  const id = req.user?.id;
  return id && UUID_RE.test(id) ? id : null;
}

function pricingNotSet(res, plan) {
  return res.status(422).json({
    error: 'pricing_not_set',
    message: `Pricing for the ${plan.name} has not been set yet — membership opens as soon as the office publishes it. Nothing was charged.`,
    planKey: plan.key,
  });
}

// ---------------------------------------------------------------------------
// Customer side
// ---------------------------------------------------------------------------

router.get('/care/plans', ...signedIn, async (req, res, next) => {
  try {
    const plans = (await listCarePlans()).filter((p) => p.isActive);
    const access = await resolveCareAccess(req.user);
    return res.json({
      data: {
        plans: plans.map(publicCarePlan),
        access: publicCareAccess(access),
        featuresCatalog: CARE_FEATURE_KEYS,
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
  // The price check runs BEFORE any Stripe call: an unpriced plan
  // creates no customer, no session, nothing.
  if (plan.annualPriceCents == null || !plan.stripePriceId) return pricingNotSet(res, plan);
  let row = await getCareSubscriptionByUserId(req.user.id);
  if (!row) row = await upsertCareSubscription(req.user.id, { status: 'NONE' });
  let customerId = row.stripeCustomerId;
  if (!customerId) {
    const name = [req.user.firstName, req.user.lastName].filter(Boolean).join(' ') || undefined;
    const customer = await createStripeCustomer({ email: req.user.email, name, userId: req.user.id, purpose: 'CARE_PLAN' });
    customerId = customer.id;
    row = await upsertCareSubscription(req.user.id, { stripeCustomerId: customerId });
  }
  const session = await createPlanCheckout({
    customerId,
    priceId: plan.stripePriceId,
    userId: req.user.id,
    planKey: plan.key,
    purpose: 'CARE_PLAN',
    successUrl: APP_BASE + '/app?care=success',
    cancelUrl: APP_BASE + '/app?care=cancelled',
  });
  return res.status(201).json({ data: { url: session.url, sessionId: session.id, action: 'checkout' } });
}

router.post('/care/plans/checkout', ...signedIn, async (req, res, next) => {
  try {
    const parsed = planKeySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid plan selection' });
    const plan = await getCarePlanByKey(parsed.data.planKey);
    if (!plan || !plan.isActive) return res.status(404).json({ error: 'Plan not found' });
    const access = await resolveCareAccess(req.user);
    if (access?.planKey === plan.key && ['ACTIVE', 'TRIALING', 'OFFICE_GRANTED'].includes(access.effectiveStatus)) {
      return res.status(422).json({ error: 'already_on_plan', message: `You are already a ${plan.name} member.` });
    }
    return await startCheckout(req, res, plan);
  } catch (error) {
    if (error?.code === 'stripe_error') return res.status(502).json({ error: 'stripe_error', message: error.message });
    return next(error);
  }
});

router.post('/care/plans/cancel', ...signedIn, async (req, res, next) => {
  try {
    const row = (await getCareSubscriptionByUserId(req.user.id)) || { status: 'NONE', stripeSubscriptionId: null, currentPeriodEnd: null };
    if (row.stripeSubscriptionId) {
      if (!stripeConfigured()) {
        return res.status(503).json({ error: 'payments_not_configured', message: 'Stripe is not configured on the API yet — cancellation is unavailable.' });
      }
      await updateStripeSubscription(row.stripeSubscriptionId, { cancel_at_period_end: true });
      await upsertCareSubscription(req.user.id, { cancelAtPeriodEnd: true });
      return res.json({
        data: {
          action: 'cancel_at_period_end',
          effectiveAt: row.currentPeriodEnd,
          message: 'Your membership stays active until the end of the current membership year, then ends. Priority booking and your check-up apply until then.',
        },
      });
    }
    if (row.status === 'OFFICE_GRANTED') {
      await upsertCareSubscription(req.user.id, { status: 'NONE', planId: null, grantedById: null, grantedAt: null });
      return res.json({ data: { action: 'ended', message: 'Your office-granted membership has been ended.' } });
    }
    return res.status(422).json({ error: 'no_active_subscription', message: 'There is no active Care Plan membership to cancel.' });
  } catch (error) {
    if (error?.code === 'stripe_error') return res.status(502).json({ error: 'stripe_error', message: error.message });
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// The included annual check-up
// ---------------------------------------------------------------------------

const checkupSchema = z.object({
  city: z.string().trim().min(2).max(80),
  zip: z.string().regex(/^\d{5}$/),
  address: z.string().trim().min(5).max(300).optional(),
  preferredWindow: z.string().trim().max(60).nullable().optional(),
});

function digitsOf(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-10);
}

function findMemberCustomer(req) {
  const email = String(req.user.email || '').toLowerCase();
  const phone = digitsOf(req.user.phone);
  for (const customer of store.customers.values()) {
    if (customer.userId && customer.userId === req.user.id) return customer;
    if (email && String(customer.email || '').toLowerCase() === email) return customer;
    if (phone && digitsOf(customer.phone) === phone) return customer;
  }
  return null;
}

router.post('/care/checkup/book', ...signedIn, async (req, res, next) => {
  try {
    const parsed = checkupSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid check-up request', details: parsed.error.flatten() });
    }
    const access = await resolveCareAccess(req.user);
    if (!careAccessHas(access, 'annualCheckup')) {
      return res.status(403).json({
        error: 'plan_upgrade_required',
        message: 'The annual check-up is a Care Plan membership benefit. Join the Care Plan in the app and your check-up is included every year.',
        upgradeUrl: '/app',
      });
    }
    if (!checkupAvailable(access)) {
      return res.status(422).json({
        error: 'checkup_already_booked',
        message: access.checkupBookingRef
          ? `This year's check-up is already booked — reference ${access.checkupBookingRef}. Your next one opens with your next membership year.`
          : 'This year\u2019s check-up has already been used. Your next one opens with your next membership year.',
        bookingReference: access.checkupBookingRef,
      });
    }

    const { city, zip, address, preferredWindow } = parsed.data;
    const resolution = resolveArea({ city, zip });
    if (resolution.areaStatus === 'OUT_OF_AREA') {
      return res.status(422).json({
        error: 'out_of_area',
        message: 'That address is outside our current service area, so we cannot book the check-up visit there. Book it for an address inside the service area, or call the office and we will help.',
      });
    }
    const canonicalCity = resolution.area || city;

    let customer = findMemberCustomer(req);
    const t = new Date().toISOString();
    if (!customer) {
      customer = {
        id: createId(),
        companyId: PLATFORM_COMPANY_ID,
        userId: req.user.id,
        name: [req.user.firstName, req.user.lastName].filter(Boolean).join(' ') || req.user.email,
        phone: req.user.phone || '',
        email: req.user.email,
        address: address || null,
        city: canonicalCity,
        zip,
        source: 'CARE_PLAN',
        createdAt: t,
      };
      store.customers.set(customer.id, customer);
      await persistCustomer(customer);
    }

    const booking = {
      id: createId(),
      companyId: PLATFORM_COMPANY_ID,
      customerId: customer.id,
      customer,
      referenceCode: createReferenceCode(),
      source: 'CARE_PLAN',
      segment: 'RESIDENTIAL',
      city: canonicalCity,
      zip,
      area: resolution.area,
      areaStatus: resolution.areaStatus,
      serviceAddress: address || customer.address || null,
      appliance: 'Annual Check-Up',
      issue: 'Annual appliance check-up visit — included with the Appliance Care Plan membership.',
      preferredWindow: preferredWindow || null,
      priority: true,
      priorityReasons: ['Care Plan member — priority booking', 'Annual check-up included in membership'],
      carePlan: { userId: req.user.id, planKey: access.planKey },
      // The check-up is INCLUDED in the membership — no diagnostic
      // fee is charged for this visit, and there is no fee to credit.
      diagnosticFee: 0,
      diagnosticFeeCurrency: 'USD',
      diagnosticFeeCreditedTowardRepair: false,
      feeStatus: 'included_in_care_plan',
      status: 'PENDING_DISPATCH',
      dispatch: { mode: 'HYBRID', stage: 'AWAITING_MATCH', candidateProviderIds: [], assignmentIds: [] },
      history: [],
      createdAt: t,
      updatedAt: t,
    };
    addBookingEvent(booking, 'BOOKING_CREATED', 'care-plan', {
      source: 'CARE_PLAN', diagnosticFee: 0, feeStatus: booking.feeStatus, checkup: true,
    });
    store.bookings.set(booking.id, booking);
    await persistBooking(booking);

    // One check-up per membership period (per grant, for office
    // grants) — recorded against the period it fulfilled.
    await upsertCareSubscription(req.user.id, {
      checkupBookedForPeriodEnd: access.currentPeriodEnd || access.grantedAt || t,
      checkupBookingRef: booking.referenceCode,
    });
    await appendEvent('BOOKING_CREATED', {
      source: 'CARE_PLAN', actor: 'care-plan', entityType: 'BOOKING', entityId: booking.id,
      referenceCode: booking.referenceCode,
      details: { appliance: booking.appliance, city: booking.city, areaStatus: booking.areaStatus, status: booking.status, checkup: true, priority: true },
    });
    await appendEvent('CARE_CHECKUP_BOOKED', {
      source: 'CARE_PLAN', actor: req.user.id, entityType: 'BOOKING', entityId: booking.id,
      referenceCode: booking.referenceCode,
      details: { planKey: access.planKey, periodEnd: access.currentPeriodEnd },
    });
    notifyNewBooking(booking, 'CARE_PLAN');

    return res.status(201).json({
      data: {
        referenceCode: booking.referenceCode,
        status: booking.status,
        city: booking.city,
        areaStatus: booking.areaStatus,
        appliance: booking.appliance,
        preferredWindow: booking.preferredWindow,
        diagnosticFee: 0,
      },
    });
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Owner admin (ApplianceMan)
// ---------------------------------------------------------------------------

router.get('/admin/care-plans', ...managerView, async (req, res, next) => {
  try {
    const plans = await listCarePlans();
    const setting = await getCareBillingSetting();
    return res.json({ data: { plans: plans.map(adminCarePlan), settings: { graceDays: setting.graceDays } } });
  } catch (error) {
    return next(error);
  }
});

const settingsSchema = z.object({ graceDays: z.number().int().min(0).max(30) });
router.patch('/admin/care-plans/settings', ...ownerOnly, async (req, res, next) => {
  try {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'graceDays must be a whole number of days between 0 and 30' });
    const setting = await updateCareBillingSetting(parsed.data.graceDays, actorOf(req));
    await appendEvent('CARE_PLAN_SETTINGS_UPDATED', {
      source: 'applianceman', actor: actorOf(req), entityType: 'CARE_BILLING_SETTING', entityId: 'default',
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
});

router.patch('/admin/care-plans/:key', ...ownerOnly, async (req, res, next) => {
  try {
    const plan = await getCarePlanByKey(req.params.key);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    const parsed = planPatchSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid plan update', details: parsed.error.flatten() });
    const data = { ...parsed.data };
    if (data.features) {
      for (const key of Object.keys(data.features)) {
        if (!CARE_FEATURE_KEYS.includes(key)) {
          return res.status(400).json({ error: `Unknown feature key: ${key}`, featureKeys: CARE_FEATURE_KEYS });
        }
      }
      data.features = { ...plan.features, ...data.features };
    }
    const updated = await updateCarePlan(plan.id, data);
    await appendEvent('CARE_PLAN_UPDATED', {
      source: 'applianceman', actor: actorOf(req), entityType: 'CARE_PLAN', entityId: plan.id,
      details: { planKey: plan.key, fields: Object.keys(parsed.data) },
    });
    return res.json({ data: adminCarePlan(updated) });
  } catch (error) {
    return next(error);
  }
});

const priceSchema = z.object({ annualPriceCents: z.number().int().min(100).max(10000000).nullable() });
router.post('/admin/care-plans/:key/price', ...ownerOnly, async (req, res, next) => {
  try {
    const plan = await getCarePlanByKey(req.params.key);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    const parsed = priceSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'annualPriceCents must be a whole-cent amount of at least 100, or null to unset pricing' });
    }
    const amount = parsed.data.annualPriceCents;
    if (amount === null) {
      const updated = await updateCarePlan(plan.id, { annualPriceCents: null, stripePriceId: null });
      await appendEvent('CARE_PLAN_PRICE_UNSET', {
        source: 'applianceman', actor: actorOf(req), entityType: 'CARE_PLAN', entityId: plan.id,
        details: { planKey: plan.key },
      });
      return res.json({ data: adminCarePlan(updated) });
    }
    if (!stripeConfigured()) {
      return res.status(503).json({ error: 'stripe_not_configured', message: 'Stripe is not configured on the API — the price was not saved.' });
    }
    // Sync to Stripe with the OWNER'S amount — the only place in the
    // system where a Stripe Product/Price for the Care Plan is ever
    // created. The membership bills ANNUALLY (interval 'year').
    let productId = plan.stripeProductId;
    if (!productId) {
      const product = await createStripeProduct({ name: `Top Speed Appliance — ${plan.name} membership`, planKey: plan.key, purpose: 'CARE_PLAN' });
      productId = product.id;
      await updateCarePlan(plan.id, { stripeProductId: productId });
    }
    const price = await createStripePrice({ productId, amountCents: amount, currency: plan.currency || 'usd', interval: 'year' });
    const updated = await updateCarePlan(plan.id, { annualPriceCents: amount, stripePriceId: price.id, stripeProductId: productId });
    await appendEvent('CARE_PLAN_PRICE_SET', {
      source: 'applianceman', actor: actorOf(req), entityType: 'CARE_PLAN', entityId: plan.id,
      details: { planKey: plan.key, annualPriceCents: amount, stripePriceId: price.id },
    });
    emitReport({
      department: 'billing',
      type: 'CARE_PLAN_PRICE_SET',
      title: `Care Plan price set — ${plan.name} at ${amount} cents/yr`,
      detail: { planKey: plan.key, annualPriceCents: amount, stripePriceId: price.id, actor: actorOf(req) },
      source: 'applianceman',
      reference: plan.key,
      eventKey: `care-plan:${plan.id}:price:${price.id}`,
    });
    return res.json({ data: adminCarePlan(updated) });
  } catch (error) {
    if (error?.code === 'stripe_error') return res.status(502).json({ error: 'stripe_error', message: error.message });
    return next(error);
  }
});

router.get('/admin/care-plans/subscriptions', ...managerView, async (req, res, next) => {
  try {
    const setting = await getCareBillingSetting();
    const rows = await listCareSubscriptions();
    const items = [];
    for (const row of rows) {
      const plan = row.planId ? await getCarePlanById(row.planId) : null;
      items.push({
        userId: row.userId,
        user: row.user || null,
        planKey: plan?.key ?? null,
        planName: plan?.name ?? null,
        status: row.status,
        effectiveStatus: effectiveCareStatusOf(row, setting.graceDays),
        currentPeriodStart: row.currentPeriodStart,
        currentPeriodEnd: row.currentPeriodEnd,
        pastDueAt: row.pastDueAt,
        cancelAtPeriodEnd: row.cancelAtPeriodEnd,
        checkupBookedForPeriodEnd: row.checkupBookedForPeriodEnd,
        checkupBookingRef: row.checkupBookingRef,
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
router.post('/admin/care-plans/subscriptions/:userId/grant', ...ownerOnly, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.userId)) return res.status(400).json({ error: 'Invalid account id' });
    const parsed = grantSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid grant request' });
    const plan = await getCarePlanByKey(parsed.data.planKey);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    if (DATABASE_ENABLED) {
      const target = await db().user.findUnique({ where: { id: req.params.userId }, select: { roles: true, email: true } });
      if (!target) return res.status(404).json({ error: 'Account not found' });
    }
    const row = await upsertCareSubscription(req.params.userId, {
      status: 'OFFICE_GRANTED',
      planId: plan.id,
      grantedById: actorIdOf(req),
      grantedAt: new Date().toISOString(),
      pastDueAt: null,
      cancelAtPeriodEnd: false,
    });
    await appendEvent('CARE_PLAN_OFFICE_GRANTED', {
      source: 'applianceman', actor: actorOf(req), entityType: 'CARE_SUBSCRIPTION', entityId: req.params.userId,
      details: { planKey: plan.key },
    });
    emitReport({
      department: 'billing',
      type: 'CARE_PLAN_OFFICE_GRANTED',
      title: `Care Plan office-granted — ${plan.name}`,
      detail: { userId: req.params.userId, planKey: plan.key, grantedBy: actorOf(req) },
      source: 'applianceman',
      reference: req.params.userId,
      eventKey: `care-plan:${req.params.userId}:granted:${plan.key}:${row.updatedAt}`,
    });
    return res.json({ data: { userId: row.userId, status: row.status, planKey: plan.key, grantedAt: row.grantedAt } });
  } catch (error) {
    return next(error);
  }
});

router.post('/admin/care-plans/subscriptions/:userId/revoke', ...ownerOnly, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.userId)) return res.status(400).json({ error: 'Invalid account id' });
    if (DATABASE_ENABLED) {
      const target = await db().user.findUnique({ where: { id: req.params.userId }, select: { id: true } });
      if (!target) return res.status(404).json({ error: 'Account not found' });
    }
    const row = await upsertCareSubscription(req.params.userId, {
      status: 'NONE', planId: null, grantedById: null, grantedAt: null,
      checkupBookedForPeriodEnd: null, checkupBookingRef: null,
    });
    await appendEvent('CARE_PLAN_OFFICE_REVOKED', {
      source: 'applianceman', actor: actorOf(req), entityType: 'CARE_SUBSCRIPTION', entityId: req.params.userId,
      details: {},
    });
    emitReport({
      department: 'billing',
      type: 'CARE_PLAN_OFFICE_REVOKED',
      title: 'Care Plan office grant revoked',
      detail: { userId: req.params.userId, revokedBy: actorOf(req) },
      source: 'applianceman',
      reference: req.params.userId,
      eventKey: `care-plan:${req.params.userId}:revoked:${row.updatedAt}`,
    });
    return res.json({ data: { userId: row.userId, status: row.status } });
  } catch (error) {
    return next(error);
  }
});

export default router;
