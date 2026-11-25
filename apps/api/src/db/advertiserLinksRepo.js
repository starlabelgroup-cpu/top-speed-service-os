import { randomBytes } from 'node:crypto';
import { createId, store } from '../data/store.js';
import { DATABASE_ENABLED, db } from './client.js';
import { slugify } from '../data/marketingTaxonomy.js';

/**
 * Advertiser tracked links + public advertiser pages (2026-11-24) —
 * Ramone's directive: "For advertisers create links and tracking for
 * every ad account made by advertisers. When customers click ad link
 * it goes to advertiser's page with tracking and advertiser details
 * and links."
 *
 * Same discipline as the Ads Library repo (db/adCreativesRepo.js):
 * the Prisma tables are the durable record, the in-memory store is
 * the working set, mutations write through with an upsert, counters
 * move in memory immediately and take an atomic increment in the
 * table, and hydrateAdvertiserLinks() loads everything at cold start
 * (it rides the Ad Studio hydration in db/adStudioRepo.js).
 *
 * Backfill: hydration also ENSURES every current advertiser account
 * (an ADVERTISER-role User) has its profile, its MASTER tracked link
 * and one tracked link per campaign it owns — idempotent upserts, so
 * a cold start can never duplicate a link or reset a counter. The
 * profile is derived ONLY from the advertiser's own real records
 * (their newest campaign's advertiserName, their account phone,
 * their campaign destination when it points off-platform); fields
 * nobody provided stay null and the public page omits them.
 *
 * A click is a row (AdvertiserLinkClick) AND an aggregate increment —
 * the counters the console reads can never drift from the event
 * record. No visitor identity is stored: counts, surface, time only.
 */

function iso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function toStoreProfile(row) {
  return {
    id: row.id,
    userId: row.userId,
    slug: row.slug,
    businessName: row.businessName || null,
    about: row.about || null,
    services: row.services || [],
    serviceArea: row.serviceArea || null,
    phone: row.phone || null,
    websiteUrl: row.websiteUrl || null,
    links: Array.isArray(row.links) ? row.links : [],
    logoCreativeId: row.logoCreativeId || null,
    isPublic: row.isPublic !== false,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function toProfileRow(record) {
  return {
    id: record.id,
    userId: record.userId,
    slug: record.slug,
    businessName: record.businessName || null,
    about: record.about || null,
    services: record.services || [],
    serviceArea: record.serviceArea || null,
    phone: record.phone || null,
    websiteUrl: record.websiteUrl || null,
    links: Array.isArray(record.links) ? record.links : [],
    logoCreativeId: record.logoCreativeId || null,
    isPublic: record.isPublic !== false,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt || record.createdAt),
  };
}

function toStoreLink(row) {
  return {
    id: row.id,
    code: row.code,
    advertiserUserId: row.advertiserUserId,
    kind: row.kind,
    campaignId: row.campaignId || null,
    label: row.label,
    clicks: row.clicks || 0,
    clickOuts: row.clickOuts || 0,
    active: row.active !== false,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function toLinkRow(record) {
  return {
    id: record.id,
    code: record.code,
    advertiserUserId: record.advertiserUserId,
    kind: record.kind,
    campaignId: record.campaignId || null,
    label: record.label,
    clicks: record.clicks || 0,
    clickOuts: record.clickOuts || 0,
    active: record.active !== false,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt || record.createdAt),
  };
}

function toClickRow(event) {
  return {
    id: event.id,
    linkId: event.linkId,
    advertiserUserId: event.advertiserUserId,
    direction: event.direction || 'IN',
    target: event.target || null,
    surface: event.surface || null,
    createdAt: new Date(event.createdAt),
  };
}

// ─── Codes + slugs ────────────────────────────────────────────────

// Unguessable-enough short codes: 10 chars from an unambiguous
// alphabet (no 0/O/1/l/I) drawn from crypto randomness — ~57 bits,
// and a code only ever reveals a public advertiser page, never
// anything private.
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateLinkCode() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const bytes = randomBytes(10);
    let code = '';
    for (let i = 0; i < 10; i += 1) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    if (!store.advertiserLinks.some((l) => l.code === code)) return code;
  }
  return `${generateLinkCode()}${CODE_ALPHABET[randomBytes(1)[0] % CODE_ALPHABET.length]}`;
}

function uniqueSlug(base) {
  const root = slugify(base || '') || 'advertiser';
  if (!store.advertiserProfiles.some((p) => p.slug === root)) return root;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${root}-${n}`;
    if (!store.advertiserProfiles.some((p) => p.slug === candidate)) return candidate;
  }
  return `${root}-${createId().slice(0, 8)}`;
}

// ─── Derivation (real records only) ───────────────────────────────

function ownCampaigns(userId) {
  return store.adCampaigns
    .filter((c) => c.createdById === userId && c.businessLine === 'EXTERNAL')
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function isOffPlatformUrl(value) {
  if (!value || !/^https?:\/\//i.test(value)) return false;
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host !== 'topspeedserviceos.com' && !host.endsWith('.topspeedserviceos.com');
  } catch {
    return false;
  }
}

function deriveProfileFields(user) {
  const mine = ownCampaigns(user.id);
  const newest = mine[0];
  const personName = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  const businessName = (newest && newest.advertiserName) || personName || null;
  let websiteUrl = null;
  for (const campaign of mine) {
    if (isOffPlatformUrl(campaign.destinationUrl)) {
      websiteUrl = campaign.destinationUrl;
      break;
    }
  }
  return { businessName, websiteUrl, phone: user.phone || null };
}

// ─── Persistence (write-through upserts) ──────────────────────────

export async function persistAdvertiserProfile(record) {
  if (!DATABASE_ENABLED || !record?.id) return;
  try {
    const row = toProfileRow(record);
    await db().advertiserProfile.upsert({ where: { id: row.id }, update: row, create: row });
  } catch (error) {
    console.error('persistAdvertiserProfile failed', error?.message || error);
  }
}

export async function persistAdvertiserLink(record) {
  if (!DATABASE_ENABLED || !record?.id) return;
  try {
    const row = toLinkRow(record);
    await db().advertiserLink.upsert({ where: { id: row.id }, update: row, create: row });
  } catch (error) {
    console.error('persistAdvertiserLink failed', error?.message || error);
  }
}

// ─── Ensure: profile + links exist for an account ─────────────────

export async function ensureAdvertiserProfile(user) {
  if (!user?.id) return null;
  const existing = store.advertiserProfiles.find((p) => p.userId === user.id);
  if (existing) return existing;
  const derived = deriveProfileFields(user);
  const now = new Date().toISOString();
  const profile = {
    id: createId(),
    userId: user.id,
    slug: uniqueSlug(derived.businessName || (user.email ? user.email.split('@')[0] : '') || 'advertiser'),
    businessName: derived.businessName,
    about: null,
    services: [],
    serviceArea: null,
    phone: derived.phone,
    websiteUrl: derived.websiteUrl,
    links: [],
    logoCreativeId: null,
    isPublic: true,
    createdAt: now,
    updatedAt: now,
  };
  store.advertiserProfiles.push(profile);
  await persistAdvertiserProfile(profile);
  return profile;
}

export async function ensureMasterLink(userId) {
  if (!userId) return null;
  const existing = store.advertiserLinks.find((l) => l.advertiserUserId === userId && l.kind === 'MASTER');
  if (existing) return existing;
  const now = new Date().toISOString();
  const link = {
    id: createId(),
    code: generateLinkCode(),
    advertiserUserId: userId,
    kind: 'MASTER',
    campaignId: null,
    label: 'Main tracked link',
    clicks: 0,
    clickOuts: 0,
    active: true,
    createdAt: now,
    updatedAt: now,
  };
  store.advertiserLinks.push(link);
  await persistAdvertiserLink(link);
  return link;
}

export async function ensureCampaignLink(campaign) {
  if (!campaign?.id || !campaign.createdById || campaign.businessLine !== 'EXTERNAL') return null;
  const existing = store.advertiserLinks.find((l) => l.kind === 'CAMPAIGN' && l.campaignId === campaign.id);
  if (existing) return existing;
  const now = new Date().toISOString();
  const link = {
    id: createId(),
    code: generateLinkCode(),
    advertiserUserId: campaign.createdById,
    kind: 'CAMPAIGN',
    campaignId: campaign.id,
    label: campaign.name || 'Campaign',
    clicks: 0,
    clickOuts: 0,
    active: true,
    createdAt: now,
    updatedAt: now,
  };
  store.advertiserLinks.push(link);
  await persistAdvertiserLink(link);
  return link;
}

/** Profile + master link + one link per live campaign, for one account. */
export async function ensureAdvertiserTracking(user) {
  if (!user?.id) return null;
  const profile = await ensureAdvertiserProfile(user);
  await ensureMasterLink(user.id);
  for (const campaign of ownCampaigns(user.id)) {
    if (campaign.status !== 'ENDED') await ensureCampaignLink(campaign);
  }
  return profile;
}

// ─── Lookups (store first, table fallback) ────────────────────────

export function findProfileByUserId(userId) {
  return store.advertiserProfiles.find((p) => p.userId === userId) || null;
}

export function findProfileBySlug(slug) {
  return store.advertiserProfiles.find((p) => p.slug === slug) || null;
}

export function linksForUser(userId) {
  return store.advertiserLinks.filter((l) => l.advertiserUserId === userId);
}

export async function findLinkByCode(code) {
  const inStore = store.advertiserLinks.find((l) => l.code === code);
  if (inStore) return inStore;
  if (!DATABASE_ENABLED) return null;
  try {
    const row = await db().advertiserLink.findUnique({ where: { code } });
    if (!row) return null;
    const link = toStoreLink(row);
    store.advertiserLinks.push(link);
    return link;
  } catch (error) {
    console.error('findLinkByCode failed', error?.message || error);
    return null;
  }
}

export async function findProfileBySlugFresh(slug) {
  const inStore = findProfileBySlug(slug);
  if (inStore) return inStore;
  if (!DATABASE_ENABLED) return null;
  try {
    const row = await db().advertiserProfile.findUnique({ where: { slug } });
    if (!row) return null;
    const profile = toStoreProfile(row);
    store.advertiserProfiles.push(profile);
    return profile;
  } catch (error) {
    console.error('findProfileBySlugFresh failed', error?.message || error);
    return null;
  }
}

// ─── Click recording ──────────────────────────────────────────────

async function writeClickEvent(event) {
  store.advertiserLinkClicks.push(event);
  if (!DATABASE_ENABLED) return;
  try {
    await db().advertiserLinkClick.create({ data: toClickRow(event) });
  } catch (error) {
    console.error('advertiser link click event failed', error?.message || error);
  }
}

async function bumpLinkCounter(link, field) {
  link[field] = (link[field] || 0) + 1;
  link.updatedAt = new Date().toISOString();
  if (!DATABASE_ENABLED) return;
  try {
    await db().advertiserLink.update({ where: { id: link.id }, data: { [field]: { increment: 1 } } });
  } catch (error) {
    console.error('advertiser link counter failed', error?.message || error);
  }
}

/** An inbound click on a tracked link: event row + aggregate increment. */
export async function recordLinkClick(link, { surface = null } = {}) {
  if (!link) return;
  await bumpLinkCounter(link, 'clicks');
  await writeClickEvent({
    id: createId(),
    linkId: link.id,
    advertiserUserId: link.advertiserUserId,
    direction: 'IN',
    target: null,
    surface: surface ? String(surface).slice(0, 60) : null,
    createdAt: new Date().toISOString(),
  });
}

/**
 * An onward click from the advertiser's page (their website, their
 * phone number): counted against the account's MASTER link, with the
 * target recorded. Creates the master link first if the account
 * somehow has none.
 */
export async function recordClickOut(profile, target) {
  if (!profile) return;
  const master = await ensureMasterLink(profile.userId);
  if (!master) return;
  await bumpLinkCounter(master, 'clickOuts');
  await writeClickEvent({
    id: createId(),
    linkId: master.id,
    advertiserUserId: profile.userId,
    direction: 'OUT',
    target: String(target || 'website').slice(0, 40),
    surface: null,
    createdAt: new Date().toISOString(),
  });
}

/**
 * The display-feed click path (routes/adStudio.js) calls this for
 * EXTERNAL campaigns: the click lands on the campaign's own tracked
 * link, so console link counts and banner counts tell one story.
 * Returns the link (the caller redirects to the advertiser's page).
 */
export async function recordCampaignLinkClick(campaign, { surface = null } = {}) {
  const link = await ensureCampaignLink(campaign);
  if (!link) return null;
  await recordLinkClick(link, { surface });
  return link;
}

// ─── Hydration + backfill ─────────────────────────────────────────

async function advertiserUsers() {
  if (DATABASE_ENABLED) {
    try {
      return await db().user.findMany({ where: { roles: { has: 'ADVERTISER' } } });
    } catch (error) {
      console.error('advertiserLinks advertiser scan failed', error?.message || error);
      return [];
    }
  }
  return [...store.users.values()].filter((u) => (u.roles || []).includes('ADVERTISER'));
}

export async function hydrateAdvertiserLinks() {
  if (!DATABASE_ENABLED) {
    try {
      for (const user of await advertiserUsers()) await ensureAdvertiserTracking(user);
    } catch (error) {
      console.error('hydrateAdvertiserLinks degraded', error?.message || error);
    }
    return store.advertiserLinks.length;
  }
  try {
    const [profiles, links] = await Promise.all([
      db().advertiserProfile.findMany({ orderBy: [{ createdAt: 'asc' }] }),
      db().advertiserLink.findMany({ orderBy: [{ createdAt: 'asc' }] }),
    ]);
    store.advertiserProfiles = profiles.map(toStoreProfile);
    store.advertiserLinks = links.map(toStoreLink);
    // Backfill: every advertiser account that exists today gets its
    // profile + tracked links, generated from its own real records.
    for (const user of await advertiserUsers()) await ensureAdvertiserTracking(user);
    return store.advertiserLinks.length;
  } catch (error) {
    // Missing tables mid-deploy degrade to empty lists, exactly like
    // the Ad Studio hydration — go-links answer an honest 404 and
    // the platform never blocks on this feature.
    console.error('hydrateAdvertiserLinks degraded', error?.message || error);
    return store.advertiserLinks.length;
  }
}

/**
 * Console-read refresh — the strict twin of refreshAdCampaigns (the
 * 2026-11-24 snapshot fix): re-reads both tables and replaces the
 * working set; a failed read REJECTS so the console answers an honest
 * error instead of a stale snapshot. Concurrent refreshes coalesce.
 */
let refreshInFlight = null;
export async function refreshAdvertiserLinks() {
  if (!DATABASE_ENABLED) return store.advertiserLinks.length;
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      const [profiles, links] = await Promise.all([
        db().advertiserProfile.findMany({ orderBy: [{ createdAt: 'asc' }] }),
        db().advertiserLink.findMany({ orderBy: [{ createdAt: 'asc' }] }),
      ]);
      store.advertiserProfiles = profiles.map(toStoreProfile);
      store.advertiserLinks = links.map(toStoreLink);
      return links.length;
    })().finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}
