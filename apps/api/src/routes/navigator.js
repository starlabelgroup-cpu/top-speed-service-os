import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { STAFF_ROLES } from '../config/security.js';
import { navigatorChat, navigatorStatus } from '../services/navigator.js';
import { systemMapPayload, portalDirectoryPayload } from '../data/systemMap.js';
import {
  captureChatExchange,
  captureSafely,
  normalizeChatSessionId,
} from '../services/chatCapture.js';

/**
 * System Navigator (2026-11-17) — the staff-only back-office guide.
 *
 *   GET  /navigator/map     the system directory (areas + how-tos)
 *   GET  /navigator/status  answer mode + map size
 *   POST /navigator/chat    one guide turn
 *   GET  /navigator/directory  the PUBLIC Portal directory projection
 *                              (name/group/location/url/access label
 *                              only — no purposes, actions or how-tos;
 *                              the staff map above stays staff-only)
 *
 * Access — the STAFF gate, exactly: every staff role (STAFF_ROLES:
 * DISPATCHER, COMPANY_ADMIN, COMPANY_OWNER, PLATFORM_ADMIN) and
 * nobody else. Unauthenticated is 401; customers and providers are
 * 403. This is a back-office surface — it is never public.
 *
 * Read-only by construction (services/navigator.js): the guide
 * explains and deep-links from data/systemMap.js. It exposes no
 * action tools, mutates nothing, and its source contains no customer
 * PII and no credential, so no answer can return either.
 */
const router = Router();

const staffOnly = [authenticate, requireCompany, requireRole(...STAFF_ROLES)];

router.get('/navigator/status', ...staffOnly, (req, res) => {
  return res.json({ data: navigatorStatus() });
});

router.get('/navigator/map', ...staffOnly, (req, res) => {
  return res.json({ data: systemMapPayload() });
});

/* The Service OS Portal's Platform Directory (Ramone, 2026-11-20:
 * "/portal must be the platform directory for all platforms"). Public
 * by design — it is the ecosystem's front-door index — and safe by
 * construction: portalDirectoryPayload() projects only the public-safe
 * fields off the same system map. It grants nothing: every door it
 * lists keeps its own gate. */
router.get('/navigator/directory', (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  return res.json({ data: portalDirectoryPayload() });
});

const historyTurn = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().trim().min(1).max(2000),
});

const chatSchema = z.object({
  message: z.string().trim().min(1, 'Message is required').max(2000),
  history: z.array(historyTurn).max(10).optional(),
  sessionId: z.string().trim().max(64).optional(),
});

router.post('/navigator/chat', ...staffOnly, async (req, res) => {
  const parsed = chatSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid chat message', details: parsed.error.flatten() });
  }
  const { message, history, sessionId } = parsed.data;

  let result;
  try {
    result = await navigatorChat({ message, history: history || [] });
  } catch (error) {
    console.error(JSON.stringify({
      level: 'error',
      message: 'system navigator failed',
      error: String(error?.message || error),
    }));
    return res.status(500).json({ error: 'The Navigator could not answer just now — try again.' });
  }

  const session = await captureSafely(() =>
    captureChatExchange({
      sessionId,
      source: 'SYSTEM_NAVIGATOR',
      userId: req.user?.id || null,
      userMessage: message,
      assistantReply: result.reply,
      answeredBy: result.answeredBy === 'ai' ? 'ai' : 'knowledge-fallback',
    }),
  );

  return res.json({
    data: {
      reply: result.reply,
      answeredBy: result.answeredBy,
      kind: result.kind,
      links: result.links || [],
      sessionId: session?.id || normalizeChatSessionId(sessionId) || undefined,
    },
  });
});

export default router;
