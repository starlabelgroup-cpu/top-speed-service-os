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
 * - A customer-stated city that names one of the 12 covered cities is
 *   authoritative → that area, IN_AREA, source CITY. (If the ZIP is not
 *   in that city's known ZIP list the booking still belongs to the
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
  return normalizeCityName(booking?.city);
}

export function effectiveAreaStatus(booking) {
  if (booking?.areaStatus) return booking.areaStatus;
  return effectiveArea(booking) ? 'IN_AREA' : 'OUT_OF_AREA';
}
