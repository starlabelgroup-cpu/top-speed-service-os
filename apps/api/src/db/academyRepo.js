import { createId, store } from '../data/store.js';
import { DATABASE_ENABLED, db } from './client.js';

/**
 * Academy completions — repository (2026-11-20, recommendations D12).
 *
 * Same dual-mode discipline as the other add-on repos: the working
 * set is store.academyCompletions (what the certification deriver
 * and the dispatch ranker read), writes land in the store first and
 * write through to the AcademyCompletion table when the database is
 * enabled, and hydrateAcademyCompletions() loads the table at cold
 * start. A missing table mid-deploy degrades to an empty set, never
 * blocks hydration (bookingsRepo wraps the call).
 *
 * A completion is recorded ONLY against a module that exists in the
 * live curriculum (the route validates the slug against
 * store.mediaContent's training-academy records) — this repo just
 * persists what the route verified.
 */

function iso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function toStoreCompletion(row) {
  return {
    id: row.id,
    companyId: row.companyId,
    userId: row.userId,
    providerId: row.providerId ?? null,
    moduleSlug: row.moduleSlug,
    moduleNumber: row.moduleNumber,
    trackName: row.trackName,
    completedAt: iso(row.completedAt),
    createdAt: iso(row.createdAt),
  };
}

export async function hydrateAcademyCompletions() {
  if (!DATABASE_ENABLED) return store.academyCompletions.length;
  const rows = await db().academyCompletion.findMany({ orderBy: { completedAt: 'asc' } });
  store.academyCompletions = rows.map(toStoreCompletion);
  return rows.length;
}

/**
 * Record a module completion for a trainee. Idempotent per
 * (userId, moduleSlug): a repeat returns the existing record with
 * `alreadyRecorded: true` and writes nothing new.
 */
export async function recordCompletion({ companyId, userId, providerId = null, moduleSlug, moduleNumber, trackName }) {
  const existing = store.academyCompletions.find(
    (row) => row.userId === userId && row.moduleSlug === moduleSlug,
  );
  if (existing) return { completion: existing, alreadyRecorded: true };

  const completion = {
    id: createId(),
    companyId,
    userId,
    providerId: providerId ?? null,
    moduleSlug,
    moduleNumber,
    trackName,
    completedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };
  store.academyCompletions.push(completion);

  if (DATABASE_ENABLED) {
    try {
      const row = await db().academyCompletion.upsert({
        where: { userId_moduleSlug: { userId, moduleSlug } },
        update: {},
        create: {
          id: completion.id,
          companyId,
          userId,
          providerId: providerId ?? null,
          moduleSlug,
          moduleNumber,
          trackName,
          completedAt: new Date(completion.completedAt),
          createdAt: new Date(completion.createdAt),
        },
      });
      // Another instance may have recorded it first — adopt the
      // durable row so the store never shows a duplicate.
      const durable = toStoreCompletion(row);
      const idx = store.academyCompletions.findIndex((r) => r.id === completion.id);
      if (durable.id !== completion.id) {
        if (idx >= 0) store.academyCompletions.splice(idx, 1);
        if (!store.academyCompletions.some((r) => r.id === durable.id)) {
          store.academyCompletions.push(durable);
        }
        return { completion: durable, alreadyRecorded: true };
      }
    } catch (error) {
      console.error('recordCompletion persist failed', error?.message || error);
    }
  }
  return { completion, alreadyRecorded: false };
}

export function completionsForUser(userId) {
  return store.academyCompletions.filter((row) => row.userId === userId);
}

export function completionsForProvider(providerId) {
  if (!providerId) return [];
  return store.academyCompletions.filter((row) => row.providerId === providerId);
}
