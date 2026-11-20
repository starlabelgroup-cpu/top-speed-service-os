/**
 * Public Help Center publishing state persistence (2026-11-20,
 * Wave 3 E5). Dual-mode like the rest of the data layer: Prisma when
 * DATABASE_URL is set, process memory with identical shapes when it
 * is not.
 *
 * The help articles themselves are Speedy's grounded knowledge
 * entries (src/knowledge) — code, rebuilt from live platform sources
 * on every read. This repo stores ONLY the human publishing decision
 * per entry id: no row (or a DRAFT row) = not public; PUBLISHED =
 * a staff member published it. Nothing here ever publishes on its
 * own, and reads fail soft to "nothing published" rather than
 * inventing state.
 */
import { DATABASE_ENABLED, db } from './client.js';
import { createId } from '../data/store.js';

const memory = { states: [] };

function stateFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    entryId: row.entryId,
    status: row.status,
    updatedById: row.updatedById ?? null,
    publishedAt: row.publishedAt instanceof Date ? row.publishedAt.toISOString() : (row.publishedAt ?? null),
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
  };
}

/** Every recorded publishing decision, keyed by entryId. */
export async function listHelpArticleStates() {
  if (!DATABASE_ENABLED) return memory.states.map(stateFromRow);
  try {
    const rows = await db().helpArticleState.findMany({ orderBy: [{ createdAt: 'asc' }] });
    return rows.map(stateFromRow);
  } catch {
    return [];
  }
}

export async function getHelpArticleState(entryId) {
  if (!entryId) return null;
  if (!DATABASE_ENABLED) return stateFromRow(memory.states.find((s) => s.entryId === entryId) || null);
  try {
    return stateFromRow(await db().helpArticleState.findUnique({ where: { entryId } }));
  } catch {
    return null;
  }
}

/**
 * Record a staff member's publishing decision. PUBLISHED stamps
 * publishedAt (kept across a later unpublish so the history of the
 * first publication survives); DRAFT clears nothing but the status.
 */
export async function setHelpArticleState(entryId, { status, updatedById }) {
  const published = status === 'PUBLISHED';
  if (!DATABASE_ENABLED) {
    const now = new Date().toISOString();
    let row = memory.states.find((s) => s.entryId === entryId);
    if (!row) {
      row = {
        id: createId(), entryId, status, updatedById: updatedById ?? null,
        publishedAt: published ? now : null, createdAt: now, updatedAt: now,
      };
      memory.states.push(row);
    } else {
      row.status = status;
      row.updatedById = updatedById ?? null;
      if (published && !row.publishedAt) row.publishedAt = now;
      row.updatedAt = now;
    }
    return stateFromRow(row);
  }
  const existing = await db().helpArticleState.findUnique({ where: { entryId } });
  const data = {
    status,
    updatedById: updatedById ?? null,
    ...(published && !existing?.publishedAt ? { publishedAt: new Date() } : {}),
  };
  const row = existing
    ? await db().helpArticleState.update({ where: { entryId }, data })
    : await db().helpArticleState.create({ data: { entryId, ...data } });
  return stateFromRow(row);
}
