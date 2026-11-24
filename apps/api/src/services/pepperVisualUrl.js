/**
 * Pepper Visuals — URL + key helpers (2026-11-23).
 *
 * Ramone's directive: "add pepper image graphic visuals to every
 * in-house ads by flywheel." Every in-house ad — Ads OS stream
 * items, Campaign Engine records, engine-queued Facebook OS
 * drafts — carries the URL of a designed Pepper graphic rendered
 * on demand by services/pepperVisual.js and served from
 * GET /api/v1/ads-os/visual/:key.svg (routes/facebookOs.js).
 *
 * This module is deliberately import-free: claimCheck.js imports
 * campaignFactory.js, and campaignFactory / facebookOs /
 * campaignEngine all import THESE helpers — keeping the helpers
 * pure strings is what keeps the module graph acyclic. The
 * composer (pepperVisual.js) is the only piece that imports the
 * claim gate.
 *
 * Keys are deterministic from the record's own identity:
 *   offer-<offerKey>            the standing Ads OS offer cards
 *   post-<streamPostId>         a POSTED ad-format stream post
 *   campaign-<base64url(key)>   a Campaign Engine registry record
 * No new table, no stored asset: the route resolves the key back
 * to the record and composes the graphic from its own fields.
 */

export const PEPPER_VISUAL_API_BASE = 'https://top-speed-service-os.vercel.app/api/v1';

export const PEPPER_VISUAL_SIZES = {
  landscape: { width: 1200, height: 628 },
  square: { width: 1080, height: 1080 },
  story: { width: 1080, height: 1920 },
};

/** Surfaces whose creative takes an image. SMS and SEARCH_AI are
 *  text-only by design (the factory's own creative specs say so)
 *  and never get a visual forced onto them. */
export const IMAGE_SURFACES = [
  'WEBSITE', 'CITY_SERVICE_PAGES', 'SOCIAL_FB', 'SOCIAL_IG',
  'PEPPER_LISTS', 'ADS_STREAM', 'EMAIL', 'MAPS_PROFILES', 'APP',
  'INTERNAL',
];

const SQUARE_SURFACES = ['SOCIAL_FB', 'SOCIAL_IG', 'PEPPER_LISTS', 'APP'];

export function sizeForSurface(surface) {
  return SQUARE_SURFACES.includes(surface) ? 'square' : 'landscape';
}

export function pepperVisualUrl(key, size = 'landscape') {
  const safeSize = PEPPER_VISUAL_SIZES[size] ? size : 'landscape';
  return `${PEPPER_VISUAL_API_BASE}/ads-os/visual/${key}.svg?size=${safeSize}`;
}

export function offerVisualKey(offer) {
  return `offer-${offer.key}`;
}

export function postVisualKey(post) {
  return `post-${post.id}`;
}

export function campaignVisualKey(campaignKey) {
  return `campaign-${Buffer.from(String(campaignKey), 'utf8').toString('base64url')}`;
}

export function campaignKeyFromVisualKey(key) {
  if (!key.startsWith('campaign-')) return null;
  try {
    return Buffer.from(key.slice('campaign-'.length), 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

/** The visual URL for a Campaign Engine record (generation + read
 *  time + the Facebook OS queue all build it the same way). */
export function campaignVisualUrl(record) {
  if (!record?.campaignKey || !IMAGE_SURFACES.includes(record.surface)) return null;
  return pepperVisualUrl(campaignVisualKey(record.campaignKey), sizeForSurface(record.surface));
}
