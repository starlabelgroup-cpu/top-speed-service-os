/**
 * Google Maps Platform — the server-side adapter (2026-11-23,
 * Ramone's directive: "Connect to Google map platform now and
 * integrate Top Speed service OS").
 *
 * DESIGN RULE (load-bearing): Google ENRICHES, the internal model
 * still DECIDES. Coverage tiers, area resolution (resolveArea) and
 * booking semantics live in config/serviceAreas.js +
 * services/geoMatch.js and never change here. Everything in this
 * module is gated on GOOGLE_MAPS_API_KEY being present in the
 * environment: with no key set, mapsEnabled() is false, every call
 * returns null, and platform behavior is byte-for-byte what it was
 * before this module existed. The key is read from the environment
 * on every call — never hardcoded, never logged, never returned to
 * a client (the separate GOOGLE_MAPS_BROWSER_KEY is the only key a
 * browser ever sees, via GET /geo/config).
 *
 * ADAPTER SHAPE: each Google product sits behind exactly ONE
 * function here, so a product swap is a one-function change:
 *   - geocodeAddress / reverseGeocode → Geocoding API
 *   - distanceMatrix                  → Distance Matrix API
 *     (legacy; Google's successor is the Routes API — swap this
 *     one function's request/response mapping when that day comes)
 * The browser-side Places Autocomplete lives behind one function
 * in apps/web/shared/zip-booking.js for the same reason (Places
 * API (New) is the successor there).
 *
 * FAILURE CONTRACT: every function resolves null on any failure —
 * no key, network error, timeout, quota, malformed payload — and
 * never throws into a booking, dispatch or tracking path. Callers
 * treat null as "no enrichment" and fall back to the internal
 * model, which is always complete on its own.
 */

const API_BASE = 'https://maps.googleapis.com/maps/api';
const FETCH_TIMEOUT_MS = 2500;
const GEOCODE_CACHE_TTL_MS = 10 * 60 * 1000;
const GEOCODE_CACHE_MAX = 200;
const METERS_PER_MILE = 1609.344;

/** The server key, read fresh so env changes need no code change. */
function serverKey() {
  return process.env.GOOGLE_MAPS_API_KEY || null;
}

/** True when the server-side Maps integration is switched on. */
export function mapsEnabled() {
  return Boolean(serverKey());
}

/**
 * The browser key for the Maps JavaScript API surfaces (wizard map
 * preview + Places Autocomplete, Track My Tech map). A Maps browser
 * key is a public, referrer-restricted credential by design — this
 * is the only key value the API ever serves to a client, and only
 * via GET /geo/config. Null when unset (clients then load nothing).
 */
export function mapsBrowserKey() {
  return process.env.GOOGLE_MAPS_BROWSER_KEY || null;
}

const round3 = (n) => Math.round(n * 1000) / 1000;

/**
 * One bounded Google GET. Returns the parsed JSON body only when
 * Google answers HTTP 200 with status "OK" (or "ZERO_RESULTS",
 * which callers distinguish); null on everything else. The URL —
 * which carries the key — is never logged.
 */
async function googleGet(path, params) {
  const key = serverKey();
  if (!key) return null;
  const url = new URL(API_BASE + path);
  for (const [name, value] of Object.entries(params)) {
    if (value != null && value !== '') url.searchParams.set(name, String(value));
  }
  url.searchParams.set('key', key);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await globalThis.fetch(url.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response || !response.ok) return null;
    const body = await response.json().catch(() => null);
    if (!body || (body.status !== 'OK' && body.status !== 'ZERO_RESULTS')) return null;
    return body;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* Geocoding API — address → coordinates (+ place id), with cache      */
/* ------------------------------------------------------------------ */

const geocodeCache = new Map(); // normalized address -> { at, value }

function cacheGet(cacheKey) {
  const hit = geocodeCache.get(cacheKey);
  if (!hit) return undefined;
  if (Date.now() - hit.at > GEOCODE_CACHE_TTL_MS) {
    geocodeCache.delete(cacheKey);
    return undefined;
  }
  return hit.value;
}

function cacheSet(cacheKey, value) {
  if (geocodeCache.size >= GEOCODE_CACHE_MAX) {
    const oldest = geocodeCache.keys().next().value;
    if (oldest !== undefined) geocodeCache.delete(oldest);
  }
  geocodeCache.set(cacheKey, { at: Date.now(), value });
}

/**
 * Geocode a free-form address → { lat, lng, formattedAddress,
 * placeId } (full precision; callers round for storage), or null.
 * Results — including "no result" — are cached in memory for the
 * TTL so a repeat booking at the same address costs no second call.
 */
export async function geocodeAddress(address) {
  if (!mapsEnabled()) return null;
  const query = String(address || '').trim();
  if (!query) return null;
  const cacheKey = query.toLowerCase().replace(/\s+/g, ' ');
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;
  const body = await googleGet('/geocode/json', { address: query });
  const first = body?.results?.[0] || null;
  const location = first?.geometry?.location;
  let value = null;
  if (
    first &&
    location &&
    Number.isFinite(Number(location.lat)) &&
    Number.isFinite(Number(location.lng))
  ) {
    value = {
      lat: Number(location.lat),
      lng: Number(location.lng),
      formattedAddress: first.formatted_address || null,
      placeId: first.place_id || null,
    };
  }
  cacheSet(cacheKey, value);
  return value;
}

function componentOf(result, type) {
  const components = Array.isArray(result?.address_components) ? result.address_components : [];
  const found = components.find((c) => Array.isArray(c.types) && c.types.includes(type));
  return found ? found.long_name || null : null;
}

/**
 * Reverse-geocode coordinates → { city, zip, formattedAddress } —
 * the locality Google places the point in (locality, falling back
 * to postal_town / sublocality) and its postal code. Identification
 * only: callers still run the city/ZIP through resolveArea, which
 * alone decides the coverage tier.
 */
export async function reverseGeocode(lat, lng) {
  if (!mapsEnabled()) return null;
  const la = Number(lat);
  const ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return null;
  const body = await googleGet('/geocode/json', { latlng: `${la},${ln}` });
  const first = body?.results?.[0] || null;
  if (!first) return null;
  const city =
    componentOf(first, 'locality') ||
    componentOf(first, 'postal_town') ||
    componentOf(first, 'sublocality') ||
    null;
  const zip = componentOf(first, 'postal_code');
  if (!city && !zip) return null;
  return { city, zip, formattedAddress: first.formatted_address || null };
}

/* ------------------------------------------------------------------ */
/* Distance Matrix API (legacy) — drive distance + duration.           */
/* THE adapter for road distance: the Routes API successor swaps in   */
/* behind this one signature.                                          */
/* ------------------------------------------------------------------ */

/**
 * Drive distance/duration from many origins to ONE destination.
 * origins: [{ lat, lng }] (max 25 per call — chunked internally).
 * Returns an array aligned with origins: { distanceMiles,
 * durationMinutes } per reachable origin, null per unreachable one;
 * null for the whole call when Google cannot answer at all.
 */
export async function distanceMatrix(origins, destination) {
  if (!mapsEnabled()) return null;
  if (!Array.isArray(origins) || !origins.length || !destination) return null;
  const destLat = Number(destination.lat);
  const destLng = Number(destination.lng);
  if (!Number.isFinite(destLat) || !Number.isFinite(destLng)) return null;
  const points = origins
    .map((o) => ({ lat: Number(o?.lat), lng: Number(o?.lng) }))
    .filter((o) => Number.isFinite(o.lat) && Number.isFinite(o.lng));
  if (!points.length) return null;

  const legs = [];
  for (let i = 0; i < points.length; i += 25) {
    const chunk = points.slice(i, i + 25);
    const body = await googleGet('/distancematrix/json', {
      origins: chunk.map((o) => `${o.lat},${o.lng}`).join('|'),
      destinations: `${destLat},${destLng}`,
      units: 'imperial',
      mode: 'driving',
    });
    if (!body) return null;
    const elements = body.rows?.[0]?.elements || [];
    for (let j = 0; j < chunk.length; j++) {
      const el = elements[j];
      if (el && el.status === 'OK' && el.distance && el.duration) {
        legs.push({
          distanceMiles: Math.round((Number(el.distance.value) / METERS_PER_MILE) * 10) / 10,
          durationMinutes: Math.round(Number(el.duration.value) / 60),
        });
      } else {
        legs.push(null);
      }
    }
  }
  return legs;
}

/* ------------------------------------------------------------------ */
/* Booking enrichment                                                  */
/* ------------------------------------------------------------------ */

/**
 * Enrich the server-derived booking geo fields with a Google
 * geocode of the service address. Returns the geo object UNCHANGED
 * (same keys, same values) whenever Maps is off, the booking has no
 * street address, or Google cannot geocode it — so a key-absent or
 * failed enrichment is indistinguishable from today's behavior.
 *
 * On success the real coordinates replace geoLat/geoLng (rounded to
 * the platform's 3-decimal storage precision) and the Google place
 * id + source ride along as geoPlaceId / geoSource =
 * 'GOOGLE_GEOCODE'. geoCity / geoTier are NOT recomputed here —
 * they come from geoFieldsFrom + resolveArea and stay authoritative.
 */
export async function enrichGeoFields({ geo, address, city, zip } = {}) {
  const base = geo || { geoCity: null, geoTier: null, geoLat: null, geoLng: null };
  if (!mapsEnabled()) return base;
  const street = typeof address === 'string' ? address.trim() : '';
  if (!street) return base;
  const query = [street, city, 'FL', zip].filter(Boolean).join(', ');
  const result = await geocodeAddress(query);
  if (!result) return base;
  return {
    geoCity: base.geoCity,
    geoTier: base.geoTier,
    geoLat: round3(result.lat),
    geoLng: round3(result.lng),
    geoPlaceId: result.placeId || null,
    geoSource: 'GOOGLE_GEOCODE',
  };
}
