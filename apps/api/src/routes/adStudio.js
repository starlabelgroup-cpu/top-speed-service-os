import { Router } from 'express';
import { z } from 'zod';
import { appendEvent, createId, store } from '../data/store.js';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { ROLES } from '../config/security.js';
import { slugify } from '../data/marketingTaxonomy.js';
import { persistAdCampaign } from '../db/adStudioRepo.js';
import { DISPLAY_SIZES, STREAMING_FORMATS, STREAMING_PACK, STREAMING_PROVIDERS } from '../data/streamingPack.js';
import { emitReport } from '../services/managementReports.js';
import { persistBanner } from '../db/bannersRepo.js';

/**
 * Ad Studio — the in-house advertising system (2026-11-14).
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
  requireRole(ROLES.MARKETING_MANAGER, ROLES.COMPANY_ADMIN, ROLES.COMPANY_OWNER, ROLES.PLATFORM_ADMIN),
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
    imageUrl: creative?.thumbnailUrl || creative?.assetUrl || null,
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
    ...streamingValues(record),
    bannerId: record.bannerId || null,
    banner: banner
      ? { id: banner.id, active: banner.active !== false, impressions: banner.impressions || 0, clicks: banner.clicks || 0 }
      : null,
    notes: record.notes || null,
    createdById: record.createdById || null,
    approvedById: record.approvedById || null,
    approvedAt: record.approvedAt || null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

// ─── campaigns ──────────────────────────────────────────────────────

router.get('/ad-studio/campaigns', ...staffOnly, (req, res) => {
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

router.get('/ad-studio/results', ...staffOnly, (req, res) => {
  const data = store.adCampaigns.map((c) => ({
    campaignId: c.id,
    name: c.name,
    sourceTag: c.sourceTag,
    status: c.status,
    ...attributedCounts(c.sourceTag),
  }));
  return res.json({ data });
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
  const parsed = campaignCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid campaign', details: parsed.error.flatten() });
  if (parsed.data.creativeId && !findCreative(parsed.data.creativeId)) {
    return res.status(400).json({ error: 'creativeId does not match a Media OS content record' });
  }
  const streamErr = streamingError({ placement: parsed.data.placement || 'NONE', ...streamingValues(parsed.data) });
  if (streamErr) return res.status(400).json({ error: streamErr });
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
    notes: parsed.data.notes || null,
    createdById: actorIdOf(req),
    approvedById: null,
    approvedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  store.adCampaigns.push(record);
  await persistAdCampaign(record);
  appendEvent('AD_CAMPAIGN_CREATED', {
    source: 'ad-studio-console',
    actor: actorOf(req),
    entityType: 'AD_CAMPAIGN',
    entityId: record.id,
    details: { sourceTag: record.sourceTag, businessLine: record.businessLine, placement: record.placement },
  });
  return res.status(201).json({ data: publicCampaign(record) });
});

router.get('/ad-studio/campaigns/:id', ...staffOnly, (req, res) => {
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
  notes: z.string().trim().max(2000).nullable().optional(),
  ...advertiserFields,
  ...streamingFields,
});

router.patch('/ad-studio/campaigns/:id', ...staffOnly, async (req, res) => {
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
  Object.assign(record, parsed.data, { updatedAt: new Date().toISOString() });
  await persistAdCampaign(record);
  return res.json({ data: publicCampaign(record) });
});

// ─── status actions ─────────────────────────────────────────────────

async function transition(req, res, target, { owner = false } = {}) {
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
  appendEvent(`AD_CAMPAIGN_${target}`, {
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
      notes: 'Flywheel Streaming Pack — loaded for owner approval. Streaming provider placement is NOT connected: approving activates the campaign in Ad Studio only; placing it on the named providers needs their ad accounts and budget (separate activation).',
      createdById: actorIdOf(req),
      approvedById: null,
      approvedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    store.adCampaigns.push(record);
    await persistAdCampaign(record);
    appendEvent('AD_CAMPAIGN_PENDING_APPROVAL', {
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
  };
}

router.get('/ad-studio/display', (req, res) => {
  const category = String(req.query.category || '').trim().toUpperCase();
  const items = store.adCampaigns
    .filter((c) => c.status === 'ACTIVE' && c.placement === 'BANNER')
    .sort((a, b) => {
      if (category) {
        const am = (a.category || '') === category ? 0 : 1;
        const bm = (b.category || '') === category ? 0 : 1;
        if (am !== bm) return am - bm;
      }
      return String(b.updatedAt).localeCompare(String(a.updatedAt));
    })
    .map(displayItem);
  return res.json({ data: items });
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
});

router.post('/ad-studio/my-campaigns', ...advertiserOnly, async (req, res) => {
  const parsed = advertiserCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid campaign', details: parsed.error.flatten() });
  const now = new Date().toISOString();
  const record = {
    id: createId(),
    name: parsed.data.name,
    businessLine: 'EXTERNAL',
    // The objective of an advertiser campaign is the offering itself.
    objective: parsed.data.offering,
    status: 'DRAFT',
    creativeId: null,
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
    notes: parsed.data.notes || null,
    createdById: actorIdOf(req),
    approvedById: null,
    approvedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  store.adCampaigns.push(record);
  await persistAdCampaign(record);
  appendEvent('AD_CAMPAIGN_CREATED', {
    source: 'advertiser-console',
    actor: actorOf(req),
    entityType: 'AD_CAMPAIGN',
    entityId: record.id,
    details: { sourceTag: record.sourceTag, businessLine: record.businessLine, placement: record.placement },
  });
  return res.status(201).json({ data: myCampaignView(record) });
});

const advertiserPatchSchema = advertiserCreateSchema.partial();

router.patch('/ad-studio/my-campaigns/:id', ...advertiserOnly, async (req, res) => {
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
  Object.assign(record, parsed.data, { updatedAt: new Date().toISOString() });
  if (parsed.data.offering) record.objective = parsed.data.offering;
  await persistAdCampaign(record);
  return res.json({ data: myCampaignView(record) });
});

router.post('/ad-studio/my-campaigns/:id/submit', ...advertiserOnly, async (req, res) => {
  const record = findOwnCampaign(req);
  if (!record) return res.status(404).json({ error: 'Campaign not found' });
  if (record.status !== 'DRAFT') {
    return res.status(422).json({ error: `Cannot submit a campaign from ${record.status}`, allowedTransitions: TRANSITIONS[record.status] || [] });
  }
  record.status = 'PENDING_APPROVAL';
  record.updatedAt = new Date().toISOString();
  await persistAdCampaign(record);
  appendEvent('AD_CAMPAIGN_PENDING_APPROVAL', {
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
  appendEvent('AD_CAMPAIGN_PAUSED', {
    source: 'advertiser-console',
    actor: actorOf(req),
    entityType: 'AD_CAMPAIGN',
    entityId: record.id,
    details: { sourceTag: record.sourceTag, ownerAction: false },
  });
  return res.json({ data: myCampaignView(record) });
});

export default router;
