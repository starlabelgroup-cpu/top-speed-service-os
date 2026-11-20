import { store } from '../data/store.js';
import { effectiveArea } from '../config/serviceAreas.js';

/**
 * Dispatch map + distance ordering (2026-11-20, D7 — Ramone approved
 * all 55 recommendations).
 *
 * What positions the platform REALLY has, stated plainly:
 *  - A technician's live GPS exists only when their device reported
 *    it on an assignment (DispatchAssignment.lastLat/lastLng — the
 *    Track My Tech feed). That is a real position.
 *  - A job has NO stored coordinates. Its service address resolves
 *    into the platform's area model at intake (the 12 core crew
 *    areas by ZIP or city; since the A6 widening, 2026-11-20, any of
 *    the 65 published cities by stated name), so a job is placed at
 *    its AREA CENTER (the city center of its covered area). Verified
 *    centers are recorded below for the 12 core areas; a job in any
 *    other resolved city is listed as unpositioned rather than
 *    pinned at an unverified point. Placement is an approximation
 *    and is labeled as one everywhere it shows.
 *  - No geocoding and no Google Distance Matrix call exists in this
 *    platform today (no billable maps API is enabled), so every
 *    distance here is a STRAIGHT-LINE (haversine) distance in miles.
 *    It is labeled "by distance" / "straight-line" — never "drive
 *    time", never an ETA.
 *
 * Nothing in this module assigns or dispatches: positions and
 * distances are advice for the Service Setter, who makes every
 * assignment through the existing approval step (standing rule).
 */

/** City-center coordinates of the 12 covered service areas. */
export const AREA_CENTROIDS = {
  Lauderhill: { lat: 26.1404, lng: -80.2139 },
  Plantation: { lat: 26.1276, lng: -80.2331 },
  Sunrise: { lat: 26.1572, lng: -80.2869 },
  Tamarac: { lat: 26.2036, lng: -80.2464 },
  'Fort Lauderdale': { lat: 26.1224, lng: -80.1373 },
  'Lauderdale Lakes': { lat: 26.1668, lng: -80.2089 },
  'North Lauderdale': { lat: 26.1777, lng: -80.2264 },
  Davie: { lat: 26.0765, lng: -80.2521 },
  'Coral Springs': { lat: 26.2712, lng: -80.2706 },
  'Pompano Beach': { lat: 26.2379, lng: -80.1248 },
  'Oakland Park': { lat: 26.1723, lng: -80.1319 },
  Margate: { lat: 26.2445, lng: -80.2064 },
};

const EARTH_RADIUS_MILES = 3958.8;

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

/** Straight-line (great-circle) distance in miles between two points. */
export function haversineMiles(a, b) {
  if (!a || !b) return null;
  const lat1 = Number(a.lat);
  const lng1 = Number(a.lng);
  const lat2 = Number(b.lat);
  const lng2 = Number(b.lng);
  if (![lat1, lng1, lat2, lng2].every(Number.isFinite)) return null;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function roundMiles(miles) {
  if (miles == null || !Number.isFinite(miles)) return null;
  return Math.round(miles * 10) / 10;
}

/**
 * Where a job sits on the map: its service area's center. Null when
 * the booking has no resolved covered area (AREA_REVIEW / OUT_OF_AREA
 * or an unknown city) — the job is then listed as unpositioned rather
 * than pinned somewhere invented.
 */
export function jobPosition(booking) {
  const area = effectiveArea(booking);
  const centroid = area ? AREA_CENTROIDS[area] : null;
  if (!centroid) return null;
  return { lat: centroid.lat, lng: centroid.lng, basis: 'AREA_CENTER', area };
}

/**
 * Where a technician sits on the map, best real evidence first:
 *  1. GPS — the freshest device-reported position across the
 *     provider's assignments (any status that can carry a live
 *     report), with its report time.
 *  2. CURRENT_JOB_AREA — no GPS on file, but the tech holds an
 *     approved/accepted assignment: the area center of that job.
 *  3. null — no position evidence at all; the tech is listed as
 *     unpositioned and sorts last in distance order.
 */
export function providerPosition(providerId, { assignments = null, bookingsById = null } = {}) {
  const all = assignments || [...store.dispatchAssignments.values()];
  const mine = all.filter((a) => a.providerId === providerId);
  let gps = null;
  for (const a of mine) {
    if (a.lastLat == null || a.lastLng == null) continue;
    const at = a.lastLocationAt ? String(a.lastLocationAt) : '';
    if (!gps || at > gps.at) gps = { lat: a.lastLat, lng: a.lastLng, at: a.lastLocationAt || null };
  }
  if (gps) return { lat: gps.lat, lng: gps.lng, basis: 'GPS', at: gps.at };
  const byId = bookingsById || store.bookings;
  const open = mine
    .filter((a) => a.status === 'APPROVED' || a.status === 'ACCEPTED')
    .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
  for (const a of open) {
    const booking = byId.get ? byId.get(a.bookingId) : null;
    const pos = booking ? jobPosition(booking) : null;
    if (pos) return { lat: pos.lat, lng: pos.lng, basis: 'CURRENT_JOB_AREA', area: pos.area };
  }
  return null;
}

/**
 * Straight-line distance from a provider's best known position to a
 * job's area center. Returns { miles, basis } where basis names the
 * position evidence used ('GPS' | 'CURRENT_JOB_AREA'), or
 * { miles: null, basis: null } when either side has no position.
 */
export function distanceToJob(providerId, booking, context = {}) {
  const target = jobPosition(booking);
  if (!target) return { miles: null, basis: null };
  const origin = providerPosition(providerId, context);
  if (!origin) return { miles: null, basis: null };
  return { miles: roundMiles(haversineMiles(origin, target)), basis: origin.basis };
}

/** Sort comparator: distance ascending, unknown distances last. */
export function byDistanceAsc(a, b) {
  const da = a.distanceMiles;
  const db = b.distanceMiles;
  if (da == null && db == null) return String(a.businessName || '').localeCompare(String(b.businessName || ''));
  if (da == null) return 1;
  if (db == null) return -1;
  if (da !== db) return da - db;
  return String(a.businessName || '').localeCompare(String(b.businessName || ''));
}

export const DISTANCE_NOTE =
  'Distances are straight-line miles from each tech\u2019s latest known position (live GPS when their device has reported, otherwise the area of the job they are on) to this job\u2019s service-area center \u2014 distance only, not drive time. The ranked list remains the recommendation; a Service Setter makes every assignment.';
