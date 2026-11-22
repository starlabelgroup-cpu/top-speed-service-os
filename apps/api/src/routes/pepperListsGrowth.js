import { Router } from 'express';
import { z } from 'zod';
import { store } from '../data/store.js';
import { countSubmissionMedia } from '../db/submissionMediaRepo.js';
import { syndicationRepo } from '../db/pepperListsSyndicationRepo.js';
import { messagesRepo } from '../db/pepperListsMessagesRepo.js';
import { sellerChannelsRepo } from '../db/sellerChannelsRepo.js';
import { pepperReportsRepo } from '../db/pepperReportsRepo.js';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { STAFF_ROLES } from '../config/security.js';
import { API_PUBLIC_BASE, getListingByReference, listingPhotoUrl, listingViewUrl } from '../services/pepperListings.js';
import {
  ebayFileExchangeCsv, feedTokenHash, findUserByEmailDual, findUserByIdDual,
  googleFeedXml, newFeedToken, publicSellerName, sellerListingsFor,
} from '../services/pepperSyndication.js';
import { consumeIntakeAttempt } from '../services/intakeShield.js';
import { NOTIFICATION_TEMPLATES, queueNotification } from '../services/notifications.js';

/**
 * Pepper Lists — Phase 2 growth (2026-11-20, recommendations
 * program C16 + C17 + C18). Three pieces, one honesty rule through
 * all of them: the server never writes to an outside platform and
 * never invents a fact — a status, a rating or a connection exists
 * only when a real record says so.
 *
 *  C16 — syndication to eBay + Google Shopping, extending the
 *  channels system the way Facebook Phase A did
 *  (routes/pepperListsFacebook.js):
 *   - POST /pepper-lists/listings/:reference/syndication — the
 *     listing's owner queues it for EBAY or GOOGLE_SHOPPING. These
 *     channels post under the SELLER'S OWN account, so queueing
 *     first requires their Phase 1 channel connection request on
 *     file (PENDING or CONNECTED); without one the answer is a 409
 *     that names the missing step. Rows are born QUEUED; staff
 *     record the real outcome (POSTED with the real eBay listing
 *     URL or the real Merchant Center product id/link, FAILED with
 *     the real reason) — the seller-facing status is the truth.
 *   - GET /pepper-lists/feeds/google/:token.xml — the seller's
 *     personal Google Shopping feed (Merchant Center pulls it).
 *     The token is random, shown once at issue, stored only as a
 *     SHA-256 hash on the channel connection; the feed serves ONLY
 *     that seller's live listings.
 *   - GET /pepper-lists/syndication/ebay-export.csv — staff only:
 *     the queued eBay worklist as an eBay File Exchange file.
 *  C17 — seller storefronts:
 *   - GET /pepper-lists/sellers/:userId/storefront (JSON) and
 *     /view (the shareable page; vercel.json rewrites
 *     pepperlists.com/seller/:userId to it): the seller's public
 *     name, member-since, and ALL their live listings, plus their
 *     reviews block. Seller reviews are keyed to completed sales
 *     recorded on the platform (the Trust & Growth build's
 *     SellerReview store); until a seller has real reviews the
 *     block reports the true empty state and NO aggregate renders
 *     — a rating is never invented.
 *  C18 — buyer–seller messaging:
 *   - POST /pepper-lists/listings/:reference/messages starts (or
 *     continues) the one thread between a signed-in buyer and the
 *     listing's seller; POST /pepper-lists/threads/:id/messages
 *     replies; GET /pepper-lists/threads + /:id are the inbox.
 *     ONLY the two parties can read or post — anyone else gets the
 *     same 404 as a missing thread. A party can report the thread:
 *     it is flagged REPORTED and a PepperReport lands in the staff
 *     queue (the Pepper console); staff read reported threads and
 *     can close them. New messages email the other party through
 *     the notification outbox (throttled per thread). A thread is
 *     about a sale item — never a lead, never dispatch.
 */
const router = Router();

function iso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Resolve a listing the signed-in user OWNS — the same account-email
 * match the Facebook queue uses (routes/pepperListsFacebook.js).
 * Unknown reference, not a listing, or someone else's listing are
 * the same 404, so these lanes can never probe other sellers.
 */
function resolveOwnedListing(req, res) {
  const found = getListingByReference(req.params.reference);
  if (!found) {
    res.status(404).json({ error: 'Listing not found' });
    return null;
  }
  const account = store.users.get(req.user.id) || {};
  const ownerEmail = String(account.email || req.user.email || '').trim().toLowerCase();
  const listingEmail = String(found.connection.email || '').trim().toLowerCase();
  if (!listingEmail || !ownerEmail || listingEmail !== ownerEmail) {
    res.status(404).json({ error: 'Listing not found' });
    return null;
  }
  return found;
}

/** Photo URLs (public bytes route) for a listing's first `max` photos. */
async function photoUrlsFor(listing, max = 4) {
  const count = await countSubmissionMedia(listing.connectionId);
  const urls = [];
  for (let i = 0; i < Math.min(count, max); i += 1) urls.push(listingPhotoUrl(listing.reference, i));
  return urls;
}

/* ============================ C16 — syndication ============================ */

const CHANNEL_LABELS = { EBAY: 'eBay', GOOGLE_SHOPPING: 'Google Shopping' };

function publicSyndication(row) {
  return {
    id: row.id,
    listingReference: row.listingReference,
    channel: row.channel,
    status: row.status,
    externalId: row.externalId ?? null,
    externalUrl: row.externalUrl ?? null,
    error: row.error ?? null,
    postedAt: iso(row.postedAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

/**
 * The Phase 1 gate: eBay and Google Shopping post under the
 * seller's own account, so the office needs their connection
 * request (with their account reference) on file before a listing
 * can queue. NOT_CONNECTED / REVOKED / ERROR rows do not pass —
 * the seller is told exactly which step is missing.
 */
async function requireChannelRequest(req, res, channel) {
  const conn = await sellerChannelsRepo.findForUserChannel(req.user.id, channel);
  if (conn && (conn.status === 'PENDING' || conn.status === 'CONNECTED')) return conn;
  res.status(409).json({
    error: channel === 'EBAY'
      ? 'Connect eBay first: send the eBay connection request in Channel Connections with your eBay user ID — the office completes the link, then your listings can queue for eBay.'
      : 'Connect Google Shopping first: send the Google Shopping connection request in Channel Connections with your Merchant Center account name or ID — the office completes the link, then your listings can queue for Google Shopping.',
    code: 'CHANNEL_NOT_REQUESTED',
    channel,
  });
  return null;
}

const syndicationSchema = z.object({
  channel: z.enum(['EBAY', 'GOOGLE_SHOPPING']),
});

router.post('/pepper-lists/listings/:reference/syndication', authenticate, async (req, res, next) => {
  const found = resolveOwnedListing(req, res);
  if (!found) return undefined;
  try {
    const parsed = syndicationSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid syndication request', details: parsed.error.flatten() });
    }
    const gate = await requireChannelRequest(req, res, parsed.data.channel);
    if (!gate) return undefined;
    const { row, duplicate } = await syndicationRepo.create({
      connectionId: found.connection.id,
      listingReference: found.listing.reference,
      userId: req.user.id,
      channel: parsed.data.channel,
    });
    if (duplicate) {
      return res.status(409).json({
        error: `This listing is already queued for ${CHANNEL_LABELS[parsed.data.channel]}`,
        data: { syndication: publicSyndication(row) },
      });
    }
    return res.status(201).json({ data: { syndication: publicSyndication(row) } });
  } catch (error) {
    return next(error);
  }
});

router.get('/pepper-lists/listings/:reference/syndication', authenticate, async (req, res, next) => {
  const found = resolveOwnedListing(req, res);
  if (!found) return undefined;
  try {
    const rows = await syndicationRepo.listForConnection(found.connection.id);
    return res.json({ data: { syndication: rows.map(publicSyndication) } });
  } catch (error) {
    return next(error);
  }
});

const staffGate = [authenticate, requireCompany, requireRole(...STAFF_ROLES)];

// The office worklist for both channels: what is waiting to be
// posted under each seller's own account, oldest first.
router.get('/pepper-lists/syndication/queue', ...staffGate, async (req, res, next) => {
  try {
    const rows = await syndicationRepo.listQueued(200);
    return res.json({ data: { count: rows.length, syndication: rows.map(publicSyndication) } });
  } catch (error) {
    return next(error);
  }
});

// The eBay worklist as an eBay File Exchange upload file (queued
// rows only; a listing deleted since queueing drops out).
router.get('/pepper-lists/syndication/ebay-export.csv', ...staffGate, async (req, res, next) => {
  try {
    const queued = (await syndicationRepo.listQueued(500)).filter((row) => row.channel === 'EBAY');
    const entries = [];
    for (const row of queued) {
      const found = getListingByReference(row.listingReference);
      if (!found) continue;
      entries.push({ listing: found.listing, photoUrls: await photoUrlsFor(found.listing) });
    }
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Cache-Control': 'private, no-store',
    });
    return res.send(ebayFileExchangeCsv(entries));
  } catch (error) {
    return next(error);
  }
});

const outcomeSchema = z.object({
  status: z.enum(['POSTED', 'FAILED']),
  externalUrl: z.string().trim().max(1000).optional(),
  externalId: z.string().trim().max(200).optional(),
  error: z.string().trim().max(500).optional(),
});

function isHostUrl(raw, suffix) {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && (url.hostname === suffix || url.hostname.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
}

router.post('/pepper-lists/syndication/:id/outcome', ...staffGate, async (req, res, next) => {
  try {
    const parsed = outcomeSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid outcome', details: parsed.error.flatten() });
    }
    const existing = await syndicationRepo.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Syndication request not found' });
    const data = parsed.data;
    if (data.status === 'POSTED') {
      if (existing.channel === 'EBAY') {
        if (!data.externalUrl || !isHostUrl(data.externalUrl, 'ebay.com')) {
          return res.status(400).json({ error: 'A posted eBay outcome needs the real eBay listing URL (an https://ebay.com link)' });
        }
      } else {
        const urlOk = data.externalUrl && isHostUrl(data.externalUrl, 'google.com');
        if (!data.externalId && !urlOk) {
          return res.status(400).json({ error: 'A posted Google Shopping outcome needs the real Merchant Center product ID, or the product\u2019s google.com link' });
        }
        if (data.externalUrl && !urlOk) {
          return res.status(400).json({ error: 'The Google Shopping link must be an https://google.com link' });
        }
      }
    }
    if (data.status === 'FAILED' && (!data.error || data.error.length < 3)) {
      return res.status(400).json({ error: 'A failed outcome needs the reason it could not post' });
    }
    // Phase 2 grant enforcement (2026-11-21): a POSTED outcome means
    // the office posted under the seller's OWN account on that
    // channel — allowed only while the seller's agent-management
    // grant for the channel is ON. FAILED bookkeeping stays ungated.
    if (data.status === 'POSTED') {
      const conn = await sellerChannelsRepo.findForUserChannel(existing.userId, existing.channel);
      if (!conn || conn.agentAccessGranted !== true) {
        return res.status(403).json({
          error: 'The seller has not granted agent access for this channel, so the office cannot post under their account. Ask the seller to turn on "Allow Pepper to manage this channel" first.',
          code: 'AGENT_GRANT_REQUIRED',
        });
      }
    }
    const { row, conflict } = await syndicationRepo.markOutcome(req.params.id, {
      status: data.status,
      externalId: data.externalId,
      externalUrl: data.status === 'POSTED' ? data.externalUrl : undefined,
      error: data.status === 'FAILED' ? data.error : undefined,
      outcomeById: req.user.id,
    });
    if (!row) return res.status(404).json({ error: 'Syndication request not found' });
    if (conflict) {
      return res.status(409).json({
        error: 'This syndication request already has an outcome',
        data: { syndication: publicSyndication(row) },
      });
    }
    // The agent-action log the seller's channel page promises.
    await sellerChannelsRepo.recordAgentAction(
      row.userId, row.channel, 'SELL',
      row.status === 'POSTED'
        ? `Pepper posted listing ${row.listingReference} to ${row.channel === 'EBAY' ? 'eBay' : 'Google Shopping'} — ${row.externalUrl || row.externalId}`
        : `Pepper could not post listing ${row.listingReference} to ${row.channel === 'EBAY' ? 'eBay' : 'Google Shopping'} — ${row.error}`,
    );
    return res.json({ data: { syndication: publicSyndication(row) } });
  } catch (error) {
    return next(error);
  }
});

/* --------------------- Google Shopping feed token --------------------- */

// Issue (or rotate) the seller's personal Merchant Center feed URL.
// The raw token is returned ONCE, in this response; only its
// SHA-256 hash is stored, on the channel connection's meta.
router.post('/pepper-lists/channels/GOOGLE_SHOPPING/feed-token', authenticate, async (req, res, next) => {
  try {
    const gate = await requireChannelRequest(req, res, 'GOOGLE_SHOPPING');
    if (!gate) return undefined;
    const token = newFeedToken();
    await sellerChannelsRepo.setMeta(req.user.id, 'GOOGLE_SHOPPING', 'SELL', {
      googleFeedTokenHash: feedTokenHash(token),
      googleFeedTokenIssuedAt: new Date().toISOString(),
    });
    return res.status(201).json({
      data: {
        feedUrl: `${API_PUBLIC_BASE}/pepper-lists/feeds/google/${token}.xml`,
        note: 'Give this URL to Google Merchant Center as your product feed. It shows only your live Pepper Lists listings. Issuing a new one replaces (and disables) the old URL.',
      },
    });
  } catch (error) {
    return next(error);
  }
});

// The feed Merchant Center pulls. The token resolves to exactly one
// seller's connection; anything else is the same 404.
router.get('/pepper-lists/feeds/google/:token', async (req, res, next) => {
  try {
    const presented = String(req.params.token || '').replace(/\.xml$/i, '');
    const hash = feedTokenHash(presented);
    const rows = await sellerChannelsRepo.listByChannel('GOOGLE_SHOPPING');
    const conn = rows.find((row) => row.meta && row.meta.googleFeedTokenHash === hash);
    if (!conn) return res.status(404).send('Feed not found');
    const user = await findUserByIdDual(conn.userId);
    if (!user) return res.status(404).send('Feed not found');
    const entries = sellerListingsFor(user);
    const photoMap = new Map();
    await Promise.all(entries.map(async ({ listing }) => {
      photoMap.set(listing.reference, await photoUrlsFor(listing));
    }));
    const xml = googleFeedXml({
      sellerName: publicSellerName(user, entries[0]?.connection?.name),
      listings: entries,
      photoUrlsFor: (listing) => photoMap.get(listing.reference) || [],
    });
    res.set({
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    });
    return res.send(xml);
  } catch (error) {
    return next(error);
  }
});

/* ============================ C17 — storefronts ============================ */

async function storefrontData(userId) {
  const user = await findUserByIdDual(userId);
  if (!user) return null;
  const entries = sellerListingsFor(user);
  const listings = [];
  for (const { listing } of entries) {
    const photoCount = await countSubmissionMedia(listing.connectionId);
    listings.push({
      reference: listing.reference,
      title: listing.title,
      description: listing.description,
      category: listing.category,
      condition: listing.condition,
      priceCents: listing.priceCents,
      photoUrl: photoCount > 0 ? listingPhotoUrl(listing.reference, 0) : null,
      viewUrl: listingViewUrl(listing.reference),
      createdAt: iso(listing.createdAt),
    });
  }
  return {
    seller: {
      userId: user.id,
      name: publicSellerName(user, entries[0]?.connection?.name),
      memberSince: iso(user.createdAt),
      listingsCount: listings.length,
    },
    listings,
    // Seller reviews are keyed to completed sales recorded on the
    // platform. No seller-review record exists for this seller in
    // the data this build can read, so the block reports the true
    // empty state — count 0, average null, and the page renders no
    // stars. (The Trust & Growth build's SellerReview store is the
    // source this block reads once it lands.)
    reviews: { count: 0, average: null, items: [] },
  };
}

router.get('/pepper-lists/sellers/:userId/storefront', async (req, res, next) => {
  try {
    const data = await storefrontData(req.params.userId);
    if (!data) return res.status(404).json({ error: 'Seller not found' });
    return res.json({ data });
  } catch (error) {
    return next(error);
  }
});

router.get('/pepper-lists/sellers/:userId/view', async (req, res, next) => {
  try {
    const data = await storefrontData(req.params.userId);
    if (!data) return res.status(404).send('Seller not found');
    const { seller, listings, reviews } = data;
    const storefrontUrl = `https://pepperlists.com/seller/${encodeURIComponent(seller.userId)}`;
    const firstPhoto = listings.find((l) => l.photoUrl)?.photoUrl;
    const imageMeta = firstPhoto
      ? `\n  <meta property="og:image" content="${esc(firstPhoto)}">\n  <meta name="twitter:image" content="${esc(firstPhoto)}">`
      : '';
    const memberLine = seller.memberSince
      ? `Selling on Pepper Lists since ${esc(new Date(seller.memberSince).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }))} · `
      : '';
    const cards = listings.map((l) => `
    <article style="border:1px solid rgba(183,227,60,.22);border-radius:14px;padding:14px 16px;margin-bottom:12px">
      ${l.photoUrl ? `<img src="${esc(l.photoUrl)}" alt="${esc(l.title)}" style="width:100%;border-radius:10px;display:block;margin-bottom:10px">` : ''}
      <h2 style="font-size:18px;margin:0 0 4px"><a href="${esc(l.viewUrl)}" style="color:#eef3ea;text-decoration:none">${esc(l.title)}</a></h2>
      <p style="font-size:15px;color:#b7e33c;margin:0 0 6px"><b>$${(l.priceCents / 100).toFixed(2)}</b>${l.condition ? ` · ${esc(l.condition)}` : ''}${l.category ? ` · ${esc(l.category)}` : ''}</p>
      ${l.description ? `<p style="font-size:14px;line-height:1.55;color:#c8d2c4;margin:0">${esc(l.description)}</p>` : ''}
    </article>`).join('');
    const reviewsHtml = reviews.count > 0
      ? `<p style="font-size:15px;color:#c8d2c4">Rated <b style="color:#eef3ea">${esc(reviews.average)}</b> from ${reviews.count} seller review${reviews.count === 1 ? '' : 's'}.</p>`
      : '<p style="font-size:15px;color:#c8d2c4">No seller reviews yet. Ratings on Pepper Lists come only from real, completed transactions — never invented, never bought.</p>';
    res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
    return res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(seller.name)} — Pepper Lists storefront</title>
  <meta name="description" content="${esc(`${seller.name} sells on Pepper Lists It by Top Speed OS — ${listings.length} live listing${listings.length === 1 ? '' : 's'} in Fort Lauderdale, FL.`)}">
  <link rel="canonical" href="${esc(storefrontUrl)}">
  <meta property="og:type" content="profile">
  <meta property="og:site_name" content="Pepper Lists It">
  <meta property="og:title" content="${esc(`${seller.name} — Pepper Lists storefront`)}">
  <meta property="og:description" content="${esc(`${listings.length} live listing${listings.length === 1 ? '' : 's'} on Pepper Lists It by Top Speed OS.`)}">
  <meta property="og:url" content="${esc(storefrontUrl)}">${imageMeta}
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(`${seller.name} — Pepper Lists storefront`)}">
</head>
<body style="margin:0;background:#0c1420;color:#eef3ea;font-family:system-ui,-apple-system,'Segoe UI',sans-serif">
  <main style="max-width:640px;margin:0 auto;padding:28px 20px 44px">
    <h1 style="font-size:26px;line-height:1.25;margin:0 0 8px">${esc(seller.name)}</h1>
    <p style="font-size:15px;color:#b7e33c;margin:0 0 6px">${memberLine}${listings.length} live listing${listings.length === 1 ? '' : 's'}</p>
    ${reviewsHtml}
    <div style="margin-top:20px">${cards || '<p style="font-size:15px;color:#c8d2c4">No live listings right now — check back soon.</p>'}</div>
    <p style="font-size:13px;color:#8fa188;margin-top:26px">Pepper Lists It by Top Speed OS — Fort Lauderdale, FL. Open a listing to message the seller through Pepper Lists.</p>
  </main>
</body>
</html>`);
  } catch (error) {
    return next(error);
  }
});

/* ============================ C18 — messaging ============================ */

const messageSchema = z.object({
  body: z.string().trim().min(1).max(2000),
});

/** A conversation party's display name — never an email address. */
function partyName(user) {
  const name = publicSellerName(user, null);
  return name === 'Pepper Lists seller' ? 'Pepper Lists member' : name;
}

function listingBrief(reference) {
  const found = getListingByReference(reference);
  if (!found) return { reference, title: null, priceCents: null };
  return { reference, title: found.listing.title, priceCents: found.listing.priceCents };
}

async function threadSummary(thread, viewerId, { staff = false } = {}) {
  const [last, unread] = await Promise.all([
    messagesRepo.findLastMessage(thread.id),
    viewerId ? messagesRepo.countUnread(thread.id, viewerId) : Promise.resolve(0),
  ]);
  const otherId = viewerId
    ? (thread.buyerUserId === viewerId ? thread.sellerUserId : thread.buyerUserId)
    : null;
  const other = otherId ? await findUserByIdDual(otherId) : null;
  const base = {
    id: thread.id,
    listing: listingBrief(thread.listingReference),
    status: thread.status,
    lastMessage: last
      ? { body: last.body, createdAt: iso(last.createdAt), senderIsMe: viewerId ? last.senderUserId === viewerId : false }
      : null,
    unreadCount: unread,
    lastMessageAt: iso(thread.lastMessageAt),
    createdAt: iso(thread.createdAt),
    updatedAt: iso(thread.updatedAt),
  };
  if (viewerId) {
    base.role = thread.buyerUserId === viewerId ? 'BUYER' : 'SELLER';
    base.otherParty = { userId: otherId, name: partyName(other) };
  }
  if (staff) {
    const [buyer, seller] = await Promise.all([
      findUserByIdDual(thread.buyerUserId),
      findUserByIdDual(thread.sellerUserId),
    ]);
    base.buyer = { userId: thread.buyerUserId, name: partyName(buyer), email: buyer?.email ?? null };
    base.seller = { userId: thread.sellerUserId, name: partyName(seller), email: seller?.email ?? null };
    const messages = await messagesRepo.listMessages(thread.id);
    base.messageCount = messages.length;
  }
  return base;
}

async function threadFull(thread, viewerId) {
  const summary = await threadSummary(thread, viewerId);
  const rows = await messagesRepo.listMessages(thread.id);
  const names = new Map();
  for (const row of rows) {
    if (!names.has(row.senderUserId)) {
      const user = await findUserByIdDual(row.senderUserId);
      names.set(row.senderUserId, partyName(user));
    }
  }
  return {
    thread: summary,
    messages: rows.map((row) => ({
      id: row.id,
      body: row.body,
      createdAt: iso(row.createdAt),
      readAt: iso(row.readAt),
      senderIsMe: row.senderUserId === viewerId,
      senderName: names.get(row.senderUserId),
    })),
  };
}

function partyOr404(req, res, thread) {
  if (!thread || (thread.buyerUserId !== req.user.id && thread.sellerUserId !== req.user.id)) {
    res.status(404).json({ error: 'Conversation not found' });
    return false;
  }
  return true;
}

async function consumeMessageBudget(req, res) {
  const verdict = await consumeIntakeAttempt('pepperListsMessage', `user:${req.user.id}`);
  if (verdict.allowed) return true;
  res.set('Retry-After', String(verdict.retryAfterSeconds));
  res.status(429).json({ error: 'Too many messages in the last hour — take a short break and try again.', code: 'RATE_LIMITED' });
  return false;
}

const NOTIFY_THROTTLE_MS = 15 * 60 * 1000;

/**
 * Email the other party through the notification outbox. Throttled
 * to one email per thread per 15 minutes (best-effort against the
 * in-memory outbox working set — a cold start can let one extra
 * through, never fewer than the truth). A notification failure
 * never fails the message send.
 */
function notifyOtherParty({ thread, message, recipientId, senderName }) {
  try {
    const keyPrefix = `plmsg:${thread.id}:`;
    const now = Date.now();
    const recent = (store.notificationOutbox || []).some((entry) => (
      typeof entry.eventKey === 'string'
      && entry.eventKey.startsWith(keyPrefix)
      && entry.eventKey.endsWith(`:${recipientId}`)
      && now - new Date(entry.createdAt).getTime() < NOTIFY_THROTTLE_MS
    ));
    if (recent) return;
    void (async () => {
      const recipient = await findUserByIdDual(recipientId);
      if (!recipient?.email) return;
      const brief = listingBrief(thread.listingReference);
      const title = brief.title || 'your listing';
      const recipientIsSeller = thread.sellerUserId === recipientId;
      const subject = recipientIsSeller
        ? `New message about your listing \u201C${title}\u201D — Pepper Lists`
        : `New reply about \u201C${title}\u201D — Pepper Lists`;
      const excerpt = message.body.length > 400 ? `${message.body.slice(0, 400)}\u2026` : message.body;
      queueNotification({
        channel: 'email',
        template: NOTIFICATION_TEMPLATES.PEPPER_LISTS_MESSAGE,
        to: recipient.email,
        payload: {
          subject,
          message: `${senderName} sent you a message on Pepper Lists about \u201C${title}\u201D:\n\n\u201C${excerpt}\u201D\n\nRead and reply in Pepper Lists: https://pepperlists.com/\nSign in with this account\u2019s email to open your messages.\n\nKeep the conversation on Pepper Lists — never pay by gift card or wire transfer, and never share payment details by message.`,
        },
        source: 'pepper-lists',
        eventKey: `plmsg:${thread.id}:${message.id}:${recipientId}`,
        eventType: 'PEPPER_LISTS_MESSAGE',
      });
    })().catch((error) => {
      console.error(JSON.stringify({ level: 'error', message: 'pepper lists message notify failed', error: String(error?.message || error) }));
    });
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', message: 'pepper lists message notify failed', error: String(error?.message || error) }));
  }
}

// Start (or continue) the buyer's thread on a listing.
router.post('/pepper-lists/listings/:reference/messages', authenticate, async (req, res, next) => {
  try {
    const found = getListingByReference(req.params.reference);
    if (!found) return res.status(404).json({ error: 'Listing not found' });
    const parsed = messageSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid message', details: parsed.error.flatten() });
    }
    const seller = await findUserByEmailDual(found.connection.email);
    if (!seller) {
      return res.status(422).json({ error: 'The seller of this listing cannot receive messages right now.' });
    }
    if (seller.id === req.user.id) {
      return res.status(400).json({ error: 'This is your own listing — buyers reach you here when they write. You will see their messages in your Pepper Lists inbox.' });
    }
    if (!(await consumeMessageBudget(req, res))) return undefined;
    const { thread } = await messagesRepo.getOrCreate({
      connectionId: found.connection.id,
      listingReference: found.listing.reference,
      sellerUserId: seller.id,
      buyerUserId: req.user.id,
    });
    if (thread.status === 'CLOSED') {
      return res.status(409).json({ error: 'This conversation was closed by the Top Speed office.' });
    }
    const message = await messagesRepo.addMessage({
      threadId: thread.id,
      senderUserId: req.user.id,
      body: parsed.data.body,
    });
    const me = await findUserByIdDual(req.user.id);
    notifyOtherParty({ thread, message, recipientId: seller.id, senderName: partyName(me) });
    const fresh = await messagesRepo.findById(thread.id);
    return res.status(201).json({ data: await threadFull(fresh, req.user.id) });
  } catch (error) {
    return next(error);
  }
});

router.get('/pepper-lists/threads', authenticate, async (req, res, next) => {
  try {
    const rows = await messagesRepo.listForUser(req.user.id);
    const threads = [];
    for (const thread of rows) threads.push(await threadSummary(thread, req.user.id));
    return res.json({ data: { threads } });
  } catch (error) {
    return next(error);
  }
});

// Registered before /threads/:threadId so "reported" is not read as an id.
router.get('/pepper-lists/threads/reported', ...staffGate, async (req, res, next) => {
  try {
    const rows = await messagesRepo.listReported(100);
    const threads = [];
    for (const thread of rows) threads.push(await threadSummary(thread, null, { staff: true }));
    return res.json({ data: { count: threads.length, threads } });
  } catch (error) {
    return next(error);
  }
});

router.get('/pepper-lists/threads/:threadId', authenticate, async (req, res, next) => {
  try {
    const thread = await messagesRepo.findById(req.params.threadId);
    if (!partyOr404(req, res, thread)) return undefined;
    // Opening the conversation marks the other party's messages read.
    await messagesRepo.markRead(thread.id, req.user.id);
    const fresh = await messagesRepo.findById(thread.id);
    return res.json({ data: await threadFull(fresh, req.user.id) });
  } catch (error) {
    return next(error);
  }
});

router.post('/pepper-lists/threads/:threadId/messages', authenticate, async (req, res, next) => {
  try {
    const thread = await messagesRepo.findById(req.params.threadId);
    if (!partyOr404(req, res, thread)) return undefined;
    const parsed = messageSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid message', details: parsed.error.flatten() });
    }
    if (thread.status === 'CLOSED') {
      return res.status(409).json({ error: 'This conversation was closed by the Top Speed office.' });
    }
    if (!(await consumeMessageBudget(req, res))) return undefined;
    const message = await messagesRepo.addMessage({
      threadId: thread.id,
      senderUserId: req.user.id,
      body: parsed.data.body,
    });
    const otherId = thread.buyerUserId === req.user.id ? thread.sellerUserId : thread.buyerUserId;
    const me = await findUserByIdDual(req.user.id);
    notifyOtherParty({ thread, message, recipientId: otherId, senderName: partyName(me) });
    const fresh = await messagesRepo.findById(thread.id);
    return res.json({ data: await threadFull(fresh, req.user.id) });
  } catch (error) {
    return next(error);
  }
});

const reportSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

// A party reports the conversation: the thread is flagged and a
// PepperReport lands in the staff queue (the Pepper console) — the
// same queue the office already works.
router.post('/pepper-lists/threads/:threadId/report', authenticate, async (req, res, next) => {
  try {
    const thread = await messagesRepo.findById(req.params.threadId);
    if (!partyOr404(req, res, thread)) return undefined;
    const parsed = reportSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid report', details: parsed.error.flatten() });
    }
    if (thread.status === 'CLOSED') {
      return res.status(409).json({ error: 'This conversation is already closed.' });
    }
    if (thread.status === 'REPORTED') {
      return res.json({ data: { thread: await threadSummary(thread, req.user.id) } });
    }
    const role = thread.buyerUserId === req.user.id ? 'buyer' : 'seller';
    await pepperReportsRepo.create({
      title: `Pepper Lists message thread reported — listing ${thread.listingReference}`,
      body: [
        `Thread: ${thread.id}`,
        `Listing: ${thread.listingReference}`,
        `Reported by: ${req.user.id} (the ${role} in this conversation)`,
        `Reason: ${parsed.data.reason || 'No reason given'}`,
        'Review the conversation in the Pepper Lists staff moderation lane (reported threads) and close it if it breaks the rules.',
      ].join('\n'),
      category: 'INCIDENT',
      createdByUserId: req.user.id,
    });
    const updated = await messagesRepo.setStatus(thread.id, 'REPORTED');
    return res.json({ data: { thread: await threadSummary(updated, req.user.id) } });
  } catch (error) {
    return next(error);
  }
});

/* ------------------------- staff moderation ------------------------- */

router.get('/pepper-lists/threads/:threadId/staff', ...staffGate, async (req, res, next) => {
  try {
    const thread = await messagesRepo.findById(req.params.threadId);
    if (!thread) return res.status(404).json({ error: 'Conversation not found' });
    const summary = await threadSummary(thread, null, { staff: true });
    const rows = await messagesRepo.listMessages(thread.id);
    return res.json({
      data: {
        thread: summary,
        messages: rows.map((row) => ({
          id: row.id,
          body: row.body,
          createdAt: iso(row.createdAt),
          readAt: iso(row.readAt),
          senderUserId: row.senderUserId,
          senderIsBuyer: row.senderUserId === thread.buyerUserId,
        })),
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/pepper-lists/threads/:threadId/close', ...staffGate, async (req, res, next) => {
  try {
    const thread = await messagesRepo.findById(req.params.threadId);
    if (!thread) return res.status(404).json({ error: 'Conversation not found' });
    const updated = thread.status === 'CLOSED' ? thread : await messagesRepo.setStatus(thread.id, 'CLOSED');
    return res.json({ data: { thread: await threadSummary(updated, null, { staff: true }) } });
  } catch (error) {
    return next(error);
  }
});

export default router;
