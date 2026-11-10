import { DATABASE_ENABLED, db } from './client.js';
import { PLATFORM_COMPANY_ID, store } from '../data/store.js';

/**
 * Speedy Live Video persistence (database mode), in the same bridge
 * pattern as the other repos: routes work on store.videoRequests; this
 * repo hydrates it at cold start and persists every mutation, so a
 * customer's video request never vanishes before a setter arranges it.
 * No-op when DATABASE_URL is not set (skeleton mode).
 */

function videoToRow(request) {
  return {
    id: request.id,
    companyId: request.companyId || PLATFORM_COMPANY_ID,
    customerName: request.customerName,
    phone: request.phone,
    appliance: request.appliance,
    note: request.note ?? null,
    bookingReference: request.bookingReference ?? null,
    mode: request.mode || 'UNDECIDED',
    status: request.status || 'PENDING',
    roomName: request.roomName ?? null,
    arrangedBy: request.arrangedBy ?? null,
    createdAt: request.createdAt ? new Date(request.createdAt) : new Date(),
  };
}

function videoFromRow(row) {
  return {
    id: row.id,
    companyId: row.companyId,
    customerName: row.customerName,
    phone: row.phone,
    appliance: row.appliance,
    note: row.note ?? undefined,
    bookingReference: row.bookingReference ?? undefined,
    mode: row.mode,
    status: row.status,
    roomName: row.roomName ?? undefined,
    arrangedBy: row.arrangedBy ?? undefined,
    createdAt: row.createdAt?.toISOString?.() ?? row.createdAt,
    updatedAt: row.updatedAt?.toISOString?.() ?? row.updatedAt,
  };
}

export async function persistVideoRequest(request) {
  if (!DATABASE_ENABLED || !request?.id) return;
  const row = videoToRow(request);
  await db().videoConsultRequest.upsert({ where: { id: row.id }, update: row, create: row });
}

export async function hydrateVideoRequests() {
  if (!DATABASE_ENABLED) return { skipped: true };
  const rows = await db().videoConsultRequest.findMany({ orderBy: { createdAt: 'asc' } });
  store.videoRequests.clear();
  for (const row of rows) {
    const request = videoFromRow(row);
    store.videoRequests.set(request.id, request);
  }
  return { videoRequests: rows.length };
}
