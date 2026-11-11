import { store } from '../data/store.js';
import { DATABASE_ENABLED, db } from './client.js';

/**
 * Appliance Connect persistence — the customer's garage. Hydrated into
 * the store at cold start alongside everything else.
 */

function iso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function toStoreAppliance(row) {
  return {
    id: row.id,
    userId: row.userId,
    type: row.type,
    brand: row.brand || null,
    model: row.model || null,
    serial: row.serial || null,
    year: row.year ?? null,
    notes: row.notes || null,
    createdAt: iso(row.createdAt),
  };
}

export async function persistAppliance(appliance) {
  if (!DATABASE_ENABLED || !appliance?.id) return;
  const row = {
    id: appliance.id,
    userId: appliance.userId,
    type: appliance.type,
    brand: appliance.brand || null,
    model: appliance.model || null,
    serial: appliance.serial || null,
    year: appliance.year ?? null,
    notes: appliance.notes || null,
    createdAt: new Date(appliance.createdAt),
  };
  await db().customerAppliance.upsert({ where: { id: row.id }, update: row, create: row });
}

export async function deleteAppliance(id) {
  if (!DATABASE_ENABLED || !id) return;
  try {
    await db().customerAppliance.delete({ where: { id } });
  } catch {
    // Already gone — the store is the working copy either way.
  }
}

export async function hydrateAppliances() {
  if (!DATABASE_ENABLED) return 0;
  const rows = await db().customerAppliance.findMany({ orderBy: { createdAt: 'asc' } });
  store.appliances = new Map(rows.map((row) => [row.id, toStoreAppliance(row)]));
  return rows.length;
}
