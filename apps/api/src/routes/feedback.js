import { Router } from 'express';
import { z } from 'zod';
import { appendEvent } from '../data/store.js';
import { pepperReportsRepo } from '../db/pepperReportsRepo.js';
import { intakeRateLimit } from '../middleware/intakeShield.js';
import { honeypotTripped } from '../services/intakeShield.js';

/**
 * Customer feedback — the review funnel's private path
 * (recommendations F1, 2026-11-20).
 *
 * POST /feedback is the "tell the office first" door linked from
 * every review ask: a customer who would rather talk to a person
 * than post a public review files a note here, and it lands in the
 * Pepper report queue (the /pepper console report log) as a
 * NEEDS_OWNER report for the office to follow up.
 *
 * Policy, by design: this path is offered ALONGSIDE the public
 * review ask, never instead of it. Filing feedback creates NO
 * review, suppresses NOTHING, and is never read by the funnel's
 * reminder sweep — every completed job is asked equally, whether or
 * not the customer also wrote to the office.
 *
 * Public door discipline (Intake Shield): per-route rate limit from
 * the `feedback` family, and the shared honeypot — a tripped
 * honeypot gets the same 201 shape a real submission gets, but
 * persists NOTHING and files NO report.
 *
 * Mounted at the shared /api/v1 prefix with the limit carried PER
 * ROUTE — no router-wide gate (the 2026-11-17 shared-prefix rule).
 */
const router = Router();

const feedbackSchema = z.object({
  name: z.string().trim().max(120).optional(),
  email: z.string().trim().max(160).optional(),
  phone: z.string().trim().max(40).optional(),
  referenceCode: z.string().trim().max(40).optional(),
  message: z.string().trim().min(3, 'Please tell us a little about what happened').max(2000),
  companyWebsite: z.string().optional(),
});

router.post('/feedback', intakeRateLimit('feedback'), async (req, res) => {
  const parsed = feedbackSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid feedback', details: parsed.error.flatten() });
  }
  const data = parsed.data;

  // Honeypot: same success shape, nothing persisted, no report filed.
  if (honeypotTripped(req.body)) {
    return res.status(201).json({ data: { received: true } });
  }

  const reference = data.referenceCode ? data.referenceCode.toUpperCase() : null;
  const title = reference
    ? `Customer feedback — booking ${reference}`
    : 'Customer feedback — no booking reference';
  const lines = [
    data.message,
    '',
    `Name: ${data.name || 'Not given'}`,
    `Email: ${data.email || 'Not given'}`,
    `Phone: ${data.phone || 'Not given'}`,
    `Booking reference: ${reference || 'Not given'}`,
    'Source: review funnel "tell the office first" page (/feedback).',
  ];
  const report = await pepperReportsRepo.create({
    title,
    body: lines.join('\n'),
    category: 'NEEDS_OWNER',
    createdByUserId: null,
  });
  // The platform event carries the filing fact only — never the
  // customer's words (the same discipline REVIEW_SUBMITTED follows).
  await appendEvent('CUSTOMER_FEEDBACK_FILED', {
    source: 'WEB_FORM',
    actor: 'customer',
    entityType: 'PEPPER_REPORT',
    entityId: report.id,
    referenceCode: reference,
    details: { hasReference: Boolean(reference) },
  });
  return res.status(201).json({ data: { received: true } });
});

export default router;
