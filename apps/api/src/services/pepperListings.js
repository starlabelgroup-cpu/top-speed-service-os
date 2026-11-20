import { store } from '../data/store.js';

/**
 * Pepper Lists — public listing reads (2026-11-20, Phase A of the
 * Facebook compatibility build).
 *
 * A confirmed Pepper Lists listing IS a Connection record of type
 * PEPPER_LISTS_SELL (see routes/pepperLists.js): the listing facts
 * live verbatim in the record's message lines and the photos on
 * SubmissionMedia rows. This module is the single place that parses
 * those records back into structured listings for the public
 * surfaces that need them — the Facebook catalog feed, the shareable
 * listing view (Open Graph), and the cross-post queue.
 *
 * Availability rule: a listing is public while its record exists.
 * The office removes a listing by deleting the record (the admin
 * delete endpoints), and a deleted record disappears from every
 * surface here on the next read. Records whose message does not
 * parse back into a title + seller-set price are never published —
 * a price is never invented or repaired here.
 */

export const LISTING_SITE_BASE = 'https://pepperlists.com';
export const API_PUBLIC_BASE = 'https://top-speed-service-os.vercel.app/api/v1';

export function listingViewUrl(reference) {
  return `${LISTING_SITE_BASE}/listing/${encodeURIComponent(reference)}`;
}

export function listingPhotoUrl(reference, index = 0) {
  return `${API_PUBLIC_BASE}/pepper-lists/listings/${encodeURIComponent(reference)}/photo/${index}`;
}

function lineValue(lines, prefix) {
  const line = lines.find((l) => l.startsWith(prefix));
  if (!line) return null;
  const value = line.slice(prefix.length).trim();
  return value || null;
}

/**
 * Parse a PEPPER_LISTS_SELL connection record into a structured
 * listing, or null when the record is not a complete listing.
 */
export function parseListing(connection) {
  if (!connection || connection.type !== 'PEPPER_LISTS_SELL') return null;
  const lines = String(connection.message || '').split('\n');
  const title = lineValue(lines, 'Listing title: ');
  const priceLine = lineValue(lines, 'Price: ');
  const priceMatch = priceLine ? /^\$(\d+(?:\.\d{2})?)/.exec(priceLine) : null;
  if (!title || !priceMatch) return null;
  const priceCents = Math.round(Number(priceMatch[1]) * 100);
  if (!Number.isFinite(priceCents) || priceCents < 1) return null;
  return {
    reference: connection.reference,
    connectionId: connection.id,
    title,
    description: lineValue(lines, 'Description: '),
    category: lineValue(lines, 'Category: '),
    condition: lineValue(lines, 'Condition: '),
    priceCents,
    createdAt: connection.createdAt || null,
  };
}

export function getListingByReference(reference) {
  const connection = (store.connections || []).find((c) => c.reference === reference);
  if (!connection) return null;
  const listing = parseListing(connection);
  if (!listing) return null;
  return { connection, listing };
}

export function listPublicListings() {
  return (store.connections || [])
    .map((connection) => parseListing(connection))
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

/** Pepper Lists conditions → Facebook catalog condition values. */
const FB_CONDITIONS = {
  'New': 'new',
  'Used - like new': 'used_like_new',
  'Used - good': 'used_good',
  'Used - fair': 'used_fair',
};

export function facebookCondition(condition) {
  return FB_CONDITIONS[condition] || 'used_good';
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Facebook Commerce catalog feed (the column set Meta's catalog
 * data-feed import expects). Only real, currently-available
 * listings — see the availability rule above.
 */
export const CATALOG_COLUMNS = [
  'id', 'title', 'description', 'availability', 'condition',
  'price', 'link', 'image_link', 'brand',
];

export function catalogCsv(listings, photoCountFor) {
  const rows = [CATALOG_COLUMNS.join(',')];
  for (const listing of listings) {
    const description = listing.description
      || `${listing.title} — listed on Pepper Lists It by Top Speed OS in Fort Lauderdale, FL.`;
    const cells = [
      listing.reference,
      listing.title,
      description,
      'in stock',
      facebookCondition(listing.condition),
      `${(listing.priceCents / 100).toFixed(2)} USD`,
      listingViewUrl(listing.reference),
      photoCountFor && photoCountFor(listing) > 0 ? listingPhotoUrl(listing.reference, 0) : '',
      'Pepper Lists It',
    ];
    rows.push(cells.map(csvCell).join(','));
  }
  return `${rows.join('\n')}\n`;
}
