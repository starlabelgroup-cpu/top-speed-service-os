import { store } from '../data/store.js';
import { DATABASE_ENABLED, db } from './client.js';

/**
 * Before/after video factory — blob persistence (2026-11-20, E9).
 *
 * Same dual-mode discipline as the rest of the platform: the
 * MediaVideoBlob table is the durable record when a database is
 * connected; the in-memory store map is the working set and the
 * skeleton-mode record. Writes go to both; reads check the store
 * first and fall back to the table (hydrating the map on the way),
 * so a cold start serves previously rendered videos without a boot
 * hydration pass over multi-megabyte rows.
 */

export async function persistVideoBlob({ contentId, mimeType, data }) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const entry = { contentId, mimeType, sizeBytes: bytes.length, data: bytes };
  store.mediaVideoBlobs.set(contentId, entry);
  if (!DATABASE_ENABLED) return entry;
  try {
    const row = { contentId, mimeType, sizeBytes: bytes.length, data: bytes };
    await db().mediaVideoBlob.upsert({
      where: { contentId },
      update: row,
      create: row,
    });
  } catch (error) {
    console.error('persistVideoBlob failed', error?.message || error);
  }
  return entry;
}

export async function getVideoBlob(contentId) {
  const cached = store.mediaVideoBlobs.get(contentId);
  if (cached) return cached;
  if (!DATABASE_ENABLED) return null;
  try {
    const row = await db().mediaVideoBlob.findUnique({ where: { contentId } });
    if (!row) return null;
    const entry = {
      contentId: row.contentId,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      data: Buffer.from(row.data),
    };
    store.mediaVideoBlobs.set(contentId, entry);
    return entry;
  } catch (error) {
    console.error('getVideoBlob failed', error?.message || error);
    return null;
  }
}
