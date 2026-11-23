/**
 * Tracking-number registry + inbound contact log persistence
 * (Satellite Website Tracking Number System, 2026-11-19).
 *
 * Dual-mode like the rest of the data layer: with DATABASE_URL set the
 * rows live in Postgres through Prisma; in skeleton mode they live in
 * process memory with the same shapes. Every function is fail-soft —
 * the Twilio webhooks call the contact logger AFTER their TwiML
 * response is computed, and a persistence error must never change
 * what a caller or texter receives, so nothing here throws.
 */
import { DATABASE_ENABLED, db } from './client.js';

const memory = { numbers: [], events: [] };

function numberFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    value: row.value ?? null,
    label: row.label,
    surfaceKey: row.surfaceKey,
    channels: Array.isArray(row.channels) ? [...row.channels] : [],
    status: row.status,
    shared: !!row.shared,
    notes: row.notes ?? null,
    seedKey: row.seedKey ?? null,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
  };
}

function eventFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    channel: row.channel,
    trackingNumberId: row.trackingNumberId ?? null,
    surfaceKey: row.surfaceKey,
    fromNumber: row.fromNumber,
    toNumber: row.toNumber,
    externalSid: row.externalSid ?? null,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
  };
}

export async function listTrackingNumbers() {
  if (!DATABASE_ENABLED) return memory.numbers.map(numberFromRow);
  try {
    const rows = await db().trackingNumber.findMany({ orderBy: [{ createdAt: 'asc' }] });
    return rows.map(numberFromRow);
  } catch {
    return [];
  }
}

export async function findTrackingNumberById(id) {
  if (!id) return null;
  if (!DATABASE_ENABLED) return numberFromRow(memory.numbers.find((n) => n.id === id) || null);
  try {
    return numberFromRow(await db().trackingNumber.findUnique({ where: { id } }));
  } catch {
    return null;
  }
}

export async function findTrackingNumberBySeedKey(seedKey) {
  if (!seedKey) return null;
  if (!DATABASE_ENABLED) return numberFromRow(memory.numbers.find((n) => n.seedKey === seedKey) || null);
  try {
    return numberFromRow(await db().trackingNumber.findUnique({ where: { seedKey } }));
  } catch {
    return null;
  }
}

/** The ACTIVE PHONE row published as `value` (E.164), or null. */
export async function findActivePhoneByValue(value) {
  if (!value) return null;
  if (!DATABASE_ENABLED) {
    return numberFromRow(
      memory.numbers.find((n) => n.kind === 'PHONE' && n.status === 'ACTIVE' && n.value === value) || null,
    );
  }
  try {
    return numberFromRow(
      await db().trackingNumber.findFirst({
        where: { kind: 'PHONE', status: 'ACTIVE', value },
        orderBy: [{ createdAt: 'asc' }],
      }),
    );
  } catch {
    return null;
  }
}

/** Any non-RETIRED row (seed or manager-created) holding kind+value. */
export async function findLiveByKindValue(kind, value) {
  if (!kind || !value) return null;
  if (!DATABASE_ENABLED) {
    return numberFromRow(
      memory.numbers.find((n) => n.kind === kind && n.value === value && n.status !== 'RETIRED') || null,
    );
  }
  try {
    return numberFromRow(
      await db().trackingNumber.findFirst({
        where: { kind, value, status: { not: 'RETIRED' } },
        orderBy: [{ createdAt: 'asc' }],
      }),
    );
  } catch {
    return null;
  }
}

export async function createTrackingNumber(data) {
  if (!DATABASE_ENABLED) {
    const now = new Date().toISOString();
    const row = {
      id: `tn_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`,
      channels: [],
      status: 'PLANNED',
      shared: false,
      notes: null,
      seedKey: null,
      value: null,
      ...data,
      createdAt: now,
      updatedAt: now,
    };
    memory.numbers.push(row);
    return numberFromRow(row);
  }
  const row = await db().trackingNumber.create({ data });
  return numberFromRow(row);
}

export async function updateTrackingNumber(id, patch) {
  if (!DATABASE_ENABLED) {
    const row = memory.numbers.find((n) => n.id === id);
    if (!row) return null;
    Object.assign(row, patch, { updatedAt: new Date().toISOString() });
    return numberFromRow(row);
  }
  try {
    const row = await db().trackingNumber.update({ where: { id }, data: patch });
    return numberFromRow(row);
  } catch {
    return null;
  }
}

/**
 * Record one inbound contact. Dedupe: a non-null externalSid that is
 * already logged collapses to the existing row (Twilio retries and
 * repeat deliveries are one contact). Returns the row, or null when
 * persistence failed — callers treat null as "not logged", never as
 * an error worth surfacing to the contact.
 */
export async function recordContactEvent(data) {
  const sid = data.externalSid || null;
  if (!DATABASE_ENABLED) {
    if (sid) {
      const existing = memory.events.find((e) => e.externalSid === sid);
      if (existing) return eventFromRow(existing);
    }
    const row = {
      id: `ce_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`,
      trackingNumberId: null,
      ...data,
      externalSid: sid,
      createdAt: new Date().toISOString(),
    };
    memory.events.push(row);
    return eventFromRow(row);
  }
  try {
    const row = await db().contactEvent.create({
      data: {
        channel: data.channel,
        trackingNumberId: data.trackingNumberId || null,
        surfaceKey: data.surfaceKey,
        fromNumber: data.fromNumber,
        toNumber: data.toNumber,
        externalSid: sid,
      },
    });
    return eventFromRow(row);
  } catch (err) {
    // P2002 = the externalSid unique constraint: a retry of an
    // already-logged delivery. That is a successful dedupe, not a
    // failure — read the row back so callers see the same shape.
    if (err && err.code === 'P2002' && sid) {
      try {
        return eventFromRow(await db().contactEvent.findUnique({ where: { externalSid: sid } }));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function inWindow(iso, since) {
  return new Date(iso).getTime() >= since.getTime();
}

/**
 * Contact counts since `since`, grouped for the registry read:
 * per trackingNumberId { VOICE: n, SMS: n } plus the unattributed
 * bucket (trackingNumberId null). Real rows only — no rows, no count.
 */
export async function contactCountsSince(since) {
  const byNumber = new Map();
  const unattributed = { VOICE: 0, SMS: 0 };
  const bump = (key, channel) => {
    if (channel !== 'VOICE' && channel !== 'SMS') return;
    if (key === null) {
      unattributed[channel] += 1;
      return;
    }
    if (!byNumber.has(key)) byNumber.set(key, { VOICE: 0, SMS: 0 });
    byNumber.get(key)[channel] += 1;
  };
  if (!DATABASE_ENABLED) {
    for (const e of memory.events) if (inWindow(e.createdAt, since)) bump(e.trackingNumberId || null, e.channel);
    return { byNumber, unattributed };
  }
  try {
    const grouped = await db().contactEvent.groupBy({
      by: ['trackingNumberId', 'channel'],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    });
    for (const g of grouped) {
      const n = g._count?._all || 0;
      for (let i = 0; i < n; i += 1) bump(g.trackingNumberId || null, g.channel);
    }
  } catch {
    /* counts degrade to zero rather than failing the registry read */
  }
  return { byNumber, unattributed };
}

/**
 * Contact counts since `since`, grouped BY SOURCE for the Insights
 * calls-by-source board (2026-11-20, Wave 3 E7):
 *  - bySurface counts only events that matched a registered
 *    tracking number (trackingNumberId set) — grouped by the
 *    surfaceKey the number carries. These are the attributable
 *    calls/texts per source.
 *  - unattributed counts events whose dialed number matched NO
 *    registered ACTIVE number (trackingNumberId null). They reached
 *    a Top Speed line, but no source can honestly be claimed for
 *    them — reported as their own bucket, never folded into a
 *    surface and never dropped.
 * The two sets are disjoint and together cover every event in the
 * window. Real rows only — no rows, no count.
 */
export async function contactCountsBySourceSince(since) {
  const bySurface = new Map();
  const unattributed = { VOICE: 0, SMS: 0 };
  const bumpSurface = (surfaceKey, channel) => {
    if (channel !== 'VOICE' && channel !== 'SMS') return;
    if (!bySurface.has(surfaceKey)) bySurface.set(surfaceKey, { VOICE: 0, SMS: 0 });
    bySurface.get(surfaceKey)[channel] += 1;
  };
  const bumpUnattributed = (channel) => {
    if (channel === 'VOICE' || channel === 'SMS') unattributed[channel] += 1;
  };
  if (!DATABASE_ENABLED) {
    for (const e of memory.events) {
      if (!inWindow(e.createdAt, since)) continue;
      if (e.trackingNumberId) bumpSurface(e.surfaceKey, e.channel);
      else bumpUnattributed(e.channel);
    }
    return { bySurface, unattributed };
  }
  try {
    const attributed = await db().contactEvent.groupBy({
      by: ['surfaceKey', 'channel'],
      where: { createdAt: { gte: since }, trackingNumberId: { not: null } },
      _count: { _all: true },
    });
    for (const g of attributed) {
      const n = g._count?._all || 0;
      for (let i = 0; i < n; i += 1) bumpSurface(g.surfaceKey, g.channel);
    }
    const unattr = await db().contactEvent.groupBy({
      by: ['channel'],
      where: { createdAt: { gte: since }, trackingNumberId: null },
      _count: { _all: true },
    });
    for (const g of unattr) {
      const n = g._count?._all || 0;
      for (let i = 0; i < n; i += 1) bumpUnattributed(g.channel);
    }
  } catch {
    /* counts degrade to zero rather than failing the board read */
  }
  return { bySurface, unattributed };
}

/** Test/drill support: every logged contact event, oldest first. */
export async function listContactEvents() {
  if (!DATABASE_ENABLED) return memory.events.map(eventFromRow);
  try {
    const rows = await db().contactEvent.findMany({ orderBy: [{ createdAt: 'asc' }] });
    return rows.map(eventFromRow);
  } catch {
    return [];
  }
}

/**
 * Delete one tracking-number row (owner record-keeping, 2026-11-23 —
 * Ramone's directive superseded the retire-only design). The contact
 * LOG is history and is never deleted with the number: in database
 * mode the ContactEvent.trackingNumber relation is onDelete:SetNull,
 * and memory mode nulls the same field, so past calls/texts stay on
 * record, just unattributed to a registry row. Answers the removed
 * row, or null when no row carries the id.
 */
export async function deleteTrackingNumber(id) {
  if (!DATABASE_ENABLED) {
    const index = memory.numbers.findIndex((n) => n.id === id);
    if (index === -1) return null;
    const [row] = memory.numbers.splice(index, 1);
    for (const event of memory.events) {
      if (event.trackingNumberId === id) event.trackingNumberId = null;
    }
    return numberFromRow(row);
  }
  try {
    const existing = await db().trackingNumber.findUnique({ where: { id } });
    if (!existing) return null;
    await db().trackingNumber.delete({ where: { id } });
    return numberFromRow(existing);
  } catch {
    return null;
  }
}
