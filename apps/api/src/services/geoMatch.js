import { PUBLISHED_CITIES, SERVICE_CITIES } from '../config/serviceAreas.js';

/**
 * Book by Location (2026-11-23): coordinate → service-area match.
 *
 * The area model itself lives in config/serviceAreas.js (resolveArea):
 * a booking whose stated city names one of the 65 published cities is
 * IN_AREA, an ambiguous covered ZIP is AREA_REVIEW, and anything else
 * is OUT_OF_AREA. This service is the coordinate front door to that
 * SAME model — it invents no coverage of its own:
 *
 * - The city set is PUBLISHED_CITIES itself (imported, never copied),
 *   so the geo matcher can never drift from the directory.
 * - The outcome vocabulary is the matcher's own: IN_AREA /
 *   AREA_REVIEW / OUT_OF_AREA.
 * - A coordinate resolves to the NEAREST published city by centroid
 *   distance. Within IN_AREA_RADIUS_MILES of a published city's
 *   centroid it is IN_AREA — the coordinate equivalent of the matcher
 *   accepting a stated covered city. Between that radius and
 *   EDGE_RADIUS_MILES it is AREA_REVIEW — the coordinate equivalent
 *   of the matcher's ambiguity outcome: near coverage, not certainly
 *   in it, a Service Setter confirms on the call. Beyond the edge
 *   radius it is OUT_OF_AREA — recorded as the expansion signal,
 *   never promised service, exactly like the matcher.
 *
 * Centroids are approximate published city-center coordinates (public
 * factual geography), keyed by the PUBLISHED_CITIES names. The drill
 * asserts every published city carries a centroid, so a city added to
 * the directory without coordinates fails loudly instead of silently
 * never matching.
 */
export const IN_AREA_RADIUS_MILES = 8;
export const EDGE_RADIUS_MILES = 16;

const CITY_CENTROIDS = {
  // Broward (31).
  Lauderhill: [26.1407, -80.2134],
  Plantation: [26.1276, -80.2331],
  Sunrise: [26.1573, -80.2565],
  Tamarac: [26.2126, -80.2456],
  'Fort Lauderdale': [26.1224, -80.1373],
  'Lauderdale Lakes': [26.1668, -80.2073],
  'North Lauderdale': [26.2176, -80.2218],
  Davie: [26.0765, -80.2521],
  'Coral Springs': [26.2712, -80.2706],
  'Pompano Beach': [26.2379, -80.1248],
  'Oakland Park': [26.1723, -80.1318],
  Margate: [26.2445, -80.2064],
  Hollywood: [26.0112, -80.1495],
  'Pembroke Pines': [26.0078, -80.2963],
  Miramar: [25.9873, -80.3030],
  'Deerfield Beach': [26.3184, -80.0998],
  'Coconut Creek': [26.2517, -80.1789],
  'Dania Beach': [26.0526, -80.1467],
  'Cooper City': [26.0575, -80.2716],
  Weston: [26.1004, -80.3998],
  Parkland: [26.3048, -80.2364],
  'Hallandale Beach': [25.9830, -80.1484],
  'Wilton Manors': [26.1605, -80.1396],
  'Lighthouse Point': [26.2757, -80.0873],
  'Lauderdale-by-the-Sea': [26.1901, -80.0961],
  'Southwest Ranches': [26.0584, -80.3373],
  'West Park': [25.9835, -80.1842],
  'Pembroke Park': [25.9832, -80.1765],
  'Hillsboro Beach': [26.2930, -80.0786],
  'Sea Ranch Lakes': [26.2023, -80.0954],
  'Lazy Lake': [26.1598, -80.1463],
  // Palm Beach (16).
  'West Palm Beach': [26.7053, -80.0364],
  'Boca Raton': [26.3683, -80.1289],
  'Boynton Beach': [26.5253, -80.0664],
  'Delray Beach': [26.4615, -80.0728],
  Wellington: [26.6586, -80.2414],
  Jupiter: [26.9342, -80.0942],
  'Palm Beach Gardens': [26.8234, -80.1387],
  'Lake Worth Beach': [26.6164, -80.0587],
  'Riviera Beach': [26.7753, -80.0584],
  Greenacres: [26.6281, -80.1353],
  'Royal Palm Beach': [26.7056, -80.2305],
  'Palm Beach': [26.7056, -80.0340],
  'Belle Glade': [26.6848, -80.6676],
  'Palm Springs': [26.6367, -80.0956],
  'North Palm Beach': [26.8187, -80.0542],
  'Lake Park': [26.8003, -80.0648],
  // Miami-Dade (18).
  Miami: [25.7617, -80.1918],
  Hialeah: [25.8576, -80.2781],
  'Miami Gardens': [25.9420, -80.2456],
  'Miami Beach': [25.7907, -80.1300],
  'North Miami': [25.8950, -80.1820],
  Homestead: [25.4687, -80.4776],
  Doral: [25.8195, -80.3553],
  'Coral Gables': [25.7215, -80.2684],
  Aventura: [25.9565, -80.1392],
  'Cutler Bay': [25.5838, -80.3350],
  'Hialeah Gardens': [25.8722, -80.3518],
  'Sunny Isles Beach': [25.9429, -80.1234],
  'North Miami Beach': [25.9331, -80.1625],
  Sweetwater: [25.7658, -80.3735],
  'Florida City': [25.4479, -80.4796],
  'Key Biscayne': [25.6937, -80.1626],
  Surfside: [25.8792, -80.1259],
  'Bal Harbour': [25.8934, -80.1250],
};

const CORE_CITIES = new Set(SERVICE_CITIES);
const EARTH_RADIUS_MILES = 3958.8;

function haversineMiles(lat1, lng1, lat2, lng2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function isValidCoordinates(lat, lng) {
  return (
    typeof lat === 'number' &&
    typeof lng === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

/**
 * Resolve a device coordinate to the nearest published city and the
 * area tier the booking matcher would express. Returns null for
 * invalid coordinates (callers answer 400 at the route, or drop the
 * geo fields on a booking — geo metadata never blocks a booking).
 */
export function matchCoordinates(lat, lng) {
  if (!isValidCoordinates(lat, lng)) return null;
  let nearest = null;
  for (const { name, county } of PUBLISHED_CITIES) {
    const centroid = CITY_CENTROIDS[name];
    if (!centroid) continue;
    const distance = haversineMiles(lat, lng, centroid[0], centroid[1]);
    if (!nearest || distance < nearest.distanceMiles) {
      nearest = { matchedCity: name, county, distanceMiles: distance };
    }
  }
  if (!nearest) return null;
  const tier =
    nearest.distanceMiles <= IN_AREA_RADIUS_MILES
      ? 'IN_AREA'
      : nearest.distanceMiles <= EDGE_RADIUS_MILES
        ? 'AREA_REVIEW'
        : 'OUT_OF_AREA';
  return {
    matchedCity: nearest.matchedCity,
    tier,
    distanceMiles: Math.round(nearest.distanceMiles * 10) / 10,
    county: nearest.county,
    core: CORE_CITIES.has(nearest.matchedCity),
  };
}

/**
 * The geo fields a booking create may store, derived SERVER-SIDE from
 * the submitted coordinates whenever they are valid — the client's
 * stated city/tier are never trusted over the server's own match.
 * When no valid coordinates arrive, stated fields pass through only
 * if the tier is one of the matcher's own outcomes and the city names
 * a published city; anything else is dropped (returns nulls), so a
 * malformed geo payload degrades to a plain booking, never a failure
 * and never an invented verification.
 */
export function geoFieldsFrom(body) {
  const empty = { geoCity: null, geoTier: null, geoLat: null, geoLng: null };
  if (!body || typeof body !== 'object') return empty;
  const lat = typeof body.geoLat === 'number' ? body.geoLat : Number(body.geoLat);
  const lng = typeof body.geoLng === 'number' ? body.geoLng : Number(body.geoLng);
  if (isValidCoordinates(lat, lng)) {
    const match = matchCoordinates(lat, lng);
    if (match) {
      return {
        /* An OUT_OF_AREA match names only the NEAREST city — storing
           it would read as "verified in <city>" in Book OS, so the
           city is stored only when the location actually matched. */
        geoCity: match.tier === 'OUT_OF_AREA' ? null : match.matchedCity,
        geoTier: match.tier,
        geoLat: Math.round(lat * 1000) / 1000,
        geoLng: Math.round(lng * 1000) / 1000,
      };
    }
  }
  const statedCity = typeof body.geoCity === 'string' ? body.geoCity.trim() : '';
  const statedTier = typeof body.geoTier === 'string' ? body.geoTier.trim() : '';
  const cityKnown = PUBLISHED_CITIES.some(({ name }) => name.toLowerCase() === statedCity.toLowerCase());
  if (cityKnown && ['IN_AREA', 'AREA_REVIEW', 'OUT_OF_AREA'].includes(statedTier)) {
    const canonical = PUBLISHED_CITIES.find(({ name }) => name.toLowerCase() === statedCity.toLowerCase()).name;
    return { geoCity: statedTier === 'OUT_OF_AREA' ? null : canonical, geoTier: statedTier, geoLat: null, geoLng: null };
  }
  return empty;
}

/** Coverage self-check for drills: every published city has a centroid. */
export function centroidCoverage() {
  const missing = PUBLISHED_CITIES.map(({ name }) => name).filter((name) => !CITY_CENTROIDS[name]);
  return { total: PUBLISHED_CITIES.length, covered: PUBLISHED_CITIES.length - missing.length, missing };
}
