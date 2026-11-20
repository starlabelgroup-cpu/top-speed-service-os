/**
 * CRM depth (2026-11-20, Ramone approved) — D4 one timeline per
 * customer + D5 duplicate-customer merge.
 *
 * D4: GET /crm/customers/:id carries ONE chronological timeline
 * assembled only from real records — bookings (+ completions),
 * PAID payments, field receipts, Tracking Number System contact
 * events (Twilio-routed only, matched by caller phone), notification
 * outbox entries (staff alerts excluded), Book OS Inbox messages,
 * and Pepper Lists Reviews. Drilled here: every seeded kind appears,
 * unrelated records never appear, ordering is newest-first, and a
 * customer with no records gets an EMPTY timeline (nothing
 * synthesized).
 *
 * D5: POST /crm/customers/merge/preview + /merge. Drilled here: the
 * preview counts exactly what will move and prices the merge in LTV;
 * the account-conflict guard (both records linked to different
 * accounts) refuses without confirmAccountConflict (409) and
 * proceeds with it; the owner guard refuses a merge touching the
 * Master/owner's record (403); after the merge the survivor's LTV
 * equals the two pre-merge LTVs summed, the duplicate's bookings /
 * payments / notes / inbox / referral records / garage live on the
 * survivor, the duplicate's timeline entries join the survivor's via
 * its alias identifiers, the duplicate's detail is a signpost
 * (mergedInto), search by the duplicate's phone finds the survivor
 * marked matchedViaMergedRecord, the tombstone + CUSTOMER_MERGED
 * platform event are in the database, and a second merge attempt is
 * refused (ALREADY_MERGED).
 *
 * Runs against a LOCAL test database only. Usage:
 *   DATABASE_URL=<local test db> node test/crm-timeline-merge.test.mjs
 * Exit code 0 = every check passed.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/services/passwords.js';
import { PLATFORM_COMPANY_ID } from '../src/data/store.js';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required (point it at a local TEST database).');
  process.exit(2);
}
process.env.DATABASE_URL_UNPOOLED ||= process.env.DATABASE_URL;

const PORT = Number(process.env.TEST_PORT || 4497);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const PASSWORD = 'test-pass-1234';
const DRILL_JWT = ['crmtl', 'drill', 'jwt', 'secret'].join('-');

const IDS = {
  owner: '90000000-0000-4000-8000-0000000000d1',
  setter: '90000000-0000-4000-8000-0000000000d2',
  customerUser: '90000000-0000-4000-8000-0000000000d3',
  survUser: '90000000-0000-4000-8000-0000000000d4',
  dupUser: '90000000-0000-4000-8000-0000000000d5',
  surv: 'a0000000-0000-4000-8000-0000000000d1',
  dup: 'a0000000-0000-4000-8000-0000000000d2',
  ownerCust: 'a0000000-0000-4000-8000-0000000000d3',
  lonely: 'a0000000-0000-4000-8000-0000000000d4',
  bookS: 'b0000000-0000-4000-8000-0000000000d1',
  bookD: 'b0000000-0000-4000-8000-0000000000d2',
  payS: 'e0000000-0000-4000-8000-0000000000d1',
  payD1: 'e0000000-0000-4000-8000-0000000000d2',
  payD2: 'e0000000-0000-4000-8000-0000000000d3',
  refDup: 'f0000000-0000-4000-8000-0000000000d1',
  journeyDup: 'f0000000-0000-4000-8000-0000000000d2',
  creditDup: 'f0000000-0000-4000-8000-0000000000d3',
  applianceDup: 'f0000000-0000-4000-8000-0000000000d4',
  invoiceDup: 'f0000000-0000-4000-8000-0000000000d5',
  reviewS: 'f0000000-0000-4000-8000-0000000000d6',
};
const EMAILS = {
  owner: 'crmtl-owner@test.local',
  setter: 'crmtl-setter@test.local',
  customerUser: 'crmtl-customer@test.local',
};
const PHONE_S = '9545550301';
const PHONE_D = '9545550302';
const REF_S = 'TS-MRGS1';
const REF_D = 'TS-MRGD1';

const prisma = new PrismaClient();
let server = null;
let passed = 0;
let failed = 0;

function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  if (ok) passed += 1; else failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}
function checkTrue(label, value) { check(label, Boolean(value), true); }

async function api(path, { token, method = 'GET', body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json };
}

async function login(email) {
  const res = await api('/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  return res.json?.token || null;
}

const daysAgo = (days) => new Date(Date.now() - days * 86400000);

async function seed() {
  const passwordHash = await hashPassword(PASSWORD);
  await prisma.company.upsert({
    where: { id: PLATFORM_COMPANY_ID }, update: {},
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'crmtl-platform', type: 'PLATFORM_OWNER', isPlatformOwner: true },
  });
  const users = [
    [IDS.owner, EMAILS.owner, ['COMPANY_OWNER']],
    [IDS.setter, EMAILS.setter, ['DISPATCHER']],
    [IDS.customerUser, EMAILS.customerUser, ['CUSTOMER']],
    [IDS.survUser, 'mary@test.local', ['CUSTOMER']],
    [IDS.dupUser, 'marydup@test.local', ['CUSTOMER']],
  ];
  for (const [id, email, roles] of users) {
    await prisma.user.upsert({
      where: { id },
      update: { passwordHash },
      create: { id, companyId: PLATFORM_COMPANY_ID, email, passwordHash, phone: '9545550110', roles, active: true },
    });
  }

  // --- The duplicate pair -------------------------------------------
  await prisma.customer.create({
    data: { id: IDS.surv, companyId: PLATFORM_COMPANY_ID, userId: IDS.survUser, name: 'Merge Mary', phone: PHONE_S, email: 'mary@test.local', city: 'Lauderhill', zip: '33311', createdAt: daysAgo(30) },
  });
  await prisma.customer.create({
    data: { id: IDS.dup, companyId: PLATFORM_COMPANY_ID, userId: IDS.dupUser, name: 'Mary Merge Dup', phone: PHONE_D, email: 'marydup@test.local', city: 'Lauderhill', zip: '33311', createdAt: daysAgo(20) },
  });
  await prisma.customer.create({
    data: { id: IDS.ownerCust, companyId: PLATFORM_COMPANY_ID, userId: IDS.owner, name: 'Owner Record', phone: '9545550309', email: 'ownerrec@test.local', city: 'Davie', zip: '33314', createdAt: daysAgo(15) },
  });
  await prisma.customer.create({
    data: { id: IDS.lonely, companyId: PLATFORM_COMPANY_ID, name: 'Quiet Quinn', phone: '9545550310', email: 'quinn@test.local', city: 'Davie', zip: '33314', createdAt: daysAgo(10) },
  });

  // Survivor booking: completed, one PAID payment, one field receipt.
  // It also arrived through the duplicate's referral (referredBy).
  await prisma.serviceRequest.create({
    data: {
      id: IDS.bookS, companyId: PLATFORM_COMPANY_ID, customerId: IDS.surv, referredByCustomerId: IDS.dup,
      city: 'Lauderhill', zip: '33311', appliance: 'Refrigerator', issue: 'Not cooling', referenceCode: REF_S,
      status: 'COMPLETED', completedAt: daysAgo(2), createdAt: daysAgo(5),
      history: [
        { type: 'RECEIPT_RECORDED', actor: 'drill', at: daysAgo(2).toISOString(), receipt: { id: 'rcpt-s1', method: 'CASH', amountCents: 21000, at: daysAgo(2).toISOString(), recordedBy: 'drill' } },
      ],
    },
  });
  await prisma.payment.create({
    data: { id: IDS.payS, companyId: PLATFORM_COMPANY_ID, serviceRequestId: IDS.bookS, customerId: IDS.surv, purpose: 'DIAGNOSTIC', amountCents: 9900, status: 'PAID', paidAt: daysAgo(5), createdAt: daysAgo(5) },
  });
  // Duplicate booking: confirmed, one PAID + one PENDING payment, one receipt.
  await prisma.serviceRequest.create({
    data: {
      id: IDS.bookD, companyId: PLATFORM_COMPANY_ID, customerId: IDS.dup,
      city: 'Lauderhill', zip: '33311', appliance: 'Washer', issue: 'Leaks', referenceCode: REF_D,
      status: 'CONFIRMED', createdAt: daysAgo(4),
      history: [
        { type: 'RECEIPT_RECORDED', actor: 'drill', at: daysAgo(1).toISOString(), receipt: { id: 'rcpt-d1', method: 'ZELLE', amountCents: 1500, at: daysAgo(1).toISOString(), recordedBy: 'drill' } },
      ],
    },
  });
  await prisma.payment.create({
    data: { id: IDS.payD1, companyId: PLATFORM_COMPANY_ID, serviceRequestId: IDS.bookD, customerId: IDS.dup, purpose: 'DIAGNOSTIC', amountCents: 5000, status: 'PAID', paidAt: daysAgo(4), createdAt: daysAgo(4) },
  });
  await prisma.payment.create({
    data: { id: IDS.payD2, companyId: PLATFORM_COMPANY_ID, serviceRequestId: IDS.bookD, customerId: IDS.dup, purpose: 'DIAGNOSTIC', amountCents: 7000, status: 'PENDING', createdAt: daysAgo(4) },
  });
  await prisma.invoice.create({
    data: { id: IDS.invoiceDup, companyId: PLATFORM_COMPANY_ID, serviceRequestId: IDS.bookD, customerId: IDS.dup, status: 'SENT', total: 300.00, createdAt: daysAgo(4) },
  });

  // Tracked contacts: a call from the survivor's phone, a text from
  // the duplicate's phone, and a call from an unrelated number that
  // must never appear on either timeline.
  await prisma.contactEvent.create({
    data: { channel: 'VOICE', surfaceKey: 'flagship-web', fromNumber: `+1${PHONE_S}`, toNumber: '+18444607038', externalSid: 'CA-drill-s', createdAt: daysAgo(3) },
  });
  await prisma.contactEvent.create({
    data: { channel: 'SMS', surfaceKey: 'flagship-web', fromNumber: `+1${PHONE_D}`, toNumber: '+18444607038', externalSid: 'SM-drill-d', createdAt: daysAgo(1) },
  });
  await prisma.contactEvent.create({
    data: { channel: 'VOICE', surfaceKey: 'flagship-web', fromNumber: '+19545550999', toNumber: '+18444607038', externalSid: 'CA-drill-x', createdAt: daysAgo(1) },
  });

  // Outbox: a real customer message for the survivor, a staff alert
  // (must be excluded), and a queued text to the duplicate's phone.
  await prisma.notificationOutbox.create({
    data: { companyId: PLATFORM_COMPANY_ID, channel: 'EMAIL', template: 'BOOKING_CONFIRMATION', to: 'mary@test.local', payload: { bookingId: IDS.bookS }, status: 'SENT', sentAt: daysAgo(5), createdAt: daysAgo(5) },
  });
  await prisma.notificationOutbox.create({
    data: { companyId: PLATFORM_COMPANY_ID, channel: 'SMS', template: 'STAFF_SUBMISSION_ALERT', to: PHONE_S, payload: { bookingId: IDS.bookS }, status: 'SENT', sentAt: daysAgo(5), createdAt: daysAgo(5) },
  });
  await prisma.notificationOutbox.create({
    data: { companyId: PLATFORM_COMPANY_ID, channel: 'SMS', template: 'APPOINTMENT_REMINDER', to: PHONE_D, payload: {}, status: 'QUEUED', createdAt: daysAgo(1) },
  });

  // The duplicate's paper trail: inbox thread, CRM note, referral
  // code + journey + credit, and a garage appliance on its account.
  await prisma.inboxMessage.create({
    data: { companyId: PLATFORM_COMPANY_ID, direction: 'INBOUND', fromEmail: 'marydup@test.local', toEmail: 'service@topspeedserviceos.com', subject: 'Washer question', customerId: IDS.dup, status: 'UNREAD', createdAt: daysAgo(2) },
  });
  await prisma.crmNote.create({
    data: { companyId: PLATFORM_COMPANY_ID, customerId: IDS.dup, author: 'Setter One', body: 'Duplicate note body', createdAt: daysAgo(2) },
  });
  await prisma.referral.create({
    data: { id: IDS.refDup, companyId: PLATFORM_COMPANY_ID, code: 'TS-REF-DUP1', customerId: IDS.dup, customerName: 'Mary Merge Dup', customerPhone: PHONE_D, status: 'ACTIVE', redemptions: [] },
  });
  await prisma.referralJourney.create({
    data: { id: IDS.journeyDup, companyId: PLATFORM_COMPANY_ID, referralId: IDS.refDup, code: 'TS-REF-DUP1', referrerCustomerId: IDS.dup, status: 'INVITED', createdAt: daysAgo(6) },
  });
  await prisma.referralCredit.create({
    data: { id: IDS.creditDup, companyId: PLATFORM_COMPANY_ID, customerId: IDS.dup, journeyId: IDS.journeyDup, amountCents: 2500, status: 'AVAILABLE', issuedBy: 'drill', createdAt: daysAgo(6) },
  });
  await prisma.customerAppliance.create({
    data: { id: IDS.applianceDup, userId: IDS.dupUser, type: 'Washer', brand: 'LG', model: 'WM4000', createdAt: daysAgo(20) },
  });

  // A published review by the survivor's account on her booking.
  await prisma.review.create({
    data: { id: IDS.reviewS, companyId: PLATFORM_COMPANY_ID, customerId: IDS.survUser, bookingId: IDS.bookS, rating: 5, title: 'Great fix', body: 'Fridge is cold again.', status: 'PUBLISHED', verifiedRepair: true, createdAt: daysAgo(1) },
  });
}

function startServer() {
  const proc = spawn('node', ['src/server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      ...process.env,
      PORT: String(PORT),
      JWT_SECRET: DRILL_JWT,
      DATABASE_URL: process.env.DATABASE_URL,
      DATABASE_URL_UNPOOLED: process.env.DATABASE_URL,
      OPENAI_API_KEY: '',
      OPENAI_API_KEY_V2: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', (d) => process.stderr.write(`[api] ${d}`));
  return proc;
}

async function waitForServer() {
  for (let i = 0; i < 90; i += 1) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('server did not come up');
}

const kindsOf = (entries) => (entries || []).map((e) => e.kind);
const hasKind = (entries, kind, titlePart) =>
  (entries || []).some((e) => e.kind === kind && (!titlePart || String(e.title).includes(titlePart)));

async function main() {
  await seed();
  server = startServer();
  await waitForServer();

  check('health 200', (await api('/health')).status, 200);
  check('payments/status 200', (await api('/payments/status')).status, 200);

  const setterToken = await login(EMAILS.setter);
  const customerToken = await login(EMAILS.customerUser);
  checkTrue('setter login returns a token', setterToken);
  checkTrue('customer login returns a token', customerToken);

  // ---- Gates -------------------------------------------------------
  check('merge preview anon → 401', (await api('/crm/customers/merge/preview', { method: 'POST', body: { survivorId: IDS.surv, duplicateId: IDS.dup } })).status, 401);
  check('merge preview customer role → 403', (await api('/crm/customers/merge/preview', { token: customerToken, method: 'POST', body: { survivorId: IDS.surv, duplicateId: IDS.dup } })).status, 403);
  check('merge anon → 401', (await api('/crm/customers/merge', { method: 'POST', body: { survivorId: IDS.surv, duplicateId: IDS.dup } })).status, 401);
  check('merge self → 400 SAME_RECORD', (await api('/crm/customers/merge', { token: setterToken, method: 'POST', body: { survivorId: IDS.surv, duplicateId: IDS.surv } })).json?.code, 'SAME_RECORD');

  // ---- D4: timeline before any merge --------------------------------
  const detailS = (await api(`/crm/customers/${IDS.surv}`, { token: setterToken })).json?.data;
  checkTrue('survivor detail loads', detailS?.customer?.id === IDS.surv);
  const tl = detailS?.timeline || [];
  checkTrue('timeline has the booking', hasKind(tl, 'BOOKING', REF_S));
  checkTrue('timeline has the completion', hasKind(tl, 'BOOKING_COMPLETED'));
  checkTrue('timeline has the PAID payment', hasKind(tl, 'PAYMENT', '$99.00'));
  checkTrue('timeline has the field receipt', hasKind(tl, 'RECEIPT', '$210.00'));
  checkTrue('timeline has the tracked call', hasKind(tl, 'CALL'));
  const callEntry = tl.find((e) => e.kind === 'CALL');
  checkTrue('call entry labels the Twilio-routed source', String(callEntry?.source || '').includes('Twilio-routed'));
  checkTrue('timeline has the outbox email', tl.some((e) => e.kind === 'MESSAGE' && String(e.title).includes('BOOKING_CONFIRMATION')));
  checkTrue('staff alert template is NOT on the timeline', !tl.some((e) => String(e.title).includes('STAFF_SUBMISSION_ALERT')));
  checkTrue('timeline has the review', hasKind(tl, 'REVIEW', 'Great fix'));
  checkTrue('unrelated caller is NOT on the timeline', !tl.some((e) => String(e.detail || '').includes('9545550999')));
  checkTrue('duplicate text is NOT on the survivor timeline yet', !tl.some((e) => e.kind === 'MESSAGE' && String(e.title).includes('Inbound text')));
  checkTrue('duplicate outbox text is NOT on the survivor timeline yet', !tl.some((e) => String(e.title).includes('APPOINTMENT_REMINDER')));
  const ats = tl.map((e) => String(e.at));
  checkTrue('timeline is newest-first', ats.every((v, i) => i === 0 || ats[i - 1] >= v));
  check('timelineTotal matches entries', detailS?.timelineTotal, tl.length);
  check('survivor LTV before merge', detailS?.customer?.lifetimeValueCents, 30900);

  const detailLonely = (await api(`/crm/customers/${IDS.lonely}`, { token: setterToken })).json?.data;
  check('record-free customer timeline is empty (nothing synthesized)', (detailLonely?.timeline || []).length, 0);

  // ---- D5: preview ---------------------------------------------------
  const preview = await api('/crm/customers/merge/preview', { token: setterToken, method: 'POST', body: { survivorId: IDS.surv, duplicateId: IDS.dup } });
  check('preview 200', preview.status, 200);
  const pv = preview.json?.data;
  check('preview moves.bookings', pv?.moves?.bookings, 1);
  check('preview moves.referredBookings', pv?.moves?.referredBookings, 1);
  check('preview moves.payments', pv?.moves?.payments, 2);
  check('preview moves.invoices', pv?.moves?.invoices, 1);
  check('preview moves.notes', pv?.moves?.notes, 1);
  check('preview moves.inboxMessages', pv?.moves?.inboxMessages, 1);
  check('preview moves.referralCodes', pv?.moves?.referralCodes, 1);
  check('preview moves.referralJourneys', pv?.moves?.referralJourneys, 1);
  check('preview moves.referralCredits', pv?.moves?.referralCredits, 1);
  check('preview moves.garageAppliances', pv?.moves?.garageAppliances, 1);
  check('preview flags the account conflict', pv?.guards?.accountConflict, true);
  check('preview ownerInvolved false for the pair', pv?.guards?.ownerInvolved, false);
  check('preview LTV survivor', pv?.lifetimeValueCents?.survivor, 30900);
  check('preview LTV duplicate', pv?.lifetimeValueCents?.duplicate, 6500);
  check('preview LTV combined', pv?.lifetimeValueCents?.combinedAfterMerge, 37400);

  // ---- Guards ---------------------------------------------------------
  const noConfirm = await api('/crm/customers/merge', { token: setterToken, method: 'POST', body: { survivorId: IDS.surv, duplicateId: IDS.dup } });
  check('merge without account-conflict confirm → 409', noConfirm.status, 409);
  check('409 carries ACCOUNT_CONFLICT', noConfirm.json?.code, 'ACCOUNT_CONFLICT');

  const ownerPreview = await api('/crm/customers/merge/preview', { token: setterToken, method: 'POST', body: { survivorId: IDS.surv, duplicateId: IDS.ownerCust } });
  check('owner pair preview flags ownerInvolved', ownerPreview.json?.data?.guards?.ownerInvolved, true);
  const ownerMerge = await api('/crm/customers/merge', { token: setterToken, method: 'POST', body: { survivorId: IDS.surv, duplicateId: IDS.ownerCust, confirmAccountConflict: true } });
  check('merge touching the owner record → 403', ownerMerge.status, 403);
  check('403 carries OWNER_RECORD', ownerMerge.json?.code, 'OWNER_RECORD');

  // ---- Execute --------------------------------------------------------
  const merged = await api('/crm/customers/merge', { token: setterToken, method: 'POST', body: { survivorId: IDS.surv, duplicateId: IDS.dup, confirmAccountConflict: true } });
  check('merge with confirm → 200', merged.status, 200);
  check('merge moved.bookings matches preview', merged.json?.data?.moved?.bookings, 1);
  check('survivor LTV in merge response = combined', merged.json?.data?.survivor?.lifetimeValueCents, 37400);
  check('survivor bookingsCount after merge', merged.json?.data?.survivor?.bookingsCount, 2);

  const after = (await api(`/crm/customers/${IDS.surv}`, { token: setterToken })).json?.data;
  check('survivor LTV after merge (totals preserved)', after?.customer?.lifetimeValueCents, 37400);
  checkTrue('duplicate booking now on the survivor', (after?.bookings || []).some((b) => b.referenceCode === REF_D));
  checkTrue('mergedRecords names the duplicate', (after?.mergedRecords || []).some((t) => t.id === IDS.dup));
  checkTrue('merge note is on the survivor', (after?.notes || []).some((n) => String(n.body).includes('Duplicate record merged into this one')));
  checkTrue('duplicate note moved to the survivor', (after?.notes || []).some((n) => n.body === 'Duplicate note body'));
  checkTrue('duplicate garage appliance now on the survivor', (after?.appliances || []).some((a) => a.brand === 'LG'));
  check('survivor referral code is the duplicate code', after?.referrals?.ownCode?.code, 'TS-REF-DUP1');
  const tlAfter = after?.timeline || [];
  checkTrue('timeline after: duplicate inbound text joined via alias', tlAfter.some((e) => e.kind === 'MESSAGE' && String(e.title).includes('Inbound text')));
  checkTrue('timeline after: duplicate outbox text joined via alias', tlAfter.some((e) => String(e.title).includes('APPOINTMENT_REMINDER')));
  checkTrue('timeline after: duplicate payment present', hasKind(tlAfter, 'PAYMENT', '$50.00'));
  checkTrue('timeline after: duplicate receipt present', hasKind(tlAfter, 'RECEIPT', '$15.00'));
  checkTrue('timeline after: duplicate inbox email present', tlAfter.some((e) => e.kind === 'EMAIL' && String(e.title).includes('Washer question')));
  checkTrue('timeline after: PENDING payment never appears', !tlAfter.some((e) => e.kind === 'PAYMENT' && String(e.title).includes('$70.00')));

  const dupDetail = (await api(`/crm/customers/${IDS.dup}`, { token: setterToken })).json?.data;
  check('duplicate detail signposts to the survivor', dupDetail?.mergedInto?.id, IDS.surv);
  check('duplicate detail has no bookings of its own', (dupDetail?.bookings || []).length, 0);

  const listAll = (await api('/crm/customers', { token: setterToken })).json?.data;
  checkTrue('customer list excludes the tombstone', !(listAll?.customers || []).some((c) => c.id === IDS.dup));
  const listAlias = (await api(`/crm/customers?q=${PHONE_D}`, { token: setterToken })).json?.data;
  const aliasHit = (listAlias?.customers || []).find((c) => c.id === IDS.surv);
  checkTrue('search by duplicate phone finds the survivor', Boolean(aliasHit));
  check('alias match is marked', aliasHit?.matchedViaMergedRecord?.name, 'Mary Merge Dup');

  const again = await api('/crm/customers/merge', { token: setterToken, method: 'POST', body: { survivorId: IDS.surv, duplicateId: IDS.dup, confirmAccountConflict: true } });
  check('second merge of the tombstone → 400', again.status, 400);
  check('second merge carries ALREADY_MERGED', again.json?.code, 'ALREADY_MERGED');

  // ---- Database truth --------------------------------------------------
  const dupRow = await prisma.customer.findUnique({ where: { id: IDS.dup } });
  check('DB: tombstone pointer set', dupRow?.mergedIntoId, IDS.surv);
  const bookRow = await prisma.serviceRequest.findUnique({ where: { id: IDS.bookD } });
  check('DB: duplicate booking re-pointed', bookRow?.customerId, IDS.surv);
  const bookSRow = await prisma.serviceRequest.findUnique({ where: { id: IDS.bookS } });
  check('DB: referredBy re-pointed', bookSRow?.referredByCustomerId, IDS.surv);
  const payRow = await prisma.payment.findUnique({ where: { id: IDS.payD1 } });
  check('DB: duplicate payment re-pointed', payRow?.customerId, IDS.surv);
  const applianceRow = await prisma.customerAppliance.findUnique({ where: { id: IDS.applianceDup } });
  check('DB: garage appliance re-pointed to the survivor account', applianceRow?.userId, IDS.survUser);
  const eventRow = await prisma.platformEvent.findFirst({ where: { type: 'CUSTOMER_MERGED', entityId: IDS.surv } });
  checkTrue('DB: CUSTOMER_MERGED platform event logged', eventRow);
  check('DB: event details carry the duplicate id', eventRow?.details?.duplicateId, IDS.dup);
  check('DB: event details carry moved bookings', eventRow?.details?.moved?.bookings, 1);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (server) server.kill('SIGTERM');
    await prisma.$disconnect();
  });
