import { Router } from 'express';
import { z } from 'zod';
import { store, appendEvent, createId } from '../data/store.js';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { STAFF_ROLES } from '../config/security.js';
import { effectiveArea, effectiveAreaStatus, SERVICE_CITIES } from '../config/serviceAreas.js';
import { slotForArea, todayDateString, APPOINTMENT_WINDOWS, CREWS_PER_AREA_WINDOW } from '../services/bookos.js';
import { suggestProviders } from '../services/dispatch.js';
import { persistCrmNote } from '../db/crmRepo.js';
import { persistConnection } from '../db/connectionsRepo.js';
import { persistCustomer } from '../db/bookingsRepo.js';
import { findUserById } from '../services/handoff.js';
import { createWorkOrder, workOrderCreateSchema } from '../services/workOrders.js';
import { jobReceipts } from '../services/jobMoney.js';
import { PIPELINE_STAGES, leadConnectionReferenceOf, pipelineBoard, pipelineRow } from '../services/crmPipeline.js';
import { surfaceOfBooking, leadConnectionOf } from '../services/trackingNumbers.js';
import { leadTypeOf } from '../services/leadBookings.js';
import { listConnections } from '../db/applianceConnectionsRepo.js';
import { buildCustomerTimeline, mergedRecordsOf } from '../services/crmTimeline.js';
import { mergePlan, resolveMergeGuards, executeMerge } from '../services/crmMerge.js';

/**
 * Top Speed CRM — the team's single home for the business (2026-11-12).
 *
 * One staff surface over the records the platform already keeps:
 * customers and their 360 (properties, appliances, job history, notes,
 * referral attribution, and a communications log that shows only the
 * outbox's truthful statuses), live operating counts for the console
 * home, and Speedy assist — briefs, message drafts, and provider-match
 * suggestions assembled from real records. Speedy drafts and suggests
 * only: a human approves every send and every dispatch, and the
 * standing governance limits (refunds human-only, no AI safety
 * certification, no credential overrides, compliance human-only) hold
 * on every assist output. Staff only.
 */
const router = Router();
const staffOnly = [authenticate, requireCompany, requireRole(...STAFF_ROLES)];

const SPEEDY_ASSIST_BOUNDARIES =
  'Speedy assist drafts and suggests from platform records only. It never sends a message, takes a payment, quotes an ETA, issues a refund, certifies repair safety, or overrides a technician credential — a Service Setter approves every send and every dispatch.';

function digits(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-10);
}

function staffName(req) {
  const name = [req.user?.firstName, req.user?.lastName].filter(Boolean).join(' ').trim();
  return name || req.user?.email || 'Service Setters';
}

function customerBookings(customerId) {
  return [...store.bookings.values()]
    .filter((b) => b.customerId === customerId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/* Lifetime value (2026-11-19 CRM upgrade): money ACTUALLY RECEIVED
 * for this customer, in integer cents, summed across all of their
 * bookings from the platform's two money-received ledgers — the
 * Payment table's PAID rows (card money collected online; the table
 * is the source of truth for online receipts, matched to the
 * customer through their bookings since a payment's customerId can
 * be null) plus the external receipts recorded on the bookings
 * (RECEIPT_RECORDED history events — cash / check / Zelle taken in
 * the field, the same receipts jobMoney counts against invoices).
 * The two never double-count: invoice totals are net of the
 * diagnostic credit, receipts are capped at the invoice balance
 * due, and PAID Payment rows are the diagnostic checkouts
 * themselves. A customer with no received money reads 0 — a true
 * zero, not a placeholder. */
function paidCentsByBooking() {
  const map = new Map();
  for (const payment of store.payments.values()) {
    if (payment.status !== 'PAID') continue;
    map.set(payment.bookingId, (map.get(payment.bookingId) || 0) + (payment.amountCents || 0));
  }
  return map;
}

function customerLifetimeValueCents(customerId, paidMap = paidCentsByBooking()) {
  let total = 0;
  for (const booking of customerBookings(customerId)) {
    total += paidMap.get(booking.id) || 0;
    for (const receipt of jobReceipts(booking)) total += receipt.amountCents || 0;
  }
  return total;
}

function bookingBrief(b) {
  return {
    id: b.id,
    referenceCode: b.referenceCode,
    appliance: b.appliance,
    issue: b.issue,
    city: b.city,
    zip: b.zip,
    area: effectiveArea(b),
    areaStatus: effectiveAreaStatus(b),
    serviceAddress: b.serviceAddress || b.customer?.address || null,
    status: b.status,
    source: b.source,
    // Tracking numbers (2026-11-19): which surface this booking came
    // from, resolved from its via/source — null when no signal names
    // a surface (honest, never guessed). Additive field.
    ...surfaceOfBooking(b, leadConnectionOf(b, store.connections)),
    referralCode: b.referralCode || null,
    preferredWindow: b.preferredWindow,
    appointment: b.appointment
      ? { date: b.appointment.date, window: b.appointment.window, windowLabel: b.appointment.windowLabel || b.appointment.window, status: b.appointment.status }
      : null,
    providerId: b.dispatch?.providerId || null,
    createdAt: b.createdAt,
    completedAt: b.completedAt || null,
  };
}

function customerSummary(customer, paidMap = paidCentsByBooking()) {
  const bookings = customerBookings(customer.id);
  const last = bookings[0] || null;
  return {
    id: customer.id,
    name: customer.name,
    phone: customer.phone,
    email: customer.email || null,
    city: customer.city || null,
    zip: customer.zip || null,
    area: last ? effectiveArea(last) : null,
    source: customer.source || null,
    // CRM upgrade (2026-11-19): ADDED fields — the staff-set status
    // flag (null = Active) and lifetime value in integer cents.
    // Every pre-existing field above is unchanged.
    crmFlag: customer.crmFlag || null,
    lifetimeValueCents: customerLifetimeValueCents(customer.id, paidMap),
    bookingsCount: bookings.length,
    lastBooking: last
      ? { referenceCode: last.referenceCode, appliance: last.appliance, status: last.status, area: effectiveArea(last), createdAt: last.createdAt }
      : null,
    createdAt: customer.createdAt,
  };
}

/** CRM home: the live operating picture the console opens on. */
router.get('/crm/home', ...staffOnly, (req, res) => {
  const bookings = [...store.bookings.values()];
  const today = todayDateString();
  const byStatus = {};
  for (const b of bookings) byStatus[b.status] = (byStatus[b.status] || 0) + 1;
  const waitlist = bookings.filter((b) => ['OUT_OF_AREA', 'AREA_REVIEW'].includes(effectiveAreaStatus(b)) && b.status !== 'CANCELLED');
  const areaLoad = SERVICE_CITIES.map((area) => {
    let booked = 0;
    for (const window of APPOINTMENT_WINDOWS) booked += slotForArea({ date: today, windowId: window.id, city: area }).booked;
    return { area, bookedToday: booked, capacityToday: APPOINTMENT_WINDOWS.length * CREWS_PER_AREA_WINDOW };
  }).filter((row) => row.bookedToday > 0);
  return res.json({
    data: {
      generatedAt: new Date().toISOString(),
      customers: { total: store.customers.size },
      bookings: {
        total: bookings.length,
        today: bookings.filter((b) => String(b.createdAt).slice(0, 10) === today).length,
        byStatus,
        queueDepth: bookings.filter((b) => b.status === 'PENDING_DISPATCH' && effectiveAreaStatus(b) !== 'OUT_OF_AREA').length,
      },
      waitlist: {
        total: waitlist.length,
        outOfArea: waitlist.filter((b) => effectiveAreaStatus(b) === 'OUT_OF_AREA').length,
        needsReview: waitlist.filter((b) => effectiveAreaStatus(b) === 'AREA_REVIEW').length,
      },
      areaLoadToday: areaLoad,
      referralsIssued: store.referrals.size,
      recentEvents: [...store.events].slice(-10).reverse().map((e) => ({ type: e.type, at: e.at, referenceCode: e.referenceCode || null })),
      speedyAssist: { boundaries: SPEEDY_ASSIST_BOUNDARIES },
    },
  });
});

router.get('/crm/customers', ...staffOnly, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const paidMap = paidCentsByBooking();
  // Duplicate merge (D5): tombstones never list as customers, but
  // their identifiers are aliases — a search on a merged record's
  // name / phone / email finds the survivor, marked as such.
  const aliasesBySurvivor = new Map();
  for (const record of store.customers.values()) {
    if (!record.mergedIntoId) continue;
    if (!aliasesBySurvivor.has(record.mergedIntoId)) aliasesBySurvivor.set(record.mergedIntoId, []);
    aliasesBySurvivor.get(record.mergedIntoId).push(record);
  }
  let customers = [...store.customers.values()]
    .filter((c) => !c.mergedIntoId)
    .map((c) => {
      const summary = customerSummary(c, paidMap);
      if (q) {
        const alias = (aliasesBySurvivor.get(c.id) || []).find(
          (t) =>
            (t.name || '').toLowerCase().includes(q) ||
            (t.phone || '').includes(q) ||
            (t.email || '').toLowerCase().includes(q),
        );
        if (alias) summary.matchedViaMergedRecord = { name: alias.name, phone: alias.phone, email: alias.email || null };
      }
      return summary;
    });
  if (q) {
    customers = customers.filter(
      (c) =>
        (c.name || '').toLowerCase().includes(q) ||
        (c.phone || '').includes(q) ||
        (c.email || '').toLowerCase().includes(q) ||
        (c.city || '').toLowerCase().includes(q) ||
        Boolean(c.matchedViaMergedRecord),
    );
  }
  customers.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return res.json({ data: { count: customers.length, customers: customers.slice(0, 200) } });
});

router.get('/crm/customers/:id', ...staffOnly, async (req, res) => {
  const customer = store.customers.get(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  // Duplicate merge (D5): a merged record's detail is a signpost to
  // the survivor — its bookings, money, and history live there now.
  if (customer.mergedIntoId) {
    const survivor = store.customers.get(customer.mergedIntoId) || null;
    return res.json({
      data: {
        customer: {
          ...customer,
          leadSource: customer.source || null,
          referredByCode: customer.referredByCode || null,
          crmFlag: customer.crmFlag || null,
          lifetimeValueCents: 0,
        },
        mergedInto: survivor ? { id: survivor.id, name: survivor.name, phone: survivor.phone, email: survivor.email || null } : null,
        account: null,
        properties: [],
        appliances: [],
        bookings: [],
        intake: [],
        communications: [],
        emails: [],
        referrals: { ownCode: null, journeys: [] },
        notes: [],
        timeline: [],
        timelineTotal: 0,
        mergedRecords: [],
      },
    });
  }
  const aliases = mergedRecordsOf(customer.id);
  const bookings = customerBookings(customer.id).map(bookingBrief);

  // Properties: every distinct address this customer has been served at
  // (their profile address plus each booking's own service address).
  const propertyKeys = new Set();
  const properties = [];
  const addProperty = (address, city, zip, area) => {
    const key = [address || '', city || '', zip || ''].join('|').toLowerCase();
    if (key === '||' || propertyKeys.has(key)) return;
    propertyKeys.add(key);
    properties.push({ address: address || null, city: city || null, zip: zip || null, area: area || null });
  };
  addProperty(customer.address, customer.city, customer.zip, null);
  for (const b of customerBookings(customer.id)) {
    addProperty(b.serviceAddress || b.customer?.address, b.city, b.zip, effectiveArea(b));
  }

  // Appliances/equipment on file: the customer's Connect garage units,
  // plus any commercial equipment registry rows tied to their account.
  const appliances = [...store.appliances.values()]
    .filter((a) => customer.userId && a.userId === customer.userId)
    .map((a) => ({
      id: a.id,
      type: a.type, brand: a.brand || null, model: a.model || null, serial: a.serial || null, year: a.year || null, notes: a.notes || null, origin: 'GARAGE',
      // Connected-appliance registry (2026-11-19): the manufacturer
      // networks this customer has consented to for this appliance.
      // REGISTERED = consent recorded; no manufacturer link exists
      // yet, and the payload must never suggest one does.
      connections: listConnections(a.id).map((c) => ({
        id: c.id, provider: c.provider, status: c.status, consentAt: c.consentAt, revokedAt: c.revokedAt,
      })),
    }));
  for (const equipment of store.commercialEquipment.values()) {
    const account = store.commercialAccounts.get(equipment.accountId);
    const linked =
      (customer.commercialAccountId && equipment.accountId === customer.commercialAccountId) ||
      (account && digits(account.phone) && digits(account.phone) === digits(customer.phone));
    if (linked) {
      appliances.push({
        type: equipment.type,
        brand: equipment.brand || null,
        model: equipment.model || null,
        serial: equipment.serial || null,
        assetTag: equipment.assetTag || null,
        healthStatus: equipment.status || null,
        origin: 'COMMERCIAL_REGISTRY',
      });
    }
  }

  const phone = digits(customer.phone);
  // Merged duplicates' identifiers are this customer's aliases (D5):
  // intake and outbox addressed to an old phone/email belong to the
  // survivor's story too.
  const aliasPhones = new Set([phone, ...aliases.map((a) => digits(a.phone))].filter(Boolean));
  const aliasEmails = new Set(
    [customer.email, ...aliases.map((a) => a.email)].filter(Boolean).map((e) => String(e).toLowerCase()),
  );
  const intake = [...store.connections]
    .filter((c) => aliasPhones.has(digits(c.phone)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((c) => ({ reference: c.reference, type: c.type, source: c.source, message: c.message, createdAt: c.createdAt }));

  // Communications log: outbox entries for this customer's bookings or
  // addressed to their phone/email — statuses shown exactly as recorded
  // (QUEUED / SENT / FAILED / GATED …), never dressed up.
  const bookingIds = new Set(bookings.map((b) => b.id));
  const communications = [...store.notificationOutbox]
    .filter((entry) => {
      // Internal staff alerts are not communications with the customer.
      if (entry.template === 'STAFF_SUBMISSION_ALERT') return false;
      if (entry.payload?.bookingId && bookingIds.has(entry.payload.bookingId)) return true;
      if (entry.to && aliasPhones.has(digits(entry.to))) return true;
      if (entry.to && aliasEmails.has(String(entry.to).toLowerCase())) return true;
      return false;
    })
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, 50)
    .map((entry) => ({
      channel: entry.channel,
      template: entry.template,
      to: entry.to,
      status: entry.status,
      reason: entry.reason || null,
      createdAt: entry.createdAt,
      sentAt: entry.sentAt || null,
    }));

  const referralCode = [...store.referrals.values()].find((r) => r.customerId === customer.id) || null;
  // Journeys name the referrer by customer id; the referee is carried by
  // phone + the booking they arrived on (there is no refereeCustomerId).
  const journeys = (store.referralJourneys || []).filter(
    (j) =>
      j.referrerCustomerId === customer.id ||
      (j.bookingId && bookingIds.has(j.bookingId)) ||
      (phone && digits(j.refereePhone) === phone),
  );
  const notes = (store.crmNotes || [])
    .filter((n) => n.customerId === customer.id)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .map((n) => ({ id: n.id, author: n.author, body: n.body, createdAt: n.createdAt }));

  // Email conversation: every Book OS Inbox message matched to this
  // customer (inbound mail they sent service@ / the managed
  // mailboxes, plus the staff replies filed on those threads),
  // newest first. Managed in the Book OS Email Manager console.
  const emails = (store.inboxMessages || [])
    .filter((m) => m.customerId === customer.id)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, 50)
    .map((m) => ({
      id: m.id,
      direction: m.direction,
      fromEmail: m.fromEmail,
      toEmail: m.toEmail,
      mailbox: m.mailbox || null,
      subject: m.subject,
      snippet: m.snippet || null,
      status: m.status,
      createdAt: m.createdAt,
    }));

  // Account block: signup attribution + email-verification state live
  // on the linked User record, not the Customer record — surface them
  // here so an offer sign-up reads as one story in the 360 (which
  // offer, which audience, verified or still pending). Null when the
  // customer has no login account.
  let account = null;
  if (customer.userId) {
    const user = await findUserById(customer.userId).catch(() => null);
    if (user) {
      const isoOrNull = (value) => (value ? (value instanceof Date ? value.toISOString() : String(value)) : null);
      account = {
        emailVerified: Boolean(user.emailVerifiedAt),
        emailVerifiedAt: isoOrNull(user.emailVerifiedAt),
        signupSource: user.signupSource || null,
        signupOfferSlug: user.signupOfferSlug || null,
        signupAudience: user.signupAudience || null,
        serviceArea: user.serviceArea || null,
        serviceAreaStatus: user.serviceAreaStatus || null,
        memberSince: isoOrNull(user.createdAt),
      };
    }
  }

  // CRM depth (2026-11-20): D4 one timeline — every real record for
  // this customer in one chronological feed (services/crmTimeline.js
  // documents the honesty rules; kinds with no records never appear).
  const timeline = await buildCustomerTimeline(customer);

  return res.json({
    data: {
      customer: {
        ...customer,
        leadSource: customer.source || null,
        referredByCode: customer.referredByCode || null,
        // CRM upgrade (2026-11-19): ADDED fields, same pair the list
        // summaries carry — staff status flag + lifetime value.
        crmFlag: customer.crmFlag || null,
        lifetimeValueCents: customerLifetimeValueCents(customer.id),
      },
      account,
      properties,
      appliances,
      bookings,
      intake,
      communications,
      emails,
      referrals: {
        ownCode: referralCode ? { code: referralCode.code, status: referralCode.status, redemptions: (referralCode.redemptions || []).length } : null,
        journeys: journeys.map((j) => ({ id: j.id, status: j.status, code: j.code || null, createdAt: j.createdAt })),
      },
      notes,
      // CRM depth (2026-11-20): ADDED fields — the D4 timeline and
      // the D5 merged-duplicate aliases pointing at this record.
      timeline: timeline.entries,
      timelineTotal: timeline.total,
      mergedRecords: aliases.map((t) => ({ id: t.id, name: t.name, phone: t.phone, email: t.email || null })),
    },
  });
});

const noteSchema = z.object({ body: z.string().trim().min(1).max(2000) });

/* New work order from the customer record (2026-11-19 create flows):
 * the customer is the record in the path — prefilled by definition —
 * and the job enters the same intake as every other surface
 * (source OFFICE, via crm) through services/workOrders.js. */
router.post('/crm/customers/:id/work-orders', ...staffOnly, async (req, res) => {
  const customer = store.customers.get(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  const parsed = workOrderCreateSchema.safeParse({
    ...(req.body || {}),
    customerId: customer.id,
    city: (req.body || {}).city || customer.city || undefined,
    zip: (req.body || {}).zip || customer.zip || undefined,
    address: (req.body || {}).address || customer.address || undefined,
  });
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid work order', details: parsed.error.flatten() });
  }
  const result = await createWorkOrder({
    actor: req.user.email,
    source: 'OFFICE',
    via: 'crm',
    input: parsed.data,
  });
  if (!result.ok) return res.status(result.status).json({ error: result.error, ...(result.code ? { code: result.code } : {}) });
  return res.status(201).json({
    data: {
      booking: {
        id: result.booking.id,
        referenceCode: result.booking.referenceCode,
        status: result.booking.status,
        source: result.booking.source,
        appliance: result.booking.appliance,
        issue: result.booking.issue,
        city: result.booking.city,
        areaStatus: result.booking.areaStatus,
        customer: { name: result.booking.customer.name, phone: result.booking.customer.phone },
      },
    },
  });
});

router.post('/crm/customers/:id/notes', ...staffOnly, async (req, res) => {
  const customer = store.customers.get(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  const parsed = noteSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'A note body is required', details: parsed.error.flatten() });
  const note = {
    id: createId(),
    companyId: req.companyId,
    customerId: customer.id,
    author: staffName(req),
    body: parsed.data.body,
    createdAt: new Date().toISOString(),
  };
  store.crmNotes.push(note);
  await persistCrmNote(note);
  await appendEvent('CRM_NOTE_ADDED', {
    actor: note.author,
    entityType: 'CUSTOMER',
    entityId: customer.id,
    details: { noteId: note.id },
  });
  return res.status(201).json({ data: { note } });
});

/* ---------------- CRM upgrades (2026-11-19): pipeline + flags ----------------
 * Ramone approved both upgrades from the CRM prototype review, built
 * onto the live records — never a second system:
 *  1. Leads & Pipeline: the lead-type Connections (the exact
 *     LEAD_TYPES set) as a staged board. Stage moves store ONE
 *     nullable column on the connection and mutate nothing else.
 *  2. Customer status flag: ONE nullable column on the customer
 *     (PRIORITY / FOLLOW_UP / null = Active), set from the record.
 * Both inherit this router's existing staff gate, unchanged. */

router.get('/crm/pipeline', ...staffOnly, (req, res) => {
  return res.json({ data: pipelineBoard() });
});

const pipelineStageSchema = z.object({ stage: z.enum(PIPELINE_STAGES) });

router.post('/crm/pipeline/:connectionId/stage', ...staffOnly, async (req, res) => {
  const connection = (store.connections || []).find((c) => c.id === req.params.connectionId);
  // Only lead-type connections live on the board; anything else —
  // unknown id, provider application, advertiser contact — is a 404
  // here, exactly as if it were not a lead at all.
  if (!connection || !leadTypeOf(connection.type)) {
    return res.status(404).json({ error: 'Lead not found' });
  }
  const parsed = pipelineStageSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid pipeline stage', details: parsed.error.flatten() });
  }
  connection.pipelineStage = parsed.data.stage;
  await persistConnection(connection);
  await appendEvent('CRM_PIPELINE_STAGE_SET', {
    actor: staffName(req),
    entityType: 'CONNECTION',
    entityId: connection.id,
    referenceCode: connection.reference,
    details: { stage: parsed.data.stage, type: connection.type },
  });
  const booking =
    [...store.bookings.values()].find((b) => leadConnectionReferenceOf(b) === connection.reference) || null;
  return res.json({ data: { lead: pipelineRow(connection, booking) } });
});

const customerFlagSchema = z.object({ flag: z.enum(['PRIORITY', 'FOLLOW_UP']).nullable() });

router.post('/crm/customers/:id/flag', ...staffOnly, async (req, res) => {
  const customer = store.customers.get(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  const parsed = customerFlagSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid customer flag', details: parsed.error.flatten() });
  }
  customer.crmFlag = parsed.data.flag;
  await persistCustomer(customer);
  await appendEvent('CRM_CUSTOMER_FLAG_SET', {
    actor: staffName(req),
    entityType: 'CUSTOMER',
    entityId: customer.id,
    details: { flag: parsed.data.flag },
  });
  return res.json({ data: { customer: customerSummary(customer) } });
});

/* ---------------- CRM depth (2026-11-20): duplicate merge (D5) ----------------
 * Guided merge of a duplicate customer record into a survivor. The
 * preview shows EXACTLY what will move (the same mergePlan the
 * execute runs) plus the guard state; the execute refuses the
 * Master/owner's records in either direction (Rule Zero) and
 * requires an explicit confirmAccountConflict when both records are
 * linked to different signed-in accounts. The duplicate is never
 * deleted — it becomes a tombstone whose identifiers keep resolving
 * to the survivor. Full rules: services/crmMerge.js. */

const mergePairSchema = z.object({ survivorId: z.string().uuid(), duplicateId: z.string().uuid() });
const mergeExecuteSchema = mergePairSchema.extend({ confirmAccountConflict: z.boolean().optional() });

function mergePairError(survivorId, duplicateId, survivor, duplicate) {
  if (survivorId === duplicateId) {
    return { status: 400, body: { error: 'A record cannot be merged into itself', code: 'SAME_RECORD' } };
  }
  if (!survivor || !duplicate) return { status: 404, body: { error: 'Customer not found' } };
  if (survivor.mergedIntoId || duplicate.mergedIntoId) {
    return { status: 400, body: { error: 'One of these records has already been merged', code: 'ALREADY_MERGED' } };
  }
  if (survivor.companyId !== duplicate.companyId) {
    return { status: 400, body: { error: 'These records belong to different companies', code: 'CROSS_COMPANY' } };
  }
  return null;
}

router.post('/crm/customers/merge/preview', ...staffOnly, async (req, res) => {
  const parsed = mergePairSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'survivorId and duplicateId are required', details: parsed.error.flatten() });
  }
  const survivor = store.customers.get(parsed.data.survivorId);
  const duplicate = store.customers.get(parsed.data.duplicateId);
  const err = mergePairError(parsed.data.survivorId, parsed.data.duplicateId, survivor, duplicate);
  if (err) return res.status(err.status).json(err.body);
  const guards = await resolveMergeGuards(survivor, duplicate);
  const survivorLtv = customerLifetimeValueCents(survivor.id);
  const duplicateLtv = customerLifetimeValueCents(duplicate.id);
  return res.json({
    data: {
      survivor: { id: survivor.id, name: survivor.name, phone: survivor.phone, email: survivor.email || null },
      duplicate: { id: duplicate.id, name: duplicate.name, phone: duplicate.phone, email: duplicate.email || null },
      moves: mergePlan(survivor, duplicate),
      guards: {
        ownerInvolved: guards.ownerInvolved,
        accountConflict: guards.accountConflict,
        survivorHasAccount: guards.survivorHasAccount,
        duplicateHasAccount: guards.duplicateHasAccount,
      },
      lifetimeValueCents: {
        survivor: survivorLtv,
        duplicate: duplicateLtv,
        combinedAfterMerge: survivorLtv + duplicateLtv,
      },
    },
  });
});

router.post('/crm/customers/merge', ...staffOnly, async (req, res) => {
  const parsed = mergeExecuteSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'survivorId and duplicateId are required', details: parsed.error.flatten() });
  }
  const survivor = store.customers.get(parsed.data.survivorId);
  const duplicate = store.customers.get(parsed.data.duplicateId);
  const err = mergePairError(parsed.data.survivorId, parsed.data.duplicateId, survivor, duplicate);
  if (err) return res.status(err.status).json(err.body);
  const guards = await resolveMergeGuards(survivor, duplicate);
  if (guards.ownerInvolved) {
    return res.status(403).json({ error: "The Master/owner's records are never merged", code: 'OWNER_RECORD' });
  }
  if (guards.accountConflict && !parsed.data.confirmAccountConflict) {
    return res.status(409).json({
      error:
        'Both records are linked to different signed-in accounts. Confirm the merge explicitly to proceed — the accounts themselves are never merged; the duplicate account link stays on the merged record as an alias.',
      code: 'ACCOUNT_CONFLICT',
    });
  }
  const { moved, note } = await executeMerge({
    survivor,
    duplicate,
    actor: staffName(req),
    confirmAccountConflict: Boolean(parsed.data.confirmAccountConflict),
  });
  return res.json({
    data: {
      survivor: customerSummary(survivor),
      moved,
      note: { id: note.id, body: note.body },
    },
  });
});

/* ---------------- Speedy assist (drafts & suggestions only) ---------------- */

router.get('/crm/customers/:id/speedy-brief', ...staffOnly, (req, res) => {
  const customer = store.customers.get(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  const bookings = customerBookings(customer.id);
  const open = bookings.filter((b) => !['COMPLETED', 'CANCELLED'].includes(b.status));
  const completed = bookings.filter((b) => b.status === 'COMPLETED');
  const last = bookings[0] || null;
  const lines = [
    `${customer.name} — customer since ${String(customer.createdAt).slice(0, 10)}${customer.source ? `, lead source ${customer.source}` : ''}.`,
    `${bookings.length} booking${bookings.length === 1 ? '' : 's'} on file (${completed.length} completed, ${open.length} open).`,
  ];
  if (last) {
    lines.push(
      `Most recent: ${last.referenceCode} — ${last.appliance} (${last.issue}) in ${effectiveArea(last) || last.city}, status ${last.status}${last.appointment?.status === 'SET' ? `, appointment ${last.appointment.date} ${last.appointment.windowLabel || last.appointment.window}` : ''}.`,
    );
  }
  const openItems = open.map((b) => {
    if (effectiveAreaStatus(b) === 'OUT_OF_AREA') return `${b.referenceCode}: outside the service area — on the expansion waitlist, no service promised.`;
    if (effectiveAreaStatus(b) === 'AREA_REVIEW') return `${b.referenceCode}: area needs a setter decision before an appointment can be set.`;
    if (b.status === 'PENDING_DISPATCH') return `${b.referenceCode}: waiting in the setter queue${b.appointment?.status === 'SET' ? ' (appointment set)' : ' (no appointment set yet)'}.`;
    if (b.status === 'MATCH_PENDING_APPROVAL') return `${b.referenceCode}: matched — waiting on a Service Setter to approve the dispatch.`;
    return `${b.referenceCode}: ${b.status}.`;
  });
  return res.json({
    data: {
      brief: { headline: `${customer.name} — ${bookings.length} booking${bookings.length === 1 ? '' : 's'}, ${open.length} open`, lines, openItems },
      assembledFrom: 'Live platform records (bookings, appointments, dispatch state). Nothing here was sent to the customer.',
      boundaries: SPEEDY_ASSIST_BOUNDARIES,
    },
  });
});

const draftSchema = z.object({
  purpose: z.enum(['follow_up', 'appointment_confirm', 'review_request', 'waitlist_update']),
  bookingId: z.string().uuid().optional(),
});

router.post('/crm/customers/:id/speedy-draft', ...staffOnly, async (req, res) => {
  const customer = store.customers.get(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  const parsed = draftSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid draft request', details: parsed.error.flatten() });
  const bookings = customerBookings(customer.id);
  const booking = (parsed.data.bookingId && bookings.find((b) => b.id === parsed.data.bookingId)) || bookings[0] || null;
  const firstName = String(customer.name || 'there').split(' ')[0];
  let draft;
  switch (parsed.data.purpose) {
    case 'appointment_confirm': {
      if (!booking?.appointment || booking.appointment.status !== 'SET') {
        return res.status(422).json({ error: 'No set appointment to confirm for this customer yet — set the appointment in Service Book Pro first, then draft the confirmation.' });
      }
      draft = `Hi ${firstName}, this is Top Speed Appliance confirming your ${booking.appliance} appointment on ${booking.appointment.date}, ${booking.appointment.windowLabel || booking.appointment.window}. Your reference is ${booking.referenceCode}. Reply here or call (844) 460-7038 if anything changes.`;
      break;
    }
    case 'review_request': {
      if (!bookings.some((b) => b.status === 'COMPLETED')) {
        return res.status(422).json({ error: 'Review requests only go to customers with a completed job.' });
      }
      draft = `Hi ${firstName}, thanks for choosing Top Speed Appliance. If we earned it, a quick review helps neighbors find us — and if anything about the visit fell short, reply here first and a human on our team will make it right.`;
      break;
    }
    case 'waitlist_update': {
      draft = `Hi ${firstName}, this is Top Speed Appliance with an honest update: your ${booking ? booking.appliance : 'appliance'} request is outside the area we serve today, so we have not booked a visit. We kept your request on our expansion list and will reach out the moment we serve your area.`;
      break;
    }
    default: {
      draft = `Hi ${firstName}, this is Top Speed Appliance following up${booking ? ` on your ${booking.appliance} request (${booking.referenceCode})` : ''}. A Service Setter can help you from here — reply to this message or call (844) 460-7038.`;
    }
  }
  await appendEvent('SPEEDY_DRAFT_CREATED', {
    actor: staffName(req),
    entityType: 'CUSTOMER',
    entityId: customer.id,
    details: { purpose: parsed.data.purpose, bookingId: booking?.id || null, sent: false },
  });
  return res.json({
    data: {
      draft,
      purpose: parsed.data.purpose,
      bookingReference: booking?.referenceCode || null,
      requiresApproval: true,
      note: 'Draft only — nothing was sent. Review, edit, and send it yourself through the normal channel.',
      boundaries: SPEEDY_ASSIST_BOUNDARIES,
    },
  });
});

router.get('/crm/bookings/:id/speedy-match', ...staffOnly, (req, res) => {
  const booking = store.bookings.get(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (effectiveAreaStatus(booking) === 'OUT_OF_AREA') {
    return res.json({
      data: {
        suggestions: [],
        note: 'This request is outside the service area — it belongs on the expansion waitlist, not in dispatch.',
        boundaries: SPEEDY_ASSIST_BOUNDARIES,
      },
    });
  }
  const suggestions = suggestProviders(booking).map((s) => ({
    providerId: s.providerId,
    businessName: s.businessName,
    matchScore: s.matchScore,
    reasons: s.reasons,
  }));
  return res.json({
    data: {
      bookingReference: booking.referenceCode || null,
      area: effectiveArea(booking),
      suggestions,
      topPick: suggestions[0]
        ? `${suggestions[0].businessName} — ${suggestions[0].reasons.join('; ')} (score ${suggestions[0].matchScore}).`
        : 'No provider clears the match threshold for this booking yet.',
      note: 'Suggestion only — dispatch still runs through Service Book Pro match + a Service Setter approval. Nothing was dispatched.',
      boundaries: SPEEDY_ASSIST_BOUNDARIES,
    },
  });
});

export default router;
