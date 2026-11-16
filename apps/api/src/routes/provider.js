import { Router } from 'express';
import { z } from 'zod';
import { addBookingEvent, appendEvent, createId, store } from '../data/store.js';
import { persistAssignment, persistBooking } from '../db/bookingsRepo.js';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { ROLES } from '../config/security.js';
import { windowById } from '../services/bookos.js';
import { notifyTechEnRoute, notifyTrackingUpdate } from '../services/notifications.js';
import { emitReport } from '../services/managementReports.js';
import { computeTracking } from '../services/tracking.js';
import { speedyExtractModelPlate, speedyPartsFinder, speedyStatus, speedyStructureNote } from '../services/speedy.js';

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

/* ------------- Track My Tech: technician job progression -------------
 * The tech advances the job from the Tech App; each tap records a real
 * event on the booking, which is what the customer's 8-stage tracking
 * timeline reads. ETAs are the technician's own estimate — never
 * generated. Status changes to the booking itself (completion etc.)
 * stay on their existing actions.
 */
const jobStatusSchema = z.object({
  action: z.enum(['EN_ROUTE', 'ARRIVED', 'DIAGNOSIS_STARTED', 'ESTIMATE_APPROVED']),
  etaMinutes: z.number().int().min(1).max(600).optional(),
});
const JOB_EVENT_TYPES = {
  EN_ROUTE: 'TECH_EN_ROUTE',
  ARRIVED: 'TECH_ARRIVED',
  DIAGNOSIS_STARTED: 'DIAGNOSIS_STARTED',
  ESTIMATE_APPROVED: 'ESTIMATE_APPROVED',
};

router.post('/provider/assignments/:id/job-status', ...providerOnly, async (req, res) => {
  const provider = myProvider(req);
  if (!provider) return noProvider(res);
  const assignment = store.dispatchAssignments.get(req.params.id);
  if (!assignment || assignment.providerId !== provider.id) {
    return res.status(404).json({ error: 'Assignment not found' });
  }
  if (!['APPROVED', 'ACCEPTED'].includes(assignment.status)) {
    return res.status(409).json({ error: 'Assignment is not active' });
  }
  const parsed = jobStatusSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid job status update', details: parsed.error.flatten() });
  }
  const booking = store.bookings.get(assignment.bookingId);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  const type = JOB_EVENT_TYPES[parsed.data.action];
  addBookingEvent(booking, type, req.user.email, {
    assignmentId: assignment.id,
    etaMinutes: parsed.data.action === 'EN_ROUTE' ? parsed.data.etaMinutes ?? null : null,
    confirmedBy: 'TECHNICIAN',
  });
  if (parsed.data.action === 'EN_ROUTE' && parsed.data.etaMinutes) {
    assignment.etaMinutes = parsed.data.etaMinutes;
    await persistAssignment(assignment);
  }
  booking.updatedAt = new Date().toISOString();
  await persistBooking(booking);
  // Lifecycle updates: when the tech reports a stage, the customer is
  // notified through the same outbox as every other platform message.
  if (parsed.data.action === 'EN_ROUTE') {
    notifyTechEnRoute(booking, 'TECH_APP');
  } else {
    notifyTrackingUpdate(booking, computeTracking(booking).stageLabel8, 'TECH_APP', `booking:${booking.id}:stage:${type}:${booking.updatedAt}`);
  }
  emitReport({
    department: 'field',
    type: 'JOB_STAGE_UPDATE',
    title: `Job stage: ${parsed.data.action} — ${booking.referenceCode || booking.id}`,
    detail: { bookingId: booking.id, bookingReference: booking.referenceCode || null, service: booking.appliance || null, city: booking.city || null, action: parsed.data.action, stage: computeTracking(booking).stageLabel8 || null, actor: req.user.email },
    source: 'TECH_APP',
    reference: booking.referenceCode || null,
    eventKey: `booking:${booking.id}:stage:${type}:${booking.updatedAt}:report`,
  });
  appendEvent(type, {
    source: 'TECH_APP',
    actor: req.user.email,
    entityType: 'BOOKING',
    entityId: booking.id,
    referenceCode: booking.referenceCode,
    details: { etaMinutes: parsed.data.etaMinutes ?? null },
  });
  return res.status(201).json({ data: { saved: true, referenceCode: booking.referenceCode, event: type } });
});

const locationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy: z.number().min(0).max(100000).optional(),
});

/**
 * Track My Tech live GPS (2026-11-11): the technician's device reports
 * its position for an active assignment. Only the latest fix is kept on
 * the assignment; customers see it solely while the job is en route,
 * via services/tracking.js. A position is never generated server-side.
 */
router.post('/provider/assignments/:id/location', ...providerOnly, async (req, res) => {
  const provider = myProvider(req);
  if (!provider) return noProvider(res);
  const assignment = store.dispatchAssignments.get(req.params.id);
  if (!assignment || assignment.providerId !== provider.id) {
    return res.status(404).json({ error: 'Assignment not found' });
  }
  if (!['APPROVED', 'ACCEPTED'].includes(assignment.status)) {
    return res.status(409).json({ error: 'Assignment is not active' });
  }
  const parsed = locationSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid location report', details: parsed.error.flatten() });
  }
  assignment.lastLat = parsed.data.lat;
  assignment.lastLng = parsed.data.lng;
  assignment.lastLocationAt = new Date().toISOString();
  assignment.locationAccuracy = parsed.data.accuracy ?? null;
  await persistAssignment(assignment);
  return res.status(201).json({ data: { saved: true, updatedAt: assignment.lastLocationAt } });
});

/* ------------- Field workspace (Speedy AI Field Pro integration) -------------
 * The Tech App's per-job workspace: service checklist, plain tech notes,
 * and the read model the workspace renders (notes + stage timeline +
 * pricing facts). Checklist state and notes ride the booking's history —
 * the platform's audit trail — so they persist with the job record and
 * need no new tables. The checklist template is owned here; the client
 * only reports which steps are done. Estimates are NOT created here:
 * written quotes are prepared after diagnosis through the existing
 * quote flow, and the ESTIMATE_APPROVED job-status action records the
 * customer's approval — this surface only reads those facts back.
 */
const FIELD_CHECKLIST_TEMPLATE = [
  { id: 'confirm_details', label: 'Confirm customer and appliance details' },
  { id: 'symptoms_safety', label: 'Document symptoms and safety checks' },
  { id: 'diagnostic_testing', label: 'Complete diagnostic testing' },
  { id: 'quote_authorization', label: 'Present written quote and obtain authorization' },
  { id: 'test_document', label: 'Test operation and document results' },
];
const FIELD_CHECKLIST_IDS = FIELD_CHECKLIST_TEMPLATE.map((item) => item.id);
const STAGE_EVENT_TYPES = [
  'ASSIGNMENT_ACCEPTED',
  'TECH_EN_ROUTE',
  'TECH_ARRIVED',
  'DIAGNOSIS_STARTED',
  'ESTIMATE_APPROVED',
];

function loadMyAssignment(req, res) {
  const provider = myProvider(req);
  if (!provider) {
    noProvider(res);
    return null;
  }
  const assignment = store.dispatchAssignments.get(req.params.id);
  if (!assignment || assignment.providerId !== provider.id) {
    res.status(404).json({ error: 'Assignment not found' });
    return null;
  }
  const booking = store.bookings.get(assignment.bookingId);
  if (!booking) {
    res.status(404).json({ error: 'Booking not found' });
    return null;
  }
  return { provider, assignment, booking };
}

function fieldChecklist(booking) {
  let doneIds = [];
  for (const event of booking.history || []) {
    if (event.type === 'FIELD_CHECKLIST_UPDATED' && Array.isArray(event.doneIds)) {
      doneIds = event.doneIds;
    }
  }
  const done = new Set(doneIds.filter((id) => FIELD_CHECKLIST_IDS.includes(id)));
  return FIELD_CHECKLIST_TEMPLATE.map((item) => ({ ...item, done: done.has(item.id) }));
}

function workspaceNotes(booking) {
  return (booking.history || [])
    .filter((event) => event.type === 'TECH_NOTE')
    .slice(-30)
    .reverse()
    .map((event) => ({
      note: event.note || '',
      at: event.at || null,
      actor: event.actor || null,
      partsUsed: Array.isArray(event.partsUsed) ? event.partsUsed : [],
      nextStep: event.nextStep || null,
      statusSuggestion: event.statusSuggestion || 'NONE',
      structuredBy: event.structuredBy || null,
    }));
}

function workspaceView(assignment, booking) {
  const history = booking.history || [];
  return {
    assignment: publicAssignment(assignment),
    checklist: fieldChecklist(booking),
    notes: workspaceNotes(booking),
    stageEvents: history
      .filter((event) => STAGE_EVENT_TYPES.includes(event.type))
      .map((event) => ({ type: event.type, at: event.at || null })),
    estimateApproved: history.some((event) => event.type === 'ESTIMATE_APPROVED'),
    pricing: {
      segment: booking.segment || 'RESIDENTIAL',
      diagnosticFee: booking.diagnosticFee ?? 99,
      diagnosticFeeCreditedTowardRepair: booking.diagnosticFeeCreditedTowardRepair ?? true,
      feeStatus: booking.feeStatus || null,
    },
    completedAt: booking.completedAt || null,
    partsOrders: plugOrders(booking),
  };
}

router.get('/provider/assignments/:id/workspace', ...providerOnly, (req, res) => {
  const loaded = loadMyAssignment(req, res);
  if (!loaded) return;
  if (!['APPROVED', 'ACCEPTED'].includes(loaded.assignment.status)) {
    return res.status(409).json({ error: 'Assignment is not active' });
  }
  return res.json({ data: workspaceView(loaded.assignment, loaded.booking) });
});

const checklistSchema = z.object({
  doneIds: z.array(z.enum(FIELD_CHECKLIST_IDS)).max(FIELD_CHECKLIST_IDS.length),
});

router.put('/provider/assignments/:id/checklist', ...providerOnly, async (req, res) => {
  const loaded = loadMyAssignment(req, res);
  if (!loaded) return;
  const { assignment, booking } = loaded;
  if (assignment.status !== 'ACCEPTED') {
    return res.status(409).json({ error: 'Accept the job before updating its checklist' });
  }
  const parsed = checklistSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid checklist state', details: parsed.error.flatten() });
  }
  const doneIds = [...new Set(parsed.data.doneIds)];
  addBookingEvent(booking, 'FIELD_CHECKLIST_UPDATED', req.user.email, {
    assignmentId: assignment.id,
    doneIds,
    confirmedBy: 'TECHNICIAN',
  });
  booking.updatedAt = new Date().toISOString();
  await persistBooking(booking);
  appendEvent('FIELD_CHECKLIST_UPDATED', {
    source: 'TECH_APP',
    actor: req.user.email,
    entityType: 'BOOKING',
    entityId: booking.id,
    referenceCode: booking.referenceCode,
    details: { doneCount: doneIds.length },
  });
  return res.json({ data: { checklist: fieldChecklist(booking) } });
});

const techNoteSchema = z.object({
  text: z.string().trim().min(3).max(2000),
});

router.post('/provider/assignments/:id/notes', ...providerOnly, async (req, res) => {
  const loaded = loadMyAssignment(req, res);
  if (!loaded) return;
  const { assignment, booking } = loaded;
  if (assignment.status !== 'ACCEPTED') {
    return res.status(409).json({ error: 'Accept the job before adding notes' });
  }
  const parsed = techNoteSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid note', details: parsed.error.flatten() });
  }
  addBookingEvent(booking, 'TECH_NOTE', req.user.email, {
    assignmentId: assignment.id,
    note: parsed.data.text,
    partsUsed: [],
    nextStep: null,
    statusSuggestion: 'NONE',
    structuredBy: 'MANUAL',
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
    details: { statusSuggestion: 'NONE' },
  });
  return res.status(201).json({ data: { saved: true, notes: workspaceNotes(booking) } });
});

/* ------------- Appliance Plug inside the workspace (Speedy Pro) -------------
 * One flow, bound to the open work order: snap the model plate →
 * Speedy transcribes it (the tech confirms every field) → Parts Finder
 * returns part CATEGORIES with fitment / verify-first notes → selected
 * categories become an order draft that carries the booking's TS
 * reference. Orders live on the booking record (audited history, the
 * same persistence as the checklist), routed Appliance Plus Parts
 * Supply first (a Parts Supply OS draft) and Other distributor second.
 * Statuses advance one tap at a time — DRAFT → SENT_TO_PARTS_SUPPLY_OS
 * → ORDERED → RECEIVED — and never on their own. No OEM part numbers
 * or prices exist anywhere in this flow: Parts Supply OS confirms the
 * exact part and price at order time.
 */
const PLUG_ORDER_FLOW = ['DRAFT', 'SENT_TO_PARTS_SUPPLY_OS', 'ORDERED', 'RECEIVED'];
const PLUG_VENDORS = ['APPLIANCE_PLUS_PARTS_SUPPLY', 'OTHER_DISTRIBUTOR'];

function plugOrders(booking) {
  const byId = new Map();
  for (const event of booking.history || []) {
    if (event.type === 'PLUG_ORDER_CREATED' && event.order && event.order.id) {
      byId.set(event.order.id, { ...event.order });
    }
    if (event.type === 'PLUG_ORDER_STATUS' && event.orderId && byId.has(event.orderId)) {
      const order = byId.get(event.orderId);
      order.status = event.status;
      order.updatedAt = event.at || order.updatedAt;
    }
  }
  return [...byId.values()].reverse();
}

function requireAccepted(res, assignment) {
  if (assignment.status !== 'ACCEPTED') {
    res.status(409).json({ error: 'Accept the job before working its parts flow' });
    return false;
  }
  return true;
}

const plateReadSchema = z.object({
  imageDataUrl: z.string().trim().min(32).max(12000000),
});

router.post('/provider/assignments/:id/plate-read', ...providerOnly, async (req, res) => {
  const loaded = loadMyAssignment(req, res);
  if (!loaded) return;
  if (!requireAccepted(res, loaded.assignment)) return;
  if (!speedyStatus().configured) {
    return res.status(503).json({ error: 'Speedy is not configured yet — enter the plate details by hand' });
  }
  const parsed = plateReadSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid plate photo', details: parsed.error.flatten() });
  }
  try {
    const plate = await speedyExtractModelPlate(parsed.data.imageDataUrl);
    return res.json({ data: { plate } });
  } catch (error) {
    return res.status(502).json({ error: 'Speedy could not read that plate — retake the photo or enter the details by hand', detail: String(error?.message || error) });
  }
});

const partsFinderSchema = z.object({
  brand: z.string().trim().max(80).optional(),
  model: z.string().trim().max(80).optional(),
  applianceType: z.string().trim().max(80).optional(),
});

router.post('/provider/assignments/:id/parts-finder', ...providerOnly, async (req, res) => {
  const loaded = loadMyAssignment(req, res);
  if (!loaded) return;
  if (!requireAccepted(res, loaded.assignment)) return;
  if (!speedyStatus().configured) {
    return res.status(503).json({ error: 'Speedy is not configured yet' });
  }
  const parsed = partsFinderSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid parts finder request', details: parsed.error.flatten() });
  }
  try {
    const result = await speedyPartsFinder({
      brand: parsed.data.brand || null,
      model: parsed.data.model || null,
      applianceType: parsed.data.applianceType || loaded.booking.appliance || null,
      issue: loaded.booking.issue || null,
    });
    return res.json({ data: { candidates: result.candidates || [] } });
  } catch (error) {
    return res.status(502).json({ error: 'Speedy Parts Finder could not answer just now — try again', detail: String(error?.message || error) });
  }
});

const partsOrderSchema = z.object({
  vendor: z.enum(PLUG_VENDORS),
  urgency: z.enum(['STANDARD', 'SAME_DAY', 'EMERGENCY']).optional(),
  appliance: z.object({
    brand: z.string().trim().max(80).nullable().optional(),
    model: z.string().trim().max(80).nullable().optional(),
    serial: z.string().trim().max(80).nullable().optional(),
    applianceType: z.string().trim().max(80).nullable().optional(),
  }).optional(),
  lines: z.array(z.object({
    category: z.string().trim().min(2).max(120),
    qty: z.number().int().min(1).max(999),
    fitmentNotes: z.string().trim().max(300).nullable().optional(),
  })).min(1).max(20),
});

router.post('/provider/assignments/:id/parts-orders', ...providerOnly, async (req, res) => {
  const loaded = loadMyAssignment(req, res);
  if (!loaded) return;
  const { assignment, booking } = loaded;
  if (!requireAccepted(res, assignment)) return;
  const parsed = partsOrderSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid parts order', details: parsed.error.flatten() });
  }
  const t = new Date().toISOString();
  const order = {
    id: createId(),
    reference: `${booking.referenceCode || 'JOB'}-P${plugOrders(booking).length + 1}`,
    bookingReference: booking.referenceCode || null,
    assignmentId: assignment.id,
    vendor: parsed.data.vendor,
    urgency: parsed.data.urgency || 'STANDARD',
    status: 'DRAFT',
    appliance: {
      brand: parsed.data.appliance?.brand || null,
      model: parsed.data.appliance?.model || null,
      serial: parsed.data.appliance?.serial || null,
      applianceType: parsed.data.appliance?.applianceType || booking.appliance || null,
    },
    lines: parsed.data.lines.map((line) => ({
      category: line.category,
      qty: line.qty,
      fitmentNotes: line.fitmentNotes || null,
    })),
    createdBy: req.user.email,
    createdAt: t,
    updatedAt: t,
  };
  addBookingEvent(booking, 'PLUG_ORDER_CREATED', req.user.email, {
    assignmentId: assignment.id,
    orderId: order.id,
    order,
    confirmedBy: 'TECHNICIAN',
  });
  booking.updatedAt = t;
  await persistBooking(booking);
  appendEvent('PLUG_ORDER_CREATED', {
    source: 'TECH_APP',
    actor: req.user.email,
    entityType: 'BOOKING',
    entityId: booking.id,
    referenceCode: booking.referenceCode,
    details: { orderId: order.id, vendor: order.vendor, lineCount: order.lines.length },
  });
  return res.status(201).json({ data: { order } });
});

const partsOrderStatusSchema = z.object({
  status: z.enum(PLUG_ORDER_FLOW),
});

router.post('/provider/assignments/:id/parts-orders/:orderId/status', ...providerOnly, async (req, res) => {
  const loaded = loadMyAssignment(req, res);
  if (!loaded) return;
  const { assignment, booking } = loaded;
  if (!requireAccepted(res, assignment)) return;
  const parsed = partsOrderStatusSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid order status', details: parsed.error.flatten() });
  }
  const order = plugOrders(booking).find((o) => o.id === req.params.orderId);
  if (!order) return res.status(404).json({ error: 'Parts order not found' });
  const next = PLUG_ORDER_FLOW[PLUG_ORDER_FLOW.indexOf(order.status) + 1];
  if (parsed.data.status !== next) {
    return res.status(409).json({
      error: next
        ? `Order is ${order.status}; the next step is ${next}`
        : `Order is ${order.status} — the flow is complete`,
    });
  }
  const t = new Date().toISOString();
  addBookingEvent(booking, 'PLUG_ORDER_STATUS', req.user.email, {
    assignmentId: assignment.id,
    orderId: order.id,
    status: parsed.data.status,
    confirmedBy: 'TECHNICIAN',
  });
  booking.updatedAt = t;
  await persistBooking(booking);
  appendEvent('PLUG_ORDER_STATUS', {
    source: 'TECH_APP',
    actor: req.user.email,
    entityType: 'BOOKING',
    entityId: booking.id,
    referenceCode: booking.referenceCode,
    details: { orderId: order.id, status: parsed.data.status },
  });
  if (parsed.data.status === 'SENT_TO_PARTS_SUPPLY_OS') {
    emitReport({
      department: 'parts',
      type: 'PLUG_ORDER_SENT',
      title: `Parts order ${order.reference} sent to Parts Supply OS`,
      detail: {
        orderId: order.id,
        reference: order.reference,
        bookingReference: booking.referenceCode || null,
        vendor: order.vendor,
        urgency: order.urgency,
        lines: order.lines.map((line) => ({ category: line.category, qty: line.qty })),
        appliance: order.appliance,
        sentBy: req.user.email,
      },
      source: 'TECH_APP',
      reference: order.reference,
      eventKey: `plug-order:${order.id}:sent:report`,
    });
  }
  return res.json({ data: { order: plugOrders(booking).find((o) => o.id === order.id) } });
});

router.get('/provider/parts-orders', ...providerOnly, (req, res) => {
  const provider = myProvider(req);
  if (!provider) return noProvider(res);
  const mine = [];
  for (const assignment of store.dispatchAssignments.values()) {
    if (assignment.providerId !== provider.id) continue;
    const booking = store.bookings.get(assignment.bookingId);
    if (!booking) continue;
    for (const order of plugOrders(booking)) {
      mine.push({ ...order, assignmentId: assignment.id, bookingReference: booking.referenceCode || null });
    }
  }
  mine.sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt)));
  return res.json({ data: { orders: mine } });
});
