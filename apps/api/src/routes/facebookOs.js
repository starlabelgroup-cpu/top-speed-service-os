import { Router } from 'express';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { ROLES } from '../config/security.js';
import {
  facebookOsAdsRepo,
  facebookOsPostsRepo,
  facebookOsSyndicationRepo,
} from '../db/facebookOsRepo.js';
import { campaignEngineRepo } from '../db/campaignEngineRepo.js';
import { DIVISIONS } from '../services/campaignFactory.js';
import {
  composePepperVisual,
  ctaLabelForLanding,
  visualLineFromCopy,
} from '../services/pepperVisual.js';
import {
  PEPPER_VISUAL_SIZES,
  campaignKeyFromVisualKey,
} from '../services/pepperVisualUrl.js';
import {
  AD_DRAFT_STATUSES,
  ADS_STREAM_FORMATS,
  ADS_STREAM_OFFERS,
  SYNDICATION_STATUSES,
  SYNDICATION_SURFACES,
  adsStream,
  createAdDraft,
  createStreamPost,
  ingestSeriesWeek,
  listSeriesInstallments,
  metaAdsState,
  pageActivity,
  publicFeed,
  queueSummary,
  todaysPosts,
  transitionStreamPost,
} from '../services/facebookOs.js';
import { ingestCityPosts } from '../services/cityPosts.js';
import { claimCheckError, findClaimViolations } from '../services/claimCheck.js';

/**
 * Top Speed Facebook OS Manager (2026-11-23) — the streaming posts +
 * advertisements system for the official Top Speed Appliance
 * Facebook Page, directed by Ramone 2026-11-23.
 *
 * Auth discipline (the 2026-11-17 auth-trap rule): this router is
 * mounted on the shared /api/v1 prefix, so the staff gate is spread
 * PER ROUTE below — never an unscoped router.use() — and every route
 * lives under this router's own /facebook-os subpath. The one public
 * route is the read-only latest-posts feed, which serves POSTED
 * records only.
 *
 * Nothing on this router publishes, enables, or funds anything:
 *  - stream posts move through their lifecycle by staff action, and
 *    POSTED requires the real facebook.com URL of a post Pepper
 *    already published behind Ramone's approval card;
 *  - ad drafts are planning records — Meta has API writes disabled
 *    on the connected account, so creating/enabling/funding happens
 *    only by Ramone in Ads Manager.
 */

const router = Router();

const facebookOsStaff = [
  authenticate,
  requireCompany,
  requireRole(
    ROLES.MARKETING_MANAGER,
    ROLES.AD_SPECIALIST,
    ROLES.COMPANY_ADMIN,
    ROLES.COMPANY_OWNER,
    ROLES.PLATFORM_ADMIN,
  ),
];

function handleServiceError(error, res, next) {
  if (error?.status) {
    return res.status(error.status).json({
      error: error.message,
      ...(error.code ? { code: error.code } : {}),
      ...(error.violations ? { violations: error.violations } : {}),
    });
  }
  return next(error);
}

function parseLimit(value, fallback, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

// ─── Public feed: POSTED posts only, Rule 1 deep links ─────────────

router.get('/facebook-os/feed', async (req, res, next) => {
  try {
    return res.json({ data: await publicFeed(parseLimit(req.query.limit, 10, 50)) });
  } catch (error) {
    return next(error);
  }
});

// ─── Public Ads stream: POSTED ad posts + standing offers ──────────
// Top Speed Ads streaming (2026-11-23): the customer-attraction
// stream — POSTED ad-format posts only, each with its real
// facebook.com URL, plus the standing offer cards (the published
// rate card + referral terms) served as data. Read-only and
// public like the feed above; it lives on this router because the
// stream is served from the Facebook OS stream tables, and the
// route is a single exact path — no gate is widened by it.

router.get('/ads-os/stream', async (req, res, next) => {
  try {
    return res.json({ data: await adsStream(parseLimit(req.query.limit, 10, 50)) });
  } catch (error) {
    return next(error);
  }
});

// ─── Public Pepper visuals: a designed graphic per in-house ad ────
// Ramone's directive (2026-11-23): every in-house Flywheel ad
// carries a Pepper image graphic. The graphic is composed on
// demand from the ad record's own fields by services/pepperVisual
// (claim-gated — a record whose strings fail the gate gets NO
// visual, and this route answers 404). Keys (services/
// pepperVisualUrl.js): offer-<key> for the standing offers,
// post-<id> for POSTED ad-format stream posts only (drafts never
// render publicly), campaign-<base64url(campaignKey)> for Campaign
// Engine registry records. ?size=landscape|square|story.

router.get('/ads-os/visual/:file', async (req, res, next) => {
  try {
    const file = String(req.params.file || '');
    if (!file.endsWith('.svg')) return res.status(404).type('text/plain').send('Not found');
    const key = file.slice(0, -'.svg'.length);
    const size = PEPPER_VISUAL_SIZES[req.query.size] ? req.query.size : 'landscape';
    let svg = null;
    if (key.startsWith('offer-')) {
      const offer = ADS_STREAM_OFFERS.find((o) => o.key === key.slice('offer-'.length));
      if (offer) {
        svg = composePepperVisual({
          kicker: 'Top Speed Offer',
          headline: offer.title,
          subline: offer.lines?.[0] || '',
          ctaLabel: offer.cta?.label || '',
          size,
        });
      }
    } else if (key.startsWith('post-')) {
      const post = await facebookOsPostsRepo.findById(key.slice('post-'.length));
      if (post && post.status === 'POSTED' && ADS_STREAM_FORMATS.includes(post.format)) {
        svg = composePepperVisual({
          kicker: 'Top Speed Ads',
          headline: String(post.title || '').replace(/^Ads:\s*/i, ''),
          subline: visualLineFromCopy(post.copy, { skipFirstLine: true }),
          size,
        });
      }
    } else if (key.startsWith('campaign-')) {
      const campaignKey = campaignKeyFromVisualKey(key);
      const record = campaignKey ? await campaignEngineRepo.findByKey(campaignKey) : null;
      if (record) {
        const divisionName = DIVISIONS.find((d) => d.key === record.division)?.name || 'Top Speed';
        svg = composePepperVisual({
          kicker: divisionName,
          headline: record.subject,
          subline: visualLineFromCopy(record.copy),
          ctaLabel: ctaLabelForLanding(record.landingBase),
          size,
          divisionKey: record.division,
        });
      }
    }
    if (!svg) return res.status(404).type('text/plain').send('No visual for this ad');
    res.set('Cache-Control', 'public, max-age=300');
    // Embedded by <img> on every customer origin — see adLibrary.js
    // (2026-11-25 CORP fix): same-origin CORP blocks the render.
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    return res.type('image/svg+xml').send(svg);
  } catch (error) {
    return next(error);
  }
});

// ─── Dashboard summary + today's post ───────────────────────────────

router.get('/facebook-os/summary', ...facebookOsStaff, async (req, res, next) => {
  try {
    return res.json({ data: await queueSummary() });
  } catch (error) {
    return next(error);
  }
});

router.get('/facebook-os/today', ...facebookOsStaff, async (req, res, next) => {
  try {
    return res.json({ data: await todaysPosts() });
  } catch (error) {
    return next(error);
  }
});

// ─── Page integration: connection + recorded Page activity ─────────

router.get('/facebook-os/meta', ...facebookOsStaff, async (req, res, next) => {
  try {
    return res.json({ data: metaAdsState() });
  } catch (error) {
    return next(error);
  }
});

router.get('/facebook-os/page-activity', ...facebookOsStaff, async (req, res, next) => {
  try {
    return res.json({ data: await pageActivity(parseLimit(req.query.limit, 20, 100)) });
  } catch (error) {
    return next(error);
  }
});

// ─── Stream queue CRUD + lifecycle ──────────────────────────────────

router.get('/facebook-os/stream', ...facebookOsStaff, async (req, res, next) => {
  try {
    const rows = await facebookOsPostsRepo.list({
      status: req.query.status || undefined,
      seriesKey: req.query.seriesKey || undefined,
      limit: parseLimit(req.query.limit, 200, 500),
    });
    return res.json({ data: rows });
  } catch (error) {
    return next(error);
  }
});

router.post('/facebook-os/stream', ...facebookOsStaff, async (req, res, next) => {
  try {
    const row = await createStreamPost(req.body || {}, req.user.id);
    return res.status(201).json({ data: row });
  } catch (error) {
    return handleServiceError(error, res, next);
  }
});

router.get('/facebook-os/stream/:id', ...facebookOsStaff, async (req, res, next) => {
  try {
    const row = await facebookOsPostsRepo.findById(req.params.id);
    if (!row) return res.status(404).json({ error: 'Stream post not found', code: 'POST_NOT_FOUND' });
    return res.json({ data: row });
  } catch (error) {
    return next(error);
  }
});

router.patch('/facebook-os/stream/:id', ...facebookOsStaff, async (req, res, next) => {
  try {
    const existing = await facebookOsPostsRepo.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Stream post not found', code: 'POST_NOT_FOUND' });
    if (existing.status === 'POSTED') {
      return res.status(409).json({
        error: 'A POSTED record is the Page\'s history — it cannot be edited, only archived',
        code: 'POSTED_IMMUTABLE',
      });
    }
    // Claim-check gate (Flywheel Item 6): edited copy passes the
    // same gate as newly created queue posts.
    if (req.body && (req.body.title !== undefined || req.body.copy !== undefined)) {
      const violations = findClaimViolations([
        ['title', req.body.title !== undefined ? req.body.title : existing.title],
        ['copy', req.body.copy !== undefined ? req.body.copy : existing.copy],
      ]);
      if (violations.length) throw claimCheckError(violations);
    }
    const row = await facebookOsPostsRepo.update(req.params.id, req.body || {}, req.user.id);
    return res.json({ data: row });
  } catch (error) {
    return next(error);
  }
});

router.post('/facebook-os/stream/:id/transition', ...facebookOsStaff, async (req, res, next) => {
  try {
    const { toStatus, facebookUrl, facebookPostId, scheduledFor, statusNote } = req.body || {};
    const row = await transitionStreamPost(
      req.params.id,
      toStatus,
      { facebookUrl, facebookPostId, scheduledFor, statusNote },
      req.user.id,
    );
    return res.json({ data: row });
  } catch (error) {
    return handleServiceError(error, res, next);
  }
});

// ─── Series: Top Speed Posts by Pepper ingestion + installments ────

router.post('/facebook-os/series/ingest', ...facebookOsStaff, async (req, res, next) => {
  try {
    const result = await ingestSeriesWeek(req.body || {}, req.user.id);
    return res.status(201).json({ data: result });
  } catch (error) {
    return handleServiceError(error, res, next);
  }
});

// ─── City posts: one City Spotlight draft per verified page ────────
// The generator (services/cityPostGenerator.js) builds one draft per
// page in the verified published-pages list; the loader is
// idempotent per page (keyed by the page's canonical URL), so
// re-running adds 0. Drafts only — publishing is unchanged.

router.post('/facebook-os/city-posts/ingest', ...facebookOsStaff, async (req, res, next) => {
  try {
    const result = await ingestCityPosts(req.user.id);
    return res.status(201).json({ data: result });
  } catch (error) {
    return handleServiceError(error, res, next);
  }
});

router.get('/facebook-os/series', ...facebookOsStaff, async (req, res, next) => {
  try {
    const seriesKey = req.query.seriesKey || 'top-speed-posts-by-pepper';
    return res.json({ data: await listSeriesInstallments(seriesKey) });
  } catch (error) {
    return next(error);
  }
});

// ─── Facebook Ads drafts (planning records only) ────────────────────

router.get('/facebook-os/ads', ...facebookOsStaff, async (req, res, next) => {
  try {
    const rows = await facebookOsAdsRepo.list({
      status: req.query.status || undefined,
      limit: parseLimit(req.query.limit, 200, 500),
    });
    return res.json({ data: rows });
  } catch (error) {
    return next(error);
  }
});

router.post('/facebook-os/ads', ...facebookOsStaff, async (req, res, next) => {
  try {
    const row = await createAdDraft(req.body || {}, req.user.id);
    return res.status(201).json({ data: row });
  } catch (error) {
    return handleServiceError(error, res, next);
  }
});

router.get('/facebook-os/ads/:id', ...facebookOsStaff, async (req, res, next) => {
  try {
    const row = await facebookOsAdsRepo.findById(req.params.id);
    if (!row) return res.status(404).json({ error: 'Ad draft not found', code: 'AD_DRAFT_NOT_FOUND' });
    return res.json({ data: row });
  } catch (error) {
    return next(error);
  }
});

router.patch('/facebook-os/ads/:id', ...facebookOsStaff, async (req, res, next) => {
  try {
    const existing = await facebookOsAdsRepo.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Ad draft not found', code: 'AD_DRAFT_NOT_FOUND' });
    if (req.body?.status && !AD_DRAFT_STATUSES.includes(req.body.status)) {
      return res.status(400).json({
        error: `Unknown ad draft status: ${req.body.status} — drafts here are DRAFT, PAUSED or ARCHIVED; enabling happens only in Ads Manager`,
        code: 'STATUS_INVALID',
      });
    }
    const row = await facebookOsAdsRepo.update(req.params.id, req.body || {}, req.user.id);
    return res.json({ data: row });
  } catch (error) {
    return next(error);
  }
});

// ─── Syndication: post × surface × deep link ────────────────────────

router.get('/facebook-os/syndication', ...facebookOsStaff, async (req, res, next) => {
  try {
    const rows = await facebookOsSyndicationRepo.list({
      postId: req.query.postId || undefined,
      surface: req.query.surface || undefined,
      status: req.query.status || undefined,
      limit: parseLimit(req.query.limit, 500, 1000),
    });
    return res.json({ data: { surfaces: SYNDICATION_SURFACES, rows } });
  } catch (error) {
    return next(error);
  }
});

router.post('/facebook-os/syndication', ...facebookOsStaff, async (req, res, next) => {
  try {
    const { postId, surface, deepLink, status } = req.body || {};
    if (!postId) return res.status(400).json({ error: 'Syndication needs a postId', code: 'POST_ID_REQUIRED' });
    if (!SYNDICATION_SURFACES.includes(surface)) {
      return res.status(400).json({
        error: `Unknown surface: ${surface}`,
        code: 'SURFACE_INVALID',
        surfaces: SYNDICATION_SURFACES,
      });
    }
    if (!deepLink || typeof deepLink !== 'string') {
      return res.status(400).json({
        error: 'Syndication needs the surface\'s deep link for the post (Rule 1 — never a bare homepage)',
        code: 'DEEP_LINK_REQUIRED',
      });
    }
    if (status && !SYNDICATION_STATUSES.includes(status)) {
      return res.status(400).json({ error: `Unknown syndication status: ${status}`, code: 'STATUS_INVALID' });
    }
    const post = await facebookOsPostsRepo.findById(postId);
    if (!post) return res.status(404).json({ error: 'Stream post not found', code: 'POST_NOT_FOUND' });
    if (status === 'LIVE' && post.status !== 'POSTED') {
      return res.status(409).json({
        error: 'A surface can only carry a post LIVE once the post itself is POSTED with its real Facebook URL',
        code: 'POST_NOT_POSTED',
      });
    }
    const row = await facebookOsSyndicationRepo.upsert(postId, surface, { deepLink, status }, req.user.id);
    return res.status(201).json({ data: row });
  } catch (error) {
    return next(error);
  }
});

router.patch('/facebook-os/syndication/:id', ...facebookOsStaff, async (req, res, next) => {
  try {
    const existing = await facebookOsSyndicationRepo.findById(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Syndication row not found', code: 'SYNDICATION_NOT_FOUND' });
    }
    if (req.body?.status && !SYNDICATION_STATUSES.includes(req.body.status)) {
      return res.status(400).json({ error: `Unknown syndication status: ${req.body.status}`, code: 'STATUS_INVALID' });
    }
    if (req.body?.status === 'LIVE') {
      const post = await facebookOsPostsRepo.findById(existing.postId);
      if (!post || post.status !== 'POSTED') {
        return res.status(409).json({
          error: 'A surface can only carry a post LIVE once the post itself is POSTED',
          code: 'POST_NOT_POSTED',
        });
      }
    }
    const row = await facebookOsSyndicationRepo.update(req.params.id, req.body || {});
    return res.json({ data: row });
  } catch (error) {
    return next(error);
  }
});

export default router;
