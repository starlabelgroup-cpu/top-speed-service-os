import { Router } from 'express';
import { z } from 'zod';
import { store } from '../data/store.js';
import { DATABASE_ENABLED, db } from '../db/client.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { ROLES } from '../config/security.js';
import { PEPPER_VISUAL_API_BASE } from '../services/pepperVisualUrl.js';
import { findClaimViolations } from '../services/claimCheck.js';
import {
  ensureAdvertiserTracking,
  ensureCampaignLink,
  findLinkByCode,
  findProfileBySlugFresh,
  findProfileByUserId,
  linksForUser,
  persistAdvertiserProfile,
  recordClickOut,
  recordLinkClick,
  refreshAdvertiserLinks,
} from '../db/advertiserLinksRepo.js';

/**
 * Advertiser tracked links + public advertiser pages (2026-11-24).
 *
 * Ramone's directive: "For advertisers create links and tracking for
 * every ad account made by advertisers. When customers click ad link
 * it goes to advertiser's page with tracking and advertiser details
 * and links."
 *
 * This router EXTENDS the existing ads-os click machinery (routes/
 * adLibrary.js) — it is not a parallel tracker. The library's house
 * creatives keep their own /ads-os/slot/click/:key door; advertiser
 * accounts get theirs here:
 *
 *   GET  /ads-os/go/:code           the tracked link itself: the
 *                                   click is recorded (event row +
 *                                   the link's aggregate counter),
 *                                   then a 302 to the advertiser's
 *                                   page ON the platform, UTM-tagged
 *                                   — never straight off-platform.
 *   GET  /ads-os/advertiser/:slug   the public page's data: the
 *                                   advertiser's real profile fields
 *                                   (missing ones omitted, never
 *                                   invented), their ACTIVE campaigns
 *                                   with tracked click URLs, and the
 *                                   counted onward doors.
 *   GET  /ads-os/out/:slug          the counted onward door to the
 *                                   advertiser's own website.
 *   POST /ads-os/out/:slug          beacon door counting a call
 *                                   click-out ({ to: 'call' } → 204).
 *
 * Advertiser Console doors (Advertiser Console → My Page & Links),
 * gated exactly like the console's other self-serve routes in
 * routes/adStudio.js — an advertiser sees ONLY their own links:
 *   GET   /ad-studio/my-links       my tracked links + real counts
 *   GET   /ad-studio/my-profile     my public profile (editable form)
 *   PATCH /ad-studio/my-profile     save the details my page shows
 *
 * Link generation lives in db/advertiserLinksRepo.js: backfilled for
 * every existing advertiser at hydration, ensured at campaign
 * creation (routes/adStudio.js) and on every console read here.
 *
 * Honesty rules: an unknown code or slug answers a real 404 and
 * records nothing; a link with zero clicks shows 0; the public
 * payload carries only fields the advertiser actually provided.
 */

const router = Router();
const API = PEPPER_VISUAL_API_BASE;
const WEB = process.env.PUBLIC_WEB_BASE || 'https://topspeedserviceos.com';
const advertiserOnly = [authenticate, requireRole(ROLES.ADVERTISER)];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function actorIdOf(req) {
  const id = req.user?.id;
  return id && UUID_RE.test(id) ? id : null;
}

function goUrl(code) {
  return `${API}/ads-os/go/${code}`;
}

function pageUrl(slug) {
  return `${WEB}/advertiser/${slug}`;
}

function notFoundPage(res, what) {
  res.status(404).set('Content-Type', 'text/html; charset=utf-8');
  return res.send(
    '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + `<title>${what} not found — Top Speed Service OS</title></head>`
    + '<body style="font-family:Arial,sans-serif;background:#060d1d;color:#eef3fa;margin:0;padding:48px 20px;text-align:center">'
    + `<h1 style="font-size:22px">${what} not found</h1>`
    + '<p style="color:#b9c6da">This link does not match any advertiser on the Top Speed platform.</p>'
    + '<p><a href="https://topspeedserviceos.com/" style="color:#ff5a52;font-weight:700">Go to Top Speed Service OS</a></p>'
    + '</body></html>',
  );
}

async function loadActorUser(req) {
  const id = actorIdOf(req);
  if (!id) return null;
  if (DATABASE_ENABLED) {
    try {
      return await db().user.findUnique({ where: { id } });
    } catch {
      return null;
    }
  }
  return store.users.get(id) || null;
}

/** Strict console refresh — the snapshot-fix discipline: a failed
 *  table read answers an honest 503, never a stale list. */
async function freshLinks(res) {
  try {
    await refreshAdvertiserLinks();
    return true;
  } catch (error) {
    console.error('advertiser links refresh failed', error?.message || error);
    res.status(503).json({
      error: 'Your tracked links could not be read from the database — no list is shown rather than a stale one',
      code: 'ADVERTISER_LINKS_REFRESH_FAILED',
    });
    return false;
  }
}

// ─── Public: the tracked link ─────────────────────────────────────

router.get('/ads-os/go/:code', async (req, res) => {
  const link = await findLinkByCode(String(req.params.code || ''));
  if (!link || !link.active) return notFoundPage(res, 'Advertiser link');
  const profile = findProfileByUserId(link.advertiserUserId) || null;
  if (!profile || !profile.isPublic) return notFoundPage(res, 'Advertiser page');
  const surface = String(req.query.surface || req.query.slot || req.query.platform || '').slice(0, 60);
  await recordLinkClick(link, { surface: surface || null });
  const campaign = link.campaignId ? store.adCampaigns.find((c) => c.id === link.campaignId) : null;
  const target = new URL(pageUrl(profile.slug));
  target.searchParams.set('utm_source', surface || 'advertiser-link');
  target.searchParams.set('utm_medium', 'advertiser-link');
  target.searchParams.set('utm_campaign', campaign ? campaign.sourceTag : 'advertiser-page');
  target.searchParams.set('ts_link', link.code);
  res.set('Cache-Control', 'no-store');
  return res.redirect(302, target.toString());
});

// ─── Public: the advertiser page's data ───────────────────────────

async function isNetworkMember(profile) {
  // Network membership lives on Provider records, which carry no
  // user id — the only join the schema supports is same company +
  // same business name. Stated exactly as it is; a false negative
  // only costs the advertiser a booking shortcut on their page.
  if (!profile.businessName) return false;
  const wanted = profile.businessName.trim().toLowerCase();
  if (!wanted) return false;
  let companyId = null;
  let providers = [];
  if (DATABASE_ENABLED) {
    try {
      const user = await db().user.findUnique({ where: { id: profile.userId }, select: { companyId: true } });
      companyId = user?.companyId || null;
      if (!companyId) return false;
      providers = await db().provider.findMany({ where: { companyId, active: true }, select: { businessName: true } });
    } catch {
      return false;
    }
  } else {
    const user = store.users.get(profile.userId);
    companyId = user?.companyId || null;
    if (!companyId) return false;
    providers = (store.providers || []).filter((p) => p.companyId === companyId && p.active !== false);
  }
  return providers.some((p) => String(p.businessName || '').trim().toLowerCase() === wanted);
}

function publicProfile(profile, { campaigns, networkMember, logoUrl }) {
  const data = { slug: profile.slug, businessName: profile.businessName || null };
  if (profile.about) data.about = profile.about;
  if (Array.isArray(profile.services) && profile.services.length) data.services = profile.services;
  if (profile.serviceArea) data.serviceArea = profile.serviceArea;
  if (profile.phone) {
    data.phone = profile.phone;
    data.callBeaconUrl = `${API}/ads-os/out/${profile.slug}`;
  }
  if (profile.websiteUrl) {
    data.websiteUrl = profile.websiteUrl;
    try {
      data.websiteHost = new URL(profile.websiteUrl).hostname;
    } catch {
      data.websiteHost = null;
    }
    data.websiteClickUrl = `${API}/ads-os/out/${profile.slug}?to=website`;
  }
  const links = (Array.isArray(profile.links) ? profile.links : [])
    .filter((l) => l && l.label && l.url && /^https?:\/\//i.test(l.url))
    .map((l) => ({ label: l.label, url: l.url }));
  if (links.length) data.links = links;
  if (logoUrl) data.logoUrl = logoUrl;
  data.networkMember = networkMember;
  data.campaigns = campaigns;
  return data;
}

router.get('/ads-os/advertiser/:slug', async (req, res) => {
  const profile = await findProfileBySlugFresh(String(req.params.slug || ''));
  if (!profile || !profile.isPublic) {
    return res.status(404).json({ error: 'Advertiser not found', code: 'ADVERTISER_NOT_FOUND' });
  }
  const active = store.adCampaigns.filter(
    (c) => c.createdById === profile.userId && c.businessLine === 'EXTERNAL' && c.status === 'ACTIVE',
  );
  const campaigns = [];
  for (const campaign of active) {
    const link = await ensureCampaignLink(campaign);
    const view = {
      id: campaign.id,
      name: campaign.name,
      offering: campaign.offering || null,
      headline: campaign.headline || null,
      copy: campaign.copy || null,
      ctaText: campaign.ctaText || 'Learn More',
      category: campaign.category || null,
      imageUrl: campaign.imageUrl || null,
      clickUrl: link ? goUrl(link.code) : null,
    };
    campaigns.push(view);
  }
  // The logo is public only while the uploaded creative rides an
  // ACTIVE campaign — the same rule the creative image door enforces.
  const logoUrl = profile.logoCreativeId
    && active.some((c) => c.creativeUploadId === profile.logoCreativeId)
    ? `${API}/ad-studio/creatives/${profile.logoCreativeId}/image`
    : null;
  const networkMember = await isNetworkMember(profile);
  res.set('Cache-Control', 'no-store');
  return res.json({ data: publicProfile(profile, { campaigns, networkMember, logoUrl }) });
});

// ─── Public: counted onward doors ─────────────────────────────────

router.get('/ads-os/out/:slug', async (req, res) => {
  const profile = await findProfileBySlugFresh(String(req.params.slug || ''));
  if (!profile || !profile.isPublic) return notFoundPage(res, 'Advertiser page');
  const to = String(req.query.to || 'website');
  if (to === 'website' && profile.websiteUrl && /^https?:\/\//i.test(profile.websiteUrl)) {
    await recordClickOut(profile, 'website');
    return res.redirect(302, profile.websiteUrl);
  }
  return res.redirect(302, pageUrl(profile.slug));
});

router.post('/ads-os/out/:slug', async (req, res) => {
  const profile = await findProfileBySlugFresh(String(req.params.slug || ''));
  if (!profile || !profile.isPublic) {
    return res.status(404).json({ error: 'Advertiser not found', code: 'ADVERTISER_NOT_FOUND' });
  }
  const to = String(req.body?.to || req.query.to || '');
  if (to !== 'call') {
    return res.status(400).json({ error: 'Only call click-outs are counted through the beacon door', code: 'ADVERTISER_OUT_BAD_TARGET' });
  }
  await recordClickOut(profile, 'call');
  return res.status(204).end();
});

// ─── Advertiser Console: my links + my profile ────────────────────

function linkView(link) {
  const campaign = link.campaignId ? store.adCampaigns.find((c) => c.id === link.campaignId) : null;
  return {
    id: link.id,
    code: link.code,
    url: goUrl(link.code),
    kind: link.kind,
    label: link.label,
    campaignId: link.campaignId || null,
    campaignName: campaign ? campaign.name : null,
    campaignStatus: campaign ? campaign.status : null,
    clicks: link.clicks || 0,
    clickOuts: link.clickOuts || 0,
    active: link.active !== false,
    createdAt: link.createdAt || null,
  };
}

function profileView(profile) {
  return {
    slug: profile.slug,
    pageUrl: pageUrl(profile.slug),
    businessName: profile.businessName || '',
    about: profile.about || '',
    services: profile.services || [],
    serviceArea: profile.serviceArea || '',
    phone: profile.phone || '',
    websiteUrl: profile.websiteUrl || '',
    links: Array.isArray(profile.links) ? profile.links : [],
    logoCreativeId: profile.logoCreativeId || null,
    isPublic: profile.isPublic !== false,
  };
}

async function actorProfile(req, res) {
  if (!(await freshLinks(res))) return null;
  const user = await loadActorUser(req);
  if (!user) {
    res.status(404).json({ error: 'Advertiser account not found', code: 'ADVERTISER_ACCOUNT_NOT_FOUND' });
    return null;
  }
  const profile = await ensureAdvertiserTracking(user);
  if (!profile) {
    res.status(404).json({ error: 'Advertiser profile could not be prepared', code: 'ADVERTISER_PROFILE_MISSING' });
    return null;
  }
  return { user, profile };
}

router.get('/ad-studio/my-links', ...advertiserOnly, async (req, res) => {
  const ctx = await actorProfile(req, res);
  if (!ctx) return undefined;
  const links = linksForUser(ctx.user.id)
    .map(linkView)
    .sort((a, b) => (a.kind === b.kind ? String(a.createdAt).localeCompare(String(b.createdAt)) : a.kind === 'MASTER' ? -1 : 1));
  const totals = links.reduce(
    (acc, l) => ({ clicks: acc.clicks + l.clicks, clickOuts: acc.clickOuts + l.clickOuts }),
    { clicks: 0, clickOuts: 0 },
  );
  return res.json({
    data: {
      profile: { slug: ctx.profile.slug, businessName: ctx.profile.businessName || null, pageUrl: pageUrl(ctx.profile.slug) },
      links,
      totals: { ...totals, linkCount: links.length },
    },
  });
});

router.get('/ad-studio/my-profile', ...advertiserOnly, async (req, res) => {
  const ctx = await actorProfile(req, res);
  if (!ctx) return undefined;
  return res.json({ data: profileView(ctx.profile) });
});

const profilePatchSchema = z.object({
  businessName: z.string().trim().min(2).max(120).optional(),
  about: z.string().trim().max(1000).nullable().optional(),
  services: z.array(z.string().trim().min(1).max(80)).max(12).optional(),
  serviceArea: z.string().trim().max(160).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  websiteUrl: z.string().trim().max(500).nullable().optional(),
  links: z.array(z.object({
    label: z.string().trim().min(1).max(60),
    url: z.string().trim().min(4).max(500),
  })).max(8).optional(),
  // One of the advertiser's OWN uploaded creatives (AdvertiserCreative
  // id) shown as the page logo while it rides an ACTIVE campaign.
  logoCreativeId: z.string().uuid().nullable().optional(),
});

router.patch('/ad-studio/my-profile', ...advertiserOnly, async (req, res) => {
  const parsed = profilePatchSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid profile', details: parsed.error.flatten(), code: 'ADVERTISER_PROFILE_INVALID' });
  }
  const data = parsed.data;
  // The same claim gate every hand-written ad copy passes: a public
  // advertiser page can carry no invented ratings, discounts or
  // superlatives the platform has not approved.
  const violations = findClaimViolations([
    ['businessName', data.businessName],
    ['about', data.about],
    ['serviceArea', data.serviceArea],
    ...(data.services || []).map((s) => ['services', s]),
    ...(data.links || []).map((l) => ['links', l.label]),
  ]);
  if (violations.length) {
    return res.status(400).json({
      error: 'Profile failed the claim check — fix the flagged claims and try again',
      code: 'CLAIM_CHECK_FAILED',
      violations,
    });
  }
  if (data.websiteUrl && !/^https?:\/\//i.test(data.websiteUrl)) {
    return res.status(400).json({ error: 'Website must start with http:// or https://', code: 'ADVERTISER_PROFILE_BAD_WEBSITE' });
  }
  for (const link of data.links || []) {
    if (!/^https?:\/\//i.test(link.url)) {
      return res.status(400).json({ error: 'Every link must start with http:// or https://', code: 'ADVERTISER_PROFILE_BAD_LINK' });
    }
  }
  if (data.logoCreativeId) {
    const ownerId = actorIdOf(req);
    const own = store.advertiserCreatives.find((c) => c.id === data.logoCreativeId && c.ownerId === ownerId);
    if (!own) return res.status(400).json({ error: 'That logo image is not in your library', code: 'ADVERTISER_PROFILE_BAD_LOGO' });
  }
  const ctx = await actorProfile(req, res);
  if (!ctx) return undefined;
  const { profile } = ctx;
  for (const field of ['businessName', 'about', 'serviceArea', 'phone', 'websiteUrl']) {
    if (field in data) profile[field] = data[field] || null;
  }
  if ('logoCreativeId' in data) profile.logoCreativeId = data.logoCreativeId || null;
  if ('services' in data) profile.services = data.services || [];
  if ('links' in data) profile.links = data.links || [];
  profile.updatedAt = new Date().toISOString();
  await persistAdvertiserProfile(profile);
  return res.json({ data: profileView(profile) });
});

export default router;
