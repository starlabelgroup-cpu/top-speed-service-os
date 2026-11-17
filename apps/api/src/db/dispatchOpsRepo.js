import { store } from '../data/store.js';
import { db, DATABASE_ENABLED } from './client.js';
import { CAPACITY_DEFAULTS } from '../services/dispatchOps.js';

/**
 * Service Setters capacity settings persistence (2026-11-17) — the
 * reviewsRepo pattern: the in-memory store map is the working copy for
 * this process, writes go through to the DispatchSetting table when
 * the database is enabled, and reads merge the database row in so the
 * office's settings survive a cold start. A persistence hiccup never
 * fails the setter's action — the in-memory copy still serves.
 */

function fromRow(row) {
  return {
    bufferPercent: row.bufferPercent,
    minutesPerJob: row.minutesPerJob,
    workingHoursPerDay: row.workingHoursPerDay,
    updatedBy: row.updatedBy ?? null,
  };
}

/** The company's effective settings (defaults merged under any saved row). */
export function getDispatchSettings(companyId) {
  return { ...CAPACITY_DEFAULTS, ...(store.dispatchSettings.get(companyId) || {}) };
}

/** Merge the persisted row (if any) into the working copy, then read. */
export async function loadDispatchSettings(companyId) {
  if (DATABASE_ENABLED) {
    try {
      const row = await db().dispatchSetting.findUnique({ where: { companyId } });
      if (row) store.dispatchSettings.set(companyId, fromRow(row));
    } catch (error) {
      console.error('loadDispatchSettings failed', error?.message || error);
    }
  }
  return getDispatchSettings(companyId);
}

/** Save the office's planning inputs (validated by the route). */
export async function saveDispatchSettings(companyId, patch, updatedBy) {
  const next = {
    ...getDispatchSettings(companyId),
    ...patch,
    updatedBy: updatedBy || null,
  };
  store.dispatchSettings.set(companyId, next);
  if (DATABASE_ENABLED) {
    try {
      await db().dispatchSetting.upsert({
        where: { companyId },
        update: {
          bufferPercent: next.bufferPercent,
          minutesPerJob: next.minutesPerJob,
          workingHoursPerDay: next.workingHoursPerDay,
          updatedBy: next.updatedBy,
        },
        create: {
          companyId,
          bufferPercent: next.bufferPercent,
          minutesPerJob: next.minutesPerJob,
          workingHoursPerDay: next.workingHoursPerDay,
          updatedBy: next.updatedBy,
        },
      });
    } catch (error) {
      console.error('saveDispatchSettings persist failed', error?.message || error);
    }
  }
  return next;
}
