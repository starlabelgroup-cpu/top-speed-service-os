import { createId } from '../data/store.js';
import { PL_DB_AVAILABLE, plDb } from './plClient.js';

/**
 * Pepper Lists — Facebook cross-post queue repository (2026-11-20,
 * Phase A). Same dual-mode discipline as sellerChannelsRepo: Prisma
 * when DATABASE_URL is set, an in-memory fallback with identical
 * shapes when it is not.
 *
 * Invariants enforced here:
 *  - a row is born QUEUED — nothing in this repo (or anywhere in the
 *    server) posts to Facebook; Pepper executes queued rows through
 *    the owner's connected Facebook account behind Ramone's
 *    per-listing approval, and staff record the real outcome;
 *  - the only transitions are QUEUED → POSTED (with the real
 *    Facebook listing URL) and QUEUED → FAILED (with the real
 *    reason), recorded by markOutcome; a row that already has an
 *    outcome never changes again;
 *  - at most one QUEUED row per (connectionId, target) — the route
 *    checks findQueued first and this repo double-checks on create.
 */

const memoryRows = [];

const prismaRepo = {
  async create({ connectionId, listingReference, userId, target, pageId }) {
    const queued = await this.findQueued(connectionId, target);
    if (queued) return { row: queued, duplicate: true };
    const row = await plDb().pepperListsCrossPost.create({
      data: { connectionId, listingReference, userId, target, pageId: pageId ?? null },
    });
    return { row, duplicate: false };
  },
  async findQueued(connectionId, target) {
    return plDb().pepperListsCrossPost.findFirst({
      where: { connectionId, target, status: 'QUEUED' },
      orderBy: { createdAt: 'asc' },
    });
  },
  async listForConnection(connectionId) {
    return plDb().pepperListsCrossPost.findMany({
      where: { connectionId },
      orderBy: { createdAt: 'desc' },
    });
  },
  async listQueued(limit = 200) {
    return plDb().pepperListsCrossPost.findMany({
      where: { status: 'QUEUED' },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
  },
  async findById(id) {
    return plDb().pepperListsCrossPost.findUnique({ where: { id } });
  },
  async markOutcome(id, { status, externalId, externalUrl, error, outcomeById }) {
    const existing = await this.findById(id);
    if (!existing) return { row: null, conflict: false };
    if (existing.status !== 'QUEUED') return { row: existing, conflict: true };
    const row = await plDb().pepperListsCrossPost.update({
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
  async create({ connectionId, listingReference, userId, target, pageId }) {
    const queued = await this.findQueued(connectionId, target);
    if (queued) return { row: queued, duplicate: true };
    const now = new Date().toISOString();
    const row = {
      id: createId(), connectionId, listingReference, userId, target,
      pageId: pageId ?? null, status: 'QUEUED',
      externalId: null, externalUrl: null, error: null,
      outcomeById: null, postedAt: null,
      createdAt: now, updatedAt: now,
    };
    memoryRows.push(row);
    return { row, duplicate: false };
  },
  async findQueued(connectionId, target) {
    return memoryRows.find((r) => r.connectionId === connectionId && r.target === target && r.status === 'QUEUED') || null;
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

export const crossPostsRepo = PL_DB_AVAILABLE ? prismaRepo : memoryRepo;
