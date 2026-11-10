import { Router } from 'express';
import { z } from 'zod';
import { createId } from '../data/store.js';
import { DATABASE_ENABLED, db } from '../db/client.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { MARKETING_ROLES, STAFF_ROLES } from '../config/security.js';

/**
 * Marketing platform routes — the Advertiser Console backend (2026-11-10).
 *
 * Accounts: advertisers, marketing managers, and developers self-register
 * through the normal /auth/register (they are public self-serve roles) and
 * sign in with the same login as everyone else. Each account gets:
 *
 *   - a CHANNEL CONNECT system: one ChannelLink row per ad channel with
 *     the account reference the professional provides (Google Ads customer
 *     ID, Meta ad account ID, ...). Links start PENDING_LINK; the Top
 *     Speed team completes the manager/partner link on the platform side
 *     and staff flip the row to CONNECTED. Honest scope: this is the
 *     connection record + workflow — live spend/metrics sync arrives per
 *     channel when that platform's API access is approved.
 *   - the console's planning/optimization tools are client-side; this API
 *     owns identity + connections + the staff review queue.
 */
const router = Router();

export const CHANNELS = [
  { key: 'GOOGLE_ADS', label: 'Google Ads', hint: 'Your 10-digit customer ID (xxx-xxx-xxxx)' },
  { key: 'META', label: 'Meta (Facebook / Instagram)', hint: 'Your ad account ID (act_...)' },
  { key: 'LOCAL_SERVICES', label: 'Google Local Services', hint: 'Your LSA account email or ID' },
  { key: 'TIKTOK', label: 'TikTok Ads', hint: 'Your advertiser account ID' },
  { key: 'YOUTUBE', label: 'YouTube', hint: 'Your channel handle or ID' },
  { key: 'NEXTDOOR', label: 'Nextdoor', hint: 'Your business page name or URL' },
];
const CHANNEL_KEYS = CHANNELS.map((c) => c.key);
const LINK_STATUSES = ['PENDING_LINK', 'CONNECTED', 'REJECTED'];

const consoleOnly = requireRole(...MARKETING_ROLES, ...STAFF_ROLES);
const staffOnly = requireRole(...STAFF_ROLES);

// ---------------------------------------------------------------------------
// Repository: Prisma or in-memory fallback (same shapes).
// ---------------------------------------------------------------------------
const memoryLinks = [];
const linksRepo = DATABASE_ENABLED
  ? {
      async listForUser(userId) {
        return db().channelLink.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
      },
      async upsert(userId, companyId, channel, accountRef, notes) {
        return db().channelLink.upsert({
          where: { userId_channel: { userId, channel } },
          create: { id: createId(), companyId, userId, channel, accountRef, notes: notes ?? null },
          update: { accountRef, notes: notes ?? null, status: 'PENDING_LINK' },
        });
      },
      async listAll() {
        return db().channelLink.findMany({
          orderBy: { createdAt: 'desc' },
          include: { user: { select: { email: true, firstName: true, lastName: true, roles: true } } },
        });
      },
      async setStatus(id, status) {
        return db().channelLink.update({ where: { id }, data: { status } });
      },
    }
  : {
      async listForUser(userId) {
        return memoryLinks.filter((l) => l.userId === userId);
      },
      async upsert(userId, companyId, channel, accountRef, notes) {
        const existing = memoryLinks.find((l) => l.userId === userId && l.channel === channel);
        if (existing) {
          existing.accountRef = accountRef;
          existing.notes = notes ?? null;
          existing.status = 'PENDING_LINK';
          existing.updatedAt = new Date().toISOString();
          return existing;
        }
        const row = {
          id: createId(), companyId, userId, channel, accountRef,
          status: 'PENDING_LINK', notes: notes ?? null,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        };
        memoryLinks.push(row);
        return row;
      },
      async listAll() {
        return [...memoryLinks].reverse();
      },
      async setStatus(id, status) {
        const row = memoryLinks.find((l) => l.id === id);
        if (row) { row.status = status; row.updatedAt = new Date().toISOString(); }
        return row;
      },
    };

function publicLink(link) {
  if (!link) return null;
  return {
    id: link.id,
    channel: link.channel,
    accountRef: link.accountRef,
    status: link.status,
    notes: link.notes ?? null,
    createdAt: link.createdAt instanceof Date ? link.createdAt.toISOString() : link.createdAt,
    updatedAt: link.updatedAt instanceof Date ? link.updatedAt.toISOString() : link.updatedAt,
    user: link.user
      ? {
          email: link.user.email,
          name: [link.user.firstName, link.user.lastName].filter(Boolean).join(' ') || null,
          roles: link.user.roles,
        }
      : undefined,
  };
}

const connectSchema = z.object({
  channel: z.enum(CHANNEL_KEYS),
  accountRef: z.string().trim().min(3).max(120),
  notes: z.string().trim().max(500).optional(),
});

router.get('/marketing/channels', authenticate, consoleOnly, async (req, res) => {
  const mine = await linksRepo.listForUser(req.user.id);
  const byChannel = new Map(mine.map((l) => [l.channel, publicLink(l)]));
  return res.json({
    data: {
      catalog: CHANNELS.map((c) => ({ ...c, link: byChannel.get(c.key) ?? null })),
      links: mine.map(publicLink),
    },
  });
});

router.post('/marketing/channels', authenticate, consoleOnly, async (req, res, next) => {
  try {
    const parsed = connectSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid channel connection', details: parsed.error.flatten() });
    }
    const link = await linksRepo.upsert(
      req.user.id, req.user.companyId, parsed.data.channel, parsed.data.accountRef, parsed.data.notes,
    );
    return res.status(201).json({ data: publicLink(link) });
  } catch (error) {
    return next(error);
  }
});

// Staff review queue: every connection request across advertisers.
router.get('/marketing/channel-links', authenticate, staffOnly, async (req, res) => {
  const all = await linksRepo.listAll();
  return res.json({ data: { count: all.length, links: all.map(publicLink) } });
});

const statusSchema = z.object({ status: z.enum(LINK_STATUSES) });
router.patch('/marketing/channel-links/:id', authenticate, staffOnly, async (req, res, next) => {
  try {
    const parsed = statusSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid status' });
    const updated = await linksRepo.setStatus(req.params.id, parsed.data.status);
    if (!updated) return res.status(404).json({ error: 'Channel link not found' });
    return res.json({ data: publicLink(updated) });
  } catch (error) {
    return next(error);
  }
});

export default router;
