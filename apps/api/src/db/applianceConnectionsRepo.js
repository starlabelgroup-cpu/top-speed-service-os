import { store } from '../data/store.js';
import { DATABASE_ENABLED, db } from './client.js';

/**
 * Connected-appliance persistence — the registry of manufacturer
 * network connections a customer consents to for a garage appliance.
 * Hydrated into the store at cold start alongside the garage itself.
 *
 * HONESTY RULE for this module: a REGISTERED row records the
 * customer's consent on their account. It is NOT a live manufacturer
 * link — externalId stays NULL and nothing here may set LINKED.
 * LINKED arrives only with a real brand integration (manufacturer
 * developer approval, OAuth consent and encrypted token storage),
 * none of which exists yet.
 */

function iso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function toStoreConnection(row) {
  return {
    id: row.id,
    applianceId: row.applianceId,
    provider: row.provider,
    externalId: row.externalId || null,
    status: row.status,
    consentAt: iso(row.consentAt),
    revokedAt: iso(row.revokedAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

/** The serialized connections for one appliance, oldest first. */
export function listConnections(applianceId) {
  return [...store.applianceConnections.values()]
    .filter((c) => c.applianceId === applianceId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** The live (non-revoked) connection for an appliance + provider. */
export function activeConnection(applianceId, provider) {
  return (
    [...store.applianceConnections.values()].find(
      (c) => c.applianceId === applianceId && c.provider === provider && c.status !== 'REVOKED',
    ) || null
  );
}

export async function persistConnection(connection) {
  if (!DATABASE_ENABLED || !connection?.id) return;
  const row = {
    id: connection.id,
    applianceId: connection.applianceId,
    provider: connection.provider,
    externalId: connection.externalId || null,
    status: connection.status,
    consentAt: connection.consentAt ? new Date(connection.consentAt) : null,
    revokedAt: connection.revokedAt ? new Date(connection.revokedAt) : null,
    createdAt: new Date(connection.createdAt),
    updatedAt: new Date(connection.updatedAt),
  };
  await db().applianceConnection.upsert({ where: { id: row.id }, update: row, create: row });
}

export async function hydrateApplianceConnections() {
  if (!DATABASE_ENABLED) return 0;
  const rows = await db().applianceConnection.findMany({ orderBy: { createdAt: 'asc' } });
  store.applianceConnections = new Map(rows.map((row) => [row.id, toStoreConnection(row)]));
  return rows.length;
}

/**
 * Read side for manufacturer events. Events are written ONLY by a
 * future brand integration — there is deliberately no ingestion
 * endpoint and no writer in the foundation build — so this returns
 * the recorded events for an appliance (empty until then), read
 * straight from the database rather than the store.
 */
export async function listApplianceEvents(applianceId) {
  if (!DATABASE_ENABLED || !applianceId) return [];
  const rows = await db().applianceEvent.findMany({
    where: { applianceId },
    orderBy: { receivedAt: 'asc' },
  });
  return rows.map((row) => ({
    id: row.id,
    applianceId: row.applianceId,
    connectionId: row.connectionId || null,
    type: row.type,
    source: row.source,
    payload: row.payload ?? null,
    receivedAt: iso(row.receivedAt),
    createdAt: iso(row.createdAt),
  }));
}
