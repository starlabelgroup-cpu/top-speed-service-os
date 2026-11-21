import { z } from 'zod';

/**
 * Intake attribution — where a lead came from (Fusion absorb Stage 3,
 * 2026-11-12). The Fusion lead form collected the landing `page` and the
 * UTM campaign on every submission, but the Service OS intake schemas
 * silently stripped them. These fields close that gap on both public
 * intake endpoints (POST /speedy/book, POST /connections).
 *
 * Everything is optional and additive: existing clients that send none
 * of it validate exactly as before, and records made without it carry
 * no attribution object at all.
 *
 * Accepted shapes (normalized by normalizeAttribution):
 *   page / via                       plain strings
 *   utmSource / utm_source           camelCase or snake_case
 *   utmMedium / utm_medium
 *   utmCampaign / utm_campaign
 *   utm                              a raw string ("utm_source=google&utm_medium=cpc…",
 *                                    the Fusion form's single textarea) or an
 *                                    object { source, medium, campaign }
 *
 * The normalized shape stored on booking/connection records:
 *   { page, via, utmSource, utmMedium, utmCampaign, utmTerm,
 *     utmContent }  (present keys only)
 * Persistence flattens it to the sourcePage / viaTag / utmSource /
 * utmMedium / utmCampaign / utmTerm / utmContent columns (see the
 * intake_attribution + booking_utm_term_content migrations).
 *
 * Top Speed Ads (2026-11-17): the platform click IDs ride along —
 * gclid (Google), fbclid (Meta), msclkid (Microsoft) — captured
 * first-touch on the landing page by shared/attribution-capture.js
 * and stored in the matching ServiceRequest columns (see the
 * top_speed_ads migration). The click-id fields are deliberately
 * UNTYPED here (z.any): a malformed click id must never fail a
 * booking — normalizeAttribution's clean() keeps real strings and
 * drops everything else.
 */

const shortText = (max) => z.string().trim().max(max).optional();
const clickId = z.any().optional();

export const attributionFields = {
  page: shortText(1000),
  via: shortText(200),
  utmSource: shortText(200),
  utm_source: shortText(200),
  utmMedium: shortText(200),
  utm_medium: shortText(200),
  utmCampaign: shortText(200),
  utm_campaign: shortText(200),
  utmTerm: shortText(200),
  utm_term: shortText(200),
  utmContent: shortText(200),
  utm_content: shortText(200),
  gclid: clickId,
  fbclid: clickId,
  msclkid: clickId,
  utm: z
    .union([
      z.string().trim().max(1000),
      z.object({
        source: shortText(200),
        medium: shortText(200),
        campaign: shortText(200),
        term: shortText(200),
        content: shortText(200),
        utm_source: shortText(200),
        utm_medium: shortText(200),
        utm_campaign: shortText(200),
        utm_term: shortText(200),
        utm_content: shortText(200),
      }),
    ])
    .optional(),
};

function clean(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 1000) : null;
}

function parseRawUtm(raw) {
  const found = {};
  if (!raw) return found;
  if (typeof raw === 'object') {
    found.utmSource = clean(raw.utm_source ?? raw.source);
    found.utmMedium = clean(raw.utm_medium ?? raw.medium);
    found.utmCampaign = clean(raw.utm_campaign ?? raw.campaign);
    found.utmTerm = clean(raw.utm_term ?? raw.term);
    found.utmContent = clean(raw.utm_content ?? raw.content);
    return found;
  }
  try {
    const params = new URLSearchParams(String(raw).replace(/^\?/, ''));
    found.utmSource = clean(params.get('utm_source'));
    found.utmMedium = clean(params.get('utm_medium'));
    found.utmCampaign = clean(params.get('utm_campaign'));
    found.utmTerm = clean(params.get('utm_term'));
    found.utmContent = clean(params.get('utm_content'));
    found.gclid = clean(params.get('gclid'));
    found.fbclid = clean(params.get('fbclid'));
    found.msclkid = clean(params.get('msclkid'));
  } catch {
    // An unparseable raw utm string is ignored, never an error.
  }
  return found;
}

/**
 * Merge every accepted attribution shape in a parsed request body into
 * the single normalized object (explicit fields win over the raw utm
 * string). Returns null when the submission carried no attribution.
 */
export function normalizeAttribution(data) {
  if (!data) return null;
  const fromRaw = parseRawUtm(data.utm);
  const attribution = {};
  const page = clean(data.page);
  const via = clean(data.via);
  const utmSource = clean(data.utmSource ?? data.utm_source) ?? fromRaw.utmSource;
  const utmMedium = clean(data.utmMedium ?? data.utm_medium) ?? fromRaw.utmMedium;
  const utmCampaign = clean(data.utmCampaign ?? data.utm_campaign) ?? fromRaw.utmCampaign;
  const utmTerm = clean(data.utmTerm ?? data.utm_term) ?? fromRaw.utmTerm;
  const utmContent = clean(data.utmContent ?? data.utm_content) ?? fromRaw.utmContent;
  const gclid = clean(data.gclid) ?? fromRaw.gclid;
  const fbclid = clean(data.fbclid) ?? fromRaw.fbclid;
  const msclkid = clean(data.msclkid) ?? fromRaw.msclkid;
  if (page) attribution.page = page;
  if (via) attribution.via = via;
  if (utmSource) attribution.utmSource = utmSource;
  if (utmMedium) attribution.utmMedium = utmMedium;
  if (utmCampaign) attribution.utmCampaign = utmCampaign;
  if (utmTerm) attribution.utmTerm = utmTerm;
  if (utmContent) attribution.utmContent = utmContent;
  if (gclid) attribution.gclid = gclid;
  if (fbclid) attribution.fbclid = fbclid;
  if (msclkid) attribution.msclkid = msclkid;
  return Object.keys(attribution).length ? attribution : null;
}

/** Flatten a normalized attribution object into DB column values. */
export function attributionToColumns(attribution) {
  return {
    sourcePage: attribution?.page ?? null,
    viaTag: attribution?.via ?? null,
    utmSource: attribution?.utmSource ?? null,
    utmMedium: attribution?.utmMedium ?? null,
    utmCampaign: attribution?.utmCampaign ?? null,
    utmTerm: attribution?.utmTerm ?? null,
    utmContent: attribution?.utmContent ?? null,
    gclid: attribution?.gclid ?? null,
    fbclid: attribution?.fbclid ?? null,
    msclkid: attribution?.msclkid ?? null,
  };
}

/** Rebuild the normalized object from DB columns (null when all empty). */
export function attributionFromColumns(row) {
  if (!row) return null;
  const attribution = {};
  if (row.sourcePage) attribution.page = row.sourcePage;
  if (row.viaTag) attribution.via = row.viaTag;
  if (row.utmSource) attribution.utmSource = row.utmSource;
  if (row.utmMedium) attribution.utmMedium = row.utmMedium;
  if (row.utmCampaign) attribution.utmCampaign = row.utmCampaign;
  if (row.utmTerm) attribution.utmTerm = row.utmTerm;
  if (row.utmContent) attribution.utmContent = row.utmContent;
  if (row.gclid) attribution.gclid = row.gclid;
  if (row.fbclid) attribution.fbclid = row.fbclid;
  if (row.msclkid) attribution.msclkid = row.msclkid;
  return Object.keys(attribution).length ? attribution : null;
}
