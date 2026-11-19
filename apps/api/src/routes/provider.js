import { Router } from 'express';
import { z } from 'zod';
import { addBookingEvent, appendEvent, createId, store } from '../data/store.js';
import { persistAssignment, persistBooking } from '../db/bookingsRepo.js';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { ROLES } from '../config/security.js';
import { windowById } from '../services/bookos.js';
import { notifyReviewRequest, notifyTechEnRoute, notifyTrackingUpdate } from '../services/notifications.js';
import { persistPartUsage, persistVanStock } from '../db/partsRepo.js';
import { issueReferralForBooking } from '../services/flywheel.js';
import { advanceReferralOnCompletion } from '../services/referrals.js';
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

/**
 * Oversight viewers (Rule Zero fix, 2026-11-18): the owner hit "Live
 * jobs unavailable: Insufficient role" in the Tech App because the
 * jobs board required a provider role and COMPANY_OWNER was not in
 * the set. The Master can never be locked out of a surface, and the
 * standing access rules give staff every platform access point — so
 * the READ side of the jobs board (me, assignments list, workspace
 * view, parts orders, van stock) also admits COMPANY_OWNER and
 * COMPANY_ADMIN as OVERSIGHT viewers: they load and view the whole
 * live board across providers. Job WORKFLOW actions (accept, decline,
 * job-status, diagnosis, estimates, photos, completion — every POST /
 * PUT below) stay on providerOnly and stay bound to the assigned
 * provider account: oversight is a viewing right, not a way to work
 * another provider's job.
 */
const OVERSIGHT_ROLES = [ROLES.COMPANY_OWNER, ROLES.COMPANY_ADMIN, ROLES.PLATFORM_ADMIN];
const providerBoard = [
  authenticate,
  requireCompany,
  requireRole(
    ROLES.PROVIDER_OWNER,
    ROLES.PROVIDER_TECH,
    ROLES.TECHNICIAN,
    ...OVERSIGHT_ROLES,
  ),
];

function myProvider(req) {
  return store.providers.find((provider) => provider.companyId === req.user.companyId) || null;
}

function isOversightViewer(req) {
  return (req.user?.roles || []).some((role) => OVERSIGHT_ROLES.includes(role));
}

function providerNameById(providerId) {
  const provider = store.providers.find((p) => p.id === providerId);
  return provider ? provider.businessName : null;
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

function jobFlags(booking) {
  // Tech Pro field states (2026-11-17): the latest word on each waiting
  // state, read off the job's event history — a later progress event
  // (work started, diagnosis started, a new stage) clears a wait.
  const flags = { workStarted: false, awaitingParts: false, awaitingDiagnosis: false };
  if (!booking) return flags;
  for (const event of booking.history || []) {
    if (event.type === 'TECH_WORK_STARTED') { flags.workStarted = true; flags.awaitingParts = false; flags.awaitingDiagnosis = false; }
    if (event.type === 'JOB_AWAITING_PARTS') flags.awaitingParts = true;
    if (event.type === 'JOB_AWAITING_DIAGNOSIS') flags.awaitingDiagnosis = true;
    if (event.type === 'DIAGNOSIS_STARTED' || event.type === 'DIAGNOSIS_RECORDED') flags.awaitingDiagnosis = false;
    if (event.type === 'PART_USED_FROM_VAN' || event.type === 'PLUG_ORDER_CREATED') flags.awaitingParts = false;
  }
  return flags;
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
    jobFlags: jobFlags(booking),
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

router.get('/provider/me', ...providerBoard, (req, res) => {
  const provider = myProvider(req);
  if (provider) return res.json({ data: { provider } });
  // No provider record of their own: an oversight viewer (owner /
  // company admin) still gets a 200 with an explicit oversight marker
  // so the Tech App lands them on the jobs board instead of an error.
  if (isOversightViewer(req)) {
    return res.json({ data: { provider: null, oversight: true } });
  }
  return noProvider(res);
});

router.get('/provider/assignments', ...providerBoard, (req, res) => {
  const provider = myProvider(req);
  if (provider) {
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
  }
  if (isOversightViewer(req)) {
    // The whole live board: every provider's assignments, each one
    // annotated with the provider it belongs to.
    const all = [...store.dispatchAssignments.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((assignment) => ({
        ...publicAssignment(assignment),
        providerId: assignment.providerId,
        providerBusinessName: providerNameById(assignment.providerId),
      }));
    return res.json({
      data: { provider: null, oversight: true, assignments: all },
    });
  }
  return noProvider(res);
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
  action: z.enum(['EN_ROUTE', 'ARRIVED', 'DIAGNOSIS_STARTED', 'ESTIMATE_APPROVED', 'WORK_STARTED', 'AWAITING_PARTS', 'AWAITING_DIAGNOSIS']),
  etaMinutes: z.number().int().min(1).max(600).optional(),
});
const JOB_EVENT_TYPES = {
  EN_ROUTE: 'TECH_EN_ROUTE',
  ARRIVED: 'TECH_ARRIVED',
  DIAGNOSIS_STARTED: 'DIAGNOSIS_STARTED',
  ESTIMATE_APPROVED: 'ESTIMATE_APPROVED',
  // Tech Pro field states (2026-11-17, from the Top Speed Tech Pro
  // guide's job-status module): the repair itself in progress, and the
  // two honest waiting states. They record on the job's history like
  // every other stage; the customer's 8-stage timeline keeps reading
  // the stages it already knows.
  WORK_STARTED: 'TECH_WORK_STARTED',
  AWAITING_PARTS: 'JOB_AWAITING_PARTS',
  AWAITING_DIAGNOSIS: 'JOB_AWAITING_DIAGNOSIS',
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
  } else if (['ARRIVED', 'DIAGNOSIS_STARTED', 'ESTIMATE_APPROVED'].includes(parsed.data.action)) {
    notifyTrackingUpdate(booking, computeTracking(booking).stageLabel8, 'TECH_APP', `booking:${booking.id}:stage:${type}:${booking.updatedAt}`);
  }
  // WORK_STARTED / AWAITING_* are field states: they land on the job
  // record and the office report above, but the customer's tracking
  // stage has not moved, so no customer notification is queued.
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

/* ------------- Tech Pro field record (2026-11-17) -------------
 * The Top Speed Tech Pro guide's modules that the workspace did not
 * have yet — structured diagnosis, the field estimate with its
 * authorization log, categorized repair photos, external receipts and
 * the close-out quality gate — all ride the booking's history, the
 * platform's audit trail, in exactly the pattern the checklist, notes
 * and Plug orders already use. The read models below fold the events
 * back into current state; the write routes live at the end of this
 * file. Pricing is computed server-side from the real Launch Pack
 * structure only — the client never sets a total.
 */
function latestDiagnosis(booking) {
  let found = null;
  for (const event of booking.history || []) {
    if (event.type === 'DIAGNOSIS_RECORDED' && event.diagnosis) found = event.diagnosis;
  }
  return found;
}

function diagnosisComplete(booking) {
  const d = latestDiagnosis(booking);
  return Boolean(d && d.confirmedFault && d.recommendedRepair);
}

function latestEstimate(booking) {
  let found = null;
  for (const event of booking.history || []) {
    if (event.type === 'ESTIMATE_SAVED' && event.estimate) found = event.estimate;
  }
  return found;
}

function authorizationLog(booking) {
  return (booking.history || [])
    .filter((event) => event.type === 'ESTIMATE_APPROVED')
    .map((event) => ({
      at: event.at || null,
      actor: event.actor || null,
      method: event.method || 'RECORDED_IN_APP',
      authorizedByName: event.authorizedByName || null,
      estimateId: event.estimateId || null,
      note: event.note || null,
    }))
    .reverse();
}

function jobPhotos(booking) {
  const byId = new Map();
  const removed = new Set();
  for (const event of booking.history || []) {
    if (event.type === 'JOB_PHOTO_ADDED' && event.photo && event.photo.id) byId.set(event.photo.id, event.photo);
    if (event.type === 'JOB_PHOTO_REMOVED' && event.photoId) removed.add(event.photoId);
  }
  return [...byId.values()].filter((photo) => !removed.has(photo.id)).slice(-60);
}

function jobReceipts(booking) {
  return (booking.history || [])
    .filter((event) => event.type === 'RECEIPT_RECORDED' && event.receipt)
    .map((event) => event.receipt)
    .reverse();
}

function jobPartsUsed(booking) {
  return (booking.history || [])
    .filter((event) => event.type === 'PART_USED_FROM_VAN')
    .map((event) => ({
      partId: event.partId,
      sku: event.sku || null,
      name: event.name || null,
      qty: event.qty,
      at: event.at || null,
      actor: event.actor || null,
    }))
    .reverse();
}

function workspaceView(assignment, booking) {
  const history = booking.history || [];
  const estimate = latestEstimate(booking);
  const receipts = jobReceipts(booking);
  const receiptsTotalCents = receipts.reduce((sum, r) => sum + (r.amountCents || 0), 0);
  const estimateTotalCents = estimate ? estimate.totalCents : null;
  const authorized = history.some((event) => event.type === 'ESTIMATE_APPROVED');
  const diagDone = diagnosisComplete(booking);
  return {
    assignment: publicAssignment(assignment),
    checklist: fieldChecklist(booking),
    notes: workspaceNotes(booking),
    stageEvents: history
      .filter((event) => STAGE_EVENT_TYPES.includes(event.type))
      .map((event) => ({ type: event.type, at: event.at || null })),
    estimateApproved: authorized,
    pricing: {
      segment: booking.segment || 'RESIDENTIAL',
      diagnosticFee: booking.diagnosticFee ?? 99,
      diagnosticFeeCreditedTowardRepair: booking.diagnosticFeeCreditedTowardRepair ?? true,
      feeStatus: booking.feeStatus || null,
    },
    completedAt: booking.completedAt || null,
    partsOrders: plugOrders(booking),
    // Tech Pro (2026-11-17): the field record.
    diagnosis: latestDiagnosis(booking),
    estimate,
    authorizationLog: authorizationLog(booking),
    photos: jobPhotos(booking),
    receipts,
    partsUsed: jobPartsUsed(booking),
    payments: {
      estimateTotalCents,
      receiptsTotalCents,
      // The balance is information, never a gate: the guide's rule is
      // that payment may remain outstanding and is tracked separately.
      balanceDueCents: estimateTotalCents == null ? null : Math.max(0, estimateTotalCents - receiptsTotalCents),
    },
    gate: {
      diagnosisRecorded: Boolean(latestDiagnosis(booking)),
      diagnosisComplete: diagDone,
      estimateAuthorized: authorized,
      canComplete: diagDone && authorized && booking.status !== 'COMPLETED',
    },
    activity: history
      .slice(-60)
      .map((event) => ({ type: event.type, at: event.at || null, actor: event.actor || null }))
      .reverse(),
  };
}

// Read-side loader for the workspace VIEW: the assigned provider
// loads their own job (same binding as loadMyAssignment); an
// oversight viewer (owner / company admin) may VIEW any job's
// workspace. Every write path keeps using loadMyAssignment, so the
// workflow binding is unchanged.
function loadAssignmentForView(req, res) {
  const provider = myProvider(req);
  const assignment = store.dispatchAssignments.get(req.params.id);
  if (provider) {
    if (!assignment || assignment.providerId !== provider.id) {
      res.status(404).json({ error: 'Assignment not found' });
      return null;
    }
  } else if (isOversightViewer(req)) {
    if (!assignment) {
      res.status(404).json({ error: 'Assignment not found' });
      return null;
    }
  } else {
    noProvider(res);
    return null;
  }
  const booking = store.bookings.get(assignment.bookingId);
  if (!booking) {
    res.status(404).json({ error: 'Booking not found' });
    return null;
  }
  return { provider, assignment, booking };
}

router.get('/provider/assignments/:id/workspace', ...providerBoard, (req, res) => {
  const loaded = loadAssignmentForView(req, res);
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

router.get('/provider/parts-orders', ...providerBoard, (req, res) => {
  const provider = myProvider(req);
  if (!provider && !isOversightViewer(req)) return noProvider(res);
  // Oversight viewers (no provider record of their own) see every
  // provider's orders, annotated with the owning provider's name.
  const mine = [];
  for (const assignment of store.dispatchAssignments.values()) {
    if (provider && assignment.providerId !== provider.id) continue;
    const booking = store.bookings.get(assignment.bookingId);
    if (!booking) continue;
    for (const order of plugOrders(booking)) {
      mine.push({
        ...order,
        assignmentId: assignment.id,
        bookingReference: booking.referenceCode || null,
        ...(provider ? {} : { providerId: assignment.providerId, providerBusinessName: providerNameById(assignment.providerId) }),
      });
    }
  }
  mine.sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt)));
  return res.json({ data: { orders: mine, ...(provider ? {} : { oversight: true }) } });
});

/* ================= Tech Pro field workflow (2026-11-17) =================
 * Built from Ramone's Top Speed Tech Pro product guide: structured
 * diagnosis, the field estimate + authorization log, categorized
 * repair photos, van stock, external receipts, and the close-out
 * quality gate. Everything writes onto the booking's audited history
 * (van stock has its own table — it is provider state, not job state)
 * and follows the workspace's existing rule: the technician confirms
 * every record; nothing here auto-dispatches, self-assigns, or moves
 * money. Completion NEVER waits on payment.
 */

const diagnosisSchema = z.object({
  applianceBrand: z.string().trim().max(80).nullable().optional(),
  model: z.string().trim().max(80).nullable().optional(),
  serial: z.string().trim().max(80).nullable().optional(),
  symptoms: z.string().trim().min(3).max(2000),
  confirmedFault: z.string().trim().min(3).max(1000),
  recommendedRepair: z.string().trim().min(3).max(1000),
  readings: z.array(z.object({
    label: z.string().trim().min(1).max(80),
    value: z.string().trim().min(1).max(120),
  })).max(20).optional(),
  testChecklist: z.array(z.object({
    id: z.string().trim().min(1).max(60),
    label: z.string().trim().min(1).max(160),
    done: z.boolean(),
  })).max(30).optional(),
  safetyConfirmed: z.boolean().optional(),
});

router.post('/provider/assignments/:id/diagnosis', ...providerOnly, async (req, res) => {
  const loaded = loadMyAssignment(req, res);
  if (!loaded) return;
  const { assignment, booking } = loaded;
  if (!requireAccepted(res, assignment)) return;
  const parsed = diagnosisSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid diagnosis record', details: parsed.error.flatten() });
  }
  const t = new Date().toISOString();
  const diagnosis = {
    applianceBrand: parsed.data.applianceBrand || null,
    model: parsed.data.model || null,
    serial: parsed.data.serial || null,
    symptoms: parsed.data.symptoms,
    confirmedFault: parsed.data.confirmedFault,
    recommendedRepair: parsed.data.recommendedRepair,
    readings: parsed.data.readings || [],
    testChecklist: parsed.data.testChecklist || [],
    safetyConfirmed: parsed.data.safetyConfirmed === true,
    recordedBy: req.user.email,
    recordedAt: t,
  };
  addBookingEvent(booking, 'DIAGNOSIS_RECORDED', req.user.email, {
    assignmentId: assignment.id,
    diagnosis,
    confirmedBy: 'TECHNICIAN',
  });
  booking.updatedAt = t;
  await persistBooking(booking);
  appendEvent('DIAGNOSIS_RECORDED', {
    source: 'TECH_APP',
    actor: req.user.email,
    entityType: 'BOOKING',
    entityId: booking.id,
    referenceCode: booking.referenceCode,
    details: { confirmedFault: diagnosis.confirmedFault },
  });
  return res.status(201).json({ data: { diagnosis } });
});

/* ---------------- Field estimate + authorization log ----------------
 * The estimate is the job's written quote, built from the real price
 * structure ONLY: $99 residential diagnostic (credited in full toward
 * an approved repair), $210 flat repair labor, $150 flat installation,
 * parts at the quoted per-line price. Commercial jobs carry no $99 —
 * their labor is the custom-quoted amount the tech enters. Tax is a
 * tech-entered rate applied to parts. The server computes the total;
 * the client can preview but never set it.
 */
const ESTIMATE_LABOR_CENTS = { REPAIR: 21000, INSTALLATION: 15000 };

const estimateSchema = z.object({
  kind: z.enum(['REPAIR', 'INSTALLATION']),
  laborCents: z.number().int().min(0).max(100000000).optional(),
  parts: z.array(z.object({
    description: z.string().trim().min(2).max(160),
    qty: z.number().int().min(1).max(999),
    unitPriceCents: z.number().int().min(0).max(100000000),
  })).max(30).optional(),
  discountCents: z.number().int().min(0).max(100000000).optional(),
  taxRatePercent: z.number().min(0).max(30).optional(),
  notes: z.string().trim().max(500).nullable().optional(),
});

function computeEstimate(booking, input) {
  const segment = booking.segment || 'RESIDENTIAL';
  const commercial = segment === 'COMMERCIAL';
  const diagnosticFeeCents = commercial ? 0 : Math.round(Number(booking.diagnosticFee ?? 99) * 100);
  const laborCents = commercial ? (input.laborCents ?? null) : ESTIMATE_LABOR_CENTS[input.kind];
  const parts = (input.parts || []).map((line) => ({
    description: line.description,
    qty: line.qty,
    unitPriceCents: line.unitPriceCents,
    lineTotalCents: line.qty * line.unitPriceCents,
  }));
  const partsSubtotalCents = parts.reduce((sum, line) => sum + line.lineTotalCents, 0);
  const taxRatePercent = input.taxRatePercent || 0;
  const taxCents = Math.round((partsSubtotalCents * taxRatePercent) / 100);
  const discountCents = input.discountCents || 0;
  // The $99 diagnostic is credited toward an approved REPAIR (Launch
  // Pack terms). It is not credited on a standalone installation, and
  // it never exists on a commercial job.
  const diagnosticCreditCents =
    !commercial && input.kind === 'REPAIR' && booking.diagnosticFeeCreditedTowardRepair !== false
      ? diagnosticFeeCents
      : 0;
  const totalCents = Math.max(
    0,
    (laborCents || 0) + partsSubtotalCents + taxCents - discountCents - diagnosticCreditCents,
  );
  return {
    segment,
    kind: input.kind,
    diagnosticFeeCents,
    diagnosticCreditCents,
    laborCents,
    parts,
    partsSubtotalCents,
    taxRatePercent,
    taxCents,
    discountCents,
    totalCents,
    notes: input.notes || null,
  };
}

router.post('/provider/assignments/:id/estimate', ...providerOnly, async (req, res) => {
  const loaded = loadMyAssignment(req, res);
  if (!loaded) return;
  const { assignment, booking } = loaded;
  if (!requireAccepted(res, assignment)) return;
  const parsed = estimateSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid estimate', details: parsed.error.flatten() });
  }
  const computed = computeEstimate(booking, parsed.data);
  if (computed.segment === 'COMMERCIAL' && computed.laborCents == null) {
    return res.status(400).json({ error: 'Commercial jobs are priced by custom quote — enter the quoted labor amount' });
  }
  const t = new Date().toISOString();
  const prior = (booking.history || []).filter((e) => e.type === 'ESTIMATE_SAVED').length;
  const estimate = {
    id: createId(),
    version: prior + 1,
    ...computed,
    createdBy: req.user.email,
    createdAt: t,
  };
  addBookingEvent(booking, 'ESTIMATE_SAVED', req.user.email, {
    assignmentId: assignment.id,
    estimate,
    confirmedBy: 'TECHNICIAN',
  });
  booking.updatedAt = t;
  await persistBooking(booking);
  appendEvent('ESTIMATE_SAVED', {
    source: 'TECH_APP',
    actor: req.user.email,
    entityType: 'BOOKING',
    entityId: booking.id,
    referenceCode: booking.referenceCode,
    details: { estimateId: estimate.id, version: estimate.version, totalCents: estimate.totalCents },
  });
  return res.status(201).json({ data: { estimate } });
});

const authorizeSchema = z.object({
  method: z.enum(['IN_PERSON_VERBAL', 'SIGNATURE_ON_DEVICE', 'PHONE', 'TEXT', 'EMAIL', 'OTHER']),
  authorizedByName: z.string().trim().max(120).nullable().optional(),
  note: z.string().trim().max(300).nullable().optional(),
});

router.post('/provider/assignments/:id/estimate/authorize', ...providerOnly, async (req, res) => {
  const loaded = loadMyAssignment(req, res);
  if (!loaded) return;
  const { assignment, booking } = loaded;
  if (!requireAccepted(res, assignment)) return;
  const parsed = authorizeSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid authorization record', details: parsed.error.flatten() });
  }
  const estimate = latestEstimate(booking);
  if (!estimate) {
    return res.status(409).json({ error: 'Save the estimate first — an authorization must attach to a written quote' });
  }
  const t = new Date().toISOString();
  // Same ESTIMATE_APPROVED event the tracking timeline and the Quote
  // tab already read — now carrying the authorization log details
  // (method, who authorized, when) the guide requires.
  addBookingEvent(booking, 'ESTIMATE_APPROVED', req.user.email, {
    assignmentId: assignment.id,
    estimateId: estimate.id,
    method: parsed.data.method,
    authorizedByName: parsed.data.authorizedByName || null,
    note: parsed.data.note || null,
    confirmedBy: 'TECHNICIAN',
  });
  booking.updatedAt = t;
  await persistBooking(booking);
  appendEvent('ESTIMATE_APPROVED', {
    source: 'TECH_APP',
    actor: req.user.email,
    entityType: 'BOOKING',
    entityId: booking.id,
    referenceCode: booking.referenceCode,
    details: { estimateId: estimate.id, method: parsed.data.method },
  });
  notifyTrackingUpdate(booking, computeTracking(booking).stageLabel8, 'TECH_APP', `booking:${booking.id}:stage:ESTIMATE_APPROVED:${t}`);
  return res.status(201).json({ data: { authorizationLog: authorizationLog(booking) } });
});

/* ---------------- Repair photos (before / during / after) ---------------- */
const photoSchema = z.object({
  category: z.enum(['BEFORE', 'DURING', 'AFTER']),
  dataUrl: z.string().trim().min(32).max(12000000),
  caption: z.string().trim().max(200).nullable().optional(),
});

router.post('/provider/assignments/:id/photos', ...providerOnly, async (req, res) => {
  const loaded = loadMyAssignment(req, res);
  if (!loaded) return;
  const { assignment, booking } = loaded;
  if (!requireAccepted(res, assignment)) return;
  const parsed = photoSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid photo', details: parsed.error.flatten() });
  }
  if (!/^data:image\/(jpeg|jpg|png|webp);base64,/.test(parsed.data.dataUrl)) {
    return res.status(400).json({ error: 'Photo must be a JPEG, PNG or WebP image' });
  }
  const t = new Date().toISOString();
  const photo = {
    id: createId(),
    category: parsed.data.category,
    dataUrl: parsed.data.dataUrl,
    caption: parsed.data.caption || null,
    at: t,
    by: req.user.email,
  };
  addBookingEvent(booking, 'JOB_PHOTO_ADDED', req.user.email, {
    assignmentId: assignment.id,
    photo,
    confirmedBy: 'TECHNICIAN',
  });
  booking.updatedAt = t;
  await persistBooking(booking);
  appendEvent('JOB_PHOTO_ADDED', {
    source: 'TECH_APP',
    actor: req.user.email,
    entityType: 'BOOKING',
    entityId: booking.id,
    referenceCode: booking.referenceCode,
    details: { photoId: photo.id, category: photo.category },
  });
  return res.status(201).json({ data: { photo: { ...photo, dataUrl: undefined }, photos: jobPhotos(booking).map((p) => ({ ...p })) } });
});

router.post('/provider/assignments/:id/photos/:photoId/remove', ...providerOnly, async (req, res) => {
  const loaded = loadMyAssignment(req, res);
  if (!loaded) return;
  const { assignment, booking } = loaded;
  if (!requireAccepted(res, assignment)) return;
  const photo = jobPhotos(booking).find((p) => p.id === req.params.photoId);
  if (!photo) return res.status(404).json({ error: 'Photo not found' });
  const t = new Date().toISOString();
  addBookingEvent(booking, 'JOB_PHOTO_REMOVED', req.user.email, {
    assignmentId: assignment.id,
    photoId: photo.id,
    confirmedBy: 'TECHNICIAN',
  });
  booking.updatedAt = t;
  await persistBooking(booking);
  return res.json({ data: { photos: jobPhotos(booking) } });
});

/* ---------------- Van stock + allocate to job ---------------- */
function vanStockView(providerId) {
  return (store.vanStock || [])
    .filter((entry) => entry.providerId === providerId)
    .map((entry) => {
      const part = store.parts.find((p) => p.id === entry.partId);
      return {
        id: entry.id,
        partId: entry.partId,
        sku: part ? part.sku : null,
        name: part ? part.name : null,
        category: part ? part.category : null,
        brand: part ? part.brand : null,
        sellPriceCents: part ? part.sellPriceCents ?? null : null,
        qty: entry.qty,
        updatedAt: entry.updatedAt,
      };
    })
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
}

router.get('/provider/van-stock', ...providerBoard, (req, res) => {
  const provider = myProvider(req);
  if (!provider && !isOversightViewer(req)) return noProvider(res);
  const catalog = store.parts
    .filter((part) => part.active !== false)
    .map((part) => ({
      id: part.id,
      sku: part.sku,
      name: part.name,
      category: part.category,
      brand: part.brand || null,
      sellPriceCents: part.sellPriceCents ?? null,
      stockOnHand: part.stockOnHand || 0,
    }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  if (provider) {
    return res.json({ data: { items: vanStockView(provider.id), catalog } });
  }
  // Oversight: every provider's van stock, annotated per provider.
  const items = [];
  for (const p of store.providers) {
    for (const item of vanStockView(p.id)) {
      items.push({ ...item, providerId: p.id, providerBusinessName: p.businessName });
    }
  }
  return res.json({ data: { items, catalog, oversight: true } });
});

const vanStockSetSchema = z.object({
  partId: z.string().uuid(),
  qty: z.number().int().min(0).max(100000),
});

router.post('/provider/van-stock', ...providerOnly, async (req, res) => {
  const provider = myProvider(req);
  if (!provider) return noProvider(res);
  const parsed = vanStockSetSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid van stock update', details: parsed.error.flatten() });
  }
  const part = store.parts.find((p) => p.id === parsed.data.partId);
  if (!part) return res.status(404).json({ error: 'Part not found in the Parts Supply OS catalog' });
  const t = new Date().toISOString();
  let entry = (store.vanStock || []).find((e) => e.providerId === provider.id && e.partId === part.id);
  if (!entry) {
    entry = { id: createId(), providerId: provider.id, partId: part.id, qty: 0, createdAt: t, updatedAt: t };
    store.vanStock.push(entry);
  }
  entry.qty = parsed.data.qty;
  entry.updatedAt = t;
  await persistVanStock(entry);
  appendEvent('VAN_STOCK_UPDATED', {
    source: 'TECH_APP',
    actor: req.user.email,
    entityType: 'PROVIDER',
    entityId: provider.id,
    details: { partId: part.id, sku: part.sku, qty: entry.qty },
  });
  return res.json({ data: { items: vanStockView(provider.id) } });
});

const partsUsedSchema = z.object({
  partId: z.string().uuid(),
  qty: z.number().int().min(1).max(999),
});

router.post('/provider/assignments/:id/parts-used', ...providerOnly, async (req, res) => {
  const loaded = loadMyAssignment(req, res);
  if (!loaded) return;
  const { provider, assignment, booking } = loaded;
  if (!requireAccepted(res, assignment)) return;
  const parsed = partsUsedSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid parts-used record', details: parsed.error.flatten() });
  }
  const part = store.parts.find((p) => p.id === parsed.data.partId);
  if (!part) return res.status(404).json({ error: 'Part not found in the Parts Supply OS catalog' });
  const entry = (store.vanStock || []).find((e) => e.providerId === provider.id && e.partId === part.id);
  if (!entry || entry.qty < parsed.data.qty) {
    return res.status(409).json({
      error: `Only ${entry ? entry.qty : 0} on the van — record what you actually have before allocating it to the job`,
    });
  }
  const t = new Date().toISOString();
  entry.qty -= parsed.data.qty;
  entry.updatedAt = t;
  await persistVanStock(entry);
  const usage = {
    id: createId(),
    bookingReference: booking.referenceCode || booking.id,
    partId: part.id,
    qty: parsed.data.qty,
    unitCostCents: part.unitCostCents || 0,
    recordedBy: req.user.email,
    createdAt: t,
  };
  store.partUsages.push(usage);
  await persistPartUsage(usage);
  addBookingEvent(booking, 'PART_USED_FROM_VAN', req.user.email, {
    assignmentId: assignment.id,
    partId: part.id,
    sku: part.sku,
    name: part.name,
    qty: parsed.data.qty,
    confirmedBy: 'TECHNICIAN',
  });
  booking.updatedAt = t;
  await persistBooking(booking);
  appendEvent('PART_USED_FROM_VAN', {
    source: 'TECH_APP',
    actor: req.user.email,
    entityType: 'BOOKING',
    entityId: booking.id,
    referenceCode: booking.referenceCode,
    details: { partId: part.id, sku: part.sku, qty: parsed.data.qty },
  });
  return res.status(201).json({ data: { partsUsed: jobPartsUsed(booking), vanStock: vanStockView(provider.id) } });
});

/* ---------------- External receipts (money taken outside the app) ----------------
 * Field money that never touches the platform's Stripe: cash, check,
 * or a payment the customer made through an external channel. The app
 * records THAT it was received, by whom, and how — it never collects
 * or stores card numbers (the guide's data-safety rule).
 */
const receiptSchema = z.object({
  method: z.enum(['CASH', 'CHECK', 'CARD_EXTERNAL', 'ZELLE', 'VENMO', 'OTHER']),
  amountCents: z.number().int().min(1).max(100000000),
  note: z.string().trim().max(300).nullable().optional(),
});

router.post('/provider/assignments/:id/receipts', ...providerOnly, async (req, res) => {
  const loaded = loadMyAssignment(req, res);
  if (!loaded) return;
  const { assignment, booking } = loaded;
  if (!requireAccepted(res, assignment)) return;
  const parsed = receiptSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid receipt', details: parsed.error.flatten() });
  }
  const t = new Date().toISOString();
  const receipt = {
    id: createId(),
    method: parsed.data.method,
    amountCents: parsed.data.amountCents,
    note: parsed.data.note || null,
    at: t,
    recordedBy: req.user.email,
  };
  addBookingEvent(booking, 'RECEIPT_RECORDED', req.user.email, {
    assignmentId: assignment.id,
    receipt,
    confirmedBy: 'TECHNICIAN',
  });
  booking.updatedAt = t;
  await persistBooking(booking);
  appendEvent('RECEIPT_RECORDED', {
    source: 'TECH_APP',
    actor: req.user.email,
    entityType: 'BOOKING',
    entityId: booking.id,
    referenceCode: booking.referenceCode,
    details: { receiptId: receipt.id, method: receipt.method, amountCents: receipt.amountCents },
  });
  const receipts = jobReceipts(booking);
  const estimate = latestEstimate(booking);
  const receiptsTotalCents = receipts.reduce((sum, r) => sum + (r.amountCents || 0), 0);
  return res.status(201).json({
    data: {
      receipt,
      receipts,
      payments: {
        estimateTotalCents: estimate ? estimate.totalCents : null,
        receiptsTotalCents,
        balanceDueCents: estimate ? Math.max(0, estimate.totalCents - receiptsTotalCents) : null,
      },
    },
  });
});

/* ---------------- Close-out: the Tech Pro quality gate ----------------
 * The guide's signature rule, enforced server-side: a job may be
 * marked Completed ONLY when (1) a confirmed diagnosis with a
 * recommended repair is on the record, and (2) a recorded estimate
 * authorization exists. Payment is NOT part of the gate — an
 * outstanding balance is tracked separately and never blocks closing.
 * On completion the same flywheel effects as the office completion
 * fire (review request + the customer's referral code).
 */
const completeJobSchema = z.object({
  notes: z.string().trim().max(1000).nullable().optional(),
});

router.post('/provider/assignments/:id/complete', ...providerOnly, async (req, res) => {
  const loaded = loadMyAssignment(req, res);
  if (!loaded) return;
  const { assignment, booking } = loaded;
  if (!requireAccepted(res, assignment)) return;
  const parsed = completeJobSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid completion request', details: parsed.error.flatten() });
  }
  if (booking.status === 'COMPLETED') {
    return res.status(409).json({ error: 'Booking is already completed' });
  }
  const missing = [];
  if (!diagnosisComplete(booking)) missing.push('CONFIRMED_DIAGNOSIS');
  if (!authorizationLog(booking).length) missing.push('ESTIMATE_AUTHORIZATION');
  if (missing.length) {
    return res.status(409).json({
      error: 'Quality gate: this job cannot close yet — a completed job requires a confirmed diagnosis with a recommended repair, and a recorded estimate authorization. Payment is not required to close.',
      missing,
    });
  }
  const t = new Date().toISOString();
  booking.status = 'COMPLETED';
  booking.completedAt = t;
  booking.completedBy = req.user.email;
  booking.updatedAt = t;
  addBookingEvent(booking, 'JOB_COMPLETED', req.user.email, {
    assignmentId: assignment.id,
    notes: parsed.data.notes || null,
    gate: { diagnosis: true, authorization: true },
    confirmedBy: 'TECHNICIAN',
  });
  appendEvent('JOB_COMPLETED', {
    source: 'TECH_APP',
    actor: req.user.email,
    entityType: 'BOOKING',
    entityId: booking.id,
    referenceCode: booking.referenceCode || null,
    details: { status: booking.status },
  });
  emitReport({
    department: 'field',
    type: 'JOB_COMPLETED',
    title: `Job completed — ${booking.referenceCode || booking.id}`,
    detail: { bookingId: booking.id, bookingReference: booking.referenceCode || null, customerName: booking.customer?.name || null, service: booking.appliance || null, city: booking.city || null, completedBy: req.user.email, completedAt: t, notes: parsed.data.notes || null },
    source: 'TECH_APP',
    reference: booking.referenceCode || null,
    eventKey: `booking:${booking.id}:completed:report`,
  });
  const reviewRequests = notifyReviewRequest(booking, 'TECH_APP');
  const { referral, created: referralCreated } = issueReferralForBooking(booking, 'TECH_APP');
  try {
    await advanceReferralOnCompletion(booking, 'TECH_APP');
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', message: 'referral completion advance failed', error: String(error?.message || error) }));
  }
  await persistBooking(booking);
  return res.json({
    data: {
      completed: true,
      referenceCode: booking.referenceCode || null,
      completedAt: t,
      notificationsQueued: reviewRequests.map((entry) => ({ id: entry.id, channel: entry.channel, template: entry.template, to: entry.to })),
      referral: { code: referral.code, created: referralCreated },
    },
  });
});
