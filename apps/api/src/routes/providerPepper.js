import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { ROLES } from '../config/security.js';
import { providerPepperChat, providerPepperStatus } from '../services/providerPepper.js';
import { captureChatExchange, captureSafely, normalizeChatSessionId } from '../services/chatCapture.js';
import { myProvider } from './provider.js';

/**
 * Ask Pepper for providers (2026-11-20, recommendations D13).
 *
 *   POST /provider/pepper/chat   the provider lane of Ask Pepper.
 *
 * Pepper's staff chat (POST /pepper/chat) is staff-gated on
 * purpose — Field Pro has no Ask Pepper because that endpoint
 * refuses provider accounts. This lane EXTENDS Ask Pepper to the
 * provider roles ONLY (PROVIDER_OWNER / PROVIDER_TECH /
 * TECHNICIAN), with the scoped service in services/
 * providerPepper.js: their own board, the trade knowledge bases,
 * and a deterministic scope wall around everything else (office
 * data, other providers, finance, credentials, refunds, safety
 * certification — the 2026-11-10 authority limits).
 *
 * Staff accounts get a 403 here and keep using /pepper/chat;
 * customers and anonymous callers likewise. The gate is carried
 * PER ROUTE — this router mounts at the shared /api/v1 prefix and
 * deliberately has NO unscoped router.use gate (the 2026-11-17
 * incident rule).
 *
 * Field Pro reaches this endpoint with the app's normal provider
 * Bearer token — that is the app's surface for the lane; the
 * /tech-network page carries the web panel.
 */
const router = Router();

const providerGate = [
  authenticate,
  requireCompany,
  requireRole(ROLES.PROVIDER_OWNER, ROLES.PROVIDER_TECH, ROLES.TECHNICIAN),
];

const chatHistoryTurn = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().trim().min(1).max(2000),
});

const chatSchema = z.object({
  message: z.string().trim().min(1, 'Message is required').max(2000),
  history: z.array(chatHistoryTurn).max(10).optional(),
  sessionId: z.string().trim().max(64).optional(),
});

router.post('/provider/pepper/chat', ...providerGate, async (req, res, next) => {
  try {
    const parsed = chatSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid chat message', details: parsed.error.flatten() });
    }
    const provider = myProvider(req);
    const result = await providerPepperChat({
      message: parsed.data.message,
      history: parsed.data.history || [],
      provider,
    });
    const session = await captureSafely(() =>
      captureChatExchange({
        sessionId: parsed.data.sessionId,
        source: 'PROVIDER_PEPPER',
        userId: req.user?.id || null,
        userMessage: parsed.data.message,
        assistantReply: result.reply,
        answeredBy: result.answeredBy === 'ai' ? 'ai' : 'knowledge-fallback',
      }),
    );
    return res.json({
      data: {
        ...result,
        chat: providerPepperStatus(),
        sessionId: session?.id || normalizeChatSessionId(parsed.data.sessionId) || undefined,
      },
    });
  } catch (error) {
    return next(error);
  }
});

export default router;
