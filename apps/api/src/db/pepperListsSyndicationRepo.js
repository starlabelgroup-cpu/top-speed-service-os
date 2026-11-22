import { createId } from '../data/store.js';
import { PL_DB_AVAILABLE, plDb } from './plClient.js';

/**
 * Pepper Lists — Phase 2 syndication queue repository (2026-11-20,
 * recommendations program C16). The eBay + Google Shopping twin of
 * pepperListsCrossPostsRepo (Facebook, Phase A), with the same
 * dual-mode discipline: Prisma when DATABASE_URL is set, an
 * in-memory fallback with identical shapes when it is not.
 *
 * Invariants enforced here:
 *  - a row is born QUEUED — nothing in this repo (or anywhere in the
 *    server) posts to eBay or Google; the office completes the post
 *    through the SELLER'S OWN channel account once their Phase 1
 *    connection request is on file, and staff record the real
 *    outcome;
 *  - the only transitions are QUEUED → POSTED (with the real eBay
 *    listing URL, or the real Merchant Center product id/link) and
 *    QUEUED → FAILED (with the real reason), recorded by
 *    markOutcome; a row that already has an outcome never changes
 *    again;
 *  - at most one QUEUED row per (connectionId, channel) — the route
 *    checks findQueued first and this repo double-checks on create.
 */

const memoryRows = [];

const prismaRepo = {
  async create({ connectionId, listingReference, userId, channel }) {
    const queued = await this.findQueued(connectionId, channel);
    if (queued) return { row: queued, duplicate: true };
    const row = await plDb().pepperListsSyndication.create({
      data: { connectionId, listingReference, userId, channel },
    });
    return { row, duplicate: false };
  },
  async findQueued(connectionId, channel) {
    return plDb().pepperListsSyndication.findFirst({
      where: { connectionId, channel, status: 'QUEUED' },
      orderBy: { createdAt: 'asc' },
    });
  },
  async listForConnection(connectionId) {
    return plDb().pepperListsSyndication.findMany({
      where: { connectionId },
      orderBy: { createdAt: 'desc' },
    });
  },
  async listQueued(limit = 200) {
    return plDb().pepperListsSyndication.findMany({
      where: { status: 'QUEUED' },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
  },
  async findById(id) {
    return plDb().pepperListsSyndication.findUnique({ where: { id } });
  },
  async markOutcome(id, { status, externalId, externalUrl, error, outcomeById }) {
    const existing = await this.findById(id);
    if (!existing) return { row: null, conflict: false };
    if (existing.status !== 'QUEUED') return { row: existing, conflict: true };
    const row = await plDb().pepperListsSyndication.update({
      where: { id },
      data: {
        status,
        externalId: externalId ?? null,
        externalUrl: externalUrl ?? null,
        error: error ?? null,
        outcomeById: outcomeById ?? null,
        postedAt: status === 'POSTED' ? new Date() : null,
      },
    });
    return { row, conflict: false };
  },
};

const memoryRepo = {
  async create({ connectionId, listingReference, userId, channel }) {
    const queued = await this.findQueued(connectionId, channel);
    if (queued) return { row: queued, duplicate: true };
    const now = new Date().toISOString();
    const row = {
      id: createId(), connectionId, listingReference, userId, channel,
      status: 'QUEUED',
      externalId: null, externalUrl: null, error: null,
      outcomeById: null, postedAt: null,
      createdAt: now, updatedAt: now,
    };
    memoryRows.push(row);
    return { row, duplicate: false };
  },
  async findQueued(connectionId, channel) {
    return memoryRows.find((r) => r.connectionId === connectionId && r.channel === channel && r.status === 'QUEUED') || null;
  },
  async listForConnection(connectionId) {
    return memoryRows
      .filter((r) => r.connectionId === connectionId)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  },
  async listQueued(limit = 200) {
    return memoryRows
      .filter((r) => r.status === 'QUEUED')
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      .slice(0, limit);
  },
  async findById(id) {
    return memoryRows.find((r) => r.id === id) || null;
  },
  async markOutcome(id, { status, externalId, externalUrl, error, outcomeById }) {
    const row = memoryRows.find((r) => r.id === id);
    if (!row) return { row: null, conflict: false };
    if (row.status !== 'QUEUED') return { row, conflict: true };
    row.status = status;
    row.externalId = externalId ?? null;
    row.externalUrl = externalUrl ?? null;
    row.error = error ?? null;
    row.outcomeById = outcomeById ?? null;
    row.postedAt = status === 'POSTED' ? new Date().toISOString() : null;
    row.updatedAt = new Date().toISOString();
    return { row, conflict: false };
  },
};

export const syndicationRepo = PL_DB_AVAILABLE ? prismaRepo : memoryRepo;
