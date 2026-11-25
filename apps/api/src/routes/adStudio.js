import { Router } from 'express';
import { z } from 'zod';
import { appendEvent, createId, store } from '../data/store.js';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { ROLES } from '../config/security.js';
import { slugify } from '../data/marketingTaxonomy.js';
import { persistAdCampaign, refreshAdCampaigns } from '../db/adStudioRepo.js';
import {
  ensureAdvertiserTracking,
  ensureCampaignLink,
  findProfileByUserId,
  recordCampaignLinkClick,
} from '../db/advertiserLinksRepo.js';
import { DISPLAY_SIZES, STREAMING_FORMATS, STREAMING_PACK, STREAMING_PROVIDERS } from '../data/streamingPack.js';
import { emitReport } from '../services/managementReports.js';
import { bumpBannerCounter, persistBanner } from '../db/bannersRepo.js';
import { assertImageDataUrl, speedyDraftAdCopy, speedyStatus } from '../services/speedy.js';
import {
  deleteAdvertiserCreative as removeAdvertiserCreative,
  getAdvertiserCreativeBytes,
  persistAdvertiserCreative,
} from '../db/advertiserCreativesRepo.js';
import {
  EXTERNAL_ADS, EXTERNAL_ADS_BOARD_LABEL, EXTERNAL_ADS_VERIFIED_ON,
  AD_SERVING_PROVIDER_ENTRIES, AD_SERVING_PROVIDERS_LABEL, AD_SERVING_PROVIDERS_VERIFIED_ON,
} from '../data/externalAds.js';
import { POSTER_IMAGE_NAMES, SCENARIO_IMAGE_NAMES } from './app.js';
import { publicAccess, publicPlan, requirePlanFeature, resolveAccess } from '../services/adPlans.js';
import { campaignOutcomeReport, flywheelLoopStages, recordedCostCents } from '../services/adOutcomes.js';
import { findClaimViolations } from '../services/claimCheck.js';

/** Claim-check gate (Flywheel Item 6, 2026-11-23): hand-written
 *  campaign copy passes the same gate the Campaign Engine's
 *  factory enforces on generated copy. Returns true when the
 *  response has been sent (violations found). */
function claimGate(res, fields) {
  const violations = findClaimViolations(fields);
  if (!violations.length) return false;
  res.status(400).json({
    error: 'Copy failed the claim check — fix the flagged claims and try again',
    code: 'CLAIM_CHECK_FAILED',
    violations,
  });
  return true;
}

/** The copy-bearing fields of a campaign payload, as [field, text]. */
function campaignCopyFields(data) {
  return [
    ['name', data.name],
    ['objective', data.objective],
    ['offering', data.offering],
    ['headline', data.headline],
    ['copy', data.copy],
    ['ctaText', data.ctaText],
  ];
}

/**
 * Ad Studio — the console of TOP SPEED ADS, the Flywheel AI
 * Advertising in-house ads system (2026-11-14; Top Speed Ads
 * upgrade 2026-11-17: first-touch attribution with click IDs, raw
 * impression/click counting on the display feed, the external
 * platforms readiness board, the flywheel loop view, the Speedy
 * copy drafter and the house creative picker).
 *
 * Ramone asked for the real version of a prototype he saw elsewhere:
 * an ad system that lives on the Service OS, spends nothing outside,
 * and runs only on his own surfaces. Campaigns are built from Media
 * OS creatives, point at his own published landing pages, and — when
 * the placement is BANNER — rotate in the flagship footer through the
 * existing Banner system. Pepper (the system manager) and staff build
 * drafts; NOTHING goes live until the owner (MASTER: COMPANY_OWNER /
 * PLATFORM_ADMIN) approves it. Results are counted from real bookings
 * and connections whose attribution carries the campaign's sourceTag
 * — the flat intake `source`, or the attribution object's `via` /
 * `utmCampaign` (the shapes the intake attribution layer fills: a
 * campaign link carries ?utm_campaign=<sourceTag>).
 *
 * Status machine, enforced server-side:
 *   DRAFT → PENDING_APPROVAL (submit, staff)
 *   PENDING_APPROVAL → ACTIVE (approve, OWNER only; activates banner)
 *   ACTIVE → PAUSED (pause, staff; deactivates banner)
 *   PAUSED → ACTIVE (resume, OWNER only; reactivates banner)
 *   ACTIVE | PAUSED | PENDING_APPROVAL → ENDED (end, staff)
 * Anything else is a 422.
 */
const router = Router();
const staffOnly = [
  authenticate,
  requireCompany,
  requireRole(ROLES.MARKETING_MANAGER, ROLES.AD_SPECIALIST, ROLES.COMPANY_ADMIN, ROLES.COMPANY_OWNER, ROLES.PLATFORM_ADMIN),
];
const ownerOnly = [
  authenticate,
  requireCompany,
  requireRole(ROLES.COMPANY_OWNER, ROLES.PLATFORM_ADMIN),
];

const BUSINESS_LINES = ['TOP_SPEED', 'CLEANOUT_VENTS', 'COCOCANE', 'EXTERNAL'];
const CAMPAIGN_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'PAUSED', 'ENDED'];
const PLACEMENTS = ['BANNER', 'NONE', 'STREAMING'];
// Streaming Ads channel (2026-11-17): a STREAMING-placement campaign
// carries Google-style creative for streaming TV providers. The
// provider names are target labels only — no streaming provider ad
// account is connected, nothing is bought or placed externally, and
// streaming campaigns NEVER enter the /ad-studio/display banner feed
// (that feed filters placement BANNER, unchanged). Same lifecycle as
// every campaign: owner-only approval before anything is ACTIVE.
const STREAMING_PROVIDER_IDS = STREAMING_PROVIDERS.map((p) => p.id);
// Flywheel relatedness categories (2026-11-16): a campaign may declare
// one; customer surfaces pass theirs to the display feed, which prefers
// a category match and falls back to any ACTIVE campaign. No scoring —
// a declared label and a surface label, compared exactly.
export const AD_CATEGORIES = [
  'APPLIANCE_SERVICE',
  'PARTS_SUPPLY',
  'VENT_CLEANING',
  'FOOD_DRINK',
  'HOME_SERVICES',
  'GENERAL',
  // Pepper Lists customer ads (2026-11-16): ads submitted by regular
  // CUSTOMER accounts from inside Pepper Lists carry this category so
  // the Pepper Lists surface's display feed prefers them.
  'PEPPER_LISTS',
];
const TRANSITIONS = {
  DRAFT: ['PENDING_APPROVAL'],
  PENDING_APPROVAL: ['ACTIVE', 'ENDED'],
  ACTIVE: ['PAUSED', 'ENDED'],
  PAUSED: ['ACTIVE', 'ENDED'],
  ENDED: [],
};
const LINE_LABELS = {
  TOP_SPEED: 'Top Speed Appliance',
  CLEANOUT_VENTS: 'Cleanout Vents',
  COCOCANE: 'CocoCane',
  EXTERNAL: 'Advertiser',
};
const LINE_CTA = {
  TOP_SPEED: 'Book Service',
  CLEANOUT_VENTS: 'Book a Cleaning',
  COCOCANE: 'See the Menu',
  EXTERNAL: 'Learn More',
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function actorOf(req) {
  return req.user?.email || req.user?.id || 'ad-studio';
}

function actorIdOf(req) {
  const id = req.user?.id;
  return id && UUID_RE.test(id) ? id : null;
}

function findCampaign(id) {
  return store.adCampaigns.find((c) => c.id === id) || null;
}

/**
 * Snapshot fix (2026-11-24): the store is hydrated once per
 * serverless instance at cold start, so without a re-read the
 * console's campaign state is whatever snapshot the serving instance
 * happened to start with — the list alternated between the real
 * state and a pre-change snapshot across reloads. Every console read
 * (and every campaign action, so a status change is always evaluated
 * against the campaign's real current status) awaits a strict
 * refresh from the AdCampaign table first. On a database failure the
 * handler answers 503 — an honest load error — instead of presenting
 * the instance snapshot as live data. Returns false when the 503 has
 * been sent.
 */
async function freshCampaigns(res) {
  try {
    await refreshAdCampaigns();
    return true;
  } catch (error) {
    console.error('ad-studio campaign refresh failed', error?.message || error);
    res.status(503).json({ error: 'Campaign data could not be loaded from the database — try again.' });
    return false;
  }
}

function findCreative(id) {
  if (!id) return null;
  return store.mediaContent.find((c) => c.id === id) || null;
}

export function generateSourceTag(name) {
  const base = `adstudio-${slugify(name) || 'campaign'}`.slice(0, 60);
  if (!store.adCampaigns.some((c) => c.sourceTag === base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${n}`;
    if (!store.adCampaigns.some((c) => c.sourceTag === candidate)) return candidate;
  }
  return `${base}-${createId().slice(0, 8)}`;
}

function taggedUrl(url, tag) {
  if (!url) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}utm_campaign=${encodeURIComponent(tag)}`;
}

/**
 * Keep the linked Banner in step with the campaign: an ACTIVE campaign
 * with placement BANNER has exactly one active FOOTER banner built
 * from its creative; in every other state that banner is inactive.
 * Uses the existing Banner store + persistence, unchanged.
 */
/**
 * The display resolution every surface shares: a campaign's own
 * advertiser fields win (Flywheel advertiser campaigns carry their
 * business name, headline, copy and CTA on the campaign itself); house
 * campaigns fall back to their Media OS creative, then to the business
 * line's label and default CTA — exactly the pre-Flywheel behavior.
 */
function displayFields(campaign) {
  const creative = findCreative(campaign.creativeId);
  return {
    advertiserName: campaign.advertiserName || LINE_LABELS[campaign.businessLine] || 'Top Speed Appliance',
    headline: (campaign.headline || creative?.title || campaign.name).slice(0, 120),
    copy: (campaign.copy || creative?.description || campaign.objective || '').slice(0, 400) || null,
    // A house image picked from the creative library wins over the
    // Media OS creative's image; campaigns that never picked one
    // resolve exactly as before.
    imageUrl: campaign.imageUrl || creative?.thumbnailUrl || creative?.assetUrl || null,
    ctaText: campaign.ctaText || LINE_CTA[campaign.businessLine] || 'Learn More',
    ctaUrl: taggedUrl(campaign.destinationUrl, campaign.sourceTag),
  };
}

async function syncBanner(campaign) {
  const shouldRun = campaign.status === 'ACTIVE' && campaign.placement === 'BANNER';
  let banner = campaign.bannerId ? store.banners.find((b) => b.id === campaign.bannerId) : null;
  if (shouldRun) {
    const fields = {
      placement: 'FOOTER',
      ...displayFields(campaign),
      active: true,
    };
    if (!banner) {
      const now = new Date().toISOString();
      banner = { id: createId(), impressions: 0, clicks: 0, createdAt: now, updatedAt: now, ...fields };
      store.banners.push(banner);
      campaign.bannerId = banner.id;
    } else {
      Object.assign(banner, fields, { updatedAt: new Date().toISOString() });
    }
    await persistBanner(banner);
  } else if (banner && banner.active) {
    banner.active = false;
    banner.updatedAt = new Date().toISOString();
    await persistBanner(banner);
  }
}

function carriesTag(record, sourceTag) {
  if (!record) return false;
  if (record.source === sourceTag) return true;
  const attribution = record.attribution;
  return Boolean(attribution && (attribution.via === sourceTag || attribution.utmCampaign === sourceTag));
}

function attributedCounts(sourceTag) {
  let bookings = 0;
  for (const booking of store.bookings.values()) {
    if (carriesTag(booking, sourceTag)) bookings += 1;
  }
  let connections = 0;
  for (const connection of store.connections || []) {
    if (carriesTag(connection, sourceTag)) connections += 1;
  }
  return { bookings, connections, total: bookings + connections };
}

// Streaming creative fields, shared by the staff create/patch
// schemas (all optional + nullable: non-streaming campaigns leave
// them empty). Google Ads limits are enforced here: headlines
// 30 chars, descriptions and long headline 90 chars.
const streamingFields = {
  streamingFormat: z.enum(STREAMING_FORMATS).nullable().optional(),
  streamingProviders: z.array(z.enum(STREAMING_PROVIDER_IDS)).max(STREAMING_PROVIDER_IDS.length).nullable().optional(),
  headlines: z.array(z.string().trim().min(1).max(30)).max(15).nullable().optional(),
  descriptions: z.array(z.string().trim().min(1).max(90)).max(4).nullable().optional(),
  displayPath: z.string().trim().max(30).nullable().optional(),
  longHeadline: z.string().trim().max(90).nullable().optional(),
  displaySizes: z.array(z.enum(DISPLAY_SIZES)).max(DISPLAY_SIZES.length).nullable().optional(),
};

/**
 * A STREAMING campaign is only well-formed with its Google-style
 * creative attached: a format, at least one provider target, at
 * least one headline and one description. Checked against the merged
 * record on create and on patch. Returns an error string or null.
 */
function streamingError(record) {
  if (record.placement !== 'STREAMING') return null;
  if (!record.streamingFormat) return 'A streaming campaign needs a format (TEXT or DISPLAY)';
  if (!Array.isArray(record.streamingProviders) || record.streamingProviders.length === 0) {
    return 'A streaming campaign needs at least one streaming provider target';
  }
  if (!Array.isArray(record.headlines) || record.headlines.length === 0) {
    return 'A streaming campaign needs at least one headline (30 characters max each)';
  }
  if (!Array.isArray(record.descriptions) || record.descriptions.length === 0) {
    return 'A streaming campaign needs at least one description (90 characters max each)';
  }
  return null;
}

/** The streaming fields of a record, normalized for storage. */
function streamingValues(source) {
  return {
    streamingFormat: source.streamingFormat || null,
    streamingProviders: source.streamingProviders || [],
    headlines: source.headlines || [],
    descriptions: source.descriptions || [],
    displayPath: source.displayPath || null,
    longHeadline: source.longHeadline || null,
    displaySizes: source.displaySizes || [],
  };
}

function publicCampaign(record) {
  const creative = findCreative(record.creativeId);
  const banner = record.bannerId ? store.banners.find((b) => b.id === record.bannerId) : null;
  return {
    id: record.id,
    name: record.name,
    businessLine: record.businessLine,
    objective: record.objective,
    status: record.status,
    creativeId: record.creativeId || null,
    creativeUploadId: record.creativeUploadId || null,
    creative: creative ? { id: creative.id, slug: creative.slug, title: creative.title, status: creative.status } : null,
    destinationUrl: record.destinationUrl,
    trackedUrl: taggedUrl(record.destinationUrl, record.sourceTag),
    sourceTag: record.sourceTag,
    placement: record.placement,
    advertiserName: record.advertiserName || null,
    offering: record.offering || null,
    headline: record.headline || null,
    copy: record.copy || null,
    ctaText: record.ctaText || null,
    category: record.category || null,
    imageUrl: record.imageUrl || null,
    ...streamingValues(record),
    bannerId: record.bannerId || null,
    banner: banner
      ? { id: banner.id, active: banner.active !== false, impressions: banner.impressions || 0, clicks: banner.clicks || 0 }
      : null,
    // Recorded spend (Local OS loop fix 2): the figure staff record
    // on the campaign; null = nothing recorded. Cost per won job
    // divides this and only this.
    recordedSpendCents: record.recordedSpendCents ?? null,
    notes: record.notes || null,
    createdById: record.createdById || null,
    approvedById: record.approvedById || null,
    approvedAt: record.approvedAt || null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

// ─── campaigns ──────────────────────────────────────────────────────

router.get('/ad-studio/campaigns', ...staffOnly, async (req, res) => {
  if (!(await freshCampaigns(res))) return;
  const status = String(req.query.status || '').trim().toUpperCase();
  const line = String(req.query.businessLine || '').trim().toUpperCase();
  const placement = String(req.query.placement || '').trim().toUpperCase();
  let items = [...store.adCampaigns].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  if (status) items = items.filter((c) => c.status === status);
  if (line) items = items.filter((c) => c.businessLine === line);
  if (placement) items = items.filter((c) => c.placement === placement);
  const byStatus = Object.fromEntries(CAMPAIGN_STATUSES.map((s) => [s, store.adCampaigns.filter((c) => c.status === s).length]));
  return res.json({
    data: items.map(publicCampaign),
    counts: { total: store.adCampaigns.length, byStatus, pendingApproval: byStatus.PENDING_APPROVAL },
  });
});

router.get('/ad-studio/results', ...staffOnly, async (req, res) => {
  if (!(await freshCampaigns(res))) return;
  const data = store.adCampaigns.map((c) => ({
    campaignId: c.id,
    name: c.name,
    sourceTag: c.sourceTag,
    status: c.status,
    ...attributedCounts(c.sourceTag),
  }));
  return res.json({ data });
});

/**
 * Cost per WON job (2026-11-20, approved recommendation E1): each
 * campaign joined through the CRM pipeline to its won jobs and the
 * real money collected on them — see services/adOutcomes.js for the
 * full grounding. Read-only: nothing here writes a campaign, a
 * pipeline stage, or a booking. Cost per won job is computed only
 * from a spend figure recorded on the campaign itself; no campaign
 * carries one today, so the cost block honestly reports
 * NO_COST_RECORDED instead of dividing by a budget label or an
 * external platform's numbers.
 */
router.get('/ad-studio/cost-per-won', ...staffOnly, async (req, res) => {
  if (!(await freshCampaigns(res))) return;
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
  return res.json({ data: campaignOutcomeReport({ days }) });
});

// ─── Top Speed Ads: attribution view (2026-11-17) ───────────────────

/**
 * Every booking in the window, grouped the way an advertiser asks:
 * how many arrived with any first-touch attribution, where they
 * came from (utm_source, falling back to the [via:] surface tag),
 * which campaign they carried, and which platform click IDs were
 * present. Counts come from the bookings' stored attribution — the
 * same records the intake wrote — so an empty window honestly
 * reports zeros (capture only exists from the day it shipped).
 */
router.get('/ad-studio/attribution', ...staffOnly, (req, res) => {
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const inWindow = [...store.bookings.values()].filter((b) => {
    const t = new Date(b.createdAt || 0).getTime();
    return Number.isFinite(t) && t >= since;
  });
  const bySource = new Map();
  const byCampaign = new Map();
  const clickIds = { gclid: 0, fbclid: 0, msclkid: 0, any: 0 };
  let withAttribution = 0;
  for (const booking of inWindow) {
    const a = booking.attribution;
    if (!a || !Object.keys(a).length) continue;
    withAttribution += 1;
    const source = a.utmSource || a.via || '(tagged, no source)';
    bySource.set(source, (bySource.get(source) || 0) + 1);
    if (a.utmCampaign) byCampaign.set(a.utmCampaign, (byCampaign.get(a.utmCampaign) || 0) + 1);
    let anyClick = false;
    for (const key of ['gclid', 'fbclid', 'msclkid']) {
      if (a[key]) { clickIds[key] += 1; anyClick = true; }
    }
    if (anyClick) clickIds.any += 1;
  }
  const rows = (map, key) => [...map.entries()]
    .map(([value, bookings]) => ({ [key]: value, bookings }))
    .sort((x, y) => y.bookings - x.bookings);
  return res.json({
    data: {
      windowDays: days,
      totalBookings: inWindow.length,
      withAttribution,
      bySource: rows(bySource, 'source'),
      byCampaign: rows(byCampaign, 'campaign'),
      clickIds,
    },
  });
});

// ─── Top Speed Ads: flywheel loop view (2026-11-17) ─────────────────

/**
 * The flywheel as it actually stands: placements served → clicks →
 * attributed bookings, counted from the same counters and records
 * as everything else in this studio — and, since the Local OS loop
 * fix (2026-11-20), the outcome stages too: completed jobs, reviews
 * and referrals counted from the real records with the same
 * campaign-tag attribution join as cost per won job (see
 * services/adOutcomes.js flywheelLoopStages). A stage with nothing
 * behind it reads an honest 0 — never an invented number.
 */
router.get('/ad-studio/loop', ...staffOnly, async (req, res) => {
  if (!(await freshCampaigns(res))) return;
  let impressions = 0;
  let clicks = 0;
  for (const campaign of store.adCampaigns) {
    if (!campaign.bannerId) continue;
    const banner = store.banners.find((b) => b.id === campaign.bannerId);
    if (!banner) continue;
    impressions += banner.impressions || 0;
    clicks += banner.clicks || 0;
  }
  let attributedBookings = 0;
  for (const booking of store.bookings.values()) {
    if (booking.attribution && Object.keys(booking.attribution).length) attributedBookings += 1;
  }
  const outcomes = await flywheelLoopStages();
  return res.json({
    data: {
      stages: [
        { id: 'served', label: 'Placements served', value: impressions, note: 'Raw impressions counted on the in-house banner placements (one per display feed serve).' },
        { id: 'clicks', label: 'Clicks', value: clicks, note: 'Raw clicks counted on the placements, through to their destinations.' },
        { id: 'attributedBookings', label: 'Attributed bookings', value: attributedBookings, note: 'Bookings whose intake carried first-touch attribution — a source tag, UTM tags or a platform click ID (all time; the Attribution view above breaks the recent window down).' },
        { id: 'completedJobs', label: 'Completed jobs', value: outcomes.completedJobs, note: 'Attributed bookings that reached COMPLETED — counted with the same campaign-tag join as cost per won job (intake source, or attribution via / utm_campaign).' },
        { id: 'reviews', label: 'Reviews', value: outcomes.reviewsReceived, asksSent: outcomes.reviewAsksSent, received: outcomes.reviewsReceived, note: 'Review asks sent for attributed bookings and the real reviews recorded against them — reviews are earned from completed jobs only, never invented.' },
        { id: 'referrals', label: 'Referrals', value: outcomes.referralJourneys, codesIssued: outcomes.referralCodesIssued, creditsIssued: outcomes.referralCreditsIssued, note: 'Referral journeys opened under codes issued from attributed bookings, and the credits issued on them — campaign customers turning into referrers.' },
      ],
      ctr: impressions > 0 ? clicks / impressions : null,
    },
  });
});

// ─── Top Speed Ads: external platforms readiness board ──────────────

/**
 * The campaigns of record in the outside platforms (Google, Meta,
 * Microsoft), from the single registry in data/externalAds.js.
 * Read-only mirror — no external API is called, nothing can be
 * funded, launched or edited from here.
 */
router.get('/ad-studio/external-board', ...staffOnly, (req, res) => {
  const byPlatform = {};
  for (const campaign of EXTERNAL_ADS) {
    byPlatform[campaign.platform] = (byPlatform[campaign.platform] || 0) + 1;
  }
  return res.json({
    data: {
      verifiedOn: EXTERNAL_ADS_VERIFIED_ON,
      label: EXTERNAL_ADS_BOARD_LABEL,
      counts: { total: EXTERNAL_ADS.length, byPlatform },
      campaigns: EXTERNAL_ADS,
      // Ad-serving providers (AdStream layer, 2026-11-18): a separate
      // section, NOT campaigns — no budgets, nothing serving. The
      // dated mirror of the provider connection registry whose live
      // request state sits behind /ad-studio/providers.
      providersVerifiedOn: AD_SERVING_PROVIDERS_VERIFIED_ON,
      providersLabel: AD_SERVING_PROVIDERS_LABEL,
      providers: AD_SERVING_PROVIDER_ENTRIES,
    },
  });
});

// ─── Top Speed Ads: house creative library (picker) ─────────────────

/**
 * The pickable house creative for campaign images: the poster set
 * and the scenario library, exactly as the API already serves them.
 * The picker stores the chosen URL on the campaign (imageUrl); the
 * display resolution prefers it over the Media OS creative's image.
 */
router.get('/ad-studio/creative-library', ...staffOnly, (req, res) => {
  const posters = POSTER_IMAGE_NAMES.map((name) => ({ kind: 'poster', name, url: `/api/v1/app/poster-images/${name}` }));
  const scenarios = SCENARIO_IMAGE_NAMES.map((name) => ({ kind: 'scenario', name, url: `/api/v1/app/scenario-images/${name}` }));
  return res.json({ data: { posters, scenarios, total: posters.length + scenarios.length } });
});

// ─── Top Speed Ads: Draft with Speedy (AI copy drafter) ─────────────

/**
 * Speedy drafts the copy; the draft becomes a campaign in
 * PENDING_APPROVAL — the owner's queue — exactly like a staff
 * submit. The AI never publishes: approval stays the owner-only
 * action it has always been. Platform limits are enforced HERE, on
 * the AI's output, the same way the streaming pack enforces them on
 * human input (headlines 30 / descriptions 90 streaming; headline
 * 120 / copy 400 banner), and the brand rules are enforced again
 * here too: any line carrying a review/rating claim is dropped, and
 * any line carrying a price is dropped unless it is the Top Speed
 * line's $99 residential diagnostic.
 */
function copyLineAllowed(line, businessLine) {
  if (/\bstars?\b|\brated\b|\breviews?\b/i.test(line)) return false;
  const amounts = line.match(/\$\s?\d[\d,]*(?:\.\d{2})?/g) || [];
  if (!amounts.length) return true;
  if (businessLine !== 'TOP_SPEED') return false;
  return amounts.every((a) => a.replace(/[\s,]/g, '') === '$99');
}

function fitDraftLines(lines, maxLen, cap, businessLine) {
  const out = [];
  for (const raw of Array.isArray(lines) ? lines : []) {
    if (typeof raw !== 'string') continue;
    const line = raw.trim().slice(0, maxLen);
    if (!line || !copyLineAllowed(line, businessLine)) continue;
    out.push(line);
    if (out.length >= cap) break;
  }
  return out;
}

function fitDraftLine(value, maxLen, businessLine) {
  if (typeof value !== 'string') return null;
  const line = value.trim().slice(0, maxLen);
  return line && copyLineAllowed(line, businessLine) ? line : null;
}

const draftCopySchema = z.object({
  name: z.string().trim().min(3).max(160).optional(),
  businessLine: z.enum(BUSINESS_LINES),
  topic: z.string().trim().min(3).max(600).optional(),
  destinationUrl: z.string().trim().min(1).max(1000),
  placement: z.enum(PLACEMENTS).optional(),
  streamingFormat: z.enum(STREAMING_FORMATS).nullable().optional(),
  streamingProviders: z.array(z.enum(STREAMING_PROVIDER_IDS)).max(STREAMING_PROVIDER_IDS.length).nullable().optional(),
});

router.post('/ad-studio/draft-copy', ...staffOnly, async (req, res) => {
  // The builder sends its raw field values, so a campaign name or
  // objective the user left blank arrives as an empty string, not an
  // absent field. Both are optional in this schema — the draft is
  // auto-named from the topic below — so a blank string must count
  // as "not given"; otherwise it fails min(3) and the click dies
  // with a bare "Invalid draft request" on a legitimate draft
  // (Ramone incident, 2026-11-20: creative picked, name left blank).
  const body = { ...(req.body || {}) };
  for (const key of ['name', 'topic']) {
    if (typeof body[key] === 'string' && body[key].trim() === '') delete body[key];
  }
  const parsed = draftCopySchema.safeParse(body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid draft request', details: parsed.error.flatten() });
  const placement = parsed.data.placement || 'BANNER';
  // The topic is what Speedy drafts about: the builder's objective
  // when given, else the campaign name. One of the two is required.
  const topic = parsed.data.topic || parsed.data.name || '';
  if (!topic) return res.status(400).json({ error: 'Give the draft a campaign name or an objective first — Speedy drafts from that.' });
  if (placement === 'STREAMING') {
    if (!parsed.data.streamingFormat) return res.status(400).json({ error: 'A streaming draft needs a format (TEXT or DISPLAY)' });
    if (!Array.isArray(parsed.data.streamingProviders) || parsed.data.streamingProviders.length === 0) {
      return res.status(400).json({ error: 'Pick at least one streaming provider target before drafting' });
    }
  }
  if (!speedyStatus().configured) {
    return res.status(503).json({ error: 'Speedy copy drafting is unavailable right now — build the campaign by hand in the builder above; it works exactly as before.' });
  }
  let draft;
  try {
    draft = await speedyDraftAdCopy({
      businessLine: parsed.data.businessLine,
      topic,
      destinationUrl: parsed.data.destinationUrl,
      placement,
      streamingFormat: parsed.data.streamingFormat || null,
    });
  } catch (error) {
    return res.status(502).json({ error: 'Speedy could not draft copy just now — try again, or write it by hand in the builder.', detail: String(error?.message || error) });
  }
  const line = parsed.data.businessLine;
  const streaming = placement === 'STREAMING';
  const headlines = fitDraftLines(draft?.headlines, streaming ? 30 : 120, 15, line);
  const descriptions = fitDraftLines(draft?.descriptions, streaming ? 90 : 400, 4, line);
  const longHeadline = streaming ? fitDraftLine(draft?.longHeadline, 90, line) : null;
  const headline = streaming ? null : (fitDraftLine(draft?.headline, 120, line) || headlines[0] || null);
  const copy = streaming ? (descriptions[0] || null) : (fitDraftLine(draft?.copy, 400, line) || descriptions[0] || null);
  if (streaming && (!headlines.length || !descriptions.length)) {
    return res.status(502).json({ error: 'Speedy did not return usable streaming copy inside the platform limits — try again, or write it by hand in the builder.' });
  }
  if (!streaming && !headline && !copy) {
    return res.status(502).json({ error: 'Speedy did not return usable copy — try again, or write it by hand in the builder.' });
  }
  const now = new Date().toISOString();
  const record = {
    id: createId(),
    name: parsed.data.name || `${topic} — Speedy draft`.slice(0, 160),
    businessLine: line,
    objective: topic,
    status: 'PENDING_APPROVAL',
    creativeId: null,
    destinationUrl: parsed.data.destinationUrl,
    sourceTag: generateSourceTag(parsed.data.name || topic),
    placement,
    ...(streaming
      ? { streamingFormat: parsed.data.streamingFormat, streamingProviders: [...parsed.data.streamingProviders], headlines, descriptions, displayPath: null, longHeadline, displaySizes: [] }
      : streamingValues({})),
    bannerId: null,
    advertiserName: parsed.data.businessLine === 'EXTERNAL' ? null : (LINE_LABELS[line] || null),
    offering: topic.slice(0, 200),
    headline,
    copy,
    ctaText: LINE_CTA[line] || 'Learn More',
    category: null,
    imageUrl: null,
    recordedSpendCents: null,
    notes: 'Drafted by Speedy (Top Speed Ads AI copy drafter) from the topic in the objective — every word waits for the owner\'s approval; the AI never publishes.',
    createdById: actorIdOf(req),
    approvedById: null,
    approvedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  // Claim-check gate (Flywheel Item 6): Speedy's drafted copy is
  // gated before the draft record exists — a violating draft is
  // rejected with the reasons, never stored.
  if (claimGate(res, [
    ['headlines', headlines.join('\n')],
    ['descriptions', descriptions.join('\n')],
    ['headline', headline],
    ['copy', copy],
    ['longHeadline', longHeadline],
  ])) return;
  const streamErr = streamingError(record);
  if (streamErr) return res.status(400).json({ error: streamErr });
  store.adCampaigns.push(record);
  await persistAdCampaign(record);
  await appendEvent('AD_CAMPAIGN_PENDING_APPROVAL', {
    source: 'ad-studio-speedy-drafter',
    actor: actorOf(req),
    entityType: 'AD_CAMPAIGN',
    entityId: record.id,
    details: { sourceTag: record.sourceTag, placement: record.placement, ownerAction: false },
  });
  emitReport({
    department: 'marketing',
    type: 'AD_CAMPAIGN_SUBMITTED',
    title: `Ad campaign submitted for approval — ${record.name}`,
    detail: { campaignId: record.id, name: record.name, businessLine: record.businessLine, sourceTag: record.sourceTag, destinationUrl: record.destinationUrl, placement: record.placement, actor: actorOf(req), draftedBy: 'speedy' },
    source: 'ad-studio-speedy-drafter',
    reference: record.sourceTag,
    eventKey: `ad-campaign:${record.id}:PENDING_APPROVAL:${record.updatedAt}`,
  });
  return res.status(201).json({ data: publicCampaign(record) });
});

// Flywheel advertiser fields, shared by the staff create/patch schemas
// (all optional + nullable: house campaigns leave them null).
const advertiserFields = {
  advertiserName: z.string().trim().min(2).max(120).nullable().optional(),
  offering: z.string().trim().min(3).max(200).nullable().optional(),
  headline: z.string().trim().min(3).max(120).nullable().optional(),
  copy: z.string().trim().max(400).nullable().optional(),
  ctaText: z.string().trim().min(2).max(60).nullable().optional(),
  category: z.enum(AD_CATEGORIES).nullable().optional(),
  // Creative picker (2026-11-17): a house creative image URL chosen
  // from the scenario/poster library (see /ad-studio/creative-library).
  imageUrl: z.string().trim().max(500).nullable().optional(),
};

const campaignCreateSchema = z.object({
  name: z.string().trim().min(3).max(160),
  businessLine: z.enum(BUSINESS_LINES),
  objective: z.string().trim().min(3).max(600),
  creativeId: z.string().uuid().nullable().optional(),
  destinationUrl: z.string().trim().min(1).max(1000),
  placement: z.enum(PLACEMENTS).optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  ...advertiserFields,
  ...streamingFields,
});

router.post('/ad-studio/campaigns', ...staffOnly, async (req, res) => {
  if (!(await freshCampaigns(res))) return;
  const parsed = campaignCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid campaign', details: parsed.error.flatten() });
  if (parsed.data.creativeId && !findCreative(parsed.data.creativeId)) {
    return res.status(400).json({ error: 'creativeId does not match a Media OS content record' });
  }
  const streamErr = streamingError({ placement: parsed.data.placement || 'NONE', ...streamingValues(parsed.data) });
  if (streamErr) return res.status(400).json({ error: streamErr });
  if (claimGate(res, campaignCopyFields(parsed.data))) return;
  const now = new Date().toISOString();
  const record = {
    id: createId(),
    name: parsed.data.name,
    businessLine: parsed.data.businessLine,
    objective: parsed.data.objective,
    status: 'DRAFT',
    creativeId: parsed.data.creativeId || null,
    destinationUrl: parsed.data.destinationUrl,
    sourceTag: generateSourceTag(parsed.data.name),
    placement: parsed.data.placement || 'NONE',
    ...streamingValues(parsed.data),
    bannerId: null,
    advertiserName: parsed.data.advertiserName || null,
    offering: parsed.data.offering || null,
    headline: parsed.data.headline || null,
    copy: parsed.data.copy || null,
    ctaText: parsed.data.ctaText || null,
    category: parsed.data.category || null,
    imageUrl: parsed.data.imageUrl || null,
    recordedSpendCents: null,
    notes: parsed.data.notes || null,
    createdById: actorIdOf(req),
    approvedById: null,
    approvedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  store.adCampaigns.push(record);
  await persistAdCampaign(record);
  await appendEvent('AD_CAMPAIGN_CREATED', {
    source: 'ad-studio-console',
    actor: actorOf(req),
    entityType: 'AD_CAMPAIGN',
    entityId: record.id,
    details: { sourceTag: record.sourceTag, businessLine: record.businessLine, placement: record.placement },
  });
  return res.status(201).json({ data: publicCampaign(record) });
});

router.get('/ad-studio/campaigns/:id', ...staffOnly, async (req, res) => {
  if (!(await freshCampaigns(res))) return;
  const record = findCampaign(req.params.id);
  if (!record) return res.status(404).json({ error: 'Campaign not found' });
  return res.json({ data: { ...publicCampaign(record), results: attributedCounts(record.sourceTag) } });
});

const campaignPatchSchema = z.object({
  name: z.string().trim().min(3).max(160).optional(),
  businessLine: z.enum(BUSINESS_LINES).optional(),
  objective: z.string().trim().min(3).max(600).optional(),
  creativeId: z.string().uuid().nullable().optional(),
  destinationUrl: z.string().trim().min(1).max(1000).optional(),
  placement: z.enum(PLACEMENTS).optional(),
  // Recorded spend (Local OS loop fix 2): integer cents ≥ 0, or null
  // to clear. Only ever what a person records — never estimated,
  // never imported. The dedicated /spend route below is the primary
  // path (it works in any campaign status); this field rides the
  // general edit for completeness.
  recordedSpendCents: z.number().int().min(0).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  ...advertiserFields,
  ...streamingFields,
});

router.patch('/ad-studio/campaigns/:id', ...staffOnly, async (req, res) => {
  if (!(await freshCampaigns(res))) return;
  const record = findCampaign(req.params.id);
  if (!record) return res.status(404).json({ error: 'Campaign not found' });
  if (req.body && 'sourceTag' in req.body) {
    return res.status(400).json({ error: 'sourceTag is server-generated and fixed for the life of the campaign' });
  }
  if (req.body && 'status' in req.body) {
    return res.status(400).json({ error: 'Use the submit / approve / pause / resume / end actions to change status' });
  }
  const parsed = campaignPatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid campaign update', details: parsed.error.flatten() });
  if (record.status === 'ACTIVE' || record.status === 'ENDED') {
    return res.status(422).json({ error: `A ${record.status} campaign cannot be edited — pause it first, or end it and build a new one` });
  }
  if (parsed.data.creativeId && !findCreative(parsed.data.creativeId)) {
    return res.status(400).json({ error: 'creativeId does not match a Media OS content record' });
  }
  const streamErr = streamingError({ ...record, ...parsed.data });
  if (streamErr) return res.status(400).json({ error: streamErr });
  if (claimGate(res, campaignCopyFields(parsed.data))) return;
  const previousSpendCents = record.recordedSpendCents ?? null;
  Object.assign(record, parsed.data, { updatedAt: new Date().toISOString() });
  await persistAdCampaign(record);
  if ('recordedSpendCents' in parsed.data && (record.recordedSpendCents ?? null) !== previousSpendCents) {
    await recordSpendEvent(req, record, previousSpendCents);
  }
  return res.json({ data: publicCampaign(record) });
});

// ─── recorded spend (Local OS loop fix 2, 2026-11-20) ──────────────

/**
 * Spend is recorded by a person, on the record, in the console —
 * never estimated and never imported from the external platforms.
 * Recording/correcting it emits AD_SPEND_RECORDED on the platform
 * feed so the change is auditable.
 */
async function recordSpendEvent(req, record, previousSpendCents) {
  await appendEvent('AD_SPEND_RECORDED', {
    source: 'ad-studio-console',
    actor: actorOf(req),
    entityType: 'AD_CAMPAIGN',
    entityId: record.id,
    details: {
      sourceTag: record.sourceTag,
      recordedSpendCents: record.recordedSpendCents ?? null,
      previousRecordedSpendCents: previousSpendCents,
    },
  });
}

const spendPatchSchema = z.object({
  recordedSpendCents: z.number().int().min(0).nullable(),
});

/**
 * Record or correct a campaign's spend. Staff-only (the same gate
 * as campaign edit) and deliberately NOT status-locked: spend is
 * usually known only after a campaign has run, so ACTIVE and ENDED
 * campaigns accept it too — the general edit above keeps its
 * pause-first rule for everything else. Advertisers never reach
 * this route (staffOnly refuses them), and their own my-campaigns
 * edit has no spend field.
 */
router.patch('/ad-studio/campaigns/:id/spend', ...staffOnly, async (req, res) => {
  if (!(await freshCampaigns(res))) return;
  const record = findCampaign(req.params.id);
  if (!record) return res.status(404).json({ error: 'Campaign not found' });
  const parsed = spendPatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid recorded spend', details: parsed.error.flatten() });
  const previousSpendCents = record.recordedSpendCents ?? null;
  record.recordedSpendCents = parsed.data.recordedSpendCents;
  record.updatedAt = new Date().toISOString();
  await persistAdCampaign(record);
  if (record.recordedSpendCents !== previousSpendCents) {
    await recordSpendEvent(req, record, previousSpendCents);
  }
  return res.json({ data: publicCampaign(record) });
});

// ─── status actions ─────────────────────────────────────────────────

async function transition(req, res, target, { owner = false } = {}) {
  if (!(await freshCampaigns(res))) return;
  const record = findCampaign(req.params.id);
  if (!record) return res.status(404).json({ error: 'Campaign not found' });
  if (target === record.status) return res.json({ data: publicCampaign(record) });
  const allowed = TRANSITIONS[record.status] || [];
  if (!allowed.includes(target)) {
    return res.status(422).json({
      error: `Cannot move a campaign from ${record.status} to ${target}`,
      allowedTransitions: allowed,
    });
  }
  record.status = target;
  record.updatedAt = new Date().toISOString();
  if (target === 'ACTIVE') {
    record.approvedById = actorIdOf(req);
    record.approvedAt = record.updatedAt;
  }
  await syncBanner(record);
  await persistAdCampaign(record);
  await appendEvent(`AD_CAMPAIGN_${target}`, {
    source: 'ad-studio-console',
    actor: actorOf(req),
    entityType: 'AD_CAMPAIGN',
    entityId: record.id,
    details: { sourceTag: record.sourceTag, ownerAction: owner },
  });
  if (target === 'PENDING_APPROVAL' || target === 'ACTIVE') {
    emitReport({
      department: 'marketing',
      type: target === 'ACTIVE' ? 'AD_CAMPAIGN_APPROVED' : 'AD_CAMPAIGN_SUBMITTED',
      title: target === 'ACTIVE' ? `Ad campaign approved & live — ${record.name}` : `Ad campaign submitted for approval — ${record.name}`,
      detail: { campaignId: record.id, name: record.name, businessLine: record.businessLine, sourceTag: record.sourceTag, destinationUrl: record.destinationUrl, placement: record.placement, actor: actorOf(req) },
      source: 'ad-studio-console',
      reference: record.sourceTag,
      eventKey: `ad-campaign:${record.id}:${target}:${record.updatedAt}`,
    });
  }
  return res.json({ data: publicCampaign(record) });
}

router.post('/ad-studio/campaigns/:id/submit', ...staffOnly, (req, res) => transition(req, res, 'PENDING_APPROVAL'));
router.post('/ad-studio/campaigns/:id/approve', ...ownerOnly, (req, res) => transition(req, res, 'ACTIVE', { owner: true }));

// ─── Flywheel Streaming Pack (owner-only loader, 2026-11-17) ────────

/**
 * The 10 Google-style streaming ads (src/data/streamingPack.js) load
 * as house campaigns under the owner's account, in PENDING_APPROVAL,
 * each under its fixed source tag — loading is idempotent by tag:
 * ads already loaded (in ANY status) are skipped, never duplicated
 * and never re-queued. The loader creates them directly in
 * PENDING_APPROVAL, the state a staff submit would produce, and
 * files the same management report a submit files — the owner's
 * approval queue is where they land, and only the owner's approve
 * action can make any of them ACTIVE. Loading is owner-only because
 * the pack is the house's own creative program, and because nothing
 * about it may bypass the approval queue.
 */
function packState() {
  return STREAMING_PACK.map((ad) => {
    const existing = store.adCampaigns.find((c) => c.sourceTag === ad.tag) || null;
    return {
      tag: ad.tag,
      name: ad.name,
      format: ad.format,
      providers: ad.providers,
      offering: ad.offering,
      destinationUrl: ad.destinationUrl,
      loaded: Boolean(existing),
      campaignId: existing ? existing.id : null,
      status: existing ? existing.status : null,
    };
  });
}

router.get('/ad-studio/streaming-pack', ...staffOnly, (req, res) => {
  const ads = packState();
  return res.json({
    data: {
      providers: STREAMING_PROVIDERS,
      formats: STREAMING_FORMATS,
      displaySizes: DISPLAY_SIZES,
      total: ads.length,
      loaded: ads.filter((a) => a.loaded).length,
      ads,
    },
  });
});

router.post('/ad-studio/streaming-pack/load', ...ownerOnly, async (req, res) => {
  const created = [];
  const skipped = [];
  for (const ad of STREAMING_PACK) {
    if (store.adCampaigns.some((c) => c.sourceTag === ad.tag)) {
      skipped.push(ad.tag);
      continue;
    }
    const now = new Date().toISOString();
    const record = {
      id: createId(),
      name: ad.name,
      businessLine: 'TOP_SPEED',
      objective: ad.objective,
      status: 'PENDING_APPROVAL',
      creativeId: null,
      destinationUrl: ad.destinationUrl,
      sourceTag: ad.tag,
      placement: 'STREAMING',
      streamingFormat: ad.format,
      streamingProviders: [...ad.providers],
      headlines: [...ad.headlines],
      descriptions: [...ad.descriptions],
      displayPath: ad.displayPath || null,
      longHeadline: ad.longHeadline || null,
      displaySizes: [...(ad.displaySizes || [])],
      bannerId: null,
      advertiserName: 'Top Speed Appliance',
      offering: ad.offering,
      // The single headline of a display ad doubles as its card
      // headline; text ads preview from the headlines array itself.
      headline: ad.format === 'DISPLAY' ? ad.headlines[0] || null : null,
      copy: ad.descriptions[0] || null,
      ctaText: ad.ctaText,
      category: ad.category || null,
      recordedSpendCents: null,
      notes: 'Flywheel Streaming Pack — loaded for owner approval. Streaming provider placement is NOT connected: approving activates the campaign in Ad Studio only; placing it on the named providers needs their ad accounts and budget (separate activation).',
      createdById: actorIdOf(req),
      approvedById: null,
      approvedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    store.adCampaigns.push(record);
    await persistAdCampaign(record);
    await appendEvent('AD_CAMPAIGN_PENDING_APPROVAL', {
      source: 'ad-studio-streaming-pack',
      actor: actorOf(req),
      entityType: 'AD_CAMPAIGN',
      entityId: record.id,
      details: { sourceTag: record.sourceTag, placement: 'STREAMING', format: ad.format, ownerAction: false },
    });
    emitReport({
      department: 'marketing',
      type: 'AD_CAMPAIGN_SUBMITTED',
      title: `Ad campaign submitted for approval — ${record.name}`,
      detail: { campaignId: record.id, name: record.name, businessLine: record.businessLine, sourceTag: record.sourceTag, destinationUrl: record.destinationUrl, placement: 'STREAMING', format: ad.format, actor: actorOf(req) },
      source: 'ad-studio-streaming-pack',
      reference: record.sourceTag,
      eventKey: `ad-campaign:${record.id}:PENDING_APPROVAL:${record.updatedAt}`,
    });
    created.push(publicCampaign(record));
  }
  return res.status(created.length ? 201 : 200).json({
    data: { created: created.map((c) => c.sourceTag), skipped, campaigns: created, pack: packState() },
  });
});
router.post('/ad-studio/campaigns/:id/resume', ...ownerOnly, (req, res) => transition(req, res, 'ACTIVE', { owner: true }));
router.post('/ad-studio/campaigns/:id/pause', ...staffOnly, (req, res) => transition(req, res, 'PAUSED'));
router.post('/ad-studio/campaigns/:id/end', ...staffOnly, (req, res) => transition(req, res, 'ENDED'));

// ─── Flywheel mini-banner display feed (public, 2026-11-16) ─────────

/**
 * The public display feed for the Flywheel mini banner that rides on
 * every customer surface. PUBLIC-SAFE BY CONSTRUCTION: it serves only
 * campaigns that are ACTIVE with placement BANNER — house campaigns
 * and approved advertiser campaigns alike — and only the fields the
 * banner renders (business name, what's advertised, headline, copy,
 * CTA, the utm-tagged destination, category, and the banner id the
 * impression/click pings use). No ACTIVE campaign → an empty list →
 * the widget renders NOTHING. There is no house filler here: the
 * pre-existing FOOTER banner seeds belong to the homepage footer slot
 * and are deliberately not part of this feed.
 *
 * Relatedness: ?category=<AD_CATEGORIES value> sorts campaigns whose
 * declared category matches the surface first; the rest follow as the
 * fallback. Exact label match only — no scoring.
 */
function displayItem(campaign) {
  return {
    id: campaign.id,
    bannerId: campaign.bannerId || null,
    ...displayFields(campaign),
    offering: campaign.offering || null,
    category: campaign.category || null,
    // Top Speed Ads click counting (2026-11-17): surfaces that render
    // the feed send clicks through this path — the endpoint counts
    // the click on the campaign's banner, then redirects to the
    // (source-tagged) destination. ctaUrl stays the direct tagged
    // destination for surfaces that link straight out.
    clickPath: `/ad-studio/click/${campaign.id}`,
  };
}

router.get('/ad-studio/display', (req, res) => {
  const category = String(req.query.category || '').trim().toUpperCase();
  const campaigns = store.adCampaigns
    .filter((c) => c.status === 'ACTIVE' && c.placement === 'BANNER')
    .sort((a, b) => {
      if (category) {
        const am = (a.category || '') === category ? 0 : 1;
        const bm = (b.category || '') === category ? 0 : 1;
        if (am !== bm) return am - bm;
      }
      return String(b.updatedAt).localeCompare(String(a.updatedAt));
    });
  // Performance counting (2026-11-17): a feed serve IS an impression
  // of every placement it carries — counted raw, once per serve, on
  // the linked banner counters (the same counters the banner event
  // pings use). Surfaces rendering this feed no longer ping
  // impressions themselves, so a serve is never double-counted.
  for (const campaign of campaigns) {
    if (campaign.bannerId) void bumpBannerCounter(campaign.bannerId, 'impressions');
  }
  return res.json({ data: campaigns.map(displayItem) });
});

/**
 * Click-through counting (public, 2026-11-17): counts the click on
 * the campaign's banner when the campaign is live, then redirects
 * to the campaign's source-tagged destination — the visitor lands
 * exactly where the direct link would have taken them. An unknown
 * id redirects to the platform home; nothing here can be aimed at
 * an arbitrary URL (the destination comes from the campaign record,
 * never from the request).
 *
 * Advertiser campaigns (2026-11-24, Ramone's directive): for an
 * EXTERNAL campaign the click ALSO records on the campaign's own
 * tracked link, and the visitor lands on the advertiser's page on
 * the platform — business details, links, and the counted onward
 * door to their website — instead of leaving straight away. House
 * campaigns redirect exactly as they always have; an advertiser
 * with no public profile falls back to the destination redirect.
 */
router.get('/ad-studio/click/:id', async (req, res) => {
  const campaign = findCampaign(req.params.id);
  if (!campaign) return res.redirect(302, 'https://topspeedserviceos.com/');
  if (campaign.status === 'ACTIVE' && campaign.placement === 'BANNER' && campaign.bannerId) {
    await bumpBannerCounter(campaign.bannerId, 'clicks');
  }
  if (campaign.businessLine === 'EXTERNAL' && campaign.createdById) {
    try {
      const link = await recordCampaignLinkClick(campaign, { surface: 'display-feed' });
      const profile = findProfileByUserId(campaign.createdById);
      if (link && profile && profile.isPublic) {
        const web = process.env.PUBLIC_WEB_BASE || 'https://topspeedserviceos.com';
        const target = new URL(`${web}/advertiser/${profile.slug}`);
        target.searchParams.set('utm_source', 'top-speed-display');
        target.searchParams.set('utm_medium', 'advertiser-link');
        target.searchParams.set('utm_campaign', campaign.sourceTag);
        target.searchParams.set('ts_link', link.code);
        target.searchParams.set('ts_via', 'display');
        return res.redirect(302, target.toString());
      }
    } catch (error) {
      console.error('advertiser click routing failed', error?.message || error);
    }
  }
  return res.redirect(302, taggedUrl(campaign.destinationUrl, campaign.sourceTag));
});

// ─── Advertiser self-serve (Advertiser Console, 2026-11-16) ─────────

/**
 * Flywheel advertiser accounts manage THEIR OWN campaigns here. An
 * advertiser account is a business account: it self-registers with the
 * ADVERTISER role and starts UNVERIFIED under Speedy Verify (see
 * services/speedyVerify.js) — the Master issues its access code before
 * its first sign-in, exactly like commercial / PM accounts.
 *
 * Ownership is the campaign's createdById: an advertiser sees, edits,
 * submits and pauses only campaigns they created (anything else is a
 * 404 — other advertisers' campaigns are not even revealed). Campaigns
 * are always businessLine EXTERNAL + placement BANNER. The status
 * machine is Ad Studio's own: DRAFT → PENDING_APPROVAL → ACTIVE is
 * reached ONLY through the owner-tier approve in Ad Studio above (an
 * advertiser can never activate, resume, or approve anything); the
 * owner ending a pending review is the rejection path (ENDED, never
 * approved). Submissions land in the same store.adCampaigns the staff
 * list and the Turbo Boss decision queue read, so an advertiser's
 * PENDING_APPROVAL campaign surfaces there with no extra wiring.
 */
const advertiserOnly = [authenticate, requireRole(ROLES.ADVERTISER)];

function findOwnCampaign(req) {
  const ownerId = actorIdOf(req);
  if (!ownerId) return null;
  const record = findCampaign(req.params.id);
  return record && record.createdById === ownerId ? record : null;
}

function myCampaignView(record) {
  const banner = record.bannerId ? store.banners.find((b) => b.id === record.bannerId) : null;
  return {
    ...publicCampaign(record),
    // Real counters only: the linked banner's recorded impressions and
    // clicks (zero until the campaign has run). Nothing is estimated.
    stats: {
      impressions: banner ? banner.impressions || 0 : 0,
      clicks: banner ? banner.clicks || 0 : 0,
    },
    wasApproved: Boolean(record.approvedAt),
  };
}

router.get('/ad-studio/my-campaigns', ...advertiserOnly, (req, res) => {
  const ownerId = actorIdOf(req);
  const items = store.adCampaigns
    .filter((c) => ownerId && c.createdById === ownerId)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return res.json({ data: items.map(myCampaignView) });
});

const advertiserCreateSchema = z.object({
  name: z.string().trim().min(3).max(160),
  advertiserName: z.string().trim().min(2).max(120),
  offering: z.string().trim().min(3).max(200),
  headline: z.string().trim().min(3).max(120).optional(),
  copy: z.string().trim().max(400).nullable().optional(),
  ctaText: z.string().trim().min(2).max(60).optional(),
  destinationUrl: z.string().trim().min(1).max(1000),
  category: z.enum(AD_CATEGORIES).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  // E3 (2026-11-20): one of the advertiser's own uploaded creatives
  // (AdvertiserCreative id). Ownership is checked in the handlers —
  // another advertiser's upload id is a 400, never attached.
  creativeUploadId: z.string().uuid().nullable().optional(),
});

/** The served URL of an uploaded creative (public only while ACTIVE). */
function creativeImageUrl(id) {
  return `/api/v1/ad-studio/creatives/${id}/image`;
}

/** Resolve an advertiser's own uploaded creative, or null. */
function findOwnCreative(req, id) {
  if (!id) return null;
  const ownerId = actorIdOf(req);
  if (!ownerId) return null;
  return store.advertiserCreatives.find((c) => c.id === id && c.ownerId === ownerId) || null;
}

router.post('/ad-studio/my-campaigns', ...advertiserOnly, requirePlanFeature('campaigns'), async (req, res) => {
  const parsed = advertiserCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid campaign', details: parsed.error.flatten() });
  if (claimGate(res, campaignCopyFields(parsed.data))) return;
  // Plan campaign cap (Flywheel Advertiser Plans, 2026-11-17): the
  // effective plan's maxCampaigns counts the advertiser's campaigns
  // that have not ended. Grandfathered accounts are unlimited —
  // exactly the access they have always had.
  const access = req.planAccess;
  if (access && !access.bypass && access.maxCampaigns != null) {
    const ownerId = actorIdOf(req);
    const live = store.adCampaigns.filter((c) => c.createdById === ownerId && c.status !== 'ENDED').length;
    if (live >= access.maxCampaigns) {
      return res.status(403).json({
        error: 'plan_limit_reached',
        message: `Your ${access.plan ? `${access.plan.name} ` : ''}plan allows up to ${access.maxCampaigns} campaign(s) at a time — end one, or upgrade in Plans & Billing in the Advertiser Console.`,
        upgradeUrl: '/advertiser',
      });
    }
  }
  // E3: an attached upload must be the advertiser's own.
  let creativeUpload = null;
  if (parsed.data.creativeUploadId) {
    creativeUpload = findOwnCreative(req, parsed.data.creativeUploadId);
    if (!creativeUpload) return res.status(400).json({ error: 'That creative image is not in your library' });
  }
  const now = new Date().toISOString();
  const record = {
    id: createId(),
    name: parsed.data.name,
    businessLine: 'EXTERNAL',
    // The objective of an advertiser campaign is the offering itself.
    objective: parsed.data.offering,
    status: 'DRAFT',
    creativeId: null,
    creativeUploadId: creativeUpload ? creativeUpload.id : null,
    imageUrl: creativeUpload ? creativeImageUrl(creativeUpload.id) : null,
    destinationUrl: parsed.data.destinationUrl,
    sourceTag: generateSourceTag(parsed.data.name),
    placement: 'BANNER',
    bannerId: null,
    advertiserName: parsed.data.advertiserName,
    offering: parsed.data.offering,
    headline: parsed.data.headline || null,
    copy: parsed.data.copy || null,
    ctaText: parsed.data.ctaText || null,
    category: parsed.data.category || null,
    recordedSpendCents: null,
    notes: parsed.data.notes || null,
    createdById: actorIdOf(req),
    approvedById: null,
    approvedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  store.adCampaigns.push(record);
  await persistAdCampaign(record);
  // Advertiser tracked links (2026-11-24): the new campaign gets its
  // tracked link, and the account its public profile + master link,
  // from the moment it exists. Best-effort by design — link
  // generation must never fail a campaign creation; the hydration
  // backfill in db/advertiserLinksRepo.js repairs any miss.
  try {
    await ensureCampaignLink(record);
    await ensureAdvertiserTracking({ id: record.createdById, email: req.user?.email || null });
  } catch (error) {
    console.error('advertiser tracking ensure failed', error?.message || error);
  }
  await appendEvent('AD_CAMPAIGN_CREATED', {
    source: 'advertiser-console',
    actor: actorOf(req),
    entityType: 'AD_CAMPAIGN',
    entityId: record.id,
    details: { sourceTag: record.sourceTag, businessLine: record.businessLine, placement: record.placement },
  });
  return res.status(201).json({ data: myCampaignView(record) });
});

const advertiserPatchSchema = advertiserCreateSchema.partial();

router.patch('/ad-studio/my-campaigns/:id', ...advertiserOnly, requirePlanFeature('campaigns'), async (req, res) => {
  const record = findOwnCampaign(req);
  if (!record) return res.status(404).json({ error: 'Campaign not found' });
  if (req.body && ('status' in req.body || 'sourceTag' in req.body || 'businessLine' in req.body)) {
    return res.status(400).json({ error: 'Status, sourceTag and business line cannot be edited' });
  }
  // Locked while in review (the team is reading this exact text),
  // while live (pause first), and once ended.
  if (record.status !== 'DRAFT' && record.status !== 'PAUSED') {
    return res.status(422).json({ error: `A ${record.status} campaign cannot be edited` });
  }
  const parsed = advertiserPatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid campaign update', details: parsed.error.flatten() });
  if (claimGate(res, campaignCopyFields(parsed.data))) return;
  // E3: a creative change must reference the advertiser's own upload.
  let patchCreative;
  if (parsed.data.creativeUploadId) {
    patchCreative = findOwnCreative(req, parsed.data.creativeUploadId);
    if (!patchCreative) return res.status(400).json({ error: 'That creative image is not in your library' });
  }
  Object.assign(record, parsed.data, { updatedAt: new Date().toISOString() });
  if (parsed.data.offering) record.objective = parsed.data.offering;
  if ('creativeUploadId' in parsed.data) {
    if (patchCreative) {
      record.creativeUploadId = patchCreative.id;
      record.imageUrl = creativeImageUrl(patchCreative.id);
    } else {
      // Explicit detach: clear the upload and its served URL (an
      // imageUrl the office set any other way is never touched —
      // advertiser records only ever carry creative URLs here).
      record.creativeUploadId = null;
      if (record.imageUrl && record.imageUrl.startsWith('/api/v1/ad-studio/creatives/')) record.imageUrl = null;
    }
  }
  await persistAdCampaign(record);
  return res.json({ data: myCampaignView(record) });
});

router.post('/ad-studio/my-campaigns/:id/submit', ...advertiserOnly, requirePlanFeature('campaigns'), async (req, res) => {
  const record = findOwnCampaign(req);
  if (!record) return res.status(404).json({ error: 'Campaign not found' });
  if (record.status !== 'DRAFT') {
    return res.status(422).json({ error: `Cannot submit a campaign from ${record.status}`, allowedTransitions: TRANSITIONS[record.status] || [] });
  }
  record.status = 'PENDING_APPROVAL';
  record.updatedAt = new Date().toISOString();
  await persistAdCampaign(record);
  await appendEvent('AD_CAMPAIGN_PENDING_APPROVAL', {
    source: 'advertiser-console',
    actor: actorOf(req),
    entityType: 'AD_CAMPAIGN',
    entityId: record.id,
    details: { sourceTag: record.sourceTag, ownerAction: false },
  });
  emitReport({
    department: 'marketing',
    type: 'AD_CAMPAIGN_SUBMITTED',
    title: `Ad campaign submitted for approval — ${record.name}`,
    detail: { campaignId: record.id, name: record.name, businessLine: record.businessLine, advertiserName: record.advertiserName, sourceTag: record.sourceTag, destinationUrl: record.destinationUrl, placement: record.placement, actor: actorOf(req) },
    source: 'advertiser-console',
    reference: record.sourceTag,
    eventKey: `ad-campaign:${record.id}:PENDING_APPROVAL:${record.updatedAt}`,
  });
  return res.json({ data: myCampaignView(record) });
});

router.post('/ad-studio/my-campaigns/:id/pause', ...advertiserOnly, async (req, res) => {
  const record = findOwnCampaign(req);
  if (!record) return res.status(404).json({ error: 'Campaign not found' });
  if (record.status !== 'ACTIVE') {
    return res.status(422).json({ error: `Cannot pause a campaign from ${record.status}`, allowedTransitions: TRANSITIONS[record.status] || [] });
  }
  record.status = 'PAUSED';
  record.updatedAt = new Date().toISOString();
  await syncBanner(record);
  await persistAdCampaign(record);
  await appendEvent('AD_CAMPAIGN_PAUSED', {
    source: 'advertiser-console',
    actor: actorOf(req),
    entityType: 'AD_CAMPAIGN',
    entityId: record.id,
    details: { sourceTag: record.sourceTag, ownerAction: false },
  });
  return res.json({ data: myCampaignView(record) });
});

// ─── Advertiser results dashboard (E2, 2026-11-20) ──────────────────

/**
 * The advertiser-facing twin of the staff results view: an advertiser
 * sees ONLY their own campaigns (createdById === their account id —
 * the same ownership rule as my-campaigns; another advertiser's
 * campaign never appears, not even as an aggregate). Every number is
 * a raw recorded count: impressions and clicks from the linked
 * banner's counters, leads from the same first-touch attribution the
 * staff Attribution view counts (bookings + enquiries carrying the
 * campaign's sourceTag). Nothing is estimated, projected or compared
 * against anyone else. Gated by the plan system's 'attribution'
 * feature — the Flywheel feature whose label is exactly this view
 * ("Attribution view — which ads bring bookings").
 */
router.get('/ad-studio/my-results', ...advertiserOnly, requirePlanFeature('attribution'), (req, res) => {
  const ownerId = actorIdOf(req);
  const rows = store.adCampaigns
    .filter((c) => ownerId && c.createdById === ownerId)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .map((record) => {
      const banner = record.bannerId ? store.banners.find((b) => b.id === record.bannerId) : null;
      const impressions = banner ? banner.impressions || 0 : 0;
      const clicks = banner ? banner.clicks || 0 : 0;
      return {
        id: record.id,
        name: record.name,
        status: record.status,
        sourceTag: record.sourceTag,
        impressions,
        clicks,
        ctr: impressions > 0 ? clicks / impressions : null,
        leads: attributedCounts(record.sourceTag),
        wasApproved: Boolean(record.approvedAt),
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      };
    });
  const totals = rows.reduce(
    (acc, row) => ({
      campaigns: acc.campaigns + 1,
      active: acc.active + (row.status === 'ACTIVE' ? 1 : 0),
      impressions: acc.impressions + row.impressions,
      clicks: acc.clicks + row.clicks,
      leads: {
        bookings: acc.leads.bookings + row.leads.bookings,
        connections: acc.leads.connections + row.leads.connections,
        total: acc.leads.total + row.leads.total,
      },
    }),
    { campaigns: 0, active: 0, impressions: 0, clicks: 0, leads: { bookings: 0, connections: 0, total: 0 } },
  );
  return res.json({
    data: {
      campaigns: rows,
      totals,
      counting: {
        impressions: 'Counted by the banner system each time the display feed serves the campaign — one per serve, the same counters the team sees.',
        clicks: 'Real clicks on the banner, counted before the redirect to the campaign destination.',
        leads: 'Bookings and enquiries whose intake carried this campaign\u2019s tag (utm_campaign / via) — first-touch attribution, all time. Zero until a tagged visit turns into a booking or enquiry.',
      },
    },
  });
});

// ─── Advertiser overview: plan + recorded results (Upgrade #8, 2026-11-23) ───

/**
 * GET /ad-studio/my-overview — the per-advertiser results view's data.
 *
 * Unlike my-results (the plan-gated Attribution view), this view is
 * open to EVERY signed-in advertiser: their own plan state, their own
 * campaigns, and the figures the office has RECORDED — nothing else.
 * Scoping is the my-campaigns ownership rule (createdById === the
 * caller's account id); another advertiser's campaign never appears,
 * not even inside a total. Spend is AdCampaign.recordedSpendCents —
 * staff-recorded only, read through adOutcomes' recordedCostCents —
 * and outcomes are campaignOutcomeReport rows filtered to the
 * caller's own campaign ids (leads / won / money actually collected).
 * A campaign with no recorded spend reports recordedSpendCents null
 * with spendStatus NO_COST_RECORDED; an advertiser with no campaigns
 * gets empty arrays and hasRecordedResults:false — the console
 * renders the honest empty states from exactly these fields.
 */
router.get('/ad-studio/my-overview', ...advertiserOnly, async (req, res, next) => {
  try {
    const ownerId = actorIdOf(req);
    const access = await resolveAccess(req.user);
    const mine = store.adCampaigns
      .filter((c) => ownerId && c.createdById === ownerId)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    const myIds = new Set(mine.map((c) => c.id));
    const report = campaignOutcomeReport({ days: 365 });
    const outcomeById = new Map(
      (report.rows || []).filter((r) => myIds.has(r.campaignId)).map((r) => [r.campaignId, r]),
    );
    const campaigns = mine.map((record) => {
      const outcome = outcomeById.get(record.id) || null;
      const recordedSpendCents = recordedCostCents(record);
      return {
        id: record.id,
        name: record.name,
        status: record.status,
        sourceTag: record.sourceTag,
        recordedSpendCents,
        spendStatus: recordedSpendCents == null ? 'NO_COST_RECORDED' : 'RECORDED',
        outcomes: outcome
          ? {
              leads: outcome.leads ?? 0,
              won: outcome.won ?? 0,
              wonCollectedCents: outcome.wonCollectedCents ?? 0,
              costPerWonCents: outcome.cost?.perWonCents ?? null,
            }
          : { leads: 0, won: 0, wonCollectedCents: 0, costPerWonCents: null },
        wasApproved: Boolean(record.approvedAt),
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      };
    });
    const recorded = campaigns.filter((c) => c.recordedSpendCents != null);
    return res.json({
      data: {
        access: publicAccess(access),
        plan: access?.plan ? publicPlan(access.plan) : null,
        campaigns,
        totals: {
          campaigns: campaigns.length,
          recordedSpendCents: recorded.length
            ? recorded.reduce((sum, c) => sum + c.recordedSpendCents, 0)
            : null,
          won: campaigns.reduce((sum, c) => sum + (c.outcomes?.won || 0), 0),
          wonCollectedCents: campaigns.reduce((sum, c) => sum + (c.outcomes?.wonCollectedCents || 0), 0),
        },
        outcomesWindowDays: report.windowDays,
        hasRecordedResults: recorded.length > 0
          || campaigns.some((c) => (c.outcomes?.won || 0) > 0 || (c.outcomes?.leads || 0) > 0),
        note: 'Results are recorded by the Top Speed office from platform reports. Nothing here is estimated or projected.',
      },
    });
  } catch (error) {
    return next(error);
  }
});

// ─── Office approval queue (Upgrade #8, 2026-11-23) ────────────────

/**
 * GET /ad-studio/approval-queue — the office's single creative
 * approval queue. ONE queue, every lane: Flywheel advertiser-console
 * submissions (my-campaigns submit), Pepper Lists seller ads
 * (routes/pepperListsAds.js) and staff drafts all land as AdCampaign
 * rows in PENDING_APPROVAL in the same store, and this is the
 * office's read of exactly those rows — the same records the Ad
 * Studio campaign list shows, with the lane each submission arrived
 * through. Nothing leaves this queue except through the owner-only
 * approve route (PENDING_APPROVAL → ACTIVE); there is no other path
 * from an advertiser submission to a live campaign.
 */
router.get('/ad-studio/approval-queue', ...staffOnly, async (req, res) => {
  if (!(await freshCampaigns(res))) return;
  const items = store.adCampaigns
    .filter((c) => c.status === 'PENDING_APPROVAL')
    .sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)))
    .map((record) => ({
      ...publicCampaign(record),
      lane: record.category === 'PEPPER_LISTS' ? 'PEPPER_LISTS' : record.businessLine === 'EXTERNAL' ? 'ADVERTISER_CONSOLE' : 'STAFF',
      submittedById: record.createdById ?? null,
    }));
  return res.json({ data: { items, counts: { pending: items.length } } });
});

// ─── Advertiser creative uploads (E3, 2026-11-20) ───────────────────

/**
 * An advertiser's own creative library. Uploads arrive as data URLs
 * and pass the platform's image discipline: JPEG/PNG/WebP only, the
 * declared type must match the file's magic bytes (assertImageDataUrl
 * — the same check Speedy photo diagnosis uses), 6 MB cap (the
 * ReviewMedia photo cap). Bytes are stored raw on the
 * AdvertiserCreative row; the owner reads them back through the gated
 * route below, and the public route serves a creative ONLY while it
 * is attached to an ACTIVE campaign (the ReviewMedia public rule:
 * bytes are public only for live content). Uploading never publishes
 * anything: the image reaches an audience only when a campaign using
 * it is approved by the owner and goes ACTIVE, through the existing
 * approval flow.
 */
const CREATIVE_MAX_BYTES = 6 * 1024 * 1024;

/** Width/height from the file header; nulls when unparseable — never invented. */
function imageDimensions(bytes, mimeType) {
  try {
    if (mimeType === 'image/png' && bytes.length >= 24) {
      return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    }
    if (mimeType === 'image/webp' && bytes.length >= 21) {
      const form = bytes.toString('ascii', 12, 16);
      if (form === 'VP8 ' && bytes.length >= 30) {
        return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
      }
      if (form === 'VP8L' && bytes.length >= 25) {
        const bits = bytes.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
      if (form === 'VP8X' && bytes.length >= 30) {
        return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
      }
      return { width: null, height: null };
    }
    if (mimeType === 'image/jpeg') {
      let off = 2;
      while (off + 9 < bytes.length) {
        if (bytes[off] !== 0xff) { off += 1; continue; }
        const marker = bytes[off + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue; }
        const len = bytes.readUInt16BE(off + 2);
        if (len < 2) break;
        const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isSof) return { height: bytes.readUInt16BE(off + 5), width: bytes.readUInt16BE(off + 7) };
        off += 2 + len;
      }
    }
  } catch { /* a header we cannot read simply has no dimensions */ }
  return { width: null, height: null };
}

function creativeView(record) {
  const attached = store.adCampaigns
    .filter((c) => c.creativeUploadId === record.id && c.createdById === record.ownerId)
    .map((c) => ({ id: c.id, name: c.name, status: c.status }));
  return {
    id: record.id,
    name: record.name,
    mimeType: record.mimeType,
    sizeBytes: record.sizeBytes,
    width: record.width ?? null,
    height: record.height ?? null,
    createdAt: record.createdAt,
    imagePath: `/ad-studio/my-creatives/${record.id}/image`,
    attachedCampaigns: attached,
  };
}

const creativeUploadSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  imageDataUrl: z.string().min(32).max(9_000_000),
});

router.post('/ad-studio/my-creatives', ...advertiserOnly, requirePlanFeature('campaigns'), async (req, res) => {
  const parsed = creativeUploadSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid creative upload', details: parsed.error.flatten() });
  const match = /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(parsed.data.imageDataUrl.trim());
  if (!match) return res.status(400).json({ error: 'Send the image as a JPEG, PNG or WebP data URL' });
  try {
    assertImageDataUrl(parsed.data.imageDataUrl);
  } catch (error) {
    return res.status(400).json({ error: String(error?.message || error) });
  }
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length) return res.status(400).json({ error: 'That file was empty — pick another image' });
  if (bytes.length > CREATIVE_MAX_BYTES) {
    return res.status(400).json({ error: 'Creative images are capped at 6 MB — export a smaller file and try again' });
  }
  const mimeType = match[1] === 'jpg' ? 'image/jpeg' : `image/${match[1]}`;
  const dims = imageDimensions(bytes, mimeType);
  const record = {
    id: createId(),
    ownerId: actorIdOf(req),
    name: parsed.data.name || 'Uploaded creative',
    mimeType,
    sizeBytes: bytes.length,
    width: dims.width,
    height: dims.height,
    createdAt: new Date().toISOString(),
  };
  store.advertiserCreatives.push(record);
  await persistAdvertiserCreative(record, bytes);
  await appendEvent('AD_CREATIVE_UPLOADED', {
    source: 'advertiser-console',
    actor: actorOf(req),
    entityType: 'AD_CREATIVE',
    entityId: record.id,
    details: { mimeType, sizeBytes: bytes.length, width: dims.width, height: dims.height },
  });
  return res.status(201).json({ data: creativeView(record) });
});

router.get('/ad-studio/my-creatives', ...advertiserOnly, (req, res) => {
  const ownerId = actorIdOf(req);
  const items = store.advertiserCreatives
    .filter((c) => ownerId && c.ownerId === ownerId)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return res.json({ data: items.map(creativeView) });
});

function serveCreativeBytes(res, record, bytes, cacheControl) {
  res.set({
    'Content-Type': record.mimeType || 'application/octet-stream',
    'Cache-Control': cacheControl,
    'Content-Length': bytes.length,
    'Content-Disposition': `inline; filename="creative-${record.id.slice(0, 8)}"`,
  });
  return res.end(bytes);
}

router.get('/ad-studio/my-creatives/:id/image', ...advertiserOnly, async (req, res) => {
  const record = findOwnCreative(req, req.params.id);
  if (!record) return res.status(404).json({ error: 'Creative not found' });
  const bytes = await getAdvertiserCreativeBytes(record.id);
  if (!bytes) return res.status(404).json({ error: 'Creative image not found' });
  return serveCreativeBytes(res, record, bytes, 'private, max-age=300');
});

/**
 * Public bytes for a creative attached to an ACTIVE campaign — the
 * display feed's image URL points here. Anything else (draft,
 * paused, unattached, another advertiser's) is a 404: an upload is
 * never public on its own.
 */
router.get('/ad-studio/creatives/:id/image', async (req, res) => {
  const record = store.advertiserCreatives.find((c) => c.id === req.params.id) || null;
  if (!record) return res.status(404).json({ error: 'Creative not found' });
  const live = store.adCampaigns.some((c) => c.creativeUploadId === record.id && c.status === 'ACTIVE');
  if (!live) return res.status(404).json({ error: 'Creative not found' });
  const bytes = await getAdvertiserCreativeBytes(record.id);
  if (!bytes) return res.status(404).json({ error: 'Creative image not found' });
  return serveCreativeBytes(res, record, bytes, 'public, max-age=300');
});

router.delete('/ad-studio/my-creatives/:id', ...advertiserOnly, requirePlanFeature('campaigns'), async (req, res) => {
  const record = findOwnCreative(req, req.params.id);
  if (!record) return res.status(404).json({ error: 'Creative not found' });
  const ownerId = actorIdOf(req);
  const mine = store.adCampaigns.filter((c) => c.createdById === ownerId && c.creativeUploadId === record.id);
  const blocking = mine.find((c) => c.status === 'ACTIVE' || c.status === 'PENDING_APPROVAL');
  if (blocking) {
    return res.status(409).json({
      error: `That image is attached to \u201C${blocking.name}\u201D, which is ${blocking.status === 'ACTIVE' ? 'live' : 'in review'} — pause or end the campaign, or swap its image, before deleting.`,
    });
  }
  // Drafts and paused campaigns simply detach.
  for (const campaign of mine) {
    campaign.creativeUploadId = null;
    if (campaign.imageUrl === creativeImageUrl(record.id)) campaign.imageUrl = null;
    campaign.updatedAt = new Date().toISOString();
    await persistAdCampaign(campaign);
  }
  store.advertiserCreatives = store.advertiserCreatives.filter((c) => c.id !== record.id);
  await removeAdvertiserCreative(record.id);
  await appendEvent('AD_CREATIVE_DELETED', {
    source: 'advertiser-console',
    actor: actorOf(req),
    entityType: 'AD_CREATIVE',
    entityId: record.id,
    details: { detachedFrom: mine.map((c) => c.id) },
  });
  return res.status(204).end();
});

export default router;
