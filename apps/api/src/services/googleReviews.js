import { googleConnections } from './insights.js';

/**
 * Google reviews — the data layer behind the website display
 * component (recommendations A2, 2026-11-20).
 *
 * HONESTY CONTRACT: this layer serves REAL Google Business Profile
 * reviews only, read from Google's own API through the business's
 * own OAuth grant. That grant does not exist yet — Google Business
 * Profile cannot be read by the read-only service account that
 * powers GA4 / Search Console; it needs an OAuth grant from the
 * Google account that manages the profile, which is Ramone's
 * pending step (the Insights connections board says exactly this).
 * Until the grant exists:
 *   - gbpConnectionState() reports not_connected (the same source
 *     the Insights board and the Pepper console read), and
 *   - fetchGoogleReviews() returns { available: false } with NO
 *     reviews — the website component renders NOTHING in that
 *     state. No placeholder, no stars, no seeded reviews, ever.
 *
 * When the grant lands, the follow-up stores it (account + location
 * + access token) and resolveGbpGrant() below returns it; the fetch
 * + mapping path is already real and is exercised in the drills
 * with a mocked Google payload.
 */

/** The connection state, from the platform's one honest source. */
export function gbpConnectionState() {
  const { connections } = googleConnections();
  const entry = (connections || []).find((c) => c.id === 'google-business-profile');
  if (!entry) return { connected: false, status: 'not_connected' };
  return { connected: entry.status === 'connected', status: entry.status };
}

/**
 * The stored OAuth grant for the Business Profile, or null. No grant
 * store exists until Ramone's OAuth step creates one — this seam is
 * where that follow-up plugs in. Returning null is the truthful
 * state today, and fetchGoogleReviews treats it as unavailable.
 */
export function resolveGbpGrant() {
  return null;
}

const STAR_RATINGS = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

/** Map one raw Google review to the display shape, or null to skip it. */
export function mapGbpReview(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const rating = STAR_RATINGS[raw.starRating] ?? null;
  if (rating == null) return null;
  return {
    authorName: String(raw.reviewer?.displayName || '').trim() || 'Google reviewer',
    rating,
    text: typeof raw.comment === 'string' ? raw.comment : '',
    createdAt: raw.createTime || null,
    updatedAt: raw.updateTime || raw.createTime || null,
  };
}

/**
 * Fetch + map the location's Google reviews. Injectable seams
 * (fetchImpl / grant / connection) exist for the drills; production
 * callers pass nothing and get the real state. Never throws — every
 * failure mode is an honest { available: false, reason }.
 */
export async function fetchGoogleReviews({ fetchImpl = fetch, grant, connection } = {}) {
  const state = connection || gbpConnectionState();
  if (!state.connected) {
    return { available: false, reason: 'GBP_NOT_CONNECTED', reviews: [], aggregate: null };
  }
  const resolvedGrant = grant === undefined ? resolveGbpGrant() : grant;
  if (!resolvedGrant?.accessToken || !resolvedGrant?.locationName) {
    return { available: false, reason: 'GBP_GRANT_MISSING', reviews: [], aggregate: null };
  }
  try {
    const url = `https://mybusiness.googleapis.com/v4/${resolvedGrant.locationName}/reviews?pageSize=50&orderBy=updateTime desc`;
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${resolvedGrant.accessToken}` },
    });
    if (!response?.ok) {
      return { available: false, reason: 'GBP_FETCH_FAILED', reviews: [], aggregate: null };
    }
    const payload = await response.json();
    const reviews = (Array.isArray(payload?.reviews) ? payload.reviews : [])
      .map(mapGbpReview)
      .filter(Boolean)
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    if (!reviews.length) {
      return { available: false, reason: 'NO_REVIEWS', reviews: [], aggregate: null };
    }
    // Google reports the location-wide average + count itself; use
    // them when present (they cover every review, not just this
    // page), and compute from the fetched reviews otherwise.
    const totalCount = Number(payload.totalReviewCount) || reviews.length;
    const average = Number(payload.averageRating)
      || Math.round((reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length) * 10) / 10;
    return {
      available: true,
      reason: null,
      reviews,
      aggregate: { count: totalCount, average: Math.round(average * 10) / 10 },
    };
  } catch {
    return { available: false, reason: 'GBP_FETCH_FAILED', reviews: [], aggregate: null };
  }
}
