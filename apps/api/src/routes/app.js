import { Router } from 'express';
import { z } from 'zod';
import { PLATFORM_CONSTANTS } from '../config/platform.js';
import { ROLES, STAFF_ROLES } from '../config/security.js';
import { appendEvent, createId, store } from '../data/store.js';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';

const router = Router();

/**
 * App distribution — the Top Speed app ships TODAY as a PWA
 * (apps/web: manifest + service worker + /download page). These
 * endpoints describe the current release honestly and record install
 * attribution:
 *
 *   - Apple App Store / Google Play listings do NOT exist yet. Their
 *     status is NOT_YET_PUBLISHED, url is null, and no download counts
 *     or ratings are reported anywhere — publishing needs developer
 *     accounts Ramone opens himself (see APPS.md).
 *   - POST /app/track-download is public on purpose: the browser that
 *     just installed the app is not a signed-in staff session. It only
 *     records platform/device/src attribution — no personal data.
 */

const APP_RELEASE = {
  appName: 'Appliance Pro',
  platformName: PLATFORM_CONSTANTS.platformName,
  version: '1.0.0',
  releaseNotes: 'Initial PWA release',
  distribution: 'PWA',
  installPage: '/download',
};

/**
 * Store listing statuses. `web` is the PWA itself (published — it is the
 * current site). Apple and Google are honest placeholders: no store URL,
 * no counts, no ratings, because nothing has been submitted.
 */
const STORE_LISTINGS = [
  {
    store: 'apple',
    name: 'Apple App Store',
    status: 'NOT_YET_PUBLISHED',
    url: null,
    note: 'Requires an Apple Developer Program account (Ramone to open) before a listing can be created.',
  },
  {
    store: 'google',
    name: 'Google Play',
    status: 'NOT_YET_PUBLISHED',
    url: null,
    note: 'Requires a Google Play Console developer account (Ramone to open) before a listing can be created.',
  },
  {
    store: 'web',
    name: 'Web app (PWA)',
    status: 'PUBLISHED',
    url: '/download',
    note: 'Installable today from the download page — this is the live Top Speed app.',
  },
];

const staffOnly = [authenticate, requireCompany, requireRole(...STAFF_ROLES)];

/** Current app release + how to get it on each store. Public. */
router.get('/app/current-version', (req, res) => {
  return res.json({
    data: {
      ...APP_RELEASE,
      publisher: PLATFORM_CONSTANTS.platformOwner,
      storeListings: STORE_LISTINGS,
      generatedAt: new Date().toISOString(),
    },
  });
});

/** Store listing statuses on their own (download page + admin use). Public. */
router.get('/app/stores', (req, res) => {
  return res.json({ data: { stores: STORE_LISTINGS } });
});

const trackDownloadSchema = z.object({
  platform: z.enum(['ios', 'android', 'web']),
  deviceType: z.string().trim().max(40).optional(),
  // Attribution tag carried by the surface that sent the user here:
  // ?src=flyer, ?src=qr-door-hanger, ?src=meta-ad, ... Free-form on
  // purpose — new surfaces invent tags without an API change.
  src: z.string().trim().min(1).max(64).optional(),
  // 'installed' = the browser fired appinstalled (a real install).
  // 'download_page_view' = someone opened /download with this src tag.
  event: z.enum(['installed', 'download_page_view']).default('installed'),
});

/**
 * Record an install / download-page attribution event. Public (see the
 * header note). Appends APP_INSTALL_TRACKED to the platform event feed.
 */
router.post('/app/track-download', (req, res) => {
  const parsed = trackDownloadSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid track-download payload', details: parsed.error.flatten() });
  }
  const data = parsed.data;

  const record = {
    id: createId(),
    platform: data.platform,
    deviceType: data.deviceType || null,
    src: data.src || null,
    event: data.event,
    at: new Date().toISOString(),
  };
  store.appInstalls.push(record);

  appendEvent('APP_INSTALL_TRACKED', {
    actor: 'app:track-download',
    entityType: 'APP_INSTALL',
    entityId: record.id,
    details: { platform: record.platform, deviceType: record.deviceType, src: record.src, event: record.event },
  });

  return res.status(201).json({ data: record });
});

/**
 * Staff view: install counts by platform and by attribution src — the
 * numbers the flywheel reads. Only real `installed` events count as
 * installs; download-page views are reported separately.
 */
router.get('/app/installs', ...staffOnly, (req, res) => {
  const installed = store.appInstalls.filter((entry) => entry.event === 'installed');
  const pageViews = store.appInstalls.filter((entry) => entry.event === 'download_page_view');

  const byPlatform = { ios: 0, android: 0, web: 0 };
  for (const entry of installed) byPlatform[entry.platform] = (byPlatform[entry.platform] || 0) + 1;

  const bySrc = {};
  for (const entry of installed) {
    const key = entry.src || 'direct';
    bySrc[key] = (bySrc[key] || 0) + 1;
  }

  return res.json({
    data: {
      installs: installed.length,
      downloadPageViews: pageViews.length,
      byPlatform,
      bySrc,
      recent: [...store.appInstalls].reverse().slice(0, 50),
    },
  });
});

export default router;
