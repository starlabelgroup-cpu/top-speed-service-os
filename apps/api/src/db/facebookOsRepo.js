import { createId } from '../data/store.js';
import { DATABASE_ENABLED, db } from './client.js';

/**
 * Top Speed Facebook OS Manager repository (2026-11-23). Same
 * dual-mode discipline as mediaFacebookRepo: Prisma when DATABASE_URL
 * is set, an in-memory fallback with identical shapes when it is not.
 *
 * Invariants enforced here:
 *  - a stream post is BORN a DRAFT — create() forces the status, so
 *    no caller can mint a SCHEDULED or POSTED row directly;
 *  - status changes happen only through transition(), which the
 *    service (services/facebookOs.js) validates against the lifecycle
 *    first — including the rule that POSTED requires the real
 *    facebook.com post URL (the MediaFacebookPost / Pepper Lists
 *    cross-post honesty rule);
 *  - ad drafts are planning records only: nothing in this repo (or
 *    anywhere in the server) creates, enables, or funds a Meta ad —
 *    Meta has API writes disabled on the connected account, and
 *    spend figures are staff-recorded, never imported.
 */

function iso(value) {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function rowFromDb(row) {
  if (!row) return null;
  return {
    ...row,
    scheduledFor: iso(row.scheduledFor),
    postedAt: iso(row.postedAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

const POST_EDITABLE = [
  'seriesKey', 'seriesWeek', 'format', 'title', 'copy', 'mediaUrl', 'mediaKind',
  'linkUrl', 'pageId', 'pageName', 'scheduledFor', 'statusNote',
];
const AD_EDITABLE = [
  'name', 'objective', 'audience', 'headline', 'copy', 'ctaText', 'creativeRef',
  'destinationUrl', 'budgetCents', 'recordedSpendCents', 'status', 'metaCampaignId',
  'metaDeepLink', 'streamPostId', 'notes',
];

function pick(source, fields) {
  const out = {};
  for (const field of fields) {
    if (source[field] !== undefined) out[field] = source[field];
  }
  return out;
}

function toDate(value) {
  if (value == null) return null;
  return value instanceof Date ? value : new Date(value);
}

// ─── Prisma mode ────────────────────────────────────────────────────

const prismaPosts = {
  async create(data) {
    const row = await db().facebookStreamPost.create({
      data: {
        ...pick(data, POST_EDITABLE),
        scheduledFor: data.scheduledFor ? toDate(data.scheduledFor) : null,
        status: 'DRAFT',
        createdById: data.createdById ?? null,
      },
    });
    return rowFromDb(row);
  },
  async findById(id) {
    return rowFromDb(await db().facebookStreamPost.findUnique({ where: { id } }));
  },
  async findSeriesInstallment(seriesKey, seriesWeek, format, title) {
    return rowFromDb(await db().facebookStreamPost.findFirst({
      where: { seriesKey, seriesWeek, format, title },
    }));
  },
  async list({ status, seriesKey, limit = 200 } = {}) {
    const where = {};
    if (status) where.status = status;
    if (seriesKey) where.seriesKey = seriesKey;
    const rows = await db().facebookStreamPost.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map(rowFromDb);
  },
  async listPosted(limit = 20) {
    const rows = await db().facebookStreamPost.findMany({
      where: { status: 'POSTED' },
      orderBy: { postedAt: 'desc' },
      take: limit,
    });
    return rows.map(rowFromDb);
  },
  async update(id, patch, updatedById) {
    const data = pick(patch, POST_EDITABLE);
    if (data.scheduledFor !== undefined) data.scheduledFor = toDate(data.scheduledFor);
    const row = await db().facebookStreamPost.update({
      where: { id },
      data: { ...data, updatedById: updatedById ?? null },
    });
    return rowFromDb(row);
  },
  async transition(id, data) {
    const row = await db().facebookStreamPost.update({ where: { id }, data });
    return rowFromDb(row);
  },
  async countsByStatus() {
    const grouped = await db().facebookStreamPost.groupBy({ by: ['status'], _count: true });
    const counts = {};
    for (const g of grouped) counts[g.status] = g._count;
    return counts;
  },
  async nextScheduled(nowIso) {
    const row = await db().facebookStreamPost.findFirst({
      where: { status: 'SCHEDULED', scheduledFor: { gte: new Date(nowIso) } },
      orderBy: { scheduledFor: 'asc' },
    });
    return rowFromDb(row);
  },
};

const prismaAds = {
  async create(data, createdById) {
    const row = await db().facebookAdDraft.create({
      data: { ...pick(data, AD_EDITABLE), createdById: createdById ?? null },
    });
    return rowFromDb(row);
  },
  async findById(id) {
    return rowFromDb(await db().facebookAdDraft.findUnique({ where: { id } }));
  },
  async list({ status, limit = 200 } = {}) {
    const where = {};
    if (status) where.status = status;
    const rows = await db().facebookAdDraft.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map(rowFromDb);
  },
  async update(id, patch, updatedById) {
    const row = await db().facebookAdDraft.update({
      where: { id },
      data: { ...pick(patch, AD_EDITABLE), updatedById: updatedById ?? null },
    });
    return rowFromDb(row);
  },
  async countsByStatus() {
    const grouped = await db().facebookAdDraft.groupBy({ by: ['status'], _count: true });
    const counts = {};
    for (const g of grouped) counts[g.status] = g._count;
    return counts;
  },
};

const prismaSyndication = {
  async upsert(postId, surface, data, createdById) {
    const row = await db().facebookSyndication.upsert({
      where: { postId_surface: { postId, surface } },
      create: {
        postId,
        surface,
        deepLink: data.deepLink,
        status: data.status || 'PLANNED',
        createdById: createdById ?? null,
      },
      update: {
        deepLink: data.deepLink,
        ...(data.status ? { status: data.status } : {}),
      },
    });
    return rowFromDb(row);
  },
  async findById(id) {
    return rowFromDb(await db().facebookSyndication.findUnique({ where: { id } }));
  },
  async list({ postId, surface, status, limit = 500 } = {}) {
    const where = {};
    if (postId) where.postId = postId;
    if (surface) where.surface = surface;
    if (status) where.status = status;
    const rows = await db().facebookSyndication.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map(rowFromDb);
  },
  async update(id, patch) {
    const row = await db().facebookSyndication.update({
      where: { id },
      data: pick(patch, ['deepLink', 'status']),
    });
    return rowFromDb(row);
  },
};

// ─── In-memory (skeleton) mode ──────────────────────────────────────

const memoryPosts = [];
const memoryAds = [];
const memorySyndication = [];

function memoryPost(data) {
  const now = new Date().toISOString();
  return {
    id: createId(),
    seriesKey: data.seriesKey ?? null,
    seriesWeek: data.seriesWeek ?? null,
    format: data.format || 'CUSTOM',
    title: data.title,
    copy: data.copy,
    mediaUrl: data.mediaUrl ?? null,
    mediaKind: data.mediaKind ?? null,
    linkUrl: data.linkUrl ?? null,
    pageId: data.pageId || '1437372132795817',
    pageName: data.pageName || 'Top Speed Appliance Repair and Installation',
    status: 'DRAFT',
    scheduledFor: data.scheduledFor ? toDate(data.scheduledFor).toISOString() : null,
    facebookUrl: null,
    facebookPostId: null,
    postedAt: null,
    statusNote: data.statusNote ?? null,
    createdById: data.createdById ?? null,
    updatedById: null,
    createdAt: now,
    updatedAt: now,
  };
}

const memoryPostsRepo = {
  async create(data) {
    const row = memoryPost(data);
    memoryPosts.push(row);
    return row;
  },
  async findById(id) {
    return memoryPosts.find((r) => r.id === id) || null;
  },
  async findSeriesInstallment(seriesKey, seriesWeek, format, title) {
    return memoryPosts.find(
      (r) => r.seriesKey === seriesKey && r.seriesWeek === seriesWeek && r.format === format && r.title === title,
    ) || null;
  },
  async list({ status, seriesKey, limit = 200 } = {}) {
    return memoryPosts
      .filter((r) => (!status || r.status === status) && (!seriesKey || r.seriesKey === seriesKey))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, limit);
  },
  async listPosted(limit = 20) {
    return memoryPosts
      .filter((r) => r.status === 'POSTED')
      .sort((a, b) => String(b.postedAt || '').localeCompare(String(a.postedAt || '')))
      .slice(0, limit);
  },
  async update(id, patch, updatedById) {
    const row = memoryPosts.find((r) => r.id === id);
    if (!row) return null;
    Object.assign(row, pick(patch, POST_EDITABLE));
    if (patch.scheduledFor !== undefined) {
      row.scheduledFor = patch.scheduledFor ? toDate(patch.scheduledFor).toISOString() : null;
    }
    row.updatedById = updatedById ?? null;
    row.updatedAt = new Date().toISOString();
    return row;
  },
  async transition(id, data) {
    const row = memoryPosts.find((r) => r.id === id);
    if (!row) return null;
    Object.assign(row, data);
    if (row.scheduledFor instanceof Date) row.scheduledFor = row.scheduledFor.toISOString();
    if (row.postedAt instanceof Date) row.postedAt = row.postedAt.toISOString();
    row.updatedAt = new Date().toISOString();
    return row;
  },
  async countsByStatus() {
    const counts = {};
    for (const r of memoryPosts) counts[r.status] = (counts[r.status] || 0) + 1;
    return counts;
  },
  async nextScheduled(nowIso) {
    const upcoming = memoryPosts
      .filter((r) => r.status === 'SCHEDULED' && r.scheduledFor && r.scheduledFor >= nowIso)
      .sort((a, b) => String(a.scheduledFor).localeCompare(String(b.scheduledFor)));
    return upcoming[0] || null;
  },
};

const memoryAdsRepo = {
  async create(data, createdById) {
    const now = new Date().toISOString();
    const row = {
      id: createId(),
      name: data.name,
      objective: data.objective,
      audience: data.audience ?? null,
      headline: data.headline ?? null,
      copy: data.copy ?? null,
      ctaText: data.ctaText ?? null,
      creativeRef: data.creativeRef ?? null,
      destinationUrl: data.destinationUrl ?? null,
      budgetCents: data.budgetCents ?? null,
      recordedSpendCents: data.recordedSpendCents ?? null,
      status: data.status || 'DRAFT',
      metaCampaignId: data.metaCampaignId ?? null,
      metaDeepLink: data.metaDeepLink ?? null,
      streamPostId: data.streamPostId ?? null,
      notes: data.notes ?? null,
      createdById: createdById ?? null,
      updatedById: null,
      createdAt: now,
      updatedAt: now,
    };
    memoryAds.push(row);
    return row;
  },
  async findById(id) {
    return memoryAds.find((r) => r.id === id) || null;
  },
  async list({ status, limit = 200 } = {}) {
    return memoryAds
      .filter((r) => !status || r.status === status)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, limit);
  },
  async update(id, patch, updatedById) {
    const row = memoryAds.find((r) => r.id === id);
    if (!row) return null;
    Object.assign(row, pick(patch, AD_EDITABLE));
    row.updatedById = updatedById ?? null;
    row.updatedAt = new Date().toISOString();
    return row;
  },
  async countsByStatus() {
    const counts = {};
    for (const r of memoryAds) counts[r.status] = (counts[r.status] || 0) + 1;
    return counts;
  },
};

const memorySyndicationRepo = {
  async upsert(postId, surface, data, createdById) {
    const existing = memorySyndication.find((r) => r.postId === postId && r.surface === surface);
    if (existing) {
      existing.deepLink = data.deepLink;
      if (data.status) existing.status = data.status;
      existing.updatedAt = new Date().toISOString();
      return existing;
    }
    const now = new Date().toISOString();
    const row = {
      id: createId(),
      postId,
      surface,
      deepLink: data.deepLink,
      status: data.status || 'PLANNED',
      createdById: createdById ?? null,
      createdAt: now,
      updatedAt: now,
    };
    memorySyndication.push(row);
    return row;
  },
  async findById(id) {
    return memorySyndication.find((r) => r.id === id) || null;
  },
  async list({ postId, surface, status, limit = 500 } = {}) {
    return memorySyndication
      .filter(
        (r) =>
          (!postId || r.postId === postId) &&
          (!surface || r.surface === surface) &&
          (!status || r.status === status),
      )
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, limit);
  },
  async update(id, patch) {
    const row = memorySyndication.find((r) => r.id === id);
    if (!row) return null;
    Object.assign(row, pick(patch, ['deepLink', 'status']));
    row.updatedAt = new Date().toISOString();
    return row;
  },
};

export const facebookOsPostsRepo = DATABASE_ENABLED ? prismaPosts : memoryPostsRepo;
export const facebookOsAdsRepo = DATABASE_ENABLED ? prismaAds : memoryAdsRepo;
export const facebookOsSyndicationRepo = DATABASE_ENABLED ? prismaSyndication : memorySyndicationRepo;
