import { Router } from 'express';
import { z } from 'zod';
import { PLATFORM_CONSTANTS } from '../config/platform.js';
import { ROLES, STAFF_ROLES } from '../config/security.js';
import { appendEvent, createId, store } from '../data/store.js';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { PLUG_192, PLUG_512, PRO_192, PRO_512, CONNECT_192, CONNECT_512, CONNECTPRO_192, CONNECTPRO_512, SPEEDY_192, SPEEDY_512 } from '../assets/appIcons.js';
import { SERVICE_HERO_WEBP, SERVICE_COMMERCIAL_WEBP, SERVICE_VAN_WEBP, PM_VISIT_WEBP, GUIDE_FRIDGE_WEBP } from '../assets/serviceImages.js';
import { PL_SELL_WEBP, PL_BOOK_WEBP } from '../assets/pepperListsImages.js';
import { MASCOT_HERO_WEBP, MASCOT_HERO_LIGHT_WEBP, MASCOT_HEAD_WEBP } from '../assets/mascotImages.js';
import { SCENE_NEED_WARM_FRIDGE, SCENE_NEED_WASHER_LEAK, SCENE_REPAIR_FRIDGE_DIAGNOSIS, SCENE_INSTALL_DELIVERY_ARRIVAL, SCENE_BOOK_CALENDAR_PICK, SCENE_SPEEDY_SYMPTOM_GUIDE, SCENE_SPEEDY_PHOTO_FRIDGE, SCENE_TRACK_MAP_PHONE, SCENE_TRACK_DOORBELL, SCENE_REVIEW_STARS_PHONE, SCENE_DISPATCH_MORNING_BOARD, SCENE_PAY_QUOTE_TABLET } from '../assets/scenarioImages.js';
import { IMG_SELL_INDIVIDUAL, IMG_SELL_BUSINESS, IMG_POST_REVIEWS, IMG_BOOKING_DISPATCH, IMG_LIVE_TRACKING, IMG_SPEEDY_DIAGNOSIS, IMG_REFER_EARN, IMG_COMMERCIAL_PM, IMG_SPEEDY_PRO_TECH, IMG_FLYWHEEL_ADS, IMG_RESIDENTIAL_FRIDGE, IMG_RESIDENTIAL_LAUNDRY, IMG_RESIDENTIAL_OVEN, IMG_COMMERCIAL_RESTAURANT, IMG_COMMERCIAL_LAUNDROMAT, IMG_COMMERCIAL_HOTEL, IMG_CLEANOUT_VENTS, IMG_APPLIANCE_PLUG, IMG_LOCAL_FORT_LAUDERDALE, IMG_FLYWHEEL_DISPLAY_AD } from '../assets/platformImages.js';
import { IMG2_ACADEMY_LEARNING, IMG2_AD_STUDIO_CREATE, IMG2_APP_GARAGE, IMG2_BOOKING_FORM_CLASSIC, IMG2_COCOCANE_JUICE, IMG2_COMMERCIAL_WORK_ORDER, IMG2_DELIVERY_NEW_APPLIANCE, IMG2_DISPATCH_SETTERS, IMG2_EMERGENCY_NIGHT, IMG2_HAUL_AWAY_RECYCLE, IMG2_INSTALL_DAY, IMG2_LIVE_VIDEO_HELP, IMG2_MAINTENANCE_PLAN, IMG2_PARTS_DELIVERY, IMG2_PM_BATCH_SCHEDULING, IMG2_PROMISE_SHIELD, IMG2_QUOTE_APPROVAL, IMG2_REMINDERS_BELL, IMG2_REPAIR_COMPLETE_PAY, IMG2_SCAN_SERIAL, IMG2_SERVICE_HISTORY, IMG2_SPEEDY_CHAT_ASSISTANT, IMG2_SPEEDY_VERIFY_SHIELD, IMG2_STORM_PREP, IMG2_ACADEMY_DEPARTMENTS, IMG2_APP_EMPTY_BOOKINGS, IMG2_APP_EMPTY_GARAGE, IMG2_APP_ONBOARDING_WELCOME, IMG2_BOOK_OS_INBOX, IMG2_DIRECTORY_STOREFRONT, IMG2_DIRECTORY_TEAM, IMG2_DIRECTORY_VAN_STREET, IMG2_FB_COVER_CLEANOUT_WIDE, IMG2_FB_COVER_CLEANOUT, IMG2_FB_COVER_COCOCANE_WIDE, IMG2_FB_COVER_COCOCANE, IMG2_FB_COVER_REPAIR_WIDE, IMG2_FB_COVER_REPAIR, IMG2_FB_COVER_SALES_WIDE, IMG2_FB_COVER_SALES, IMG2_MARKETING_OS_STUDIO, IMG2_PLUG_EMPTY, IMG2_SERVICE_DISHWASHER, IMG2_SERVICE_DISPOSAL, IMG2_SERVICE_DRYER, IMG2_SERVICE_FREEZER, IMG2_SERVICE_MICROWAVE, IMG2_SERVICE_RANGE, IMG2_SOCIAL_POST_THANKS, IMG2_SOCIAL_POST_TIPS, IMG2_TECH_ONBOARDING, IMG2_TURBO_BOSS_OVERVIEW, IMG2_APP_EMPTY_NOTIFICATIONS, IMG2_APP_EMPTY_PAYMENTS, IMG2_APP_EMPTY_SEARCH, IMG2_CLEANOUT_VENTS_HERO, IMG2_COMMERCIAL_FRIDGE_PRO, IMG2_COMMERCIAL_OVEN_PRO, IMG2_OVERSIGHT_OVERVIEW, IMG2_PEPPERLISTS_EMPTY, IMG2_SERVICE_ICE_MAKER, IMG2_SOCIAL_POST_COMMERCIAL, IMG2_SOCIAL_POST_INSTALL, IMG2_SOCIAL_POST_PEPPERLISTS, IMG2_SOCIAL_POST_SEASONAL, IMG2_COMMERCIAL_ICE_MACHINE, IMG2_PEPPERLISTS_EMPTY_REVIEWS, IMG2_SOCIAL_POST_BEFORE_AFTER, IMG2_SOCIAL_POST_REVIEW_SPOTLIGHT } from '../assets/platformImages2.js';

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
 * its hero + Commercial Track photos here, and the /property-managers
 * page points its service-visit graphic (pm-visit.webp) here.
 * The homepage Symptom Guides fridge card points its banner
 * (guide-fridge.webp) here. Public brand assets.
 */
const SERVICE_IMAGE_FILES = {
  'hero-tech.webp': SERVICE_HERO_WEBP,
  'commercial.webp': SERVICE_COMMERCIAL_WEBP,
  'van-banner.webp': SERVICE_VAN_WEBP,
  'pm-visit.webp': PM_VISIT_WEBP,
  'guide-fridge.webp': GUIDE_FRIDGE_WEBP,
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

const MASCOT_IMAGE_FILES = {
  'mascot-hero.webp': MASCOT_HERO_WEBP,
  'mascot-hero-light.webp': MASCOT_HERO_LIGHT_WEBP,
  'mascot-head.webp': MASCOT_HEAD_WEBP,
};

router.get('/app/mascot-images/:name', (req, res) => {
  const bytes = MASCOT_IMAGE_FILES[req.params.name];
  if (!bytes) return res.status(404).json({ error: 'Image not found' });
  res.set({
    'Content-Type': 'image/webp',
    'Cache-Control': 'public, max-age=86400',
    'Access-Control-Allow-Origin': '*',
  });
  return res.send(bytes);
});

/**
 * Platform illustration pack (2026-11-16): 89 flat-vector category /
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
  'academy-learning.webp': IMG2_ACADEMY_LEARNING,
  'ad-studio-create.webp': IMG2_AD_STUDIO_CREATE,
  'app-garage.webp': IMG2_APP_GARAGE,
  'booking-form-classic.webp': IMG2_BOOKING_FORM_CLASSIC,
  'cococane-juice.webp': IMG2_COCOCANE_JUICE,
  'commercial-work-order.webp': IMG2_COMMERCIAL_WORK_ORDER,
  'delivery-new-appliance.webp': IMG2_DELIVERY_NEW_APPLIANCE,
  'dispatch-setters.webp': IMG2_DISPATCH_SETTERS,
  'emergency-night.webp': IMG2_EMERGENCY_NIGHT,
  'haul-away-recycle.webp': IMG2_HAUL_AWAY_RECYCLE,
  'install-day.webp': IMG2_INSTALL_DAY,
  'live-video-help.webp': IMG2_LIVE_VIDEO_HELP,
  'maintenance-plan.webp': IMG2_MAINTENANCE_PLAN,
  'parts-delivery.webp': IMG2_PARTS_DELIVERY,
  'pm-batch-scheduling.webp': IMG2_PM_BATCH_SCHEDULING,
  'promise-shield.webp': IMG2_PROMISE_SHIELD,
  'quote-approval.webp': IMG2_QUOTE_APPROVAL,
  'reminders-bell.webp': IMG2_REMINDERS_BELL,
  'repair-complete-pay.webp': IMG2_REPAIR_COMPLETE_PAY,
  'scan-serial.webp': IMG2_SCAN_SERIAL,
  'service-history.webp': IMG2_SERVICE_HISTORY,
  'speedy-chat-assistant.webp': IMG2_SPEEDY_CHAT_ASSISTANT,
  'speedy-verify-shield.webp': IMG2_SPEEDY_VERIFY_SHIELD,
  'storm-prep.webp': IMG2_STORM_PREP,
  'academy-departments.webp': IMG2_ACADEMY_DEPARTMENTS,
  'app-empty-bookings.webp': IMG2_APP_EMPTY_BOOKINGS,
  'app-empty-garage.webp': IMG2_APP_EMPTY_GARAGE,
  'app-onboarding-welcome.webp': IMG2_APP_ONBOARDING_WELCOME,
  'book-os-inbox.webp': IMG2_BOOK_OS_INBOX,
  'directory-storefront.webp': IMG2_DIRECTORY_STOREFRONT,
  'directory-team.webp': IMG2_DIRECTORY_TEAM,
  'directory-van-street.webp': IMG2_DIRECTORY_VAN_STREET,
  'fb-cover-cleanout-wide.webp': IMG2_FB_COVER_CLEANOUT_WIDE,
  'fb-cover-cleanout.webp': IMG2_FB_COVER_CLEANOUT,
  'fb-cover-cococane-wide.webp': IMG2_FB_COVER_COCOCANE_WIDE,
  'fb-cover-cococane.webp': IMG2_FB_COVER_COCOCANE,
  'fb-cover-repair-wide.webp': IMG2_FB_COVER_REPAIR_WIDE,
  'fb-cover-repair.webp': IMG2_FB_COVER_REPAIR,
  'fb-cover-sales-wide.webp': IMG2_FB_COVER_SALES_WIDE,
  'fb-cover-sales.webp': IMG2_FB_COVER_SALES,
  'marketing-os-studio.webp': IMG2_MARKETING_OS_STUDIO,
  'plug-empty.webp': IMG2_PLUG_EMPTY,
  'service-dishwasher.webp': IMG2_SERVICE_DISHWASHER,
  'service-disposal.webp': IMG2_SERVICE_DISPOSAL,
  'service-dryer.webp': IMG2_SERVICE_DRYER,
  'service-freezer.webp': IMG2_SERVICE_FREEZER,
  'service-microwave.webp': IMG2_SERVICE_MICROWAVE,
  'service-range.webp': IMG2_SERVICE_RANGE,
  'social-post-thanks.webp': IMG2_SOCIAL_POST_THANKS,
  'social-post-tips.webp': IMG2_SOCIAL_POST_TIPS,
  'tech-onboarding.webp': IMG2_TECH_ONBOARDING,
  'turbo-boss-overview.webp': IMG2_TURBO_BOSS_OVERVIEW,
  'app-empty-notifications.webp': IMG2_APP_EMPTY_NOTIFICATIONS,
  'app-empty-payments.webp': IMG2_APP_EMPTY_PAYMENTS,
  'app-empty-search.webp': IMG2_APP_EMPTY_SEARCH,
  'cleanout-vents-hero.webp': IMG2_CLEANOUT_VENTS_HERO,
  'commercial-fridge-pro.webp': IMG2_COMMERCIAL_FRIDGE_PRO,
  'commercial-oven-pro.webp': IMG2_COMMERCIAL_OVEN_PRO,
  'oversight-overview.webp': IMG2_OVERSIGHT_OVERVIEW,
  'pepperlists-empty.webp': IMG2_PEPPERLISTS_EMPTY,
  'service-ice-maker.webp': IMG2_SERVICE_ICE_MAKER,
  'social-post-commercial.webp': IMG2_SOCIAL_POST_COMMERCIAL,
  'social-post-install.webp': IMG2_SOCIAL_POST_INSTALL,
  'social-post-pepperlists.webp': IMG2_SOCIAL_POST_PEPPERLISTS,
  'social-post-seasonal.webp': IMG2_SOCIAL_POST_SEASONAL,
  'commercial-ice-machine.webp': IMG2_COMMERCIAL_ICE_MACHINE,
  'pepperlists-empty-reviews.webp': IMG2_PEPPERLISTS_EMPTY_REVIEWS,
  'social-post-before-after.webp': IMG2_SOCIAL_POST_BEFORE_AFTER,
  'social-post-review-spotlight.webp': IMG2_SOCIAL_POST_REVIEW_SPOTLIGHT,
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

/**
 * Scenario illustration library — round one, flagship pages
 * (2026-11-16 launch). The 228-scene flat-vector library's scenes are
 * embedded as base64 in assets/scenarioImages.js (same text-only
 * pipeline constraint as the platform images above) and served here
 * as image/webp. Web surfaces reference them same-origin via
 * /api/v1/app/scenario-images/<stem>.webp (vercel.json rewrite).
 * Public brand assets. A later worker extends scenarioImages.js with
 * the app-surface scenes — add their filename -> export rows to the
 * map below.
 */
const SCENARIO_IMAGE_FILES = {
  'need-warm-fridge.webp': SCENE_NEED_WARM_FRIDGE,
  'need-washer-leak.webp': SCENE_NEED_WASHER_LEAK,
  'repair-fridge-diagnosis.webp': SCENE_REPAIR_FRIDGE_DIAGNOSIS,
  'install-delivery-arrival.webp': SCENE_INSTALL_DELIVERY_ARRIVAL,
  'book-calendar-pick.webp': SCENE_BOOK_CALENDAR_PICK,
  'speedy-symptom-guide.webp': SCENE_SPEEDY_SYMPTOM_GUIDE,
  'speedy-photo-fridge.webp': SCENE_SPEEDY_PHOTO_FRIDGE,
  'track-map-phone.webp': SCENE_TRACK_MAP_PHONE,
  'track-doorbell.webp': SCENE_TRACK_DOORBELL,
  'review-stars-phone.webp': SCENE_REVIEW_STARS_PHONE,
  'dispatch-morning-board.webp': SCENE_DISPATCH_MORNING_BOARD,
  'pay-quote-tablet.webp': SCENE_PAY_QUOTE_TABLET,
};

router.get('/app/scenario-images/:name', (req, res) => {
  const bytes = SCENARIO_IMAGE_FILES[req.params.name];
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
