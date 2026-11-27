import { Router } from 'express';
import { z } from 'zod';
import { appendEvent, store } from '../data/store.js';
import { DATABASE_ENABLED, db } from '../db/client.js';
import {
  countBumpsSince, countVisibleComments, createListingBump, createListingComment,
  createListingReport, createSellerReview, createSellerSale, getListingComment,
  getListingProfile, getSaleByListing, getSellerReviewBySale, incrementListingViews,
  listListingComments, listListingProfiles, listListingReports, listSalesByBuyer,
  listSalesBySeller, listSellerReviews, listSavedListings, saveListing, unsaveListing,
  updateListingComment, updateListingReport, updateSellerReview, upsertListingProfile,
} from '../db/listingTrustRepo.js';
import { getSubmissionMediaItem, listSubmissionMedia } from '../db/submissionMediaRepo.js';
import { pepperReportsRepo } from '../db/pepperReportsRepo.js';
import { authenticate, optionalAuthenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { STAFF_ROLES } from '../config/security.js';
import { consumeIntakeAttempt } from '../services/intakeShield.js';
import { layer2Applies } from '../services/layer2.js';
import { requireSellerPlanFeature, resolveSellerAccess } from '../services/sellerPlans.js';

/**
 * Pepper Lists Trust & Growth (2026-11-20) — Ramone's direction:
 * customers must feel safe and secure while selling or booking.
 *
 * A Pepper Lists listing IS a PEPPER_LISTS_SELL Connection record:
 * the facts the seller confirmed (title, price, category, condition,
 * description) live in its message, its photos on SubmissionMedia
 * rows. This router builds the trust layer over those real records:
 *
 * Public lanes (no auth):
 * - GET /pepper-lists/listings/public — live listing cards (featured
 *   first, then most recently bumped/posted), with REAL visible
 *   comment counts. Only listing facts are ever serialized — never
 *   the seller's phone or email.
 * - GET /pepper-lists/listings/public/:id — the trust-first detail:
 *   photos, facts, the seller card with badges computed from real
 *   account facts, the seller's real reviews, the comments panel.
 *   Viewing it increments the listing's real view counter.
 * - GET /pepper-lists/listings/public/:id/media/:mediaId — photos.
 * - GET /pepper-lists/listings/public/:id/comments — visible thread.
 * - GET /pepper-lists/sellers/:userId/reviews — a seller's published
 *   reviews + an aggregate computed from them (null when none).
 * - GET /pepper-lists/sellers/:userId/public — the storefront
 *   (a seller-plan feature): seller card + listings + reviews.
 *
 * Signed-in lanes:
 * - POST .../listings/:id/comments — comment (the seller's own posts
 *   are marked as the seller's reply); rate-limited per account.
 * - POST .../listings/:id/comments/:commentId/hide — the listing's
 *   owner hides a comment on their own listing.
 * - POST .../listings/:id/report — report a listing into the staff
 *   queue (ListingReport row + the Pepper Reports log).
 * - GET  /pepper-lists/listings/mine — the seller's own listings
 *   with profile state, views and comment counts.
 * - POST .../listings/:id/sold — the seller marks their listing
 *   sold; the SellerSale it creates is the ONLY key that unlocks a
 *   seller review (the buyer named on the sale, and only them).
 * - POST .../listings/:id/featured | /unfeature | /bump — seller
 *   plan features, gated by services/sellerPlans.js.
 * - GET  /pepper-lists/sales/reviewable + POST
 *   /pepper-lists/sellers/:sellerId/reviews — buyer reviews.
 * - GET  /pepper-lists/seller-analytics — the analytics plan
 *   feature: real views, comments and sales per listing.
 *
 * Staff lanes (STAFF_ROLES): comment removal, the listing-report
 * queue, and seller-review moderation.
 *
 * Honesty rules (absolute): every badge, count and aggregate comes
 * from a real record; a seller with no reviews shows no aggregate;
 * nothing here invents a sale, a review or a protection the platform
 * does not actually offer.
 */
const router = Router();

export const LISTING_REPORT_REASONS = ['SCAM_OR_FRAUD', 'PROHIBITED_ITEM', 'INACCURATE_LISTING', 'ALREADY_SOLD', 'OTHER'];

/* --------------------------- listing facts --------------------------- */

/**
 * The listing facts live in the Connection message, written by
 * POST /pepper-lists/listings in a fixed template:
 *   Listing title: … / Category: … / Condition: … / Price: $X.XX
 *   (set by the seller) / Description: … / Media attached: …
 * This parser reads exactly that template — a listing whose message
 * does not match simply yields nulls and is skipped by the feed.
 */
export function parseListingFacts(connection) {
  const message = String(connection?.message || '');
  const grab = (label) => {
    const match = new RegExp(`^${label}: (.*)$`, 'm').exec(message);
    return match ? match[1].trim() : null;
  };
  const priceMatch = /^Price: \$([\d,]+(?:\.\d{2})?)/m.exec(message);
  let description = null;
  const descStart = message.indexOf('\nDescription: ');
  if (descStart >= 0) {
    const rest = message.slice(descStart + '\nDescription: '.length);
    const endMarkers = ['\nMedia attached:', '\nConfirmed by the seller', '\nSubmitted by'];
    let end = rest.length;
    for (const marker of endMarkers) {
      const idx = rest.indexOf(marker);
      if (idx >= 0 && idx < end) end = idx;
    }
    description = rest.slice(0, end).trim() || null;
  }
  const title = grab('Listing title');
  if (!title) return null;
  return {
    title,
    category: grab('Category'),
    condition: grab('Condition'),
    format: grab('Format'),
    priceCents: priceMatch ? Math.round(Number(priceMatch[1].replace(/,/g, '')) * 100) : null,
    description,
  };
}

export function findListing(idOrReference) {
  const raw = String(idOrReference || '');
  if (!raw) return null;
  return store.connections.find(
    (c) => c.type === 'PEPPER_LISTS_SELL' && (c.id === raw || c.reference === raw),
  ) || null;
}

function allListings() {
  return store.connections.filter((c) => c.type === 'PEPPER_LISTS_SELL');
}

/* ------------------------------ user facts ---------------------------- */

const USER_FACT_SELECT = {
  id: true, email: true, firstName: true, lastName: true, roles: true,
  emailVerifiedAt: true, layer2Required: true, createdAt: true, signupSource: true,
};

export async function findUserById(userId) {
  if (!userId) return null;
  if (DATABASE_ENABLED) {
    try {
      const row = await db().user.findUnique({ where: { id: userId }, select: USER_FACT_SELECT });
      if (row) return row;
    } catch { /* fall through to the in-memory record */ }
  }
  const record = store.users.get(userId);
  return record ? { id: userId, ...record } : null;
}

export async function findUserByEmail(email) {
  const target = String(email || '').trim().toLowerCase();
  if (!target) return null;
  if (DATABASE_ENABLED) {
    try {
      const row = await db().user.findFirst({
        where: { email: { equals: target, mode: 'insensitive' } },
        select: USER_FACT_SELECT,
      });
      if (row) return row;
    } catch { /* fall through to the in-memory records */ }
  }
  for (const [id, record] of store.users.entries()) {
    if (String(record.email || '').toLowerCase() === target) return { id, ...record };
  }
  return null;
}

/** "Maria G." — first name + last initial, never a full name in public. */
export function publicNameOf(user, fallbackName) {
  const first = String(user?.firstName || '').trim();
  const last = String(user?.lastName || '').trim();
  if (first) return last ? `${first} ${last.charAt(0).toUpperCase()}.` : first;
  const full = String(fallbackName || '').trim();
  if (full) {
    const parts = full.split(/\s+/);
    return parts.length > 1 ? `${parts[0]} ${parts[1].charAt(0).toUpperCase()}.` : parts[0];
  }
  return 'Pepper Lists seller';
}

/** The seller account behind a listing: profile first, then the intake email match. */
export async function sellerIdFor(listing, profile) {
  if (profile?.sellerUserId) return profile.sellerUserId;
  const user = await findUserByEmail(listing.email);
  return user?.id || null;
}

/**
 * The public seller card. Badges exist ONLY when the underlying
 * account fact is true — emailVerifiedAt set, Layer 2 applying to
 * the account, the real createdAt, and completed sales counted from
 * SellerSale rows. An unmatched seller (no account found) shows a
 * name and nothing else — no badge is ever guessed.
 */
export async function sellerCardFor(listing, profile) {
  const sellerId = await sellerIdFor(listing, profile);
  const user = sellerId ? await findUserById(sellerId) : null;
  const sales = sellerId ? await listSalesBySeller(sellerId) : [];
  return {
    userId: sellerId,
    name: publicNameOf(user, listing.name),
    badges: user
      ? {
          emailVerified: Boolean(user.emailVerifiedAt),
          twoStepOn: Boolean(layer2Applies(user)),
          memberSince: user.createdAt ? new Date(user.createdAt).toISOString() : null,
        }
      : { emailVerified: false, twoStepOn: false, memberSince: null },
    salesCount: sales.length,
  };
}

/* ---------------------------- serializers ----------------------------- */

async function photoUrlsFor(listing) {
  const rows = await listSubmissionMedia(listing.id);
  return rows
    .filter((row) => row.kind === 'photo')
    .map((row) => `/api/v1/pepper-lists/listings/public/${listing.id}/media/${row.id}`);
}

async function serializeCard(listing, profile, commentCounts) {
  const facts = parseListingFacts(listing);
  if (!facts) return null;
  const photos = await photoUrlsFor(listing);
  // Seller display name (2026-11-21): resolve the account like the
  // detail path does. The record's name field falls back to the
  // account email when the create path had no display name, and an
  // email address must never be published as the public seller name.
  const sellerId = await sellerIdFor(listing, profile);
  const seller = sellerId ? await findUserById(sellerId) : null;
  let sellerName = publicNameOf(seller, listing.name);
  if (sellerName.includes('@')) sellerName = 'Pepper Lists seller';
  return {
    id: listing.id,
    reference: listing.reference,
    title: facts.title,
    priceCents: facts.priceCents,
    category: facts.category,
    condition: facts.condition,
    format: facts.format,
    status: profile?.status || 'ACTIVE',
    featured: Boolean(profile?.featured),
    photoUrl: photos[0] || null,
    commentCount: commentCounts?.get(listing.id) ?? 0,
    sellerName,
    createdAt: listing.createdAt,
  };
}

function sortListings(entries) {
  return entries.sort((a, b) => {
    if (a.card.featured !== b.card.featured) return a.card.featured ? -1 : 1;
    const aBump = a.profile?.bumpedAt || a.listing.createdAt;
    const bBump = b.profile?.bumpedAt || b.listing.createdAt;
    return String(bBump).localeCompare(String(aBump));
  });
}

async function visibleComments(listingId) {
  const rows = await listListingComments(listingId);
  return rows.filter((c) => !c.hidden && !c.removed);
}

async function serializeComment(comment) {
  const author = await findUserById(comment.authorId);
  return {
    id: comment.id,
    body: comment.body,
    authorKind: comment.authorKind,
    authorName: publicNameOf(author, null),
    createdAt: comment.createdAt,
  };
}

/* ----------------------------- public lanes --------------------------- */

router.get('/pepper-lists/listings/public', async (req, res) => {
  const limit = Math.min(60, Math.max(1, Number(req.query.limit) || 30));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const profiles = await listListingProfiles();
  const byConn = new Map(profiles.map((p) => [p.connectionId, p]));
  const listings = allListings().filter((l) => (byConn.get(l.id)?.status || 'ACTIVE') === 'ACTIVE');
  const counts = await countVisibleComments(listings.map((l) => l.id));
  const entries = [];
  for (const listing of listings) {
    const card = await serializeCard(listing, byConn.get(listing.id), counts);
    if (card) entries.push({ listing, profile: byConn.get(listing.id), card });
  }
  sortListings(entries);
  const page = entries.slice(offset, offset + limit);
  return res.json({ data: page.map((e) => e.card), pagination: { limit, offset, total: entries.length } });
});

/* Google Shopping product feed (Commerce OS Phase 2, 2026-11-27):
   a standard RSS 2.0 / g: feed generated from the same live listings
   the public feed serves — ACTIVE profiles only, real prices and real
   photo URLs, nothing invented. Merchant Center claims this URL once
   the owner creates that account. */
function xmlEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

router.get('/pepper-lists/feeds/google.xml', async (req, res) => {
  const profiles = await listListingProfiles();
  const byConn = new Map(profiles.map((p) => [p.connectionId, p]));
  const listings = allListings().filter((l) => (byConn.get(l.id)?.status || 'ACTIVE') === 'ACTIVE');
  const items = [];
  for (const listing of listings) {
    const facts = parseListingFacts(listing);
    if (!facts || !facts.title || !facts.priceCents) continue;
    const photos = await photoUrlsFor(listing);
    const cond = /^new/i.test(facts.condition || '') ? 'new' : 'used';
    items.push('<item>'
      + '<g:id>' + xmlEsc(listing.reference || listing.id) + '</g:id>'
      + '<g:title>' + xmlEsc(facts.title.slice(0, 150)) + '</g:title>'
      + '<g:description>' + xmlEsc((facts.description || facts.title).slice(0, 5000)) + '</g:description>'
      + '<g:link>https://pepperlists.com/pepper-lists-site</g:link>'
      + (photos[0] ? '<g:image_link>' + xmlEsc('https://top-speed-service-os.vercel.app' + photos[0]) + '</g:image_link>' : '')
      + '<g:price>' + (facts.priceCents / 100).toFixed(2) + ' USD</g:price>'
      + '<g:availability>in_stock</g:availability>'
      + '<g:condition>' + cond + '</g:condition>'
      + (cond === 'used' ? '<g:identifier_exists>no</g:identifier_exists>' : '')
      + '</item>');
  }
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0"><channel>'
    + '<title>Pepperlists — Pepper Lists It</title>'
    + '<link>https://pepperlists.com/</link>'
    + '<description>Live Pepperlists listings</description>'
    + items.join('')
    + '</channel></rss>';
  res.set('Content-Type', 'application/xml; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=3600');
  return res.send(xml);
});

router.get('/pepper-lists/listings/public/:id', optionalAuthenticate, async (req, res) => {
  const listing = findListing(req.params.id);
  if (!listing) return res.status(404).json({ error: 'Listing not found' });
  const facts = parseListingFacts(listing);
  if (!facts) return res.status(404).json({ error: 'Listing not found' });
  let profile = await getListingProfile(listing.id);
  const sellerId = await sellerIdFor(listing, profile);
  const status = profile?.status || 'ACTIVE';
  // A real view: count public detail views of live listings — never
  // the seller reading their own page.
  if (status === 'ACTIVE' && req.user?.id !== sellerId) {
    profile = await incrementListingViews(listing.id);
  }
  const [photos, seller, comments] = await Promise.all([
    photoUrlsFor(listing),
    sellerCardFor(listing, profile),
    visibleComments(listing.id),
  ]);
  const sellerReviews = seller.userId
    ? await listSellerReviews({ sellerId: seller.userId, status: 'PUBLISHED' })
    : [];
  const reviewData = [];
  for (const review of sellerReviews.slice(0, 5)) {
    const buyer = await findUserById(review.buyerId);
    reviewData.push({
      id: review.id, rating: review.rating, title: review.title, body: review.body,
      buyerName: publicNameOf(buyer, null), createdAt: review.createdAt,
    });
  }
  const commentData = [];
  for (const comment of comments) commentData.push(await serializeComment(comment));
  return res.json({
    data: {
      id: listing.id,
      reference: listing.reference,
      title: facts.title,
      priceCents: facts.priceCents,
      category: facts.category,
      condition: facts.condition,
      format: facts.format,
      description: facts.description,
      status,
      featured: Boolean(profile?.featured),
      photos,
      viewCount: profile?.viewCount ?? 0,
      createdAt: listing.createdAt,
      seller,
      sellerReviews: {
        count: sellerReviews.length,
        average: sellerReviews.length
          ? Math.round((sellerReviews.reduce((sum, r) => sum + r.rating, 0) / sellerReviews.length) * 10) / 10
          : null,
        items: reviewData,
      },
      comments: commentData,
    },
  });
});

router.get('/pepper-lists/listings/public/:id/media/:mediaId', async (req, res) => {
  const listing = findListing(req.params.id);
  if (!listing) return res.status(404).json({ error: 'Media item not found' });
  const row = await getSubmissionMediaItem(listing.id, req.params.mediaId);
  if (!row || row.kind !== 'photo') return res.status(404).json({ error: 'Media item not found' });
  const match = /^data:([^;,]+);base64,([\s\S]*)$/.exec(row.dataUrl || '');
  if (!match) return res.status(500).json({ error: 'Stored media is unreadable' });
  const bytes = Buffer.from(match[2], 'base64');
  res.set({
    'Content-Type': row.mime || match[1] || 'application/octet-stream',
    'Cache-Control': 'public, max-age=300',
    // Public listing photos are embedded cross-origin (pepperlists.com
    // loads them from the API origin) — without this, helmet's default
    // same-origin CORP makes browsers refuse a perfectly good 200.
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Content-Disposition': `inline; filename="listing-photo-${row.id.slice(0, 8)}"`,
    'Content-Length': bytes.length,
  });
  return res.end(bytes);
});

router.get('/pepper-lists/listings/public/:id/comments', async (req, res) => {
  const listing = findListing(req.params.id);
  if (!listing) return res.status(404).json({ error: 'Listing not found' });
  const comments = await visibleComments(listing.id);
  const data = [];
  for (const comment of comments) data.push(await serializeComment(comment));
  return res.json({ data });
});

router.get('/pepper-lists/sellers/:userId/reviews', async (req, res) => {
  const published = await listSellerReviews({ sellerId: req.params.userId, status: 'PUBLISHED' });
  const data = [];
  for (const review of published) {
    const buyer = await findUserById(review.buyerId);
    data.push({
      id: review.id, rating: review.rating, title: review.title, body: review.body,
      buyerName: publicNameOf(buyer, null), createdAt: review.createdAt,
    });
  }
  const count = published.length;
  const average = count ? Math.round((published.reduce((sum, r) => sum + r.rating, 0) / count) * 10) / 10 : null;
  return res.json({ data, aggregate: { count, average } });
});

router.get('/pepper-lists/sellers/:userId/public', async (req, res) => {
  const user = await findUserById(req.params.userId);
  if (!user) return res.status(404).json({ error: 'Seller not found' });
  const access = await resolveSellerAccess({ id: user.id, roles: user.roles || [] });
  if (!access?.bypass && !access?.features?.storefront) {
    return res.status(403).json({
      error: 'storefront_not_enabled',
      message: 'This seller has not opened a public storefront yet. Their listings still appear in the Pepper Lists feed.',
    });
  }
  const listings = allListings();
  const mine = [];
  for (const listing of listings) {
    const profile = await getListingProfile(listing.id);
    const sellerId = await sellerIdFor(listing, profile);
    if (sellerId === user.id) mine.push({ listing, profile });
  }
  const active = mine.filter((e) => (e.profile?.status || 'ACTIVE') === 'ACTIVE');
  const counts = await countVisibleComments(active.map((e) => e.listing.id));
  const entries = [];
  for (const entry of active) {
    const card = await serializeCard(entry.listing, entry.profile, counts);
    if (card) entries.push({ ...entry, card });
  }
  sortListings(entries);
  const sales = await listSalesBySeller(user.id);
  return res.json({
    data: {
      seller: {
        userId: user.id,
        name: publicNameOf(user, null),
        badges: {
          emailVerified: Boolean(user.emailVerifiedAt),
          twoStepOn: Boolean(layer2Applies(user)),
          memberSince: user.createdAt ? new Date(user.createdAt).toISOString() : null,
        },
        salesCount: sales.length,
      },
      listings: entries.map((e) => e.card),
    },
  });
});

/* --------------------------- signed-in lanes -------------------------- */

async function rateLimitUser(req, res) {
  const verdict = await consumeIntakeAttempt('listingActions', `user:${req.user.id}`);
  if (verdict.allowed) return true;
  res.set('Retry-After', String(verdict.retryAfterSeconds));
  res.status(429).json({
    error: 'Too many actions from this account in a short window — please wait a little while and try again.',
    code: 'RATE_LIMITED',
  });
  return false;
}

/* Saved listings (2026-11-21, launch package) — the signed-in
   customer's private save list (Facebook Marketplace parity). A
   save is visible only to its owner: the list lane answers only
   the caller's own saves, and unsaving another account's row is
   indistinguishable from unsaving nothing. Cards serialize exactly
   like the public feed (listing facts only — never the seller's
   phone or email); a saved listing that has since been removed
   simply drops off the list. */
router.get('/pepper-lists/saved', authenticate, async (req, res) => {
  const saved = await listSavedListings(req.user.id);
  const profiles = await listListingProfiles();
  const byConn = new Map(profiles.map((p) => [p.connectionId, p]));
  const listings = saved.map((row) => findListing(row.listingId)).filter(Boolean);
  const counts = await countVisibleComments(listings.map((l) => l.id));
  const cards = [];
  for (const listing of listings) {
    const card = await serializeCard(listing, byConn.get(listing.id), counts);
    if (card) cards.push(card);
  }
  return res.json({ data: cards });
});

router.post('/pepper-lists/listings/:id/save', authenticate, async (req, res) => {
  const listing = findListing(req.params.id);
  if (!listing || !parseListingFacts(listing)) return res.status(404).json({ error: 'Listing not found' });
  if (!(await rateLimitUser(req, res))) return undefined;
  const row = await saveListing({ userId: req.user.id, listingId: listing.id });
  return res.status(201).json({ data: { saved: true, listingId: listing.id, savedId: row.id } });
});

router.delete('/pepper-lists/listings/:id/save', authenticate, async (req, res) => {
  const listing = findListing(req.params.id);
  await unsaveListing(req.user.id, listing ? listing.id : req.params.id);
  return res.json({ data: { saved: false, listingId: listing ? listing.id : req.params.id } });
});

const commentSchema = z.object({ body: z.string().trim().min(1).max(2000) });

router.post('/pepper-lists/listings/:id/comments', authenticate, async (req, res) => {
  const listing = findListing(req.params.id);
  if (!listing) return res.status(404).json({ error: 'Listing not found' });
  if (!(await rateLimitUser(req, res))) return undefined;
  const parsed = commentSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid comment', details: parsed.error.flatten() });
  }
  const profile = await getListingProfile(listing.id);
  const sellerId = await sellerIdFor(listing, profile);
  const created = await createListingComment({
    listingId: listing.id,
    authorId: req.user.id,
    authorKind: sellerId && sellerId === req.user.id ? 'SELLER' : 'USER',
    body: parsed.data.body,
  });
  await appendEvent('LISTING_COMMENTED', {
    source: 'pepper-lists', actor: 'customer', entityType: 'LISTING', entityId: listing.id,
    referenceCode: listing.reference,
    details: { authorKind: created.authorKind },
  });
  return res.status(201).json({ data: await serializeComment(created) });
});

router.post('/pepper-lists/listings/:id/comments/:commentId/hide', authenticate, async (req, res) => {
  const listing = findListing(req.params.id);
  if (!listing) return res.status(404).json({ error: 'Listing not found' });
  const profile = await getListingProfile(listing.id);
  const sellerId = await sellerIdFor(listing, profile);
  if (!sellerId || sellerId !== req.user.id) {
    return res.status(403).json({ error: 'Only the listing owner can hide comments on this listing' });
  }
  const comment = await getListingComment(req.params.commentId);
  if (!comment || comment.listingId !== listing.id) return res.status(404).json({ error: 'Comment not found' });
  const updated = await updateListingComment(comment.id, { hidden: true });
  return res.json({ data: { id: updated.id, hidden: updated.hidden } });
});

const staffGate = [authenticate, requireCompany, requireRole(...STAFF_ROLES)];

router.post('/pepper-lists/listings/:id/comments/:commentId/remove', ...staffGate, async (req, res) => {
  const listing = findListing(req.params.id);
  if (!listing) return res.status(404).json({ error: 'Listing not found' });
  const comment = await getListingComment(req.params.commentId);
  if (!comment || comment.listingId !== listing.id) return res.status(404).json({ error: 'Comment not found' });
  const updated = await updateListingComment(comment.id, { removed: true });
  await appendEvent('LISTING_COMMENT_REMOVED', {
    source: 'pepper-lists', actor: req.user.email || 'staff', entityType: 'LISTING', entityId: listing.id,
    referenceCode: listing.reference, details: { commentId: comment.id },
  });
  return res.json({ data: { id: updated.id, removed: updated.removed } });
});

const reportSchema = z.object({
  reason: z.enum(LISTING_REPORT_REASONS),
  details: z.string().trim().max(1000).optional(),
});

router.post('/pepper-lists/listings/:id/report', authenticate, async (req, res) => {
  const listing = findListing(req.params.id);
  if (!listing) return res.status(404).json({ error: 'Listing not found' });
  if (!(await rateLimitUser(req, res))) return undefined;
  const parsed = reportSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid report', details: parsed.error.flatten() });
  }
  const existing = await listListingReports({ status: 'NEW' });
  if (existing.some((r) => r.listingId === listing.id && r.reporterId === req.user.id)) {
    return res.status(409).json({ error: 'You already reported this listing — the office has it in the queue.' });
  }
  const facts = parseListingFacts(listing);
  const report = await createListingReport({
    listingId: listing.id,
    reporterId: req.user.id,
    reason: parsed.data.reason,
    details: parsed.data.details || null,
  });
  // The same filing lands in the Pepper Reports log the office
  // already watches from the Pepper console — one queue, no silo.
  try {
    await pepperReportsRepo.create({
      title: `Listing reported — ${listing.reference}`,
      body: [
        `Listing: ${facts?.title || listing.reference} (${listing.reference})`,
        `Reason: ${parsed.data.reason}`,
        ...(parsed.data.details ? [`Details: ${parsed.data.details}`] : []),
        'Filed from the listing page on pepperlists.com. Review it in the listing-report queue.',
      ].join('\n'),
      category: 'NEEDS_OWNER',
      createdByUserId: req.user.id,
    });
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', message: 'listing report pepper-log failed', error: String(error?.message || error) }));
  }
  await appendEvent('LISTING_REPORTED', {
    source: 'pepper-lists', actor: 'customer', entityType: 'LISTING', entityId: listing.id,
    referenceCode: listing.reference, details: { reason: parsed.data.reason },
  });
  return res.status(201).json({
    data: { id: report.id, status: report.status },
    message: 'Thank you — your report is with the Top Speed office. They review every report by hand.',
  });
});

router.get('/pepper-lists/listings/mine', authenticate, async (req, res) => {
  const mine = [];
  for (const listing of allListings()) {
    const profile = await getListingProfile(listing.id);
    const sellerId = await sellerIdFor(listing, profile);
    if (sellerId !== req.user.id) continue;
    const facts = parseListingFacts(listing);
    if (!facts) continue;
    const counts = await countVisibleComments([listing.id]);
    const sale = await getSaleByListing(listing.id);
    mine.push({
      id: listing.id,
      reference: listing.reference,
      title: facts.title,
      priceCents: facts.priceCents,
      category: facts.category,
      condition: facts.condition,
      status: profile?.status || 'ACTIVE',
      featured: Boolean(profile?.featured),
      bumpedAt: profile?.bumpedAt ?? null,
      viewCount: profile?.viewCount ?? 0,
      commentCount: counts.get(listing.id) ?? 0,
      soldAt: profile?.soldAt ?? null,
      sale: sale ? { id: sale.id, buyerMatched: Boolean(sale.buyerId), completedAt: sale.completedAt } : null,
      createdAt: listing.createdAt,
    });
  }
  mine.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return res.json({ data: mine });
});

async function loadOwnedListing(req, res) {
  const listing = findListing(req.params.id);
  if (!listing) { res.status(404).json({ error: 'Listing not found' }); return null; }
  const profile = await getListingProfile(listing.id);
  const sellerId = await sellerIdFor(listing, profile);
  if (!sellerId || sellerId !== req.user.id) {
    res.status(403).json({ error: 'That listing belongs to another seller' });
    return null;
  }
  return { listing, profile };
}

const soldSchema = z.object({
  buyerEmail: z.string().trim().email().max(200).optional(),
});

router.post('/pepper-lists/listings/:id/sold', authenticate, async (req, res) => {
  const owned = await loadOwnedListing(req, res);
  if (!owned) return undefined;
  const { listing } = owned;
  const parsed = soldSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid sale details', details: parsed.error.flatten() });
  }
  const existing = await getSaleByListing(listing.id);
  if (existing) return res.status(409).json({ error: 'This listing is already marked sold.' });
  let buyerId = null;
  if (parsed.data.buyerEmail) {
    const buyer = await findUserByEmail(parsed.data.buyerEmail);
    if (buyer && buyer.id !== req.user.id) buyerId = buyer.id;
  }
  const sale = await createSellerSale({
    listingId: listing.id,
    sellerId: req.user.id,
    buyerId,
    buyerEmail: parsed.data.buyerEmail || null,
  });
  await upsertListingProfile(listing.id, {
    sellerUserId: req.user.id, status: 'SOLD', soldAt: sale.completedAt, featured: false,
  });
  await appendEvent('LISTING_SOLD', {
    source: 'pepper-lists', actor: 'customer', entityType: 'LISTING', entityId: listing.id,
    referenceCode: listing.reference, details: { buyerMatched: Boolean(buyerId) },
  });
  return res.status(201).json({
    data: { saleId: sale.id, status: 'SOLD', buyerMatched: Boolean(buyerId) },
    message: buyerId
      ? 'Marked sold. Your buyer can now review you from their Pepper Lists account.'
      : 'Marked sold. If your buyer has a Pepper Lists account, record their account email next time so they can review you.',
  });
});

router.post('/pepper-lists/listings/:id/featured', authenticate, requireSellerPlanFeature('featured'), async (req, res) => {
  const owned = await loadOwnedListing(req, res);
  if (!owned) return undefined;
  const { listing, profile } = owned;
  if ((profile?.status || 'ACTIVE') !== 'ACTIVE') {
    return res.status(400).json({ error: 'Only a live listing can be featured.' });
  }
  if (!profile?.featured) {
    const limit = req.sellerPlanAccess?.limits?.featuredListings;
    if (limit != null) {
      let count = 0;
      for (const other of allListings()) {
        const otherProfile = await getListingProfile(other.id);
        const otherSeller = await sellerIdFor(other, otherProfile);
        if (otherSeller === req.user.id && otherProfile?.featured && (otherProfile?.status || 'ACTIVE') === 'ACTIVE') count += 1;
      }
      if (count >= limit) {
        return res.status(422).json({
          error: 'featured_limit_reached',
          message: `Your plan includes ${limit} featured listing${limit === 1 ? '' : 's'} at a time — unfeature one first, or upgrade for more.`,
        });
      }
    }
  }
  const updated = await upsertListingProfile(listing.id, { sellerUserId: req.user.id, featured: true });
  return res.json({ data: { id: listing.id, featured: updated.featured } });
});

router.post('/pepper-lists/listings/:id/unfeature', authenticate, async (req, res) => {
  const owned = await loadOwnedListing(req, res);
  if (!owned) return undefined;
  const updated = await upsertListingProfile(owned.listing.id, { sellerUserId: req.user.id, featured: false });
  return res.json({ data: { id: owned.listing.id, featured: updated.featured } });
});

router.post('/pepper-lists/listings/:id/bump', authenticate, requireSellerPlanFeature('bump'), async (req, res) => {
  const owned = await loadOwnedListing(req, res);
  if (!owned) return undefined;
  const { listing, profile } = owned;
  if ((profile?.status || 'ACTIVE') !== 'ACTIVE') {
    return res.status(400).json({ error: 'Only a live listing can be bumped.' });
  }
  const limit = req.sellerPlanAccess?.limits?.bumpsPerMonth;
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const used = await countBumpsSince(req.user.id, monthStart);
  if (limit != null && used >= limit) {
    return res.status(422).json({
      error: 'bump_credits_used',
      message: `You have used all ${limit} of this month's bump credits — they refresh on the 1st, or upgrade for more.`,
      bumpsUsedThisMonth: used,
      bumpsPerMonth: limit,
    });
  }
  await createListingBump({ listingId: listing.id, sellerId: req.user.id });
  const updated = await upsertListingProfile(listing.id, { sellerUserId: req.user.id, bumpedAt: now.toISOString() });
  return res.json({
    data: {
      id: listing.id, bumpedAt: updated.bumpedAt,
      bumpsUsedThisMonth: used + 1, bumpsPerMonth: limit,
    },
  });
});

router.get('/pepper-lists/sales/reviewable', authenticate, async (req, res) => {
  const sales = await listSalesByBuyer(req.user.id);
  const data = [];
  for (const sale of sales) {
    const review = await getSellerReviewBySale(sale.id);
    if (review) continue;
    const listing = findListing(sale.listingId);
    if (!listing) continue;
    const facts = parseListingFacts(listing);
    const seller = await findUserById(sale.sellerId);
    data.push({
      saleId: sale.id,
      listingId: sale.listingId,
      listingTitle: facts?.title || listing.reference,
      sellerId: sale.sellerId,
      sellerName: publicNameOf(seller, listing.name),
      completedAt: sale.completedAt,
    });
  }
  return res.json({ data });
});

const sellerReviewSchema = z.object({
  saleId: z.string().min(1),
  rating: z.number().int().min(1).max(5),
  title: z.string().trim().min(2).max(120),
  body: z.string().trim().min(3).max(2000),
});

router.post('/pepper-lists/sellers/:sellerId/reviews', authenticate, async (req, res) => {
  const parsed = sellerReviewSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid review', details: parsed.error.flatten() });
  }
  const data = parsed.data;
  const sales = await listSalesByBuyer(req.user.id);
  const sale = sales.find((s) => s.id === data.saleId);
  if (!sale || sale.sellerId !== req.params.sellerId) {
    return res.status(403).json({ error: 'Seller reviews open only after a completed sale — this account has no completed sale with that seller.' });
  }
  const existing = await getSellerReviewBySale(sale.id);
  if (existing) return res.status(409).json({ error: 'You already reviewed this sale.' });
  // Same moderation posture as the service reviews: low ratings wait
  // for the office instead of publishing instantly.
  const status = data.rating <= 3 ? 'PENDING' : 'PUBLISHED';
  const created = await createSellerReview({
    saleId: sale.id, sellerId: sale.sellerId, buyerId: req.user.id,
    rating: data.rating, title: data.title, body: data.body, status,
  });
  await appendEvent('SELLER_REVIEW_SUBMITTED', {
    source: 'pepper-lists', actor: 'customer', entityType: 'SELLER_REVIEW', entityId: created.id,
    details: { rating: created.rating, status: created.status },
  });
  return res.status(201).json({
    data: { id: created.id, rating: created.rating, title: created.title, body: created.body, status: created.status, createdAt: created.createdAt },
    message: status === 'PENDING'
      ? 'Thank you — your review is with the office for a quick look before it posts.'
      : 'Thank you — your review is live on the seller’s profile.',
  });
});

router.get('/pepper-lists/seller-analytics', authenticate, requireSellerPlanFeature('analytics'), async (req, res) => {
  const mine = [];
  let totalViews = 0;
  let totalComments = 0;
  for (const listing of allListings()) {
    const profile = await getListingProfile(listing.id);
    const sellerId = await sellerIdFor(listing, profile);
    if (sellerId !== req.user.id) continue;
    const facts = parseListingFacts(listing);
    if (!facts) continue;
    const counts = await countVisibleComments([listing.id]);
    const commentCount = counts.get(listing.id) ?? 0;
    totalViews += profile?.viewCount ?? 0;
    totalComments += commentCount;
    mine.push({
      id: listing.id,
      reference: listing.reference,
      title: facts.title,
      status: profile?.status || 'ACTIVE',
      featured: Boolean(profile?.featured),
      viewCount: profile?.viewCount ?? 0,
      commentCount,
      createdAt: listing.createdAt,
    });
  }
  const sales = await listSalesBySeller(req.user.id);
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const bumpsUsed = await countBumpsSince(req.user.id, monthStart);
  mine.sort((a, b) => b.viewCount - a.viewCount);
  return res.json({
    data: {
      listings: mine,
      totals: { views: totalViews, comments: totalComments, sales: sales.length, bumpsUsedThisMonth: bumpsUsed },
    },
  });
});

/* ----------------------------- staff lanes ---------------------------- */

router.get('/pepper-lists/admin/listing-reports', ...staffGate, async (req, res) => {
  const status = String(req.query.status || 'NEW').toUpperCase();
  const rows = await listListingReports({ status: status === 'ALL' ? null : status });
  const data = [];
  for (const row of rows) {
    const listing = findListing(row.listingId);
    const reporter = await findUserById(row.reporterId);
    data.push({
      ...row,
      listingReference: listing?.reference || null,
      listingTitle: listing ? parseListingFacts(listing)?.title || null : null,
      reporterName: publicNameOf(reporter, null),
    });
  }
  return res.json({ data });
});

const reportPatchSchema = z.object({ status: z.enum(['REVIEWED', 'DISMISSED']) });

router.patch('/pepper-lists/admin/listing-reports/:id', ...staffGate, async (req, res) => {
  const parsed = reportPatchSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid status change', details: parsed.error.flatten() });
  }
  const updated = await updateListingReport(req.params.id, { status: parsed.data.status });
  if (!updated) return res.status(404).json({ error: 'Report not found' });
  return res.json({ data: updated });
});

router.get('/pepper-lists/admin/seller-reviews', ...staffGate, async (req, res) => {
  const status = String(req.query.status || 'PENDING').toUpperCase();
  const rows = await listSellerReviews({ status: status === 'ALL' ? null : status });
  const data = [];
  for (const row of rows) {
    const buyer = await findUserById(row.buyerId);
    const seller = await findUserById(row.sellerId);
    data.push({
      ...row,
      buyerName: publicNameOf(buyer, null),
      sellerName: publicNameOf(seller, null),
    });
  }
  return res.json({ data });
});

const sellerReviewPatchSchema = z.object({ status: z.enum(['PUBLISHED', 'HIDDEN']) });

router.patch('/pepper-lists/admin/seller-reviews/:id', ...staffGate, async (req, res) => {
  const parsed = sellerReviewPatchSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid status change', details: parsed.error.flatten() });
  }
  const updated = await updateSellerReview(req.params.id, { status: parsed.data.status });
  if (!updated) return res.status(404).json({ error: 'Seller review not found' });
  return res.json({ data: updated });
});

export default router;
