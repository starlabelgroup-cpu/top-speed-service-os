import { createId, store } from '../data/store.js';
import { DATABASE_ENABLED, db } from './client.js';
import { AD_CREATIVE_SEEDS } from '../data/adCreativeSeeds.js';

/**
 * Ads Library persistence (2026-11-24) — the creative registry
 * behind the Flywheel streaming system. Same discipline as Ad
 * Studio's repo: the Prisma AdCreative table is the durable record,
 * the in-memory store is the working set, mutations write through
 * with an upsert, and hydrateAdCreatives() loads everything at cold
 * start (it rides the Ad Studio hydration in db/adStudioRepo.js).
 *
 * Seeding: whenever the table is missing any key from the real
 * house creative set (data/adCreativeSeeds.js — Pepper's
 * claim-checked photo batch, the Flywheel display + text pack,
 * the standing Pepper-visual offer cards, and later additions
 * like the 2026-11-25 accounts + rewards set), the missing seeds
 * are registered. Seeding is by key upsert, so it can never
 * duplicate a creative, and it never touches a row that already
 * exists — a creative staff paused in the Ads OS Manager stays
 * paused across every cold start.
 */

function iso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function toStoreCreative(row) {
  return {
    id: row.id,
    key: row.key,
    kind: row.kind,
    title: row.title,
    headline: row.headline || null,
    subline: row.subline || null,
    ctaText: row.ctaText || null,
    serviceTag: row.serviceTag || null,
    cityTag: row.cityTag || null,
    assetKind: row.assetKind || 'NONE',
    assetRef: row.assetRef || null,
    formats: row.formats || [],
    destinationUrl: row.destinationUrl,
    claimStatus: row.claimStatus || 'CLEAN',
    status: row.status || 'ACTIVE',
    served: row.served || 0,
    clicked: row.clicked || 0,
    sortOrder: row.sortOrder || 0,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function toRow(record) {
  return {
    id: record.id,
    key: record.key,
    kind: record.kind,
    title: record.title,
    headline: record.headline || null,
    subline: record.subline || null,
    ctaText: record.ctaText || null,
    serviceTag: record.serviceTag || null,
    cityTag: record.cityTag || null,
    assetKind: record.assetKind || 'NONE',
    assetRef: record.assetRef || null,
    formats: record.formats || [],
    destinationUrl: record.destinationUrl,
    claimStatus: record.claimStatus || 'CLEAN',
    status: record.status || 'ACTIVE',
    served: record.served || 0,
    clicked: record.clicked || 0,
    sortOrder: record.sortOrder || 0,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt || record.createdAt),
  };
}

async function seedAdCreatives() {
  const now = new Date().toISOString();
  let order = 0;
  for (const seed of AD_CREATIVE_SEEDS) {
    const record = {
      id: createId(),
      ...seed,
      claimStatus: 'CLEAN',
      status: 'ACTIVE',
      served: 0,
      clicked: 0,
      sortOrder: order,
      createdAt: now,
      updatedAt: now,
    };
    order += 1;
    await db().adCreative.upsert({
      where: { key: record.key },
      update: {},
      create: toRow(record),
    });
  }
}

export async function hydrateAdCreatives() {
  if (!DATABASE_ENABLED) return store.adCreatives.length;
  try {
    let rows = await db().adCreative.findMany({ orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
    const haveKeys = new Set(rows.map((row) => row.key));
    if (AD_CREATIVE_SEEDS.some((seed) => !haveKeys.has(seed.key))) {
      // Upsert-by-key with an empty update: registers any seed the
      // table is missing (new house creatives — e.g. the 2026-11-25
      // accounts + rewards set — land on the next cold start) and
      // never touches a row that already exists.
      await seedAdCreatives();
      rows = await db().adCreative.findMany({ orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
    }
    store.adCreatives = rows.map(toStoreCreative);
    return rows.length;
  } catch (error) {
    // A missing table mid-deploy degrades to an empty library,
    // exactly like the Ad Studio hydration — the stream answers an
    // honest empty slot and the platform never blocks on the library.
    console.error('hydrateAdCreatives degraded', error?.message || error);
    return store.adCreatives.length;
  }
}

/**
 * Manager-read refresh — the strict twin of refreshAdCampaigns
 * (the 2026-11-24 snapshot fix): serverless instances hydrate once
 * at cold start, so a console read that served the in-memory list
 * could show a creative's status or counters long after another
 * instance changed them. refreshAdCreatives() re-reads the table
 * and replaces the working set; a failed read REJECTS so the
 * Manager answers an honest error instead of a stale snapshot.
 * Concurrent refreshes coalesce into a single table read.
 */
let refreshInFlight = null;
export async function refreshAdCreatives() {
  if (!DATABASE_ENABLED) return store.adCreatives.length;
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      const rows = await db().adCreative.findMany({ orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
      store.adCreatives = rows.map(toStoreCreative);
      return rows.length;
    })().finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}

export async function persistAdCreative(record) {
  if (!DATABASE_ENABLED || !record?.id) return;
  try {
    const row = toRow(record);
    await db().adCreative.upsert({ where: { id: row.id }, update: row, create: row });
  } catch (error) {
    console.error('persistAdCreative failed', error?.message || error);
  }
}

/**
 * Counter discipline identical to bumpBannerCounter: the in-memory
 * record moves immediately (the rotation reads it on the next
 * request this instance serves) and the table takes an atomic
 * increment, so counters are never lost to a read-modify-write race.
 */
export async function bumpAdCreativeCounter(key, field) {
  const creative = store.adCreatives.find((c) => c.key === key);
  if (creative) creative[field] = (creative[field] || 0) + 1;
  if (!DATABASE_ENABLED) return;
  try {
    await db().adCreative.update({ where: { key }, data: { [field]: { increment: 1 } } });
  } catch (error) {
    console.error('bumpAdCreativeCounter failed', error?.message || error);
  }
}
