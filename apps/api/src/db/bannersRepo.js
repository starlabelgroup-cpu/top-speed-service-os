import { createId, store } from '../data/store.js';
import { DATABASE_ENABLED, db } from './client.js';

/**
 * Advertiser banner system — direct-sold creatives that rotate in the
 * site's banner slots (streaming delivery: the slot fetches the active
 * set and rotates without a page reload). Impressions and clicks are
 * counted per creative so advertisers get real reporting from the
 * Service OS. Persisted to the Banner table and hydrated at cold start.
 * Google AdSense is the backfill layer and activates separately, only
 * when a publisher ID is configured on the web side.
 */

function iso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function toStoreBanner(row) {
  return {
    id: row.id,
    placement: row.placement,
    advertiserName: row.advertiserName,
    headline: row.headline,
    copy: row.copy || null,
    imageUrl: row.imageUrl || null,
    ctaText: row.ctaText || null,
    ctaUrl: row.ctaUrl,
    active: row.active !== false,
    impressions: row.impressions || 0,
    clicks: row.clicks || 0,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export async function persistBanner(banner) {
  if (!DATABASE_ENABLED || !banner?.id) return;
  try {
    const row = {
      id: banner.id,
      placement: banner.placement,
      advertiserName: banner.advertiserName,
      headline: banner.headline,
      copy: banner.copy || null,
      imageUrl: banner.imageUrl || null,
      ctaText: banner.ctaText || null,
      ctaUrl: banner.ctaUrl,
      active: banner.active !== false,
      impressions: banner.impressions || 0,
      clicks: banner.clicks || 0,
      createdAt: new Date(banner.createdAt),
      updatedAt: new Date(banner.updatedAt || banner.createdAt),
    };
    await db().banner.upsert({ where: { id: row.id }, update: row, create: row });
  } catch (error) {
    console.error('persistBanner failed', error?.message || error);
  }
}

export async function bumpBannerCounter(id, field) {
  const banner = store.banners.find((b) => b.id === id);
  if (banner) banner[field] = (banner[field] || 0) + 1;
  if (!DATABASE_ENABLED) return;
  try {
    await db().banner.update({ where: { id }, data: { [field]: { increment: 1 } } });
  } catch (error) {
    console.error('bumpBannerCounter failed', error?.message || error);
  }
}

const HOUSE_SEEDS = [
  {
    placement: 'FOOTER',
    advertiserName: 'Top Speed (house)',
    headline: 'GET TOP SPEED.',
    copy: 'Your appliance repair starts here — same-day slots across Broward County. $99 diagnostic, collected at booking and credited toward your repair.',
    imageUrl: '/graphic-gettopspeed.jpg',
    ctaText: 'Book Service',
    ctaUrl: 'https://topspeedserviceos.com/#book',
  },
  {
    placement: 'FOOTER',
    advertiserName: 'Top Speed Ads (house)',
    headline: 'YOUR BUSINESS HERE',
    copy: 'Reach Broward homeowners, property managers and commercial accounts where they book appliance service. Direct placements, real impression and click reporting.',
    imageUrl: null,
    ctaText: 'Advertise with us',
    ctaUrl: 'https://topspeedserviceos.com/advertise',
  },
];

export async function hydrateBanners() {
  if (!DATABASE_ENABLED) {
    if (!store.banners.length) {
      store.banners = HOUSE_SEEDS.map((seed) => ({
        ...seed,
        id: createId(),
        active: true,
        impressions: 0,
        clicks: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }));
    }
    return store.banners.length;
  }
  const rows = await db().banner.findMany({ orderBy: { createdAt: 'asc' } });
  if (!rows.length) {
    for (const seed of HOUSE_SEEDS) {
      const banner = {
        ...seed,
        id: createId(),
        active: true,
        impressions: 0,
        clicks: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await persistBanner(banner);
    }
    const seeded = await db().banner.findMany({ orderBy: { createdAt: 'asc' } });
    store.banners = seeded.map(toStoreBanner);
    return seeded.length;
  }
  store.banners = rows.map(toStoreBanner);
  return rows.length;
}
