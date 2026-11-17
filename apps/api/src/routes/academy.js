import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { ROLES, STAFF_ROLES } from '../config/security.js';
import { store } from '../data/store.js';
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
 *   GET  /academy/curriculum    the training modules (Media OS library,
 *                               read-only, scoped to the training tag)
 *   GET  /academy/specialists   the department → category → specialist roster
 *   POST /academy/coach         one coach turn with a chosen specialist
 *
 * Access — the TRAINEE gate (widened 2026-11-16 at Ramone's direction:
 * Service Setters enter the Academy as trainees, "same thing with the
 * other roles"): every staff role (STAFF_ROLES) plus the provider roles
 * (PROVIDER_TECH / PROVIDER_OWNER), plus MARKETING_MANAGER, which the
 * original gate already admitted. Trainee means LEARNING only: the
 * curriculum read, Speedy Class, and these coaches.
 *
 * Media OS ADMIN capabilities are NOT widened. Creating, editing,
 * transitioning, or deleting library content stays behind the separate
 * admin gate in routes/mediaOs.js (MARKETING_MANAGER / COMPANY_ADMIN /
 * COMPANY_OWNER / PLATFORM_ADMIN), which this file does not touch.
 * That separation is exactly why the curriculum is served here —
 * read-only and scoped to the training-academy tag — instead of the
 * Academy page reading the Media OS admin library endpoint.
 *
 * Coaches explain and guide only: the coach service holds no tools and
 * performs no operations (see services/academyCoach.js). Answers are
 * grounded in the Speedy knowledge base; when the AI provider is down
 * the coach answers from knowledge retrieval and says so in
 * data.answeredBy — the same always-answer contract as /speedy/chat.
 */
const router = Router();

const ACADEMY_TRAINEE_ROLES = [
  ...STAFF_ROLES,
  ROLES.PROVIDER_TECH,
  ROLES.PROVIDER_OWNER,
  ROLES.TECHNICIAN,
  ROLES.MARKETING_MANAGER,
];

const academyTrainee = [
  authenticate,
  requireCompany,
  requireRole(...ACADEMY_TRAINEE_ROLES),
];

function learnerContent(record) {
  return {
    id: record.id,
    slug: record.slug,
    type: record.type,
    division: record.division,
    title: record.title,
    description: record.description || null,
    assetUrl: record.assetUrl || null,
    thumbnailUrl: record.thumbnailUrl || null,
    destinationUrl: record.destinationUrl || null,
    // Lesson body for text content (the System Navigator course,
    // modules 30–38, is ARTICLE-type): trainees read the lesson from
    // the record itself. Video modules carry no transcript today, so
    // this stays null for them.
    transcript: record.transcript || null,
    durationSec: record.durationSec ?? null,
    status: record.status,
    tags: Array.isArray(record.tags) ? record.tags : [],
  };
}

router.get('/academy/curriculum', ...academyTrainee, (req, res) => {
  const items = store.mediaContent.filter(
    (c) => Array.isArray(c.tags) && c.tags.includes('training-academy'),
  );
  return res.json({ data: items.map(learnerContent) });
});

router.get('/academy/specialists', ...academyTrainee, (req, res) => {
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

router.post('/academy/coach', ...academyTrainee, async (req, res) => {
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
