import {
  facebookOsAdsRepo,
  facebookOsPostsRepo,
  facebookOsSyndicationRepo,
} from '../db/facebookOsRepo.js';
import { MEDIA_FACEBOOK_PAGE, mediaFacebookConnectionState } from './mediaFacebook.js';
import { claimCheckError, findClaimViolations } from './claimCheck.js';
import { offerVisualKey, pepperVisualUrl, postVisualKey } from './pepperVisualUrl.js';

/**
 * Top Speed Facebook OS Manager (2026-11-23) — the streaming posts +
 * advertisements system Ramone directed: a database-backed stream of
 * posts and ad drafts for the official Top Speed Appliance Facebook
 * Page, integrated with Top Speed Posts by Pepper, with Facebook Ads
 * (as drafts + reads), and with every Service OS surface.
 *
 * THE HONEST PIPELINE (the MediaFacebookPost model, extended):
 * there is NO server-side Facebook write anywhere in this system and
 * this service creates none. The stream PREPARES and QUEUES; Pepper
 * publishes through Ramone's connected Facebook account behind his
 * per-post approval card; staff record the real outcome here. A post
 * reaches POSTED only with its real facebook.com URL.
 *
 * PAGE INTEGRATION, BOTH DIRECTIONS: OUT — this queue is what the
 * Page publishes. IN — the server holds no Facebook credential, so
 * the Page's real published activity is read back from the POSTED
 * rows of this very table (the recorded-posts registry): every post
 * published through Pepper is recorded with its real URL, and the
 * console Page Activity view + the public feed serve from those
 * records. Nothing about Page activity is ever fabricated.
 *
 * FACEBOOK ADS BOUNDARY: Meta has API writes DISABLED on the
 * connected ad account (834084027055828). Ad drafts here are
 * planning records (DRAFT/PAUSED, recorded-only spend). Nothing in
 * this service enables, funds, or launches an ad; that happens only
 * by Ramone in Ads Manager. Zero-spend organic stands.
 */

// The Page's canonical public URL (established via the Facebook
// connector 2026-11-23): the profile-id form of the SAME Page the
// Media OS constant names by its page id — one Page, two ids. The
// fleet's schema/footer link alignment (flagship 348488d) uses this
// URL, so the Facebook OS presents it too.
export const FACEBOOK_OS_PAGE = {
  ...MEDIA_FACEBOOK_PAGE,
  url: 'https://www.facebook.com/profile.php?id=61596590488055',
};

export const POST_STATUSES = [
  'DRAFT', 'PENDING_APPROVAL', 'SCHEDULED', 'POSTED', 'REJECTED', 'ARCHIVED',
];

export const POST_FORMATS = [
  'REPAIR_SPOTLIGHT', 'SPEEDY_TIP', 'REWARDS_SAVINGS',
  'CITY_SPOTLIGHT', 'QUICK_TIP', 'REVIEW_INVITE',
  'AD_IDEA', 'ANNOUNCEMENT', 'CUSTOM',
];

export const AD_DRAFT_STATUSES = ['DRAFT', 'PAUSED', 'ARCHIVED'];

export const SYNDICATION_STATUSES = ['PLANNED', 'LIVE', 'REMOVED'];

/** The fleet surfaces a posted stream post can be carried on. */
export const SYNDICATION_SURFACES = [
  'flagship-home',
  'city-pages',
  'customer-app',
  'pepper-lists',
  'topspeedappliance-net',
  'topspeedapplianceservice-com',
  'browardapplianceservice-com',
  'totalhomeappliance-com',
  'appliancepro-net',
  'ads-os-app',
];

/**
 * The 7-slot weekly cadence (Ramone, 2026-11-23: "I must see posts
 * everyday"). The 3 series posts from the Top Speed Posts by Pepper
 * bible plus the 4 rotating daily formats. dayOffset is days after
 * the week's Monday. This is the queue's planning shape — the weekly
 * production registers real drafts against these slots; nothing here
 * publishes anything.
 */
export const WEEKLY_SLOTS = [
  { dayOffset: 0, format: 'REPAIR_SPOTLIGHT', label: 'Post A — Repair Spotlight (series)', series: true },
  { dayOffset: 1, format: 'CITY_SPOTLIGHT', label: 'City Spotlight — a real service in a real covered city', series: false },
  { dayOffset: 2, format: 'SPEEDY_TIP', label: 'Post B — Speedy Tip (series)', series: true },
  { dayOffset: 3, format: 'QUICK_TIP', label: 'Quick Tip', series: false },
  { dayOffset: 4, format: 'REWARDS_SAVINGS', label: 'Post C — Rewards & Savings (series)', series: true },
  { dayOffset: 5, format: 'REVIEW_INVITE', label: 'Review invite — the real review link only', series: false },
  { dayOffset: 6, format: 'REWARDS_SAVINGS', label: 'Rewards explainer rotation', series: false },
];

const TRANSITIONS = {
  DRAFT: ['PENDING_APPROVAL', 'ARCHIVED'],
  PENDING_APPROVAL: ['SCHEDULED', 'DRAFT', 'REJECTED'],
  SCHEDULED: ['POSTED', 'DRAFT', 'ARCHIVED'],
  POSTED: ['ARCHIVED'],
  REJECTED: ['DRAFT', 'ARCHIVED'],
  ARCHIVED: [],
};

function fail(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

const FACEBOOK_HOSTS = ['facebook.com', 'www.facebook.com', 'm.facebook.com', 'fb.watch', 'fb.com'];

export function isRealFacebookUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    return FACEBOOK_HOSTS.includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

// ─── Stream posts ───────────────────────────────────────────────────

export async function createStreamPost(input, actorId) {
  if (!input?.title?.trim()) throw fail(400, 'TITLE_REQUIRED', 'A stream post needs a title');
  if (!input?.copy?.trim()) throw fail(400, 'COPY_REQUIRED', 'A stream post needs copy');
  // Claim-check gate (Flywheel Item 6): hand-written queue copy
  // passes the same gate the Campaign Engine's factory enforces.
  const claimViolations = findClaimViolations([
    ['title', input.title],
    ['copy', input.copy],
  ]);
  if (claimViolations.length) throw claimCheckError(claimViolations);
  if (input.format && !POST_FORMATS.includes(input.format)) {
    throw fail(400, 'FORMAT_INVALID', `Unknown post format: ${input.format}`);
  }
  return facebookOsPostsRepo.create({
    seriesKey: input.seriesKey ?? null,
    seriesWeek: input.seriesWeek ?? null,
    format: input.format || 'CUSTOM',
    title: String(input.title).trim(),
    copy: String(input.copy),
    mediaUrl: input.mediaUrl ?? null,
    mediaKind: input.mediaKind ?? null,
    linkUrl: input.linkUrl ?? null,
    pageId: input.pageId || FACEBOOK_OS_PAGE.id,
    pageName: input.pageName || 'Top Speed Appliance Repair and Installation',
    scheduledFor: input.scheduledFor ?? null,
    statusNote: input.statusNote ?? null,
    createdById: actorId ?? null,
  });
}

export async function transitionStreamPost(id, toStatus, options = {}, actorId) {
  if (!POST_STATUSES.includes(toStatus)) {
    throw fail(400, 'STATUS_INVALID', `Unknown post status: ${toStatus}`);
  }
  const post = await facebookOsPostsRepo.findById(id);
  if (!post) throw fail(404, 'POST_NOT_FOUND', 'Stream post not found');
  const allowed = TRANSITIONS[post.status] || [];
  if (!allowed.includes(toStatus)) {
    throw fail(409, 'TRANSITION_NOT_ALLOWED', `A ${post.status} post cannot move to ${toStatus}`);
  }
  const data = { status: toStatus, updatedById: actorId ?? null };
  if (options.statusNote !== undefined) data.statusNote = options.statusNote;
  if (toStatus === 'SCHEDULED') {
    const scheduledFor = options.scheduledFor || post.scheduledFor;
    if (!scheduledFor) {
      throw fail(400, 'SCHEDULE_REQUIRED', 'A post can only be scheduled with a scheduled time');
    }
    data.scheduledFor = new Date(scheduledFor);
  }
  if (toStatus === 'POSTED') {
    // The honesty gate: POSTED exists only with the real post URL.
    if (!isRealFacebookUrl(options.facebookUrl)) {
      throw fail(
        400,
        'FACEBOOK_URL_REQUIRED',
        'A post can be marked POSTED only with its real facebook.com post URL',
      );
    }
    data.facebookUrl = String(options.facebookUrl).trim();
    data.facebookPostId = options.facebookPostId ?? post.facebookPostId ?? null;
    data.postedAt = new Date();
  }
  return facebookOsPostsRepo.transition(id, data);
}

/**
 * Register one week of Top Speed Posts by Pepper production as
 * DRAFTS. Accepts the 3 series posts and/or the week's daily-slot
 * posts — each item is a stream post draft. Idempotent per
 * (seriesKey, seriesWeek, format, title): re-registering the same
 * week returns the existing rows as duplicates instead of doubling
 * the queue. Nothing here approves, schedules, or publishes.
 */
export async function ingestSeriesWeek({ seriesKey, seriesWeek, posts }, actorId) {
  if (!seriesKey || typeof seriesKey !== 'string') {
    throw fail(400, 'SERIES_KEY_REQUIRED', 'Series ingestion needs a seriesKey');
  }
  if (!Number.isInteger(seriesWeek) || seriesWeek < 1) {
    throw fail(400, 'SERIES_WEEK_REQUIRED', 'Series ingestion needs a positive integer seriesWeek');
  }
  if (!Array.isArray(posts) || posts.length === 0) {
    throw fail(400, 'POSTS_REQUIRED', 'Series ingestion needs at least one post');
  }
  const created = [];
  const duplicates = [];
  for (const item of posts) {
    if (!item?.title?.trim() || !item?.copy?.trim()) {
      throw fail(400, 'POST_INVALID', 'Every ingested post needs a title and copy');
    }
    const format = item.format || 'CUSTOM';
    if (!POST_FORMATS.includes(format)) {
      throw fail(400, 'FORMAT_INVALID', `Unknown post format: ${format}`);
    }
    const existing = await facebookOsPostsRepo.findSeriesInstallment(
      seriesKey, seriesWeek, format, String(item.title).trim(),
    );
    if (existing) {
      duplicates.push(existing);
      continue;
    }
    created.push(await createStreamPost({ ...item, seriesKey, seriesWeek, format }, actorId));
  }
  return { seriesKey, seriesWeek, created, duplicates };
}

/** Installments grouped by series week, newest week first. */
export async function listSeriesInstallments(seriesKey) {
  const rows = await facebookOsPostsRepo.list({ seriesKey, limit: 500 });
  const weeks = new Map();
  for (const row of rows) {
    const key = row.seriesWeek ?? 0;
    if (!weeks.has(key)) weeks.set(key, { seriesWeek: row.seriesWeek, posts: [] });
    weeks.get(key).posts.push(row);
  }
  return [...weeks.values()].sort((a, b) => (b.seriesWeek ?? 0) - (a.seriesWeek ?? 0));
}

// ─── Today's post + queue summary ───────────────────────────────────

function etDayBounds(now = new Date()) {
  // America/New_York calendar day containing `now`, as UTC instants.
  // The zone's own offset for that date (EST or EDT) is read from
  // Intl so the boundary is right across DST changes.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    timeZoneName: 'shortOffset',
  }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type).value;
  const offsetLabel = get('timeZoneName'); // e.g. "GMT-5" / "GMT-4"
  const match = /GMT([+-]\d{1,2})(?::(\d{2}))?/.exec(offsetLabel || '');
  const offsetHours = match ? Number(match[1]) : -5;
  const offsetMins = match && match[2] ? Number(match[2]) * Math.sign(offsetHours || -1) : 0;
  const startUtcMs = Date.UTC(Number(get('year')), Number(get('month')) - 1, Number(get('day')))
    - (offsetHours * 60 + offsetMins) * 60 * 1000;
  const start = new Date(startUtcMs);
  const end = new Date(startUtcMs + 24 * 60 * 60 * 1000);
  return { start, end };
}

export async function todaysPosts(now = new Date()) {
  const { start, end } = etDayBounds(now);
  const scheduled = await facebookOsPostsRepo.list({ status: 'SCHEDULED', limit: 500 });
  const posted = await facebookOsPostsRepo.list({ status: 'POSTED', limit: 500 });
  const inDay = (row, field) => {
    if (!row[field]) return false;
    const t = new Date(row[field]).getTime();
    return t >= start.getTime() && t < end.getTime();
  };
  return {
    date: start.toISOString(),
    scheduled: scheduled.filter((r) => inDay(r, 'scheduledFor')),
    posted: posted.filter((r) => inDay(r, 'postedAt')),
  };
}

export async function queueSummary(now = new Date()) {
  const [postCounts, adCounts, next, today, posted] = await Promise.all([
    facebookOsPostsRepo.countsByStatus(),
    facebookOsAdsRepo.countsByStatus(),
    facebookOsPostsRepo.nextScheduled(now.toISOString()),
    todaysPosts(now),
    facebookOsPostsRepo.listPosted(1),
  ]);
  const posts = Object.fromEntries(POST_STATUSES.map((s) => [s, postCounts[s] || 0]));
  const ads = Object.fromEntries(AD_DRAFT_STATUSES.map((s) => [s, adCounts[s] || 0]));
  return {
    generatedAt: now.toISOString(),
    page: { id: FACEBOOK_OS_PAGE.id, name: FACEBOOK_OS_PAGE.name, url: FACEBOOK_OS_PAGE.url },
    posts,
    adDrafts: ads,
    postedTotal: posts.POSTED,
    latestPostedAt: posted[0]?.postedAt ?? null,
    nextScheduled: next
      ? { id: next.id, title: next.title, format: next.format, scheduledFor: next.scheduledFor }
      : null,
    today: {
      date: today.date,
      scheduled: today.scheduled.map((r) => ({ id: r.id, title: r.title, format: r.format, scheduledFor: r.scheduledFor })),
      posted: today.posted.map((r) => ({ id: r.id, title: r.title, format: r.format, facebookUrl: r.facebookUrl, postedAt: r.postedAt })),
    },
    weeklySlots: WEEKLY_SLOTS,
  };
}

// ─── Page activity (the recorded-posts registry, read IN) ───────────

/**
 * The official Page's real published activity as Service OS knows
 * it: the POSTED stream records, each carrying the real facebook.com
 * URL recorded when Pepper published it behind Ramone's approval.
 * This is a registry of recorded outcomes — never a fabricated feed.
 */
export async function pageActivity(limit = 20) {
  const rows = await facebookOsPostsRepo.listPosted(limit);
  return {
    page: { id: FACEBOOK_OS_PAGE.id, name: FACEBOOK_OS_PAGE.name, url: FACEBOOK_OS_PAGE.url },
    source: 'recorded-posts-registry',
    note: 'Every entry is a post Pepper published through the connected Facebook account behind Ramone\'s approval, recorded with its real URL. The API server holds no Facebook credential, so Page activity is served from these records — never invented.',
    posts: rows.map((row) => ({
      id: row.id,
      title: row.title,
      format: row.format,
      seriesKey: row.seriesKey,
      seriesWeek: row.seriesWeek,
      facebookUrl: row.facebookUrl,
      facebookPostId: row.facebookPostId,
      postedAt: row.postedAt,
      mediaUrl: row.mediaUrl,
    })),
  };
}

// ─── Public feed (POSTED only, Rule 1 deep links) ───────────────────

export async function publicFeed(limit = 10) {
  const rows = await facebookOsPostsRepo.listPosted(limit);
  const posts = [];
  for (const row of rows) {
    const syndication = await facebookOsSyndicationRepo.list({ postId: row.id, status: 'LIVE' });
    posts.push({
      id: row.id,
      title: row.title,
      copy: row.copy,
      format: row.format,
      seriesKey: row.seriesKey,
      seriesWeek: row.seriesWeek,
      mediaUrl: row.mediaUrl,
      mediaKind: row.mediaKind,
      // Rule 1: the link goes to the post itself — the real Facebook
      // post — never to a homepage.
      url: row.facebookUrl,
      postedAt: row.postedAt,
      page: { name: row.pageName, url: FACEBOOK_OS_PAGE.url },
      carriedOn: syndication.map((s) => ({ surface: s.surface, deepLink: s.deepLink })),
    });
  }
  return { generatedAt: new Date().toISOString(), page: { id: FACEBOOK_OS_PAGE.id, name: FACEBOOK_OS_PAGE.name, url: FACEBOOK_OS_PAGE.url }, posts };
}

// ─── Top Speed Ads streaming (public attraction stream) ─────────────

/**
 * The standing offers the attraction stream carries as DATA. These
 * are the platform's own published terms, stated exactly as the
 * flagship itself publishes them — the rate card from the homepage
 * flat-pricing block (and the payments configuration's $99
 * diagnostic) and the referral terms from the /refer page. They are
 * standing offers, not metrics: no counts, no results, nothing
 * estimated. If the published terms ever change, this block is
 * updated in the same change — the stream never advertises a price
 * or a reward the platform does not actually offer.
 */
export const ADS_STREAM_OFFERS = [
  {
    key: 'rate-card',
    kind: 'RATE_CARD',
    title: 'Flat-rate pricing — no surprises',
    lines: [
      '$99 residential diagnostic, collected at booking and credited toward an approved repair',
      'Repair labor $210 flat · Installation labor $150 flat',
      'Parts & materials at written quote — no work without your approved written quote',
      'Commercial service is priced by custom quote',
    ],
    cta: { label: 'Book a repair', url: 'https://topspeedserviceos.com/book' },
  },
  {
    key: 'referral-rewards',
    kind: 'REFERRAL',
    title: 'Refer & earn — Top Speed referral rewards',
    lines: [
      '$25 service credit for each friend whose job is completed and paid',
      '$35 each from your 5th through 9th completed referral · $50 each from your 10th on',
      'One-time bonuses: $100 at 10 lifetime referrals · $250 at 25',
      'Your friend gets $25 off their first repair · Credits expire 12 months after the day they are issued',
    ],
    cta: { label: 'Get your referral link', url: 'https://topspeedserviceos.com/refer' },
  },
];

/**
 * Which stream formats count as ads. AD_IDEA is the stream's ad
 * format, and CUSTOM is what the console actually recorded the
 * published ads-style posts under (verified against the live feed
 * on 2026-11-23: Brand Master, Rate Card, 9 Services, Speedy AI
 * and Referral ads all carry format CUSTOM). POSTED records are
 * immutable by design, so those posts can never be re-tagged —
 * the stream serves both formats or it never shows the real ads.
 */
export const ADS_STREAM_FORMATS = ['AD_IDEA', 'CUSTOM'];

/**
 * The public advertising stream (Top Speed Ads, 2026-11-23): the
 * POSTED stream posts in the ad formats (see ADS_STREAM_FORMATS) —
 * the ads-style posts Pepper published on the official Page behind
 * Ramone's approval, each carrying its real facebook.com URL
 * (Rule 1) — plus the standing offer cards above. POSTED only,
 * exactly like the feed: drafts and queued posts never appear
 * here, and when no ad post has been posted yet the posts list is
 * honestly empty (the offer cards still render — they are standing
 * offers, not posts).
 */
export async function adsStream(limit = 10) {
  const rows = (await facebookOsPostsRepo.listPosted(50)).filter((r) => ADS_STREAM_FORMATS.includes(r.format));
  const posts = [];
  for (const row of rows.slice(0, limit)) {
    const syndication = await facebookOsSyndicationRepo.list({ postId: row.id, status: 'LIVE' });
    posts.push({
      id: row.id,
      title: row.title,
      copy: row.copy,
      format: row.format,
      mediaUrl: row.mediaUrl,
      mediaKind: row.mediaKind,
      // Pepper visual (2026-11-23): every stream item carries the
      // URL of its designed Pepper graphic. The renderer prefers a
      // real mediaUrl when the record has one; the visual is the
      // guaranteed graphic for the records that don't (today, all
      // of them — the stream rendered text-only before this).
      visual: pepperVisualUrl(postVisualKey(row), 'landscape'),
      // Rule 1: the card links to the ad post itself on Facebook.
      url: row.facebookUrl,
      postedAt: row.postedAt,
      page: { name: row.pageName, url: FACEBOOK_OS_PAGE.url },
      carriedOn: syndication.map((s) => ({ surface: s.surface, deepLink: s.deepLink })),
    });
  }
  return {
    generatedAt: new Date().toISOString(),
    page: { id: FACEBOOK_OS_PAGE.id, name: FACEBOOK_OS_PAGE.name, url: FACEBOOK_OS_PAGE.url },
    // Standing offers carry their Pepper visual too — the offer
    // cards were the stream's other text-only surface.
    offers: ADS_STREAM_OFFERS.map((offer) => ({
      ...offer,
      visual: pepperVisualUrl(offerVisualKey(offer), 'landscape'),
    })),
    posts,
  };
}

/**
 * The Ads OS platforms-feed section for the streaming system:
 * counts from the same repos the console reads — how many ad-format
 * posts are POSTED, when the latest went up, and on how many fleet
 * surfaces the stream is carried LIVE (syndication rows). Counts
 * and labels only, like every other section of that feed.
 */
export async function adsStreamCounts() {
  const posted = (await facebookOsPostsRepo.listPosted(500)).filter((r) => ADS_STREAM_FORMATS.includes(r.format));
  const live = await facebookOsSyndicationRepo.list({ status: 'LIVE', limit: 1000 });
  const postedIds = new Set(posted.map((r) => r.id));
  const adSurfaces = new Set(live.filter((s) => postedIds.has(s.postId)).map((s) => s.surface));
  const allSurfaces = new Set(live.map((s) => s.surface));
  return {
    adPostsPosted: posted.length,
    latestAdPostedAt: posted[0]?.postedAt ?? null,
    adStreamSurfacesLive: adSurfaces.size,
    streamSurfacesLive: allSurfaces.size,
    surfacesKnown: SYNDICATION_SURFACES.length,
  };
}

// ─── Facebook Ads (drafts + the honest boundary) ────────────────────

export const META_ADS_BOUNDARY = {
  adAccountId: '834084027055828',
  apiWrites: 'DISABLED_BY_META',
  adsManagerUrl: 'https://business.facebook.com/adsmanager/manage/campaigns?act=834084027055828',
  note: 'Meta has API writes disabled on this ad account: campaigns cannot be created, enabled, or funded from Service OS. Drafts here are planning records with recorded-only spend; Ramone creates and enables the real campaigns in Ads Manager. Zero-spend organic stands.',
};

export function metaAdsState() {
  return {
    connection: mediaFacebookConnectionState(),
    ads: META_ADS_BOUNDARY,
  };
}

export async function createAdDraft(input, actorId) {
  if (!input?.name?.trim()) throw fail(400, 'NAME_REQUIRED', 'An ad draft needs a name');
  if (!input?.objective?.trim()) throw fail(400, 'OBJECTIVE_REQUIRED', 'An ad draft needs an objective');
  if (input.status && !AD_DRAFT_STATUSES.includes(input.status)) {
    throw fail(400, 'STATUS_INVALID', `Unknown ad draft status: ${input.status}`);
  }
  if (input.status === 'ACTIVE') {
    throw fail(400, 'STATUS_INVALID', 'Ad drafts can never be ACTIVE here — enabling happens only in Ads Manager');
  }
  // Claim-check gate (Flywheel Item 6): same gate as the stream.
  const adClaimViolations = findClaimViolations([
    ['name', input.name],
    ['objective', input.objective],
    ['headline', input.headline],
    ['copy', input.copy],
    ['description', input.description],
    ['text', input.text],
  ]);
  if (adClaimViolations.length) throw claimCheckError(adClaimViolations);
  return facebookOsAdsRepo.create({ ...input, status: input.status || 'DRAFT' }, actorId);
}
