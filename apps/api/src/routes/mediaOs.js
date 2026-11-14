import { Router } from 'express';
import { z } from 'zod';
import { appendEvent, createId, store } from '../data/store.js';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { ROLES } from '../config/security.js';
import { slugify } from '../data/marketingTaxonomy.js';
import { persistMediaAsset, persistMediaContent } from '../db/mediaOsRepo.js';

/**
 * Top Speed Media OS — Phase 1 API on the Service OS backend
 * (blueprint: Top Speed Media OS Expanded Blueprint, 2026-11-13;
 * built per the approved digest on the existing stack).
 *
 * Public (what topspeedserviceos.com/media renders):
 *   GET /media-os/content           PUBLISHED content only (?division=)
 *   GET /media-os/content/:slug     one PUBLISHED record, else 404
 *
 * Admin (the /media console; same role guard as Marketing OS admin):
 *   GET/POST   /media-os/admin/content
 *   GET/PATCH  /media-os/admin/content/:id   (slug is immutable)
 *   POST       /media-os/admin/content/:id/status
 *   GET/POST   /media-os/admin/assets
 *   PATCH      /media-os/admin/assets/:id
 *
 * Editorial workflow, enforced server-side like the Marketing OS page
 * workflow: DRAFT → IN_REVIEW → APPROVED → SCHEDULED → PUBLISHED →
 * ARCHIVED, with IN_REVIEW → DRAFT as the send-back. A direct
 * DRAFT → PUBLISHED jump is a 422 — nothing reaches the public
 * without human review, per the platform's Speedy governance.
 */
const router = Router();
const mediaOnly = [
  authenticate,
  requireCompany,
  requireRole(ROLES.MARKETING_MANAGER, ROLES.COMPANY_ADMIN, ROLES.COMPANY_OWNER, ROLES.PLATFORM_ADMIN),
];

const CONTENT_TYPES = ['VIDEO', 'ARTICLE', 'SOCIAL_POST', 'LIVE', 'IMAGE'];
const DIVISIONS = ['VIDEOS', 'PUBLISHING', 'NEWS', 'SOCIAL', 'LIVE'];
const CONTENT_STATUSES = ['DRAFT', 'IN_REVIEW', 'APPROVED', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED'];
const RIGHTS_STATUSES = ['OWNED', 'LICENSED', 'PENDING_REVIEW'];
const TRANSITIONS = {
  DRAFT: ['IN_REVIEW'],
  IN_REVIEW: ['APPROVED', 'DRAFT'],
  APPROVED: ['SCHEDULED', 'PUBLISHED'],
  SCHEDULED: ['PUBLISHED'],
  PUBLISHED: ['ARCHIVED'],
  ARCHIVED: [],
};

function actorOf(req) {
  return req.user?.email || req.user?.id || 'media-os';
}

function assetCountFor(contentId) {
  return store.mediaAssets.filter((a) => a.contentId === contentId).length;
}

function publicContent(record) {
  return {
    id: record.id,
    slug: record.slug,
    type: record.type,
    division: record.division,
    title: record.title,
    description: record.description || null,
    assetUrl: record.assetUrl || null,
    thumbnailUrl: record.thumbnailUrl || null,
    durationSec: record.durationSec ?? null,
    transcript: record.transcript || null,
    destinationUrl: record.destinationUrl || null,
    status: record.status,
    publishAt: record.publishAt || null,
    publishedAt: record.publishedAt || null,
    tags: Array.isArray(record.tags) ? record.tags : [],
    createdBy: record.createdBy || null,
    updatedBy: record.updatedBy || null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function adminContent(record) {
  return { ...publicContent(record), assetCount: assetCountFor(record.id) };
}

function publicAsset(record) {
  return {
    id: record.id,
    contentId: record.contentId || null,
    kind: record.kind,
    name: record.name,
    url: record.url || null,
    rightsStatus: record.rightsStatus,
    rightsNote: record.rightsNote || null,
    createdAt: record.createdAt,
  };
}

function findContent(id) {
  return store.mediaContent.find((c) => c.id === id) || null;
}

// ─── public ─────────────────────────────────────────────────────────

router.get('/media-os/content', (req, res) => {
  const division = String(req.query.division || '').trim().toUpperCase();
  let items = store.mediaContent.filter((c) => c.status === 'PUBLISHED');
  if (division) items = items.filter((c) => c.division === division);
  items = [...items].sort((a, b) => String(b.publishedAt || b.updatedAt).localeCompare(String(a.publishedAt || a.updatedAt)));
  return res.json({ data: items.map(publicContent) });
});

router.get('/media-os/content/:slug', (req, res) => {
  const record = store.mediaContent.find((c) => c.slug === req.params.slug && c.status === 'PUBLISHED');
  if (!record) return res.status(404).json({ error: 'Published content not found for that slug' });
  return res.json({ data: publicContent(record) });
});

// ─── admin: content ─────────────────────────────────────────────────

router.get('/media-os/admin/content', ...mediaOnly, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const status = String(req.query.status || '').trim().toUpperCase();
  const division = String(req.query.division || '').trim().toUpperCase();
  const type = String(req.query.type || '').trim().toUpperCase();
  let items = [...store.mediaContent].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  if (status) items = items.filter((c) => c.status === status);
  if (division) items = items.filter((c) => c.division === division);
  if (type) items = items.filter((c) => c.type === type);
  if (q) {
    items = items.filter((c) =>
      c.title.toLowerCase().includes(q) || c.slug.includes(q) ||
      (Array.isArray(c.tags) && c.tags.some((t) => t.toLowerCase().includes(q))));
  }
  const byStatus = Object.fromEntries(CONTENT_STATUSES.map((s) => [s, store.mediaContent.filter((c) => c.status === s).length]));
  return res.json({
    data: items.map(adminContent),
    counts: { total: store.mediaContent.length, byStatus, published: byStatus.PUBLISHED, assets: store.mediaAssets.length },
  });
});

const contentCreateSchema = z.object({
  slug: z.string().trim().max(120).optional(),
  type: z.enum(CONTENT_TYPES),
  division: z.enum(DIVISIONS),
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().max(4000).nullable().optional(),
  assetUrl: z.string().trim().max(1000).nullable().optional(),
  thumbnailUrl: z.string().trim().max(1000).nullable().optional(),
  durationSec: z.number().int().min(0).max(86400).nullable().optional(),
  transcript: z.string().max(100000).nullable().optional(),
  destinationUrl: z.string().trim().max(1000).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
});

router.post('/media-os/admin/content', ...mediaOnly, async (req, res) => {
  const parsed = contentCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid content', details: parsed.error.flatten() });
  const slug = slugify(parsed.data.slug || parsed.data.title);
  if (!slug) return res.status(400).json({ error: 'A title or slug that produces a URL slug is required' });
  if (store.mediaContent.some((c) => c.slug === slug)) {
    return res.status(409).json({ error: 'A content record already exists for that slug', slug });
  }
  const now = new Date().toISOString();
  const record = {
    id: createId(),
    slug,
    type: parsed.data.type,
    division: parsed.data.division,
    title: parsed.data.title,
    description: parsed.data.description || null,
    assetUrl: parsed.data.assetUrl || null,
    thumbnailUrl: parsed.data.thumbnailUrl || null,
    durationSec: parsed.data.durationSec ?? null,
    transcript: parsed.data.transcript || null,
    destinationUrl: parsed.data.destinationUrl || null,
    status: 'DRAFT',
    publishAt: null,
    publishedAt: null,
    tags: parsed.data.tags || [],
    createdBy: actorOf(req),
    updatedBy: actorOf(req),
    createdAt: now,
    updatedAt: now,
  };
  store.mediaContent.push(record);
  await persistMediaContent(record);
  appendEvent('MEDIA_CONTENT_CREATED', {
    source: 'media-os-console',
    actor: actorOf(req),
    entityType: 'MEDIA_CONTENT',
    entityId: record.id,
    details: { slug, type: record.type, division: record.division },
  });
  return res.status(201).json({ data: adminContent(record) });
});

router.get('/media-os/admin/content/:id', ...mediaOnly, (req, res) => {
  const record = findContent(req.params.id);
  if (!record) return res.status(404).json({ error: 'Content not found' });
  return res.json({ data: adminContent(record) });
});

const contentPatchSchema = z.object({
  type: z.enum(CONTENT_TYPES).optional(),
  division: z.enum(DIVISIONS).optional(),
  title: z.string().trim().min(3).max(200).optional(),
  description: z.string().trim().max(4000).nullable().optional(),
  assetUrl: z.string().trim().max(1000).nullable().optional(),
  thumbnailUrl: z.string().trim().max(1000).nullable().optional(),
  durationSec: z.number().int().min(0).max(86400).nullable().optional(),
  transcript: z.string().max(100000).nullable().optional(),
  destinationUrl: z.string().trim().max(1000).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
});

router.patch('/media-os/admin/content/:id', ...mediaOnly, async (req, res) => {
  const record = findContent(req.params.id);
  if (!record) return res.status(404).json({ error: 'Content not found' });
  if (req.body && 'slug' in req.body) {
    return res.status(400).json({ error: 'Content slug is fixed — create a new record for a different slug' });
  }
  const parsed = contentPatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid content update', details: parsed.error.flatten() });
  Object.assign(record, parsed.data, { updatedBy: actorOf(req), updatedAt: new Date().toISOString() });
  await persistMediaContent(record);
  return res.json({ data: adminContent(record) });
});

const statusSchema = z.object({
  status: z.enum(CONTENT_STATUSES),
  publishAt: z.string().trim().max(40).nullable().optional(),
});

router.post('/media-os/admin/content/:id/status', ...mediaOnly, async (req, res) => {
  const record = findContent(req.params.id);
  if (!record) return res.status(404).json({ error: 'Content not found' });
  const parsed = statusSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid status change', details: parsed.error.flatten() });
  const target = parsed.data.status;
  if (target === record.status) return res.json({ data: adminContent(record) });
  const allowed = TRANSITIONS[record.status] || [];
  if (!allowed.includes(target)) {
    return res.status(422).json({
      error: `Cannot move content from ${record.status} to ${target}`,
      allowedTransitions: allowed,
    });
  }
  record.status = target;
  record.updatedBy = actorOf(req);
  record.updatedAt = new Date().toISOString();
  if (target === 'SCHEDULED') {
    if (parsed.data.publishAt) {
      const when = new Date(parsed.data.publishAt);
      if (Number.isNaN(when.getTime())) return res.status(400).json({ error: 'publishAt must be a valid date/time' });
      record.publishAt = when.toISOString();
    }
  }
  if (target === 'PUBLISHED') record.publishedAt = record.updatedAt;
  await persistMediaContent(record);
  appendEvent(`MEDIA_CONTENT_${target}`, {
    source: 'media-os-console',
    actor: actorOf(req),
    entityType: 'MEDIA_CONTENT',
    entityId: record.id,
    details: { slug: record.slug },
  });
  return res.json({ data: adminContent(record) });
});

// ─── admin: assets ──────────────────────────────────────────────────

router.get('/media-os/admin/assets', ...mediaOnly, (req, res) => {
  const contentId = String(req.query.contentId || '').trim();
  const rightsStatus = String(req.query.rightsStatus || '').trim().toUpperCase();
  let items = [...store.mediaAssets].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  if (contentId) items = items.filter((a) => a.contentId === contentId);
  if (rightsStatus) items = items.filter((a) => a.rightsStatus === rightsStatus);
  return res.json({ data: items.map(publicAsset) });
});

const assetCreateSchema = z.object({
  contentId: z.string().uuid().nullable().optional(),
  kind: z.string().trim().min(1).max(60),
  name: z.string().trim().min(1).max(200),
  url: z.string().trim().max(1000).nullable().optional(),
  rightsStatus: z.enum(RIGHTS_STATUSES).optional(),
  rightsNote: z.string().trim().max(500).nullable().optional(),
});

router.post('/media-os/admin/assets', ...mediaOnly, async (req, res) => {
  const parsed = assetCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid asset', details: parsed.error.flatten() });
  if (parsed.data.contentId && !findContent(parsed.data.contentId)) {
    return res.status(400).json({ error: 'contentId does not match a content record' });
  }
  const record = {
    id: createId(),
    contentId: parsed.data.contentId || null,
    kind: parsed.data.kind,
    name: parsed.data.name,
    url: parsed.data.url || null,
    rightsStatus: parsed.data.rightsStatus || 'PENDING_REVIEW',
    rightsNote: parsed.data.rightsNote || null,
    createdAt: new Date().toISOString(),
  };
  store.mediaAssets.push(record);
  await persistMediaAsset(record);
  appendEvent('MEDIA_ASSET_CREATED', {
    source: 'media-os-console',
    actor: actorOf(req),
    entityType: 'MEDIA_ASSET',
    entityId: record.id,
    details: { name: record.name, kind: record.kind, rightsStatus: record.rightsStatus },
  });
  return res.status(201).json({ data: publicAsset(record) });
});

const assetPatchSchema = z.object({
  contentId: z.string().uuid().nullable().optional(),
  kind: z.string().trim().min(1).max(60).optional(),
  name: z.string().trim().min(1).max(200).optional(),
  url: z.string().trim().max(1000).nullable().optional(),
  rightsStatus: z.enum(RIGHTS_STATUSES).optional(),
  rightsNote: z.string().trim().max(500).nullable().optional(),
});

router.patch('/media-os/admin/assets/:id', ...mediaOnly, async (req, res) => {
  const record = store.mediaAssets.find((a) => a.id === req.params.id);
  if (!record) return res.status(404).json({ error: 'Asset not found' });
  const parsed = assetPatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid asset update', details: parsed.error.flatten() });
  if (parsed.data.contentId && !findContent(parsed.data.contentId)) {
    return res.status(400).json({ error: 'contentId does not match a content record' });
  }
  Object.assign(record, parsed.data);
  await persistMediaAsset(record);
  return res.json({ data: publicAsset(record) });
});

export default router;
