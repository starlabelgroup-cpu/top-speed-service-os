import { Router } from 'express';
import { z } from 'zod';
import { createId, store } from '../data/store.js';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { STAFF_ROLES } from '../config/security.js';
import { bumpBannerCounter, persistBanner } from '../db/bannersRepo.js';

/**
 * Advertiser banner system.
 * Public: the active creative set per placement (the slot streams and
 * rotates them) and the impression/click event pings.
 * Staff: create, list with counters, update, delete creatives.
 */
const router = Router();
const staffOnly = [authenticate, requireCompany, requireRole(...STAFF_ROLES)];

function publicBanner(b) {
  return {
    id: b.id,
    placement: b.placement,
    advertiserName: b.advertiserName,
    headline: b.headline,
    copy: b.copy || null,
    imageUrl: b.imageUrl || null,
    ctaText: b.ctaText || null,
    ctaUrl: b.ctaUrl,
  };
}

router.get('/marketing/banners', (req, res) => {
  const placement = String(req.query.placement || 'FOOTER').toUpperCase();
  const banners = store.banners.filter((b) => b.active && b.placement === placement).map(publicBanner);
  return res.json({ data: banners });
});

router.post('/marketing/banners/:id/event', async (req, res) => {
  const type = req.body?.type;
  if (type !== 'impression' && type !== 'click') {
    return res.status(400).json({ error: 'type must be impression or click' });
  }
  const banner = store.banners.find((b) => b.id === req.params.id);
  if (!banner) return res.status(404).json({ error: 'Banner not found' });
  await bumpBannerCounter(banner.id, type === 'impression' ? 'impressions' : 'clicks');
  return res.status(204).end();
});

const bannerSchema = z.object({
  placement: z.string().trim().max(40).optional(),
  advertiserName: z.string().trim().min(2).max(120),
  headline: z.string().trim().min(2).max(120),
  copy: z.string().trim().max(400).optional(),
  imageUrl: z.string().trim().max(500).optional(),
  ctaText: z.string().trim().max(60).optional(),
  ctaUrl: z.string().trim().url().max(500),
  active: z.boolean().optional(),
});

router.get('/marketing/banners/all', ...staffOnly, (req, res) => {
  return res.json({ data: store.banners });
});

router.post('/marketing/banners', ...staffOnly, async (req, res) => {
  const parsed = bannerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid banner', details: parsed.error.flatten() });
  }
  const now = new Date().toISOString();
  const banner = {
    id: createId(),
    placement: (parsed.data.placement || 'FOOTER').toUpperCase(),
    advertiserName: parsed.data.advertiserName,
    headline: parsed.data.headline,
    copy: parsed.data.copy || null,
    imageUrl: parsed.data.imageUrl || null,
    ctaText: parsed.data.ctaText || null,
    ctaUrl: parsed.data.ctaUrl,
    active: parsed.data.active !== false,
    impressions: 0,
    clicks: 0,
    createdAt: now,
    updatedAt: now,
  };
  store.banners.push(banner);
  await persistBanner(banner);
  return res.status(201).json({ data: banner });
});

router.patch('/marketing/banners/:id', ...staffOnly, async (req, res) => {
  const banner = store.banners.find((b) => b.id === req.params.id);
  if (!banner) return res.status(404).json({ error: 'Banner not found' });
  const parsed = bannerSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid banner update', details: parsed.error.flatten() });
  }
  Object.assign(banner, parsed.data, { updatedAt: new Date().toISOString() });
  if (parsed.data.placement) banner.placement = parsed.data.placement.toUpperCase();
  await persistBanner(banner);
  return res.json({ data: banner });
});

router.delete('/marketing/banners/:id', ...staffOnly, async (req, res) => {
  const idx = store.banners.findIndex((b) => b.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Banner not found' });
  const [removed] = store.banners.splice(idx, 1);
  try {
    const { DATABASE_ENABLED, db } = await import('../db/client.js');
    if (DATABASE_ENABLED) await db().banner.delete({ where: { id: removed.id } });
  } catch (error) {
    console.error('banner delete failed', error?.message || error);
  }
  return res.status(204).end();
});

export default router;
