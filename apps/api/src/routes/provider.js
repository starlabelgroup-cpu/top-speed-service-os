import { Router } from 'express';
import { z } from 'zod';
import { addBookingEvent, appendEvent, createId, PLATFORM_COMPANY_ID, store } from '../data/store.js';
import { persistAssignment, persistBooking, persistCustomer, persistProvider } from '../db/bookingsRepo.js';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { ROLES } from '../config/security.js';
import { windowById } from '../services/bookos.js';
import { notifyReviewRequest, notifyTechEnRoute, notifyTrackingUpdate } from '../services/notifications.js';
import { persistPartUsage, persistVanStock } from '../db/partsRepo.js';
import { persistInvoice, persistProperty, persistWarranty, persistWarrantyClaim } from '../db/techPackageRepo.js';
import { PLATFORM_CONSTANTS } from '../config/platform.js';
import { searchKnowledge } from '../knowledge/index.js';
import { speedyKnowledgeSections } from '../services/speedyKnowledge.js';
import { issueReferralForBooking } from '../services/flywheel.js';
import { advanceReferralOnCompletion } from '../services/referrals.js';
import { emitReport } from '../services/managementReports.js';
import { computeTracking } from '../services/tracking.js';
import { speedyDraftDiagnosis, speedyExtractModelPlate, speedyPartsFinder, speedyStatus, speedyStructureNote } from '../services/speedy.js';
import {
  authorizeEstimateForJob,
  authorizeSchema,
  estimateDecisionSchema,
  estimateSchema,
  generateInvoiceForJob,
  invoiceMoney,
  latestEstimate,
  authorizationLog,
  estimateDecision,
  receiptSchema,
  recordEstimateDecisionForJob,
  recordReceiptForJob,
  saveEstimateForJob,
} from '../services/jobMoney.js';
import { createWorkOrder, findCustomersForCreate, workOrderCreateSchema } from '../services/workOrders.js';
import { db, DATABASE_ENABLED } from '../db/client.js';
import { catalogEntry, LINK_TYPES } from '../services/linkCenter.js';

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
  const own = store.providers.find((provider) => provider.companyId === req.user.companyId) || null;
  if (own) return own;
  // Two tech systems (2026-11-19): Top Speed's own technicians hold
  // accounts in the PLATFORM company (created in Work Time Access),
  // not in the Field Team's provider company — their crew record is
  // the company-crew provider. Oversight viewers are excluded: the
  // owner also sits in the platform company and must stay oversight,
  // never silently become the crew.
  if (
    req.user?.companyId === PLATFORM_COMPANY_ID &&
    !isOversightViewer(req) &&
    (req.user?.roles || []).some((role) => [ROLES.PROVIDER_OWNER, ROLES.PROVIDER_TECH, ROLES.TECHNICIAN].includes(role))
  ) {
    return store.providers.find((provider) => provider.companyCrew) || null;
  }
  return null;
}

/**
 * Which of the two tech systems this sign-in belongs to (2026-11-19):
 * COMPANY = Top Speed's own crew (the companyCrew provider), NETWORK =
 * an independent Service Network business, OVERSIGHT = owner/manager
 * viewing the whole board. The doors (/tech = Company Tech,
 * /tech-network = Network Tech) read this and land each account in
 * its own system, with a clear wrong-door message otherwise.
 */
function techSystemFor(req, provider) {
  if (isOversightViewer(req) && (!provider || provider.companyId !== req.user?.companyId)) return 'OVERSIGHT';
  if (!provider) return null;
  return provider.companyCrew ? 'COMPANY' : 'NETWORK';
}

function isOversightViewer(req) {
  return (req.user?.roles || []).some((role) => OVERSIGHT_ROLES.includes(role));
}

function providerNameById(providerId) {
  const provider = store.providers.find((p) => p.id === providerId);
  return provider ? provider.businessName : null;
}

function providerSystemById(providerId) {
  const provider = store.providers.find((p) => p.id === providerId);
  if (!provider) return null;
  return provider.companyCrew ? 'COMPANY' : 'NETWORK';
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
  if (provider) {
    const system = techSystemFor(req, provider);
    return res.json({ data: { provider, system, oversight: system === 'OVERSIGHT' } });
  }
  // No provider record of their own: an oversight viewer (owner /
  // company admin) still gets a 200 with an explicit oversight marker
  // so the Tech App lands them on the jobs board instead of an error.
  if (isOversightViewer(req)) {
    return res.json({ data: { provider: null, system: 'OVERSIGHT', oversight: true } });
  }
  return noProvider(res);
});

/* ================= Create flows + tech profile (2026-11-19) =================
 * Origination inside the Tech App (Directives 3 + 5 + 6): a tech
 * creates a work order (assigned to themselves, or released into the
 * Service Setters queue), looks customers up before creating so
 * repeat customers never duplicate, and maintains their own settings
 * — the same user/provider records the office sees in Work Time
 * Access. Money origination rides the job workspace endpoints above
 * (estimate / decision / invoice / receipts, services/jobMoney.js).
 */

router.post('/provider/work-orders', ...providerOnly, async (req, res) => {
  const provider = myProvider(req);
  if (!provider) return noProvider(res);
  const parsed = workOrderCreateSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid work order', details: parsed.error.flatten() });
  }
  const assignSelf = parsed.data.assign !== 'QUEUE';
  const result = await createWorkOrder({
    actor: req.user.email,
    source: 'TECH_APP',
    via: 'tech-app',
    input: parsed.data,
    assignProvider: assignSelf ? provider : null,
    assignmentStatus: 'ACCEPTED',
  });
  if (!result.ok) return res.status(result.status).json({ error: result.error, ...(result.code ? { code: result.code } : {}) });
  return res.status(201).json({
    data: {
      booking: {
        id: result.booking.id,
        referenceCode: result.booking.referenceCode,
        status: result.booking.status,
        appliance: result.booking.appliance,
        issue: result.booking.issue,
        city: result.booking.city,
        areaStatus: result.booking.areaStatus,
        customer: { name: result.booking.customer.name, phone: result.booking.customer.phone },
      },
      assignment: result.assignment ? publicAssignment(result.assignment) : null,
      customerCreated: result.customerCreated,
    },
  });
});

router.get('/provider/customers', ...providerBoard, (req, res) => {
  const provider = myProvider(req);
  const oversight = isOversightViewer(req);
  if (!provider && !oversight) return noProvider(res);
  // A provider looks up only customers their own business has worked
  // (their assignments' bookings). Oversight searches the whole book.
  let visible = null;
  if (provider && !oversight) {
    visible = new Set();
    for (const assignment of store.dispatchAssignments.values()) {
      if (assignment.providerId !== provider.id) continue;
      const booking = store.bookings.get(assignment.bookingId);
      if (booking?.customerId) visible.add(booking.customerId);
    }
  }
  return res.json({ data: findCustomersForCreate(req.query.q, visible) });
});

/* ---------------- Tech settings (Directive 6) ----------------
 * Profile details live on the account's User record; a network
 * provider's business name / service areas / appliances live on their
 * Provider record (the office sees and the matcher uses the same
 * fields). Vehicle + notification preferences + a company tech's
 * personal areas/appliances live in User.techSettings — per-account,
 * because the company crew SHARES one provider record. Documents are
 * not modeled as uploads anywhere in the platform, so Settings links
 * them to the Provider portal instead of faking a save.
 */
const techProfileSchema = z.object({
  firstName: z.string().trim().max(80).optional(),
  lastName: z.string().trim().max(80).optional(),
  phone: z.string().trim().max(30).optional(),
  businessName: z.string().trim().min(2).max(160).optional(),
  vehicle: z.object({
    year: z.string().trim().max(8).nullable().optional(),
    make: z.string().trim().max(40).nullable().optional(),
    model: z.string().trim().max(40).nullable().optional(),
    color: z.string().trim().max(30).nullable().optional(),
    plate: z.string().trim().max(16).nullable().optional(),
  }).nullable().optional(),
  notifications: z.object({
    jobOffers: z.boolean().optional(),
    scheduleChanges: z.boolean().optional(),
    payments: z.boolean().optional(),
    messages: z.boolean().optional(),
  }).optional(),
  myAreas: z.array(z.string().trim().min(1).max(80)).max(60).optional(),
  myAppliances: z.array(z.string().trim().min(1).max(80)).max(60).optional(),
});

// Dev-only fallback when no database is configured (production and
// the drills always run on Postgres): settings persist for the
// process lifetime keyed by account id.
const memoryTechSettings = new Map();

async function loadTechAccount(userId) {
  if (DATABASE_ENABLED) {
    const user = await db().user.findUnique({ where: { id: userId } });
    return user;
  }
  return null;
}

function techProfileView(req, provider, user) {
  const settings = (user?.techSettings && typeof user.techSettings === 'object' ? user.techSettings : null)
    || memoryTechSettings.get(req.user.id)
    || {};
  const system = techSystemFor(req, provider);
  return {
    system,
    account: {
      email: req.user.email,
      firstName: user?.firstName ?? null,
      lastName: user?.lastName ?? null,
      phone: user?.phone ?? null,
      roles: req.user.roles || [],
    },
    provider: provider
      ? {
          id: provider.id,
          businessName: provider.businessName,
          companyCrew: Boolean(provider.companyCrew),
          serviceCities: provider.serviceCities || [],
          specialties: provider.specialties || [],
        }
      : null,
    vehicle: settings.vehicle || null,
    notifications: {
      jobOffers: settings.notifications?.jobOffers !== false,
      scheduleChanges: settings.notifications?.scheduleChanges !== false,
      payments: settings.notifications?.payments !== false,
      messages: settings.notifications?.messages !== false,
    },
    // Company crew: personal working lists (the shared crew record's
    // areas/appliances are set by the office). Network: the provider
    // record itself is the list of record.
    myAreas: system === 'NETWORK' ? provider?.serviceCities || [] : settings.myAreas || [],
    myAppliances: system === 'NETWORK' ? provider?.specialties || [] : settings.myAppliances || [],
    areasManagedByOffice: system === 'COMPANY',
  };
}

router.get('/provider/profile', ...providerBoard, async (req, res) => {
  const provider = myProvider(req);
  if (!provider && !isOversightViewer(req)) return noProvider(res);
  const user = await loadTechAccount(req.user.id).catch(() => null);
  return res.json({ data: techProfileView(req, provider, user) });
});

router.patch('/provider/profile', ...providerOnly, async (req, res) => {
  const provider = myProvider(req);
  if (!provider) return noProvider(res);
  const parsed = techProfileSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid profile update', details: parsed.error.flatten() });
  }
  const data = parsed.data;
  const system = techSystemFor(req, provider);
  const changed = [];
  const user = await loadTechAccount(req.user.id).catch(() => null);
  const settings = {
    ...((user?.techSettings && typeof user.techSettings === 'object' ? user.techSettings : null) || memoryTechSettings.get(req.user.id) || {}),
  };
  if (data.vehicle !== undefined) { settings.vehicle = data.vehicle; changed.push('vehicle'); }
  if (data.notifications !== undefined) {
    settings.notifications = { ...(settings.notifications || {}), ...data.notifications };
    changed.push('notifications');
  }
  if (system === 'COMPANY') {
    if (data.myAreas !== undefined) { settings.myAreas = data.myAreas; changed.push('myAreas'); }
    if (data.myAppliances !== undefined) { settings.myAppliances = data.myAppliances; changed.push('myAppliances'); }
  }
  const userFields = {};
  if (data.firstName !== undefined) { userFields.firstName = data.firstName || null; changed.push('firstName'); }
  if (data.lastName !== undefined) { userFields.lastName = data.lastName || null; changed.push('lastName'); }
  if (data.phone !== undefined) { userFields.phone = data.phone || null; changed.push('phone'); }
  if (Object.keys(userFields).length || changed.length) {
    if (DATABASE_ENABLED) {
      await db().user.update({
        where: { id: req.user.id },
        data: { ...userFields, techSettings: settings },
      });
    } else {
      memoryTechSettings.set(req.user.id, settings);
    }
  }
  if (system === 'NETWORK') {
    let providerChanged = false;
    if (data.businessName !== undefined && data.businessName !== provider.businessName) {
      provider.businessName = data.businessName;
      providerChanged = true;
      changed.push('businessName');
    }
    if (data.myAreas !== undefined) { provider.serviceCities = data.myAreas; providerChanged = true; changed.push('serviceCities'); }
    if (data.myAppliances !== undefined) { provider.specialties = data.myAppliances; providerChanged = true; changed.push('specialties'); }
    if (providerChanged) await persistProvider(provider);
  }
  appendEvent('TECH_PROFILE_UPDATED', {
    source: 'TECH_APP',
    actor: req.user.email,
    entityType: 'USER',
    entityId: req.user.id,
    details: { system, fields: changed },
  });
  const fresh = await loadTechAccount(req.user.id).catch(() => null);
  return res.json({ data: techProfileView(req, provider, fresh) });
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



/* ------------- Tech dispatch package read models (2026-11-19) -------------
 * Ramone's full-package rebuild, shaped by the enterprise blueprint's
 * consolidated work-order view: the estimate DECISION (approved /
 * declined, recorded against a specific estimate version), the
 * approved-estimate INVOICE (the Invoice table finally has a creation
 * path), WARRANTY coverage + claims as first-class records, and the
 * job's Stripe payments — all folded into the workspace view and the
 * /full record below. Everything here reads real records only; a
 * missing record reads back as an explicit empty state, never a
 * fabricated one.
 */

function jobWarranties(booking) {
  // Blueprint rule: warranties are looked up BY APPLIANCE. A job's
  // appliance identity is its type + the recorded rating-plate facts;
  // a warranty recorded on another job for the same customer and the
  // same serial is the same appliance's coverage.
  const diagnosis = latestDiagnosis(booking);
  const serial = diagnosis?.serial || null;
  return (store.warranties || [])
    .filter((w) => {
      if (w.serviceRequestId === booking.id) return true;
      return Boolean(serial && w.customerId && booking.customerId && w.customerId === booking.customerId && w.serial && w.serial === serial);
    })
    .slice()
    .reverse();
}

function jobWarrantyClaims(booking) {
  return (store.warrantyClaims || [])
    .filter((claim) => claim.serviceRequestId === booking.id)
    .slice()
    .reverse();
}


function jobStripePayments(booking) {
  return [...(store.payments?.values() || [])]
    .filter((payment) => payment.bookingId === booking.id)
    .map((payment) => ({
      id: payment.id,
      purpose: payment.purpose || 'DIAGNOSTIC',
      amountCents: payment.amountCents,
      currency: payment.currency || 'usd',
      status: payment.status || 'PENDING',
      paidAt: payment.paidAt || null,
      createdAt: payment.createdAt || null,
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
  const money = invoiceMoney(booking);
  const receipts = money.receipts;
  const receiptsTotalCents = money.receiptsTotalCents;
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
    // Tech dispatch package (2026-11-19): the customer's recorded
    // decision on the current estimate, the generated invoice, the
    // warranty coverage + claims on this job's appliance.
    estimateDecision: estimateDecision(booking),
    invoice: money.invoice,
    warranties: jobWarranties(booking),
    warrantyClaims: jobWarrantyClaims(booking),
    review: reviewState(booking),
    photos: jobPhotos(booking),
    receipts,
    partsUsed: jobPartsUsed(booking),
    payments: {
      estimateTotalCents,
      receiptsTotalCents,
      // The balance is information, never a gate: the guide's rule is
      // that payment may remain outstanding and is tracked separately.
      // Once an invoice exists it is the balance of record.
      invoiceTotalCents: money.invoiceTotalCents,
      balanceDueCents: money.balanceDueCents,
      stripePayments: jobStripePayments(booking),
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
/* Pricing + estimate math live in services/jobMoney.js (shared with Book OS). */

router.post('/provider/assignments/:id/estimate', ...providerOnly, async (req, res) => {
  const loaded = loadMyAssignment(req, res);
  if (!loaded) return;
  const { assignment, booking } = loaded;
  if (!requireAccepted(res, assignment)) return;
  const parsed = estimateSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid estimate', details: parsed.error.flatten() });
  }
  const result = await saveEstimateForJob(booking, parsed.data, {
    actor: req.user.email,
    source: 'TECH_APP',
    assignmentId: assignment.id,
    confirmedBy: 'TECHNICIAN',
  });
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  return res.status(201).json({ data: { estimate: result.estimate } });
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
  const result = await authorizeEstimateForJob(booking, parsed.data, {
    actor: req.user.email,
    source: 'TECH_APP',
    assignmentId: assignment.id,
    confirmedBy: 'TECHNICIAN',
  });
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  return res.status(201).json({ data: { authorizationLog: result.authorizationLog } });
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
router.post('/provider/assignments/:id/receipts', ...providerOnly, async (req, res) => {
  const loaded = loadMyAssignment(req, res);
  if (!loaded) return;
  const { assignment, booking } = loaded;
  if (!requireAccepted(res, assignment)) return;
  const parsed = receiptSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid receipt', details: parsed.error.flatten() });
  }
  const result = await recordReceiptForJob(booking, parsed.data, {
    actor: req.user.email,
    source: 'TECH_APP',
    assignmentId: assignment.id,
    confirmedBy: 'TECHNICIAN',
  });
  if (!result.ok) {
    return res.status(result.status).json({
      error: result.error,
      ...(result.balanceDueCents != null ? { balanceDueCents: result.balanceDueCents } : {}),
    });
  }
  return res.status(201).json({
    data: { receipt: result.receipt, receipts: result.receipts, payments: result.payments },
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

/* ================= Tech dispatch package routes (2026-11-19) =================
 * The full-package Field Pro build, shaped by the enterprise
 * blueprint (docs/INTEGRATION_PLAN.md fold-in rule: the live Service
 * OS keeps its auth, gates and data; the package contributes
 * structure). Everything below reads and writes the SAME records the
 * booking platform and CRM use — ServiceRequest/booking, the CRM
 * customer record, the Parts Supply OS catalog — plus the package's
 * new first-class structures (Property, Warranty, WarrantyClaim,
 * Invoice) attached to those same records. No parallel tech-only
 * store exists. Gates follow the file's standing pattern: reads on
 * providerBoard (assigned provider + oversight viewers), writes on
 * providerOnly bound to the caller's own assignment (another
 * provider's job is a 404), office-level field edits on the staff
 * gate. Every mutation lands on the booking history (the audit
 * trail) and the global event log.
 */

/* ---------------- Review link state (Pepper Lists reviews) ----------------
 * The job's review destination is the platform's real review link —
 * the Pepper Lists reviews wall, the same URL the Link Center
 * catalog carries. The request state is read off the notification
 * outbox: the completion flow already queues a REVIEW_REQUEST per
 * customer channel; a job with no entry has honestly not been asked
 * yet, and staff can fire the real send from the workspace.
 */
function reviewState(booking) {
  const entry = catalogEntry(LINK_TYPES.REVIEW);
  const requests = (store.notificationOutbox || [])
    .filter((item) => item.template === 'REVIEW_REQUEST' && item.payload?.bookingId === booking.id)
    .map((item) => ({
      id: item.id,
      channel: item.channel,
      to: item.to,
      status: item.status || 'QUEUED',
      createdAt: item.createdAt || null,
    }))
    .reverse();
  return {
    link: entry?.url || null,
    linkName: entry?.name || 'Review link',
    completed: booking.status === 'COMPLETED',
    requested: requests.length > 0,
    requests,
    customerEmail: booking.customer?.email || null,
  };
}

/* ---------------- Dispatch overview (the Field Pro board) ---------------- */
router.get('/provider/overview', ...providerBoard, (req, res) => {
  const provider = myProvider(req);
  const oversight = isOversightViewer(req);
  if (!provider && !oversight) return noProvider(res);
  const scoped = [...store.dispatchAssignments.values()].filter(
    (assignment) => !provider || assignment.providerId === provider.id,
  );
  const todayNY = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const isToday = (iso) => Boolean(iso) && new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) === todayNY;
  const groups = { offers: [], accepted: [], inProgress: [], awaitingParts: [], awaitingDiagnosis: [], completedToday: [] };
  let completedTotal = 0;
  for (const assignment of scoped) {
    const booking = store.bookings.get(assignment.bookingId);
    if (assignment.status === 'APPROVED') groups.offers.push(assignment);
    if (assignment.status !== 'ACCEPTED' || !booking) continue;
    if (booking.status === 'COMPLETED') {
      completedTotal += 1;
      if (isToday(booking.completedAt)) groups.completedToday.push(assignment);
      continue;
    }
    groups.accepted.push(assignment);
    const flags = jobFlags(booking);
    if (flags.workStarted || booking.status === 'IN_PROGRESS') groups.inProgress.push(assignment);
    if (flags.awaitingParts) groups.awaitingParts.push(assignment);
    if (flags.awaitingDiagnosis) groups.awaitingDiagnosis.push(assignment);
  }
  // Bucket pages (2026-11-19, Directive 7) list EVERY job in the
  // bucket, so the board accepts a limit (default 50 as before, the
  // bucket views ask for more) and tags each row with its tech system
  // so the oversight pages can filter company vs network.
  const limit = Math.min(500, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
  const view = (list) =>
    list.slice(0, limit).map((assignment) => ({
      ...publicAssignment(assignment),
      providerId: assignment.providerId,
      providerBusinessName: providerNameById(assignment.providerId),
      providerSystem: providerSystemById(assignment.providerId),
    }));
  const lowStock = store.parts.filter((part) => part.active !== false && (part.stockOnHand || 0) <= (part.reorderPoint || 0));
  const data = {
    oversight: !provider && oversight,
    provider: provider ? { id: provider.id, businessName: provider.businessName } : null,
    counts: {
      offers: groups.offers.length,
      accepted: groups.accepted.length,
      inProgress: groups.inProgress.length,
      awaitingParts: groups.awaitingParts.length,
      awaitingDiagnosis: groups.awaitingDiagnosis.length,
      completedToday: groups.completedToday.length,
      completedTotal,
      lowStock: lowStock.length,
      openWarrantyClaims: (store.warrantyClaims || []).filter((claim) => claim.status !== 'CLOSED').length,
    },
    offers: view(groups.offers),
    accepted: view(groups.accepted),
    inProgress: view(groups.inProgress),
    awaitingParts: view(groups.awaitingParts),
    awaitingDiagnosis: view(groups.awaitingDiagnosis),
    completedToday: view(groups.completedToday),
  };
  if (!provider && oversight) {
    data.perProvider = store.providers.map((p) => {
      const own = scoped.filter((a) => a.providerId === p.id);
      return {
        providerId: p.id,
        businessName: p.businessName,
        system: p.companyCrew ? 'COMPANY' : 'NETWORK',
        offers: own.filter((a) => a.status === 'APPROVED').length,
        accepted: own.filter((a) => a.status === 'ACCEPTED').length,
        completedToday: own.filter((a) => {
          const b = store.bookings.get(a.bookingId);
          return b?.status === 'COMPLETED' && isToday(b.completedAt);
        }).length,
      };
    });
  }
  return res.json({ data });
});

/* ---------------- The consolidated job record (/full) ----------------
 * The blueprint's GET /work-orders/:id/full, composed on live
 * records: customer + account + service history, property, appliance
 * (+ the customer's appliance garage), technician, the full
 * workspace (diagnosis, checklist, notes, photos, estimate +
 * decision, invoice, payments, parts, activity), warranty coverage
 * looked up BY APPLIANCE, warranty claims, and the review-link
 * state. Payment detail rides the same board gate as the workspace —
 * providers see their own jobs only; oversight reads.
 */
router.get('/provider/assignments/:id/full', ...providerBoard, (req, res) => {
  const loaded = loadAssignmentForView(req, res);
  if (!loaded) return;
  const { assignment, booking } = loaded;
  if (!['APPROVED', 'ACCEPTED'].includes(assignment.status)) {
    return res.status(409).json({ error: 'Assignment is not active' });
  }
  const customerRecord = booking.customerId ? store.customers.get(booking.customerId) || null : null;
  const history = [...store.bookings.values()].filter((b) => booking.customerId && b.customerId === booking.customerId);
  const diagnosis = latestDiagnosis(booking);
  const properties = (store.properties || []).filter((p) => booking.customerId && p.customerId === booking.customerId);
  const property =
    properties.find((p) => p.address === (booking.serviceAddress || booking.customer?.address)) ||
    properties[properties.length - 1] ||
    null;
  const providerRecord = store.providers.find((p) => p.id === assignment.providerId) || null;
  const knowledgeQuery = `${booking.appliance || ''} ${booking.issue || ''}`.trim();
  return res.json({
    data: {
      ...workspaceView(assignment, booking),
      booking: {
        id: booking.id,
        referenceCode: booking.referenceCode || null,
        status: booking.status,
        source: booking.source || null,
        segment: booking.segment || 'RESIDENTIAL',
        city: booking.city || null,
        zip: booking.zip || null,
        serviceAddress: booking.serviceAddress || null,
        appliance: booking.appliance || null,
        issue: booking.issue || null,
        preferredWindow: booking.preferredWindow || null,
        resolution: booking.resolution || null,
        appointment: appointmentSummary(booking),
        createdAt: booking.createdAt || null,
        completedAt: booking.completedAt || null,
      },
      customer: {
        record: customerRecord,
        accountUserId: customerRecord?.userId || null,
        bookingHistoryCount: history.length,
        serviceHistory: history
          .slice()
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
          .slice(0, 25)
          .map((b) => ({
            id: b.id,
            referenceCode: b.referenceCode || null,
            appliance: b.appliance || null,
            issue: b.issue || null,
            status: b.status,
            createdAt: b.createdAt || null,
            completedAt: b.completedAt || null,
          })),
      },
      property,
      properties,
      appliance: {
        type: booking.appliance || null,
        issue: booking.issue || null,
        brand: diagnosis?.applianceBrand || null,
        model: diagnosis?.model || null,
        serial: diagnosis?.serial || null,
        garage: booking.customerId
          ? [...(store.appliances?.values() || [])].filter((a) => a.userId && customerRecord?.userId && a.userId === customerRecord.userId)
          : [],
      },
      technician: {
        provider: providerRecord
          ? { id: providerRecord.id, businessName: providerRecord.businessName, phone: providerRecord.phone || null }
          : null,
        assignmentStatus: assignment.status,
        approvedBy: assignment.approvedBy ?? null,
        approvedAt: assignment.approvedAt ?? null,
      },
      knowledge: knowledgeQuery
        ? searchKnowledge(knowledgeQuery, 4).map((hit) => ({ topic: hit.entry.topic, answer: hit.entry.answer, pack: hit.entry.pack }))
        : [],
      review: reviewState(booking),
    },
  });
});

/* ---------------- Estimate decision (approved / declined) ----------------
 * The blueprint's estimate → invoice workflow starts with the
 * customer's recorded decision. APPROVED writes the same
 * ESTIMATE_APPROVED event the authorization log, the tracking
 * timeline and the completion gate already read; DECLINED is its own
 * audited event so a refused quote is on the record, not lost.
 */
router.post('/provider/assignments/:id/estimate/decision', ...providerOnly, async (req, res) => {
  const loaded = loadMyAssignment(req, res);
  if (!loaded) return;
  const { assignment, booking } = loaded;
  if (!requireAccepted(res, assignment)) return;
  const parsed = estimateDecisionSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid estimate decision', details: parsed.error.flatten() });
  }
  const result = await recordEstimateDecisionForJob(booking, parsed.data, {
    actor: req.user.email,
    source: 'TECH_APP',
    assignmentId: assignment.id,
    confirmedBy: 'TECHNICIAN',
  });
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  return res.status(201).json({
    data: { estimateDecision: result.estimateDecision, authorizationLog: result.authorizationLog },
  });
});

/* ---------------- Invoice generation (approved estimate → invoice) -------- */
router.post('/provider/assignments/:id/invoice', ...providerOnly, async (req, res) => {
  const loaded = loadMyAssignment(req, res);
  if (!loaded) return;
  const { assignment, booking } = loaded;
  if (!requireAccepted(res, assignment)) return;
  const result = await generateInvoiceForJob(booking, {
    actor: req.user.email,
    source: 'TECH_APP',
    assignmentId: assignment.id,
    confirmedBy: 'TECHNICIAN',
  });
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  if (!result.created) return res.json({ data: { invoice: result.invoice, created: false } });
  return res.status(201).json({ data: { invoice: result.invoice, created: true } });
});

/* ---------------- Warranty coverage + claims ----------------
 * First-class records (blueprint models Warranty / WarrantyClaim),
 * attached to the job and looked up by appliance. Recording coverage
 * never invents it: the tech enters what the customer's warranty
 * paperwork actually says — provider, policy, expiry.
 */
const warrantySchema = z.object({
  provider: z.string().trim().min(2).max(160),
  coverage: z.string().trim().max(500).nullable().optional(),
  policyNumber: z.string().trim().max(120).nullable().optional(),
  expiresAt: z.string().trim().max(40).nullable().optional(),
  claimStatus: z.enum(['Not Filed', 'Filed', 'Approved', 'Denied', 'Closed']).optional(),
  applianceType: z.string().trim().max(80).nullable().optional(),
  brand: z.string().trim().max(80).nullable().optional(),
  model: z.string().trim().max(120).nullable().optional(),
  serial: z.string().trim().max(120).nullable().optional(),
});

router.post('/provider/assignments/:id/warranty', ...providerOnly, async (req, res) => {
  const loaded = loadMyAssignment(req, res);
  if (!loaded) return;
  const { assignment, booking } = loaded;
  if (!requireAccepted(res, assignment)) return;
  const parsed = warrantySchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid warranty record', details: parsed.error.flatten() });
  }
  const diagnosis = latestDiagnosis(booking);
  const t = new Date().toISOString();
  let warranty = (store.warranties || []).find((w) => w.serviceRequestId === booking.id);
  if (!warranty) {
    warranty = {
      id: createId(),
      companyId: booking.companyId,
      serviceRequestId: booking.id,
      createdAt: t,
    };
    store.warranties.push(warranty);
  }
  Object.assign(warranty, {
    customerId: booking.customerId || null,
    applianceType: parsed.data.applianceType || diagnosis?.applianceType || booking.appliance || null,
    brand: parsed.data.brand || diagnosis?.applianceBrand || null,
    model: parsed.data.model || diagnosis?.model || null,
    serial: parsed.data.serial || diagnosis?.serial || null,
    provider: parsed.data.provider,
    coverage: parsed.data.coverage || null,
    policyNumber: parsed.data.policyNumber || null,
    expiresAt: parsed.data.expiresAt || null,
    claimStatus: parsed.data.claimStatus || warranty.claimStatus || 'Not Filed',
    createdBy: req.user.email,
    updatedAt: t,
  });
  await persistWarranty(warranty);
  addBookingEvent(booking, 'WARRANTY_RECORDED', req.user.email, {
    assignmentId: assignment.id,
    warrantyId: warranty.id,
    warrantyProvider: warranty.provider,
    confirmedBy: 'TECHNICIAN',
  });
  booking.updatedAt = t;
  await persistBooking(booking);
  appendEvent('WARRANTY_RECORDED', {
    source: 'TECH_APP',
    actor: req.user.email,
    entityType: 'BOOKING',
    entityId: booking.id,
    referenceCode: booking.referenceCode,
    details: { warrantyId: warranty.id, warrantyProvider: warranty.provider },
  });
  return res.status(201).json({ data: { warranty, warranties: jobWarranties(booking) } });
});

const warrantyClaimSchema = z.object({
  description: z.string().trim().min(3).max(1000),
  claimNumber: z.string().trim().max(120).nullable().optional(),
  warrantyProvider: z.string().trim().max(160).nullable().optional(),
  authorization: z.string().trim().max(300).nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
  amountCents: z.number().int().min(0).max(100000000).nullable().optional(),
  warrantyId: z.string().uuid().nullable().optional(),
});

router.post('/provider/assignments/:id/warranty-claims', ...providerOnly, async (req, res) => {
  const loaded = loadMyAssignment(req, res);
  if (!loaded) return;
  const { assignment, booking } = loaded;
  if (!requireAccepted(res, assignment)) return;
  const parsed = warrantyClaimSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid warranty claim', details: parsed.error.flatten() });
  }
  const warranties = jobWarranties(booking);
  const t = new Date().toISOString();
  const claim = {
    id: createId(),
    companyId: booking.companyId,
    serviceRequestId: booking.id,
    assignmentId: assignment.id,
    customerId: booking.customerId || null,
    warrantyId: parsed.data.warrantyId || warranties[0]?.id || null,
    claimNumber: parsed.data.claimNumber || null,
    warrantyProvider: parsed.data.warrantyProvider || warranties[0]?.provider || null,
    authorization: parsed.data.authorization || null,
    status: 'OPEN',
    description: parsed.data.description,
    notes: parsed.data.notes || null,
    amountCents: parsed.data.amountCents ?? null,
    createdBy: req.user.email,
    createdAt: t,
    updatedAt: t,
  };
  store.warrantyClaims.push(claim);
  await persistWarrantyClaim(claim);
  addBookingEvent(booking, 'WARRANTY_CLAIM_FILED', req.user.email, {
    assignmentId: assignment.id,
    claimId: claim.id,
    claimNumber: claim.claimNumber,
    warrantyProvider: claim.warrantyProvider,
    confirmedBy: 'TECHNICIAN',
  });
  booking.updatedAt = t;
  await persistBooking(booking);
  appendEvent('WARRANTY_CLAIM_FILED', {
    source: 'TECH_APP',
    actor: req.user.email,
    entityType: 'BOOKING',
    entityId: booking.id,
    referenceCode: booking.referenceCode,
    details: { claimId: claim.id, claimNumber: claim.claimNumber },
  });
  return res.status(201).json({ data: { claim, warrantyClaims: jobWarrantyClaims(booking) } });
});

const warrantyClaimStatusSchema = z.object({
  status: z.enum(['OPEN', 'FILED', 'APPROVED', 'DENIED', 'CLOSED']),
  authorization: z.string().trim().max(300).nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});

router.post('/provider/warranty-claims/:claimId/status', ...providerOnly, async (req, res) => {
  const provider = myProvider(req);
  if (!provider) return noProvider(res);
  const parsed = warrantyClaimStatusSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid claim status update', details: parsed.error.flatten() });
  }
  const claim = (store.warrantyClaims || []).find((c) => c.id === req.params.claimId);
  if (!claim) return res.status(404).json({ error: 'Warranty claim not found' });
  const booking = store.bookings.get(claim.serviceRequestId);
  const mine = booking
    ? [...store.dispatchAssignments.values()].some((a) => a.bookingId === booking.id && a.providerId === provider.id)
    : false;
  if (!mine) return res.status(404).json({ error: 'Warranty claim not found' });
  const t = new Date().toISOString();
  claim.status = parsed.data.status;
  if (parsed.data.authorization !== undefined) claim.authorization = parsed.data.authorization;
  if (parsed.data.notes !== undefined) claim.notes = parsed.data.notes;
  claim.updatedAt = t;
  await persistWarrantyClaim(claim);
  addBookingEvent(booking, 'WARRANTY_CLAIM_STATUS', req.user.email, {
    claimId: claim.id,
    status: claim.status,
    confirmedBy: 'TECHNICIAN',
  });
  booking.updatedAt = t;
  await persistBooking(booking);
  appendEvent('WARRANTY_CLAIM_STATUS', {
    source: 'TECH_APP',
    actor: req.user.email,
    entityType: 'BOOKING',
    entityId: booking.id,
    referenceCode: booking.referenceCode,
    details: { claimId: claim.id, status: claim.status },
  });
  return res.json({ data: { claim } });
});

router.get('/provider/warranty-claims', ...providerBoard, (req, res) => {
  const provider = myProvider(req);
  const oversight = isOversightViewer(req);
  if (!provider && !oversight) return noProvider(res);
  const q = String(req.query.q || '').trim().toLowerCase();
  const rows = [];
  for (const claim of store.warrantyClaims || []) {
    const booking = store.bookings.get(claim.serviceRequestId);
    if (!booking) continue;
    if (provider) {
      const mine = [...store.dispatchAssignments.values()].some(
        (a) => a.bookingId === booking.id && a.providerId === provider.id,
      );
      if (!mine) continue;
    }
    const row = {
      ...claim,
      bookingReference: booking.referenceCode || null,
      customerName: booking.customer?.name || null,
      customerPhone: booking.customer?.phone || null,
      appliance: booking.appliance || null,
    };
    if (q) {
      const haystack = [claim.claimNumber, claim.warrantyProvider, row.bookingReference, row.customerName, row.customerPhone]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(q)) continue;
    }
    rows.push(row);
  }
  rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return res.json({ data: { claims: rows.slice(0, 100) } });
});

/* ---------------- Property (first-class, attached to the customer) -------- */
const propertySchema = z.object({
  label: z.string().trim().max(120).nullable().optional(),
  address: z.string().trim().min(4).max(240).optional(),
  city: z.string().trim().min(2).max(80).optional(),
  zip: z.string().trim().min(3).max(16).optional(),
  unit: z.string().trim().max(40).nullable().optional(),
  accessNotes: z.string().trim().max(1000).nullable().optional(),
});

router.post('/provider/assignments/:id/property', ...providerOnly, async (req, res) => {
  const loaded = loadMyAssignment(req, res);
  if (!loaded) return;
  const { assignment, booking } = loaded;
  if (!requireAccepted(res, assignment)) return;
  if (!booking.customerId) {
    return res.status(409).json({ error: 'This booking has no customer record to attach a property to' });
  }
  const parsed = propertySchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid property record', details: parsed.error.flatten() });
  }
  const address = parsed.data.address || booking.serviceAddress || booking.customer?.address || null;
  if (!address) {
    return res.status(400).json({ error: 'No service address on this job yet — enter the property address' });
  }
  const t = new Date().toISOString();
  let property = (store.properties || []).find((p) => p.customerId === booking.customerId && p.address === address);
  if (!property) {
    property = { id: createId(), companyId: booking.companyId, customerId: booking.customerId, createdAt: t };
    store.properties.push(property);
  }
  Object.assign(property, {
    label: parsed.data.label ?? property.label ?? null,
    address,
    city: parsed.data.city || booking.city || property.city || '',
    zip: parsed.data.zip || booking.zip || property.zip || '',
    unit: parsed.data.unit ?? property.unit ?? null,
    accessNotes: parsed.data.accessNotes ?? property.accessNotes ?? null,
    updatedAt: t,
  });
  await persistProperty(property);
  addBookingEvent(booking, 'PROPERTY_UPDATED', req.user.email, {
    assignmentId: assignment.id,
    propertyId: property.id,
    confirmedBy: 'TECHNICIAN',
  });
  booking.updatedAt = t;
  await persistBooking(booking);
  appendEvent('PROPERTY_UPDATED', {
    source: 'TECH_APP',
    actor: req.user.email,
    entityType: 'BOOKING',
    entityId: booking.id,
    referenceCode: booking.referenceCode,
    details: { propertyId: property.id },
  });
  return res.status(201).json({ data: { property } });
});

/* ---------------- Suppliers, company card, repair knowledge --------------- */
router.get('/provider/suppliers', ...providerBoard, (req, res) => {
  const provider = myProvider(req);
  if (!provider && !isOversightViewer(req)) return noProvider(res);
  const suppliers = (store.suppliers || [])
    .filter((s) => s.active !== false)
    .map((s) => ({
      id: s.id,
      name: s.name,
      contact: s.contact || null,
      phone: s.phone || null,
      email: s.email || null,
      terms: s.terms || null,
      vendorType: s.vendorType || 'STANDARD',
    }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return res.json({ data: { suppliers } });
});

router.get('/provider/company', ...providerBoard, (req, res) => {
  const provider = myProvider(req);
  if (!provider && !isOversightViewer(req)) return noProvider(res);
  const warrantySection = speedyKnowledgeSections().find((section) => section.startsWith('WARRANTY'));
  return res.json({
    data: {
      business: {
        name: PLATFORM_CONSTANTS.platformOwner,
        slogan: PLATFORM_CONSTANTS.slogan,
        phoneDisplay: PLATFORM_CONSTANTS.phoneDisplay,
        phone: PLATFORM_CONSTANTS.phone,
        officeAddress: PLATFORM_CONSTANTS.officeAddress,
      },
      dispatch: { team: PLATFORM_CONSTANTS.dispatchTeam, hours: 'Monday–Friday, 8 AM–7 PM' },
      pricing: {
        diagnosticFee: PLATFORM_CONSTANTS.diagnosticFee,
        feeTerms: PLATFORM_CONSTANTS.feeTerms,
        repairLaborFlat: 210,
        installationLaborFlat: 150,
        parts: 'Priced on the written quote — no work without an approved written quote.',
        commercial: 'Custom quote — the $99 diagnostic does not apply to commercial work.',
        paymentDue: 'Payment is due on completion unless agreed in writing.',
      },
      warrantyTerms: warrantySection ? warrantySection.split('\n').slice(1).join('\n').trim() || null : null,
      partners: [
        {
          name: 'Cleanout Vents',
          role: 'Registered vendor partner — dryer vent cleaning',
          phoneDisplay: '(954) 931-7997',
          note: 'Route vent work to Cleanout Vents. Never quote a vent price — none exists on Top Speed surfaces.',
        },
        {
          name: 'Appliance Plus Parts Supply',
          role: 'Partner distributor (Parts Supply OS)',
          phoneDisplay: null,
          note: 'Order parts through the Parts Supply OS flow in this app; the partner confirms exact part and price at order time.',
        },
      ],
      coverage: {
        landingCities: 65,
        autoMatchCities: (PLATFORM_CONSTANTS.serviceCities || []).length,
        note: 'Bookings outside the auto-match cities land in the Service Setters review queue.',
      },
    },
  });
});

router.get('/provider/knowledge', ...providerBoard, (req, res) => {
  const provider = myProvider(req);
  if (!provider && !isOversightViewer(req)) return noProvider(res);
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ data: { results: [] } });
  const results = searchKnowledge(q, 6).map((hit) => ({
    topic: hit.entry.topic,
    answer: hit.entry.answer,
    pack: hit.entry.pack,
    score: Math.round(hit.score * 100) / 100,
  }));
  return res.json({ data: { results } });
});

/* ---------------- Unified job-details editing (NO SILO) ----------------
 * Ramone (2026-11-19): full data-entry fields across the lifecycle,
 * and every field reads/writes the SAME ServiceRequest + CRM
 * customer record the booking platform and Book OS use. An edit here
 * is the office's record the moment it saves — booking fields land on
 * the booking, customer fields land on booking.customer AND the CRM
 * customer row (persisted through the same bookingsRepo bridge), and
 * every change is written to the booking history with from → to.
 * The assigned tech edits their own accepted jobs; oversight/staff
 * use the office variant, which additionally owns the provenance
 * fields (source, segment) a tech must never rewrite.
 */
const jobDetailsBase = {
  customerName: z.string().trim().min(2).max(120),
  customerPhone: z.string().trim().min(7).max(32),
  customerEmail: z.string().trim().email().max(160).nullable(),
  serviceAddress: z.string().trim().min(4).max(240),
  city: z.string().trim().min(2).max(80),
  zip: z.string().trim().min(3).max(16),
  appliance: z.string().trim().min(2).max(80),
  issue: z.string().trim().min(3).max(1000),
  preferredWindow: z.string().trim().max(120).nullable(),
  resolution: z.string().trim().max(1000).nullable(),
};
const jobDetailsSchema = z
  .object(Object.fromEntries(Object.entries(jobDetailsBase).map(([key, schema]) => [key, schema.optional()])))
  .refine((data) => Object.values(data).some((value) => value !== undefined), { message: 'Send at least one field to update' });
const officeJobDetailsSchema = z
  .object({
    ...Object.fromEntries(Object.entries(jobDetailsBase).map(([key, schema]) => [key, schema.optional()])),
    source: z.string().trim().min(2).max(60).optional(),
    segment: z.enum(['RESIDENTIAL', 'COMMERCIAL']).optional(),
  })
  .refine((data) => Object.values(data).some((value) => value !== undefined), { message: 'Send at least one field to update' });

async function applyJobDetails(req, booking, data, scope) {
  const changes = [];
  const set = (field, target, key, value) => {
    if (value === undefined) return;
    const from = target[key] ?? null;
    if (from !== value) {
      changes.push({ field, from, to: value });
      target[key] = value;
    }
  };
  if (!booking.customer) booking.customer = {};
  const customer = booking.customer;
  set('customerName', customer, 'name', data.customerName);
  set('customerPhone', customer, 'phone', data.customerPhone);
  set('customerEmail', customer, 'email', data.customerEmail);
  if (data.serviceAddress !== undefined) {
    set('serviceAddress', booking, 'serviceAddress', data.serviceAddress);
    set('customerAddress', customer, 'address', data.serviceAddress);
  }
  if (data.city !== undefined) {
    set('city', booking, 'city', data.city);
    set('customerCity', customer, 'city', data.city);
  }
  if (data.zip !== undefined) {
    set('zip', booking, 'zip', data.zip);
    set('customerZip', customer, 'zip', data.zip);
  }
  set('appliance', booking, 'appliance', data.appliance);
  set('issue', booking, 'issue', data.issue);
  set('preferredWindow', booking, 'preferredWindow', data.preferredWindow);
  set('resolution', booking, 'resolution', data.resolution);
  set('source', booking, 'source', data.source);
  set('segment', booking, 'segment', data.segment);
  if (!changes.length) return changes;
  const t = new Date().toISOString();
  // The CRM customer row is the same record the office reads: sync
  // the customer fields onto it and persist through the same bridge
  // the booking platform uses.
  const record = booking.customerId ? store.customers.get(booking.customerId) : null;
  if (record && record !== customer) {
    record.name = customer.name;
    record.phone = customer.phone;
    if (customer.email !== undefined) record.email = customer.email;
    if (customer.address !== undefined) record.address = customer.address;
    record.city = booking.city;
    record.zip = booking.zip;
    await persistCustomer(record);
  } else if (customer.id) {
    await persistCustomer(customer);
  }
  // A stored Property for the old address follows the job's address.
  const addressChanged = changes.some((c) => ['serviceAddress', 'city', 'zip'].includes(c.field));
  if (addressChanged && booking.customerId) {
    const oldAddress = changes.find((c) => c.field === 'serviceAddress')?.from;
    const property = (store.properties || []).find(
      (p) => p.customerId === booking.customerId && (!oldAddress || p.address === oldAddress),
    );
    if (property) {
      property.address = booking.serviceAddress || property.address;
      property.city = booking.city || property.city;
      property.zip = booking.zip || property.zip;
      property.updatedAt = t;
      await persistProperty(property);
    }
  }
  addBookingEvent(booking, 'JOB_DETAILS_UPDATED', req.user.email, {
    scope,
    changes,
    confirmedBy: scope === 'FIELD' ? 'TECHNICIAN' : 'OFFICE',
  });
  booking.updatedAt = t;
  await persistBooking(booking);
  appendEvent('JOB_DETAILS_UPDATED', {
    source: 'TECH_APP',
    actor: req.user.email,
    entityType: 'BOOKING',
    entityId: booking.id,
    referenceCode: booking.referenceCode,
    details: { scope, fields: changes.map((c) => c.field) },
  });
  return changes;
}

function jobDetailsView(booking) {
  return {
    referenceCode: booking.referenceCode || null,
    customerName: booking.customer?.name || null,
    customerPhone: booking.customer?.phone || null,
    customerEmail: booking.customer?.email || null,
    serviceAddress: booking.serviceAddress || null,
    city: booking.city || null,
    zip: booking.zip || null,
    appliance: booking.appliance || null,
    issue: booking.issue || null,
    preferredWindow: booking.preferredWindow || null,
    resolution: booking.resolution || null,
    source: booking.source || null,
    segment: booking.segment || 'RESIDENTIAL',
  };
}

router.patch('/provider/assignments/:id/job-details', ...providerOnly, async (req, res) => {
  const loaded = loadMyAssignment(req, res);
  if (!loaded) return;
  const { assignment, booking } = loaded;
  if (!requireAccepted(res, assignment)) return;
  const parsed = jobDetailsSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid job details', details: parsed.error.flatten() });
  }
  const changes = await applyJobDetails(req, booking, parsed.data, 'FIELD');
  return res.json({ data: { updated: changes.map((c) => c.field), changes, booking: jobDetailsView(booking) } });
});

const officeGate = [
  authenticate,
  requireCompany,
  requireRole(ROLES.DISPATCHER, ...OVERSIGHT_ROLES),
];

router.patch('/provider/assignments/:id/job-details/office', ...officeGate, async (req, res) => {
  const assignment = store.dispatchAssignments.get(req.params.id);
  if (!assignment) return res.status(404).json({ error: 'Assignment not found' });
  const booking = store.bookings.get(assignment.bookingId);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  const parsed = officeJobDetailsSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid job details', details: parsed.error.flatten() });
  }
  const changes = await applyJobDetails(req, booking, parsed.data, 'OFFICE');
  return res.json({ data: { updated: changes.map((c) => c.field), changes, booking: jobDetailsView(booking) } });
});

/* ---------------- Review request send (real outbox, by email) -------------
 * Fires the platform's real review request (services/notifications)
 * — the same one completion queues — through the notification
 * outbox. Idempotent by the outbox's event keys: if the completion
 * send already queued the email, this reports its live status
 * instead of double-sending. Honest refusals: not completed yet, or
 * no customer email on the record (add one under Booking details).
 */
router.post('/provider/assignments/:id/review-request', ...providerOnly, async (req, res) => {
  const loaded = loadMyAssignment(req, res);
  if (!loaded) return;
  const { assignment, booking } = loaded;
  if (booking.status !== 'COMPLETED') {
    return res.status(409).json({ error: 'The review request goes out after the job is completed' });
  }
  if (!booking.customer?.email) {
    return res.status(409).json({
      error: 'No customer email on this job — add one under Booking details, then send the review request',
      review: reviewState(booking),
    });
  }
  const before = reviewState(booking);
  notifyReviewRequest(booking, 'TECH_APP');
  const after = reviewState(booking);
  const newlyQueued = after.requests.filter((r) => !before.requests.some((b) => b.id === r.id));
  if (newlyQueued.length) {
    const t = new Date().toISOString();
    addBookingEvent(booking, 'REVIEW_REQUEST_SENT', req.user.email, {
      assignmentId: assignment.id,
      channels: newlyQueued.map((r) => r.channel),
      confirmedBy: 'TECHNICIAN',
    });
    booking.updatedAt = t;
    await persistBooking(booking);
  }
  appendEvent('REVIEW_REQUEST_TRIGGERED', {
    source: 'TECH_APP',
    actor: req.user.email,
    entityType: 'BOOKING',
    entityId: booking.id,
    referenceCode: booking.referenceCode,
    details: { newlyQueued: newlyQueued.length },
  });
  return res.json({ data: { review: after, newlyQueued: newlyQueued.length } });
});

/* ---------------- AI-fill: diagnosis form draft (never persists) ----------
 * Ramone's interaction model (2026-11-19): forms complete two ways —
 * typing, and AI filling. This preview is the AI-fill leg for the
 * diagnosis form: Speedy drafts the fields from the tech's own
 * description/dictation and the app drops them into the form as a
 * DRAFT. Nothing is written to the job here — no booking event, no
 * persistence — the tech reviews, edits and taps "Save diagnosis"
 * (the existing confirmed save) before anything commits. Mirrors the
 * ai-note preview's binding and honest 503/502 handling.
 */
const aiDiagnosisPreviewSchema = z.object({
  text: z.string().trim().min(3).max(4000),
});

router.post('/provider/assignments/:id/ai-diagnosis/preview', ...providerOnly, async (req, res) => {
  const provider = myProvider(req);
  if (!provider) return noProvider(res);
  const assignment = store.dispatchAssignments.get(req.params.id);
  if (!assignment || assignment.providerId !== provider.id) {
    return res.status(404).json({ error: 'Assignment not found' });
  }
  if (assignment.status !== 'ACCEPTED') {
    return res.status(409).json({ error: 'Accept the job before drafting its diagnosis' });
  }
  if (!speedyStatus().configured) {
    return res.status(503).json({ error: 'Speedy is not configured yet' });
  }
  const parsed = aiDiagnosisPreviewSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid description text' });
  }
  try {
    const draft = await speedyDraftDiagnosis(parsed.data.text);
    return res.json({ data: { draft, persisted: false } });
  } catch (error) {
    return res.status(502).json({
      error: 'Speedy could not draft that — your words are kept; type the form or try again',
      detail: String(error?.message || error),
    });
  }
});
