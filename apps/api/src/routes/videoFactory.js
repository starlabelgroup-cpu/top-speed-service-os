import express from 'express';
import { appendEvent, createId, store } from '../data/store.js';
import { authenticate, optionalAuthenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { ROLES, STAFF_ROLES } from '../config/security.js';
import { findBookingByReference } from '../services/linkCenter.js';
import { persistMediaAsset, persistMediaContent } from '../db/mediaOsRepo.js';
import { getVideoBlob, persistVideoBlob } from '../db/videoFactoryRepo.js';
import { renderBeforeAfterVideo, videoFactoryStatus } from '../services/videoFactory.js';
import { slugify } from '../data/marketingTaxonomy.js';
import { jobPhotos } from './provider.js';

const router = express.Router();

/**
 * Before/after video factory (2026-11-20, E9).
 *
 * Generates a short branded MP4 from a completed job's own
 * before/after photos and files it as a Media OS DRAFT — the same
 * library and the same editorial workflow as every other content
 * record. The factory NEVER publishes: the record is born DRAFT and
 * only a human can move it through IN_REVIEW → APPROVED → SCHEDULED
 * → PUBLISHED in routes/mediaOs.js. Titles and captions carry only
 * the job's real facts (appliance, city, completion date, the
 * technician's own photo captions) — no invented claims.
 *
 * The video bytes live in the MediaVideoBlob table / store map
 * (Media OS assetUrl fields are URL strings, not byte stores) and
 * are served by the byte route below: staff can always stream it;
 * the public can stream it only once the content record is
 * PUBLISHED through the normal workflow.
 *
 * Every guard is applied per-route: this router mounts on the
 * shared /api/v1 prefix, where an unscoped router.use() gate would
 * wall every router mounted after it (the 2026-11-17 lesson).
 */

const MEDIA_ROLES = [
  ROLES.MARKETING_MANAGER,
  ROLES.AD_SPECIALIST,
  ROLES.COMPANY_ADMIN,
  ROLES.COMPANY_OWNER,
  ROLES.PLATFORM_ADMIN,
];
const mediaOnly = [authenticate, requireCompany, requireRole(...MEDIA_ROLES)];

function actorOf(req) {
  return req.user?.email || req.user?.id || 'media-os';
}

function uniqueSlug(base) {
  let slug = base;
  let n = 2;
  while (store.mediaContent.some((c) => c.slug === slug)) {
    slug = `${base}-${n}`;
    n += 1;
  }
  return slug;
}

router.get('/media-os/video-factory/status', ...mediaOnly, async (req, res) => {
  const status = await videoFactoryStatus();
  return res.json({ data: status });
});

router.post('/media-os/video-factory', ...mediaOnly, async (req, res) => {
  const key = String(req.body?.bookingId || req.body?.referenceCode || '').trim();
  if (!key) return res.status(400).json({ error: 'bookingId or referenceCode is required' });
  const booking = store.bookings.get(key) || findBookingByReference(key);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.status !== 'COMPLETED') {
    return res.status(422).json({
      error: 'Before/after videos are generated from completed jobs only',
      status: booking.status,
    });
  }
  const photos = jobPhotos(booking);
  const befores = photos.filter((p) => p.category === 'BEFORE');
  const afters = photos.filter((p) => p.category === 'AFTER');
  if (!befores.length || !afters.length) {
    return res.status(422).json({
      error: 'This job does not have both a BEFORE and an AFTER photo yet',
      beforePhotos: befores.length,
      afterPhotos: afters.length,
    });
  }
  let rendered;
  try {
    rendered = await renderBeforeAfterVideo({ booking, photos });
  } catch (error) {
    if (error?.code === 'VIDEO_FACTORY_UNAVAILABLE') {
      return res.status(503).json({ error: error.message, available: false });
    }
    console.error('video factory render failed', error?.message || error);
    return res.status(500).json({ error: 'Video rendering failed' });
  }

  const now = new Date().toISOString();
  const appliance = booking.appliance || 'Appliance';
  const city = booking.city || '';
  const title = `${appliance} repair${city ? ` in ${city}` : ''} — before & after`;
  const slug = uniqueSlug(
    slugify(`${title} ${booking.referenceCode || ''}`) || `before-after-${booking.referenceCode || 'job'}`,
  );
  const record = {
    id: createId(),
    slug,
    type: 'VIDEO',
    division: 'VIDEOS',
    title,
    description:
      `Before & after video generated from job ${booking.referenceCode || booking.id}` +
      `${city ? ` (${appliance} repair, ${city})` : ''}. ` +
      'Rendered from the job\u2019s own before/after photos. Draft — review before publishing.',
    assetUrl: null, // set to the byte route below, once the id exists
    thumbnailUrl: null,
    durationSec: rendered.durationSec,
    transcript: null,
    destinationUrl: null,
    status: 'DRAFT',
    publishAt: null,
    publishedAt: null,
    tags: [
      'before-after',
      'video-factory',
      ...(city ? [slugify(city)] : []),
      ...(appliance ? [slugify(appliance)] : []),
    ].filter(Boolean),
    createdBy: actorOf(req),
    updatedBy: actorOf(req),
    ownerId: null,
    createdAt: now,
    updatedAt: now,
  };
  record.assetUrl = `/api/v1/media-os/video-factory/${record.id}/video`;
  store.mediaContent.push(record);
  await persistMediaContent(record);
  await persistVideoBlob({ contentId: record.id, mimeType: 'video/mp4', data: rendered.data });

  const asset = {
    id: createId(),
    contentId: record.id,
    kind: 'VIDEO',
    name: `${title}.mp4`,
    url: record.assetUrl,
    rightsStatus: 'OWNED',
    rightsNote:
      `Rendered by the before/after video factory from job ${booking.referenceCode || booking.id}'s ` +
      'own before/after photos, taken by the assigned technician on the job record.',
    createdAt: now,
  };
  store.mediaAssets.push(asset);
  await persistMediaAsset(asset);

  await appendEvent('MEDIA_VIDEO_FACTORY_CREATED', {
    source: 'media-os-console',
    actor: actorOf(req),
    entityType: 'MEDIA_CONTENT',
    entityId: record.id,
    referenceCode: booking.referenceCode || null,
    details: { bookingId: booking.id, durationSec: rendered.durationSec, sizeBytes: rendered.data.length, slug },
  });

  return res.status(201).json({
    data: {
      id: record.id,
      slug: record.slug,
      title: record.title,
      status: record.status,
      assetUrl: record.assetUrl,
      durationSec: record.durationSec,
      sizeBytes: rendered.data.length,
    },
  });
});

/**
 * Stream a factory video's bytes (HTTP Range supported, like the
 * Pepper Lists review-media route). Access: any signed-in staff or
 * media role, or anyone once the content is PUBLISHED. A draft's
 * bytes are never public.
 */
router.get('/media-os/video-factory/:contentId/video', optionalAuthenticate, async (req, res) => {
  const record = store.mediaContent.find((c) => c.id === req.params.contentId);
  if (!record) return res.status(404).json({ error: 'Content not found' });
  const roles = req.user?.roles || [];
  const canStaffView = roles.some((r) => MEDIA_ROLES.includes(r) || STAFF_ROLES.includes(r));
  if (record.status !== 'PUBLISHED' && !canStaffView) {
    return res.status(404).json({ error: 'Content not found' });
  }
  const blob = await getVideoBlob(record.id);
  if (!blob) return res.status(404).json({ error: 'Video bytes not found' });
  const data = Buffer.isBuffer(blob.data) ? blob.data : Buffer.from(blob.data);
  const total = data.length;
  const range = req.headers.range;
  res.setHeader('Content-Type', blob.mimeType || 'video/mp4');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, max-age=60');
  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Math.min(Number(match[2]), total - 1) : total - 1;
      if (Number.isFinite(start) && Number.isFinite(end) && start <= end && start < total) {
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
        res.setHeader('Content-Length', end - start + 1);
        return res.end(data.subarray(start, end + 1));
      }
    }
    res.setHeader('Content-Range', `bytes */${total}`);
    return res.status(416).end();
  }
  res.setHeader('Content-Length', total);
  return res.end(data);
});

export default router;
