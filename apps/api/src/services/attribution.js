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
 *   { page, via, utmSource, utmMedium, utmCampaign }  (present keys only)
 * Persistence flattens it to the sourcePage / viaTag / utmSource /
 * utmMedium / utmCampaign columns (see the intake_attribution migration).
 */

const shortText = (max) => z.string().trim().max(max).optional();

export const attributionFields = {
  page: shortText(1000),
  via: shortText(200),
  utmSource: shortText(200),
  utm_source: shortText(200),
  utmMedium: shortText(200),
  utm_medium: shortText(200),
  utmCampaign: shortText(200),
  utm_campaign: shortText(200),
  utm: z
    .union([
      z.string().trim().max(1000),
      z.object({
        source: shortText(200),
        medium: shortText(200),
        campaign: shortText(200),
        utm_source: shortText(200),
        utm_medium: shortText(200),
        utm_campaign: shortText(200),
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
    return found;
  }
  try {
    const params = new URLSearchParams(String(raw).replace(/^\?/, ''));
    found.utmSource = clean(params.get('utm_source'));
    found.utmMedium = clean(params.get('utm_medium'));
    found.utmCampaign = clean(params.get('utm_campaign'));
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
  if (page) attribution.page = page;
  if (via) attribution.via = via;
  if (utmSource) attribution.utmSource = utmSource;
  if (utmMedium) attribution.utmMedium = utmMedium;
  if (utmCampaign) attribution.utmCampaign = utmCampaign;
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
  return Object.keys(attribution).length ? attribution : null;
}
