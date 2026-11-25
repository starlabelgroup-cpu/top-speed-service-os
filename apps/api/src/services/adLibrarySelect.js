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
 *   - Kind alternation (2026-11-24, Ramone: "Both display ads and
 *     text ads streaming access all platforms"): the library holds
 *     far more IMAGE creatives than TEXT ones, so a plain fair
 *     rotation crowds the text ads out of most surfaces. Every
 *     serve bumps exactly one creative's served counter (the route
 *     counts the impression synchronously in the working set), so
 *     the parity of the eligible pool's total served flips on
 *     every serve — the slot deals IMAGE and TEXT in strict
 *     alternation whenever both kinds are eligible for it. On a
 *     kind's turn, its own best tier wins: a service slot still
 *     shows its service-matched photo on IMAGE turns, and the
 *     general text ads (untagged, eligible everywhere) take the
 *     TEXT turns. Inside the winning kind+tier, rotation stays
 *     fair: the least-served creatives go first and the pick is
 *     random among the three least-served, so no single creative
 *     can dominate a surface and reloads visibly rotate.
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

function leastServedPick(pool, random) {
  const sorted = pool.slice().sort((a, b) => (a.served || 0) - (b.served || 0));
  const finalists = sorted.slice(0, Math.min(3, sorted.length));
  return finalists[Math.floor(random() * finalists.length)] || null;
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
  const tierNums = [...tiers.keys()].sort((a, b) => a - b);
  if (!tierNums.length) return null;
  const union = tierNums.flatMap((tier) => tiers.get(tier));
  const totalServed = union.reduce((sum, c) => sum + (c.served || 0), 0);
  const preferredKind = totalServed % 2 === 0 ? 'TEXT' : 'IMAGE';
  for (const tier of tierNums) {
    const kindPool = tiers.get(tier).filter((c) => c.kind === preferredKind);
    if (kindPool.length) return leastServedPick(kindPool, random);
  }
  // The preferred kind is not eligible in any tier for this slot
  // (single-kind pool): fair rotation in the winning tier.
  return leastServedPick(tiers.get(tierNums[0]), random);
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
