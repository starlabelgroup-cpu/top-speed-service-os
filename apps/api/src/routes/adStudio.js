import { Router } from 'express';
import { z } from 'zod';
import { appendEvent, createId, store } from '../data/store.js';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { ROLES } from '../config/security.js';
import { slugify } from '../data/marketingTaxonomy.js';
import { persistAdCampaign } from '../db/adStudioRepo.js';
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

const BUSINESS_LINES = ['TOP_SPEED', 'CLEANOUT_VENTS', 'COCOCANE'];
const CAMPAIGN_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'PAUSED', 'ENDED'];
const PLACEMENTS = ['BANNER', 'NONE'];
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
};
const LINE_CTA = {
  TOP_SPEED: 'Book Service',
  CLEANOUT_VENTS: 'Book a Cleaning',
  COCOCANE: 'See the Menu',
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

function generateSourceTag(name) {
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
async function syncBanner(campaign) {
  const shouldRun = campaign.status === 'ACTIVE' && campaign.placement === 'BANNER';
  let banner = campaign.bannerId ? store.banners.find((b) => b.id === campaign.bannerId) : null;
  if (shouldRun) {
    const creative = findCreative(campaign.creativeId);
    const fields = {
      placement: 'FOOTER',
      advertiserName: LINE_LABELS[campaign.businessLine] || 'Top Speed Appliance',
      headline: (creative?.title || campaign.name).slice(0, 120),
      copy: (creative?.description || campaign.objective || '').slice(0, 400) || null,
      imageUrl: creative?.thumbnailUrl || creative?.assetUrl || null,
      ctaText: LINE_CTA[campaign.businessLine] || 'Learn More',
      ctaUrl: taggedUrl(campaign.destinationUrl, campaign.sourceTag),
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
  let items = [...store.adCampaigns].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  if (status) items = items.filter((c) => c.status === status);
  if (line) items = items.filter((c) => c.businessLine === line);
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

const campaignCreateSchema = z.object({
  name: z.string().trim().min(3).max(160),
  businessLine: z.enum(BUSINESS_LINES),
  objective: z.string().trim().min(3).max(600),
  creativeId: z.string().uuid().nullable().optional(),
  destinationUrl: z.string().trim().min(1).max(1000),
  placement: z.enum(PLACEMENTS).optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

router.post('/ad-studio/campaigns', ...staffOnly, async (req, res) => {
  const parsed = campaignCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid campaign', details: parsed.error.flatten() });
  if (parsed.data.creativeId && !findCreative(parsed.data.creativeId)) {
    return res.status(400).json({ error: 'creativeId does not match a Media OS content record' });
  }
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
    bannerId: null,
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
router.post('/ad-studio/campaigns/:id/resume', ...ownerOnly, (req, res) => transition(req, res, 'ACTIVE', { owner: true }));
router.post('/ad-studio/campaigns/:id/pause', ...staffOnly, (req, res) => transition(req, res, 'PAUSED'));
router.post('/ad-studio/campaigns/:id/end', ...staffOnly, (req, res) => transition(req, res, 'ENDED'));

export default router;
