import { timingSafeEqual } from 'node:crypto';

/**
 * Top Speed Ads OS integration — the Service OS side of the
 * advertising flywheel feed (2026-11-20, Ramone approved connecting
 * the Ads OS console to Service OS).
 *
 * The Ads OS console reads ONE read-only summary from this service:
 * how many bookings arrived, grouped by the advertising source
 * label each booking carries, how they spread across statuses, and
 * how many jobs completed — all-time and over the last 30 days.
 * Counts and labels only: this feed never carries customer names,
 * phones, emails or any other PII, and it writes nothing.
 *
 * SOURCE LABEL. A booking's label is resolved from the intake
 * attribution the record already carries (ServiceRequest columns,
 * flattened onto the store record by db/bookingsRepo): the UTM
 * campaign first (campaign links carry ?utm_campaign=<sourceTag>,
 * e.g. google_general — see services/adOutcomes.js for the same
 * join), then the [via:] surface tag (e.g.
 * appliance-express-shop.vercel.app), then the flat intake
 * `source`. A booking carrying none of them reads "unattributed".
 *
 * COMPLETED means booking.status === 'COMPLETED' — the same test
 * the flywheel loop stages use (services/adOutcomes.js).
 *
 * SERVICE KEY. The feed is guarded by a dedicated service key the
 * caller sends in the x-ads-os-key header, compared in constant
 * time against the ADS_OS_SERVICE_KEY environment variable (the
 * twilio/inbox timingSafeEqual idiom). The key itself lives only
 * in the environment — never in code, never in this file. When the
 * variable is unset the integration is NOT CONFIGURED and the
 * route answers 503, so the console can tell "not set up yet"
 * apart from "set up and refusing" (401).
 */

export const ADS_OS_KEY_ENV = 'ADS_OS_SERVICE_KEY';
export const ADS_OS_KEY_HEADER = 'x-ads-os-key';
export const UNATTRIBUTED_LABEL = 'unattributed';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** True when the service key exists in the environment at all. */
export function adsOsConfigured() {
  const value = process.env[ADS_OS_KEY_ENV];
  return typeof value === 'string' && value.length > 0;
}

/**
 * Constant-time check of a presented key against the environment.
 * Reads the environment at call time (never cached at module load),
 * so configuration changes need no code change. False whenever the
 * integration is unconfigured or the presented value is absent,
 * empty, or simply wrong — one answer, no oracle about which.
 */
export function adsOsKeyMatches(provided) {
  const expected = process.env[ADS_OS_KEY_ENV];
  if (typeof expected !== 'string' || expected.length === 0) return false;
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const expectedBuf = Buffer.from(expected, 'utf8');
  const providedBuf = Buffer.from(provided, 'utf8');
  return expectedBuf.length === providedBuf.length && timingSafeEqual(expectedBuf, providedBuf);
}

function cleanLabel(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** The one advertising source label a booking carries (see header). */
export function adsOsSourceLabel(booking) {
  const attribution = booking?.attribution || null;
  return (
    cleanLabel(attribution?.utmCampaign)
    || cleanLabel(attribution?.via)
    || cleanLabel(booking?.source)
    || UNATTRIBUTED_LABEL
  );
}

function bump(map, key, recent) {
  const entry = map.get(key) || { allTime: 0, last30Days: 0 };
  entry.allTime += 1;
  if (recent) entry.last30Days += 1;
  map.set(key, entry);
}

/**
 * Build the summary over an iterable of store booking records.
 * Pure (the caller passes the records and the clock), so the drill
 * can exercise it through the real HTTP route in skeleton mode.
 */
export function buildAdsOsSummary(bookings, now = new Date()) {
  const sinceMs = now.getTime() - THIRTY_DAYS_MS;
  const inWindow = (booking) => {
    const t = new Date(booking?.createdAt || 0).getTime();
    return Number.isFinite(t) && t >= sinceMs;
  };

  const bySource = new Map();
  const byStatus = new Map();
  let bookingsAllTime = 0;
  let bookingsLast30Days = 0;
  let completedAllTime = 0;
  let completedLast30Days = 0;

  for (const booking of bookings || []) {
    const recent = inWindow(booking);
    bookingsAllTime += 1;
    if (recent) bookingsLast30Days += 1;
    if (booking?.status === 'COMPLETED') {
      completedAllTime += 1;
      if (recent) completedLast30Days += 1;
    }
    bump(bySource, adsOsSourceLabel(booking), recent);
    bump(byStatus, cleanLabel(booking?.status) || 'UNKNOWN', recent);
  }

  return {
    generatedAt: now.toISOString(),
    windows: {
      last30Days: { days: 30, since: new Date(sinceMs).toISOString() },
    },
    sourceLabelField:
      'ServiceRequest intake attribution, resolved per booking: attribution.utmCampaign, then attribution.via, then the flat source (Prisma columns utmCampaign / viaTag / source)',
    totals: {
      bookings: { allTime: bookingsAllTime, last30Days: bookingsLast30Days },
      completedJobs: { allTime: completedAllTime, last30Days: completedLast30Days },
    },
    bookingsBySource: [...bySource.entries()]
      .map(([label, counts]) => ({ label, allTime: counts.allTime, last30Days: counts.last30Days }))
      .sort((a, b) => b.allTime - a.allTime || a.label.localeCompare(b.label)),
    bookingsByStatus: Object.fromEntries(
      [...byStatus.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([status, counts]) => [status, { allTime: counts.allTime, last30Days: counts.last30Days }]),
    ),
  };
}
