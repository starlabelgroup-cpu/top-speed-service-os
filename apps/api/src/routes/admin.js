import { Router } from 'express';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { store } from '../data/store.js';
import { db, DATABASE_ENABLED } from '../db/client.js';

/**
 * Owner-only maintenance: remove the Pepper drill/test data created while
 * the platform was being built and verified (Nov 9–11), leaving every real
 * record untouched. Identification is positive-only — a record is removed
 * only when it matches a known drill marker — and Aldo Alay's real booking
 * is hard-excluded by reference, phone, and name, checked last.
 *
 * POST /admin/cleanup-test-data { dryRun: true }  → counts, deletes nothing
 * POST /admin/cleanup-test-data { dryRun: false } → deletes, returns counts
 * Executed for the launch reset on 2026-11-11 (drills + video drills removed, Aldo kept).
 */
const router = Router();
const ownerOnly = [authenticate, requireCompany, requireRole('COMPANY_OWNER', 'PLATFORM_ADMIN')];

const KEEP_REFS = new Set(['TS-BRWT9Y']);
const KEEP_PHONES = new Set(['9543255467']);
const KEEP_NAMES = new Set(['Aldo Alay']);
const DRILL_REFS = ['TS-AEVEQH', 'TS-2YZSC2', 'TS-KNDMC8', 'TS-G6Q63U', 'TS-NRP24A'];
const DRILL_CONN_REFS = ['TS-8VC98U'];

const digits = (v) => String(v || '').replace(/\D/g, '');
const isDrillEmail = (e) => /^pepper-.*@example\.com$/i.test(String(e || ''));

async function identify(prisma) {
  // --- users: every drill account is a pepper-*@example.com address ------
  const userRows = await prisma.user.findMany({ where: { email: { startsWith: 'pepper-' } } });
  const drillUsers = userRows.filter((u) => isDrillEmail(u.email));
  const drillUserIds = new Set(drillUsers.map((u) => u.id));
  const drillEmails = new Set(drillUsers.map((u) => String(u.email).toLowerCase()));
  const drillPhones = new Set(drillUsers.map((u) => digits(u.phone)).filter((p) => p.length >= 7));
  const drillNames = new Set(['Neighbor Test']);

  // --- customers: linked to a drill user, a drill contact detail, or a ---
  // --- Pepper/Neighbor test name. Maria Lopez is caught via her booking. -
  const customerRows = await prisma.customer.findMany();
  let drillCustomers = new Map();
  const customerMatches = (c) =>
    (c.userId && drillUserIds.has(c.userId)) ||
    (c.email && drillEmails.has(String(c.email).toLowerCase())) ||
    drillPhones.has(digits(c.phone)) ||
    digits(c.phone).startsWith('9545550') ||
    /^Pepper\b/.test(c.name || '') ||
    drillNames.has(c.name);
  for (const c of customerRows) if (customerMatches(c)) drillCustomers.set(c.id, c);

  // --- bookings: known drill references, drill customers, or the word ---
  // --- "drill" the test bookings carry in their issue text. --------------
  const bookingRows = await prisma.serviceRequest.findMany();
  const bookingMatches = (b, custIds) =>
    DRILL_REFS.includes(b.referenceCode) ||
    (b.customerId && custIds.has(b.customerId)) ||
    /drill/i.test(b.issue || '');
  let drillBookings = bookingRows.filter((b) => bookingMatches(b, new Set(drillCustomers.keys())));
  // Second pass: a drill booking's customer is a drill customer too.
  for (const b of drillBookings) {
    const c = customerRows.find((x) => x.id === b.customerId);
    if (c && !drillCustomers.has(c.id)) drillCustomers.set(c.id, c);
  }
  drillBookings = bookingRows.filter((b) => bookingMatches(b, new Set(drillCustomers.keys())));
  for (const b of drillBookings) {
    const c = customerRows.find((x) => x.id === b.customerId);
    if (c && !drillCustomers.has(c.id)) drillCustomers.set(c.id, c);
  }

  // --- HARD EXCLUSIONS (applied last, they always win) -------------------
  for (const [id, c] of [...drillCustomers]) {
    if (KEEP_PHONES.has(digits(c.phone)) || KEEP_NAMES.has(c.name)) drillCustomers.delete(id);
  }
  drillBookings = drillBookings.filter((b) => {
    if (KEEP_REFS.has(b.referenceCode)) return false;
    const c = customerRows.find((x) => x.id === b.customerId);
    if (c && (KEEP_PHONES.has(digits(c.phone)) || KEEP_NAMES.has(c.name))) return false;
    return drillCustomers.has(b.customerId) || DRILL_REFS.includes(b.referenceCode) || /drill/i.test(b.issue || '');
  });
  // Bookings whose customer was excluded for safety stay, and their
  // customers stay too.
  const keptBookingCustomerIds = new Set(
    bookingRows.filter((b) => !drillBookings.includes(b)).map((b) => b.customerId)
  );
  for (const id of [...drillCustomers.keys()]) {
    if (keptBookingCustomerIds.has(id)) drillCustomers.delete(id);
  }

  const bookingIds = new Set(drillBookings.map((b) => b.id));
  const customerIds = new Set(drillCustomers.keys());
  const keptBooking = bookingRows.find((b) => KEEP_REFS.has(b.referenceCode)) || null;
  if (keptBooking && bookingIds.has(keptBooking.id)) {
    throw new Error('Safety check failed: the protected booking was marked for removal. Aborting.');
  }

  // --- everything that hangs off the drill set ---------------------------
  const assignmentRows = await prisma.dispatchAssignment.findMany({ where: { serviceRequestId: { in: [...bookingIds] } } });
  const invoiceRows = await prisma.invoice.findMany({
    where: { OR: [{ serviceRequestId: { in: [...bookingIds] } }, { customerId: { in: [...customerIds] } }] },
  });
  const referralRows = await prisma.referral.findMany({
    where: {
      OR: [
        { customerId: { in: [...customerIds] } },
        { issuedFromBookingId: { in: [...bookingIds] } },
        { issuedFromReferenceCode: { in: DRILL_REFS } },
      ],
    },
  });
  const videoRows = await prisma.videoConsultRequest.findMany();
  const drillVideos = videoRows.filter(
    (v) =>
      drillPhones.has(digits(v.phone)) ||
      digits(v.phone).startsWith('555010') ||
      DRILL_REFS.includes(v.bookingReference) ||
      /^Pepper\b/.test(v.customerName || '') ||
      /drill|smoke test/i.test(v.customerName || '') ||
      /drill|smoke test/i.test(v.note || '')
  );
  const connectionRows = await prisma.connection.findMany();
  const drillConnections = connectionRows.filter(
    (c) =>
      DRILL_CONN_REFS.includes(c.reference) ||
      (c.email && drillEmails.has(String(c.email).toLowerCase())) ||
      drillPhones.has(digits(c.phone)) ||
      digits(c.phone).startsWith('9545550') ||
      /^Pepper\b/.test(c.name || '') ||
      drillNames.has(c.name) ||
      /drill/i.test(c.message || '')
  );
  const applianceRows = await prisma.customerAppliance.findMany({ where: { userId: { in: [...drillUserIds] } } });

  // Outbox rows are matched in the store (their payloads carry the drill
  // references), plus anything addressed to a drill contact directly.
  const markers = [...drillEmails, ...drillPhones, ...DRILL_REFS, ...bookingIds, ...customerIds];
  const outboxIds = new Set();
  for (const entry of store.notificationOutbox) {
    const blob = JSON.stringify(entry || {});
    if (markers.some((m) => m && blob.includes(m))) outboxIds.add(entry.id);
  }
  const outboxByRecipient = await prisma.notificationOutbox.findMany({
    where: { to: { in: [...drillEmails, ...[...drillPhones]] } },
    select: { id: true },
  });
  for (const r of outboxByRecipient) outboxIds.add(r.id);
  for (const entry of store.notificationOutbox) {
    if (KEEP_REFS.has(entry?.payload?.referenceCode) || KEEP_PHONES.has(digits(entry?.to))) outboxIds.delete(entry.id);
  }

  return {
    drillUsers, drillUserIds, drillEmails, drillPhones,
    drillCustomers, drillBookings, bookingIds, customerIds,
    assignmentRows, invoiceRows, referralRows, drillVideos, drillConnections, applianceRows,
    outboxIds, markers,
    keptBooking,
  };
}

function sweepStore(plan) {
  const { drillUserIds, drillEmails, drillPhones, bookingIds, customerIds, markers } = plan;
  const hasMarker = (v) => {
    const blob = JSON.stringify(v || {});
    if ([...KEEP_REFS].some((r) => blob.includes(r)) || [...KEEP_PHONES].some((p) => blob.includes(p))) return false;
    return markers.some((m) => m && blob.includes(m));
  };
  for (const id of drillUserIds) store.users.delete(id);
  for (const id of customerIds) store.customers.delete(id);
  for (const id of bookingIds) store.bookings.delete(id);
  for (const [id, a] of [...store.dispatchAssignments]) if (bookingIds.has(a.bookingId)) store.dispatchAssignments.delete(id);
  for (const [id, p] of [...store.payments]) if (bookingIds.has(p.bookingId)) store.payments.delete(id);
  for (const [id, r] of [...store.referrals]) {
    if (customerIds.has(r.customerId) || bookingIds.has(r.issuedFromBookingId) || DRILL_REFS.includes(r.issuedFromReferenceCode)) store.referrals.delete(id);
  }
  for (const [id, v] of [...store.videoRequests]) {
    if (drillPhones.has(digits(v.phone)) || DRILL_REFS.includes(v.bookingReference) || /^Pepper\b/.test(v.customerName || '')) store.videoRequests.delete(id);
  }
  for (const [id, a] of [...store.appliances]) if (drillUserIds.has(a.userId)) store.appliances.delete(id);
  for (const map of [store.providerApplications, store.pmLeads, store.commercialAccounts, store.commercialFacilities, store.commercialEquipment, store.commercialWorkOrders]) {
    if (map instanceof Map) for (const [id, v] of [...map]) if (hasMarker(v)) map.delete(id);
  }
  store.connections = store.connections.filter((c) => !plan.drillConnections.some((d) => d.reference === c.reference) && !hasMarker(c));
  store.notificationOutbox = store.notificationOutbox.filter((e) => !plan.outboxIds.has(e.id));
  store.events = store.events.filter((e) => !hasMarker(e));
}

router.post('/admin/cleanup-test-data', ...ownerOnly, async (req, res) => {
  if (!DATABASE_ENABLED) return res.status(503).json({ error: 'Database is not connected, so there is nothing to clean.' });
  const dryRun = req.body?.dryRun !== false;
  const prisma = db();
  try {
    const plan = await identify(prisma);
    const removed = {
      users: plan.drillUsers.length,
      customers: plan.drillCustomers.size,
      bookings: plan.drillBookings.length,
      assignments: plan.assignmentRows.length,
      invoices: plan.invoiceRows.length,
      referrals: plan.referralRows.length,
      videoRequests: plan.drillVideos.length,
      connections: plan.drillConnections.length,
      appliances: plan.applianceRows.length,
      outbox: plan.outboxIds.size,
    };
    const kept = { reference: 'TS-BRWT9Y', present: Boolean(plan.keptBooking) };
    if (dryRun) {
      return res.json({
        ok: true, dryRun: true, removed, kept,
        bookingReferences: plan.drillBookings.map((b) => b.referenceCode).filter(Boolean),
      });
    }
    const bookingIds = [...plan.bookingIds];
    const customerIds = [...plan.customerIds];
    await prisma.$transaction([
      prisma.invoice.deleteMany({ where: { id: { in: plan.invoiceRows.map((r) => r.id) } } }),
      prisma.dispatchAssignment.deleteMany({ where: { id: { in: plan.assignmentRows.map((r) => r.id) } } }),
      prisma.referral.deleteMany({ where: { id: { in: plan.referralRows.map((r) => r.id) } } }),
      prisma.videoConsultRequest.deleteMany({ where: { id: { in: plan.drillVideos.map((r) => r.id) } } }),
      prisma.connection.deleteMany({ where: { id: { in: plan.drillConnections.map((r) => r.id) } } }),
      prisma.customerAppliance.deleteMany({ where: { id: { in: plan.applianceRows.map((r) => r.id) } } }),
      prisma.notificationOutbox.deleteMany({ where: { id: { in: [...plan.outboxIds] } } }),
      prisma.serviceRequest.deleteMany({ where: { id: { in: bookingIds } } }),
      prisma.customer.deleteMany({ where: { id: { in: customerIds } } }),
      prisma.user.deleteMany({ where: { id: { in: [...plan.drillUserIds] } } }),
    ]);
    sweepStore(plan);
    const remaining = await prisma.serviceRequest.count();
    return res.json({ ok: true, dryRun: false, removed, kept, remainingBookings: remaining });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Cleanup failed' });
  }
});


/**
 * Owner-only: permanently delete ONE booking by reference (a bogus or
 * mis-entered record, or one the owner says is not a real customer), with
 * its assignments, invoices, issued referral and queued notifications.
 * The customer record is removed too when this was their only booking.
 * POST /admin/bookings/delete { reference }
 */
router.post('/admin/bookings/delete', ...ownerOnly, async (req, res) => {
  if (!DATABASE_ENABLED) return res.status(503).json({ error: 'Database is not connected.' });
  const reference = String(req.body?.reference || '').trim();
  if (!reference) return res.status(400).json({ error: 'A booking reference is required' });
  const prisma = db();
  try {
    const booking = await prisma.serviceRequest.findUnique({ where: { referenceCode: reference } });
    if (!booking) return res.status(404).json({ error: 'No booking found with that reference' });
    const customer = await prisma.customer.findUnique({ where: { id: booking.customerId } });
    const siblings = await prisma.serviceRequest.count({ where: { customerId: booking.customerId, id: { not: booking.id } } });
    const invoiceRows = await prisma.invoice.findMany({ where: { serviceRequestId: booking.id }, select: { id: true } });
    const referralRows = await prisma.referral.findMany({ where: { issuedFromBookingId: booking.id }, select: { id: true } });
    const outboxIds = new Set();
    for (const entry of store.notificationOutbox) {
      const blob = JSON.stringify(entry || {});
      if (blob.includes(reference) || entry?.payload?.bookingId === booking.id) outboxIds.add(entry.id);
    }
    const ops = [
      prisma.invoice.deleteMany({ where: { id: { in: invoiceRows.map((r) => r.id) } } }),
      prisma.referral.deleteMany({ where: { id: { in: referralRows.map((r) => r.id) } } }),
      prisma.notificationOutbox.deleteMany({ where: { id: { in: [...outboxIds] } } }),
      prisma.serviceRequest.delete({ where: { id: booking.id } }),
    ];
    if (customer && siblings === 0) ops.push(prisma.customer.delete({ where: { id: customer.id } }));
    await prisma.$transaction(ops);

    store.bookings.delete(booking.id);
    for (const [id, a] of [...store.dispatchAssignments]) if (a.bookingId === booking.id) store.dispatchAssignments.delete(id);
    for (const [id, pay] of [...store.payments]) if (pay.bookingId === booking.id) store.payments.delete(id);
    for (const [id, r] of [...store.referrals]) if (r.issuedFromBookingId === booking.id) store.referrals.delete(id);
    if (customer && siblings === 0) store.customers.delete(customer.id);
    store.notificationOutbox = store.notificationOutbox.filter((e) => !outboxIds.has(e.id));

    const remaining = await prisma.serviceRequest.count();
    return res.json({
      ok: true,
      deleted: { reference, bookings: 1, invoices: invoiceRows.length, referrals: referralRows.length, outbox: outboxIds.size, customer: customer && siblings === 0 ? 1 : 0 },
      remainingBookings: remaining,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Delete failed' });
  }
});

export default router;
