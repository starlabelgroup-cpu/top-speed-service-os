import { store } from '../data/store.js';
import { DATABASE_ENABLED, db } from './client.js';

/**
 * Management department reports persistence (2026-11-14) — same pattern
 * as the Ad Studio / Media OS data layers: the Prisma DepartmentReport
 * table is the durable record, the in-memory store is the working set,
 * mutations write through with an upsert, and hydrateDepartmentReports()
 * loads everything at cold start. A missing table mid-deploy degrades
 * to an empty list — never blocks the platform.
 */

function iso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function toStoreReport(row) {
  return {
    id: row.id,
    department: row.department,
    type: row.type,
    title: row.title,
    detail: row.detail && typeof row.detail === 'object' ? row.detail : {},
    source: row.source || null,
    reference: row.reference || null,
    eventKey: row.eventKey || null,
    status: row.status || 'NEW',
    ackById: row.ackById || null,
    ackAt: iso(row.ackAt),
    createdAt: iso(row.createdAt),
  };
}

export async function hydrateDepartmentReports() {
  if (!DATABASE_ENABLED) return store.departmentReports.length;
  try {
    const rows = await db().departmentReport.findMany({ orderBy: [{ createdAt: 'asc' }] });
    store.departmentReports = rows.map(toStoreReport);
    return rows.length;
  } catch (error) {
    console.error('hydrateDepartmentReports degraded', error?.message || error);
    return store.departmentReports.length;
  }
}

export async function persistDepartmentReport(record) {
  if (!DATABASE_ENABLED || !record?.id) return;
  const row = {
    id: record.id,
    department: record.department,
    type: record.type,
    title: record.title,
    detail: record.detail || {},
    source: record.source || null,
    reference: record.reference || null,
    eventKey: record.eventKey || null,
    status: record.status || 'NEW',
    ackById: record.ackById || null,
    ackAt: record.ackAt ? new Date(record.ackAt) : null,
    createdAt: new Date(record.createdAt),
  };
  await db().departmentReport.upsert({ where: { id: row.id }, update: row, create: row });
}

/**
 * Delete department report rows by id (owner record-keeping, 2026-11-23).
 * Mirrors persistDepartmentReport's posture: database mode only, and a
 * failure is logged and swallowed — the caller has already removed the
 * rows from the working set, and a failed durable delete must not fail
 * the request (the next refresh would resurrect the row, which the
 * caller surfaces honestly rather than hiding).
 */
export async function deleteDepartmentReport(ids) {
  const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
  if (!list.length || !DATABASE_ENABLED) return;
  try {
    const client = await getPrisma();
    await client.departmentReport.deleteMany({ where: { id: { in: list } } });
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', message: 'department report delete failed', error: String(error?.message || error) }));
  }
}
