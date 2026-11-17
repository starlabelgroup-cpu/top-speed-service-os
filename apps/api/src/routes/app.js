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
import { LOGO_LOCKUP_A_WEBP, LOGO_LOCKUP_B_WEBP, LOGO_HORSE_HEAD_WEBP } from '../assets/logoImages.js';
import { POSTER_FRIDGE_NOT_COOLING_WEBP, POSTER_SAME_DAY_WEBP, POSTER_WASHER_DRYER_WEBP, POSTER_ASK_SPEEDY_WEBP, POSTER_CITIES_WEBP, POSTER_DIAGNOSTIC_WEBP } from '../assets/posterImages.js';
import { SCENE_NEED_WARM_FRIDGE, SCENE_NEED_WASHER_LEAK, SCENE_REPAIR_FRIDGE_DIAGNOSIS, SCENE_INSTALL_DELIVERY_ARRIVAL, SCENE_BOOK_CALENDAR_PICK, SCENE_SPEEDY_SYMPTOM_GUIDE, SCENE_SPEEDY_PHOTO_FRIDGE, SCENE_TRACK_MAP_PHONE, SCENE_TRACK_DOORBELL, SCENE_REVIEW_STARS_PHONE, SCENE_DISPATCH_MORNING_BOARD, SCENE_PAY_QUOTE_TABLET, SCENE_BOOK_FORM_PHONE, SCENE_NEED_DRYER_NO_HEAT, SCENE_CARE_PLAN_CALENDAR, SCENE_PAY_RECEIPT_PHONE, SCENE_SPEEDY_CHAT_COUCH, SCENE_NEED_RESTAURANT_COOLER_DOWN, SCENE_NEED_LAUNDROMAT_STOPPED, SCENE_COMMERCIAL_RESTAURANT_RANGE, SCENE_COMMERCIAL_LAUNDROMAT_ROWS, SCENE_PAY_COMMERCIAL_PORTAL, SCENE_BOOK_PM_BATCH, SCENE_NEED_NEIGHBOR_DRYER_DIED, SCENE_REVIEW_NEIGHBOR_CHAT, SCENE_REVIEW_REFER_FRIEND, SCENE_NEED_TENANT_DISCOVERY, SCENE_REVIEW_REPEAT_CUSTOMER } from '../assets/scenarioImages.js';
import { SCENE_NEED_OVEN_DEAD_DINNER, SCENE_NEED_FIRST_HOMEOWNER_DISHWASHER, SCENE_NEED_WASHER_WONT_DRAIN, SCENE_NEED_MICROWAVE_DEAD, SCENE_NEED_DISPOSAL_CLOG, SCENE_NEED_FREEZER_THAW, SCENE_STORY_FRIDGE_COOKOUT, SCENE_STORY_LAUNDRY_MOUNTAIN, SCENE_STORY_HOLIDAY_OVEN, SCENE_STORY_BABY_DISHWASHER, SCENE_STORY_QUIET_FRIDGE, SCENE_STORY_MOVE_IN_READY, SCENE_REPAIR_THERMOSTAT_TEST, SCENE_REPAIR_FRIDGE_FAN, SCENE_REPAIR_WASHER_BELT, SCENE_REPAIR_WASHER_PUMP, SCENE_REPAIR_DRYER_HEATING, SCENE_REPAIR_DRYER_ROLLERS, SCENE_REPAIR_OVEN_IGNITER, SCENE_REPAIR_RANGE_BURNER, SCENE_REPAIR_DISHWASHER_SEAL, SCENE_REPAIR_FREEZER_THAW, SCENE_REPAIR_ICE_MAKER_SWAP, SCENE_REPAIR_MICROWAVE_DOOR, SCENE_REPAIR_DISPOSAL_JAM, SCENE_REPAIR_LEAK_HUNT, SCENE_REPAIR_CONTROL_BOARD, SCENE_INSTALL_WASHER_HOOKUP, SCENE_INSTALL_DRYER_VENT_HOOKUP, SCENE_INSTALL_RANGE_GAS, SCENE_INSTALL_DISHWASHER_SLIDE, SCENE_INSTALL_ICE_MAKER_LINE, SCENE_INSTALL_MICROWAVE_MOUNT, SCENE_INSTALL_DISPOSAL_NEW, SCENE_INSTALL_DOOR_MEASURE, SCENE_INSTALL_FRIDGE_LEVEL, SCENE_INSTALL_WATER_LINE, SCENE_INSTALL_FIRST_RUN_WASHER, SCENE_INSTALL_WALKTHROUGH, SCENE_INSTALL_CLEAN_FINISH, SCENE_INSTALL_HAUL_AWAY_OLD, SCENE_TRACK_MORNING_TEXT, SCENE_TRACK_VAN_STREET, SCENE_TRACK_ETA_WINDOW, SCENE_TRACK_STATUS_REPAIR, SCENE_TRACK_WELCOME_HOME, SCENE_TRACK_PORCH_WAVE, SCENE_BOOK_SPEEDY_CHAT, SCENE_BOOK_WINDOW_CHOICE, SCENE_BOOK_CONFIRMATION, SCENE_BOOK_REMINDER_MORNING, SCENE_BOOK_COMMERCIAL_REQUEST, SCENE_BOOK_MULTI_UNIT, SCENE_PAY_APPROVE_TAP, SCENE_PAY_PHONE_TAP, SCENE_PAY_CARD_READER, SCENE_PAY_NO_SURPRISE, SCENE_PAY_OFFICE_BILLING, SCENE_PAY_INVOICE_DOOR, SCENE_PAY_PM_MONTHLY } from '../assets/scenarioImages2.js';
import { SCENE_DISPATCH_ASSIGN_TECH, SCENE_DISPATCH_ROUTE_PLAN, SCENE_DISPATCH_CUSTOMER_UPDATE, SCENE_DISPATCH_EMERGENCY_TRIAGE, SCENE_DISPATCH_TRAFFIC_REROUTE, SCENE_DISPATCH_OVERLAP_SAVE, SCENE_DISPATCH_TEAM_HUDDLE, SCENE_DISPATCH_SHIFT_HANDOVER, SCENE_DISPATCH_FEEDBACK_BOARD, SCENE_DISPATCH_COMMERCIAL_DESK, SCENE_DISPATCH_PM_INTAKE, SCENE_DISPATCH_FOLLOWUP_CALLS, SCENE_DISPATCH_VAN_ROLLOUT, SCENE_DISPATCH_NEW_TECH_WELCOME, SCENE_VENT_LINT_HANDFUL, SCENE_VENT_ROOF_BRUSH, SCENE_VENT_EXTERIOR_WALL, SCENE_VENT_BEFORE_AFTER_DUCT, SCENE_VENT_AIRFLOW_TEST, SCENE_VENT_SAFETY_CHECK, SCENE_VENT_VACUUM_FINISH, SCENE_VENT_CLEAN_AIR_HOME, SCENE_STORY_VENT_SLOW_DRYER, SCENE_STORY_VENT_ONE_CYCLE, SCENE_STORY_VENT_SAFE_HOME, SCENE_STORY_VENT_NEW_HOMEOWNER, SCENE_REVIEW_WALL, SCENE_REVIEW_PHOTO_SNAP, SCENE_REVIEW_VIDEO_TESTIMONIAL, SCENE_REVIEW_COMMENT_THREAD, SCENE_REVIEW_BEFORE_AFTER_POST, SCENE_REVIEW_EVENING_POST, SCENE_REVIEW_KITCHEN_HAPPY, SCENE_REVIEW_THUMBS_UP_DOOR, SCENE_REVIEW_PM_THANKS, SCENE_SPEEDY_PHOTO_WASHER, SCENE_SPEEDY_SERIAL_SCAN, SCENE_SPEEDY_VIDEO_CALL, SCENE_SPEEDY_VOICE_ASK, SCENE_SPEEDY_DIAGNOSIS_RESULT, SCENE_COMMERCIAL_HOTEL_ICE, SCENE_COMMERCIAL_GROCERY_FREEZER, SCENE_COMMERCIAL_DISH_MACHINE, SCENE_COMMERCIAL_PREVENTIVE_ROUND, SCENE_COMMERCIAL_EMERGENCY_NIGHT, SCENE_COMMERCIAL_PM_PORTFOLIO, SCENE_COMMERCIAL_LEASE_TURNOVER, SCENE_CARE_DELIVERY_DOOR, SCENE_CARE_MAINTENANCE_VISIT, SCENE_CARE_FILTER_CHANGE, SCENE_CARE_COIL_CLEAN, SCENE_CARE_WARRANTY_SHIELD, SCENE_CARE_HOSE_CHECK, SCENE_CARE_HOLIDAY_PREP, SCENE_CARE_STORM_READY, SCENE_CARE_SNOWBIRD_RETURN, SCENE_REPAIR_TOOL_BAG_READY, SCENE_REVIEW_STARS_BURST, SCENE_NEED_ICE_MAKER_EMPTY, SCENE_NEED_FRIDGE_NOISE_NIGHT, SCENE_PAY_DIAGNOSTIC_VISIT } from '../assets/scenarioImages3.js';
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
 * Top Speed Appliance logo lockup (2026-11-16): Ramone's new brand
 * lockup artwork, embedded as base64 in assets/logoImages.js (same
 * text-only pipeline constraint as the mascot images above) and
 * served here as image/webp. Web surfaces reference them same-origin
 * via /api/v1/app/logo-images/<name> (vercel.json rewrite).
 * Public brand assets.
 */
const LOGO_IMAGE_FILES = {
  'lockup-a': LOGO_LOCKUP_A_WEBP,
  'lockup-b': LOGO_LOCKUP_B_WEBP,
  'horse-head': LOGO_HORSE_HEAD_WEBP,
  'lockup-a.webp': LOGO_LOCKUP_A_WEBP,
  'lockup-b.webp': LOGO_LOCKUP_B_WEBP,
  'horse-head.webp': LOGO_HORSE_HEAD_WEBP,
};

router.get('/app/logo-images/:name', (req, res) => {
  const bytes = LOGO_IMAGE_FILES[req.params.name];
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
 * (2026-11-16 launch), plus round two (2026-11-17). The flat-vector
 * library's scenes are embedded as base64 in assets/scenarioImages.js
 * (round one) and in assets/scenarioImages2.js +
 * assets/scenarioImages3.js (round two) — same text-only pipeline
 * constraint as the platform images above — and served here as
 * image/webp. Web surfaces reference them same-origin via
 * /api/v1/app/scenario-images/<stem>.webp (vercel.json rewrite).
 * Public brand assets. The app-surface scenes (Appliance Connect
 * /app, Appliance Pro app, Appliance Referral /refer) were added to
 * scenarioImages.js and to the map below in the same round.
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
  'book-form-phone.webp': SCENE_BOOK_FORM_PHONE,
  'need-dryer-no-heat.webp': SCENE_NEED_DRYER_NO_HEAT,
  'care-plan-calendar.webp': SCENE_CARE_PLAN_CALENDAR,
  'pay-receipt-phone.webp': SCENE_PAY_RECEIPT_PHONE,
  'speedy-chat-couch.webp': SCENE_SPEEDY_CHAT_COUCH,
  'need-restaurant-cooler-down.webp': SCENE_NEED_RESTAURANT_COOLER_DOWN,
  'need-laundromat-stopped.webp': SCENE_NEED_LAUNDROMAT_STOPPED,
  'commercial-restaurant-range.webp': SCENE_COMMERCIAL_RESTAURANT_RANGE,
  'commercial-laundromat-rows.webp': SCENE_COMMERCIAL_LAUNDROMAT_ROWS,
  'pay-commercial-portal.webp': SCENE_PAY_COMMERCIAL_PORTAL,
  'book-pm-batch.webp': SCENE_BOOK_PM_BATCH,
  'need-neighbor-dryer-died.webp': SCENE_NEED_NEIGHBOR_DRYER_DIED,
  'review-neighbor-chat.webp': SCENE_REVIEW_NEIGHBOR_CHAT,
  'review-refer-friend.webp': SCENE_REVIEW_REFER_FRIEND,
  'need-tenant-discovery.webp': SCENE_NEED_TENANT_DISCOVERY,
  'review-repeat-customer.webp': SCENE_REVIEW_REPEAT_CUSTOMER,
  'need-oven-dead-dinner.webp': SCENE_NEED_OVEN_DEAD_DINNER,
  'need-first-homeowner-dishwasher.webp': SCENE_NEED_FIRST_HOMEOWNER_DISHWASHER,
  'need-washer-wont-drain.webp': SCENE_NEED_WASHER_WONT_DRAIN,
  'need-microwave-dead.webp': SCENE_NEED_MICROWAVE_DEAD,
  'need-disposal-clog.webp': SCENE_NEED_DISPOSAL_CLOG,
  'need-freezer-thaw.webp': SCENE_NEED_FREEZER_THAW,
  'story-fridge-cookout.webp': SCENE_STORY_FRIDGE_COOKOUT,
  'story-laundry-mountain.webp': SCENE_STORY_LAUNDRY_MOUNTAIN,
  'story-holiday-oven.webp': SCENE_STORY_HOLIDAY_OVEN,
  'story-baby-dishwasher.webp': SCENE_STORY_BABY_DISHWASHER,
  'story-quiet-fridge.webp': SCENE_STORY_QUIET_FRIDGE,
  'story-move-in-ready.webp': SCENE_STORY_MOVE_IN_READY,
  'repair-thermostat-test.webp': SCENE_REPAIR_THERMOSTAT_TEST,
  'repair-fridge-fan.webp': SCENE_REPAIR_FRIDGE_FAN,
  'repair-washer-belt.webp': SCENE_REPAIR_WASHER_BELT,
  'repair-washer-pump.webp': SCENE_REPAIR_WASHER_PUMP,
  'repair-dryer-heating.webp': SCENE_REPAIR_DRYER_HEATING,
  'repair-dryer-rollers.webp': SCENE_REPAIR_DRYER_ROLLERS,
  'repair-oven-igniter.webp': SCENE_REPAIR_OVEN_IGNITER,
  'repair-range-burner.webp': SCENE_REPAIR_RANGE_BURNER,
  'repair-dishwasher-seal.webp': SCENE_REPAIR_DISHWASHER_SEAL,
  'repair-freezer-thaw.webp': SCENE_REPAIR_FREEZER_THAW,
  'repair-ice-maker-swap.webp': SCENE_REPAIR_ICE_MAKER_SWAP,
  'repair-microwave-door.webp': SCENE_REPAIR_MICROWAVE_DOOR,
  'repair-disposal-jam.webp': SCENE_REPAIR_DISPOSAL_JAM,
  'repair-leak-hunt.webp': SCENE_REPAIR_LEAK_HUNT,
  'repair-control-board.webp': SCENE_REPAIR_CONTROL_BOARD,
  'install-washer-hookup.webp': SCENE_INSTALL_WASHER_HOOKUP,
  'install-dryer-vent-hookup.webp': SCENE_INSTALL_DRYER_VENT_HOOKUP,
  'install-range-gas.webp': SCENE_INSTALL_RANGE_GAS,
  'install-dishwasher-slide.webp': SCENE_INSTALL_DISHWASHER_SLIDE,
  'install-ice-maker-line.webp': SCENE_INSTALL_ICE_MAKER_LINE,
  'install-microwave-mount.webp': SCENE_INSTALL_MICROWAVE_MOUNT,
  'install-disposal-new.webp': SCENE_INSTALL_DISPOSAL_NEW,
  'install-door-measure.webp': SCENE_INSTALL_DOOR_MEASURE,
  'install-fridge-level.webp': SCENE_INSTALL_FRIDGE_LEVEL,
  'install-water-line.webp': SCENE_INSTALL_WATER_LINE,
  'install-first-run-washer.webp': SCENE_INSTALL_FIRST_RUN_WASHER,
  'install-walkthrough.webp': SCENE_INSTALL_WALKTHROUGH,
  'install-clean-finish.webp': SCENE_INSTALL_CLEAN_FINISH,
  'install-haul-away-old.webp': SCENE_INSTALL_HAUL_AWAY_OLD,
  'track-morning-text.webp': SCENE_TRACK_MORNING_TEXT,
  'track-van-street.webp': SCENE_TRACK_VAN_STREET,
  'track-eta-window.webp': SCENE_TRACK_ETA_WINDOW,
  'track-status-repair.webp': SCENE_TRACK_STATUS_REPAIR,
  'track-welcome-home.webp': SCENE_TRACK_WELCOME_HOME,
  'track-porch-wave.webp': SCENE_TRACK_PORCH_WAVE,
  'book-speedy-chat.webp': SCENE_BOOK_SPEEDY_CHAT,
  'book-window-choice.webp': SCENE_BOOK_WINDOW_CHOICE,
  'book-confirmation.webp': SCENE_BOOK_CONFIRMATION,
  'book-reminder-morning.webp': SCENE_BOOK_REMINDER_MORNING,
  'book-commercial-request.webp': SCENE_BOOK_COMMERCIAL_REQUEST,
  'book-multi-unit.webp': SCENE_BOOK_MULTI_UNIT,
  'pay-approve-tap.webp': SCENE_PAY_APPROVE_TAP,
  'pay-phone-tap.webp': SCENE_PAY_PHONE_TAP,
  'pay-card-reader.webp': SCENE_PAY_CARD_READER,
  'pay-no-surprise.webp': SCENE_PAY_NO_SURPRISE,
  'pay-office-billing.webp': SCENE_PAY_OFFICE_BILLING,
  'pay-invoice-door.webp': SCENE_PAY_INVOICE_DOOR,
  'pay-pm-monthly.webp': SCENE_PAY_PM_MONTHLY,
  'dispatch-assign-tech.webp': SCENE_DISPATCH_ASSIGN_TECH,
  'dispatch-route-plan.webp': SCENE_DISPATCH_ROUTE_PLAN,
  'dispatch-customer-update.webp': SCENE_DISPATCH_CUSTOMER_UPDATE,
  'dispatch-emergency-triage.webp': SCENE_DISPATCH_EMERGENCY_TRIAGE,
  'dispatch-traffic-reroute.webp': SCENE_DISPATCH_TRAFFIC_REROUTE,
  'dispatch-overlap-save.webp': SCENE_DISPATCH_OVERLAP_SAVE,
  'dispatch-team-huddle.webp': SCENE_DISPATCH_TEAM_HUDDLE,
  'dispatch-shift-handover.webp': SCENE_DISPATCH_SHIFT_HANDOVER,
  'dispatch-feedback-board.webp': SCENE_DISPATCH_FEEDBACK_BOARD,
  'dispatch-commercial-desk.webp': SCENE_DISPATCH_COMMERCIAL_DESK,
  'dispatch-pm-intake.webp': SCENE_DISPATCH_PM_INTAKE,
  'dispatch-followup-calls.webp': SCENE_DISPATCH_FOLLOWUP_CALLS,
  'dispatch-van-rollout.webp': SCENE_DISPATCH_VAN_ROLLOUT,
  'dispatch-new-tech-welcome.webp': SCENE_DISPATCH_NEW_TECH_WELCOME,
  'vent-lint-handful.webp': SCENE_VENT_LINT_HANDFUL,
  'vent-roof-brush.webp': SCENE_VENT_ROOF_BRUSH,
  'vent-exterior-wall.webp': SCENE_VENT_EXTERIOR_WALL,
  'vent-before-after-duct.webp': SCENE_VENT_BEFORE_AFTER_DUCT,
  'vent-airflow-test.webp': SCENE_VENT_AIRFLOW_TEST,
  'vent-safety-check.webp': SCENE_VENT_SAFETY_CHECK,
  'vent-vacuum-finish.webp': SCENE_VENT_VACUUM_FINISH,
  'vent-clean-air-home.webp': SCENE_VENT_CLEAN_AIR_HOME,
  'story-vent-slow-dryer.webp': SCENE_STORY_VENT_SLOW_DRYER,
  'story-vent-one-cycle.webp': SCENE_STORY_VENT_ONE_CYCLE,
  'story-vent-safe-home.webp': SCENE_STORY_VENT_SAFE_HOME,
  'story-vent-new-homeowner.webp': SCENE_STORY_VENT_NEW_HOMEOWNER,
  'review-wall.webp': SCENE_REVIEW_WALL,
  'review-photo-snap.webp': SCENE_REVIEW_PHOTO_SNAP,
  'review-video-testimonial.webp': SCENE_REVIEW_VIDEO_TESTIMONIAL,
  'review-comment-thread.webp': SCENE_REVIEW_COMMENT_THREAD,
  'review-before-after-post.webp': SCENE_REVIEW_BEFORE_AFTER_POST,
  'review-evening-post.webp': SCENE_REVIEW_EVENING_POST,
  'review-kitchen-happy.webp': SCENE_REVIEW_KITCHEN_HAPPY,
  'review-thumbs-up-door.webp': SCENE_REVIEW_THUMBS_UP_DOOR,
  'review-pm-thanks.webp': SCENE_REVIEW_PM_THANKS,
  'speedy-photo-washer.webp': SCENE_SPEEDY_PHOTO_WASHER,
  'speedy-serial-scan.webp': SCENE_SPEEDY_SERIAL_SCAN,
  'speedy-video-call.webp': SCENE_SPEEDY_VIDEO_CALL,
  'speedy-voice-ask.webp': SCENE_SPEEDY_VOICE_ASK,
  'speedy-diagnosis-result.webp': SCENE_SPEEDY_DIAGNOSIS_RESULT,
  'commercial-hotel-ice.webp': SCENE_COMMERCIAL_HOTEL_ICE,
  'commercial-grocery-freezer.webp': SCENE_COMMERCIAL_GROCERY_FREEZER,
  'commercial-dish-machine.webp': SCENE_COMMERCIAL_DISH_MACHINE,
  'commercial-preventive-round.webp': SCENE_COMMERCIAL_PREVENTIVE_ROUND,
  'commercial-emergency-night.webp': SCENE_COMMERCIAL_EMERGENCY_NIGHT,
  'commercial-pm-portfolio.webp': SCENE_COMMERCIAL_PM_PORTFOLIO,
  'commercial-lease-turnover.webp': SCENE_COMMERCIAL_LEASE_TURNOVER,
  'care-delivery-door.webp': SCENE_CARE_DELIVERY_DOOR,
  'care-maintenance-visit.webp': SCENE_CARE_MAINTENANCE_VISIT,
  'care-filter-change.webp': SCENE_CARE_FILTER_CHANGE,
  'care-coil-clean.webp': SCENE_CARE_COIL_CLEAN,
  'care-warranty-shield.webp': SCENE_CARE_WARRANTY_SHIELD,
  'care-hose-check.webp': SCENE_CARE_HOSE_CHECK,
  'care-holiday-prep.webp': SCENE_CARE_HOLIDAY_PREP,
  'care-storm-ready.webp': SCENE_CARE_STORM_READY,
  'care-snowbird-return.webp': SCENE_CARE_SNOWBIRD_RETURN,
  'repair-tool-bag-ready.webp': SCENE_REPAIR_TOOL_BAG_READY,
  'review-stars-burst.webp': SCENE_REVIEW_STARS_BURST,
  'need-ice-maker-empty.webp': SCENE_NEED_ICE_MAKER_EMPTY,
  'need-fridge-noise-night.webp': SCENE_NEED_FRIDGE_NOISE_NIGHT,
  'pay-diagnostic-visit.webp': SCENE_PAY_DIAGNOSTIC_VISIT,
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

/**
 * Homepage poster set (2026-11-16): the six posters from Ramone's
 * approved mockup — built for the topspeedappliance.net homepage and
 * placed on the flagship Service OS homepage at his direction.
 * Embedded as base64 in assets/posterImages.js (same text-only
 * pipeline constraint as above) and served here as image/webp. Web
 * surfaces reference them same-origin via
 * /api/v1/app/poster-images/<file> (vercel.json rewrite).
 * Public brand assets.
 */
const POSTER_IMAGE_FILES = {
  'visual-fridge-not-cooling.webp': POSTER_FRIDGE_NOT_COOLING_WEBP,
  'visual-same-day.webp': POSTER_SAME_DAY_WEBP,
  'visual-washer-dryer.webp': POSTER_WASHER_DRYER_WEBP,
  'visual-ask-speedy.webp': POSTER_ASK_SPEEDY_WEBP,
  'visual-cities.webp': POSTER_CITIES_WEBP,
  'visual-diagnostic.webp': POSTER_DIAGNOSTIC_WEBP,
};

router.get('/app/poster-images/:name', (req, res) => {
  const bytes = POSTER_IMAGE_FILES[req.params.name];
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
