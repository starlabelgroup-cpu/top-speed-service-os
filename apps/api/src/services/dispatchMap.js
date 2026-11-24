import { store } from '../data/store.js';
import { effectiveArea } from '../config/serviceAreas.js';
import { distanceMatrix, mapsEnabled } from './googleMaps.js';

/**
 * Dispatch map + distance ordering (2026-11-20, D7 — Ramone approved
 * all 55 recommendations).
 *
 * What positions the platform REALLY has, stated plainly:
 *  - A technician's live GPS exists only when their device reported
 *    it on an assignment (DispatchAssignment.lastLat/lastLng — the
 *    Track My Tech feed). That is a real position.
 *  - A job's service address resolves into the platform's area
 *    model at intake (the 12 core crew areas by ZIP or city; since
 *    the A6 widening, 2026-11-20, any of the 65 published cities by
 *    stated name), so by default a job is placed at its AREA CENTER
 *    (the city center of its covered area). Verified centers are
 *    recorded below for the 12 core areas; a job in any other
 *    resolved city is listed as unpositioned rather than pinned at
 *    an unverified point. Area placement is an approximation and is
 *    labeled as one everywhere it shows. Exception (2026-11-23):
 *    when the Google Maps enrichment geocoded the address at
 *    intake, the job's stored coordinates ARE its real position
 *    (basis 'GOOGLE_GEOCODE') and take precedence — see
 *    jobRealPosition.
 *  - Distances here are STRAIGHT-LINE (haversine) miles by default,
 *    labeled "by distance" / "straight-line" — never "drive time",
 *    never an ETA. Google Maps enrichment (2026-11-23, gated on
 *    GOOGLE_MAPS_API_KEY): when a booking's street address was
 *    geocoded at intake (geoSource 'GOOGLE_GEOCODE'), the job also
 *    has a REAL position, and enrichCandidatesWithDriveTime below
 *    can replace a candidate's straight-line figure with a Google
 *    drive distance/duration — labeled "drive time (Google)" —
 *    when the tech's side is a real GPS position too. With no key
 *    set, none of that runs and every figure stays straight-line.
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
 * A job's REAL position: the Google-geocoded service address, when
 * the Maps enrichment verified one at intake. Device-tap
 * coordinates (geoSource 'CENTROID_MATCH') deliberately do NOT
 * qualify — they are where the customer stood when booking, not a
 * verified service address. Null in every other case.
 */
export function jobRealPosition(booking) {
  if (!booking || booking.geoSource !== 'GOOGLE_GEOCODE') return null;
  const lat = Number(booking.geoLat);
  const lng = Number(booking.geoLng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng, basis: 'GOOGLE_GEOCODE', area: effectiveArea(booking) };
}

/**
 * Where a job sits on the map: its Google-verified address when one
 * was geocoded at intake, else its service area's center. Null when
 * neither exists (AREA_REVIEW / OUT_OF_AREA or an unknown city) —
 * the job is then listed as unpositioned rather than pinned
 * somewhere invented.
 */
export function jobPosition(booking) {
  const real = jobRealPosition(booking);
  if (real) return real;
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
  'Distances are straight-line miles from each tech\u2019s latest known position (live GPS when their device has reported, otherwise the area of the job they are on) to this job\u2019s position (its Google-verified address when one was geocoded at intake, otherwise its service-area center) \u2014 distance only, not drive time. The ranked list remains the recommendation; a Service Setter makes every assignment.';

export const DISTANCE_NOTE_WITH_DRIVE_TIME =
  'Distances are straight-line miles from each tech\u2019s latest known position to this job\u2019s position \u2014 except where a tech\u2019s live GPS and the job\u2019s Google-verified address allow a real road distance, which is labeled drive time (Google) on that candidate. The ranked list remains the recommendation; a Service Setter makes every assignment.';

/**
 * Google drive-time enrichment for ranked assignment candidates
 * (2026-11-23). For each candidate whose position evidence is a
 * REAL device GPS fix, one Distance Matrix call (behind the
 * googleMaps adapter) replaces the straight-line figure with the
 * road distance + duration when the job itself has a real
 * Google-verified position. Candidates without GPS keep their
 * straight-line figure and label — an area center is an
 * approximation, and a drive time computed from one would dress a
 * guess up as a measurement. The ranked order (by score) is never
 * touched; the caller re-sorts its by-distance lens afterwards.
 *
 * Mutates the enriched candidates in place and resolves
 * { enriched } — false (with zero mutation) when Maps is off,
 * the job has no verified position, no candidate has GPS, or
 * Google cannot answer.
 */
export async function enrichCandidatesWithDriveTime(booking, candidates, context = {}) {
  if (!mapsEnabled()) return { enriched: false };
  if (!Array.isArray(candidates) || !candidates.length) return { enriched: false };
  const target = jobRealPosition(booking);
  if (!target) return { enriched: false };
  const jobs = [];
  for (const candidate of candidates) {
    const origin = providerPosition(candidate.providerId, context);
    if (origin && origin.basis === 'GPS') jobs.push({ candidate, origin });
  }
  if (!jobs.length) return { enriched: false };
  const legs = await distanceMatrix(
    jobs.map((j) => j.origin),
    target,
  );
  if (!legs) return { enriched: false };
  let enriched = false;
  jobs.forEach((job, i) => {
    const leg = legs[i];
    if (!leg) return;
    enriched = true;
    job.candidate.distanceMiles = leg.distanceMiles;
    job.candidate.distanceMode = 'DRIVE_TIME_GOOGLE';
    job.candidate.driveDurationMinutes = leg.durationMinutes;
    const label = `About ${leg.distanceMiles} mi \u00b7 ~${leg.durationMinutes} min drive time (Google) from live GPS`;
    const reasons = Array.isArray(job.candidate.reasons) ? job.candidate.reasons : [];
    const idx = reasons.findIndex(
      (r) => r && r.kind === 'info' && typeof r.label === 'string' && r.label.includes('(straight-line'),
    );
    if (idx >= 0) reasons[idx] = { ...reasons[idx], label };
    else reasons.push({ kind: 'info', label });
    job.candidate.reasons = reasons;
  });
  if (enriched) {
    for (const candidate of candidates) {
      if (!candidate.distanceMode) candidate.distanceMode = 'STRAIGHT_LINE';
    }
  }
  return { enriched };
}
