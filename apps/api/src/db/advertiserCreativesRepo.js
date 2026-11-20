import { store } from '../data/store.js';
import { DATABASE_ENABLED, db } from './client.js';

/**
 * Advertiser creative uploads (2026-11-20, E3) — persistence for the
 * AdvertiserCreative table. Same pattern as the review media: the
 * in-memory store is the working set for METADATA, image bytes live
 * in a module-level map for this process and write through to the
 * database; a cold process re-reads bytes from the table on demand.
 * A missing table mid-deploy degrades to an empty library, exactly
 * like the Media OS hydration — never blocks the platform.
 */

const bytesById = new Map();

function iso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function toStoreCreative(row) {
  return {
    id: row.id,
    ownerId: row.ownerId,
    name: row.name,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    width: row.width ?? null,
    height: row.height ?? null,
    createdAt: iso(row.createdAt),
  };
}

export async function hydrateAdvertiserCreatives() {
  if (!DATABASE_ENABLED) return store.advertiserCreatives.length;
  try {
    const rows = await db().advertiserCreative.findMany({
      orderBy: [{ createdAt: 'asc' }],
      select: {
        id: true, ownerId: true, name: true, mimeType: true, sizeBytes: true,
        width: true, height: true, createdAt: true,
      },
    });
    store.advertiserCreatives = rows.map(toStoreCreative);
    return rows.length;
  } catch (error) {
    // A missing table mid-deploy degrades to an empty library.
    console.error('hydrateAdvertiserCreatives degraded', error?.message || error);
    return store.advertiserCreatives.length;
  }
}

/** Write-through persist of a store record (metadata) + its bytes. */
export async function persistAdvertiserCreative(record, data) {
  if (data) bytesById.set(record.id, data);
  if (!DATABASE_ENABLED || !record?.id) return;
  try {
    const bytes = data || bytesById.get(record.id);
    if (!bytes) return; // metadata-only update path is not used today
    await db().advertiserCreative.upsert({
      where: { id: record.id },
      update: {
        name: record.name, mimeType: record.mimeType, sizeBytes: record.sizeBytes,
        width: record.width ?? null, height: record.height ?? null, data: bytes,
      },
      create: {
        id: record.id, ownerId: record.ownerId, name: record.name,
        mimeType: record.mimeType, sizeBytes: record.sizeBytes,
        width: record.width ?? null, height: record.height ?? null,
        data: bytes, createdAt: new Date(record.createdAt),
      },
    });
  } catch (error) {
    console.error('persistAdvertiserCreative failed', error?.message || error);
  }
}

export async function deleteAdvertiserCreative(id) {
  bytesById.delete(id);
  if (!DATABASE_ENABLED || !id) return;
  try {
    await db().advertiserCreative.delete({ where: { id } });
  } catch (error) {
    console.error('deleteAdvertiserCreative failed', error?.message || error);
  }
}

/** The image bytes for a creative: process memory first, then the table. */
export async function getAdvertiserCreativeBytes(id) {
  const cached = bytesById.get(id);
  if (cached) return cached;
  if (!DATABASE_ENABLED || !id) return null;
  try {
    const row = await db().advertiserCreative.findUnique({
      where: { id },
      select: { data: true },
    });
    if (!row?.data) return null;
    const bytes = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data);
    bytesById.set(id, bytes);
    return bytes;
  } catch (error) {
    console.error('getAdvertiserCreativeBytes failed', error?.message || error);
    return null;
  }
}
