import { createId } from '../data/store.js';
import { DATABASE_ENABLED, db } from './client.js';

/**
 * Top Speed Campaign Engine repository (2026-11-23). Same
 * dual-mode discipline as facebookOsRepo: Prisma when DATABASE_URL
 * is set, an in-memory fallback with identical shapes when it is
 * not.
 *
 * Invariants enforced here:
 *  - a campaign record is BORN in the status the factory assigned
 *    (DRAFT, QUEUED for social, STAGED for send lanes) — create()
 *    accepts only those three; nothing can mint an ACTIVE or sent
 *    state because the registry has no such state at all;
 *  - campaignKey is unique: batch generation is idempotent by
 *    construction — re-running a batch inserts only the keys that
 *    do not exist yet;
 *  - a batch row is written once per batchKey (unique), so a day's
 *    batch generates exactly once.
 */

function iso(value) {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function rowFromDb(row) {
  if (!row) return null;
  return { ...row, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) };
}

function batchFromDb(row) {
  if (!row) return null;
  return { ...row, generatedAt: iso(row.generatedAt) };
}

const BORN_STATUSES = ['DRAFT', 'QUEUED', 'STAGED'];
const EDITABLE = ['status', 'linkedRef', 'audienceNote'];

function pick(source, fields) {
  const out = {};
  for (const field of fields) {
    if (source[field] !== undefined) out[field] = source[field];
  }
  return out;
}

// ─── Prisma mode ──────────────────────────────────────────────────

const prismaRepo = {
  async insertMany(records) {
    let created = 0;
    for (const record of records) {
      const existing = await db().campaignRecord.findUnique({
        where: { campaignKey: record.campaignKey },
        select: { id: true },
      });
      if (existing) continue;
      await db().campaignRecord.create({
        data: {
          campaignKey: record.campaignKey,
          batchKey: record.batchKey,
          name: record.name,
          division: record.division,
          surface: record.surface,
          audience: record.audience ?? null,
          audienceNote: record.audienceNote ?? null,
          angle: record.angle,
          subject: record.subject ?? null,
          copy: record.copy,
          creativeSpec: record.creativeSpec ?? undefined,
          landingUrl: record.landingUrl,
          sourceTag: record.sourceTag,
          status: BORN_STATUSES.includes(record.status) ? record.status : 'DRAFT',
          linkedRef: record.linkedRef ?? null,
          createdById: record.createdById ?? null,
        },
      });
      created += 1;
    }
    return created;
  },
  async findByKey(campaignKey) {
    return rowFromDb(await db().campaignRecord.findUnique({ where: { campaignKey } }));
  },
  async findById(id) {
    return rowFromDb(await db().campaignRecord.findUnique({ where: { id } }));
  },
  async update(id, data) {
    const row = await db().campaignRecord.update({ where: { id }, data: pick(data, EDITABLE) });
    return rowFromDb(row);
  },
  async list({ division, surface, status, batchKey, limit = 200 } = {}) {
    const where = {};
    if (division) where.division = division;
    if (surface) where.surface = surface;
    if (status) where.status = status;
    if (batchKey) where.batchKey = batchKey;
    const rows = await db().campaignRecord.findMany({
      where, orderBy: { createdAt: 'asc' }, take: Math.min(limit, 1000),
    });
    return rows.map(rowFromDb);
  },
  async counts() {
    const rows = await db().campaignRecord.findMany({
      select: { division: true, surface: true, status: true },
    });
    return rows;
  },
  async recordBatch(batch) {
    const existing = await db().campaignBatch.findUnique({ where: { batchKey: batch.batchKey } });
    if (existing) return batchFromDb(existing);
    return batchFromDb(await db().campaignBatch.create({
      data: {
        batchKey: batch.batchKey,
        kind: batch.kind,
        campaignCount: batch.campaignCount ?? 0,
        socialQueued: batch.socialQueued ?? 0,
      },
    }));
  },
  async findBatch(batchKey) {
    return batchFromDb(await db().campaignBatch.findUnique({ where: { batchKey } }));
  },
  async listBatches(limit = 50) {
    const rows = await db().campaignBatch.findMany({
      orderBy: { generatedAt: 'desc' }, take: Math.min(limit, 200),
    });
    return rows.map(batchFromDb);
  },
};

// ─── In-memory mode ───────────────────────────────────────────────

const memoryRecords = [];
const memoryBatches = [];

const memoryRepo = {
  async insertMany(records) {
    let created = 0;
    for (const record of records) {
      if (memoryRecords.some((r) => r.campaignKey === record.campaignKey)) continue;
      const now = new Date().toISOString();
      memoryRecords.push({
        id: createId(),
        campaignKey: record.campaignKey,
        batchKey: record.batchKey,
        name: record.name,
        division: record.division,
        surface: record.surface,
        audience: record.audience ?? null,
        audienceNote: record.audienceNote ?? null,
        angle: record.angle,
        subject: record.subject ?? null,
        copy: record.copy,
        creativeSpec: record.creativeSpec ?? null,
        landingUrl: record.landingUrl,
        sourceTag: record.sourceTag,
        status: BORN_STATUSES.includes(record.status) ? record.status : 'DRAFT',
        linkedRef: record.linkedRef ?? null,
        createdById: record.createdById ?? null,
        createdAt: now,
        updatedAt: now,
      });
      created += 1;
    }
    return created;
  },
  async findByKey(campaignKey) {
    return memoryRecords.find((r) => r.campaignKey === campaignKey) || null;
  },
  async findById(id) {
    return memoryRecords.find((r) => r.id === id) || null;
  },
  async update(id, data) {
    const row = memoryRecords.find((r) => r.id === id);
    if (!row) return null;
    Object.assign(row, pick(data, EDITABLE), { updatedAt: new Date().toISOString() });
    return row;
  },
  async list({ division, surface, status, batchKey, limit = 200 } = {}) {
    return memoryRecords
      .filter((r) => (!division || r.division === division)
        && (!surface || r.surface === surface)
        && (!status || r.status === status)
        && (!batchKey || r.batchKey === batchKey))
      .slice(0, Math.min(limit, 1000));
  },
  async counts() {
    return memoryRecords.map((r) => ({ division: r.division, surface: r.surface, status: r.status }));
  },
  async recordBatch(batch) {
    const existing = memoryBatches.find((b) => b.batchKey === batch.batchKey);
    if (existing) return existing;
    const row = {
      id: createId(),
      batchKey: batch.batchKey,
      kind: batch.kind,
      campaignCount: batch.campaignCount ?? 0,
      socialQueued: batch.socialQueued ?? 0,
      generatedAt: new Date().toISOString(),
    };
    memoryBatches.push(row);
    return row;
  },
  async findBatch(batchKey) {
    return memoryBatches.find((b) => b.batchKey === batchKey) || null;
  },
  async listBatches(limit = 50) {
    return [...memoryBatches].reverse().slice(0, Math.min(limit, 200));
  },
};

export const campaignEngineRepo = DATABASE_ENABLED ? prismaRepo : memoryRepo;
