export const SERVICE_AREAS = [
  { city: 'Lauderhill', zips: ['33313', '33319', '33351'] },
  { city: 'Plantation', zips: ['33313', '33317', '33322', '33323', '33324', '33325', '33388'] },
  { city: 'Sunrise', zips: ['33313', '33322', '33323', '33326', '33351'] },
  { city: 'Tamarac', zips: ['33309', '33319', '33321', '33351', '33359'] },
  {
    city: 'Fort Lauderdale',
    zips: ['33301', '33302', '33303', '33304', '33305', '33306', '33307', '33308', '33309', '33311', '33312', '33313', '33314', '33315', '33316', '33317', '33319', '33334'],
  },
  { city: 'Lauderdale Lakes', zips: ['33309', '33311', '33313', '33319'] },
  { city: 'North Lauderdale', zips: ['33068', '33319'] },
  { city: 'Davie', zips: ['33312', '33314', '33317', '33324', '33325', '33326', '33328', '33329', '33330', '33331', '33332'] },
  { city: 'Coral Springs', zips: ['33065', '33067', '33071', '33073', '33075', '33076', '33077'] },
  { city: 'Pompano Beach', zips: ['33060', '33061', '33062', '33063', '33064', '33066', '33067', '33068', '33069', '33072', '33073', '33074'] },
  { city: 'Oakland Park', zips: ['33309', '33311', '33334'] },
  { city: 'Margate', zips: ['33063', '33068', '33073', '33093'] },
];

export const SERVICE_CITIES = SERVICE_AREAS.map(({ city }) => city);
export const SERVICE_ZIPS = new Set(SERVICE_AREAS.flatMap(({ zips }) => zips));

/**
 * The 65 PUBLISHED service cities (2026-11-20) — every city with a
 * published Top Speed landing page in the Service Areas directory
 * (Broward 31, Palm Beach 16, Miami-Dade 18). This list is the
 * directory's own city index, transcribed into the area model when
 * booking auto-match widened from the 12 core cities to all 65
 * published cities (Ramone's approved recommendation A6). The 12 core
 * cities above remain the ZIP-resolved crew areas; the other 53 are
 * matched by stated city name (no ZIP table is published for them, so
 * ZIP-only resolution still runs on the core table).
 */
export const PUBLISHED_CITIES = [
  // Broward (31) — the 12 core crew cities first.
  { name: 'Lauderhill', slug: 'lauderhill', county: 'Broward' },
  { name: 'Plantation', slug: 'plantation', county: 'Broward' },
  { name: 'Sunrise', slug: 'sunrise', county: 'Broward' },
  { name: 'Tamarac', slug: 'tamarac', county: 'Broward' },
  { name: 'Fort Lauderdale', slug: 'fort-lauderdale', county: 'Broward' },
  { name: 'Lauderdale Lakes', slug: 'lauderdale-lakes', county: 'Broward' },
  { name: 'North Lauderdale', slug: 'north-lauderdale', county: 'Broward' },
  { name: 'Davie', slug: 'davie', county: 'Broward' },
  { name: 'Coral Springs', slug: 'coral-springs', county: 'Broward' },
  { name: 'Pompano Beach', slug: 'pompano-beach', county: 'Broward' },
  { name: 'Oakland Park', slug: 'oakland-park', county: 'Broward' },
  { name: 'Margate', slug: 'margate', county: 'Broward' },
  { name: 'Hollywood', slug: 'hollywood', county: 'Broward' },
  { name: 'Pembroke Pines', slug: 'pembroke-pines', county: 'Broward' },
  { name: 'Miramar', slug: 'miramar', county: 'Broward' },
  { name: 'Deerfield Beach', slug: 'deerfield-beach', county: 'Broward' },
  { name: 'Coconut Creek', slug: 'coconut-creek', county: 'Broward' },
  { name: 'Dania Beach', slug: 'dania-beach', county: 'Broward' },
  { name: 'Cooper City', slug: 'cooper-city', county: 'Broward' },
  { name: 'Weston', slug: 'weston', county: 'Broward' },
  { name: 'Parkland', slug: 'parkland', county: 'Broward' },
  { name: 'Hallandale Beach', slug: 'hallandale-beach', county: 'Broward' },
  { name: 'Wilton Manors', slug: 'wilton-manors', county: 'Broward' },
  { name: 'Lighthouse Point', slug: 'lighthouse-point', county: 'Broward' },
  { name: 'Lauderdale-by-the-Sea', slug: 'lauderdale-by-the-sea', county: 'Broward' },
  { name: 'Southwest Ranches', slug: 'southwest-ranches', county: 'Broward' },
  { name: 'West Park', slug: 'west-park', county: 'Broward' },
  { name: 'Pembroke Park', slug: 'pembroke-park', county: 'Broward' },
  { name: 'Hillsboro Beach', slug: 'hillsboro-beach', county: 'Broward' },
  { name: 'Sea Ranch Lakes', slug: 'sea-ranch-lakes', county: 'Broward' },
  { name: 'Lazy Lake', slug: 'lazy-lake', county: 'Broward' },
  // Palm Beach (16).
  { name: 'West Palm Beach', slug: 'west-palm-beach', county: 'Palm Beach' },
  { name: 'Boca Raton', slug: 'boca-raton', county: 'Palm Beach' },
  { name: 'Boynton Beach', slug: 'boynton-beach', county: 'Palm Beach' },
  { name: 'Delray Beach', slug: 'delray-beach', county: 'Palm Beach' },
  { name: 'Wellington', slug: 'wellington', county: 'Palm Beach' },
  { name: 'Jupiter', slug: 'jupiter', county: 'Palm Beach' },
  { name: 'Palm Beach Gardens', slug: 'palm-beach-gardens', county: 'Palm Beach' },
  { name: 'Lake Worth Beach', slug: 'lake-worth-beach', county: 'Palm Beach' },
  { name: 'Riviera Beach', slug: 'riviera-beach', county: 'Palm Beach' },
  { name: 'Greenacres', slug: 'greenacres', county: 'Palm Beach' },
  { name: 'Royal Palm Beach', slug: 'royal-palm-beach', county: 'Palm Beach' },
  { name: 'Palm Beach', slug: 'palm-beach', county: 'Palm Beach' },
  { name: 'Belle Glade', slug: 'belle-glade', county: 'Palm Beach' },
  { name: 'Palm Springs', slug: 'palm-springs', county: 'Palm Beach' },
  { name: 'North Palm Beach', slug: 'north-palm-beach', county: 'Palm Beach' },
  { name: 'Lake Park', slug: 'lake-park', county: 'Palm Beach' },
  // Miami-Dade (18).
  { name: 'Miami', slug: 'miami', county: 'Miami-Dade' },
  { name: 'Hialeah', slug: 'hialeah', county: 'Miami-Dade' },
  { name: 'Miami Gardens', slug: 'miami-gardens', county: 'Miami-Dade' },
  { name: 'Miami Beach', slug: 'miami-beach', county: 'Miami-Dade' },
  { name: 'North Miami', slug: 'north-miami', county: 'Miami-Dade' },
  { name: 'Homestead', slug: 'homestead', county: 'Miami-Dade' },
  { name: 'Doral', slug: 'doral', county: 'Miami-Dade' },
  { name: 'Coral Gables', slug: 'coral-gables', county: 'Miami-Dade' },
  { name: 'Aventura', slug: 'aventura', county: 'Miami-Dade' },
  { name: 'Cutler Bay', slug: 'cutler-bay', county: 'Miami-Dade' },
  { name: 'Hialeah Gardens', slug: 'hialeah-gardens', county: 'Miami-Dade' },
  { name: 'Sunny Isles Beach', slug: 'sunny-isles-beach', county: 'Miami-Dade' },
  { name: 'North Miami Beach', slug: 'north-miami-beach', county: 'Miami-Dade' },
  { name: 'Sweetwater', slug: 'sweetwater', county: 'Miami-Dade' },
  { name: 'Florida City', slug: 'florida-city', county: 'Miami-Dade' },
  { name: 'Key Biscayne', slug: 'key-biscayne', county: 'Miami-Dade' },
  { name: 'Surfside', slug: 'surfside', county: 'Miami-Dade' },
  { name: 'Bal Harbour', slug: 'bal-harbour', county: 'Miami-Dade' },
];

export const PUBLISHED_CITY_NAMES = PUBLISHED_CITIES.map(({ name }) => name);

/** Case/space-insensitive match of a stated city against all 65 published cities. */
export function normalizePublishedCityName(city) {
  const wanted = String(city || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!wanted) return null;
  return PUBLISHED_CITY_NAMES.find((c) => c.toLowerCase() === wanted) || null;
}

export function findServiceArea({ city, zip }) {
  return SERVICE_AREAS.find((area) => area.zips.includes(zip) && (!city || area.city === city));
}

export function areasForZip(zip) {
  return SERVICE_AREAS.filter((area) => area.zips.includes(zip)).map(({ city }) => city);
}

/**
 * Top Speed CRM — Service Book area resolution (2026-11-12).
 *
 * Every booking resolves its service address into the platform's area
 * model at intake, and the area rides the record end-to-end (queue,
 * dispatch board, slot capacity). Resolution is deterministic and
 * honest — it never invents coverage:
 *
 * - A customer-stated city that names one of the 65 published cities
 *   (the 12 core crew cities, or any other city with a published
 *   landing page — auto-match widened 2026-11-20, recommendation A6)
 *   is authoritative → that area, IN_AREA, source CITY. (If the ZIP is
 *   not in that city's known ZIP list the booking still belongs to the
 *   named city; the mismatch is flagged for the setter, not rejected.)
 * - No covered city named, but the ZIP maps to exactly one covered
 *   area → that area, IN_AREA, source ZIP.
 * - No covered city named and the ZIP is shared by several covered
 *   areas → no area guessed: AREA_REVIEW, source ZIP_AMBIGUOUS. A
 *   Service Setter resolves it (POST /bookos/bookings/:id/resolve-area)
 *   before an appointment can be set.
 * - Anything else → OUT_OF_AREA. The lead is still recorded (it is the
 *   expansion/waitlist signal), but it is never promised service, never
 *   enters the setter queue or slot capacity, and no booking
 *   confirmation with service terms is sent for it.
 */
export const AREA_STATUSES = ['IN_AREA', 'AREA_REVIEW', 'OUT_OF_AREA'];

export function normalizeCityName(city) {
  const wanted = String(city || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!wanted) return null;
  return SERVICE_CITIES.find((c) => c.toLowerCase() === wanted) || null;
}

export function resolveArea({ city, zip } = {}) {
  const zipAreas = areasForZip(String(zip || '').trim());
  const canonicalCity = normalizeCityName(city);
  if (canonicalCity) {
    return {
      area: canonicalCity,
      areaStatus: 'IN_AREA',
      areaSource: 'CITY',
      zipAreas,
      zipMismatch: zipAreas.length > 0 && !zipAreas.includes(canonicalCity),
    };
  }
  // Widened auto-match (2026-11-20, A6): a stated city that names any
  // other published city (the 53 beyond the core 12) is also IN_AREA —
  // the booking goes straight to the setter queue like a core booking.
  // ZIP-only resolution below still runs on the core ZIP table (no ZIP
  // list is published for the 53), and anything outside the 65 keeps
  // the AREA_REVIEW / OUT_OF_AREA fallbacks exactly as before.
  const publishedCity = normalizePublishedCityName(city);
  if (publishedCity) {
    return {
      area: publishedCity,
      areaStatus: 'IN_AREA',
      areaSource: 'CITY',
      zipAreas,
      zipMismatch: zipAreas.length > 0 && !zipAreas.includes(publishedCity),
    };
  }
  if (zipAreas.length === 1) {
    return { area: zipAreas[0], areaStatus: 'IN_AREA', areaSource: 'ZIP', zipAreas, zipMismatch: false };
  }
  if (zipAreas.length > 1) {
    return { area: null, areaStatus: 'AREA_REVIEW', areaSource: 'ZIP_AMBIGUOUS', zipAreas, zipMismatch: false };
  }
  return { area: null, areaStatus: 'OUT_OF_AREA', areaSource: 'NONE', zipAreas, zipMismatch: false };
}

/**
 * The area a booking operationally belongs to. New bookings carry an
 * explicit `area`; records created before the area model hydrate with
 * one derived from their city, so every surface can rely on this.
 */
export function effectiveArea(booking) {
  if (booking?.area) return booking.area;
  return normalizePublishedCityName(booking?.city);
}

export function effectiveAreaStatus(booking) {
  if (booking?.areaStatus) return booking.areaStatus;
  return effectiveArea(booking) ? 'IN_AREA' : 'OUT_OF_AREA';
}
