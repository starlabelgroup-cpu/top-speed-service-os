import { DATABASE_ENABLED, db } from './client.js';

/**
 * Platform Events — repository (2026-11-19, Platform Interconnect).
 *
 * The durable half of the platform event feed. appendEvent() in
 * data/store.js has always collected every platform event (booking
 * created/completed on any surface, referral, review, advertiser and
 * provider job events) into an in-memory list; this repo is the
 * write-through record of that same feed, so the timeline survives
 * serverless instance turnover and every surface's activity can be
 * read back in one place (GET /platform/events, the Platform
 * Interconnect console).
 *
 * Same dual-mode discipline as the other repos: Prisma when
 * DATABASE_URL is set, an in-memory fallback with identical shapes
 * when it is not. This module deliberately does NOT import
 * data/store.js (store.js imports it — no cycles).
 *
 * Persistence is awaited from appendEvent's side (2026-11-19 race
 * fix): when an appendEvent call completes, the event is durable, so
 * a reader in another process — or the next request — always sees
 * it. The write stays fail-soft: persistPlatformEvent swallows its
 * own errors after a console line, so a feed problem can never fail
 * the business flow that produced the event. The in-memory copy is
 * kept in BOTH modes so a reader in the same process always sees
 * the events it just wrote.
 *
 * Privacy: details is an operational summary, not a customer record.
 * Contact-shaped keys are scrubbed before a row is written and the
 * payload is size-capped — the feed never becomes a second copy of
 * customer PII.
 */

const memoryEvents = [];

const SCRUB_KEYS = new Set([
  'phone', 'customerphone', 'email', 'customeremail', 'address',
  'streetaddress', 'customername', 'customer', 'to', 'recipient',
]);

const MAX_DETAILS_CHARS = 4000;

export function scrubEventDetails(details) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return {};
  const clean = {};
  for (const [key, value] of Object.entries(details)) {
    if (SCRUB_KEYS.has(String(key).toLowerCase())) continue;
    clean[key] = value;
  }
  try {
    if (JSON.stringify(clean).length > MAX_DETAILS_CHARS) {
      return { truncated: true, keys: Object.keys(clean).slice(0, 24) };
    }
  } catch {
    return { truncated: true, keys: [] };
  }
  return clean;
}

function toFeedShape(row) {
  return {
    id: row.id,
    type: row.type,
    source: row.source ?? null,
    actor: row.actor ?? null,
    entityType: row.entityType ?? null,
    entityId: row.entityId ?? null,
    referenceCode: row.referenceCode ?? null,
    at: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.at || row.createdAt,
    details: row.details && typeof row.details === 'object' ? row.details : {},
  };
}

function toRow(event) {
  return {
    id: event.id,
    type: event.type,
    source: event.source ?? null,
    actor: event.actor ?? null,
    entityType: event.entityType ?? null,
    entityId: event.entityId ?? null,
    referenceCode: event.referenceCode ?? null,
    details: scrubEventDetails(event.details),
    createdAt: event.at ? new Date(event.at) : new Date(),
  };
}

/**
 * Write one appendEvent event through to the durable feed. Never
 * throws and never rejects: the business flow that produced the
 * event has already succeeded and must not learn about a feed
 * problem. Awaited by appendEvent so a completed append means the
 * event is readable from the durable feed (the 2026-11-19 race fix
 * — previously this insert floated un-awaited and an immediate read
 * could miss the event).
 */
export async function persistPlatformEvent(event) {
  try {
    const row = toRow(event);
    memoryEvents.push({ ...row, createdAt: row.createdAt.toISOString() });
    if (memoryEvents.length > 5000) memoryEvents.splice(0, memoryEvents.length - 5000);
    if (!DATABASE_ENABLED) return;
    try {
      await db().platformEvent.create({
        data: {
          id: row.id,
          type: row.type,
          source: row.source,
          actor: row.actor,
          entityType: row.entityType,
          entityId: row.entityId,
          referenceCode: row.referenceCode,
          details: row.details,
          createdAt: row.createdAt,
        },
      });
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', message: 'platform event persist failed', type: row.type, error: String(error?.message || error) }));
    }
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', message: 'platform event persist failed', error: String(error?.message || error) }));
  }
}

const prismaRepo = {
  async listRecent({ limit = 100, type = null, source = null } = {}) {
    const rows = await db().platformEvent.findMany({
      where: {
        ...(type ? { type } : {}),
        ...(source ? { source } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(Number(limit) || 100, 1), 500),
    });
    return rows.map(toFeedShape);
  },
  async lastForSources(sources) {
    if (!Array.isArray(sources) || !sources.length) return null;
    const row = await db().platformEvent.findFirst({
      where: { source: { in: sources } },
      orderBy: { createdAt: 'desc' },
    });
    return row ? toFeedShape(row) : null;
  },
  // Newest event whose TYPE is in the list, or null. Some surfaces
  // (the CRM) emit events that carry no source tag — their activity
  // is joined by type instead. Same honesty contract as
  // lastForSources: null means no such event exists.
  async lastForTypes(types) {
    if (!Array.isArray(types) || !types.length) return null;
    const row = await db().platformEvent.findFirst({
      where: { type: { in: types } },
      orderBy: { createdAt: 'desc' },
    });
    return row ? toFeedShape(row) : null;
  },

  async countSince(since) {
    return db().platformEvent.count({ where: { createdAt: { gte: since } } });
  },
  async countAll() {
    return db().platformEvent.count();
  },
};

function memoryFiltered({ type = null, source = null } = {}) {
  return memoryEvents
    .filter((row) => (!type || row.type === type) && (!source || row.source === source))
    .slice()
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

const memoryRepo = {
  async listRecent({ limit = 100, type = null, source = null } = {}) {
    return memoryFiltered({ type, source })
      .slice(0, Math.min(Math.max(Number(limit) || 100, 1), 500))
      .map(toFeedShape);
  },
  async lastForSources(sources) {
    if (!Array.isArray(sources) || !sources.length) return null;
    const hit = memoryFiltered({}).find((row) => sources.includes(row.source));
    return hit ? toFeedShape(hit) : null;
  },
  async lastForTypes(types) {
    if (!Array.isArray(types) || !types.length) return null;
    const hit = memoryFiltered({}).find((row) => types.includes(row.type));
    return hit ? toFeedShape(hit) : null;
  },
  async countSince(since) {
    const floor = since instanceof Date ? since.toISOString() : String(since);
    return memoryEvents.filter((row) => row.createdAt >= floor).length;
  },
  async countAll() {
    return memoryEvents.length;
  },
};

export const platformEventsRepo = DATABASE_ENABLED ? prismaRepo : memoryRepo;
