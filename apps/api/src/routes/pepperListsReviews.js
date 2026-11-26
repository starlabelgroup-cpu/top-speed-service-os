import { Router } from 'express';
import { z } from 'zod';
import { appendEvent, store } from '../data/store.js';
import {
  addReviewMedia,
  countReviewMedia,
  createReview,
  getReview,
  getReviewMediaItem,
  listReviewComments,
  listReviewMedia,
  listReviews,
  addReviewComment,
  updateReview,
} from '../db/reviewsRepo.js';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { STAFF_ROLES } from '../config/security.js';
import { assertImageDataUrl } from '../services/speedy.js';
import { respondToComment, respondToReview } from '../services/reviewResponder.js';
import { maybeIssueReviewReward } from '../services/topReviews.js';

/**
 * Pepper Lists Reviews (2026-11-16) — reviews of repairs, posted from
 * inside the signed-in Pepper Lists app, with Speedy as responder.
 *
 * Customer lanes (signed-in; signed-out is 401):
 * - POST /pepper-lists/reviews — write a review, optionally tied to
 *   one of the customer's own COMPLETED bookings (verified repair) and
 *   with an optional post-service survey. Speedy responds before the
 *   create returns: positive reviews publish immediately; flagged or
 *   low-rating reviews stay PENDING for the office (the customer still
 *   sees their review as posted, marked "under office review").
 * - POST /pepper-lists/reviews/:id/media — attach one photo/video
 *   (owner only; same caps + magic-byte rules as Scan & Send media).
 * - GET  /pepper-lists/reviews/mine — the customer's own reviews with
 *   status, Speedy's reply and the full comment thread.
 * - GET  /pepper-lists/reviews/my-bookings — the customer's completed
 *   bookings, for the review picker (same ownership linkage as the
 *   signed-in tracking view).
 * - POST /pepper-lists/reviews/:id/comments — comment on your own
 *   review thread; Speedy answers, and a flagged comment escalates.
 *
 * Public lane (no auth):
 * - GET /pepper-lists/reviews/public — PUBLISHED reviews only, plus an
 *   aggregate computed from real published reviews only. Media bytes
 *   are served only for media of PUBLISHED reviews.
 *
 * Staff lanes (STAFF_ROLES; customer tokens 403):
 * - GET   /pepper-lists/reviews/admin — moderation queue (default:
 *   PENDING or escalated; ?status=PENDING|ESCALATED|ALL|PUBLISHED|HIDDEN).
 * - PATCH /pepper-lists/reviews/admin/:id — publish or hide.
 * - POST  /pepper-lists/reviews/admin/:id/reply — office reply, shown
 *   to the customer as "Top Speed Appliance — Office".
 * - Media manifest + per-item bytes mirror the submissions viewer.
 */
const router = Router();

const PHOTO_MAX_BYTES = 6 * 1024 * 1024;
const VIDEO_MAX_BYTES = 15 * 1024 * 1024;
const MEDIA_MAX_ITEMS = 4;

const digits10 = (value) => String(value || '').replace(/\D/g, '').slice(-10);

/**
 * The booking ownership linkage every surface agrees on (the same
 * test as routes/bookings.js bookingBelongsToUser and the tracking
 * view's bookingsForUser): the booking's customer record carries the
 * account's userId when linked, else the account email or phone must
 * match the contact details on the booking.
 */
function bookingBelongsToUser(booking, user) {
  const record = store.users.get(user.id) || {};
  const email = String(record.email || user.email || '').toLowerCase();
  const phone = digits10(record.phone || user.phone || '');
  const c = booking.customer || {};
  if (c.userId && c.userId === user.id) return true;
  if (email && String(c.email || '').toLowerCase() === email) return true;
  if (phone && digits10(c.phone || booking.phone || '') === phone) return true;
  return false;
}

function bookingsForUser(user) {
  const record = store.users.get(user.id) || {};
  const email = String(record.email || user.email || '').toLowerCase();
  const phone = digits10(record.phone || user.phone || '');
  return [...store.bookings.values()].filter((b) => {
    const c = b.customer || {};
    if (c.userId && c.userId === user.id) return true;
    if (email && String(c.email || '').toLowerCase() === email) return true;
    if (phone && digits10(c.phone || b.phone || '') === phone) return true;
    return false;
  });
}

/**
 * Display/contact facts for a review's author. Sources, in order: the
 * account record when this process has it (skeleton mode / freshly
 * registered accounts), the CRM customer record linked to the account
 * (store.customers is hydrated from the database; Customer.userId is
 * the link), and the booking's embedded customer snapshot.
 */
function customerRecordForUser(userId) {
  return [...store.customers.values()].find((c) => c.userId === userId) || null;
}

function userDisplayParts(userId, booking) {
  const record = store.users.get(userId) || {};
  const crm = customerRecordForUser(userId);
  let first = String(record.firstName || '').trim();
  let last = String(record.lastName || '').trim();
  const fullName = [first, last].filter(Boolean).join(' ').trim()
    || String(crm?.name || booking?.customer?.name || '').trim();
  if (!first && fullName) {
    const parts = fullName.split(/\s+/);
    first = parts[0] || '';
    last = parts.slice(1).join(' ');
  }
  return {
    first,
    last,
    record,
    contact: {
      name: fullName || 'Customer',
      phone: record.phone || crm?.phone || booking?.customer?.phone || null,
      email: record.email || crm?.email || booking?.customer?.email || null,
    },
  };
}

/** "Maria G." — first name + last initial, never a full name in public. */
function publicName(userId, booking) {
  const { first, last } = userDisplayParts(userId, booking);
  if (!first) return 'Top Speed customer';
  return last ? `${first} ${last.charAt(0).toUpperCase()}.` : first;
}

function bookingSummary(booking) {
  if (!booking) return null;
  return {
    id: booking.id,
    referenceCode: booking.referenceCode || null,
    appliance: booking.appliance || null,
    city: booking.city || null,
    status: booking.status || null,
    completedAt: booking.completedAt || null,
  };
}

function reviewContext(review) {
  const booking = review.bookingId ? store.bookings.get(review.bookingId) : null;
  const { first } = userDisplayParts(review.customerId, booking);
  return {
    booking,
    firstName: first || null,
    serviceLabel: booking?.appliance ? `${booking.appliance} repair` : null,
    city: booking?.city || null,
  };
}

async function serializeReview(review, { audience }) {
  const booking = review.bookingId ? store.bookings.get(review.bookingId) : null;
  const [media, comments] = await Promise.all([
    listReviewMedia(review.id),
    listReviewComments(review.id),
  ]);
  const base = {
    id: review.id,
    rating: review.rating,
    title: review.title,
    body: review.body,
    status: review.status,
    verifiedRepair: review.verifiedRepair,
    speedyReply: review.speedyReply,
    speedyReplyAt: review.speedyReplyAt,
    speedyReplyMode: review.speedyReplyMode,
    survey: review.survey,
    createdAt: review.createdAt,
    updatedAt: review.updatedAt,
    booking: bookingSummary(booking),
    media: media.map((m) => ({ id: m.id, kind: m.kind, mimeType: m.mimeType, sizeBytes: m.sizeBytes, createdAt: m.createdAt })),
  };
  if (audience === 'public') {
    return {
      ...base,
      customerName: publicName(review.customerId, booking),
      media: base.media.map((m) => ({
        ...m,
        url: `/api/v1/pepper-lists/reviews/public/${review.id}/media/${m.id}`,
      })),
      comments: comments
        .filter((c) => c.authorKind === 'SPEEDY' || c.authorKind === 'STAFF')
        .map((c) => ({ id: c.id, authorKind: c.authorKind, body: c.body, createdAt: c.createdAt })),
    };
  }
  if (audience === 'admin') {
    const { contact } = userDisplayParts(review.customerId, booking);
    return {
      ...base,
      customerId: review.customerId,
      escalated: review.escalated,
      escalationReason: review.escalationReason,
      customer: contact,
      comments: comments.map((c) => ({ id: c.id, authorKind: c.authorKind, authorId: c.authorId, body: c.body, createdAt: c.createdAt })),
    };
  }
  // owner view
  return {
    ...base,
    escalated: review.escalated,
    comments: comments.map((c) => ({ id: c.id, authorKind: c.authorKind, body: c.body, createdAt: c.createdAt })),
  };
}

/* ------------------------------ media ------------------------------ */

function videoBytesOk(mime, head) {
  if (mime === 'video/mp4' || mime === 'video/quicktime') {
    return head.length >= 8 && head.toString('ascii', 4, 8) === 'ftyp';
  }
  if (mime === 'video/webm') {
    return head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
  }
  return false;
}

/** Same caps + magic-byte discipline as the Scan & Send media intake. */
function validateReviewMediaItem(item) {
  const mime = String(item.mime || '').split(';')[0].trim().toLowerCase();
  const bytes = Buffer.from(item.dataBase64, 'base64');
  if (!bytes.length) throw new Error('That file was empty — remove it and try again');
  if (item.kind === 'photo') {
    if (bytes.length > PHOTO_MAX_BYTES) throw new Error('A photo is over the 6 MB limit — retake it or pick a smaller one');
    const photoMime = mime === 'image/jpg' ? 'image/jpeg' : mime;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(photoMime)) {
      throw new Error('Photos must be JPEG, PNG or WebP');
    }
    assertImageDataUrl(`data:${photoMime};base64,${item.dataBase64}`); // throws on mismatched bytes
    return { kind: 'photo', mimeType: photoMime, sizeBytes: bytes.length, data: bytes };
  }
  if (bytes.length > VIDEO_MAX_BYTES) throw new Error('A video is over the 15 MB limit — keep clips short and try again');
  if (!videoBytesOk(mime, bytes)) {
    throw new Error('Videos must be real MP4, MOV or WebM clips');
  }
  return { kind: 'video', mimeType: mime, sizeBytes: bytes.length, data: bytes };
}

/** Raw bytes with Range support — the submissions viewer's discipline. */
function serveMediaBytes(req, res, row) {
  const bytes = row.data;
  const total = bytes.length;
  res.set({
    'Content-Type': row.mimeType || 'application/octet-stream',
    'Cache-Control': 'private, no-store',
    'Accept-Ranges': 'bytes',
    'Content-Disposition': `inline; filename="review-${row.kind}-${row.id.slice(0, 8)}"`,
  });
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
  if (range && (range[1] !== '' || range[2] !== '')) {
    let start = range[1] === '' ? 0 : Number(range[1]);
    let end = range[2] === '' ? total - 1 : Number(range[2]);
    if (range[1] === '') { start = Math.max(0, total - Number(range[2])); end = total - 1; }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
      res.set('Content-Range', `bytes */${total}`);
      return res.status(416).end();
    }
    end = Math.min(end, total - 1);
    res.status(206);
    res.set({ 'Content-Range': `bytes ${start}-${end}/${total}`, 'Content-Length': end - start + 1 });
    return res.end(bytes.subarray(start, end + 1));
  }
  res.set('Content-Length', total);
  return res.end(bytes);
}

/* --------------------------- public lane --------------------------- */

router.get('/pepper-lists/reviews/public', async (req, res) => {
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const published = await listReviews({ status: 'PUBLISHED' });
  const count = published.length;
  const average = count
    ? Math.round((published.reduce((sum, r) => sum + r.rating, 0) / count) * 10) / 10
    : null;
  const page = published.slice(offset, offset + limit);
  const data = [];
  for (const review of page) data.push(await serializeReview(review, { audience: 'public' }));
  return res.json({ data, aggregate: { count, average }, pagination: { limit, offset, total: count } });
});

router.get('/pepper-lists/reviews/public/:reviewId/media/:mediaId', async (req, res) => {
  const review = await getReview(req.params.reviewId);
  if (!review || review.status !== 'PUBLISHED') return res.status(404).json({ error: 'Media item not found' });
  const row = await getReviewMediaItem(review.id, req.params.mediaId);
  if (!row) return res.status(404).json({ error: 'Media item not found' });
  res.set('Cache-Control', 'public, max-age=300');
  return serveMediaBytes(req, res, row);
});

/* -------------------------- customer lanes -------------------------- */

const surveySchema = z.object({
  overall: z.number().int().min(1).max(5),
  technician: z.number().int().min(1).max(5),
  timeliness: z.number().int().min(1).max(5),
  cleanliness: z.number().int().min(1).max(5),
  recommend: z.boolean(),
  comments: z.string().trim().max(1000).optional(),
});

const createReviewSchema = z.object({
  bookingId: z.string().uuid().optional(),
  rating: z.number().int().min(1).max(5),
  title: z.string().trim().min(2).max(120),
  body: z.string().trim().min(3).max(4000),
  survey: surveySchema.optional(),
});

router.post('/pepper-lists/reviews', authenticate, async (req, res) => {
  const parsed = createReviewSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid review', details: parsed.error.flatten() });
  }
  const data = parsed.data;

  let booking = null;
  let verifiedRepair = false;
  if (data.bookingId) {
    booking = store.bookings.get(data.bookingId);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (!bookingBelongsToUser(booking, req.user)) {
      return res.status(403).json({ error: 'That booking belongs to another customer' });
    }
    if (booking.status !== 'COMPLETED') {
      return res.status(400).json({ error: 'Reviews with a survey open after the repair is completed — this booking is not completed yet' });
    }
    verifiedRepair = true;
  }

  const created = await createReview({
    companyId: req.user.companyId,
    customerId: req.user.id,
    bookingId: data.bookingId || null,
    rating: data.rating,
    title: data.title,
    body: data.body,
    survey: data.survey || null,
    verifiedRepair,
    status: 'PENDING',
  });

  // Speedy responds before the create returns; the responder never
  // throws, so a reply failure simply leaves the review PENDING for
  // the office instead of failing the customer's post.
  const { firstName, serviceLabel, city } = reviewContext(created);
  const final = await respondToReview(created, { firstName, serviceLabel, city });
  // Platform Interconnect (2026-11-19): review events join the
  // cross-platform feed at the create success point — rating and
  // publication state only, never the review text or the reviewer.
  await appendEvent('REVIEW_SUBMITTED', {
    source: 'pepper-lists',
    actor: 'customer',
    entityType: 'REVIEW',
    entityId: created.id,
    referenceCode: booking?.referenceCode || null,
    details: {
      rating: created.rating ?? null,
      verifiedRepair,
      status: final?.status || created.status || 'PENDING',
      withBooking: Boolean(data.bookingId),
    },
  });
  // Top Reviews and Rewards (2026-11-25): a verified review of a
  // completed repair earns the standard thank-you credit — any
  // rating, once per booking. Fail-soft: a reward hiccup never
  // fails the customer's post.
  if (verifiedRepair && booking) {
    try {
      await maybeIssueReviewReward(final || created, booking);
    } catch (error) {
      console.error('review reward issue failed', error?.message || error);
    }
  }
  return res.status(201).json({ data: await serializeReview(final, { audience: 'owner' }) });
});

router.get('/pepper-lists/reviews/mine', authenticate, async (req, res) => {
  const mine = await listReviews({ customerId: req.user.id });
  const data = [];
  for (const review of mine) data.push(await serializeReview(review, { audience: 'owner' }));
  return res.json({ data });
});

router.get('/pepper-lists/reviews/my-bookings', authenticate, async (req, res) => {
  const completed = bookingsForUser(req.user)
    .filter((b) => b.status === 'COMPLETED')
    .sort((a, b) => String(b.completedAt || b.createdAt).localeCompare(String(a.completedAt || a.createdAt)))
    .map((b) => ({
      id: b.id,
      referenceCode: b.referenceCode || null,
      appliance: b.appliance || null,
      city: b.city || null,
      completedAt: b.completedAt || null,
    }));
  return res.json({ data: completed });
});

const mediaItemSchema = z.object({
  kind: z.enum(['photo', 'video']),
  mime: z.string().trim().max(60),
  dataBase64: z.string().min(16).max(21_000_000),
});

async function loadOwnedReview(req, res) {
  const review = await getReview(req.params.id);
  if (!review) { res.status(404).json({ error: 'Review not found' }); return null; }
  if (review.customerId !== req.user.id) {
    res.status(403).json({ error: 'That review belongs to another customer' });
    return null;
  }
  return review;
}

router.post('/pepper-lists/reviews/:id/media', authenticate, async (req, res) => {
  const review = await loadOwnedReview(req, res);
  if (!review) return undefined;
  const parsed = mediaItemSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid media', details: parsed.error.flatten() });
  }
  const existing = await countReviewMedia(review.id);
  if (existing >= MEDIA_MAX_ITEMS) {
    return res.status(400).json({ error: `A review holds up to ${MEDIA_MAX_ITEMS} photos/videos — remove one to add another` });
  }
  let item;
  try {
    item = validateReviewMediaItem(parsed.data);
  } catch (error) {
    return res.status(400).json({ error: String(error?.message || error) });
  }
  const [saved] = await addReviewMedia(review.id, [item]);
  return res.status(201).json({ data: saved });
});

router.get('/pepper-lists/reviews/:id/media', authenticate, async (req, res) => {
  const review = await loadOwnedReview(req, res);
  if (!review) return undefined;
  const rows = await listReviewMedia(review.id);
  const metaOnly = String(req.query.meta || '') === '1';
  return res.json({
    data: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      ...(metaOnly ? {} : { dataBase64: row.data.toString('base64') }),
      createdAt: row.createdAt,
    })),
  });
});

router.get('/pepper-lists/reviews/:id/media/:mediaId', authenticate, async (req, res) => {
  const review = await loadOwnedReview(req, res);
  if (!review) return undefined;
  const row = await getReviewMediaItem(review.id, req.params.mediaId);
  if (!row) return res.status(404).json({ error: 'Media item not found' });
  return serveMediaBytes(req, res, row);
});

const commentSchema = z.object({
  body: z.string().trim().min(1).max(2000),
});

router.post('/pepper-lists/reviews/:id/comments', authenticate, async (req, res) => {
  const review = await loadOwnedReview(req, res);
  if (!review) return undefined;
  const parsed = commentSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid comment', details: parsed.error.flatten() });
  }
  await addReviewComment({ reviewId: review.id, authorId: req.user.id, authorKind: 'CUSTOMER', body: parsed.data.body });
  const { firstName } = reviewContext(review);
  await respondToComment(review, parsed.data.body, { firstName });
  const fresh = await getReview(review.id);
  return res.status(201).json({ data: await serializeReview(fresh, { audience: 'owner' }) });
});

/* ---------------------------- staff lanes ---------------------------- */

const staffGate = [authenticate, requireCompany, requireRole(...STAFF_ROLES)];

router.get('/pepper-lists/reviews/admin', ...staffGate, async (req, res) => {
  const mode = String(req.query.status || '').toUpperCase();
  let rows;
  if (mode === 'ALL') rows = await listReviews({});
  else if (mode === 'ESCALATED') rows = await listReviews({ escalatedOnly: true });
  else if (['PENDING', 'PUBLISHED', 'HIDDEN'].includes(mode)) rows = await listReviews({ status: mode });
  else {
    const [pending, escalated] = await Promise.all([
      listReviews({ status: 'PENDING' }),
      listReviews({ escalatedOnly: true }),
    ]);
    const byId = new Map();
    for (const row of [...pending, ...escalated]) byId.set(row.id, row);
    rows = [...byId.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }
  const data = [];
  for (const review of rows) data.push(await serializeReview(review, { audience: 'admin' }));
  return res.json({ data });
});

const patchSchema = z.object({
  status: z.enum(['PUBLISHED', 'HIDDEN']),
});

router.patch('/pepper-lists/reviews/admin/:id', ...staffGate, async (req, res) => {
  const parsed = patchSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid status change', details: parsed.error.flatten() });
  }
  const review = await getReview(req.params.id);
  if (!review) return res.status(404).json({ error: 'Review not found' });
  // Publishing a held review keeps Speedy's holding reply on the
  // thread — the office reply below is how a human follows it up.
  const updated = await updateReview(review.id, { status: parsed.data.status });
  return res.json({ data: await serializeReview(updated, { audience: 'admin' }) });
});

const staffReplySchema = z.object({
  body: z.string().trim().min(1).max(4000),
});

router.post('/pepper-lists/reviews/admin/:id/reply', ...staffGate, async (req, res) => {
  const parsed = staffReplySchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid reply', details: parsed.error.flatten() });
  }
  const review = await getReview(req.params.id);
  if (!review) return res.status(404).json({ error: 'Review not found' });
  await addReviewComment({ reviewId: review.id, authorId: req.user.id, authorKind: 'STAFF', body: parsed.data.body });
  const fresh = await getReview(review.id);
  return res.status(201).json({ data: await serializeReview(fresh, { audience: 'admin' }) });
});

router.get('/pepper-lists/reviews/admin/:id/media', ...staffGate, async (req, res) => {
  const review = await getReview(req.params.id);
  if (!review) return res.status(404).json({ error: 'Review not found' });
  const rows = await listReviewMedia(review.id);
  const metaOnly = String(req.query.meta || '') === '1';
  return res.json({
    data: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      ...(metaOnly ? {} : { dataBase64: row.data.toString('base64') }),
      createdAt: row.createdAt,
    })),
  });
});

router.get('/pepper-lists/reviews/admin/:id/media/:mediaId', ...staffGate, async (req, res) => {
  const review = await getReview(req.params.id);
  if (!review) return res.status(404).json({ error: 'Review not found' });
  const row = await getReviewMediaItem(review.id, req.params.mediaId);
  if (!row) return res.status(404).json({ error: 'Media item not found' });
  return serveMediaBytes(req, res, row);
});

export default router;
