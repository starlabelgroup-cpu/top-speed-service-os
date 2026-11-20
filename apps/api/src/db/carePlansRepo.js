import { createId } from '../data/store.js';
import { DATABASE_ENABLED, db } from './client.js';

/**
 * Appliance Care Plan (membership) — repository (2026-11-20, B4).
 *
 * Same dual-mode discipline as db/adPlansRepo.js: Prisma when
 * DATABASE_URL is set, an in-memory fallback with identical shapes
 * when it is not (the Phase-1 skeleton). The tier STRUCTURE is seeded
 * here — one membership plan with annualPriceCents NULL. The price is
 * owner-configured in the admin surface (routes/carePlans.js) and
 * only there; nothing in this file ever writes a price or a Stripe id.
 *
 * The feature matrix keys are services/carePlans.js CARE_FEATURES.
 */

export const CARE_PLAN_TIERS = [
  {
    key: 'care-plan',
    name: 'Appliance Care Plan',
    description: 'One annual appliance check-up visit included every membership year, and priority booking — your requests move to the front of the Service Setters queue.',
    sortOrder: 1,
    features: { annualCheckup: true, priorityBooking: true },
  },
];

function iso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function toPlan(row) {
  if (!row) return null;
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description ?? null,
    annualPriceCents: row.annualPriceCents ?? null,
    currency: row.currency || 'usd',
    features: row.features && typeof row.features === 'object' ? row.features : {},
    isActive: row.isActive !== false,
    sortOrder: row.sortOrder ?? 0,
    stripeProductId: row.stripeProductId ?? null,
    stripePriceId: row.stripePriceId ?? null,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function toSubscription(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.userId,
    planId: row.planId ?? null,
    status: row.status || 'NONE',
    stripeCustomerId: row.stripeCustomerId ?? null,
    stripeSubscriptionId: row.stripeSubscriptionId ?? null,
    currentPeriodStart: iso(row.currentPeriodStart),
    currentPeriodEnd: iso(row.currentPeriodEnd),
    pastDueAt: iso(row.pastDueAt),
    cancelAtPeriodEnd: Boolean(row.cancelAtPeriodEnd),
    checkupBookedForPeriodEnd: iso(row.checkupBookedForPeriodEnd),
    checkupBookingRef: row.checkupBookingRef ?? null,
    grantedById: row.grantedById ?? null,
    grantedAt: iso(row.grantedAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    user: row.user
      ? {
          email: row.user.email,
          name: [row.user.firstName, row.user.lastName].filter(Boolean).join(' ') || null,
          roles: row.user.roles || [],
        }
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// In-memory fallback (Phase-1 skeleton: no DATABASE_URL).
// ---------------------------------------------------------------------------
const memoryPlans = [];
const memorySubscriptions = [];
let memorySetting = null;

const memoryRepo = {
  async listPlans() {
    return [...memoryPlans].sort((a, b) => a.sortOrder - b.sortOrder).map(toPlan);
  },
  async createPlan(tier) {
    const now = new Date().toISOString();
    const row = {
      id: createId(), key: tier.key, name: tier.name, description: tier.description ?? null,
      annualPriceCents: null, currency: 'usd',
      features: { ...tier.features },
      isActive: true, sortOrder: tier.sortOrder ?? 0,
      stripeProductId: null, stripePriceId: null, createdAt: now, updatedAt: now,
    };
    memoryPlans.push(row);
    return toPlan(row);
  },
  async updatePlan(id, data) {
    const row = memoryPlans.find((p) => p.id === id);
    if (!row) return null;
    Object.assign(row, data, { updatedAt: new Date().toISOString() });
    return toPlan(row);
  },
  async getSubscriptionByUserId(userId) {
    return toSubscription(memorySubscriptions.find((s) => s.userId === userId) || null);
  },
  async getSubscriptionByStripeSubscriptionId(stripeSubscriptionId) {
    if (!stripeSubscriptionId) return null;
    return toSubscription(memorySubscriptions.find((s) => s.stripeSubscriptionId === stripeSubscriptionId) || null);
  },
  async upsertSubscription(userId, data) {
    let row = memorySubscriptions.find((s) => s.userId === userId);
    const now = new Date().toISOString();
    if (!row) {
      row = {
        id: createId(), userId, planId: null, status: 'NONE',
        stripeCustomerId: null, stripeSubscriptionId: null,
        currentPeriodStart: null, currentPeriodEnd: null,
        pastDueAt: null, cancelAtPeriodEnd: false,
        checkupBookedForPeriodEnd: null, checkupBookingRef: null,
        grantedById: null, grantedAt: null,
        createdAt: now, updatedAt: now,
      };
      memorySubscriptions.push(row);
    }
    Object.assign(row, data, { updatedAt: now });
    return toSubscription(row);
  },
  async listSubscriptions() {
    return memorySubscriptions.map(toSubscription);
  },
  async getSetting() {
    return memorySetting ? { ...memorySetting } : { id: 'default', graceDays: 7, updatedBy: null };
  },
  async updateSetting(graceDays, updatedBy) {
    memorySetting = { id: 'default', graceDays, updatedBy: updatedBy ?? null, updatedAt: new Date().toISOString() };
    return { ...memorySetting };
  },
};

// ---------------------------------------------------------------------------
// Prisma repository.
// ---------------------------------------------------------------------------
const prismaRepo = {
  async listPlans() {
    const rows = await db().carePlan.findMany({ orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
    return rows.map(toPlan);
  },
  async createPlan(tier) {
    const row = await db().carePlan.create({
      data: {
        key: tier.key, name: tier.name, description: tier.description ?? null,
        annualPriceCents: null, currency: 'usd',
        features: tier.features,
        isActive: true, sortOrder: tier.sortOrder ?? 0,
      },
    });
    return toPlan(row);
  },
  async updatePlan(id, data) {
    const row = await db().carePlan.update({ where: { id }, data });
    return toPlan(row);
  },
  async getSubscriptionByUserId(userId) {
    const row = await db().careSubscription.findUnique({ where: { userId } });
    return toSubscription(row);
  },
  async getSubscriptionByStripeSubscriptionId(stripeSubscriptionId) {
    if (!stripeSubscriptionId) return null;
    const row = await db().careSubscription.findFirst({ where: { stripeSubscriptionId } });
    return toSubscription(row);
  },
  async upsertSubscription(userId, data) {
    const row = await db().careSubscription.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
    return toSubscription(row);
  },
  async listSubscriptions() {
    const rows = await db().careSubscription.findMany({
      orderBy: { updatedAt: 'desc' },
      include: { user: { select: { email: true, firstName: true, lastName: true, roles: true } } },
    });
    return rows.map(toSubscription);
  },
  async getSetting() {
    const row = await db().careBillingSetting.findUnique({ where: { id: 'default' } });
    if (!row) return { id: 'default', graceDays: 7, updatedBy: null };
    return { id: row.id, graceDays: row.graceDays, updatedBy: row.updatedBy ?? null };
  },
  async updateSetting(graceDays, updatedBy) {
    const row = await db().careBillingSetting.upsert({
      where: { id: 'default' },
      create: { id: 'default', graceDays, updatedBy: updatedBy ?? null },
      update: { graceDays, updatedBy: updatedBy ?? null },
    });
    return { id: row.id, graceDays: row.graceDays, updatedBy: row.updatedBy ?? null };
  },
};

const repo = DATABASE_ENABLED ? prismaRepo : memoryRepo;

/** Idempotent tier seed: creates the Care Plan (price UNSET) only when no plans exist. */
export async function ensureSeedCarePlans() {
  const existing = await repo.listPlans();
  if (existing.length) return existing;
  const created = [];
  for (const tier of CARE_PLAN_TIERS) created.push(await repo.createPlan(tier));
  return created;
}

export async function listCarePlans() {
  await ensureSeedCarePlans();
  return repo.listPlans();
}

export async function getCarePlanByKey(key) {
  const plans = await listCarePlans();
  return plans.find((p) => p.key === key) || null;
}

export async function getCarePlanById(id) {
  if (!id) return null;
  const plans = await listCarePlans();
  return plans.find((p) => p.id === id) || null;
}

export async function updateCarePlan(id, data) {
  return repo.updatePlan(id, data);
}

export async function getCareSubscriptionByUserId(userId) {
  return repo.getSubscriptionByUserId(userId);
}

export async function getCareSubscriptionByStripeSubscriptionId(stripeSubscriptionId) {
  return repo.getSubscriptionByStripeSubscriptionId(stripeSubscriptionId);
}

export async function upsertCareSubscription(userId, data) {
  return repo.upsertSubscription(userId, data);
}

export async function listCareSubscriptions() {
  return repo.listSubscriptions();
}

export async function getCareBillingSetting() {
  return repo.getSetting();
}

export async function updateCareBillingSetting(graceDays, updatedBy) {
  return repo.updateSetting(graceDays, updatedBy);
}
