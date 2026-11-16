import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { ROLES } from '../config/security.js';
import { specialistsRoster } from '../knowledge/specialists.js';
import { academyCoachChat, coachProviderConfigured } from '../services/academyCoach.js';
import {
  captureChatExchange,
  captureSafely,
  normalizeChatSessionId,
} from '../services/chatCapture.js';

/**
 * Top Speed Academy — AI Specialists & Strategists (2026-11-16).
 *
 *   GET  /academy/specialists   the department → category → specialist roster
 *   POST /academy/coach         one coach turn with a chosen specialist
 *
 * The gate is IDENTICAL to the Academy's own: the /academy page only
 * opens its staff zone for sessions that pass the Media OS admin check
 * (MARKETING_MANAGER / COMPANY_ADMIN / COMPANY_OWNER / PLATFORM_ADMIN),
 * so the coach endpoints use the same role set — a session that cannot
 * open the Academy cannot reach its specialists.
 *
 * Coaches explain and guide only: the coach service holds no tools and
 * performs no operations (see services/academyCoach.js). Answers are
 * grounded in the Speedy knowledge base; when the AI provider is down
 * the coach answers from knowledge retrieval and says so in
 * data.answeredBy — the same always-answer contract as /speedy/chat.
 */
const router = Router();

const academyStaff = [
  authenticate,
  requireCompany,
  requireRole(ROLES.MARKETING_MANAGER, ROLES.COMPANY_ADMIN, ROLES.COMPANY_OWNER, ROLES.PLATFORM_ADMIN),
];

router.get('/academy/specialists', ...academyStaff, (req, res) => {
  const roster = specialistsRoster();
  const categories = roster.departments.reduce((sum, dept) => sum + dept.categories.length, 0);
  return res.json({
    data: {
      ...roster,
      meta: {
        departments: roster.departments.length,
        categories,
        specialists: roster.departments.length + 1, // + the Ecosystem Guide
        providerConfigured: coachProviderConfigured(),
        mode: coachProviderConfigured() ? 'ai-with-knowledge-fallback' : 'knowledge-fallback',
        governance:
          'Specialists explain and guide only. They never execute operations — dispatch, approvals, refunds, account or campaign changes are done by people in the consoles.',
      },
    },
  });
});

const historyTurn = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().trim().min(1).max(2000),
});

const coachSchema = z.object({
  target: z.string().trim().min(1).max(60),
  message: z.string().trim().min(1, 'Message is required').max(2000),
  history: z.array(historyTurn).max(10).optional(),
  sessionId: z.string().trim().max(64).optional(),
});

router.post('/academy/coach', ...academyStaff, async (req, res) => {
  const parsed = coachSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid coach message', details: parsed.error.flatten() });
  }
  const { target, message, history, sessionId } = parsed.data;

  let result;
  try {
    result = await academyCoachChat({ target, message, history: history || [] });
  } catch (error) {
    console.error(JSON.stringify({
      level: 'error',
      message: 'academy coach failed',
      error: String(error?.message || error),
    }));
    return res.status(500).json({ error: 'The coach could not answer just now — try again.' });
  }
  if (!result) {
    return res.status(400).json({ error: 'Unknown specialist target', target });
  }

  const session = await captureSafely(() =>
    captureChatExchange({
      sessionId,
      source: 'ACADEMY_COACH',
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
      ...(result.governance ? { governance: result.governance } : {}),
      specialist: { target: result.scope.target, name: result.scope.name, title: result.scope.title },
      sessionId: session?.id || normalizeChatSessionId(sessionId) || undefined,
    },
  });
});

export default router;
