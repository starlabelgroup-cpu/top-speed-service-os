import { createHash, randomBytes } from 'node:crypto';
import { store } from '../data/store.js';
import { DATABASE_ENABLED, db } from '../db/client.js';
import { parseListing, listingViewUrl, listingPhotoUrl } from './pepperListings.js';

/**
 * Pepper Lists — Phase 2 syndication (2026-11-20, recommendations
 * program C16): eBay + Google Shopping, built the way Facebook
 * Phase A built its side (services/pepperListings.js).
 *
 * The honest shape of both channels:
 *  - Listings syndicate under the SELLER'S OWN account (their eBay
 *    seller account, their Google Merchant Center) — the Phase 1
 *    channel request is how the office learns that account, and
 *    the syndication queue (db/pepperListsSyndicationRepo.js) is
 *    how a listing's trip out is requested and truthfully tracked.
 *  - Google Shopping pulls a per-seller product FEED: the seller
 *    registers one secret feed URL in their own Merchant Center.
 *    The URL carries a random token; only its SHA-256 hash is
 *    stored (on the channel connection's meta), the raw token is
 *    shown to the seller once at issue/rotation — the temp-password
 *    posture. The feed serves ONLY that seller's live listings.
 *  - eBay has no pull feed for this flow: the office works from the
 *    queue and a File Exchange export (below) of the queued items.
 *
 * Availability rule (same as Phase A): a listing is syndicated
 * while its PEPPER_LISTS_SELL record exists and parses — the office
 * removes a listing by deleting the record, and it leaves every
 * feed and export on the next read.
 */

/* ------------------------- seller resolution ------------------------ */

const USER_SELECT = { id: true, email: true, firstName: true, lastName: true, roles: true, createdAt: true };

export async function findUserByIdDual(userId) {
  if (!userId) return null;
  if (DATABASE_ENABLED) {
    try {
      const row = await db().user.findUnique({ where: { id: userId }, select: USER_SELECT });
      if (row) return row;
    } catch { /* fall through to the in-memory record */ }
  }
  const record = store.users.get(userId);
  return record ? { id: userId, ...record } : null;
}

export async function findUserByEmailDual(email) {
  const target = String(email || '').trim().toLowerCase();
  if (!target) return null;
  if (DATABASE_ENABLED) {
    try {
      const row = await db().user.findFirst({
        where: { email: { equals: target, mode: 'insensitive' } },
        select: USER_SELECT,
      });
      if (row) return row;
    } catch { /* fall through to the in-memory records */ }
  }
  for (const [id, record] of store.users.entries()) {
    if (String(record?.email || '').trim().toLowerCase() === target) {
      return { id, ...record };
    }
  }
  return null;
}

/** "Maria G." — first name + last initial, never a full name in public. */
export function publicSellerName(user, fallbackName) {
  let first = String(user?.firstName || '').trim();
  let last = String(user?.lastName || '').trim();
  if (!first) {
    const full = String(fallbackName || '').trim();
    const parts = full.split(/\s+/).filter(Boolean);
    first = parts[0] || '';
    last = parts.slice(1).join(' ');
  }
  if (!first) return 'Pepper Lists seller';
  return last ? `${first} ${last.charAt(0).toUpperCase()}.` : first;
}

/**
 * A seller account's live listings: every PEPPER_LISTS_SELL record
 * stamped with the account's email (the identity listings are
 * confirmed under — the same match the Facebook queue uses),
 * parsed; unparseable records never publish.
 */
export function sellerListingsFor(user) {
  const email = String(user?.email || '').trim().toLowerCase();
  if (!email) return [];
  return (store.connections || [])
    .filter((c) => c.type === 'PEPPER_LISTS_SELL' && String(c.email || '').trim().toLowerCase() === email)
    .map((connection) => ({ connection, listing: parseListing(connection) }))
    .filter((entry) => entry.listing)
    .sort((a, b) => String(b.listing.createdAt || '').localeCompare(String(a.listing.createdAt || '')));
}

/* --------------------------- feed tokens ---------------------------- */

export function newFeedToken() {
  return randomBytes(32).toString('base64url');
}

export function feedTokenHash(token) {
  return createHash('sha256').update(String(token || '')).digest('hex');
}

/* ------------------------- Google Shopping -------------------------- */

/** Pepper Lists conditions → Google Shopping condition values. */
export function googleCondition(condition) {
  return condition === 'New' ? 'new' : 'used';
}

function xmlEsc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * A Google Merchant Center product feed (RSS 2.0 + the Google
 * namespace Merchant Center expects) holding ONE seller's live
 * listings. Prices are the seller's own, formatted "45.00 USD";
 * identifier_exists is "no" — these are one-off local items
 * without manufacturer GTINs, and inventing one would be worse.
 */
export function googleFeedXml({ sellerName, listings, photoUrlsFor }) {
  const items = listings.map(({ listing }) => {
    const photos = photoUrlsFor ? photoUrlsFor(listing) : [];
    const description = listing.description
      || `${listing.title} — listed on Pepper Lists It by Top Speed OS in Fort Lauderdale, FL.`;
    const lines = [
      '    <item>',
      `      <g:id>${xmlEsc(listing.reference)}</g:id>`,
      `      <title>${xmlEsc(listing.title)}</title>`,
      `      <description>${xmlEsc(description)}</description>`,
      `      <link>${xmlEsc(listingViewUrl(listing.reference))}</link>`,
    ];
    if (photos[0]) lines.push(`      <g:image_link>${xmlEsc(photos[0])}</g:image_link>`);
    for (const extra of photos.slice(1, 4)) {
      lines.push(`      <g:additional_image_link>${xmlEsc(extra)}</g:additional_image_link>`);
    }
    lines.push(
      '      <g:availability>in stock</g:availability>',
      `      <g:price>${(listing.priceCents / 100).toFixed(2)} USD</g:price>`,
      `      <g:condition>${googleCondition(listing.condition)}</g:condition>`,
      '      <g:brand>Pepper Lists It</g:brand>',
      '      <g:identifier_exists>no</g:identifier_exists>',
      '    </item>',
    );
    return lines.join('\n');
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">',
    '  <channel>',
    `    <title>${xmlEsc(`Pepper Lists It — ${sellerName}`)}</title>`,
    '    <link>https://pepperlists.com</link>',
    `    <description>${xmlEsc(`Live Pepper Lists listings from ${sellerName}, syndicated to Google Shopping at the seller's request.`)}</description>`,
    ...items,
    '  </channel>',
    '</rss>',
    '',
  ].join('\n');
}

/* ------------------------------ eBay -------------------------------- */

/** Pepper Lists conditions → eBay File Exchange ConditionID values. */
export function ebayConditionId(condition) {
  return condition === 'New' ? '1000' : '3000';
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export const EBAY_EXPORT_COLUMNS = [
  'Action(SiteID=US|Country=US|Currency=USD|Version=1193)',
  'CustomLabel', 'Category', 'Title', 'Description', 'ConditionID',
  'PictureURL', 'Format', 'StartPrice', 'Quantity', 'Duration',
];

/**
 * An eBay File Exchange upload file for the office worklist: one
 * "Add" row per listing, carrying the listing's real facts. The
 * Category column is deliberately EMPTY — eBay category ids are
 * picked per item inside the seller's eBay account, and inventing
 * one here would misfile the listing; the office completes it (and
 * the account's shipping/payment defaults) at upload time.
 */
export function ebayFileExchangeCsv(entries) {
  const rows = [EBAY_EXPORT_COLUMNS.join(',')];
  for (const { listing, photoUrls } of entries) {
    const description = listing.description
      || `${listing.title} — listed on Pepper Lists It by Top Speed OS in Fort Lauderdale, FL.`;
    const cells = [
      'Add',
      listing.reference,
      '',
      String(listing.title || '').slice(0, 140),
      description,
      ebayConditionId(listing.condition),
      (photoUrls || []).slice(0, 4).join('|'),
      'FixedPrice',
      (listing.priceCents / 100).toFixed(2),
      '1',
      'GTC',
    ];
    rows.push(cells.map(csvCell).join(','));
  }
  return `${rows.join('\n')}\n`;
}

export { listingPhotoUrl };
