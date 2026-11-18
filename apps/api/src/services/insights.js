import { seoConfigured, seoServiceAccountEmail, grantSteps, GA4_PROPERTY_ID } from './googleSeo.js';

/**
 * Service OS Insights (2026-11-17) — the web traffic & website activity
 * manager's data layer.
 *
 * Two kinds of truth live here, kept strictly separate:
 *
 *  1. FIRST-PARTY activity — leads and bookings counted from the OS's
 *     own database (ServiceRequest + Connection rows, with the intake
 *     attribution the platform has captured since 2026-11-12 and the
 *     click IDs added 2026-11-17). These numbers are real the day this
 *     ships. Rows that predate attribution capture fall into an honest
 *     "(not captured)" bucket — nothing is backfilled or estimated.
 *
 *  2. GOOGLE data — GA4, Search Console and Business Profile. The
 *     /insights/connections endpoint reports the REAL connection state
 *     and nothing else: no metrics are served from here until Google
 *     access is actually configured (see services/googleSeo.js — the
 *     read-only service account exists and the Google-side grants were
 *     made 2026-11-13; the API-side private key is the remaining step).
 *
 * PageSpeed snapshots sit between the two: fetched live from Google's
 * public PageSpeed Insights API on a staff-triggered refresh and stored,
 * failures included, so a down site shows its failure — never a stale
 * or invented score.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const NOT_CAPTURED = '(not captured)';
const EASTERN = 'America/New_York';

const easternDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: EASTERN, year: 'numeric', month: '2-digit', day: '2-digit',
});

function dayKey(date) {
  return easternDay.format(date);
}

function last28Days() {
  const days = [];
  const now = new Date();
  for (let i = 27; i >= 0; i -= 1) {
    days.push(dayKey(new Date(now.getTime() - i * DAY_MS)));
  }
  return days;
}

function bucket(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = row.key || NOT_CAPTURED;
    const entry = map.get(key) || { key, leads: 0, bookings: 0 };
    entry.leads += row.leads || 0;
    entry.bookings += row.bookings || 0;
    map.set(key, entry);
  }
  return [...map.values()].sort((a, b) => (b.leads + b.bookings) - (a.leads + a.bookings));
}

function groupCounts(bookings, leads, field, limit = 25) {
  const rows = [];
  for (const r of bookings) rows.push({ key: r[field], bookings: 1 });
  for (const r of leads) rows.push({ key: r[field], leads: 1 });
  return bucket(rows).slice(0, limit);
}

/**
 * The first-party overview: 28 Eastern days of lead/booking activity.
 * `prisma` may be null (skeleton mode) — the shape still answers, with
 * zeros and the database state named, so the console renders honestly.
 */
export async function buildOverview(prisma) {
  const days = last28Days();
  const window = { days: 28, from: days[0], to: days[days.length - 1], timeZone: EASTERN };
  const empty = {
    window,
    database: 'not-connected-in-skeleton',
    totals: { leads: 0, bookings: 0, completedJobs: 0 },
    byDay: days.map((date) => ({ date, leads: 0, bookings: 0 })),
    funnel: { leads: 0, bookings: 0, completedJobs: 0, leadToBookingPct: null, bookingToCompletedPct: null },
    byUtmSource: [], byUtmMedium: [], byCampaign: [], byLandingPage: [],
    byViaTag: [], byIntakeSource: [], byConnectionType: [],
    clickIds: { gclid: 0, fbclid: 0, msclkid: 0, withAnyClickId: 0, bookingsTotal: 0 },
    attributionCoverage: { bookingsWithAnyUtm: 0, bookingsTotal: 0, pct: null },
    notes: [
      'The database is not connected in this mode, so every count is zero — connect DATABASE_URL for live first-party data.',
    ],
  };
  if (!prisma) return empty;

  // Fetch a slightly wider window than the 28 Eastern day buckets and
  // bucket in JS: Eastern day boundaries are not UTC boundaries.
  const since = new Date(Date.now() - 30 * DAY_MS);
  const select = {
    createdAt: true, sourcePage: true, viaTag: true,
    utmSource: true, utmMedium: true, utmCampaign: true,
    gclid: true, fbclid: true, msclkid: true,
  };
  const [bookingRows, leadRows] = await Promise.all([
    prisma.serviceRequest.findMany({
      where: { createdAt: { gte: since } },
      select: { ...select, source: true, status: true },
    }),
    prisma.connection.findMany({
      where: { createdAt: { gte: since } },
      select: { ...select, type: true },
    }),
  ]);

  const daySet = new Set(days);
  const bookings = bookingRows.filter((r) => daySet.has(dayKey(r.createdAt)));
  const leads = leadRows.filter((r) => daySet.has(dayKey(r.createdAt)));

  const byDay = days.map((date) => ({
    date,
    leads: leads.filter((r) => dayKey(r.createdAt) === date).length,
    bookings: bookings.filter((r) => dayKey(r.createdAt) === date).length,
  }));

  const completedJobs = bookings.filter((r) => r.status === 'COMPLETED').length;
  const pct = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);

  const withAnyUtm = bookings.filter((r) => r.utmSource || r.utmMedium || r.utmCampaign).length;
  const clickIds = {
    gclid: bookings.filter((r) => r.gclid).length + leads.filter((r) => r.gclid).length,
    fbclid: bookings.filter((r) => r.fbclid).length + leads.filter((r) => r.fbclid).length,
    msclkid: bookings.filter((r) => r.msclkid).length + leads.filter((r) => r.msclkid).length,
    withAnyClickId: bookings.filter((r) => r.gclid || r.fbclid || r.msclkid).length,
    bookingsTotal: bookings.length,
  };

  return {
    window,
    database: 'connected',
    totals: { leads: leads.length, bookings: bookings.length, completedJobs },
    byDay,
    funnel: {
      leads: leads.length,
      bookings: bookings.length,
      completedJobs,
      leadToBookingPct: pct(bookings.length, leads.length),
      bookingToCompletedPct: pct(completedJobs, bookings.length),
    },
    byUtmSource: groupCounts(bookings, leads, 'utmSource'),
    byUtmMedium: groupCounts(bookings, leads, 'utmMedium'),
    byCampaign: groupCounts(bookings, leads, 'utmCampaign'),
    byLandingPage: groupCounts(bookings, leads, 'sourcePage', 15),
    byViaTag: groupCounts(bookings, leads, 'viaTag'),
    byIntakeSource: groupCounts(bookings, [], 'source'),
    byConnectionType: groupCounts([], leads, 'type'),
    clickIds,
    attributionCoverage: {
      bookingsWithAnyUtm: withAnyUtm,
      bookingsTotal: bookings.length,
      pct: pct(withAnyUtm, bookings.length),
    },
    notes: [
      'First-party data: counted from this platform\'s own lead and booking records — no Google data is mixed in.',
      'Attribution is captured first-touch at intake (landing page, UTM fields and ad click IDs). Records created before capture existed carry none and fall into "(not captured)" — they are never backfilled or estimated.',
      'A "lead" is a Connection intake (forms, provider applications, Pepper Lists submissions); a "booking" is a ServiceRequest. The same person can appear in both.',
    ],
  };
}

/* ------------------------- PageSpeed snapshots ------------------------- */

/** The portfolio homepages the speed board tracks (canonical forms). */
export const PAGESPEED_TARGETS = [
  { url: 'https://topspeedserviceos.com/', label: 'topspeedserviceos.com' },
  { url: 'https://www.topspeedappliance.net/', label: 'topspeedappliance.net' },
  { url: 'https://topspeedapplianceservice.com/', label: 'topspeedapplianceservice.com' },
  { url: 'https://www.appliancepro.net/', label: 'appliancepro.net' },
  { url: 'https://cleanoutvents.com/', label: 'cleanoutvents.com' },
  { url: 'https://pepperlists.com/', label: 'pepperlists.com' },
  { url: 'https://appliancereferral.com/', label: 'appliancereferral.com' },
  { url: 'https://totalhomeappliancerepair.com/', label: 'totalhomeappliancerepair.com' },
  { url: 'https://topspeedappliancerepair.com/', label: 'Top Speed Appliance Repair — brand landing' },
  { url: 'https://topspeedrepairs.com/', label: 'Top Speed Repairs — flagship alias' },
];

const pagespeedBase = () => process.env.PAGESPEED_API_BASE
  || 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';

async function fetchPageSpeed(target, fetchImpl) {
  const apiKey = process.env.PAGESPEED_API_KEY || '';
  const query = `?url=${encodeURIComponent(target.url)}&strategy=mobile&category=performance`
    + (apiKey ? `&key=${encodeURIComponent(apiKey)}` : '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    const res = await fetchImpl(`${pagespeedBase()}${query}`, { signal: controller.signal });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.lighthouseResult) {
      const message = json?.error?.message || `PageSpeed API answered HTTP ${res.status}`;
      return { url: target.url, strategy: 'mobile', status: 'ERROR', error: String(message).slice(0, 500) };
    }
    const lh = json.lighthouseResult;
    const audits = lh.audits || {};
    const num = (id) => (typeof audits[id]?.numericValue === 'number' ? audits[id].numericValue : null);
    return {
      url: target.url,
      strategy: 'mobile',
      status: 'OK',
      score: typeof lh.categories?.performance?.score === 'number' ? lh.categories.performance.score : null,
      lcpMs: num('largest-contentful-paint'),
      cls: num('cumulative-layout-shift'),
      inpMs: num('interaction-to-next-paint'),
      error: null,
    };
  } catch (error) {
    return {
      url: target.url, strategy: 'mobile', status: 'ERROR',
      error: String(error?.message || error).slice(0, 500),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Staff-triggered refresh: fetch every target SEQUENTIALLY (the
 * unauthenticated PageSpeed quota is per-minute; eight calls in a row
 * is polite and reliable) and store every outcome, failures included.
 */
export async function refreshPageSpeed(prisma, fetchImpl = fetch) {
  const results = [];
  for (const target of PAGESPEED_TARGETS) {
    const snapshot = await fetchPageSpeed(target, fetchImpl);
    const saved = await prisma.insightsPageSpeedSnapshot.create({ data: snapshot });
    results.push(saved);
  }
  return {
    fetchedAt: new Date().toISOString(),
    succeeded: results.filter((r) => r.status === 'OK').length,
    failed: results.filter((r) => r.status !== 'OK').length,
    results,
  };
}

/** Latest snapshot per target (null until the first refresh runs). */
export async function latestPageSpeed(prisma) {
  const targets = [];
  for (const target of PAGESPEED_TARGETS) {
    const snapshot = prisma
      ? await prisma.insightsPageSpeedSnapshot.findFirst({
        where: { url: target.url },
        orderBy: { fetchedAt: 'desc' },
      })
      : null;
    targets.push({ ...target, snapshot });
  }
  return {
    database: prisma ? 'connected' : 'not-connected-in-skeleton',
    strategy: 'mobile',
    targets,
  };
}

/* ------------------------- Google connections ------------------------- */

/**
 * The honest connection board. Statuses derive from the REAL Google
 * configuration state (services/googleSeo.js) — when the read-only
 * service account is not fully configured on the API, GA4 and Search
 * Console report not_connected and the connect step names the exact
 * remaining action. Google Business Profile has no service-account
 * path at all: it needs an OAuth grant from the Google account that
 * manages the profile, which has not been given — stated plainly.
 * No metrics are ever returned from this endpoint.
 */
export function googleConnections() {
  const configured = seoConfigured();
  const steps = grantSteps();
  const googleStep = configured
    ? 'Connected through the read-only service account '
      + `(${seoServiceAccountEmail()}). Live Google metrics render in Marketing OS → SEO; `
      + 'this board reports connection state only.'
    : 'One step remains, and it is Ramone\'s: in the Vercel project "top-speed-service-os" '
      + '(the API) → Settings → Environment Variables, set GOOGLE_SEO_PRIVATE_KEY to the '
      + 'private key from the service account JSON key file, then redeploy the API. '
      + 'The Google-side grants are already done (Search Console Restricted user on '
      + 'topspeedserviceos.com and topspeedappliance.net; GA4 Viewer). Until that variable '
      + 'is set, no Google data can be read and this stays not connected.';
  return {
    connections: [
      {
        id: 'ga4',
        label: 'Google Analytics 4',
        status: configured ? 'connected' : 'not_connected',
        detail: `Property "Top Speed Service OS" (ID ${GA4_PROPERTY_ID}, measurement G-30WFYN49DP).`,
        whatItUnlocks: 'Sessions, users, traffic sources and top pages for the flagship, joined with Search Console pages in Marketing OS → SEO.',
        connectStep: googleStep,
        grantSteps: steps,
      },
      {
        id: 'search-console',
        label: 'Google Search Console',
        status: configured ? 'connected' : 'not_connected',
        detail: 'URL-prefix properties: topspeedserviceos.com, topspeedappliance.net (apex + www).',
        whatItUnlocks: 'Search queries, clicks, impressions, average position and index coverage for the flagship and .net — the organic-search scoreboard.',
        connectStep: googleStep,
        grantSteps: steps,
      },
      {
        id: 'google-business-profile',
        label: 'Google Business Profile',
        status: 'not_connected',
        detail: 'The Top Speed Appliance Google Business Profile (the "Open 24 hours" listing).',
        whatItUnlocks: 'Profile views, calls, direction requests, search appearances and review counts from Google Maps and Search.',
        connectStep: 'Google Business Profile cannot be read by a service account — it needs an OAuth '
          + 'grant from the Google account that manages the profile. When Ramone is ready, he signs in '
          + 'with that account and approves read-only Business Profile access; Pepper then wires the '
          + 'reader. Until that grant exists this stays not connected and no profile numbers are shown.',
        grantSteps: [],
      },
    ],
  };
}
