import { Router } from 'express';
import { z } from 'zod';
import { store, appendEvent, createId } from '../data/store.js';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { STAFF_ROLES } from '../config/security.js';
import { effectiveArea, effectiveAreaStatus, SERVICE_CITIES } from '../config/serviceAreas.js';
import { slotForArea, todayDateString, APPOINTMENT_WINDOWS, CREWS_PER_AREA_WINDOW } from '../services/bookos.js';
import { suggestProviders } from '../services/dispatch.js';
import { persistCrmNote } from '../db/crmRepo.js';

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

function customerSummary(customer) {
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
  let customers = [...store.customers.values()].map(customerSummary);
  if (q) {
    customers = customers.filter(
      (c) =>
        (c.name || '').toLowerCase().includes(q) ||
        (c.phone || '').includes(q) ||
        (c.email || '').toLowerCase().includes(q) ||
        (c.city || '').toLowerCase().includes(q),
    );
  }
  customers.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return res.json({ data: { count: customers.length, customers: customers.slice(0, 200) } });
});

router.get('/crm/customers/:id', ...staffOnly, (req, res) => {
  const customer = store.customers.get(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
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
    .map((a) => ({ type: a.type, brand: a.brand || null, model: a.model || null, serial: a.serial || null, year: a.year || null, notes: a.notes || null, origin: 'GARAGE' }));
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
  const intake = [...store.connections]
    .filter((c) => digits(c.phone) === phone && phone)
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
      if (phone && digits(entry.to) === phone) return true;
      if (customer.email && String(entry.to || '').toLowerCase() === customer.email.toLowerCase()) return true;
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

  return res.json({
    data: {
      customer: {
        ...customer,
        leadSource: customer.source || null,
        referredByCode: customer.referredByCode || null,
      },
      properties,
      appliances,
      bookings,
      intake,
      communications,
      referrals: {
        ownCode: referralCode ? { code: referralCode.code, status: referralCode.status, redemptions: (referralCode.redemptions || []).length } : null,
        journeys: journeys.map((j) => ({ id: j.id, status: j.status, code: j.code || null, createdAt: j.createdAt })),
      },
      notes,
    },
  });
});

const noteSchema = z.object({ body: z.string().trim().min(1).max(2000) });

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
  appendEvent('CRM_NOTE_ADDED', {
    actor: note.author,
    entityType: 'CUSTOMER',
    entityId: customer.id,
    details: { noteId: note.id },
  });
  return res.status(201).json({ data: { note } });
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

router.post('/crm/customers/:id/speedy-draft', ...staffOnly, (req, res) => {
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
      draft = `Hi ${firstName}, this is Top Speed Appliance confirming your ${booking.appliance} appointment on ${booking.appointment.date}, ${booking.appointment.windowLabel || booking.appointment.window}. Your reference is ${booking.referenceCode}. Reply here or call (954) 931-7997 if anything changes.`;
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
      draft = `Hi ${firstName}, this is Top Speed Appliance following up${booking ? ` on your ${booking.appliance} request (${booking.referenceCode})` : ''}. A Service Setter can help you from here — reply to this message or call (954) 931-7997.`;
    }
  }
  appendEvent('SPEEDY_DRAFT_CREATED', {
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
