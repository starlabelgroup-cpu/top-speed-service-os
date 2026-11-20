/**
 * Before/after video factory drill (2026-11-20, E9).
 *
 * Proves, in skeleton mode with the VM's real ffmpeg:
 *  1. The factory reports itself available where ffmpeg + a font
 *     exist.
 *  2. A marketing-role staffer can generate a video for a COMPLETED
 *     job from its own before/after photos: the result is a Media OS
 *     content record born DRAFT (never published by the factory),
 *     absent from the public content list, with real MP4 bytes
 *     (ftyp signature) stored in the blob layer and a positive
 *     duration.
 *  3. The byte route streams the video to staff (200, video/mp4,
 *     Range → 206) and hides a draft's bytes from anonymous and
 *     customer callers (404).
 *  4. Honest refusals: unknown booking 404, non-completed job 422,
 *     a completed job missing its AFTER photo 422, a customer
 *     caller 403.
 *
 * Run: node test/video-factory.test.mjs   (exit 0 = pass)
 */
import { createHmac } from 'node:crypto';

delete process.env.DATABASE_URL;
delete process.env.DATABASE_URL_UNPOOLED;
delete process.env.DIRECT_URL;
process.env.JWT_SECRET = 'video-factory-drill-secret';
delete process.env.ALLOW_DEMO_AUTH;

const express = (await import('express')).default;
const { default: videoFactoryRouter } = await import('../src/routes/videoFactory.js');
const { default: mediaOsRouter } = await import('../src/routes/mediaOs.js');
const { store, PLATFORM_COMPANY_ID } = await import('../src/data/store.js');
const { videoFactoryStatus } = await import('../src/services/videoFactory.js');

let failures = 0;
function check(label, ok, extra = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  (${extra})` : ''}`);
}

function mintToken(roles) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const payload = b64({
    sub: 'drill-user', companyId: PLATFORM_COMPANY_ID, email: 'drill@example.test',
    roles, exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const sig = createHmac('sha256', process.env.JWT_SECRET).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function seedBooking({ id, referenceCode, status, photos }) {
  const booking = {
    id, referenceCode, status,
    appliance: 'Refrigerator', city: 'Davie',
    completedAt: '2026-11-19T15:04:00.000Z',
    customer: { name: 'Drill Customer', phone: '9545550142' },
    history: photos.map((p, i) => ({
      type: 'JOB_PHOTO_ADDED',
      at: '2026-11-19T14:00:00.000Z',
      photo: { id: `${id}-photo-${i}`, category: p.category, dataUrl: PNG_1PX, caption: p.caption || null, at: '2026-11-19T14:00:00.000Z', by: 'tech-drill' },
    })),
  };
  store.bookings.set(id, booking);
  return booking;
}

seedBooking({
  id: 'drill-booking-done', referenceCode: 'TS-DRILL1', status: 'COMPLETED',
  photos: [{ category: 'BEFORE', caption: 'Leaking at the base' }, { category: 'AFTER' }],
});
seedBooking({
  id: 'drill-booking-pending', referenceCode: 'TS-DRILL2', status: 'PENDING_DISPATCH',
  photos: [{ category: 'BEFORE' }, { category: 'AFTER' }],
});
seedBooking({
  id: 'drill-booking-noafter', referenceCode: 'TS-DRILL3', status: 'COMPLETED',
  photos: [{ category: 'BEFORE' }],
});

const app = express();
app.use(express.json());
app.use('/api/v1', videoFactoryRouter);
app.use('/api/v1', mediaOsRouter);
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.on('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}/api/v1`;

async function req(method, path, { token, body, headers } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(headers || {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buf.toString('utf8')); } catch { /* binary */ }
  return { status: res.status, json, buf, headers: res.headers };
}

const marketing = mintToken(['MARKETING_MANAGER']);
const customer = mintToken(['CUSTOMER']);

/* ── 1. Availability ───────────────────────────────────────────── */
const status = await videoFactoryStatus();
check('factory reports available in this environment (ffmpeg + font)', status.available === true, JSON.stringify(status));
const statusRes = await req('GET', '/media-os/video-factory/status', { token: marketing });
check('status endpoint answers staff', statusRes.status === 200 && statusRes.json.data.available === true, String(statusRes.status));

/* ── 2. Generate from a completed job ──────────────────────────── */
const gen = await req('POST', '/media-os/video-factory', { token: marketing, body: { referenceCode: 'TS-DRILL1' } });
check('generation succeeds (201)', gen.status === 201, `${gen.status} ${gen.buf.toString('utf8').slice(0, 200)}`);
const created = gen.json?.data || {};
check('content is born DRAFT — the factory never publishes', created.status === 'DRAFT', created.status);
check('duration is the composed slideshow length (11s)', created.durationSec === 11, String(created.durationSec));
check('title carries the real job facts', created.title === 'Refrigerator repair in Davie — before & after', created.title);

const record = store.mediaContent.find((c) => c.id === created.id);
check('record lives in the Media OS library as DRAFT', Boolean(record) && record.status === 'DRAFT');
const pubList = await req('GET', '/media-os/content');
check('draft is absent from the public content list',
  !(pubList.json?.data || []).some((c) => c.id === created.id));

const blob = store.mediaVideoBlobs.get(created.id);
check('video bytes are stored', Boolean(blob) && blob.sizeBytes > 1000, blob ? String(blob.sizeBytes) : 'none');
check('bytes are a real MP4 (ftyp box)', blob && blob.data.subarray(4, 8).toString('ascii') === 'ftyp',
  blob ? blob.data.subarray(4, 8).toString('ascii') : 'none');
const asset = store.mediaAssets.find((a) => a.contentId === created.id);
check('asset registry entry exists with OWNED rights', Boolean(asset) && asset.rightsStatus === 'OWNED');

/* ── 3. Byte route access ──────────────────────────────────────── */
const stream = await req('GET', `/media-os/video-factory/${created.id}/video`, { token: marketing });
check('staff can stream the draft video', stream.status === 200 && stream.headers.get('content-type') === 'video/mp4', String(stream.status));
check('streamed bytes match the stored bytes', stream.buf.length === blob.sizeBytes, `${stream.buf.length} vs ${blob.sizeBytes}`);
const ranged = await req('GET', `/media-os/video-factory/${created.id}/video`, { token: marketing, headers: { Range: 'bytes=0-99' } });
check('range requests are honored (206)', ranged.status === 206 && ranged.buf.length === 100, String(ranged.status));
const anon = await req('GET', `/media-os/video-factory/${created.id}/video`);
check('anonymous callers cannot read a draft video (404)', anon.status === 404, String(anon.status));
const cust = await req('GET', `/media-os/video-factory/${created.id}/video`, { token: customer });
check('customer callers cannot read a draft video (404)', cust.status === 404, String(cust.status));

/* ── 4. Honest refusals ────────────────────────────────────────── */
const unknown = await req('POST', '/media-os/video-factory', { token: marketing, body: { referenceCode: 'TS-NOPE99' } });
check('unknown booking → 404', unknown.status === 404, String(unknown.status));
const pending = await req('POST', '/media-os/video-factory', { token: marketing, body: { referenceCode: 'TS-DRILL2' } });
check('non-completed job → 422', pending.status === 422, String(pending.status));
const noAfter = await req('POST', '/media-os/video-factory', { token: marketing, body: { referenceCode: 'TS-DRILL3' } });
check('completed job missing its AFTER photo → 422', noAfter.status === 422, String(noAfter.status));
const forbidden = await req('POST', '/media-os/video-factory', { token: customer, body: { referenceCode: 'TS-DRILL1' } });
check('customer caller → 403', forbidden.status === 403, String(forbidden.status));

server.close();
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
