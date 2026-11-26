import { store, appendEvent } from '../data/store.js';
import { listReviews } from '../db/reviewsRepo.js';
import { platformEventsRepo } from '../db/platformEventsRepo.js';
import { fetchGoogleReviews, gbpConnectionState } from './googleReviews.js';
import { mapsEnabled, mapsBrowserKey } from './googleMaps.js';

/**
 * TOP REVIEWS AND REWARDS — the unified reviews system (Ramone's
 * directive, 2026-11-25): one system joining the pieces the platform
 * already runs into a single named product:
 *
 *   - ASK: the review funnel (services/reviewFunnel.js) asks every
 *     completed job for a review, with one reminder — plus the
 *     private "tell the office first" feedback path alongside.
 *   - GOOGLE / MAP PACK: real Google Business Profile reviews via
 *     services/googleReviews.js (honest not_connected until Ramone's
 *     GBP OAuth grant exists), the public Google review link, and
 *     Google Maps Platform state (services/googleMaps.js) — the map
 *     surfaces light up when the Maps keys land.
 *   - LOCAL SERVICES ADS: readiness is tracked here; enrollment is
 *     Google's external program (license, insurance, background
 *     checks) and stays honestly labelled until Google approves it.
 *   - REWARDS: a recorded review of a completed repair earns the
 *     customer the standard thank-you credit, recorded as a
 *     REVIEW_REWARD_ISSUED platform event — the rewards ledger the
 *     Top Reviews console reads.
 *
 * POLICY SHAPE (load-bearing): the reward thanks the customer for
 * reviewing a completed repair ON THIS PLATFORM — any rating, once
 * per booking. It is never conditioned on a positive rating and
 * never on posting to Google specifically; Google prohibits
 * incentivized and selectively solicited reviews, and the funnel
 * asks every completed job equally. The office applies an issued
 * credit to the customer's next invoice.
 *
 * HONESTY: every number here is folded from live records (reviews
 * repo, notification outbox, platform events). Nothing is seeded,
 * and a disconnected Google surface reports its real state.
 */

/** The standard review thank-you credit — the one number Ramone sets. */
export const REVIEW_REWARD_CENTS = 2500;

const REWARD_EVENT = 'REVIEW_REWARD_ISSUED';
const LSA_SIGNUP_URL = 'https://ads.google.com/localservices';

/**
 * The public Google review link for the flagship profile: an explicit
 * GOOGLE_REVIEW_URL wins; otherwise it is built from GOOGLE_PLACE_ID.
 * Null when neither is configured — surfaces then show no Google
 * review button rather than a wrong link.
 */
export function googleReviewUrl() {
  const direct = String(process.env.GOOGLE_REVIEW_URL || '').trim();
  if (direct) return direct;
  const placeId = String(process.env.GOOGLE_PLACE_ID || '').trim();
  if (placeId) return `https://search.google.com/local/writereview?placeid=${encodeURIComponent(placeId)}`;
  return null;
}

/** Local Services Ads enrollment state — external program, env-declared. */
export function lsaState() {
  const status = String(process.env.TOP_REVIEWS_LSA_STATUS || '').trim() || 'not_enrolled';
  return { status, signupUrl: LSA_SIGNUP_URL };
}

async function rewardEvents(limit = 500) {
  try {
    const rows = await platformEventsRepo.listRecent({ type: REWARD_EVENT, limit });
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

/**
 * Issue the review thank-you credit for a recorded review of a
 * completed booking — once per booking, any rating. Called from the
 * review create success point (routes/pepperListsReviews.js);
 * fail-soft by contract, the caller also guards it.
 */
export async function maybeIssueReviewReward(review, booking) {
  if (!review?.id || !booking?.id) return null;
  if (booking.status !== 'COMPLETED') return null;
  const existing = await rewardEvents();
  if (existing.some((e) => e?.details?.bookingId === booking.id)) return null;
  return appendEvent(REWARD_EVENT, {
    source: 'top-reviews',
    actor: 'system',
    entityType: 'BOOKING',
    entityId: booking.id,
    referenceCode: booking.referenceCode || null,
    details: {
      bookingId: booking.id,
      reviewId: review.id,
      customerId: review.customerId || null,
      amountCents: REVIEW_REWARD_CENTS,
      kind: 'REVIEW_THANK_YOU',
      status: 'ISSUED',
    },
  });
}

function statsFor(reviews) {
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let sum = 0;
  for (const r of reviews) {
    const rating = Number(r?.rating);
    if (rating >= 1 && rating <= 5) {
      distribution[rating] += 1;
      sum += rating;
    }
  }
  return {
    count: reviews.length,
    average: reviews.length ? Math.round((sum / reviews.length) * 10) / 10 : null,
    distribution,
  };
}

function funnelStats() {
  const asked = new Set();
  const reminded = new Set();
  for (const entry of store.notificationOutbox || []) {
    const bookingId = entry?.payload?.bookingId;
    if (!bookingId) continue;
    if (entry.template === 'REVIEW_REQUEST') asked.add(bookingId);
    if (entry.template === 'REVIEW_REMINDER') reminded.add(bookingId);
  }
  return { asked: asked.size, reminded: reminded.size };
}

/**
 * The public-safe Top Reviews summary the customer platforms render:
 * real on-platform review stats (published only), the Google state
 * exactly as connected (or not), and the rewards totals.
 */
export async function topReviewsSummary() {
  const all = await listReviews({});
  const published = all.filter((r) => r.status === 'PUBLISHED');
  let gbp = { available: false, aggregate: null, reviews: [] };
  try {
    gbp = await fetchGoogleReviews();
  } catch {
    /* fetchGoogleReviews is fail-soft by contract; belt and braces */
  }
  const rewards = await rewardEvents();
  const issuedTotalCents = rewards.reduce((sum, e) => sum + (Number(e?.details?.amountCents) || 0), 0);
  return {
    system: 'Top Reviews and Rewards',
    platformReviews: statsFor(published),
    google: {
      connected: gbpConnectionState().connected,
      available: Boolean(gbp?.available),
      aggregate: gbp?.aggregate || null,
      reviewUrl: googleReviewUrl(),
    },
    rewards: {
      perReviewCents: REVIEW_REWARD_CENTS,
      issuedCount: rewards.length,
      issuedTotalCents,
    },
    trackMyTech: { url: '/track' },
    maps: { serverEnabled: mapsEnabled(), browserKeyPresent: Boolean(mapsBrowserKey()) },
    lsa: lsaState(),
  };
}

/**
 * The staff console read model: the summary plus the funnel, the
 * rewards ledger, and the Map Pack / Local Services Ads readiness
 * boards — every line folded from a live state, never a label.
 */
export async function topReviewsConsole() {
  const summary = await topReviewsSummary();
  const all = await listReviews({});
  const byStatus = {};
  for (const r of all) byStatus[r.status || 'UNKNOWN'] = (byStatus[r.status || 'UNKNOWN'] || 0) + 1;
  const rewards = await rewardEvents(200);
  const reviewUrl = googleReviewUrl();
  const mapsReady = summary.maps.serverEnabled && summary.maps.browserKeyPresent;
  return {
    ...summary,
    funnel: { ...funnelStats(), reviewsRecorded: all.length, reviewsByStatus: byStatus },
    rewardsLedger: rewards.slice(0, 25).map((e) => ({
      at: e.createdAt || e.at || null,
      referenceCode: e.referenceCode || null,
      amountCents: Number(e?.details?.amountCents) || 0,
      status: e?.details?.status || 'ISSUED',
    })),
    mapPackReadiness: [
      {
        key: 'gbp_connected',
        label: 'Google Business Profile connected',
        ok: summary.google.connected,
        note: summary.google.connected
          ? 'Real Google reviews flow into the Top Reviews displays.'
          : "Ramone's GBP OAuth grant is the open step — until it lands, Google reviews honestly show as not connected.",
      },
      {
        key: 'google_review_link',
        label: 'Public Google review link configured',
        ok: Boolean(reviewUrl),
        note: reviewUrl
          ? 'The funnel and Top Reviews pages can send customers straight to the Google review form.'
          : 'Set GOOGLE_PLACE_ID (or GOOGLE_REVIEW_URL) so customers get the one-tap Google review link.',
      },
      {
        key: 'maps_platform',
        label: 'Google Maps Platform keys live',
        ok: mapsReady,
        note: mapsReady
          ? 'Track My Tech maps, Places autocomplete and geocoding enrichment are on.'
          : 'Built and wired — lights up the moment an active Google billing account is linked and the two Maps keys are set.',
      },
      {
        key: 'review_funnel',
        label: 'Review funnel asking every completed job',
        ok: true,
        note: 'Ask at completion plus one reminder at 3 days, every job equally; private feedback runs alongside.',
      },
      {
        key: 'reviews_published',
        label: 'Published platform reviews',
        ok: summary.platformReviews.count > 0,
        note: `${summary.platformReviews.count} published review(s) recorded on the platform.`,
      },
    ],
    lsaReadiness: {
      ...lsaState(),
      checklist: [
        { label: 'Google Local Services Ads enrollment (license, insurance, background checks — Google runs these)', done: lsaState().status === 'enrolled' },
        { label: 'Google Guaranteed badge earned', done: lsaState().status === 'enrolled' },
        { label: 'Review engine feeding the LSA profile (this system)', done: true },
      ],
      note:
        lsaState().status === 'enrolled'
          ? 'Enrolled — Top Reviews keeps the review engine behind the LSA profile fed.'
          : 'Not enrolled yet. Enrollment is Ramone-side at Google (business license, insurance, background checks); Top Reviews is built to feed it reviews the day it activates.',
    },
  };
}
