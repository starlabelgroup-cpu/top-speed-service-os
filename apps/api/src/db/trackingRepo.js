import { DATABASE_ENABLED, db } from './client.js';
import { store } from '../data/store.js';

/**
 * Persistence for Track My Tech secure tracking links. The store holds
 * records keyed by token hash; Postgres is the durable copy that
 * survives redeploys (hydrated at cold start by bookingsRepo).
 */

export function tokenToRow(record) {
  return {
    id: record.id,
    tokenHash: record.tokenHash,
    bookingId: record.bookingId,
    issuedBy: record.issuedBy ?? null,
    expiresAt: new Date(record.expiresAt),
    revokedAt: record.revokedAt ? new Date(record.revokedAt) : null,
  };
}

export function tokenFromRow(row) {
  return {
    id: row.id,
    tokenHash: row.tokenHash,
    bookingId: row.bookingId,
    issuedBy: row.issuedBy ?? null,
    expiresAt: row.expiresAt?.toISOString?.() ?? row.expiresAt,
    revokedAt: row.revokedAt?.toISOString?.() ?? null,
    createdAt: row.createdAt?.toISOString?.() ?? row.createdAt,
  };
}

export async function hydrateTrackingTokens() {
  if (!DATABASE_ENABLED) return { skipped: true };
  const rows = await db().trackingToken.findMany();
  store.trackingTokens.clear();
  for (const row of rows) {
    const record = tokenFromRow(row);
    store.trackingTokens.set(record.tokenHash, record);
  }
  return { trackingTokens: rows.length };
}

export async function persistTrackingToken(record) {
  if (!record?.id) return;
  store.trackingTokens.set(record.tokenHash, record);
  if (!DATABASE_ENABLED) return;
  const row = tokenToRow(record);
  await db().trackingToken.upsert({ where: { id: row.id }, update: row, create: row });
}

/** Revoke every live token for a booking (used when a fresh link is issued). */
export async function revokeTrackingTokensForBooking(bookingId) {
  const now = new Date().toISOString();
  for (const record of store.trackingTokens.values()) {
    if (record.bookingId === bookingId && !record.revokedAt) {
      record.revokedAt = now;
    }
  }
  if (!DATABASE_ENABLED) return;
  await db().trackingToken.updateMany({
    where: { bookingId, revokedAt: null },
    data: { revokedAt: new Date(now) },
  });
}
