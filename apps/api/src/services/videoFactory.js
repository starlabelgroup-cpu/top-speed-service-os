import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Before/after video factory (2026-11-20, E9).
 *
 * Renders a short branded slideshow MP4 from a completed job's own
 * before/after photos (the JOB_PHOTO_ADDED history events on the
 * booking): a branded title card carrying only the job's real facts
 * (appliance, city, completion date), the before photos, the after
 * photos, and a branded closing card (business name, slogan, phone,
 * website). No claim is invented: no ratings, no reviews, no prices,
 * no promises — the captions are the booking's own recorded facts
 * and the photo's own caption when the technician wrote one.
 *
 * Composition is ffmpeg (slideshow segments + concat). ffmpeg is
 * present in the VM/dev environment; a serverless production runtime
 * may not ship it, so availability is probed honestly and the route
 * reports { available: false } (503) where no binary exists —
 * VIDEO_FACTORY_FFMPEG_PATH can point at a bundled binary, and
 * VIDEO_FACTORY_FONT_FILE at the drawtext font. The factory's output
 * is always a Media OS DRAFT; publishing stays a human decision in
 * the editorial workflow.
 */

const WIDTH = 1280;
const HEIGHT = 720;
const INTRO_SECONDS = 2.5;
const PHOTO_SECONDS = 3;
const OUTRO_SECONDS = 2.5;
const MAX_PHOTOS_PER_SIDE = 2;
const NAVY = '0x0C162B';
const RED = '0xE94E5C';

let probeCache = null;

export function ffmpegPath() {
  return process.env.VIDEO_FACTORY_FFMPEG_PATH || 'ffmpeg';
}

export function fontFile() {
  const candidates = [
    process.env.VIDEO_FACTORY_FONT_FILE,
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) || null;
}

export async function videoFactoryStatus() {
  if (probeCache) return probeCache;
  probeCache = (async () => {
    const font = fontFile();
    try {
      await run(ffmpegPath(), ['-version'], { timeout: 10000 });
      return { available: Boolean(font), ffmpeg: ffmpegPath(), font };
    } catch {
      return { available: false, ffmpeg: ffmpegPath(), font };
    }
  })();
  return probeCache;
}

/** Test hook: forget the cached probe (drills flip env between runs). */
export function resetVideoFactoryProbe() {
  probeCache = null;
}

function drawtextEscape(text) {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/%/g, '\\%')
    .replace(/\n/g, ' ')
    .slice(0, 120);
}

function textFilter({ text, size, y, color = 'white', font }) {
  return `drawtext=fontfile=${font}:text='${drawtextEscape(text)}':fontsize=${size}:fontcolor=${color}:x=(w-text_w)/2:y=${y}`;
}

async function renderCard({ dir, name, lines, font, seconds }) {
  const out = join(dir, name);
  const filters = lines.map((line) => textFilter({ ...line, font })).join(',');
  await run(ffmpegPath(), [
    '-f', 'lavfi', '-i', `color=c=${NAVY}:s=${WIDTH}x${HEIGHT}:d=${seconds}:r=30`,
    '-vf', filters,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', String(seconds),
    '-movflags', '+faststart', out,
  ], { timeout: 60000 });
  return out;
}

async function renderPhotoSegment({ dir, name, photo, label, font }) {
  const match = /^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/.exec(photo.dataUrl || '');
  if (!match) throw new Error('A job photo is not a readable image');
  const ext = match[1] === 'jpg' ? 'jpeg' : match[1];
  const imgPath = join(dir, `${name}.${ext}`);
  await writeFile(imgPath, Buffer.from(match[2], 'base64'));
  const out = join(dir, `${name}.mp4`);
  const caption = photo.caption ? ` — ${photo.caption}` : '';
  const vf = [
    `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease`,
    `pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=${NAVY}`,
    textFilter({ text: `${label}${caption}`, size: 44, y: HEIGHT - 90, font }),
    `drawbox=x=0:y=${HEIGHT - 110}:w=${WIDTH}:h=110:color=${RED}@0.85:t=fill`,
  ];
  // Draw the band first so the label sits on it: reorder — band, then text.
  const vfOrdered = [vf[0], vf[1], vf[3], vf[2]].join(',');
  await run(ffmpegPath(), [
    '-loop', '1', '-i', imgPath,
    '-vf', vfOrdered,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', String(PHOTO_SECONDS),
    '-movflags', '+faststart', out,
  ], { timeout: 60000 });
  return out;
}

/**
 * Render the before/after video for a booking. `photos` is the job's
 * photo list (jobPhotos shape: { category, dataUrl, caption }).
 * Returns { data: Buffer, durationSec }.
 */
export async function renderBeforeAfterVideo({ booking, photos }) {
  const status = await videoFactoryStatus();
  if (!status.available) {
    const error = new Error('Video rendering is not available in this environment (no ffmpeg binary or font)');
    error.code = 'VIDEO_FACTORY_UNAVAILABLE';
    throw error;
  }
  const font = status.font;
  const befores = photos.filter((p) => p.category === 'BEFORE').slice(0, MAX_PHOTOS_PER_SIDE);
  const afters = photos.filter((p) => p.category === 'AFTER').slice(0, MAX_PHOTOS_PER_SIDE);
  if (!befores.length || !afters.length) {
    const error = new Error('The job needs at least one BEFORE and one AFTER photo');
    error.code = 'PHOTOS_MISSING';
    throw error;
  }
  const base = process.env.VIDEO_FACTORY_WORK_DIR || tmpdir();
  const dir = await mkdtemp(join(base, 'tsos-video-factory-'));
  try {
    const appliance = booking.appliance || 'Appliance';
    const city = booking.city || '';
    const completedDate = booking.completedAt
      ? new Date(booking.completedAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
      : null;
    const segments = [];
    segments.push(await renderCard({
      dir, name: 'seg-intro.mp4', font, seconds: INTRO_SECONDS,
      lines: [
        { text: 'TOP SPEED APPLIANCE', size: 64, y: 240 },
        { text: `${appliance} repair — before & after`, size: 40, y: 340, color: '0x9DB6DE' },
        ...(city ? [{ text: city, size: 36, y: 410, color: '0x9DB6DE' }] : []),
        ...(completedDate ? [{ text: completedDate, size: 30, y: 470, color: '0x9DB6DE' }] : []),
      ],
    }));
    for (let i = 0; i < befores.length; i += 1) {
      segments.push(await renderPhotoSegment({ dir, name: `seg-before-${i}`, photo: befores[i], label: 'BEFORE', font }));
    }
    for (let i = 0; i < afters.length; i += 1) {
      segments.push(await renderPhotoSegment({ dir, name: `seg-after-${i}`, photo: afters[i], label: 'AFTER', font }));
    }
    segments.push(await renderCard({
      dir, name: 'seg-outro.mp4', font, seconds: OUTRO_SECONDS,
      lines: [
        { text: 'The Faster, The Better.', size: 52, y: 260 },
        { text: '(844) 460-7038', size: 44, y: 350 },
        { text: 'topspeedserviceos.com', size: 34, y: 420, color: '0x9DB6DE' },
      ],
    }));
    const listPath = join(dir, 'segments.txt');
    await writeFile(listPath, segments.map((s) => `file '${s}'`).join('\n'));
    const outPath = join(dir, 'before-after.mp4');
    await run(ffmpegPath(), [
      '-f', 'concat', '-safe', '0', '-i', listPath,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30',
      '-movflags', '+faststart', outPath,
    ], { timeout: 120000 });
    const data = await readFile(outPath);
    const durationSec = Math.round(
      INTRO_SECONDS + OUTRO_SECONDS + PHOTO_SECONDS * (befores.length + afters.length),
    );
    return { data, durationSec };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
