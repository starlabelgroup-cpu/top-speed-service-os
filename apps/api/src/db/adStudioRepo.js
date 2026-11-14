import { store } from '../data/store.js';
import { DATABASE_ENABLED, db } from './client.js';

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
    destinationUrl: row.destinationUrl,
    sourceTag: row.sourceTag,
    placement: row.placement || 'NONE',
    bannerId: row.bannerId || null,
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
    return rows.length;
  } catch (error) {
    // A missing table mid-deploy degrades to an empty studio, exactly
    // like the Media OS hydration — never blocks the platform.
    console.error('hydrateAdCampaigns degraded', error?.message || error);
    return store.adCampaigns.length;
  }
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
      destinationUrl: record.destinationUrl,
      sourceTag: record.sourceTag,
      placement: record.placement || 'NONE',
      bannerId: record.bannerId || null,
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
