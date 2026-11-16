import { Router } from 'express';
import { z } from 'zod';
import { appendEvent, createId, store } from '../data/store.js';
import { authenticate } from '../middleware/auth.js';
import { persistAdCampaign } from '../db/adStudioRepo.js';
import { emitReport } from '../services/managementReports.js';
import { generateSourceTag } from './adStudio.js';

/**
 * Pepper Lists customer advertisements (2026-11-16).
 *
 * Ramone's directive: "Inside pepper lists for customer advertisements."
 * Regular CUSTOMER accounts — the Pepper Lists audience, e.g. a seller
 * who wants to promote the products they list — submit a simple banner
 * ad from inside Pepper Lists. This is the customer counterpart of the
 * Flywheel Advertiser Console lane (routes/adStudio.js): same
 * AdCampaign store, same fields, same approval flow, narrower form.
 *
 * - POST /pepper-lists/ads — create an ad. It lands directly in
 *   PENDING_APPROVAL: the campaign is an AdCampaign with businessLine
 *   EXTERNAL, placement BANNER and category PEPPER_LISTS, so the
 *   existing Ad Studio staff list + Turbo Boss decision queue (which
 *   read every PENDING_APPROVAL campaign) pick it up unchanged, and
 *   the owner approves/rejects there exactly like an advertiser
 *   submission. NOTHING a customer submits is ever live on its own —
 *   only the owner-tier approve in Ad Studio flips it ACTIVE, and
 *   only then does GET /ad-studio/display?category=PEPPER_LISTS serve
 *   it (the feed prefers the category match, then falls back to any
 *   ACTIVE banner).
 * - GET /pepper-lists/ads/mine — the signed-in customer's own
 *   submissions with statuses, newest first. The query is scoped to
 *   createdById === the caller's id, so another customer's ads are
 *   unreachable by construction.
 *
 * Money: there is NO payment and NO pricing anywhere in this lane —
 * the platform has no ad pricing and none is invented here. An ad is
 * a submission for the owner's approval, nothing more.
 *
 * Abuse guard: a customer may hold at most MAX_LIVE_ADS campaigns that
 * are not ENDED (ENDED is the system's rejection/retirement state —
 * the owner ending a pending review is the rejection path). Beyond
 * the cap the create is refused with 429. The platform-wide general
 * rate limiter also covers these routes like every /api/v1 route.
 */
const router = Router();

const MAX_LIVE_ADS = 10;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function actorOf(req) {
  return req.user?.email || req.user?.id || 'pepper-lists-ads';
}

function actorIdOf(req) {
  const id = req.user?.id;
  return id && UUID_RE.test(id) ? id : null;
}

const ctaUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(1000)
  .refine((value) => /^https?:\/\//i.test(value) || value.startsWith('/'), {
    message: 'ctaUrl must be an http(s) URL or a site path starting with /',
  });

const createAdSchema = z.object({
  advertiserName: z.string().trim().min(2).max(60),
  headline: z.string().trim().min(3).max(90),
  copy: z.string().trim().min(3).max(240),
  ctaText: z.string().trim().min(2).max(24).optional(),
  ctaUrl: ctaUrlSchema,
});

/**
 * The customer-facing view of one of their ads: exactly what they
 * submitted, where it points, and where it stands. No other customer's
 * data can appear here — rows are only ever read through the
 * createdById scope below.
 */
function customerAdView(record) {
  return {
    id: record.id,
    advertiserName: record.advertiserName || null,
    headline: record.headline || null,
    copy: record.copy || null,
    ctaText: record.ctaText || null,
    ctaUrl: record.destinationUrl,
    category: record.category || null,
    status: record.status,
    sourceTag: record.sourceTag,
    wasApproved: Boolean(record.approvedAt),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

router.post('/pepper-lists/ads', authenticate, async (req, res) => {
  const ownerId = actorIdOf(req);
  if (!ownerId) return res.status(401).json({ error: 'Authentication required' });
  const parsed = createAdSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid ad', details: parsed.error.flatten() });
  }
  const liveCount = store.adCampaigns.filter(
    (c) => c.createdById === ownerId && c.status !== 'ENDED',
  ).length;
  if (liveCount >= MAX_LIVE_ADS) {
    return res.status(429).json({
      error: `You already have ${MAX_LIVE_ADS} ads submitted or live — wait for a review outcome before submitting more`,
    });
  }
  const now = new Date().toISOString();
  const { advertiserName, headline, copy, ctaText, ctaUrl } = parsed.data;
  const record = {
    id: createId(),
    // The staff queue reads `name`; a customer ad's name is its headline.
    name: headline,
    businessLine: 'EXTERNAL',
    // Like advertiser campaigns, the objective is the offering itself —
    // for a customer ad the offering is the headline (the display feed
    // surfaces offering, and falls back to objective for copy).
    objective: headline,
    status: 'PENDING_APPROVAL',
    creativeId: null,
    destinationUrl: ctaUrl,
    sourceTag: generateSourceTag(headline),
    placement: 'BANNER',
    bannerId: null,
    advertiserName,
    offering: headline,
    headline,
    copy,
    ctaText: ctaText || null,
    category: 'PEPPER_LISTS',
    notes: null,
    createdById: ownerId,
    approvedById: null,
    approvedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  store.adCampaigns.push(record);
  await persistAdCampaign(record);
  appendEvent('AD_CAMPAIGN_PENDING_APPROVAL', {
    source: 'pepper-lists-ads',
    actor: actorOf(req),
    entityType: 'AD_CAMPAIGN',
    entityId: record.id,
    details: { sourceTag: record.sourceTag, businessLine: record.businessLine, placement: record.placement, ownerAction: false },
  });
  emitReport({
    department: 'marketing',
    type: 'AD_CAMPAIGN_SUBMITTED',
    title: `Ad campaign submitted for approval — ${record.name}`,
    detail: { campaignId: record.id, name: record.name, businessLine: record.businessLine, advertiserName: record.advertiserName, sourceTag: record.sourceTag, destinationUrl: record.destinationUrl, placement: record.placement, actor: actorOf(req) },
    source: 'pepper-lists-ads',
    reference: record.sourceTag,
    eventKey: `ad-campaign:${record.id}:PENDING_APPROVAL:${record.updatedAt}`,
  });
  return res.status(201).json({ data: customerAdView(record) });
});

router.get('/pepper-lists/ads/mine', authenticate, (req, res) => {
  const ownerId = actorIdOf(req);
  if (!ownerId) return res.status(401).json({ error: 'Authentication required' });
  const items = store.adCampaigns
    .filter((c) => c.createdById === ownerId && c.category === 'PEPPER_LISTS')
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return res.json({ data: items.map(customerAdView) });
});

export default router;
