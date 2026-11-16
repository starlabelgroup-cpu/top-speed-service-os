import { Router } from 'express';
import { z } from 'zod';
import { store } from '../data/store.js';
import { createConnectionRecord } from '../db/connectionsRepo.js';
import { getSubmissionMediaItem, listSubmissionMedia, saveSubmissionMedia } from '../db/submissionMediaRepo.js';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { STAFF_ROLES } from '../config/security.js';
import { assertImageDataUrl, speedyDiagnose, speedyExtractModelPlate, speedyStatus } from '../services/speedy.js';
import { notifySubmission } from '../services/notifications.js';

/**
 * Pepper Lists — Speedy Brain lanes (2026-11-16).
 *
 * The consumer-app counterpart of the provider machinery:
 * - POST /pepper-lists/plate-read: a signed-in CUSTOMER photographs
 *   their own appliance's rating plate and Speedy transcribes model +
 *   serial (the same speedyExtractModelPlate service Appliance Plug's
 *   tech plate read uses; the provider route itself stays provider-
 *   only). The customer confirms/edits before anything is saved to
 *   their garage via the existing POST /connect/appliances.
 * - POST /pepper-lists/submissions: the Scan & Send and Live Video
 *   Request lanes. Both create a real connection record through the
 *   universal intake (createConnectionRecord), whose lead types
 *   (PEPPER_LISTS_SCAN / PEPPER_LISTS_LIVE_VIDEO in
 *   services/leadBookings.js) also create the linked booking the
 *   Service Setters queue reads. Media bytes persist on
 *   SubmissionMedia rows keyed to the connection; staff fetch them
 *   through the staff-gated media endpoint below. A live video
 *   submission is a REQUEST — a setter responds to start the session;
 *   nothing here simulates a call.
 * - GET /pepper-lists/submissions/:connectionId/media: staff only.
 *
 * Governance (unchanged): Speedy never invents a diagnosis or a
 * price; when the AI provider is down the plate read says so (503)
 * and a scan submission still succeeds with the diagnosis honestly
 * marked unavailable — the media goes to the office either way.
 */
const router = Router();

const PHOTO_MAX_BYTES = 6 * 1024 * 1024;
const VIDEO_MAX_BYTES = 15 * 1024 * 1024;
const MEDIA_MAX_ITEMS = 4;
const MEDIA_TOTAL_MAX_BYTES = 18 * 1024 * 1024;

const plateReadSchema = z.object({
  imageDataUrl: z.string().trim().min(32).max(12_000_000),
});

router.post('/pepper-lists/plate-read', authenticate, async (req, res) => {
  if (!speedyStatus().configured) {
    return res.status(503).json({ error: 'Speedy plate reading is unavailable right now — enter the model and serial by hand' });
  }
  const parsed = plateReadSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid plate photo', details: parsed.error.flatten() });
  }
  try {
    const plate = await speedyExtractModelPlate(parsed.data.imageDataUrl);
    return res.json({ data: { plate } });
  } catch (error) {
    return res.status(502).json({ error: 'Speedy could not read that plate — retake the photo or enter the details by hand', detail: String(error?.message || error) });
  }
});

const mediaItemSchema = z.object({
  kind: z.enum(['photo', 'video']),
  mime: z.string().trim().max(60),
  dataBase64: z.string().min(16).max(21_000_000),
});

const submissionSchema = z.object({
  lane: z.enum(['SCAN_SEND', 'LIVE_VIDEO']),
  appliance: z.string().trim().min(2).max(80),
  issue: z.string().trim().min(3).max(2000),
  phone: z.string().trim().min(7).max(30),
  name: z.string().trim().min(2).max(120).optional(),
  email: z.string().email().max(200).optional(),
  brand: z.string().trim().max(60).optional(),
  model: z.string().trim().max(80).optional(),
  serial: z.string().trim().max(80).optional(),
  preferredTime: z.string().trim().max(80).optional(),
  media: z.array(mediaItemSchema).max(MEDIA_MAX_ITEMS).optional(),
});

function videoBytesOk(mime, head) {
  if (mime === 'video/mp4' || mime === 'video/quicktime') {
    return head.length >= 8 && head.toString('ascii', 4, 8) === 'ftyp';
  }
  if (mime === 'video/webm') {
    return head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
  }
  return false;
}

/**
 * Validate one media item's real bytes against its declared type and
 * the lane caps. Photos reuse the security pass's magic-byte check
 * (assertImageDataUrl); videos get the matching container check here
 * (MP4/MOV ftyp box, WebM EBML header) — this is the only path that
 * accepts video, and the check lives with it.
 */
function validateMediaItem(item) {
  // Browsers report recorder types with parameters ('video/webm;codecs=vp8')
  // — the container is what matters, so normalize before checking.
  item = { ...item, mime: String(item.mime || '').split(';')[0].trim().toLowerCase() };
  const bytes = Buffer.from(item.dataBase64, 'base64');
  if (!bytes.length) throw new Error('One of the files was empty — remove it and try again');
  if (item.kind === 'photo') {
    if (bytes.length > PHOTO_MAX_BYTES) throw new Error('A photo is over the 6 MB limit — retake it or pick a smaller one');
    const mime = item.mime === 'image/jpg' ? 'image/jpeg' : item.mime;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) {
      throw new Error('Photos must be JPEG, PNG or WebP');
    }
    const dataUrl = `data:${mime};base64,${item.dataBase64}`;
    assertImageDataUrl(dataUrl); // throws when the bytes are not the declared image type
    return { kind: 'photo', mime, sizeBytes: bytes.length, dataUrl };
  }
  if (bytes.length > VIDEO_MAX_BYTES) throw new Error('A video is over the 15 MB limit — keep clips short and try again');
  if (!videoBytesOk(item.mime, bytes)) {
    throw new Error('Videos must be real MP4, MOV or WebM clips');
  }
  return { kind: 'video', mime: item.mime, sizeBytes: bytes.length, dataUrl: `data:${item.mime};base64,${item.dataBase64}` };
}

router.post('/pepper-lists/submissions', authenticate, async (req, res) => {
  const parsed = submissionSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid submission', details: parsed.error.flatten() });
  }
  const data = parsed.data;

  let media = [];
  try {
    media = (data.media || []).map(validateMediaItem);
  } catch (error) {
    return res.status(400).json({ error: String(error?.message || error) });
  }
  const totalBytes = media.reduce((sum, item) => sum + item.sizeBytes, 0);
  if (totalBytes > MEDIA_TOTAL_MAX_BYTES) {
    return res.status(400).json({ error: 'The files together are over the 18 MB limit — remove one and try again' });
  }

  const account = store.users.get(req.user.id) || {};
  const name = data.name || [account.firstName, account.lastName].filter(Boolean).join(' ').trim() || account.email || req.user.email || 'Pepper Lists customer';
  const email = data.email || account.email || req.user.email || undefined;

  // Speedy photo read (Scan & Send only): best-effort, never blocking.
  // While the provider is down the submission still succeeds and the
  // read is honestly marked unavailable in the office record.
  let diagnosisNote = null;
  if (data.lane === 'SCAN_SEND') {
    const firstPhoto = media.find((item) => item.kind === 'photo');
    if (firstPhoto && speedyStatus().configured) {
      try {
        const result = await speedyDiagnose({ imageUrl: firstPhoto.dataUrl, note: data.issue });
        const read = String(result?.reply || '').trim().slice(0, 600);
        if (read) diagnosisNote = read;
      } catch (error) {
        console.error(JSON.stringify({ level: 'warn', message: 'pepper lists scan diagnosis failed — submission continues without it', error: String(error?.message || error) }));
      }
    }
    if (!diagnosisNote) {
      diagnosisNote = 'Speedy photo read unavailable right now — the media is attached for the Service Setters to review.';
    }
  }

  const type = data.lane === 'LIVE_VIDEO' ? 'PEPPER_LISTS_LIVE_VIDEO' : 'PEPPER_LISTS_SCAN';
  const mediaLine = media.length
    ? `Media attached: ${media.map((item) => `${item.kind} (${item.mime}, ${Math.max(1, Math.round(item.sizeBytes / 1024))} KB)`).join(', ')} — staff can open it from this record (reference below).`
    : 'Media attached: none';
  const lines = [
    `Appliance: ${data.appliance}`,
    ...(data.brand ? [`Brand: ${data.brand}`] : []),
    ...(data.model ? [`Model: ${data.model}`] : []),
    ...(data.serial ? [`Serial: ${data.serial}`] : []),
    `Issue: ${data.issue}`,
    ...(data.lane === 'LIVE_VIDEO' ? [`Preferred time: ${data.preferredTime || 'As soon as possible'}`] : []),
    ...(data.lane === 'LIVE_VIDEO' ? ['Live video: REQUEST only — a Service Setter responds to start the video session.'] : []),
    mediaLine,
    ...(diagnosisNote ? [`Speedy photo read: ${diagnosisNote}`] : []),
    `Submitted by signed-in Pepper Lists account ${email || ''}`.trim(),
  ];

  const record = await createConnectionRecord({
    name,
    phone: data.phone,
    email,
    type,
    source: 'pepper-lists',
    message: lines.join('\n'),
  });
  if (media.length) {
    await saveSubmissionMedia(record.id, media);
  }

  try {
    notifySubmission({
      kind: type,
      reference: record.reference,
      submitter: { name, phone: data.phone, email },
      lines: lines.slice(0, 6),
      source: 'pepper-lists',
    });
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', message: 'pepper lists submission notify failed', error: String(error?.message || error) }));
  }

  const leadBooking = record.leadBookingId ? store.bookings.get(record.leadBookingId) : null;
  return res.status(201).json({
    data: {
      reference: record.reference,
      bookingReference: leadBooking?.referenceCode || null,
      lane: data.lane,
      mediaCount: media.length,
      diagnosis: data.lane === 'SCAN_SEND' ? diagnosisNote : null,
    },
  });
});

/**
 * Media routes accept either the connection's id or its TS- reference:
 * a booking's persisted history carries the connection reference (the
 * lead link itself is not a database column), so staff surfaces that
 * only know the reference still resolve to the same record. Anything
 * else falls through unchanged and simply finds no media.
 */
function resolveMediaConnectionId(param) {
  const raw = String(param || '');
  if (!raw) return raw;
  if (store.connections.some((c) => c.id === raw)) return raw;
  const byReference = store.connections.find((c) => c.reference === raw);
  return byReference ? byReference.id : raw;
}

const staffMediaGate = [authenticate, requireCompany, requireRole(...STAFF_ROLES)];

router.get('/pepper-lists/submissions/:connectionId/media', ...staffMediaGate, async (req, res) => {
  const rows = await listSubmissionMedia(resolveMediaConnectionId(req.params.connectionId));
  // ?meta=1 returns the manifest only (no media bytes) so staff
  // consoles can list a submission's files cheaply and stream each
  // one through the per-item route below when a setter opens it.
  const metaOnly = String(req.query.meta || '') === '1';
  return res.json({
    data: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      mime: row.mime,
      sizeBytes: row.sizeBytes,
      ...(metaOnly ? {} : { dataUrl: row.dataUrl }),
      createdAt: row.createdAt,
    })),
  });
});

/**
 * One media item as raw bytes (staff only, same gate as the list).
 * Consoles fetch it with the staff token in the Authorization header
 * and hand the browser an object URL — the token never appears in a
 * URL. Range requests are honored so video can seek and stream
 * instead of downloading the whole clip before playback.
 */
router.get('/pepper-lists/submissions/:connectionId/media/:mediaId', ...staffMediaGate, async (req, res) => {
  const row = await getSubmissionMediaItem(resolveMediaConnectionId(req.params.connectionId), req.params.mediaId);
  if (!row) return res.status(404).json({ error: 'Media item not found' });
  const match = /^data:([^;,]+);base64,([\s\S]*)$/.exec(row.dataUrl || '');
  if (!match) return res.status(500).json({ error: 'Stored media is unreadable' });
  const bytes = Buffer.from(match[2], 'base64');
  const total = bytes.length;
  const filename = `pepper-lists-${row.kind}-${row.id.slice(0, 8)}`;
  res.set({
    'Content-Type': row.mime || match[1] || 'application/octet-stream',
    'Cache-Control': 'private, no-store',
    'Accept-Ranges': 'bytes',
    'Content-Disposition': `inline; filename="${filename}"`,
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
});

export default router;
