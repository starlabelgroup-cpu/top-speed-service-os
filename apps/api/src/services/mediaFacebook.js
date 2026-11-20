import { platformFacebookConnection } from './facebookConnector.js';
import { mediaFacebookRepo } from '../db/mediaFacebookRepo.js';

/**
 * Media OS → Facebook Page publishing (2026-11-20, Wave 3 E6).
 *
 * THE BRAND-CORRECT PAGE: "Repair & Installation" — the Top Speed
 * Appliance repair Page, Facebook Page id 1437372132795817. NOT the
 * Sales & Delivery Page, NOT Cleanout Vents, and never the
 * Appliance Plus Air Page (a separate LLC — hands off, standing
 * rule). Media OS content is repair/platform content, so the repair
 * Page is its home.
 *
 * THE HONEST PIPELINE (same model as the Pepper Lists cross-post
 * queue): facebook_cli is Pepper's operator-side connector — the
 * API server has no Facebook write path and this service creates
 * none. Publishing Media OS content creates a ready-to-post PACKAGE
 * (message + link + image) in the queue; Pepper posts it through
 * the owner's connected Facebook account behind Ramone's approval;
 * staff then record the real outcome. Until a real facebook.com
 * post URL is recorded, the status reads "Queued for posting" —
 * the platform never presents a queued post as published.
 */
export const MEDIA_FACEBOOK_PAGE = {
  id: '1437372132795817',
  name: 'Top Speed Appliance — Repair & Installation',
  url: 'https://www.facebook.com/profile.php?id=1437372132795817',
};

const PUBLIC_MEDIA_URL = 'https://topspeedserviceos.com/media';

/** The ready-to-post package for one Media OS record. */
export function buildFacebookPackage(record) {
  const linkUrl = record.destinationUrl || PUBLIC_MEDIA_URL;
  const lines = [record.title];
  if (record.description) lines.push('', record.description);
  lines.push('', linkUrl);
  if (Array.isArray(record.tags) && record.tags.length) {
    lines.push('', record.tags.map((t) => `#${String(t).replace(/\s+/g, '')}`).join(' '));
  }
  return {
    message: lines.join('\n'),
    linkUrl,
    imageUrl: record.thumbnailUrl || record.assetUrl || null,
  };
}

/**
 * Queue a Facebook post for a PUBLISHED Media OS record. Returns:
 *  { queued: true, duplicate, row }         — package is in the queue
 *  { queued: false, reason: 'not_connected' } — the platform Facebook
 *    attestation is absent/disabled, so nothing may present
 *    Facebook as connected and nothing is queued.
 */
export async function queueMediaFacebookPost(record) {
  if (!platformFacebookConnection()) return { queued: false, reason: 'not_connected' };
  const existing = await mediaFacebookRepo.findQueued(record.id);
  if (existing) return { queued: true, duplicate: true, row: existing };
  const pkg = buildFacebookPackage(record);
  const { row, duplicate } = await mediaFacebookRepo.create({
    contentId: record.id,
    contentSlug: record.slug,
    pageId: MEDIA_FACEBOOK_PAGE.id,
    pageName: MEDIA_FACEBOOK_PAGE.name,
    message: pkg.message,
    linkUrl: pkg.linkUrl,
    imageUrl: pkg.imageUrl,
  });
  return { queued: true, duplicate, row };
}

/** Truthful display state for one content record's latest queue row. */
export function facebookDisplayFor(row) {
  if (!row) return null;
  if (row.status === 'POSTED') {
    return { state: 'POSTED', label: `Published — ${row.externalUrl}`, url: row.externalUrl, queueId: row.id };
  }
  if (row.status === 'FAILED') {
    return { state: 'FAILED', label: `Couldn't post — ${row.error || 'posting failed'}`, url: null, queueId: row.id };
  }
  return { state: 'QUEUED', label: 'Queued for posting', url: null, queueId: row.id };
}

/** Latest queue row per content id, for the admin console lists. */
export async function facebookSummariesFor(contentIds) {
  const map = new Map();
  for (const id of contentIds) {
    const rows = await mediaFacebookRepo.listForContent(id);
    if (rows.length) map.set(id, facebookDisplayFor(rows[0]));
  }
  return map;
}

export async function facebookSummaryFor(contentId) {
  const rows = await mediaFacebookRepo.listForContent(contentId);
  return rows.length ? facebookDisplayFor(rows[0]) : null;
}

/** The connection truth the console shows next to the queue. */
export function mediaFacebookConnectionState() {
  const connection = platformFacebookConnection();
  return {
    connected: Boolean(connection),
    page: MEDIA_FACEBOOK_PAGE,
    account: connection
      ? { name: connection.accountName, verifiedAt: connection.verifiedAt, via: connection.via }
      : null,
  };
}
