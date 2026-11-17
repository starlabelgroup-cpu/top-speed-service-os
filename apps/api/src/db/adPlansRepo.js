import { createId } from '../data/store.js';
import { DATABASE_ENABLED, db } from './client.js';

/**
 * Flywheel Advertiser Plans — repository (2026-11-17).
 *
 * Same dual-mode discipline as the ChannelLink / SellerChannel
 * repositories: Prisma when DATABASE_URL is set, an in-memory
 * fallback with identical shapes when it is not (the Phase-1
 * skeleton). The tier STRUCTURE is seeded here — three plans with
 * monthlyPriceCents NULL. Prices are owner-configured in Ad Studio
 * (routes/adPlans.js) and only there; nothing in this file ever
 * writes a price or a Stripe id.
 *
 * The feature matrix keys are services/adPlans.js PLAN_FEATURES.
 * Baseline (grandfathered) access is NOT a plan row — it is the
 * resolution services/adPlans.js computes for GRANDFATHERED rows.
 */

export const PLAN_TIERS = [
  {
    key: 'starter',
    name: 'Starter',
    description: 'Run your first mini-banner campaigns on the Top Speed surfaces.',
    sortOrder: 1,
    features: { campaigns: true, display: true, streaming: false, aiDrafter: false, attribution: false, loopView: false, creativePicker: false },
    limits: { maxCampaigns: 3, channels: ['DISPLAY'] },
  },
  {
    key: 'growth',
    name: 'Growth',
    description: 'More campaigns, the creative picker, and attribution — see which ads bring bookings.',
    sortOrder: 2,
    features: { campaigns: true, display: true, streaming: false, aiDrafter: false, attribution: true, loopView: false, creativePicker: true },
    limits: { maxCampaigns: 10, channels: ['DISPLAY'] },
  },
  {
    key: 'pro',
    name: 'Pro',
    description: 'The full Flywheel platform: unlimited campaigns, the Streaming Ads channel, the Speedy AI copy drafter and the Flywheel loop view.',
    sortOrder: 3,
    features: { campaigns: true, display: true, streaming: true, aiDrafter: true, attribution: true, loopView: true, creativePicker: true },
    limits: { maxCampaigns: null, channels: ['DISPLAY', 'STREAMING'] },
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
    monthlyPriceCents: row.monthlyPriceCents ?? null,
    currency: row.currency || 'usd',
    features: row.features && typeof row.features === 'object' ? row.features : {},
    limits: row.limits && typeof row.limits === 'object' ? row.limits : {},
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
    currentPeriodEnd: iso(row.currentPeriodEnd),
    pastDueAt: iso(row.pastDueAt),
    pendingPlanId: row.pendingPlanId ?? null,
    pendingEffectiveAt: iso(row.pendingEffectiveAt),
    cancelAtPeriodEnd: Boolean(row.cancelAtPeriodEnd),
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
      monthlyPriceCents: null, currency: 'usd',
      features: { ...tier.features }, limits: { ...tier.limits },
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
        stripeCustomerId: null, stripeSubscriptionId: null, currentPeriodEnd: null,
        pastDueAt: null, pendingPlanId: null, pendingEffectiveAt: null,
        cancelAtPeriodEnd: false, grantedById: null, grantedAt: null,
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
    const rows = await db().adPlan.findMany({ orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
    return rows.map(toPlan);
  },
  async createPlan(tier) {
    const row = await db().adPlan.create({
      data: {
        key: tier.key, name: tier.name, description: tier.description ?? null,
        monthlyPriceCents: null, currency: 'usd',
        features: tier.features, limits: tier.limits,
        isActive: true, sortOrder: tier.sortOrder ?? 0,
      },
    });
    return toPlan(row);
  },
  async updatePlan(id, data) {
    const row = await db().adPlan.update({ where: { id }, data });
    return toPlan(row);
  },
  async getSubscriptionByUserId(userId) {
    const row = await db().advertiserSubscription.findUnique({ where: { userId } });
    return toSubscription(row);
  },
  async getSubscriptionByStripeSubscriptionId(stripeSubscriptionId) {
    if (!stripeSubscriptionId) return null;
    const row = await db().advertiserSubscription.findFirst({ where: { stripeSubscriptionId } });
    return toSubscription(row);
  },
  async upsertSubscription(userId, data) {
    const row = await db().advertiserSubscription.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
    return toSubscription(row);
  },
  async listSubscriptions() {
    const rows = await db().advertiserSubscription.findMany({
      orderBy: { updatedAt: 'desc' },
      include: { user: { select: { email: true, firstName: true, lastName: true, roles: true } } },
    });
    return rows.map(toSubscription);
  },
  async getSetting() {
    const row = await db().adBillingSetting.findUnique({ where: { id: 'default' } });
    if (!row) return { id: 'default', graceDays: 7, updatedBy: null };
    return { id: row.id, graceDays: row.graceDays, updatedBy: row.updatedBy ?? null };
  },
  async updateSetting(graceDays, updatedBy) {
    const row = await db().adBillingSetting.upsert({
      where: { id: 'default' },
      create: { id: 'default', graceDays, updatedBy: updatedBy ?? null },
      update: { graceDays, updatedBy: updatedBy ?? null },
    });
    return { id: row.id, graceDays: row.graceDays, updatedBy: row.updatedBy ?? null };
  },
};

const repo = DATABASE_ENABLED ? prismaRepo : memoryRepo;

/** Idempotent tier seed: creates Starter / Growth / Pro (prices UNSET) only when no plans exist. */
export async function ensureSeedPlans() {
  const existing = await repo.listPlans();
  if (existing.length) return existing;
  const created = [];
  for (const tier of PLAN_TIERS) created.push(await repo.createPlan(tier));
  return created;
}

export async function listPlans() {
  await ensureSeedPlans();
  return repo.listPlans();
}

export async function getPlanByKey(key) {
  const plans = await listPlans();
  return plans.find((p) => p.key === key) || null;
}

export async function getPlanById(id) {
  if (!id) return null;
  const plans = await listPlans();
  return plans.find((p) => p.id === id) || null;
}

export async function updatePlan(id, data) {
  return repo.updatePlan(id, data);
}

export async function getSubscriptionByUserId(userId) {
  return repo.getSubscriptionByUserId(userId);
}

export async function getSubscriptionByStripeSubscriptionId(stripeSubscriptionId) {
  return repo.getSubscriptionByStripeSubscriptionId(stripeSubscriptionId);
}

export async function upsertSubscription(userId, data) {
  return repo.upsertSubscription(userId, data);
}

export async function listSubscriptions() {
  return repo.listSubscriptions();
}

export async function getBillingSetting() {
  return repo.getSetting();
}

export async function updateBillingSetting(graceDays, updatedBy) {
  return repo.updateSetting(graceDays, updatedBy);
}
