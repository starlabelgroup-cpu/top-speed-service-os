import { store } from '../data/store.js';
import { DATABASE_ENABLED, db } from './client.js';
import { hydrateAdvertiserCreatives } from './advertiserCreativesRepo.js';

/**
 * Ad Studio persistence (2026-11-14) — same pattern as the Media OS
 * data layer: the Prisma AdCampaign table is the durable record, the
 * in-memory store is the working set, mutations write through with an
 * upsert, and hydrateAdCampaigns() loads everything at cold start.
 *
 * No seed campaigns: the studio starts empty and honest. Campaigns are
 * created by staff in the console and go live only on the owner's
 * approval (routes/adStudio.js enforces the status machine).
 */

function iso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function toStoreCampaign(row) {
  return {
    id: row.id,
    name: row.name,
    businessLine: row.businessLine,
    objective: row.objective,
    status: row.status || 'DRAFT',
    creativeId: row.creativeId || null,
    creativeUploadId: row.creativeUploadId || null,
    destinationUrl: row.destinationUrl,
    sourceTag: row.sourceTag,
    placement: row.placement || 'NONE',
    bannerId: row.bannerId || null,
    advertiserName: row.advertiserName || null,
    offering: row.offering || null,
    headline: row.headline || null,
    copy: row.copy || null,
    ctaText: row.ctaText || null,
    category: row.category || null,
    imageUrl: row.imageUrl || null,
    streamingFormat: row.streamingFormat || null,
    streamingProviders: row.streamingProviders || [],
    headlines: row.headlines || [],
    descriptions: row.descriptions || [],
    displayPath: row.displayPath || null,
    longHeadline: row.longHeadline || null,
    displaySizes: row.displaySizes || [],
    recordedSpendCents: row.recordedSpendCents ?? null,
    notes: row.notes || null,
    createdById: row.createdById || null,
    approvedById: row.approvedById || null,
    approvedAt: iso(row.approvedAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export async function hydrateAdCampaigns() {
  if (!DATABASE_ENABLED) return store.adCampaigns.length;
  try {
    const rows = await db().adCampaign.findMany({ orderBy: [{ createdAt: 'asc' }] });
    store.adCampaigns = rows.map(toStoreCampaign);
    // Advertiser creative uploads (E3) ride the same cold start.
    await hydrateAdvertiserCreatives();
    return rows.length;
  } catch (error) {
    // A missing table mid-deploy degrades to an empty studio, exactly
    // like the Media OS hydration — never blocks the platform.
    console.error('hydrateAdCampaigns degraded', error?.message || error);
    return store.adCampaigns.length;
  }
}

/**
 * Console-read refresh (snapshot fix, 2026-11-24): serverless
 * instances hydrate the store ONCE at cold start and then serve
 * their in-memory snapshot indefinitely — an instance that started
 * before a campaign change kept serving the old campaign list while
 * fresher instances served the new one, so the Ad Studio list
 * alternated between two snapshots across reloads (a paused campaign
 * reading ACTIVE again, newer campaigns missing). The AdCampaign
 * table is the durable record: refreshAdCampaigns() re-reads it and
 * replaces the working set, so any read that awaits it reflects
 * every persisted campaign change, on every instance. Unlike boot
 * hydration it does NOT degrade silently — a failed read rejects, so
 * callers answer an honest error instead of presenting a stale
 * snapshot as the live state. Concurrent refreshes coalesce into a
 * single table read.
 */
let refreshInFlight = null;
export async function refreshAdCampaigns() {
  if (!DATABASE_ENABLED) return store.adCampaigns.length;
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      const rows = await db().adCampaign.findMany({ orderBy: [{ createdAt: 'asc' }] });
      store.adCampaigns = rows.map(toStoreCampaign);
      return rows.length;
    })().finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}

export async function persistAdCampaign(record) {
  if (!DATABASE_ENABLED || !record?.id) return;
  try {
    const row = {
      id: record.id,
      name: record.name,
      businessLine: record.businessLine,
      objective: record.objective,
      status: record.status || 'DRAFT',
      creativeId: record.creativeId || null,
      creativeUploadId: record.creativeUploadId || null,
      destinationUrl: record.destinationUrl,
      sourceTag: record.sourceTag,
      placement: record.placement || 'NONE',
      bannerId: record.bannerId || null,
      advertiserName: record.advertiserName || null,
      offering: record.offering || null,
      headline: record.headline || null,
      copy: record.copy || null,
      ctaText: record.ctaText || null,
      category: record.category || null,
      imageUrl: record.imageUrl || null,
      streamingFormat: record.streamingFormat || null,
      streamingProviders: record.streamingProviders || [],
      headlines: record.headlines || [],
      descriptions: record.descriptions || [],
      displayPath: record.displayPath || null,
      longHeadline: record.longHeadline || null,
      displaySizes: record.displaySizes || [],
      recordedSpendCents: record.recordedSpendCents ?? null,
      notes: record.notes || null,
      createdById: record.createdById || null,
      approvedById: record.approvedById || null,
      approvedAt: record.approvedAt ? new Date(record.approvedAt) : null,
      createdAt: new Date(record.createdAt),
      updatedAt: new Date(record.updatedAt || record.createdAt),
    };
    await db().adCampaign.upsert({ where: { id: row.id }, update: row, create: row });
  } catch (error) {
    console.error('persistAdCampaign failed', error?.message || error);
  }
}
