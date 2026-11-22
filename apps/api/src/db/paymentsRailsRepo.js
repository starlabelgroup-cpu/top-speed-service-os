import { createId } from '../data/store.js';
import { DATABASE_ENABLED, db } from './client.js';
import { PL_DATABASE_ENABLED, plDb } from './plClient.js';

/**
 * New money rails — repository (2026-11-20, Wave 4).
 *
 * Same dual-mode discipline as adPlansRepo / pepperListsCrossPostsRepo:
 * Prisma when DATABASE_URL is set, an in-memory fallback with
 * identical shapes when it is not (the Phase-1 skeleton).
 *
 * Invariants enforced here:
 *  - The PaymentsSetting singleton starts with Connect OFF, the fee
 *    NULL and gift card denominations EMPTY. Nothing in this file
 *    ever writes a fee, a denomination, or the activation flag —
 *    those are written only by the owner's settings route.
 *  - A gift card's balance never goes negative: redemption runs in
 *    a transaction and re-checks the live balance inside it.
 *  - Gift card codes are looked up by SHA-256 hash only; the raw
 *    code never reaches this layer.
 */

function iso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function toSetting(row) {
  if (!row) return { id: 'default', connectEnabled: false, connectFeeBps: null, giftCardDenominationsCents: [], updatedBy: null };
  const denoms = Array.isArray(row.giftCardDenominationsCents) ? row.giftCardDenominationsCents : [];
  return {
    id: row.id,
    connectEnabled: Boolean(row.connectEnabled),
    connectFeeBps: row.connectFeeBps ?? null,
    giftCardDenominationsCents: denoms.filter((n) => Number.isInteger(n) && n > 0),
    updatedBy: row.updatedBy ?? null,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function toConnectAccount(row) {
  if (!row) return null;
  return {
    id: row.id,
    companyId: row.companyId,
    userId: row.userId,
    stripeAccountId: row.stripeAccountId ?? null,
    status: row.status || 'NOT_STARTED',
    chargesEnabled: Boolean(row.chargesEnabled),
    payoutsEnabled: Boolean(row.payoutsEnabled),
    detailsSubmitted: Boolean(row.detailsSubmitted),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function toOrder(row) {
  if (!row) return null;
  return {
    id: row.id,
    companyId: row.companyId,
    listingConnectionId: row.listingConnectionId,
    listingReference: row.listingReference,
    sellerUserId: row.sellerUserId,
    buyerUserId: row.buyerUserId ?? null,
    buyerEmail: row.buyerEmail ?? null,
    amountCents: row.amountCents,
    feeCents: row.feeCents ?? 0,
    currency: row.currency || 'usd',
    status: row.status || 'PENDING',
    stripeSessionId: row.stripeSessionId ?? null,
    stripePaymentIntentId: row.stripePaymentIntentId ?? null,
    sellerStripeAccountId: row.sellerStripeAccountId ?? null,
    checkoutUrl: row.checkoutUrl ?? null,
    paidAt: iso(row.paidAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function toGiftCard(row) {
  if (!row) return null;
  return {
    id: row.id,
    companyId: row.companyId,
    codeHash: row.codeHash,
    codeLast4: row.codeLast4,
    initialAmountCents: row.initialAmountCents,
    balanceCents: row.balanceCents ?? 0,
    currency: row.currency || 'usd',
    status: row.status || 'PENDING',
    purchaserUserId: row.purchaserUserId ?? null,
    purchaserEmail: row.purchaserEmail ?? null,
    recipientEmail: row.recipientEmail ?? null,
    stripeSessionId: row.stripeSessionId ?? null,
    stripePaymentIntentId: row.stripePaymentIntentId ?? null,
    checkoutUrl: row.checkoutUrl ?? null,
    issuedAt: iso(row.issuedAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function toLedgerEntry(row) {
  if (!row) return null;
  return {
    id: row.id,
    giftCardId: row.giftCardId,
    kind: row.kind,
    amountCents: row.amountCents,
    balanceAfterCents: row.balanceAfterCents,
    bookingId: row.bookingId ?? null,
    paymentId: row.paymentId ?? null,
    note: row.note ?? null,
    createdById: row.createdById ?? null,
    createdAt: iso(row.createdAt),
  };
}

// ---------------------------------------------------------------------------
// In-memory fallback (Phase-1 skeleton: no DATABASE_URL).
// ---------------------------------------------------------------------------
let memorySetting = null;
const memoryConnectAccounts = [];
const memoryOrders = [];
const memoryGiftCards = [];
const memoryLedger = [];

const memoryRepo = {
  async getSetting() {
    return toSetting(memorySetting);
  },
  async updateSetting(data, updatedBy) {
    const now = new Date().toISOString();
    if (!memorySetting) {
      memorySetting = {
        id: 'default', connectEnabled: false, connectFeeBps: null,
        giftCardDenominationsCents: [], updatedBy: null, createdAt: now, updatedAt: now,
      };
    }
    Object.assign(memorySetting, data, { updatedBy: updatedBy ?? null, updatedAt: now });
    return toSetting(memorySetting);
  },

  async getConnectAccountByUserId(userId) {
    return toConnectAccount(memoryConnectAccounts.find((a) => a.userId === userId) || null);
  },
  async upsertConnectAccount(userId, data) {
    let row = memoryConnectAccounts.find((a) => a.userId === userId);
    const now = new Date().toISOString();
    if (!row) {
      row = {
        id: createId(), companyId: data.companyId, userId, stripeAccountId: null,
        status: 'NOT_STARTED', chargesEnabled: false, payoutsEnabled: false,
        detailsSubmitted: false, createdAt: now, updatedAt: now,
      };
      memoryConnectAccounts.push(row);
    }
    Object.assign(row, data, { updatedAt: now });
    return toConnectAccount(row);
  },

  async createOrder(data) {
    const now = new Date().toISOString();
    const row = { id: createId(), status: 'PENDING', paidAt: null, createdAt: now, updatedAt: now, ...data };
    memoryOrders.push(row);
    return toOrder(row);
  },
  async getOrderById(id) {
    return toOrder(memoryOrders.find((o) => o.id === id) || null);
  },
  async getOrderBySessionId(sessionId) {
    if (!sessionId) return null;
    return toOrder(memoryOrders.find((o) => o.stripeSessionId === sessionId) || null);
  },
  async updateOrder(id, data) {
    const row = memoryOrders.find((o) => o.id === id);
    if (!row) return null;
    Object.assign(row, data, { updatedAt: new Date().toISOString() });
    return toOrder(row);
  },
  async findOrderForListing(listingConnectionId, statuses) {
    const rows = memoryOrders
      .filter((o) => o.listingConnectionId === listingConnectionId && statuses.includes(o.status))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return toOrder(rows[0] || null);
  },
  async listOrdersForUser(userId) {
    return memoryOrders
      .filter((o) => o.buyerUserId === userId || o.sellerUserId === userId)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .map(toOrder);
  },

  async createGiftCard(data) {
    const now = new Date().toISOString();
    const row = { id: createId(), status: 'PENDING', balanceCents: 0, issuedAt: null, createdAt: now, updatedAt: now, ...data };
    memoryGiftCards.push(row);
    return toGiftCard(row);
  },
  async getGiftCardById(id) {
    return toGiftCard(memoryGiftCards.find((c) => c.id === id) || null);
  },
  async getGiftCardByHash(codeHash) {
    return toGiftCard(memoryGiftCards.find((c) => c.codeHash === codeHash) || null);
  },
  async getGiftCardBySessionId(sessionId) {
    if (!sessionId) return null;
    return toGiftCard(memoryGiftCards.find((c) => c.stripeSessionId === sessionId) || null);
  },
  async updateGiftCard(id, data) {
    const row = memoryGiftCards.find((c) => c.id === id);
    if (!row) return null;
    Object.assign(row, data, { updatedAt: new Date().toISOString() });
    return toGiftCard(row);
  },
  async listGiftCardsForPurchaser(userId) {
    return memoryGiftCards
      .filter((c) => c.purchaserUserId === userId)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .map(toGiftCard);
  },
  async addLedgerEntry(data) {
    const row = { id: createId(), createdAt: new Date().toISOString(), ...data };
    memoryLedger.push(row);
    return toLedgerEntry(row);
  },
  async listLedgerForCard(giftCardId) {
    return memoryLedger
      .filter((e) => e.giftCardId === giftCardId)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      .map(toLedgerEntry);
  },
  async sumRedeemedForBooking(bookingId) {
    return memoryLedger
      .filter((e) => e.kind === 'REDEEM' && e.bookingId === bookingId)
      .reduce((sum, e) => sum - e.amountCents, 0);
  },
  async redeemGiftCard({ giftCardId, amountCents, bookingId, createdById, note }) {
    const card = memoryGiftCards.find((c) => c.id === giftCardId);
    if (!card || card.status !== 'ACTIVE') return { ok: false, reason: 'not_active' };
    if (!Number.isInteger(amountCents) || amountCents <= 0) return { ok: false, reason: 'bad_amount' };
    if (amountCents > card.balanceCents) return { ok: false, reason: 'insufficient_balance' };
    card.balanceCents -= amountCents;
    if (card.balanceCents === 0) card.status = 'DEPLETED';
    card.updatedAt = new Date().toISOString();
    const entry = {
      id: createId(), giftCardId, kind: 'REDEEM', amountCents: -amountCents,
      balanceAfterCents: card.balanceCents, bookingId: bookingId ?? null,
      paymentId: null, note: note ?? null, createdById: createdById ?? null,
      createdAt: new Date().toISOString(),
    };
    memoryLedger.push(entry);
    return { ok: true, card: toGiftCard(card), entry: toLedgerEntry(entry) };
  },
};

// ---------------------------------------------------------------------------
// Prisma repository.
// ---------------------------------------------------------------------------
const prismaRepo = {
  async getSetting() {
    const row = await db().paymentsSetting.findUnique({ where: { id: 'default' } });
    return toSetting(row);
  },
  async updateSetting(data, updatedBy) {
    const row = await db().paymentsSetting.upsert({
      where: { id: 'default' },
      create: { id: 'default', ...data, updatedBy: updatedBy ?? null },
      update: { ...data, updatedBy: updatedBy ?? null },
    });
    return toSetting(row);
  },

  async getConnectAccountByUserId(userId) {
    const row = await plDb().sellerConnectAccount.findUnique({ where: { userId } });
    return toConnectAccount(row);
  },
  async upsertConnectAccount(userId, data) {
    const row = await plDb().sellerConnectAccount.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
    return toConnectAccount(row);
  },

  async createOrder(data) {
    const row = await plDb().pepperListsOrder.create({ data });
    return toOrder(row);
  },
  async getOrderById(id) {
    const row = await plDb().pepperListsOrder.findUnique({ where: { id } });
    return toOrder(row);
  },
  async getOrderBySessionId(sessionId) {
    if (!sessionId) return null;
    const row = await plDb().pepperListsOrder.findUnique({ where: { stripeSessionId: sessionId } });
    return toOrder(row);
  },
  async updateOrder(id, data) {
    const row = await plDb().pepperListsOrder.update({ where: { id }, data });
    return toOrder(row);
  },
  async findOrderForListing(listingConnectionId, statuses) {
    const row = await plDb().pepperListsOrder.findFirst({
      where: { listingConnectionId, status: { in: statuses } },
      orderBy: { createdAt: 'desc' },
    });
    return toOrder(row);
  },
  async listOrdersForUser(userId) {
    const rows = await plDb().pepperListsOrder.findMany({
      where: { OR: [{ buyerUserId: userId }, { sellerUserId: userId }] },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toOrder);
  },

  async createGiftCard(data) {
    const row = await db().giftCard.create({ data });
    return toGiftCard(row);
  },
  async getGiftCardById(id) {
    const row = await db().giftCard.findUnique({ where: { id } });
    return toGiftCard(row);
  },
  async getGiftCardByHash(codeHash) {
    const row = await db().giftCard.findUnique({ where: { codeHash } });
    return toGiftCard(row);
  },
  async getGiftCardBySessionId(sessionId) {
    if (!sessionId) return null;
    const row = await db().giftCard.findUnique({ where: { stripeSessionId: sessionId } });
    return toGiftCard(row);
  },
  async updateGiftCard(id, data) {
    const row = await db().giftCard.update({ where: { id }, data });
    return toGiftCard(row);
  },
  async listGiftCardsForPurchaser(userId) {
    const rows = await db().giftCard.findMany({
      where: { purchaserUserId: userId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toGiftCard);
  },
  async addLedgerEntry(data) {
    const row = await db().giftCardLedgerEntry.create({ data });
    return toLedgerEntry(row);
  },
  async listLedgerForCard(giftCardId) {
    const rows = await db().giftCardLedgerEntry.findMany({
      where: { giftCardId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toLedgerEntry);
  },
  async sumRedeemedForBooking(bookingId) {
    const agg = await db().giftCardLedgerEntry.aggregate({
      where: { kind: 'REDEEM', bookingId },
      _sum: { amountCents: true },
    });
    return -(agg._sum.amountCents || 0);
  },
  /**
   * The one place a gift card balance moves down. Runs in a
   * transaction and re-reads the card inside it, so two redemptions
   * racing the same card can never push the balance below zero:
   * the second one re-checks against the first one's result.
   */
  async redeemGiftCard({ giftCardId, amountCents, bookingId, createdById, note }) {
    return db().$transaction(async (tx) => {
      const card = await tx.giftCard.findUnique({ where: { id: giftCardId } });
      if (!card || card.status !== 'ACTIVE') return { ok: false, reason: 'not_active' };
      if (!Number.isInteger(amountCents) || amountCents <= 0) return { ok: false, reason: 'bad_amount' };
      if (amountCents > card.balanceCents) return { ok: false, reason: 'insufficient_balance' };
      const balanceAfterCents = card.balanceCents - amountCents;
      const updated = await tx.giftCard.update({
        where: { id: giftCardId },
        data: {
          balanceCents: balanceAfterCents,
          status: balanceAfterCents === 0 ? 'DEPLETED' : card.status,
        },
      });
      const entry = await tx.giftCardLedgerEntry.create({
        data: {
          giftCardId, kind: 'REDEEM', amountCents: -amountCents, balanceAfterCents,
          bookingId: bookingId ?? null, note: note ?? null, createdById: createdById ?? null,
        },
      });
      return { ok: true, card: toGiftCard(updated), entry: toLedgerEntry(entry) };
    });
  },
};

// Pepper Lists orders + seller connect accounts live in the Pepper
// Lists database (plDb — which falls back to the main client until
// PL_DATABASE_URL is set); the payments setting and gift cards are
// platform records and stay on the main client.
const repo = DATABASE_ENABLED || PL_DATABASE_ENABLED ? prismaRepo : memoryRepo;

export async function getPaymentsSetting() {
  return repo.getSetting();
}

export async function updatePaymentsSetting(data, updatedBy) {
  return repo.updateSetting(data, updatedBy);
}

export async function getConnectAccountByUserId(userId) {
  return repo.getConnectAccountByUserId(userId);
}

export async function upsertConnectAccount(userId, data) {
  return repo.upsertConnectAccount(userId, data);
}

export async function createOrder(data) {
  return repo.createOrder(data);
}

export async function getOrderById(id) {
  return repo.getOrderById(id);
}

export async function getOrderBySessionId(sessionId) {
  return repo.getOrderBySessionId(sessionId);
}

export async function updateOrder(id, data) {
  return repo.updateOrder(id, data);
}

export async function findOrderForListing(listingConnectionId, statuses) {
  return repo.findOrderForListing(listingConnectionId, statuses);
}

export async function listOrdersForUser(userId) {
  return repo.listOrdersForUser(userId);
}

export async function createGiftCard(data) {
  return repo.createGiftCard(data);
}

export async function getGiftCardById(id) {
  return repo.getGiftCardById(id);
}

export async function getGiftCardByHash(codeHash) {
  return repo.getGiftCardByHash(codeHash);
}

export async function getGiftCardBySessionId(sessionId) {
  return repo.getGiftCardBySessionId(sessionId);
}

export async function updateGiftCard(id, data) {
  return repo.updateGiftCard(id, data);
}

export async function listGiftCardsForPurchaser(userId) {
  return repo.listGiftCardsForPurchaser(userId);
}

export async function addLedgerEntry(data) {
  return repo.addLedgerEntry(data);
}

export async function listLedgerForCard(giftCardId) {
  return repo.listLedgerForCard(giftCardId);
}

export async function sumRedeemedForBooking(bookingId) {
  return repo.sumRedeemedForBooking(bookingId);
}

export async function redeemGiftCard(args) {
  return repo.redeemGiftCard(args);
}
