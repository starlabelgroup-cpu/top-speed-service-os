import { store } from '../data/store.js';
import { listPlans, listSubscriptions } from '../db/adPlansRepo.js';
import { COVERAGE_AFTER_RING2, EXPANSION_RING2_CITIES } from '../data/expansionCities.js';
import { NETWORK_PARTNER_COMPANIES, NETWORK_PARTNER_PROVIDERS } from '../data/networkPartners.js';
import { campaignOutcomeReport, flywheelLoopStages, recordedCostCents } from './adOutcomes.js';
import { getReferralFunnel } from './referrals.js';
import { seoConfigured } from './googleSeo.js';
import { mediaFacebookConnectionState } from './mediaFacebook.js';

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

const METRIC_BUILDERS = {
  'top-speed-ads': topSpeedAdsMetrics,
  'ads-console': adsConsoleMetrics,
  'local-os': localOsMetrics,
  'marketing-os': marketingOsMetrics,
  flywheel: flywheelMetrics,
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
