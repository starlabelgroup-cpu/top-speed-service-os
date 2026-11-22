import { createId } from '../data/store.js';
import { PL_DB_AVAILABLE, plDb } from './plClient.js';

/**
 * Pepper Lists Seller Plans — repository (2026-11-20).
 *
 * The structural mirror of db/adPlansRepo.js (Flywheel Advertiser
 * Plans): Prisma when DATABASE_URL is set, an in-memory fallback with
 * identical shapes when it is not. The tier STRUCTURE is seeded here —
 * three plans with monthlyPriceCents NULL. Prices are owner-configured
 * in the seller-plans admin (routes/sellerPlans.js) and only there;
 * nothing in this file ever writes a price or a Stripe id.
 *
 * The feature matrix keys are services/sellerPlans.js
 * SELLER_PLAN_FEATURES. The Free tier's limits ARE today's Pepper
 * Lists behavior (4 photos per listing, no featured placement, no
 * bumps) — so a seller who never touches plans sees no change at all.
 */

export const SELLER_PLAN_TIERS = [
  {
    key: 'free',
    name: 'Free',
    description: 'List on Pepper Lists the way it works today — photo listings Pepper posts for you after your confirm tap.',
    sortOrder: 1,
    features: { featured: false, bump: false, analytics: false, storefront: false },
    limits: { maxPhotos: 4, bumpsPerMonth: 0, featuredListings: 0 },
  },
  {
    key: 'featured',
    name: 'Featured Seller',
    description: 'Featured placement with the Featured badge and top-of-grid sorting, monthly listing bumps, up to 8 photos per listing, and your public seller storefront.',
    sortOrder: 2,
    features: { featured: true, bump: true, analytics: false, storefront: true },
    limits: { maxPhotos: 8, bumpsPerMonth: 4, featuredListings: 3 },
  },
  {
    key: 'pro',
    name: 'Pro Seller',
    description: 'Everything in Featured Seller, plus unlimited bumps and featured listings, up to 12 photos per listing, and the seller analytics panel — real views, comments and sales.',
    sortOrder: 3,
    features: { featured: true, bump: true, analytics: true, storefront: true },
    limits: { maxPhotos: 12, bumpsPerMonth: null, featuredListings: null },
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
};

// ---------------------------------------------------------------------------
// Prisma repository.
// ---------------------------------------------------------------------------
const prismaRepo = {
  async listPlans() {
    const rows = await plDb().sellerPlan.findMany({ orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
    return rows.map(toPlan);
  },
  async createPlan(tier) {
    const row = await plDb().sellerPlan.create({
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
    const row = await plDb().sellerPlan.update({ where: { id }, data });
    return toPlan(row);
  },
  async getSubscriptionByUserId(userId) {
    const row = await plDb().sellerSubscription.findUnique({ where: { userId } });
    return toSubscription(row);
  },
  async getSubscriptionByStripeSubscriptionId(stripeSubscriptionId) {
    if (!stripeSubscriptionId) return null;
    const row = await plDb().sellerSubscription.findFirst({ where: { stripeSubscriptionId } });
    return toSubscription(row);
  },
  async upsertSubscription(userId, data) {
    const row = await plDb().sellerSubscription.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
    return toSubscription(row);
  },
  async listSubscriptions() {
    const rows = await plDb().sellerSubscription.findMany({
      orderBy: { updatedAt: 'desc' },
      include: { user: { select: { email: true, firstName: true, lastName: true, roles: true } } },
    });
    return rows.map(toSubscription);
  },
};

const repo = PL_DB_AVAILABLE ? prismaRepo : memoryRepo;

/** Idempotent tier seed: creates Free / Featured Seller / Pro Seller (prices UNSET) only when no plans exist. */
export async function ensureSeedSellerPlans() {
  const existing = await repo.listPlans();
  if (existing.length) return existing;
  const created = [];
  for (const tier of SELLER_PLAN_TIERS) created.push(await repo.createPlan(tier));
  return created;
}

export async function listSellerPlans() {
  await ensureSeedSellerPlans();
  return repo.listPlans();
}

export async function getSellerPlanByKey(key) {
  const plans = await listSellerPlans();
  return plans.find((p) => p.key === key) || null;
}

export async function getSellerPlanById(id) {
  if (!id) return null;
  const plans = await listSellerPlans();
  return plans.find((p) => p.id === id) || null;
}

export async function updateSellerPlan(id, data) {
  return repo.updatePlan(id, data);
}

export async function getSellerSubscriptionByUserId(userId) {
  return repo.getSubscriptionByUserId(userId);
}

export async function getSellerSubscriptionByStripeSubscriptionId(stripeSubscriptionId) {
  return repo.getSubscriptionByStripeSubscriptionId(stripeSubscriptionId);
}

export async function upsertSellerSubscription(userId, data) {
  return repo.upsertSubscription(userId, data);
}

export async function listSellerSubscriptions() {
  return repo.listSubscriptions();
}
