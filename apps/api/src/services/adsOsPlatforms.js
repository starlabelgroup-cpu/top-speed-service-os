import { store } from '../data/store.js';
import { listPlans, listSubscriptions } from '../db/adPlansRepo.js';
import { COVERAGE_AFTER_RING2, EXPANSION_RING2_CITIES } from '../data/expansionCities.js';
import { NETWORK_PARTNER_COMPANIES, NETWORK_PARTNER_PROVIDERS } from '../data/networkPartners.js';
import { campaignOutcomeReport, flywheelLoopStages, recordedCostCents } from './adOutcomes.js';
import { getReferralFunnel } from './referrals.js';
import { seoConfigured } from './googleSeo.js';
import { mediaFacebookConnectionState } from './mediaFacebook.js';
import { adsStreamCounts, queueSummary as facebookOsQueueSummary } from './facebookOs.js';
import { salesOsMetrics } from './salesOs.js';
import { campaignEngineSummary } from './campaignEngine.js';

/**
 * Top Speed Ads OS — the UNIFIED advertising feed (2026-11-22,
 * Ramone: "integrate it with all advertising platforms in Top
 * Speed Service OS — Top Speed Ads, Ads Console, Top Speed Local
 * OS, Marketing OS and Flywheel Advertising, all in one").
 *
 * One aggregate read over the five advertising platforms that
 * already live inside Service OS, so the Ads OS Manager app is a
 * single front door over all of them:
 *
 *   top-speed-ads  Top Speed Ads (Ad Studio) — Top Speed's own
 *                  campaigns: status counts, pending approvals,
 *                  recorded spend, attributed outcomes.
 *   ads-console    Ads Console (Advertiser Console) — advertiser
 *                  campaigns, plan subscriptions, creatives.
 *   local-os       Top Speed Local OS — one face of the ONE
 *                  Local + Marketing OS platform: the local
 *                  search DIRECTORIES AND MAPS face (directory
 *                  coverage for the Service Network, the setter-
 *                  to-ads loop stages).
 *   marketing-os   Marketing OS — the OTHER face of the same
 *                  platform: local WEBSITES, LANDING PAGES AND
 *                  CITY PAGES, with the marketing/advertising
 *                  tooling (page pipeline, taxonomy, publish
 *                  events, Google connection state).
 *   flywheel       Flywheel Advertising — the Flywheel advertiser
 *                  plans and the referral / review / install
 *                  flywheel serving the network AND outside
 *                  advertisers (under the Advertiser Console).
 *   facebook-os    Top Speed Facebook OS Manager — the official
 *                  Page's streaming post queue + recorded activity
 *                  (added 2026-11-23 with the Facebook OS build).
 *   ads-stream     Top Speed Ads — Streaming — the attraction
 *                  stream's counts: POSTED ads-style posts and the
 *                  surfaces carrying them LIVE (added 2026-11-23
 *                  with the social + ads streaming build).
 *   sales-os       Top Speed Sales OS — the sales platform: its
 *                  first vendor (Top Speed Appliances, the
 *                  used-appliance shop at topspeedappliances.com),
 *                  the ACTIVE catalog count, and an honest
 *                  LIVE/BUILT status from the catalog itself
 *                  (added 2026-11-23 with the Sales OS build).
 *
 * The two faces are grouped in the payload (group
 * "local-marketing-os") and share one SOCIAL element: the social
 * media connections (the Media OS social layer — the platform's
 * Facebook connection, services/mediaFacebook.js) span BOTH
 * faces; neither face owns them alone. The social state is the
 * platform's own connection truth — a verified attestation the
 * service itself maintains, never a fabricated "connected".
 *
 * DISCIPLINE, same as the summary feed (services/adsOsSummary.js):
 * every number comes from the platform's own existing service or
 * store — campaignOutcomeReport / flywheelLoopStages /
 * getReferralFunnel (services/adOutcomes.js, services/referrals.js),
 * the Flywheel plans repository (db/adPlansRepo.js), the Marketing
 * OS store collections, and the coverage record the expansion
 * module itself publishes (data/expansionCities.js). Nothing is
 * re-derived under copied logic where a service exists, no metric
 * a platform does not track is invented, and recorded spend is
 * only ever the figure staff recorded on the campaign record
 * (recordedCostCents) — never estimated, never imported.
 * Counts and labels only: no customer PII ever leaves through
 * this door, and the feed writes nothing.
 *
 * A platform whose source throws answers available:false with
 * SOURCE_UNAVAILABLE and null metrics — an honest dark section
 * instead of a fabricated zero — while the other four still read.
 */

// Mirrors CAMPAIGN_STATUSES in routes/adStudio.js (the console's
// own status set; not exported there).
const CAMPAIGN_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'PAUSED', 'ENDED'];
// Mirrors PAGE_STATUSES in routes/marketingOs.js.
const PAGE_STATUSES = ['DRAFT', 'IN_REVIEW', 'PUBLISHED', 'UNPUBLISHED'];

export const ADS_OS_PLATFORMS = [
  {
    key: 'top-speed-ads',
    name: 'Top Speed Ads',
    console: 'Ad Studio',
    role: "Top Speed's own advertising — house campaigns, approvals, recorded spend and attribution.",
    consoleUrl: 'https://topspeedserviceos.com/ad-studio',
  },
  {
    key: 'ads-console',
    name: 'Ads Console',
    console: 'Advertiser Console',
    role: 'Advertiser accounts on Top Speed surfaces — plan subscriptions, advertiser campaigns and creatives.',
    consoleUrl: 'https://topspeedserviceos.com/advertiser',
  },
  {
    key: 'local-os',
    name: 'Top Speed Local OS',
    console: 'Top Speed Local OS',
    group: 'local-marketing-os',
    face: 'directories-maps',
    role: 'One face of the one Local + Marketing OS platform — local search directories and maps presence, the main advertiser for the Service Network.',
    consoleUrl: 'https://topspeedserviceos.com/local',
  },
  {
    key: 'marketing-os',
    name: 'Marketing OS',
    console: 'Marketing OS',
    group: 'local-marketing-os',
    face: 'websites-pages',
    role: 'One face of the one Local + Marketing OS platform — local websites, landing pages and city pages, with the advanced marketing and advertising tools.',
    consoleUrl: 'https://topspeedserviceos.com/marketing-os',
  },
  {
    key: 'flywheel',
    name: 'Flywheel Advertising',
    console: 'Flywheel',
    role: 'Flywheel advertiser plans plus the referral, review and install flywheel — serving the network and outside advertisers.',
    consoleUrl: 'https://topspeedserviceos.com/flywheel',
  },
  {
    key: 'facebook-os',
    name: 'Top Speed Facebook OS Manager',
    console: 'Facebook OS Manager',
    role: 'The official Facebook Page, integrated: the daily streaming post queue (Top Speed Posts by Pepper + daily formats), recorded Page activity, and Facebook Ads drafts — Meta API writes are disabled, so drafts are planning records and enabling happens in Ads Manager.',
    consoleUrl: 'https://topspeedserviceos.com/facebook-os',
  },
  {
    key: 'ads-stream',
    name: 'Top Speed Ads — Streaming',
    console: 'Facebook OS Manager',
    role: 'The customer-attraction streaming system: the POSTED ads-style posts (AD_IDEA + CUSTOM — the formats the console records ads under) and the standing offer cards (the published rate card + referral terms), streamed from the public /ads-os/stream endpoint onto the fleet surfaces that carry the shared ads-stream include. Organic only — nothing here enables or funds an ad.',
    consoleUrl: 'https://topspeedserviceos.com/facebook-os',
  },
  {
    key: 'sales-os',
    name: 'Top Speed Sales OS',
    console: 'Sales OS',
    role: 'The sales platform inside the Service OS: Top Speed Appliances — the used-appliance shop at topspeedappliances.com — as its first vendor, with a staff-entered catalog and Stripe-checkout orders. Status is read from the catalog itself: LIVE once a real product is ACTIVE, BUILT while the catalog is still empty.',
    consoleUrl: 'https://topspeedserviceos.com/sales-os',
  },
  {
    key: 'campaign-engine',
    name: 'Top Speed Campaign Engine',
    console: 'Campaign Engine (registry)',
    role: 'The perpetual campaign factory (added 2026-11-23): campaign records generated daily across EVERY advertising division — Top Speed Ads, Local OS, Marketing OS, Sales OS, Book OS / Service Setters, dispatch, Tech, Field Pro, Ad Console, Flywheel, Ad Studio, Page Studio, CRM, Media OS, the service network, parts supply, Appliance Plug, Finance, Pepper Lists, Appliance Connect / Pro, AppliancePro, Speedy booking, rewards & referrals, Training Academy, the portal, Work Time Access, ApplianceMan, CocoCane and Cleanout Vents — each division row below carries its campaign count and its own console link (Rule 1). Zero spend: records are DRAFT / QUEUED / STAGED; funding, publishing and sending stay behind the owner\'s own approvals.',
    consoleUrl: 'https://topspeedserviceos.com/ads',
  },
];

function byStatusCounts(records, statuses) {
  const counts = Object.fromEntries(statuses.map((s) => [s, 0]));
  for (const record of records || []) {
    if (record && counts[record.status] != null) counts[record.status] += 1;
  }
  return counts;
}

function countBy(records, keyOf) {
  const counts = {};
  for (const record of records || []) {
    const key = keyOf(record) || 'UNKNOWN';
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

// ─── Top Speed Ads (Ad Studio) ────────────────────────────────────
function topSpeedAdsMetrics() {
  const house = store.adCampaigns.filter((c) => c.businessLine !== 'EXTERNAL');
  const byStatus = byStatusCounts(house, CAMPAIGN_STATUSES);
  let recordedTotalCents = null;
  let campaignsWithRecordedSpend = 0;
  for (const campaign of house) {
    const cost = recordedCostCents(campaign);
    if (cost != null) {
      recordedTotalCents = (recordedTotalCents ?? 0) + cost;
      campaignsWithRecordedSpend += 1;
    }
  }
  // The console's own outcome report (services/adOutcomes.js),
  // house rows only — advertiser rows belong to the Ads Console.
  const report = campaignOutcomeReport({ days: 30 });
  const houseRows = report.rows.filter((row) => row.kind === 'HOUSE');
  const outcomes = { leads: 0, estimates: 0, won: 0, wonCollectedCents: 0 };
  for (const row of houseRows) {
    outcomes.leads += row.leads || 0;
    outcomes.estimates += row.estimates || 0;
    outcomes.won += row.won || 0;
    outcomes.wonCollectedCents += row.wonCollectedCents || 0;
  }
  return {
    campaigns: { total: house.length, byStatus, pendingApproval: byStatus.PENDING_APPROVAL },
    recordedSpend: {
      totalCents: recordedTotalCents,
      campaignsWithRecordedSpend,
      note: 'Spend a person recorded on the campaign record in Ad Studio only — never estimated, never imported from the external platforms.',
    },
    outcomesLast30Days: outcomes,
  };
}

// ─── Ads Console (Advertiser Console) ─────────────────────────────
async function adsConsoleMetrics() {
  const external = store.adCampaigns.filter((c) => c.businessLine === 'EXTERNAL');
  const byStatus = byStatusCounts(external, CAMPAIGN_STATUSES);
  const subscriptions = await listSubscriptions();
  return {
    advertiserCampaigns: { total: external.length, byStatus, pendingApproval: byStatus.PENDING_APPROVAL },
    subscriptions: {
      total: subscriptions.length,
      byStatus: countBy(subscriptions, (s) => s.status || 'NONE'),
      advertisersWithSubscriptions: new Set(subscriptions.map((s) => s.userId).filter(Boolean)).size,
    },
    creatives: { total: store.advertiserCreatives.length },
  };
}

// ─── Top Speed Local OS (directories & maps face) ─────────────────
async function localOsMetrics() {
  return {
    directory: {
      // The coverage record the expansion module itself publishes
      // (data/expansionCities.js): the directory's city footprint —
      // 65 cities / 131 pages live, the next ring staged in the
      // Expander, 104 / 170 after it. The pages themselves are the
      // Marketing OS face's pipeline (counted there, not here —
      // one platform, no duplicated metrics).
      citiesPublished: COVERAGE_AFTER_RING2.citiesBefore,
      pagesPublished: COVERAGE_AFTER_RING2.pagesBefore,
      nextRingCitiesPending: EXPANSION_RING2_CITIES.length,
      coverageAfterNextRing: {
        cities: COVERAGE_AFTER_RING2.citiesAfter,
        pages: COVERAGE_AFTER_RING2.pagesAfter,
      },
      byCounty: COVERAGE_AFTER_RING2.byCounty,
    },
    network: {
      partnerCompanies: NETWORK_PARTNER_COMPANIES.length,
      partnerProviders: NETWORK_PARTNER_PROVIDERS.length,
    },
    // The Local OS loop's own stages (services/adOutcomes.js):
    // completed jobs, reviews and referrals on attributed bookings.
    loop: await flywheelLoopStages(),
  };
}

// ─── Marketing OS (websites & pages face) ─────────────────────────
function marketingOsMetrics() {
  return {
    pages: {
      total: store.landingPages.length,
      byStatus: byStatusCounts(store.landingPages, PAGE_STATUSES),
      byType: countBy(store.landingPages, (p) => p.type || 'UNKNOWN'),
    },
    taxonomy: {
      cities: store.marketingCities.length,
      services: store.marketingServices.length,
      brands: store.marketingBrands.length,
      symptoms: store.marketingSymptoms.length,
    },
    experiments: store.pageExperiments.length,
    publishEvents: Array.isArray(store.publishEvents) ? store.publishEvents.length : 0,
    seo: { configured: seoConfigured() },
  };
}

// ─── Flywheel Advertising ─────────────────────────────────────────
async function flywheelMetrics() {
  const plans = await listPlans();
  const subscriptions = await listSubscriptions();
  const planKeyById = new Map(plans.map((p) => [p.id, p.key]));
  const funnel = getReferralFunnel().all;
  const bookings = [...store.bookings.values()];
  return {
    plans: plans.map((p) => ({
      key: p.key,
      name: p.name,
      monthlyPriceCents: p.monthlyPriceCents ?? null,
      isActive: p.isActive !== false,
    })),
    subscriptionsByPlan: countBy(subscriptions, (s) => (s.planId ? planKeyById.get(s.planId) || 'unknown' : 'none')),
    funnel: {
      intakeEvents: store.events.filter((e) => e.type === 'INTAKE_RECEIVED').length,
      referralBookings: bookings.filter((b) => b.source === 'REFERRAL').length,
      reviewRequestsQueued: (store.notificationOutbox || []).filter((e) => e.template === 'REVIEW_REQUEST').length,
      appInstalls: store.appInstalls.filter((e) => e.event === 'installed').length,
      codesIssued: funnel.codesIssued,
      linkClicks: funnel.linkClicks,
      invites: funnel.invites,
      journeysTotal: funnel.journeysTotal,
      bookingsAttributed: funnel.bookingsAttributed,
      completions: funnel.completions,
      creditsIssued: funnel.creditsIssued,
      creditsIssuedCents: funnel.creditsIssuedCents,
      creditsAvailable: funnel.creditsAvailable,
      creditsRedeemed: funnel.creditsRedeemed,
    },
  };
}

// ─── Top Speed Facebook OS Manager ────────────────────────────────
// The stream queue's own summary (services/facebookOs.js): counts
// by lifecycle status, today's post, the next scheduled slot, the
// posted total, and the ad-draft counts. Counts and labels only —
// the app reads the same truth the /facebook-os console shows.
async function facebookOsMetrics() {
  const summary = await facebookOsQueueSummary();
  return {
    page: summary.page,
    postsByStatus: summary.posts,
    adDraftsByStatus: summary.adDrafts,
    postedTotal: summary.postedTotal,
    latestPostedAt: summary.latestPostedAt,
    nextScheduled: summary.nextScheduled,
    today: summary.today,
  };
}

// ─── Top Speed Ads — Streaming ────────────────────────────────────
// The attraction stream's own counts (services/facebookOs.js):
// POSTED ad posts, the latest one's date, and how many fleet
// surfaces carry the stream LIVE. The public stream itself is
// GET /api/v1/ads-os/stream (POSTED ad-format posts + offer cards).
async function adsStreamMetrics() {
  return adsStreamCounts();
}

// ─── Top Speed Campaign Engine ────────────────────────────────────
// The registry's own summary (services/campaignEngine.js): totals
// by status and surface, the batch ledger, and one row per
// division with its campaign count and console link — the
// interconnection view the owner directed (every advertising
// division working from one system of record).
async function campaignEngineMetrics() {
  const summary = await campaignEngineSummary();
  return {
    campaigns: {
      total: summary.total,
      byStatus: summary.byStatus,
      bySurface: summary.bySurface,
    },
    divisions: summary.divisions,
    batches: {
      total: summary.batches.total,
      latest: summary.batches.latest
        ? {
          batchKey: summary.batches.latest.batchKey,
          kind: summary.batches.latest.kind,
          campaignCount: summary.batches.latest.campaignCount,
          socialQueued: summary.batches.latest.socialQueued,
          generatedAt: summary.batches.latest.generatedAt,
        }
        : null,
    },
  };
}

// ─── Top Speed Sales OS ───────────────────────────────────────────
// The sales platform's own metrics (services/salesOs.js): vendor
// identity, ACTIVE product count, the storefront domain, and the
// honest LIVE/BUILT status the catalog itself supports.
async function salesOsSectionMetrics() {
  return salesOsMetrics();
}

const METRIC_BUILDERS = {
  'top-speed-ads': topSpeedAdsMetrics,
  'ads-console': adsConsoleMetrics,
  'local-os': localOsMetrics,
  'marketing-os': marketingOsMetrics,
  flywheel: flywheelMetrics,
  'facebook-os': facebookOsMetrics,
  'ads-stream': adsStreamMetrics,
  'sales-os': salesOsSectionMetrics,
  'campaign-engine': campaignEngineMetrics,
};

/**
 * The social connections shared across BOTH faces of the Local +
 * Marketing OS platform — the Media OS social layer's own
 * connection truth (services/mediaFacebook.js): the platform's
 * Facebook connection and the Page it posts to. This is a
 * verified attestation the service maintains, not a live probe,
 * and it is the only social connection state the platform tracks;
 * nothing else is presented as connected.
 */
export function buildAdsOsSocial() {
  try {
    const state = mediaFacebookConnectionState();
    return {
      available: true,
      sharedAcross: ['local-os', 'marketing-os'],
      facebook: {
        connected: state.connected,
        page: state.page ? { name: state.page.name, url: state.page.url } : null,
        account: state.account
          ? { name: state.account.name, verifiedAt: state.account.verifiedAt, via: state.account.via }
          : null,
      },
    };
  } catch {
    return { available: false, error: 'SOURCE_UNAVAILABLE', sharedAcross: ['local-os', 'marketing-os'], facebook: null };
  }
}

export const ADS_OS_GROUPS = [
  {
    key: 'local-marketing-os',
    name: 'Top Speed Local OS + Marketing OS',
    note: 'One platform, two faces: Local OS is the local search directories and maps face; Marketing OS is the local websites, landing pages and city pages face, with the marketing and advertising tools. The social connections are shared across both faces.',
    faces: ['local-os', 'marketing-os'],
  },
];

async function buildSection(descriptor) {
  try {
    const metrics = await METRIC_BUILDERS[descriptor.key]();
    const section = { ...descriptor, available: true, metrics };
    // Both faces carry the shared social element — it belongs to
    // the one platform, visible with either face.
    if (descriptor.group === 'local-marketing-os') section.social = buildAdsOsSocial();
    return section;
  } catch {
    return { ...descriptor, available: false, error: 'SOURCE_UNAVAILABLE', metrics: null };
  }
}

/** One platform's section, or null for an unknown platform key. */
export async function buildAdsOsPlatform(key) {
  const descriptor = ADS_OS_PLATFORMS.find((p) => p.key === key);
  if (!descriptor) return null;
  return buildSection(descriptor);
}

/** The unified feed: every platform's section under one payload. */
export async function buildAdsOsPlatforms(now = new Date()) {
  const platforms = {};
  for (const descriptor of ADS_OS_PLATFORMS) {
    platforms[descriptor.key] = await buildSection(descriptor);
  }
  return {
    generatedAt: now.toISOString(),
    order: ADS_OS_PLATFORMS.map((p) => p.key),
    groups: ADS_OS_GROUPS.map((g) => ({ ...g, social: buildAdsOsSocial() })),
    platforms,
  };
}
