/**
 * Top Speed Academy — track table (2026-11-20, recommendations D12).
 *
 * The Academy curriculum is 50 modules in 10 tracks. The track a
 * module belongs to is a function of its module NUMBER, and the
 * number is read off the module record itself (its slug
 * `training-module-N-…`, else its "Module N:" title) — the exact
 * derivation the Academy page (apps/web/academy/index.html) has
 * always rendered by. This module is that same table on the API
 * side, so completions, certifications and the page can never
 * disagree about what a track is.
 *
 * A track CERTIFICATION is derived from completion records
 * (services/academyCerts.js): every live module of the track
 * completed. Nothing here grants a role, a credential or access —
 * a certification is a training record the office can see, under
 * the 2026-11-10 authority limits (overriding technician
 * credentials is never AI).
 */
export const ACADEMY_TRACKS = [
  { name: 'Foundation', sub: 'Every role — start here', lo: 1, hi: 3 },
  { name: 'Owner Track', sub: 'The owner', lo: 4, hi: 7 },
  { name: 'Manager Track', sub: 'Managers', lo: 8, hi: 11 },
  { name: 'Technician Track', sub: 'Technicians & field providers', lo: 12, hi: 15 },
  { name: 'Setter Track', sub: 'Service Setters — the dispatch team', lo: 16, hi: 19 },
  { name: 'Dispatcher Track', sub: 'Dispatchers', lo: 20, hi: 22 },
  { name: 'Ad Specialist Track', sub: 'Ads & marketing', lo: 23, hi: 26 },
  { name: 'Customer-Facing', sub: 'Everyone who talks to customers', lo: 27, hi: 29 },
  { name: 'System Navigator', sub: 'Know Your Platform — every role', lo: 30, hi: 38 },
  { name: 'Ads & Bookings Operations', sub: 'Run ads, process bookings & requests — operations roles', lo: 39, hi: 50 },
];

/** Module number from a curriculum record — the page's own regexes. */
export function moduleNumberOf(record) {
  const fromSlug = /training-module-(\d+)-/.exec(record?.slug || '');
  if (fromSlug) return parseInt(fromSlug[1], 10);
  const fromTitle = /^Module\s+(\d+)\s*:/.exec(record?.title || '');
  return fromTitle ? parseInt(fromTitle[1], 10) : 0;
}

/** The track a module number belongs to, or null outside 1–50. */
export function trackOfModule(moduleNumber) {
  for (const track of ACADEMY_TRACKS) {
    if (moduleNumber >= track.lo && moduleNumber <= track.hi) return track;
  }
  return null;
}

/**
 * Dispatch weighing policy for certifications (D12) — the ONLY
 * place these numbers live. Certifications are one factor among the
 * ranking's existing ones (specialty, area, rating, load, van
 * stock, history); they never change eligibility, which stays on
 * the matcher's long-standing base score.
 *
 *  - Technician Track is the field certification: a certified tech
 *    is the platform's trained pair of hands, so it weighs on every
 *    appliance job — and weighs EXTRA for Refrigerator work, the
 *    sealed-system end of the trade (the owner's example: sealed-
 *    system certification ranks a tech higher for refrigerator
 *    jobs; refrigerant work is licensed, human-professional work —
 *    knowledge/industry.js).
 *  - Foundation is the every-role base: a small weight everywhere.
 *  - The office tracks (Setter, Dispatcher, Manager, Owner, Ad
 *    Specialist, Customer-Facing, System Navigator, Ads &
 *    Bookings) certify office skills; they show on the profile and
 *    weigh nothing in field dispatch.
 */
export const CERT_DISPATCH_POLICY = {
  'Technician Track': { points: 8, specialtyAppliance: 'Refrigerator', specialtyPoints: 6 },
  Foundation: { points: 2 },
};
