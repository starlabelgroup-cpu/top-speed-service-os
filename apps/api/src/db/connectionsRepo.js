import { appendEvent, createId, createReferenceCode, store } from '../data/store.js';
import { DATABASE_ENABLED, db } from './client.js';

/**
 * Connection records — the public web intake (forms + Speedy-assisted
 * flows across every surface). One shape everywhere: name, phone, type,
 * message, and a TS- reference the customer can quote. Persisted to the
 * Connection table and hydrated into the store at cold start so the
 * staff list survives deploys.
 */

function iso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function toStoreConnection(row) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    email: row.email || null,
    type: row.type,
    source: row.source || null,
    message: row.message || null,
    reference: row.reference,
    createdAt: iso(row.createdAt),
  };
}

export async function persistConnection(record) {
  if (!DATABASE_ENABLED || !record?.id) return;
  try {
    const row = {
      id: record.id,
      name: record.name,
      phone: record.phone,
      email: record.email || null,
      type: record.type,
      source: record.source || null,
      message: record.message || null,
      reference: record.reference,
      createdAt: new Date(record.createdAt),
    };
    await db().connection.upsert({ where: { id: row.id }, update: row, create: row });
  } catch (error) {
    // A public form must never fail because the log write hiccuped —
    // the in-store record still exists for this process's lifetime.
    console.error('persistConnection failed', error?.message || error);
  }
}

export async function createConnectionRecord({ name, phone, email = null, type, source = null, message = null }) {
  const record = {
    id: createId(),
    name,
    phone,
    email: email || null,
    type,
    source: source || null,
    message: message || null,
    reference: createReferenceCode(),
    createdAt: new Date().toISOString(),
  };
  store.connections.push(record);
  await persistConnection(record);
  appendEvent('CONNECTION_CREATED', {
    source: record.source,
    actor: 'public-web',
    entityType: 'CONNECTION',
    entityId: record.id,
    referenceCode: record.reference,
    details: { type: record.type },
  });
  return record;
}

export async function hydrateConnections() {
  if (!DATABASE_ENABLED) return 0;
  const rows = await db().connection.findMany({ orderBy: { createdAt: 'asc' } });
  store.connections = rows.map(toStoreConnection);
  return rows.length;
}
