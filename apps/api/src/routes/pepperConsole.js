import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { MANAGER_ROLES, STAFF_ROLES } from '../config/security.js';
import { buildPepperStatus } from '../services/pepperConsole.js';
import { buildPepperBriefing } from '../services/pepperBriefing.js';
import { buildOpsDigest, etDateString, formatDigestDraft } from '../services/opsDigest.js';
import { pepperChat, pepperChatStatus, pepperPhoto } from '../services/pepperChat.js';
import { PEPPER_REPORT_CATEGORIES, pepperReportsRepo } from '../db/pepperReportsRepo.js';

/**
 * Pepper — Systems Manager console API (2026-11-18).
 *
 * Ramone's direction: "I need pepper/muze agent working inside work
 * station as systems manager reporting to me Ramone Williams." This
 * router is Pepper's duty post inside the Workstation:
 *
 *   GET  /pepper-console/status   the systems board — an aggregate of
 *                                 REAL states read from the existing
 *                                 services/repos (services/
 *                                 pepperConsole.js), plus Pepper's
 *                                 identity block: name, title, the
 *                                 reporting line to Ramone Williams,
 *                                 the 2026-11-10 authority limits and
 *                                 Rule Zero.
 *   GET  /pepper-console/reports  the report log, newest first.
 *   POST /pepper-console/reports  staff file a report.
 *   GET  /pepper-console/digest   the morning ops digest (D14,
 *                                 2026-11-20): unassigned jobs, the
 *                                 exception queue, parts delays and
 *                                 yesterday's counts, computed from
 *                                 the real sources (services/
 *                                 opsDigest.js). A draft for the
 *                                 office — reading it sends nothing.
 *   POST /pepper-console/digest/draft
 *                                 save the current digest into the
 *                                 report log as a STATUS draft. Also
 *                                 sends nothing — the log is the
 *                                 delivery, by a human's choice.
 *   GET  /pepper-console/briefing the live operations briefing
 *                                 behind ApplianceMan's Pepper
 *                                 section (2026-11-20): insights,
 *                                 analytics and grounded
 *                                 recommendations in ONE aggregate
 *                                 (services/pepperBriefing.js).
 *                                 MANAGER-gated (MANAGER_ROLES —
 *                                 ApplianceMan is the managers'
 *                                 virtual office), per route like
 *                                 every gate in this router.
 *   POST /pepper/chat             the Workstation chat bar: staff
 *                                 ask Pepper about the platform,
 *                                 their work and onboarding; live
 *                                 status questions answer from the
 *                                 real board payload; problem
 *                                 reports file a NEEDS_OWNER report
 *                                 (services/pepperChat.js).
 *   POST /pepper/photo            the Pepper photo channel (camera
 *                                 upgrade, 2026-11-20): staff send a
 *                                 photo (job site, rating plate, a
 *                                 part) and get Pepper's read plus,
 *                                 for a plate, a structured DRAFT
 *                                 extraction. Same staff gate, same
 *                                 provider as the chat (OpenAI
 *                                 Responses API with image input).
 *                                 The read is a draft only — this
 *                                 endpoint writes NOTHING to any
 *                                 record.
 *
 * Gate: the staff set exactly (STAFF_ROLES — Service Setters,
 * managers, the Master, platform admin), carried PER ROUTE. This
 * router is mounted at the shared /api/v1 prefix, so there is
 * deliberately NO unscoped router.use gate here — an unscoped gate
 * on a shared-prefix router walls every router mounted after it
 * (the 2026-11-17 incident). Anonymous is 401, non-staff is 403.
 *
 * Data honesty: the status aggregate invents nothing — a system
 * that cannot be read reports { available: false, reason }; the
 * report log holds exactly what staff filed.
 */
const router = Router();

const staffGate = [authenticate, requireCompany, requireRole(...STAFF_ROLES)];
const managerGate = [authenticate, requireCompany, requireRole(...MANAGER_ROLES)];

function iso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function publicReport(row) {
  // Field-by-field: only the log's own fields and the filer's public
  // identity ever leave the server.
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    category: row.category,
    createdByUserId: row.createdByUserId ?? null,
    createdBy: row.createdBy
      ? {
          email: row.createdBy.email,
          name: [row.createdBy.firstName, row.createdBy.lastName].filter(Boolean).join(' ') || null,
          roles: row.createdBy.roles,
        }
      : null,
    createdAt: iso(row.createdAt),
  };
}

router.get('/pepper-console/status', ...staffGate, async (req, res, next) => {
  try {
    return res.json({ data: await buildPepperStatus() });
  } catch (error) {
    return next(error);
  }
});

router.get('/pepper-console/briefing', ...managerGate, async (req, res, next) => {
  try {
    return res.json({ data: await buildPepperBriefing() });
  } catch (error) {
    return next(error);
  }
});

router.get('/pepper-console/reports', ...staffGate, async (req, res, next) => {
  try {
    const rows = await pepperReportsRepo.listRecent(50);
    return res.json({ data: rows.map(publicReport) });
  } catch (error) {
    return next(error);
  }
});

const reportSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(160),
  body: z.string().trim().min(1, 'Body is required').max(4000),
  category: z.enum(PEPPER_REPORT_CATEGORIES),
});

router.post('/pepper-console/reports', ...staffGate, async (req, res, next) => {
  try {
    const parsed = reportSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid report', details: parsed.error.flatten() });
    }
    const row = await pepperReportsRepo.create({
      title: parsed.data.title,
      body: parsed.data.body,
      category: parsed.data.category,
      createdByUserId: req.user.id,
    });
    return res.status(201).json({ data: publicReport(row) });
  } catch (error) {
    return next(error);
  }
});

router.get('/pepper-console/digest', ...staffGate, async (req, res, next) => {
  try {
    return res.json({ data: await buildOpsDigest() });
  } catch (error) {
    return next(error);
  }
});

router.post('/pepper-console/digest/draft', ...staffGate, async (req, res, next) => {
  try {
    const digest = await buildOpsDigest();
    const row = await pepperReportsRepo.create({
      title: `Morning ops digest — ${etDateString(new Date())}`,
      body: formatDigestDraft(digest),
      category: 'STATUS',
      createdByUserId: req.user.id,
    });
    return res.status(201).json({ data: { report: publicReport(row), digest } });
  } catch (error) {
    return next(error);
  }
});

const chatHistoryTurn = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().trim().min(1).max(2000),
});

const chatSchema = z.object({
  message: z.string().trim().min(1, 'Message is required').max(2000),
  history: z.array(chatHistoryTurn).max(10).optional(),
  // Which console the bar is embedded in (e.g. "/book-os") — filed
  // with problem reports so the owner sees where it happened.
  surface: z.string().trim().max(60).optional(),
});

router.post('/pepper/chat', ...staffGate, async (req, res, next) => {
  try {
    const parsed = chatSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid chat message', details: parsed.error.flatten() });
    }
    const result = await pepperChat({
      message: parsed.data.message,
      history: parsed.data.history || [],
      user: { id: req.user.id, email: req.user.email },
      surface: parsed.data.surface || null,
    });
    return res.json({ data: { ...result, chat: pepperChatStatus() } });
  } catch (error) {
    return next(error);
  }
});

const photoSchema = z.object({
  imageDataUrl: z.string().trim().min(32).max(12_000_000),
  question: z.string().trim().max(500).optional(),
  // Which console/surface the photo came from (e.g. "/tech") — carried
  // into the model's context only; nothing is filed under it.
  context: z.string().trim().max(120).optional(),
});

router.post('/pepper/photo', ...staffGate, async (req, res) => {
  if (!pepperChatStatus().configured) {
    return res.status(503).json({ error: 'Pepper photo reading is unavailable right now — the vision provider is not configured on this server. Describe the photo in the chat instead.' });
  }
  const parsed = photoSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid photo', details: parsed.error.flatten() });
  }
  try {
    const result = await pepperPhoto({
      imageDataUrl: parsed.data.imageDataUrl,
      question: parsed.data.question || '',
      context: parsed.data.context || '',
    });
    return res.json({ data: result });
  } catch (error) {
    if (error?.code === 'PEPPER_PHOTO_UNCONFIGURED') {
      return res.status(503).json({ error: 'Pepper photo reading is unavailable right now — the vision provider is not configured on this server. Describe the photo in the chat instead.' });
    }
    if (/not a real photo/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: 'That file is not a real photo — its contents do not match an image format' });
    }
    return res.status(502).json({ error: 'Pepper could not read that photo just now — try again, or describe it in the chat', detail: String(error?.message || error) });
  }
});

export default router;
