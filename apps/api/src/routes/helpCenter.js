import { Router } from 'express';
import { z } from 'zod';
import { appendEvent } from '../data/store.js';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { ROLES } from '../config/security.js';
import { PLATFORM_CONSTANTS } from '../config/platform.js';
import {
  listPublicHelpArticles,
  getPublicHelpArticle,
  listAdminHelpArticles,
  helpEntryExists,
} from '../services/helpCenter.js';
import { setHelpArticleState } from '../db/helpCenterRepo.js';

/**
 * Public Help Center (2026-11-20, Wave 3 E5) — topspeedserviceos.com/help.
 *
 * Public lanes (no auth):
 *   GET /help/articles           PUBLISHED articles only (?q= search)
 *   GET /help/articles/:entryId  one PUBLISHED article, else 404
 *
 * Staff lanes (the Media OS role set — this is a publishing
 * surface), gated ONLY under this router's own /help/admin subpath
 * (the shared-prefix rule):
 *   GET  /help/admin/articles                    every knowledge
 *     entry with its publishing state + counts
 *   POST /help/admin/articles/:entryId/status    { status:
 *     'PUBLISHED' | 'DRAFT' } — the human approval step. Publishing
 *     is ALWAYS a person's decision here; nothing auto-publishes.
 *
 * The articles are Speedy's grounded knowledge entries — the same
 * facts Speedy answers from, rebuilt from live platform sources —
 * so the help center can never drift from the platform. Every
 * article payload carries the booking paths (book + call) the page
 * renders against it: no bare SEO pages, help wires into booking.
 */
const router = Router();

const helpStaff = [
  authenticate,
  requireCompany,
  requireRole(ROLES.MARKETING_MANAGER, ROLES.AD_SPECIALIST, ROLES.COMPANY_ADMIN, ROLES.COMPANY_OWNER, ROLES.PLATFORM_ADMIN),
];
router.use('/help/admin', ...helpStaff);

function bookingPaths() {
  return {
    bookUrl: '/book',
    callDisplay: PLATFORM_CONSTANTS.phoneDisplay,
    callHref: `tel:+1${String(PLATFORM_CONSTANTS.phone).replace(/\D/g, '')}`,
  };
}

router.get('/help/articles', async (req, res) => {
  const data = await listPublicHelpArticles({ q: req.query.q });
  return res.json({ data: { ...data, booking: bookingPaths() } });
});

router.get('/help/articles/:entryId', async (req, res) => {
  const article = await getPublicHelpArticle(req.params.entryId);
  if (!article) return res.status(404).json({ error: 'Help article not found' });
  return res.json({ data: { article, booking: bookingPaths() } });
});

router.get('/help/admin/articles', async (req, res) => {
  const data = await listAdminHelpArticles();
  return res.json({ data });
});

const statusSchema = z.object({
  status: z.enum(['PUBLISHED', 'DRAFT']),
});

router.post('/help/admin/articles/:entryId/status', async (req, res) => {
  const parsed = statusSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid status', details: parsed.error.flatten() });
  }
  const { entryId } = req.params;
  if (!helpEntryExists(entryId)) {
    return res.status(404).json({ error: 'No knowledge entry with that id' });
  }
  const state = await setHelpArticleState(entryId, {
    status: parsed.data.status,
    updatedById: req.user.id,
  });
  await appendEvent(parsed.data.status === 'PUBLISHED' ? 'HELP_ARTICLE_PUBLISHED' : 'HELP_ARTICLE_UNPUBLISHED', {
    source: 'help-center',
    actor: req.user.email || req.user.id,
    entityType: 'HELP_ARTICLE',
    entityId: entryId,
    details: { entryId, status: parsed.data.status },
  });
  return res.json({ data: { entryId, state: state.status, publishedAt: state.publishedAt } });
});

export default router;
