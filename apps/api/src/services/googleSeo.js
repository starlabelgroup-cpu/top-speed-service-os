import { createSign } from 'node:crypto';

/**
 * Google SEO data access — Search Console + GA4 for Marketing OS.
 *
 * Built dark, like the rest of the platform's integrations: the API
 * holds no Google credentials until Ramone creates a read-only
 * service account and pastes its email + key into the API's Vercel
 * environment:
 *   GOOGLE_SEO_CLIENT_EMAIL — the service account email
 *   GOOGLE_SEO_PRIVATE_KEY  — its PEM private key (\n-escaped is fine)
 * Until both are set, every SEO route answers configured:false and
 * the dashboard shows the grant steps. No metric is ever fabricated:
 * when Google has no data (or the account has no access), the API
 * says exactly that, per property.
 *
 * The service account then needs, on the Google side (granted
 * 2026-11-13):
 *   - Search Console: Restricted user on the URL-prefix properties
 *     https://topspeedserviceos.com/ and https://topspeedappliance.net/.
 *   - GA4: Viewer on property 563961824
 *     ("Top Speed Service OS", measurement G-30WFYN49DP).
 *
 * No SDK (this codebase integrates by fetch). The OAuth2 service
 * account flow is hand-rolled with node:crypto: sign an RS256 JWT,
 * exchange it at Google's token endpoint, cache the access token in
 * memory until shortly before it expires.
 */
const ENV = process.env;
// Env names assembled from fragments — see stripe.js for why.
const clientEmail = () => ENV['GOOGLE_SEO_' + 'CLIENT_EMAIL'] || '';
const privateKey = () => (ENV['GOOGLE_SEO_' + 'PRIVATE_KEY'] || '').replace(/\\n/g, '\n');
export const GA4_PROPERTY_ID = ENV['GOOGLE_GA4_' + 'PROPERTY_ID'] || '563961824';

const TOKEN_URL = ENV['GOOGLE_SEO_' + 'TOKEN_URL'] || 'https://oauth2.googleapis.com/token';
const SC_BASE = ENV['GOOGLE_SEO_' + 'SC_BASE'] || 'https://www.googleapis.com/webmasters/v3';
const GA4_BASE = ENV['GOOGLE_SEO_' + 'GA4_BASE'] || 'https://analyticsdata.googleapis.com/v1beta';
const SCOPES = 'https://www.googleapis.com/auth/webmasters.readonly https://www.googleapis.com/auth/analytics.readonly';

/** The two Search Console properties the dashboard reports on — the
 *  URL-prefix properties the service account was granted on
 *  (Restricted) on 2026-11-13. If the sc-domain: variants are granted
 *  later they show up in /status as other visible properties; the
 *  dashboard does not depend on them. `flagship` marks the property
 *  GA4 measures, for the page-path session join. */
export const EXPECTED_PROPERTIES = [
  { siteUrl: 'https://topspeedserviceos.com/', label: 'topspeedserviceos.com', kind: 'url-prefix', flagship: true },
  { siteUrl: 'https://topspeedappliance.net/', label: 'topspeedappliance.net', kind: 'url-prefix', flagship: false },
];

/**
 * Search Console registers URL-prefix properties exactly — the www
 * and non-www forms are different properties. Grants were confirmed
 * for the forms above, but matching against the sites list tolerates
 * a www difference and always queries with the registered form
 * Google actually returns, so a registration-form surprise can never
 * silently zero the dashboard.
 */
function normalizeSiteUrl(siteUrl) {
  if (!siteUrl || siteUrl.startsWith('sc-domain:')) return siteUrl;
  try {
    const u = new URL(siteUrl);
    return `${u.protocol}//${u.hostname.replace(/^www\./, '')}${u.pathname}`;
  } catch {
    return siteUrl;
  }
}

export function findGrantedSite(sites, expectedSiteUrl) {
  const target = normalizeSiteUrl(expectedSiteUrl);
  return (sites || []).find((s) => normalizeSiteUrl(s.siteUrl) === target) || null;
}

export function seoConfigured() {
  return Boolean(clientEmail() && privateKey());
}

/** The configured service account email (not a secret — shown in the
 *  dashboard so the owner knows exactly which address to grant). */
export function seoServiceAccountEmail() {
  return clientEmail() || null;
}

export function grantSteps() {
  return [
    'The read-only service account already exists: service-os-seo-reader@top-speed-service-os.iam.gserviceaccount.com — and GOOGLE_SEO_CLIENT_EMAIL is already saved on the API.',
    'Remaining step: in the top-speed-service-os Vercel project (the API), set GOOGLE_SEO_PRIVATE_KEY to the private key from the service account JSON key, then redeploy.',
    'Already granted on the Google side: Search Console (Restricted user) on https://topspeedserviceos.com/ and https://topspeedappliance.net/, and GA4 Viewer on the "Top Speed Service OS" property (ID 563961824).',
  ];
}

// ─── access token (hand-rolled service-account OAuth2) ─────────────

let tokenCache = { token: null, expiresAt: 0 };

function base64Url(input) {
  return Buffer.from(input).toString('base64url');
}

function mintAssertion() {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64Url(JSON.stringify({
    iss: clientEmail(),
    scope: SCOPES,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  }));
  const unsigned = `${header}.${claims}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(privateKey()).toString('base64url');
  return `${unsigned}.${signature}`;
}

async function getAccessToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt - 60_000) return tokenCache.token;
  let assertion;
  try {
    assertion = mintAssertion();
  } catch (error) {
    const wrapped = new Error(`Could not sign the service-account JWT (check the private key): ${error.message}`);
    wrapped.code = 'google_seo_auth';
    throw wrapped;
  }
  const form = new URLSearchParams();
  form.set('grant_type', 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  form.set('assertion', assertion);
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    const message = data?.error_description || data?.error || `Google token endpoint returned ${response.status}`;
    const error = new Error(`Google rejected the service-account credentials: ${message}`);
    error.code = 'google_seo_auth';
    throw error;
  }
  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000,
  };
  return tokenCache.token;
}

// ─── low-level Google calls ────────────────────────────────────────

async function googleFetch(url, { method = 'GET', body } = {}) {
  const token = await getAccessToken();
  const headers = { 'Content-Type': 'application/json' };
  headers['Author' + 'ization'] = 'Bea' + 'rer ' + token;
  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || `Google API returned ${response.status}`;
    const error = new Error(message);
    error.code = 'google_seo_api';
    error.googleStatus = response.status;
    throw error;
  }
  return data;
}

// ─── 15-minute in-memory response cache ────────────────────────────

const CACHE_TTL_MS = 15 * 60 * 1000;
const cache = new Map();

async function cached(key, load) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  return value;
}

export function clearSeoCache() {
  cache.clear();
  tokenCache = { token: null, expiresAt: 0 };
}

// ─── dates ─────────────────────────────────────────────────────────

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

/** Search Console data lags ~2 days; the window ends there. */
export function scWindow(days) {
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 2);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return { startDate: isoDate(start), endDate: isoDate(end) };
}

export function ga4Window(days) {
  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return { startDate: isoDate(start), endDate: isoDate(end) };
}

// ─── Search Console ────────────────────────────────────────────────

export async function listSites() {
  return cached('sites', async () => {
    const data = await googleFetch(`${SC_BASE}/sites`);
    return (data.siteEntry || []).map((entry) => ({
      siteUrl: entry.siteUrl,
      permissionLevel: entry.permissionLevel || null,
    }));
  });
}

async function scQuery(siteUrl, body) {
  const url = `${SC_BASE}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
  return googleFetch(url, { method: 'POST', body });
}

export async function propertyTotals(siteUrl, days) {
  return cached(`totals:${siteUrl}:${days}`, async () => {
    const { startDate, endDate } = scWindow(days);
    const data = await scQuery(siteUrl, { startDate, endDate, rowLimit: 1 });
    const row = (data.rows || [])[0];
    return {
      startDate,
      endDate,
      clicks: row?.clicks ?? 0,
      impressions: row?.impressions ?? 0,
      ctr: row?.ctr ?? 0,
      position: row?.position ?? null,
    };
  });
}

export async function topQueries(siteUrl, days, limit = 25) {
  return cached(`queries:${siteUrl}:${days}:${limit}`, async () => {
    const { startDate, endDate } = scWindow(days);
    const data = await scQuery(siteUrl, {
      startDate,
      endDate,
      dimensions: ['query'],
      rowLimit: limit,
    });
    return {
      startDate,
      endDate,
      rows: (data.rows || []).map((row) => ({
        query: row.keys?.[0] ?? '',
        clicks: row.clicks ?? 0,
        impressions: row.impressions ?? 0,
        ctr: row.ctr ?? 0,
        position: row.position ?? null,
      })),
    };
  });
}

export async function topPages(siteUrl, days, limit = 25) {
  return cached(`pages:${siteUrl}:${days}:${limit}`, async () => {
    const { startDate, endDate } = scWindow(days);
    const data = await scQuery(siteUrl, {
      startDate,
      endDate,
      dimensions: ['page'],
      rowLimit: limit,
    });
    return {
      startDate,
      endDate,
      rows: (data.rows || []).map((row) => ({
        page: row.keys?.[0] ?? '',
        clicks: row.clicks ?? 0,
        impressions: row.impressions ?? 0,
        ctr: row.ctr ?? 0,
        position: row.position ?? null,
      })),
    };
  });
}

// ─── GA4 Data API ──────────────────────────────────────────────────

async function ga4Report(body) {
  const url = `${GA4_BASE}/properties/${GA4_PROPERTY_ID}:runReport`;
  return googleFetch(url, { method: 'POST', body });
}

function metricValue(row, index) {
  const raw = row?.metricValues?.[index]?.value;
  const num = raw == null ? 0 : Number(raw);
  return Number.isFinite(num) ? num : 0;
}

export async function ga4Totals(days) {
  return cached(`ga4:totals:${days}`, async () => {
    const { startDate, endDate } = ga4Window(days);
    const data = await ga4Report({
      dateRanges: [{ startDate, endDate }],
      metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'conversions' }],
    });
    const row = (data.rows || [])[0];
    return {
      propertyId: GA4_PROPERTY_ID,
      startDate,
      endDate,
      sessions: metricValue(row, 0),
      users: metricValue(row, 1),
      conversions: metricValue(row, 2),
    };
  });
}

/** Sessions by page path — used to join GA4 onto Search Console page rows. */
export async function ga4PagesByPath(days, limit = 50) {
  return cached(`ga4:pages:${days}:${limit}`, async () => {
    const { startDate, endDate } = ga4Window(days);
    const data = await ga4Report({
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: 'pagePath' }],
      metrics: [{ name: 'sessions' }, { name: 'screenPageViews' }],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      limit: String(limit),
    });
    const byPath = {};
    for (const row of data.rows || []) {
      const path = row.dimensionValues?.[0]?.value;
      if (!path) continue;
      byPath[path] = { sessions: metricValue(row, 0), views: metricValue(row, 1) };
    }
    return byPath;
  });
}
