/**
 * Ads Library slot selection (2026-11-24) — the pure half of the
 * streaming endpoint, kept side-effect free so the rotation can be
 * drilled without a database.
 *
 * Pool discipline:
 *   - Only ACTIVE creatives whose claimStatus is CLEAN ever serve.
 *   - Tag matching is exact-label, like the display feed's
 *     relatedness: a service slot prefers creatives tagged with
 *     that service, a city slot prefers its city, and untagged
 *     (general) creatives are the universal fallback. A creative
 *     tagged for a DIFFERENT service or city never leaks into the
 *     slot — a washer page shows washer ads or general ads, never
 *     a refrigerator ad.
 *   - Priority: service+city match → service match → city match →
 *     general.
 *   - Fair rotation inside the winning tier: the least-served
 *     creatives go first; among the three least-served, the pick
 *     is random, so no single creative can dominate a surface and
 *     reloads visibly rotate.
 */

function norm(value) {
  return String(value || '').trim().toLowerCase();
}

export function creativeTier(creative, service, city) {
  const svc = norm(service);
  const cty = norm(city);
  const cSvc = norm(creative.serviceTag);
  const cCty = norm(creative.cityTag);
  if (svc && cSvc && cSvc !== svc) return -1;
  if (cty && cCty && cCty !== cty) return -1;
  if (svc && cty && cSvc === svc && cCty === cty) return 0;
  if (svc && cSvc === svc) return 1;
  if (cty && cCty === cty) return 2;
  if (!cSvc && !cCty) return 3;
  // Tagged for exactly one dimension the slot did not ask about
  // (e.g. a city creative in a service-only slot): not eligible —
  // it belongs to its own tagged slots.
  return -1;
}

export function selectCreative(creatives, { service = '', city = '', format = '' } = {}, random = Math.random) {
  const eligible = (creatives || []).filter(
    (c) => c.status === 'ACTIVE' && (c.claimStatus || 'CLEAN') === 'CLEAN',
  );
  const tiers = new Map();
  for (const creative of eligible) {
    const tier = creativeTier(creative, service, city);
    if (tier < 0) continue;
    if (!tiers.has(tier)) tiers.set(tier, []);
    tiers.get(tier).push(creative);
  }
  const bestTier = [...tiers.keys()].sort((a, b) => a - b)[0];
  if (bestTier === undefined) return null;
  const pool = tiers.get(bestTier).slice().sort((a, b) => (a.served || 0) - (b.served || 0));
  const finalists = pool.slice(0, Math.min(3, pool.length));
  return finalists[Math.floor(random() * finalists.length)] || null;
}

/**
 * Which embedded/visual variant a slot format asks for. Photo
 * creatives carry master (1600×1600) + landscape (1200×628);
 * 'square' slots take the master, everything else the landscape
 * when it exists. Returns null when the creative has no such
 * asset (text creatives).
 */
export function variantForFormat(creative, format) {
  if (!creative || creative.assetKind === 'NONE') return null;
  // The Pepper visual service renders by size name, not by variant.
  if (creative.assetKind === 'VISUAL') return norm(format) === 'square' ? 'square' : 'landscape';
  const want = norm(format) === 'square' ? 'master' : 'landscape';
  const has = (v) => (creative.formats || []).includes(v === 'master' ? '1600x1600' : '1200x628');
  if (has(want)) return want;
  return has('master') ? 'master' : has('landscape') ? 'landscape' : null;
}
