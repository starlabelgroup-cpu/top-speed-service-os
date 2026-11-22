import { Router } from 'express';
import { z } from 'zod';
import { store } from '../data/store.js';
import { countSubmissionMedia, listSubmissionMedia } from '../db/submissionMediaRepo.js';
import { crossPostsRepo } from '../db/pepperListsCrossPostsRepo.js';
import { sellerChannelsRepo } from '../db/sellerChannelsRepo.js';
import { findUserByIdDual } from '../services/pepperSyndication.js';
import { ROLES } from '../config/security.js';
import { getPaymentsSetting } from '../db/paymentsRailsRepo.js';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { STAFF_ROLES } from '../config/security.js';
import {
  catalogCsv,
  facebookCondition,
  getListingByReference,
  listingPhotoUrl,
  listingViewUrl,
  listPublicListings,
} from '../services/pepperListings.js';

/**
 * Pepper Lists — Facebook compatibility, Phase A (2026-11-20).
 *
 * Four honest pieces, and one hard rule that runs through all of
 * them: NOTHING in this file writes to Facebook. There is no
 * official API for personal-profile Marketplace posting; posting
 * runs through the owner's connected Facebook account, executed by
 * Pepper behind Ramone's per-listing approval — exactly the manual
 * flow that predates this build.
 *
 *  1. GET /pepper-lists/catalog.csv — a public data feed of the
 *     live Pepper Lists listings in Facebook Commerce catalog
 *     format, so the existing Commerce catalog can pull Pepper
 *     Lists inventory on a schedule. Only real, currently-available
 *     listings (a listing is available while its record exists;
 *     the office removes a record to remove the listing).
 *  2. GET /pepper-lists/listings/:reference/view — the shareable
 *     listing page: complete Open Graph + Twitter card meta with
 *     the listing's real title, description, price and photo, and
 *     the canonical URL on pepperlists.com, so a link pasted into
 *     Facebook renders a rich card. (vercel.json rewrites
 *     pepperlists.com/listing/:reference to this page.)
 *  3. GET /pepper-lists/listings/:reference/photo/:index — the
 *     listing's photos as public bytes. Catalog image_link and
 *     og:image need a URL Facebook can fetch anonymously; listing
 *     photos are the seller's marketing photos, published by the
 *     seller's own confirm. ONLY PEPPER_LISTS_SELL records resolve
 *     here — Scan & Send / Live Video media stays staff-only.
 *  4. The cross-post queue — POST .../cross-posts (the listing's
 *     owner) files a QUEUED PepperListsCrossPost; staff record the
 *     real outcome via POST /pepper-lists/cross-posts/:id/outcome
 *     (POSTED with the real Facebook listing URL, or FAILED with
 *     the real reason). The seller-facing status is the truth:
 *     "Queued for posting", "Posted — view on Facebook",
 *     "Couldn't post — <reason>".
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

function publicCrossPost(row) {
  return {
    id: row.id,
    listingReference: row.listingReference,
    target: row.target,
    pageId: row.pageId ?? null,
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
 * Resolve a listing the signed-in user OWNS. Ownership is the
 * account-email match the listing was confirmed under (the same
 * identity the POST /pepper-lists/listings route stamps on the
 * record). Anything else — unknown reference, not a listing, or
 * someone else's listing — is the same 404, so the queue can never
 * be used to probe other sellers' listings.
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

// ── 1. Facebook Commerce catalog feed (public) ─────────────────────
router.get('/pepper-lists/catalog.csv', async (req, res, next) => {
  try {
    const listings = listPublicListings();
    const counts = new Map();
    await Promise.all(listings.map(async (listing) => {
      counts.set(listing.reference, await countSubmissionMedia(listing.connectionId));
    }));
    const csv = catalogCsv(listings, (listing) => counts.get(listing.reference) || 0);
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    });
    return res.send(csv);
  } catch (error) {
    return next(error);
  }
});

// ── 2. Shareable listing view with Open Graph meta (public) ───────
router.get('/pepper-lists/listings/:reference/view', async (req, res, next) => {
  try {
    const found = getListingByReference(req.params.reference);
    if (!found) return res.status(404).send('Listing not found');
    const { listing } = found;
    const photoCount = await countSubmissionMedia(listing.connectionId);
    const viewUrl = listingViewUrl(listing.reference);
    const description = listing.description
      || `${listing.title} — for sale on Pepper Lists It by Top Speed OS, Fort Lauderdale, FL.`;
    const price = (listing.priceCents / 100).toFixed(2);
    const imageMeta = photoCount > 0
      ? `\n  <meta property="og:image" content="${esc(listingPhotoUrl(listing.reference, 0))}">`
        + `\n  <meta name="twitter:image" content="${esc(listingPhotoUrl(listing.reference, 0))}">`
      : '';
    const photoHtml = photoCount > 0
      ? `<img src="${esc(listingPhotoUrl(listing.reference, 0))}" alt="${esc(listing.title)}" style="width:100%;border-radius:14px;display:block;margin-bottom:16px">`
      : '';
    const facts = [
      `<b>$${price}</b>`,
      listing.condition ? esc(listing.condition) : null,
      listing.category ? esc(listing.category) : null,
    ].filter(Boolean).join(' · ');
    // C19 protected payments: honest state copy — while the owner
    // activation flag is off the feature is announced as coming,
    // never presented as available.
    const setting = await getPaymentsSetting().catch(() => null);
    const ppBlock = setting?.connectEnabled === true
      ? `<div style="border:1.5px solid #2c4232;border-radius:14px;padding:14px 16px;font-size:14.5px;line-height:1.55;margin:0 0 22px"><b>Protected payment available.</b> This item can be bought with a protected payment inside Pepper Lists — payment is processed by Stripe and the seller is paid through their own connected account.</div>`
      : `<div style="border:1.5px solid #2c4232;border-radius:14px;padding:14px 16px;font-size:14.5px;line-height:1.55;margin:0 0 22px"><b>Protected payments are coming.</b> Soon you will be able to pay for this item right inside Pepper Lists, with your payment held safely until handover. For now, contact the seller to arrange the sale.</div>`;
    res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
    return res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(listing.title)} — $${price} | Pepper Lists It</title>
  <meta name="description" content="${esc(description)}">
  <link rel="canonical" href="${esc(viewUrl)}">
  <meta property="og:type" content="product">
  <meta property="og:site_name" content="Pepper Lists It">
  <meta property="og:title" content="${esc(listing.title)} — $${price}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:url" content="${esc(viewUrl)}">${imageMeta}
  <meta property="product:price:amount" content="${price}">
  <meta property="product:price:currency" content="USD">
  <meta property="product:condition" content="${esc(facebookCondition(listing.condition))}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(listing.title)} — $${price}">
  <meta name="twitter:description" content="${esc(description)}">
</head>
<body style="margin:0;background:#0c1420;color:#eef3ea;font-family:system-ui,-apple-system,'Segoe UI',sans-serif">
  <main style="max-width:640px;margin:0 auto;padding:28px 20px 44px">
    ${photoHtml}
    <h1 style="font-size:26px;line-height:1.25;margin:0 0 8px">${esc(listing.title)}</h1>
    <p style="font-size:17px;color:#b7e33c;margin:0 0 14px">${facts}</p>
    ${listing.description ? `<p style="font-size:15px;line-height:1.65;color:#c8d2c4;margin:0 0 22px">${esc(listing.description)}</p>` : ''}
    ${ppBlock}
    <a href="https://pepperlists.com/" style="display:inline-block;background:#b7e33c;color:#101608;font-weight:700;text-decoration:none;padding:12px 22px;border-radius:10px">See it on Pepper Lists</a>
    <a href="https://pepperlists.com/?message=${encodeURIComponent(listing.reference)}" style="display:inline-block;border:1px solid #b7e33c;color:#b7e33c;font-weight:700;text-decoration:none;padding:12px 22px;border-radius:10px;margin-left:10px">Message the seller</a>
    <p style="font-size:13px;color:#8fa188;margin-top:26px">Pepper Lists It by Top Speed OS — Fort Lauderdale, FL. Message the seller through Pepper Lists.</p>
  </main>
</body>
</html>`);
  } catch (error) {
    return next(error);
  }
});

// ── 3. Listing photos as public bytes (SELL listings only) ────────
router.get('/pepper-lists/listings/:reference/photo/:index', async (req, res, next) => {
  try {
    const found = getListingByReference(req.params.reference);
    if (!found) return res.status(404).json({ error: 'Listing not found' });
    const index = Number(req.params.index);
    if (!Number.isInteger(index) || index < 0 || index > 20) {
      return res.status(404).json({ error: 'Photo not found' });
    }
    const rows = await listSubmissionMedia(found.connection.id);
    const photos = rows.filter((row) => row.kind === 'photo');
    const row = photos[index];
    if (!row) return res.status(404).json({ error: 'Photo not found' });
    const match = /^data:([^;,]+);base64,([\s\S]*)$/.exec(row.dataUrl || '');
    if (!match) return res.status(500).json({ error: 'Stored photo is unreadable' });
    const bytes = Buffer.from(match[2], 'base64');
    res.set({
      'Content-Type': row.mime || match[1] || 'image/jpeg',
      'Cache-Control': 'public, max-age=86400',
      'Content-Length': bytes.length,
    });
    return res.end(bytes);
  } catch (error) {
    return next(error);
  }
});

// ── 4. Cross-post queue ────────────────────────────────────────────
const crossPostSchema = z.object({
  target: z.enum(['MARKETPLACE', 'PAGE']),
  pageId: z.string().trim().max(120).optional(),
});

router.post('/pepper-lists/listings/:reference/cross-posts', authenticate, async (req, res, next) => {
  const found = resolveOwnedListing(req, res);
  if (!found) return undefined;
  try {
    const parsed = crossPostSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid cross-post request', details: parsed.error.flatten() });
    }
    const { row, duplicate } = await crossPostsRepo.create({
      connectionId: found.connection.id,
      listingReference: found.listing.reference,
      userId: req.user.id,
      target: parsed.data.target,
      pageId: parsed.data.pageId,
    });
    if (duplicate) {
      return res.status(409).json({
        error: 'This listing is already queued for that Facebook target',
        data: { crossPost: publicCrossPost(row) },
      });
    }
    return res.status(201).json({ data: { crossPost: publicCrossPost(row) } });
  } catch (error) {
    return next(error);
  }
});

router.get('/pepper-lists/listings/:reference/cross-posts', authenticate, async (req, res, next) => {
  const found = resolveOwnedListing(req, res);
  if (!found) return undefined;
  try {
    const rows = await crossPostsRepo.listForConnection(found.connection.id);
    return res.json({ data: { crossPosts: rows.map(publicCrossPost) } });
  } catch (error) {
    return next(error);
  }
});

const staffGate = [authenticate, requireCompany, requireRole(...STAFF_ROLES)];

// The office/Pepper worklist: what is waiting to be posted, oldest
// first. Pepper works this queue through the connected Facebook
// account, one listing at a time, behind Ramone's approval.
router.get('/pepper-lists/cross-posts/queue', ...staffGate, async (req, res, next) => {
  try {
    const rows = await crossPostsRepo.listQueued(200);
    return res.json({ data: { count: rows.length, crossPosts: rows.map(publicCrossPost) } });
  } catch (error) {
    return next(error);
  }
});

const outcomeSchema = z.object({
  status: z.enum(['POSTED', 'FAILED']),
  externalUrl: z.string().trim().max(1000).optional(),
  externalId: z.string().trim().max(120).optional(),
  error: z.string().trim().max(500).optional(),
});

function isFacebookUrl(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:'
      && (url.hostname === 'facebook.com' || url.hostname.endsWith('.facebook.com'));
  } catch {
    return false;
  }
}

router.post('/pepper-lists/cross-posts/:id/outcome', ...staffGate, async (req, res, next) => {
  try {
    const parsed = outcomeSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid outcome', details: parsed.error.flatten() });
    }
    const data = parsed.data;
    if (data.status === 'POSTED') {
      if (!data.externalUrl || !isFacebookUrl(data.externalUrl)) {
        return res.status(400).json({ error: 'A posted outcome needs the real Facebook listing URL (an https://facebook.com link)' });
      }
    }
    if (data.status === 'FAILED' && (!data.error || data.error.length < 3)) {
      return res.status(400).json({ error: 'A failed outcome needs the reason it could not post' });
    }
    const existing = await crossPostsRepo.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Cross-post not found' });
    // The Facebook gateway (Ramone, 2026-11-21: "Muse is the
    // gateway to Facebook"): grant check → owner approval (this
    // staff outcome IS the approval step) → post via Top Speed's
    // connected account → real URL recorded → action logged on the
    // seller's account. A POSTED outcome therefore requires the
    // seller's Facebook agent grant ON — except when the seller IS
    // the platform owner, whose own per-listing approval rule
    // governs his account. FAILED bookkeeping stays ungated.
    if (data.status === 'POSTED') {
      const seller = await findUserByIdDual(existing.userId);
      const sellerIsOwner = Array.isArray(seller?.roles) && seller.roles.includes(ROLES.COMPANY_OWNER);
      if (!sellerIsOwner) {
        const conn = await sellerChannelsRepo.findForUserChannel(existing.userId, 'FACEBOOK');
        if (!conn || conn.agentAccessGranted !== true) {
          return res.status(403).json({
            error: 'The seller has not granted agent access for Facebook, so Pepper cannot post for them. Ask the seller to turn on "Allow Pepper to manage this channel" on their Facebook channel card first.',
            code: 'AGENT_GRANT_REQUIRED',
          });
        }
      }
    }
    const { row, conflict } = await crossPostsRepo.markOutcome(req.params.id, {
      status: data.status,
      externalId: data.externalId,
      externalUrl: data.status === 'POSTED' ? data.externalUrl : undefined,
      error: data.status === 'FAILED' ? data.error : undefined,
      outcomeById: req.user.id,
    });
    if (!row) return res.status(404).json({ error: 'Cross-post not found' });
    if (conflict) {
      return res.status(409).json({
        error: 'This cross-post already has an outcome',
        data: { crossPost: publicCrossPost(row) },
      });
    }
    // The agent-action log the seller's channel page promises.
    await sellerChannelsRepo.recordAgentAction(
      row.userId, 'FACEBOOK', 'SELL',
      row.status === 'POSTED'
        ? `Pepper posted listing ${row.listingReference} to Facebook through the Top Speed account — ${row.externalUrl}`
        : `Pepper could not post listing ${row.listingReference} to Facebook — ${row.error}`,
    );
    return res.json({ data: { crossPost: publicCrossPost(row) } });
  } catch (error) {
    return next(error);
  }
});

export default router;
