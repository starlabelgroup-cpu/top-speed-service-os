import { Router } from 'express';
import { z } from 'zod';
import { store } from '../data/store.js';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { ROLES } from '../config/security.js';
import {
  bumpAdCreativeCounter,
  persistAdCreative,
  refreshAdCreatives,
} from '../db/adCreativesRepo.js';
import { adCreativeImage } from '../assets/adCreativeImages.js';
import { selectCreative, variantForFormat } from '../services/adLibrarySelect.js';
import { findClaimViolations } from '../services/claimCheck.js';
import { PEPPER_VISUAL_API_BASE, PEPPER_VISUAL_SIZES } from '../services/pepperVisualUrl.js';

/**
 * Ads Library + Streaming (2026-11-24) — Flywheel Advertising's
 * creative library and the streaming system that carries it to
 * every Top Speed surface.
 *
 * The library (AdCreative table, db/adCreativesRepo.js) is the one
 * managed registry of house image + text ads: Pepper's real-image
 * batch, the Flywheel display + text pack, and the standing Pepper
 * visual offer cards — seeded once from data/adCreativeSeeds.js,
 * every item claim-gated, every destination a real platform page
 * (booking intent lands on /book per the booking consolidation).
 *
 * Public streaming doors:
 *   GET /ads-os/slot          the next creative for a surface slot
 *                             (service/city matched, fair rotation,
 *                             impression counted on serve — the
 *                             display feed's counting discipline)
 *   GET /ads-os/slot/click/:key  click counting + redirect to the
 *                             creative's own destination, UTM-tagged
 *   GET /ads-os/img/:file     the embedded photo bytes
 *
 * Manager doors (Ad Studio → Library, staff-gated like the rest of
 * the studio): GET /ad-studio/library reads through the strict
 * refresh (the 2026-11-24 snapshot fix discipline — a failed table
 * read answers an honest 503, never a stale list), and
 * POST /ad-studio/library/:key/status flips ACTIVE/PAUSED.
 *
 * Honesty rules: a slot with no eligible creative answers
 * { data: null } and surfaces render NOTHING — no filler, no fake
 * ad. Copy can only enter the library through the seed set or a
 * future gated write path; the serve path re-runs the claim gate
 * on every candidate, so a creative whose copy ever failed the
 * gate cannot serve even if its stored status says CLEAN.
 */

const router = Router();
const staffOnly = [
  authenticate,
  requireCompany,
  requireRole(ROLES.MARKETING_MANAGER, ROLES.AD_SPECIALIST, ROLES.COMPANY_ADMIN, ROLES.COMPANY_OWNER, ROLES.PLATFORM_ADMIN),
];

const API = PEPPER_VISUAL_API_BASE;
const VARIANT_DIMS = {
  master: { width: 1600, height: 1600 },
  landscape: { width: 1200, height: 628 },
};

function copyFields(creative) {
  return [
    ['title', creative.title],
    ['headline', creative.headline],
    ['subline', creative.subline],
    ['ctaText', creative.ctaText],
  ];
}

/** Serve-time claim gate: violators are invisible to the stream. */
function serveable(creative) {
  if (!creative || creative.status !== 'ACTIVE') return false;
  if ((creative.claimStatus || 'CLEAN') !== 'CLEAN') return false;
  return findClaimViolations(copyFields(creative)).length === 0;
}

function imageFor(creative, format) {
  const variant = variantForFormat(creative, format);
  if (!variant) return null;
  if (creative.assetKind === 'MODULE') {
    return {
      url: `${API}/ads-os/img/${creative.key}-${variant}.jpg`,
      ...VARIANT_DIMS[variant],
    };
  }
  if (creative.assetKind === 'VISUAL') {
    return {
      url: `${API}/ads-os/visual/${creative.assetRef}.svg?size=${variant}`,
      ...PEPPER_VISUAL_SIZES[variant],
    };
  }
  return null;
}

function taggedDestination(creative, slot, platform) {
  try {
    const url = new URL(creative.destinationUrl);
    url.searchParams.set('utm_source', 'flywheel');
    url.searchParams.set('utm_medium', 'ads-stream');
    url.searchParams.set('utm_campaign', creative.key);
    if (slot) url.searchParams.set('ts_slot', slot);
    if (platform) url.searchParams.set('ts_platform', platform);
    return url.toString();
  } catch {
    return creative.destinationUrl;
  }
}

function publicCreative(creative, { slot = '', platform = '', format = '' } = {}) {
  const image = imageFor(creative, format);
  return {
    key: creative.key,
    kind: creative.kind,
    title: creative.title,
    headline: creative.headline || null,
    subline: creative.subline || null,
    ctaText: creative.ctaText || null,
    service: creative.serviceTag || null,
    city: creative.cityTag || null,
    imageUrl: image ? image.url : null,
    imageAlt: creative.headline || creative.title,
    width: image ? image.width : null,
    height: image ? image.height : null,
    clickUrl: `${API}/ads-os/slot/click/${creative.key}?slot=${encodeURIComponent(slot)}&platform=${encodeURIComponent(platform)}`,
    destinationUrl: creative.destinationUrl,
  };
}

// ─── Public: embedded photo bytes ─────────────────────────────────

router.get('/ads-os/img/:file', (req, res) => {
  const match = /^([a-z0-9-]+)-(master|landscape)\.jpg$/.exec(String(req.params.file || ''));
  if (!match) return res.status(404).json({ error: 'Unknown creative image', code: 'AD_IMAGE_NOT_FOUND' });
  const buffer = adCreativeImage(match[1], match[2]);
  if (!buffer) return res.status(404).json({ error: 'Unknown creative image', code: 'AD_IMAGE_NOT_FOUND' });
  res.set('Content-Type', 'image/jpeg');
  res.set('Cache-Control', 'public, max-age=86400');
  return res.send(buffer);
});

// ─── Public: the slot stream ──────────────────────────────────────

router.get('/ads-os/slot', (req, res) => {
  const slot = String(req.query.slot || '').slice(0, 60);
  const service = String(req.query.service || '').slice(0, 60);
  const city = String(req.query.city || '').slice(0, 60);
  const platform = String(req.query.platform || '').slice(0, 60);
  const format = String(req.query.format || '').slice(0, 20);
  const pool = (store.adCreatives || []).filter(serveable);
  const creative = selectCreative(pool, { service, city, format });
  res.set('Cache-Control', 'no-store');
  if (!creative) return res.json({ data: null });
  // A slot serve IS the impression (the display feed's discipline):
  // counted raw, once, on the creative's own counters — the same
  // counters the Ads OS Manager library view and the unified
  // metrics feed read.
  void bumpAdCreativeCounter(creative.key, 'served');
  return res.json({ data: publicCreative(creative, { slot, platform, format }) });
});

router.get('/ads-os/slot/click/:key', async (req, res) => {
  const creative = (store.adCreatives || []).find((c) => c.key === req.params.key);
  if (!creative) return res.redirect(302, 'https://topspeedserviceos.com/');
  if (creative.status === 'ACTIVE') {
    await bumpAdCreativeCounter(creative.key, 'clicked');
  }
  const slot = String(req.query.slot || '').slice(0, 60);
  const platform = String(req.query.platform || '').slice(0, 60);
  return res.redirect(302, taggedDestination(creative, slot, platform));
});

// ─── Manager: the library (Ad Studio) ─────────────────────────────

async function freshLibrary(res) {
  try {
    await refreshAdCreatives();
    return true;
  } catch (error) {
    console.error('ad library refresh failed', error?.message || error);
    res.status(503).json({
      error: 'The ads library could not be read from the database — no list is shown rather than a stale one',
      code: 'AD_LIBRARY_REFRESH_FAILED',
    });
    return false;
  }
}

function libraryRow(creative) {
  return {
    ...publicCreative(creative),
    assetKind: creative.assetKind,
    assetRef: creative.assetRef || null,
    formats: creative.formats || [],
    claimStatus: creative.claimStatus || 'CLEAN',
    violations: findClaimViolations(copyFields(creative)),
    status: creative.status,
    served: creative.served || 0,
    clicked: creative.clicked || 0,
    ctr: creative.served > 0 ? (creative.clicked || 0) / creative.served : null,
    updatedAt: creative.updatedAt || null,
  };
}

router.get('/ad-studio/library', ...staffOnly, async (req, res) => {
  if (!(await freshLibrary(res))) return undefined;
  const rows = (store.adCreatives || []).map(libraryRow);
  const totals = rows.reduce(
    (acc, row) => ({ served: acc.served + row.served, clicked: acc.clicked + row.clicked }),
    { served: 0, clicked: 0 },
  );
  return res.json({ data: { creatives: rows, totals } });
});

const statusSchema = z.object({ status: z.enum(['ACTIVE', 'PAUSED']) });

router.post('/ad-studio/library/:key/status', ...staffOnly, async (req, res) => {
  const parsed = statusSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'status must be ACTIVE or PAUSED', code: 'AD_LIBRARY_BAD_STATUS' });
  }
  if (!(await freshLibrary(res))) return undefined;
  const creative = (store.adCreatives || []).find((c) => c.key === req.params.key);
  if (!creative) {
    return res.status(404).json({ error: 'Unknown library creative', code: 'AD_LIBRARY_NOT_FOUND' });
  }
  creative.status = parsed.data.status;
  creative.updatedAt = new Date().toISOString();
  await persistAdCreative(creative);
  return res.json({ data: libraryRow(creative) });
});

export default router;
