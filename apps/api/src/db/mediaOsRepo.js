import { createId, store } from '../data/store.js';
import { DATABASE_ENABLED, db } from './client.js';
import { MEDIA_CONTENT_SEEDS } from '../data/mediaOsSeed.js';

/**
 * Top Speed Media OS — Phase 1 persistence (2026-11-14).
 *
 * Same pattern as the Marketing OS and Google-account-registry data
 * layers: Prisma tables are the durable record, the in-memory store
 * is the working set, mutations write through with an upsert, and
 * hydrateMedia() loads everything at cold start.
 *
 * Seed discipline: the seed library (data/mediaOsSeed.js — the 25
 * Flywheel ads and 29 Training Academy modules) is create-only BY
 * SLUG, at Prisma seed time and again at boot hydration, so a
 * redeploy can never overwrite a status change or edit made in the
 * console, and the library is truthful from first boot. Statuses are
 * workflow states set by humans through the admin API — nothing in
 * this layer ever flips one on its own.
 */

function iso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function toStoreContent(row) {
  return {
    id: row.id,
    slug: row.slug,
    type: row.type,
    division: row.division,
    title: row.title,
    description: row.description || null,
    assetUrl: row.assetUrl || null,
    thumbnailUrl: row.thumbnailUrl || null,
    durationSec: row.durationSec ?? null,
    transcript: row.transcript || null,
    destinationUrl: row.destinationUrl || null,
    status: row.status || 'DRAFT',
    publishAt: iso(row.publishAt),
    publishedAt: iso(row.publishedAt),
    tags: Array.isArray(row.tags) ? row.tags : [],
    createdBy: row.createdBy || null,
    updatedBy: row.updatedBy || null,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function toStoreAsset(row) {
  return {
    id: row.id,
    contentId: row.contentId || null,
    kind: row.kind,
    name: row.name,
    url: row.url || null,
    rightsStatus: row.rightsStatus || 'PENDING_REVIEW',
    rightsNote: row.rightsNote || null,
    createdAt: iso(row.createdAt),
  };
}

function seedStoreRecord(seed) {
  const now = new Date().toISOString();
  return {
    id: createId(),
    slug: seed.slug,
    type: seed.type,
    division: seed.division,
    title: seed.title,
    description: seed.description || null,
    assetUrl: seed.assetUrl || null,
    thumbnailUrl: seed.thumbnailUrl || null,
    durationSec: seed.durationSec ?? null,
    transcript: seed.transcript || null,
    destinationUrl: seed.destinationUrl || null,
    status: seed.status || 'DRAFT',
    publishAt: seed.publishAt || null,
    publishedAt: seed.publishedAt || null,
    tags: Array.isArray(seed.tags) ? seed.tags : [],
    createdBy: 'media-os-seed',
    updatedBy: 'media-os-seed',
    createdAt: now,
    updatedAt: now,
  };
}

function seedDbRow(seed) {
  return {
    slug: seed.slug,
    type: seed.type,
    division: seed.division,
    title: seed.title,
    description: seed.description || null,
    assetUrl: seed.assetUrl || null,
    thumbnailUrl: seed.thumbnailUrl || null,
    durationSec: seed.durationSec ?? null,
    transcript: seed.transcript || null,
    destinationUrl: seed.destinationUrl || null,
    status: seed.status || 'DRAFT',
    publishAt: seed.publishAt ? new Date(seed.publishAt) : null,
    publishedAt: seed.publishedAt ? new Date(seed.publishedAt) : null,
    tags: Array.isArray(seed.tags) ? seed.tags : [],
    createdBy: 'media-os-seed',
    updatedBy: 'media-os-seed',
  };
}

function seedMediaIntoStore() {
  for (const seed of MEDIA_CONTENT_SEEDS) {
    if (!store.mediaContent.some((record) => record.slug === seed.slug)) {
      store.mediaContent.push(seedStoreRecord(seed));
    }
  }
}

export async function hydrateMedia() {
  if (!DATABASE_ENABLED) {
    seedMediaIntoStore();
    return { content: store.mediaContent.length, assets: store.mediaAssets.length };
  }
  const prisma = db();
  // Idempotent seed: create only the slugs that are missing.
  const existing = await prisma.mediaContent.findMany({ select: { slug: true } });
  const have = new Set(existing.map((row) => row.slug));
  for (const seed of MEDIA_CONTENT_SEEDS) {
    if (!have.has(seed.slug)) {
      await prisma.mediaContent.create({ data: seedDbRow(seed) });
    }
  }
  const [contentRows, assetRows] = await Promise.all([
    prisma.mediaContent.findMany({ orderBy: [{ createdAt: 'asc' }] }),
    prisma.mediaAsset.findMany({ orderBy: [{ createdAt: 'asc' }] }),
  ]);
  store.mediaContent = contentRows.map(toStoreContent);
  store.mediaAssets = assetRows.map(toStoreAsset);
  return { content: contentRows.length, assets: assetRows.length };
}

export async function persistMediaContent(record) {
  if (!DATABASE_ENABLED || !record?.id) return;
  try {
    const row = {
      id: record.id,
      slug: record.slug,
      type: record.type,
      division: record.division,
      title: record.title,
      description: record.description || null,
      assetUrl: record.assetUrl || null,
      thumbnailUrl: record.thumbnailUrl || null,
      durationSec: record.durationSec ?? null,
      transcript: record.transcript || null,
      destinationUrl: record.destinationUrl || null,
      status: record.status || 'DRAFT',
      publishAt: record.publishAt ? new Date(record.publishAt) : null,
      publishedAt: record.publishedAt ? new Date(record.publishedAt) : null,
      tags: Array.isArray(record.tags) ? record.tags : [],
      createdBy: record.createdBy || 'media-os',
      updatedBy: record.updatedBy || record.createdBy || 'media-os',
      createdAt: new Date(record.createdAt),
      updatedAt: new Date(record.updatedAt || record.createdAt),
    };
    await db().mediaContent.upsert({ where: { id: row.id }, update: row, create: row });
  } catch (error) {
    console.error('persistMediaContent failed', error?.message || error);
  }
}

export async function persistMediaAsset(record) {
  if (!DATABASE_ENABLED || !record?.id) return;
  try {
    const row = {
      id: record.id,
      contentId: record.contentId || null,
      kind: record.kind,
      name: record.name,
      url: record.url || null,
      rightsStatus: record.rightsStatus || 'PENDING_REVIEW',
      rightsNote: record.rightsNote || null,
      createdAt: new Date(record.createdAt),
    };
    await db().mediaAsset.upsert({ where: { id: row.id }, update: row, create: row });
  } catch (error) {
    console.error('persistMediaAsset failed', error?.message || error);
  }
}
