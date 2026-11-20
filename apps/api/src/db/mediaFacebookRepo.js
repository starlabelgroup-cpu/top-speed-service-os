import { createId } from '../data/store.js';
import { DATABASE_ENABLED, db } from './client.js';

/**
 * Media OS → Facebook Page publish queue repository (2026-11-20,
 * Wave 3 E6). Same dual-mode discipline as pepperListsCrossPostsRepo:
 * Prisma when DATABASE_URL is set, an in-memory fallback with
 * identical shapes when it is not.
 *
 * Invariants enforced here:
 *  - a row is born QUEUED — nothing in this repo (or anywhere in the
 *    server) posts to Facebook; Pepper executes queued rows through
 *    the owner's connected Facebook account behind Ramone's approval,
 *    and staff record the real outcome;
 *  - the only transitions are QUEUED → POSTED (with the real
 *    facebook.com post URL) and QUEUED → FAILED (with the real
 *    reason), recorded by markOutcome; a row that already has an
 *    outcome never changes again;
 *  - at most one QUEUED row per contentId — the service checks
 *    findQueued first and this repo double-checks on create.
 */

const memoryRows = [];

function rowFromDb(row) {
  if (!row) return null;
  return {
    ...row,
    postedAt: row.postedAt instanceof Date ? row.postedAt.toISOString() : (row.postedAt ?? null),
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
  };
}

const prismaRepo = {
  async create(data) {
    const queued = await this.findQueued(data.contentId);
    if (queued) return { row: rowFromDb(queued), duplicate: true };
    const row = await db().mediaFacebookPost.create({ data });
    return { row: rowFromDb(row), duplicate: false };
  },
  async findQueued(contentId) {
    return db().mediaFacebookPost.findFirst({
      where: { contentId, status: 'QUEUED' },
      orderBy: { createdAt: 'asc' },
    });
  },
  async listForContent(contentId) {
    const rows = await db().mediaFacebookPost.findMany({
      where: { contentId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(rowFromDb);
  },
  async listQueue(limit = 200) {
    const rows = await db().mediaFacebookPost.findMany({
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: limit,
    });
    return rows.map(rowFromDb);
  },
  async findById(id) {
    return rowFromDb(await db().mediaFacebookPost.findUnique({ where: { id } }));
  },
  async markOutcome(id, { status, externalId, externalUrl, error, outcomeById }) {
    const existing = await this.findById(id);
    if (!existing) return { row: null, conflict: false };
    if (existing.status !== 'QUEUED') return { row: existing, conflict: true };
    const row = await db().mediaFacebookPost.update({
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
    return { row: rowFromDb(row), conflict: false };
  },
};

const memoryRepo = {
  async create(data) {
    const queued = await this.findQueued(data.contentId);
    if (queued) return { row: queued, duplicate: true };
    const now = new Date().toISOString();
    const row = {
      id: createId(),
      contentId: data.contentId,
      contentSlug: data.contentSlug,
      pageId: data.pageId,
      pageName: data.pageName,
      message: data.message,
      linkUrl: data.linkUrl ?? null,
      imageUrl: data.imageUrl ?? null,
      status: 'QUEUED',
      externalId: null, externalUrl: null, error: null,
      outcomeById: null, postedAt: null,
      createdAt: now, updatedAt: now,
    };
    memoryRows.push(row);
    return { row, duplicate: false };
  },
  async findQueued(contentId) {
    return memoryRows.find((r) => r.contentId === contentId && r.status === 'QUEUED') || null;
  },
  async listForContent(contentId) {
    return memoryRows
      .filter((r) => r.contentId === contentId)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  },
  async listQueue(limit = 200) {
    const rank = { QUEUED: 0, POSTED: 1, FAILED: 2 };
    return [...memoryRows]
      .sort((a, b) => (rank[a.status] - rank[b.status]) || String(b.createdAt).localeCompare(String(a.createdAt)))
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

export const mediaFacebookRepo = DATABASE_ENABLED ? prismaRepo : memoryRepo;
