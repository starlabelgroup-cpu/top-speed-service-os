import { Router } from 'express';
import { z } from 'zod';
import { addBookingEvent, appendEvent, store } from '../data/store.js';
import { persistAssignment, persistBooking } from '../db/bookingsRepo.js';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { ROLES } from '../config/security.js';
import { windowById } from '../services/bookos.js';
import { speedyStatus, speedyStructureNote } from '../services/speedy.js';

/**
 * Provider side of dispatch — the Tech App's live data.
 *
 * A provider login (PROVIDER_OWNER / PROVIDER_TECH / TECHNICIAN) belongs to
 * the provider's own company; the Provider record with the same companyId
 * is "their" provider. Setter-APPROVED assignments are the job offers: the
 * tech accepts (→ ACCEPTED) or declines (→ DECLINED, and the booking goes
 * back to the setter queue for a new match).
 */
const router = Router();

const providerOnly = [
  authenticate,
  requireCompany,
  requireRole(
    ROLES.PROVIDER_OWNER,
    ROLES.PROVIDER_TECH,
    ROLES.TECHNICIAN,
    ROLES.PLATFORM_ADMIN,
  ),
];

function myProvider(req) {
  return store.providers.find((provider) => provider.companyId === req.user.companyId) || null;
}

/**
 * Provider company directory for the Portal's team-accounts panel: when
 * the owner creates a Tech App account, the account must land inside the
 * provider's company. Staff-level read — names and ids only.
 */
router.get(
  '/provider/companies',
  authenticate,
  requireCompany,
  requireRole(ROLES.PLATFORM_ADMIN, ROLES.COMPANY_OWNER, ROLES.COMPANY_ADMIN, ROLES.DISPATCHER),
  (req, res) => {
    const seen = new Map();
    for (const provider of store.providers) {
      if (!seen.has(provider.companyId)) {
        seen.set(provider.companyId, { companyId: provider.companyId, businessName: provider.businessName });
      }
    }
    return res.json({ data: [...seen.values()] });
  },
);

function noProvider(res) {
  return res.status(404).json({
    error: 'No provider record is linked to this account\u2019s company',
  });
}

function appointmentSummary(booking) {
  const a = booking.appointment;
  if (!a || a.status !== 'SET') return null;
  return {
    date: a.date,
    window: a.window,
    windowLabel: windowById(a.window)?.label || a.window,
    status: a.status,
  };
}

function publicAssignment(assignment) {
  const booking = store.bookings.get(assignment.bookingId);
  return {
    id: assignment.id,
    bookingId: assignment.bookingId,
    status: assignment.status,
    matchScore: assignment.matchScore ?? null,
    createdAt: assignment.createdAt,
    approvedBy: assignment.approvedBy ?? null,
    approvedAt: assignment.approvedAt ?? null,
    booking: booking
      ? {
          referenceCode: booking.referenceCode || null,
          appliance: booking.appliance,
          issue: booking.issue,
          city: booking.city,
          zip: booking.zip,
          status: booking.status,
          customer: booking.customer
            ? {
                name: booking.customer.name,
                phone: booking.customer.phone,
                address: booking.customer.address || null,
              }
            : null,
          appointment: appointmentSummary(booking),
        }
      : null,
  };
}

router.get('/provider/me', ...providerOnly, (req, res) => {
  const provider = myProvider(req);
  if (!provider) return noProvider(res);
  return res.json({ data: { provider } });
});

router.get('/provider/assignments', ...providerOnly, (req, res) => {
  const provider = myProvider(req);
  if (!provider) return noProvider(res);
  const mine = [...store.dispatchAssignments.values()]
    .filter((assignment) => assignment.providerId === provider.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(publicAssignment);
  return res.json({
    data: {
      provider: { id: provider.id, businessName: provider.businessName },
      assignments: mine,
    },
  });
});

const respondSchema = z.object({
  note: z.string().trim().max(300).optional(),
});

router.post('/provider/assignments/:id/accept', ...providerOnly, async (req, res) => {
  const provider = myProvider(req);
  if (!provider) return noProvider(res);
  const assignment = store.dispatchAssignments.get(req.params.id);
  if (!assignment || assignment.providerId !== provider.id) {
    return res.status(404).json({ error: 'Assignment not found' });
  }
  if (assignment.status !== 'APPROVED') {
    return res.status(409).json({
      error: `Only an APPROVED offer can be accepted (current: ${assignment.status})`,
    });
  }
  assignment.status = 'ACCEPTED';
  assignment.acceptedAt = new Date().toISOString();
  assignment.updatedAt = assignment.acceptedAt;

  const booking = store.bookings.get(assignment.bookingId);
  if (booking) {
    addBookingEvent(booking, 'ASSIGNMENT_ACCEPTED', req.user.email, {
      assignmentId: assignment.id,
      providerId: provider.id,
    });
    appendEvent('ASSIGNMENT_ACCEPTED', {
      source: booking.source || null,
      actor: req.user.email,
      entityType: 'BOOKING',
      entityId: booking.id,
      referenceCode: booking.referenceCode || null,
      details: { providerId: provider.id, businessName: provider.businessName },
    });
    await persistBooking(booking);
  }
  await persistAssignment(assignment);
  return res.json({ data: publicAssignment(assignment) });
});

router.post('/provider/assignments/:id/decline', ...providerOnly, async (req, res) => {
  const parsed = respondSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid decline request', details: parsed.error.flatten() });
  }
  const provider = myProvider(req);
  if (!provider) return noProvider(res);
  const assignment = store.dispatchAssignments.get(req.params.id);
  if (!assignment || assignment.providerId !== provider.id) {
    return res.status(404).json({ error: 'Assignment not found' });
  }
  if (assignment.status !== 'APPROVED') {
    return res.status(409).json({
      error: `Only an APPROVED offer can be declined (current: ${assignment.status})`,
    });
  }
  assignment.status = 'DECLINED';
  assignment.declinedAt = new Date().toISOString();
  assignment.updatedAt = assignment.declinedAt;

  const booking = store.bookings.get(assignment.bookingId);
  if (booking) {
    // Back to the setter queue so Service Setters can match another provider.
    booking.status = 'PENDING_DISPATCH';
    booking.dispatch = {
      ...(booking.dispatch || {}),
      stage: 'PROVIDER_DECLINED',
      declinedByProviderId: provider.id,
      declineNote: parsed.data.note || null,
    };
    booking.updatedAt = assignment.declinedAt;
    addBookingEvent(booking, 'ASSIGNMENT_DECLINED', req.user.email, {
      assignmentId: assignment.id,
      providerId: provider.id,
      note: parsed.data.note || null,
    });
    appendEvent('ASSIGNMENT_DECLINED', {
      source: booking.source || null,
      actor: req.user.email,
      entityType: 'BOOKING',
      entityId: booking.id,
      referenceCode: booking.referenceCode || null,
      details: { providerId: provider.id, businessName: provider.businessName },
    });
    await persistBooking(booking);
  }
  await persistAssignment(assignment);
  return res.json({ data: publicAssignment(assignment) });
});

export default router;

/* ------------- AI-assisted job updates (technician-confirmed) -------------
 * The tech dictates; Speedy structures; the TECH confirms before
 * anything is saved. Saving writes a TECH_NOTE event onto the job —
 * status changes stay on the explicit accept/complete actions, and
 * Speedy never certifies a repair (governance, 2026-11-10).
 */
const aiNotePreviewSchema = z.object({ text: z.string().trim().min(3).max(4000) });

router.post('/provider/assignments/:id/ai-note/preview', ...providerOnly, async (req, res) => {
  const provider = myProvider(req);
  if (!provider) return noProvider(res);
  const assignment = store.dispatchAssignments.get(req.params.id);
  if (!assignment || assignment.providerId !== provider.id) {
    return res.status(404).json({ error: 'Assignment not found' });
  }
  if (!speedyStatus().configured) {
    return res.status(503).json({ error: 'Speedy is not configured yet' });
  }
  const parsed = aiNotePreviewSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid note text' });
  try {
    const structured = await speedyStructureNote(parsed.data.text);
    return res.json({ data: { structured } });
  } catch (error) {
    return res.status(502).json({ error: 'Speedy could not structure that note — your words are kept; try again or save a plain note', detail: String(error?.message || error) });
  }
});

const aiNoteSaveSchema = z.object({
  raw: z.string().trim().min(3).max(4000),
  note: z.string().trim().min(3).max(2000),
  partsUsed: z.array(z.string().trim().max(120)).max(20).optional(),
  nextStep: z.string().trim().max(300).nullable().optional(),
  statusSuggestion: z.enum(['NONE', 'COMPLETED', 'NEEDS_PARTS', 'FOLLOW_UP']).optional(),
});

router.post('/provider/assignments/:id/ai-note', ...providerOnly, async (req, res) => {
  const provider = myProvider(req);
  if (!provider) return noProvider(res);
  const assignment = store.dispatchAssignments.get(req.params.id);
  if (!assignment || assignment.providerId !== provider.id) {
    return res.status(404).json({ error: 'Assignment not found' });
  }
  const parsed = aiNoteSaveSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid note', details: parsed.error.flatten() });
  }
  const booking = store.bookings.get(assignment.bookingId);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  const { raw, note, partsUsed = [], nextStep = null, statusSuggestion = 'NONE' } = parsed.data;
  addBookingEvent(booking, 'TECH_NOTE', req.user.email, {
    assignmentId: assignment.id,
    note,
    partsUsed,
    nextStep,
    statusSuggestion,
    rawDictation: raw,
    structuredBy: 'SPEEDY',
    confirmedBy: 'TECHNICIAN',
  });
  booking.updatedAt = new Date().toISOString();
  await persistBooking(booking);
  appendEvent('TECH_NOTE', {
    source: 'TECH_APP',
    actor: req.user.email,
    entityType: 'BOOKING',
    entityId: booking.id,
    referenceCode: booking.referenceCode,
    details: { statusSuggestion },
  });
  return res.status(201).json({ data: { saved: true, referenceCode: booking.referenceCode } });
});
