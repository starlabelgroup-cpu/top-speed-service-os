import { Router } from 'express';
import { z } from 'zod';
import { sellerChannelsRepo } from '../db/sellerChannelsRepo.js';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { STAFF_ROLES } from '../config/security.js';

/**
 * Pepper Lists — Channel Connections (2026-11-17, Phase 1).
 *
 * The seller-side counterpart of the Advertiser Console's channel
 * system (routes/marketing.js): a per-account registry of the
 * external channels a Pepper Lists seller sells and posts on, with
 * an office oversight view. Two groups:
 *
 *   SELL — Facebook Marketplace, Google Shopping, eBay, Etsy,
 *          Walmart Marketplace (listings syndicate out)
 *   POST — TikTok, Facebook, YouTube, Instagram, X, LinkedIn
 *          (posts publish out), plus the seller's search-directory
 *          presence: Google Business Profile, Bing Places, and a
 *          general search-directories request (added 2026-11-17
 *          with the three-purpose consolidation — Sell / Post / Book)
 *
 * HONEST SCOPE — Phase 1 is the registry + request workflow ONLY:
 *  - There is NO user-facing third-party OAuth flow in this codebase
 *    today (checked: no Facebook/Meta OAuth, no eBay/Etsy/Walmart/
 *    TikTok/YouTube/Instagram/X/LinkedIn connect flow exists), so a
 *    connect files a PENDING request the Top Speed team completes on
 *    the platform side — the exact Advertiser Console pattern — and
 *    the seller sees the channel's real prerequisite up front.
 *  - NOTHING here can produce a CONNECTED row: that status is only
 *    ever set when a real completed connect flow exists (Phase 2,
 *    per channel). No simulated syncs, no placeholder connections,
 *    and Phase 1 stores no third-party tokens at all.
 *  - agentAccessGranted is the seller's explicit per-channel grant
 *    for the Muse agent (Pepper) to manage that channel for them —
 *    default OFF, revocable any time, and every change is written to
 *    the SellerChannelAudit log in the same call.
 *
 * Every seller route is scoped to req.user.id from the session token
 * (the multi-account vault's ACTIVE account) — a seller can only ever
 * see or change their own connections.
 */
const router = Router();

export const SELLER_CHANNELS = [
  {
    key: 'FACEBOOK', label: 'Facebook Marketplace', kind: 'SELL',
    blurb: 'Sell on Facebook Marketplace — your listings reach Marketplace buyers through your own Facebook account. The same connection also covers posting to your Facebook Page or profile.',
    nextSteps: 'Send the request with the name on your Facebook account. Our team completes the Facebook link on the platform side — no password sharing, ever. Listings are prepared in Pepper Lists and post through your connected account only after your yes.',
  },
  {
    key: 'GOOGLE_SHOPPING', label: 'Google Shopping', kind: 'SELL',
    blurb: 'Your products can show in Google Shopping results, tied to your own Merchant Center account.',
    nextSteps: 'You need your own Google Merchant Center account first — it is free to create at merchants.google.com. Then send this request with your Merchant Center account name or ID and our team completes the link.',
  },
  {
    key: 'EBAY', label: 'eBay', kind: 'SELL',
    blurb: 'Your Pepper Lists listings can be offered to eBay buyers under your own eBay seller account.',
    nextSteps: 'You need an eBay seller account first. Send this request with your eBay user ID and our team completes the connection — listing sync switches on with the eBay integration phase.',
  },
  {
    key: 'ETSY', label: 'Etsy', kind: 'SELL',
    blurb: 'Your handmade and vintage listings can reach Etsy shoppers through your own Etsy shop.',
    nextSteps: 'You need an Etsy shop first. Send this request with your shop name and our team completes the connection — listing sync switches on with the Etsy integration phase.',
  },
  {
    key: 'WALMART', label: 'Walmart Marketplace', kind: 'SELL',
    blurb: 'Your products can be offered on Walmart Marketplace under your own approved Walmart seller account.',
    nextSteps: 'Walmart approves its own sellers first — apply at marketplace.walmart.com (US business and tax verification are Walmart\u2019s own steps). Once you are approved, send this request with your Walmart seller name and our team completes the connection.',
  },
  {
    key: 'TIKTOK', label: 'TikTok', kind: 'POST',
    blurb: 'Post your listing videos to TikTok — and, with a TikTok Shop seller account, sell there too.',
    nextSteps: 'TikTok posting opens after TikTok\u2019s app review for our integration, and selling needs your own TikTok Shop seller registration (seller.tiktok.com). Send a request now — with your @handle — and your account is first in line when the channel opens.',
  },
  {
    key: 'YOUTUBE', label: 'YouTube', kind: 'POST',
    blurb: 'Post listing and shop videos to your own YouTube channel.',
    nextSteps: 'Posting runs through your own YouTube channel. Send this request with your channel handle (like @YourChannel) — video posting switches on with the YouTube integration phase.',
  },
  {
    key: 'INSTAGRAM', label: 'Instagram', kind: 'POST',
    blurb: 'Post your listings to your Instagram professional account.',
    nextSteps: 'Instagram posting needs a professional (business or creator) account linked to a Facebook Page. Send this request with your @handle and our team completes the Meta connection for your account.',
  },
  {
    key: 'X', label: 'X (Twitter)', kind: 'POST',
    blurb: 'Post your listings to your X account.',
    nextSteps: 'Posting to X runs on X\u2019s paid API tier. Send a request with your @handle and our team confirms the plan with you before anything is switched on — no charges without your say-so.',
  },
  {
    key: 'LINKEDIN', label: 'LinkedIn', kind: 'POST',
    blurb: 'Post your business listings to LinkedIn — your profile or company page.',
    nextSteps: 'Company-page posting needs LinkedIn\u2019s own approval for our app. Send a request with your profile or page name and we complete the link when the channel opens.',
  },
  {
    key: 'GOOGLE_BUSINESS', label: 'Google Business Profile', kind: 'POST',
    blurb: 'Your own business listing on Google Search and Maps — the profile customers find when they search for you.',
    nextSteps: 'The listing is yours: create or claim your free Google Business Profile at google.com/business and finish Google\u2019s own verification (Google decides how — often a video or a postcard). Send this request with your business name exactly as it appears on Google and our team completes the link on the platform side.',
  },
  {
    key: 'BING_PLACES', label: 'Bing Places', kind: 'POST',
    blurb: 'Your own business listing on Bing search and maps, through Microsoft\u2019s Bing Places for Business.',
    nextSteps: 'The listing is yours: claim or create it free at bingplaces.com and finish Microsoft\u2019s verification (often a PIN mailed to the business address). Send this request with your business name exactly as it appears on Bing Places and our team completes the link on the platform side.',
  },
  {
    key: 'SEARCH_DIRECTORIES', label: 'More search directories', kind: 'POST',
    blurb: 'Beyond Google and Bing: your business can also appear in more search and local directories, like Yelp and Apple Maps.',
    nextSteps: 'Every directory has its own claim and verification steps, and the listing is always yours. Send this request with your business name and our team confirms the directory list with you before anything is filed anywhere — nothing is submitted in your name without your say-so.',
  },
];
const CHANNEL_KEYS = SELLER_CHANNELS.map((c) => c.key);
const CHANNEL_BY_KEY = new Map(SELLER_CHANNELS.map((c) => [c.key, c]));

function iso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function publicConnection(row, channelDef) {
  if (!row) {
    return {
      id: null,
      channel: channelDef.key,
      kind: channelDef.kind,
      status: 'NOT_CONNECTED',
      externalAccountLabel: null,
      agentAccessGranted: false,
      connectedAt: null,
      lastSyncAt: null,
      createdAt: null,
      updatedAt: null,
    };
  }
  // Deliberately field-by-field: `meta` (request context) and any
  // future token material never leave the server through a serializer.
  return {
    id: row.id,
    channel: row.channel,
    kind: row.kind,
    status: row.status,
    externalAccountLabel: row.externalAccountLabel ?? null,
    agentAccessGranted: Boolean(row.agentAccessGranted),
    connectedAt: iso(row.connectedAt),
    lastSyncAt: iso(row.lastSyncAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function catalogWithConnections(rows) {
  const byChannel = new Map(rows.map((r) => [r.channel, r]));
  return SELLER_CHANNELS.map((def) => ({
    key: def.key,
    label: def.label,
    kind: def.kind,
    blurb: def.blurb,
    nextSteps: def.nextSteps,
    connection: publicConnection(byChannel.get(def.key) ?? null, def),
  }));
}

function channelOr404(req, res) {
  const def = CHANNEL_BY_KEY.get(String(req.params.channel || '').toUpperCase());
  if (!def) {
    res.status(404).json({ error: 'Unknown channel' });
    return null;
  }
  return def;
}

// ── Seller: my channels ─────────────────────────────────────────────
router.get('/pepper-lists/channels', authenticate, async (req, res, next) => {
  try {
    const rows = await sellerChannelsRepo.listForUser(req.user.id);
    return res.json({ data: { channels: catalogWithConnections(rows) } });
  } catch (error) {
    return next(error);
  }
});

const connectSchema = z.object({
  accountLabel: z.string().trim().min(2).max(120).optional(),
});

router.post('/pepper-lists/channels/:channel/connect', authenticate, async (req, res, next) => {
  const def = channelOr404(req, res);
  if (!def) return undefined;
  try {
    const parsed = connectSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid connection request', details: parsed.error.flatten() });
    }
    const row = await sellerChannelsRepo.requestConnect(
      req.user.id, def.key, def.kind, parsed.data.accountLabel,
    );
    return res.status(201).json({
      data: {
        connection: publicConnection(row, def),
        nextSteps: def.nextSteps,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/pepper-lists/channels/:channel/disconnect', authenticate, async (req, res, next) => {
  const def = channelOr404(req, res);
  if (!def) return undefined;
  try {
    const row = await sellerChannelsRepo.disconnect(req.user.id, def.key, def.kind);
    return res.json({ data: { connection: publicConnection(row, def) } });
  } catch (error) {
    return next(error);
  }
});

const agentAccessSchema = z.object({ granted: z.boolean() });

router.patch('/pepper-lists/channels/:channel/agent-access', authenticate, async (req, res, next) => {
  const def = channelOr404(req, res);
  if (!def) return undefined;
  try {
    const parsed = agentAccessSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid agent-access update', details: parsed.error.flatten() });
    }
    const row = await sellerChannelsRepo.setAgentAccess(req.user.id, def.key, def.kind, parsed.data.granted);
    return res.json({ data: { connection: publicConnection(row, def) } });
  } catch (error) {
    return next(error);
  }
});

// ── Office oversight (read-only): statuses + labels + audit trail ──
// Statuses only — no request context (`meta`), no token material
// (Phase 1 stores none). Same staff gate as the Pepper Lists media
// routes in routes/pepperLists.js.
const staffGate = [authenticate, requireCompany, requireRole(...STAFF_ROLES)];

router.get('/pepper-lists/channels/oversight', ...staffGate, async (req, res, next) => {
  try {
    const [rows, audit] = await Promise.all([
      sellerChannelsRepo.listAll(),
      sellerChannelsRepo.listRecentAudit(100),
    ]);
    return res.json({
      data: {
        count: rows.length,
        connections: rows.map((row) => ({
          ...publicConnection(row, CHANNEL_BY_KEY.get(row.channel) || { key: row.channel, kind: row.kind }),
          user: row.user
            ? {
                email: row.user.email,
                name: [row.user.firstName, row.user.lastName].filter(Boolean).join(' ') || null,
                roles: row.user.roles,
              }
            : undefined,
          userId: row.userId,
        })),
        audit: audit.map((entry) => ({
          id: entry.id,
          connectionId: entry.connectionId,
          userId: entry.userId,
          action: entry.action,
          detail: entry.detail ?? null,
          createdAt: iso(entry.createdAt),
        })),
      },
    });
  } catch (error) {
    return next(error);
  }
});

export default router;
