import { Router } from 'express';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { ROLES } from '../config/security.js';
import {
  EXPECTED_PROPERTIES,
  GA4_PROPERTY_ID,
  findGrantedSite,
  ga4PagesByPath,
  ga4Totals,
  grantSteps,
  listSites,
  propertyTotals,
  seoConfigured,
  seoServiceAccountEmail,
  topPages,
  topQueries,
} from '../services/googleSeo.js';

/**
 * Marketing OS — SEO dashboard API (Search Console + GA4).
 *
 * Staff-gated with the same roles as the rest of Marketing OS admin.
 * Built dark: until Ramone's read-only Google service account is
 * configured on the API (GOOGLE_SEO_CLIENT_EMAIL /
 * GOOGLE_SEO_PRIVATE_KEY) and granted on the Google side, /status
 * answers configured:false with the grant steps, and the data routes
 * answer the same honest state — never an invented number.
 *
 * When configured, a property the service account cannot see is
 * reported per property as access:false with the reason, not as an
 * error page: the fix (a Google-side grant) belongs to that property.
 */
const router = Router();
const marketingOnly = [
  authenticate,
  requireCompany,
  requireRole(ROLES.MARKETING_MANAGER, ROLES.COMPANY_ADMIN, ROLES.COMPANY_OWNER, ROLES.PLATFORM_ADMIN),
];

function parseDays(req) {
  const days = Number(req.query.days || 28);
  if (!Number.isFinite(days)) return 28;
  return Math.min(180, Math.max(1, Math.trunc(days)));
}

function notConfigured(res) {
  return res.json({
    data: {
      configured: false,
      serviceAccountEmail: seoServiceAccountEmail(),
      ga4PropertyId: GA4_PROPERTY_ID,
      grantSteps: grantSteps(),
    },
  });
}

/** Resolve the caller's property param against what Google grants. */
async function resolveProperty(req) {
  const requested = String(req.query.property || '').trim();
  if (!requested) return { error: 'property query parameter is required' };
  const sites = await listSites();
  const granted = findGrantedSite(sites, requested);
  const expected = EXPECTED_PROPERTIES.find((p) => p.siteUrl === requested)
    || EXPECTED_PROPERTIES.find((p) => granted && p.siteUrl === granted.siteUrl);
  if (!granted) {
    return {
      state: {
        property: requested,
        label: expected?.label || requested,
        access: false,
        reason: 'The SEO service account does not have access to this property yet — add its email as a user on the property in Search Console.',
      },
    };
  }
  return { siteUrl: granted.siteUrl, label: expected?.label || granted.siteUrl };
}

router.get('/marketing-os/seo/status', ...marketingOnly, async (req, res) => {
  if (!seoConfigured()) return notConfigured(res);
  const base = {
    configured: true,
    serviceAccountEmail: seoServiceAccountEmail(),
    ga4PropertyId: GA4_PROPERTY_ID,
  };
  try {
    const sites = await listSites();
    base.properties = EXPECTED_PROPERTIES.map((expected) => {
      const granted = findGrantedSite(sites, expected.siteUrl);
      return {
        ...expected,
        siteUrl: granted?.siteUrl || expected.siteUrl,
        granted: Boolean(granted),
        permissionLevel: granted?.permissionLevel || null,
      };
    });
    base.otherVisibleProperties = sites
      .filter((s) => !EXPECTED_PROPERTIES.some((e) => findGrantedSite([s], e.siteUrl)))
      .map((s) => s.siteUrl);
    return res.json({ data: base });
  } catch (error) {
    base.properties = EXPECTED_PROPERTIES.map((expected) => ({ ...expected, granted: false, permissionLevel: null }));
    base.accessError = error.message;
    return res.json({ data: base });
  }
});

router.get('/marketing-os/seo/overview', ...marketingOnly, async (req, res) => {
  if (!seoConfigured()) return notConfigured(res);
  const days = parseDays(req);
  let sites;
  try {
    sites = await listSites();
  } catch (error) {
    return res.json({
      data: {
        configured: true,
        days,
        accessError: error.message,
        properties: EXPECTED_PROPERTIES.map((expected) => ({
          ...expected,
          access: false,
          reason: error.message,
        })),
        ga4: { propertyId: GA4_PROPERTY_ID, access: false, reason: error.message },
      },
    });
  }

  const properties = await Promise.all(EXPECTED_PROPERTIES.map(async (expected) => {
    const granted = findGrantedSite(sites, expected.siteUrl);
    if (!granted) {
      return {
        ...expected,
        access: false,
        reason: 'The SEO service account has not been added to this property in Search Console yet.',
      };
    }
    try {
      const totals = await propertyTotals(granted.siteUrl, days);
      return { ...expected, siteUrl: granted.siteUrl, access: true, ...totals };
    } catch (error) {
      return { ...expected, access: false, reason: error.message };
    }
  }));

  let ga4;
  try {
    const totals = await ga4Totals(days);
    ga4 = { access: true, ...totals };
  } catch (error) {
    ga4 = { propertyId: GA4_PROPERTY_ID, access: false, reason: error.message };
  }

  return res.json({ data: { configured: true, days, properties, ga4 } });
});

router.get('/marketing-os/seo/queries', ...marketingOnly, async (req, res) => {
  if (!seoConfigured()) return notConfigured(res);
  const days = parseDays(req);
  try {
    const resolved = await resolveProperty(req);
    if (resolved.error) return res.status(400).json({ error: resolved.error });
    if (resolved.state) return res.json({ data: { configured: true, days, ...resolved.state, rows: [] } });
    const result = await topQueries(resolved.siteUrl, days);
    return res.json({
      data: {
        configured: true,
        days,
        property: resolved.siteUrl,
        label: resolved.label,
        access: true,
        ...result,
      },
    });
  } catch (error) {
    return res.json({
      data: {
        configured: true,
        days,
        property: String(req.query.property || ''),
        access: false,
        reason: error.message,
        rows: [],
      },
    });
  }
});

router.get('/marketing-os/seo/pages', ...marketingOnly, async (req, res) => {
  if (!seoConfigured()) return notConfigured(res);
  const days = parseDays(req);
  try {
    const resolved = await resolveProperty(req);
    if (resolved.error) return res.status(400).json({ error: resolved.error });
    if (resolved.state) return res.json({ data: { configured: true, days, ...resolved.state, rows: [] } });
    const result = await topPages(resolved.siteUrl, days);
    // GA4 measures the flagship site (topspeedserviceos.com) only, so
    // sessions join onto page paths for that property alone.
    const expected = EXPECTED_PROPERTIES.find((p) => p.siteUrl === resolved.siteUrl);
    let rows = result.rows;
    if (expected?.flagship) {
      try {
        const byPath = await ga4PagesByPath(days);
        rows = rows.map((row) => {
          let path = row.page;
          try { path = new URL(row.page).pathname; } catch { /* keep raw */ }
          const ga4 = byPath[path] || byPath[`${path.replace(/\/$/, '')}/`];
          return { ...row, ga4Sessions: ga4?.sessions ?? null, ga4Views: ga4?.views ?? null };
        });
      } catch {
        rows = rows.map((row) => ({ ...row, ga4Sessions: null, ga4Views: null }));
      }
    }
    return res.json({
      data: {
        configured: true,
        days,
        property: resolved.siteUrl,
        label: resolved.label,
        access: true,
        startDate: result.startDate,
        endDate: result.endDate,
        rows,
      },
    });
  } catch (error) {
    return res.json({
      data: {
        configured: true,
        days,
        property: String(req.query.property || ''),
        access: false,
        reason: error.message,
        rows: [],
      },
    });
  }
});

export default router;
