import { store } from '../data/store.js';
import { DATABASE_ENABLED, db } from './client.js';

/**
 * QuickBooks finance integration — the mirror layer. The deployed API
 * holds no Intuit credentials and never calls QuickBooks; Pepper's
 * QuickBooks connector syncs real company data through the owner-only
 * POST /finance/sync, which lands here. Every finance surface reads
 * these rows and stamps the sync time. Until a first sync lands the
 * store holds no connection row — and that absence IS the honest
 * "QuickBooks not connected" state. Nothing here ever invents a
 * figure: snapshots are stored verbatim from the connector.
 */

function iso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function toStoreConnection(row) {
  return {
    id: row.id,
    provider: row.provider,
    status: row.status,
    companyName: row.companyName || null,
    realmHint: row.realmHint || null,
    lastSyncAt: iso(row.lastSyncAt),
    updatedBy: row.updatedBy || null,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function toStoreSnapshot(row) {
  return {
    id: row.id,
    kind: row.kind,
    periodLabel: row.periodLabel,
    payload: row.payload,
    source: row.source,
    syncedAt: iso(row.syncedAt),
  };
}

function toStoreInvoice(row) {
  return {
    id: row.id,
    qbId: row.qbId,
    number: row.number || null,
    customerName: row.customerName || null,
    totalCents: row.totalCents || 0,
    balanceCents: row.balanceCents || 0,
    status: row.status || null,
    dueDate: iso(row.dueDate),
    qbUrl: row.qbUrl || null,
    syncedAt: iso(row.syncedAt),
  };
}

export function publicConnectionState() {
  const conn = store.financeConnection;
  if (!conn) {
    return { status: 'not_connected', companyName: null, lastSyncAt: null };
  }
  return { status: conn.status, companyName: conn.companyName || null, lastSyncAt: conn.lastSyncAt || null };
}

export async function persistConnection(connection) {
  if (!DATABASE_ENABLED || !connection?.id) return;
  try {
    const row = {
      id: connection.id,
      provider: connection.provider || 'quickbooks',
      status: connection.status,
      companyName: connection.companyName || null,
      realmHint: connection.realmHint || null,
      lastSyncAt: connection.lastSyncAt ? new Date(connection.lastSyncAt) : null,
      updatedBy: connection.updatedBy || null,
      createdAt: new Date(connection.createdAt),
      updatedAt: new Date(connection.updatedAt || connection.createdAt),
    };
    await db().financeConnection.upsert({ where: { id: row.id }, update: row, create: row });
  } catch (error) {
    console.error('persistConnection(finance) failed', error?.message || error);
  }
}

export async function persistSnapshot(snapshot) {
  if (!DATABASE_ENABLED || !snapshot?.id) return;
  try {
    const row = {
      id: snapshot.id,
      kind: snapshot.kind,
      periodLabel: snapshot.periodLabel,
      payload: snapshot.payload,
      source: snapshot.source || 'quickbooks-connector',
      syncedAt: new Date(snapshot.syncedAt),
    };
    await db().financeSnapshot.upsert({ where: { id: row.id }, update: row, create: row });
  } catch (error) {
    console.error('persistSnapshot failed', error?.message || error);
  }
}

export async function persistInvoice(invoice) {
  if (!DATABASE_ENABLED || !invoice?.id) return;
  try {
    const row = {
      id: invoice.id,
      qbId: invoice.qbId,
      number: invoice.number || null,
      customerName: invoice.customerName || null,
      totalCents: invoice.totalCents || 0,
      balanceCents: invoice.balanceCents || 0,
      status: invoice.status || null,
      dueDate: invoice.dueDate ? new Date(invoice.dueDate) : null,
      qbUrl: invoice.qbUrl || null,
      syncedAt: new Date(invoice.syncedAt),
    };
    await db().financeInvoiceMirror.upsert({ where: { id: row.id }, update: row, create: row });
  } catch (error) {
    console.error('persistInvoice failed', error?.message || error);
  }
}

export async function hydrateFinance() {
  if (!DATABASE_ENABLED) return 0;
  const prisma = db();
  const [connRows, snapshotRows, invoiceRows] = await Promise.all([
    prisma.financeConnection.findMany(),
    prisma.financeSnapshot.findMany({ orderBy: { syncedAt: 'desc' } }),
    prisma.financeInvoiceMirror.findMany({ orderBy: { dueDate: 'asc' } }),
  ]);
  store.financeConnection = connRows.length ? toStoreConnection(connRows[0]) : null;
  store.financeSnapshots = snapshotRows.map(toStoreSnapshot);
  store.financeInvoices = invoiceRows.map(toStoreInvoice);
  return snapshotRows.length;
}
