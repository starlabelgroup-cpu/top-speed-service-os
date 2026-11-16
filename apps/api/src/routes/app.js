import { Router } from 'express';
import { z } from 'zod';
import { PLATFORM_CONSTANTS } from '../config/platform.js';
import { ROLES, STAFF_ROLES } from '../config/security.js';
import { appendEvent, createId, store } from '../data/store.js';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { PLUG_192, PLUG_512, PRO_192, PRO_512, CONNECT_192, CONNECT_512, CONNECTPRO_192, CONNECTPRO_512, SPEEDY_192, SPEEDY_512 } from '../assets/appIcons.js';
import { SERVICE_HERO_WEBP, SERVICE_COMMERCIAL_WEBP, SERVICE_VAN_WEBP } from '../assets/serviceImages.js';
import { PL_SELL_WEBP, PL_BOOK_WEBP } from '../assets/pepperListsImages.js';
import { IMG_SELL_INDIVIDUAL, IMG_SELL_BUSINESS, IMG_POST_REVIEWS, IMG_BOOKING_DISPATCH, IMG_LIVE_TRACKING, IMG_SPEEDY_DIAGNOSIS, IMG_REFER_EARN, IMG_COMMERCIAL_PM, IMG_SPEEDY_PRO_TECH, IMG_FLYWHEEL_ADS, IMG_RESIDENTIAL_FRIDGE, IMG_RESIDENTIAL_LAUNDRY, IMG_RESIDENTIAL_OVEN, IMG_COMMERCIAL_RESTAURANT, IMG_COMMERCIAL_LAUNDROMAT, IMG_COMMERCIAL_HOTEL, IMG_CLEANOUT_VENTS, IMG_APPLIANCE_PLUG, IMG_LOCAL_FORT_LAUDERDALE, IMG_FLYWHEEL_DISPLAY_AD } from '../assets/platformImages.js';

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
/**
 * PWA install icons for the Service OS apps (Appliance Connect,
 * Appliance Connect Pro, Appliance Pro, Appliance Plug, Speedy Pro).
 * The PNG bytes live in assets/appIcons.js as base64 text (the repo's
 * push pipeline is text-only, so real binary PNGs cannot be stored in
 * the repo); this route serves the decoded bytes as image/png. The
 * apps' manifests and apple-touch-icon links point here. Public on
 * purpose — these are published brand assets, no data behind them.
 */
const APP_ICON_FILES = {
  'plug-192.png': PLUG_192,
  'plug-512.png': PLUG_512,
  'pro-192.png': PRO_192,
  'pro-512.png': PRO_512,
  'connect-192.png': CONNECT_192,
  'connect-512.png': CONNECT_512,
  'connectpro-192.png': CONNECTPRO_192,
  'connectpro-512.png': CONNECTPRO_512,
  'speedy-192.png': SPEEDY_192,
  'speedy-512.png': SPEEDY_512,
};

router.get('/app/icons/:name', (req, res) => {
  const encoded = APP_ICON_FILES[req.params.name];
  if (!encoded) return res.status(404).json({ error: 'Icon not found' });
  res.set({
    'Content-Type': 'image/png',
    'Cache-Control': 'public, max-age=86400',
    'Access-Control-Allow-Origin': '*',
  });
  return res.send(Buffer.from(encoded, 'base64'));
});

/**
 * Service Network page photos (Ramone's own branded-technician shots).
 * Same text-only-pipeline constraint as the icons above: the WebP
 * bytes live in assets/serviceImages.js as base64 text and this route
 * serves the decoded bytes as image/webp. The /service page points
 * its hero + Commercial Track photos here. Public brand assets.
 */
const SERVICE_IMAGE_FILES = {
  'hero-tech.webp': SERVICE_HERO_WEBP,
  'commercial.webp': SERVICE_COMMERCIAL_WEBP,
  'van-banner.webp': SERVICE_VAN_WEBP,
};

router.get('/app/service-images/:name', (req, res) => {
  const encoded = SERVICE_IMAGE_FILES[req.params.name];
  if (!encoded) return res.status(404).json({ error: 'Image not found' });
  res.set({
    'Content-Type': 'image/webp',
    'Cache-Control': 'public, max-age=86400',
    'Access-Control-Allow-Origin': '*',
  });
  return res.send(Buffer.from(encoded, 'base64'));
});

const PEPPER_LISTS_IMAGE_FILES = {
  'sell.webp': PL_SELL_WEBP,
  'book.webp': PL_BOOK_WEBP,
};

router.get('/app/pepper-lists-images/:name', (req, res) => {
  const bytes = PEPPER_LISTS_IMAGE_FILES[req.params.name];
  if (!bytes) return res.status(404).json({ error: 'Image not found' });
  res.set({
    'Content-Type': 'image/webp',
    'Cache-Control': 'public, max-age=86400',
    'Access-Control-Allow-Origin': '*',
  });
  return res.send(bytes);
});

/**
 * Platform illustration pack (2026-11-16): 20 flat-vector category /
 * purpose illustrations generated for the platforms, embedded as
 * base64 in assets/platformImages.js (same text-only-pipeline
 * constraint as above) and served here as image/webp. Web surfaces
 * reference them same-origin via /api/v1/app/platform-images/<file>
 * (vercel.json rewrite on the web project). Public brand assets.
 */
const PLATFORM_IMAGE_FILES = {
  'sell-individual.webp': IMG_SELL_INDIVIDUAL,
  'sell-business.webp': IMG_SELL_BUSINESS,
  'post-reviews.webp': IMG_POST_REVIEWS,
  'booking-dispatch.webp': IMG_BOOKING_DISPATCH,
  'live-tracking.webp': IMG_LIVE_TRACKING,
  'speedy-diagnosis.webp': IMG_SPEEDY_DIAGNOSIS,
  'refer-earn.webp': IMG_REFER_EARN,
  'commercial-pm.webp': IMG_COMMERCIAL_PM,
  'speedy-pro-tech.webp': IMG_SPEEDY_PRO_TECH,
  'flywheel-ads.webp': IMG_FLYWHEEL_ADS,
  'residential-fridge.webp': IMG_RESIDENTIAL_FRIDGE,
  'residential-laundry.webp': IMG_RESIDENTIAL_LAUNDRY,
  'residential-oven.webp': IMG_RESIDENTIAL_OVEN,
  'commercial-restaurant.webp': IMG_COMMERCIAL_RESTAURANT,
  'commercial-laundromat.webp': IMG_COMMERCIAL_LAUNDROMAT,
  'commercial-hotel.webp': IMG_COMMERCIAL_HOTEL,
  'cleanout-vents.webp': IMG_CLEANOUT_VENTS,
  'appliance-plug.webp': IMG_APPLIANCE_PLUG,
  'local-fort-lauderdale.webp': IMG_LOCAL_FORT_LAUDERDALE,
  'flywheel-display-ad.webp': IMG_FLYWHEEL_DISPLAY_AD,
};

router.get('/app/platform-images/:name', (req, res) => {
  const bytes = PLATFORM_IMAGE_FILES[req.params.name];
  if (!bytes) return res.status(404).json({ error: 'Image not found' });
  res.set({
    'Content-Type': 'image/webp',
    'Cache-Control': 'public, max-age=86400',
    'Access-Control-Allow-Origin': '*',
  });
  return res.send(bytes);
});

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
