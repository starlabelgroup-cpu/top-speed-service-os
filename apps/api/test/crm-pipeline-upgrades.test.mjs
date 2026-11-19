/**
 * CRM upgrades (2026-11-19, Ramone approved) — the two additions from
 * the CRM prototype review, built onto the live records:
 *
 *  1. Leads & Pipeline (GET /crm/pipeline, POST
 *     /crm/pipeline/:connectionId/stage): the board assembles ONLY
 *     the lead-type Connections (the LEAD_TYPES set), joined to their
 *     bookings by the established link (booking.lead.
 *     connectionReference / the BOOKING_CREATED history entry).
 *     Drilled here: NEW derivation, ESTIMATE via a real estimate,
 *     WON via a fully paid invoice AND via a completed booking
 *     (seeded cold-start shape — history join, no in-memory lead),
 *     a stored stage overriding the derivation, stage POST
 *     validation / 404 / gates, non-lead types excluded, and the
 *     stored stage landing in the database.
 *  2. Customer lifetime value + status flag: LTV is exact against
 *     seeded money (a PAID Payment row + recorded receipts across
 *     two bookings; a PENDING payment never counts; zero-payment
 *     customers read a true 0), the flag POST sets / changes /
 *     clears with validation, and the pre-existing /crm/customers
 *     list + detail responses keep every field they had.
 *
 * Runs against a LOCAL test database only. Usage:
 *   DATABASE_URL=postgresql://... node test/crm-pipeline-upgrades.test.mjs
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

const PORT = Number(process.env.TEST_PORT || 4491);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const PASSWORD = 'test-pass-1234';
const DRILL_JWT = ['crmup', 'drill', 'jwt', 'secret'].join('-');

const IDS = {
  owner: '90000000-0000-4000-8000-0000000000c1',
  setter: '90000000-0000-4000-8000-0000000000c2',
  customerUser: '90000000-0000-4000-8000-0000000000c3',
  custA: 'a0000000-0000-4000-8000-0000000000a1',
  custB: 'a0000000-0000-4000-8000-0000000000a2',
  custC: 'a0000000-0000-4000-8000-0000000000a3',
  custD: 'a0000000-0000-4000-8000-0000000000a4',
  custE: 'a0000000-0000-4000-8000-0000000000a5',
  bookA1: 'b0000000-0000-4000-8000-0000000000a1',
  bookA2: 'b0000000-0000-4000-8000-0000000000a2',
  bookC1: 'b0000000-0000-4000-8000-0000000000a3',
  bookD: 'b0000000-0000-4000-8000-0000000000a4',
  bookE: 'b0000000-0000-4000-8000-0000000000a5',
  connDone: 'd0000000-0000-4000-8000-0000000000a4',
  connStored: 'd0000000-0000-4000-8000-0000000000a5',
  payA1: 'e0000000-0000-4000-8000-0000000000a1',
  payA2: 'e0000000-0000-4000-8000-0000000000a2',
};
const EMAILS = {
  owner: 'crmup-owner@test.local',
  setter: 'crmup-setter@test.local',
  customerUser: 'crmup-customer@test.local',
};
const REF_DONE = 'TS-DRILLDONE';
const REF_STORED = 'TS-DRILLSTOR';

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

const isoDaysAgo = (days) => new Date(Date.now() - days * 86400000).toISOString();

async function seed() {
  const passwordHash = await hashPassword(PASSWORD);
  await prisma.company.upsert({
    where: { id: PLATFORM_COMPANY_ID }, update: {},
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'crmup-platform', type: 'PLATFORM_OWNER', isPlatformOwner: true },
  });
  const users = [
    [IDS.owner, EMAILS.owner, ['COMPANY_OWNER']],
    [IDS.setter, EMAILS.setter, ['DISPATCHER']],
    [IDS.customerUser, EMAILS.customerUser, ['CUSTOMER']],
  ];
  for (const [id, email, roles] of users) {
    await prisma.user.upsert({
      where: { id },
      update: { passwordHash },
      create: { id, companyId: PLATFORM_COMPANY_ID, email, passwordHash, phone: '9545550110', roles, active: true },
    });
  }

  // --- LTV fixtures -------------------------------------------------
  // Customer A: booking A1 carries a PAID $99 Stripe payment; booking
  // A2 carries two recorded receipts ($210 + $15) and one PENDING
  // payment that must never count. Expected LTV: 9900+21000+1500.
  await prisma.customer.create({
    data: { id: IDS.custA, companyId: PLATFORM_COMPANY_ID, name: 'Ltv Anna', phone: '9545550201', email: 'anna@test.local', city: 'Lauderhill', zip: '33311' },
  });
  await prisma.serviceRequest.create({
    data: {
      id: IDS.bookA1, companyId: PLATFORM_COMPANY_ID, customerId: IDS.custA, city: 'Lauderhill', zip: '33311',
      appliance: 'Refrigerator', issue: 'Not cooling', referenceCode: 'TS-LTVA1', status: 'CONFIRMED', history: [],
    },
  });
  await prisma.payment.create({
    data: {
      id: IDS.payA1, companyId: PLATFORM_COMPANY_ID, serviceRequestId: IDS.bookA1, customerId: IDS.custA,
      purpose: 'DIAGNOSTIC', amountCents: 9900, status: 'PAID', paidAt: new Date(),
    },
  });
  await prisma.serviceRequest.create({
    data: {
      id: IDS.bookA2, companyId: PLATFORM_COMPANY_ID, customerId: IDS.custA, city: 'Lauderhill', zip: '33311',
      appliance: 'Washer', issue: 'Leaks', referenceCode: 'TS-LTVA2', status: 'COMPLETED',
      history: [
        { type: 'RECEIPT_RECORDED', actor: 'drill', at: isoDaysAgo(3), receipt: { id: 'rcpt-1', method: 'CASH', amountCents: 21000, at: isoDaysAgo(3), recordedBy: 'drill' } },
        { type: 'RECEIPT_RECORDED', actor: 'drill', at: isoDaysAgo(2), receipt: { id: 'rcpt-2', method: 'ZELLE', amountCents: 1500, at: isoDaysAgo(2), recordedBy: 'drill' } },
      ],
    },
  });
  await prisma.payment.create({
    data: {
      id: IDS.payA2, companyId: PLATFORM_COMPANY_ID, serviceRequestId: IDS.bookA2, customerId: IDS.custA,
      purpose: 'DIAGNOSTIC', amountCents: 5000, status: 'PENDING',
    },
  });
  // Customer B: no bookings at all — a true $0.
  await prisma.customer.create({
    data: { id: IDS.custB, companyId: PLATFORM_COMPANY_ID, name: 'Zero Zelda', phone: '9545550202', email: 'zelda@test.local', city: 'Davie', zip: '33314' },
  });
  // Customer C: a booking, but no money ever received — also $0.
  await prisma.customer.create({
    data: { id: IDS.custC, companyId: PLATFORM_COMPANY_ID, name: 'Nopay Ned', phone: '9545550203', email: 'ned@test.local', city: 'Davie', zip: '33314' },
  });
  await prisma.serviceRequest.create({
    data: {
      id: IDS.bookC1, companyId: PLATFORM_COMPANY_ID, customerId: IDS.custC, city: 'Davie', zip: '33314',
      appliance: 'Dryer', issue: 'No heat', referenceCode: 'TS-LTVC1', status: 'PENDING_DISPATCH', history: [],
    },
  });

  // --- Pipeline derivation fixtures (cold-start shape) --------------
  // Customer D + a COMPLETED booking whose ONLY lead link is the
  // BOOKING_CREATED history entry (what a hydrated record looks
  // like) → the board must derive WON.
  await prisma.customer.create({
    data: { id: IDS.custD, companyId: PLATFORM_COMPANY_ID, name: 'Done Dana', phone: '9545550204', email: 'dana@test.local', city: '', zip: '' },
  });
  await prisma.connection.create({
    data: {
      id: IDS.connDone, name: 'Done Dana', phone: '9545550204', email: 'dana@test.local',
      type: 'SERVICE_REQUEST', source: 'drill', message: 'Fridge warm', reference: REF_DONE,
    },
  });
  await prisma.serviceRequest.create({
    data: {
      id: IDS.bookD, companyId: PLATFORM_COMPANY_ID, customerId: IDS.custD, city: '', zip: '',
      appliance: 'Refrigerator', issue: 'Fridge warm', referenceCode: 'TS-DJOB1', status: 'COMPLETED',
      history: [
        { type: 'BOOKING_CREATED', actor: 'lead-intake', at: isoDaysAgo(5), connectionId: IDS.connDone, connectionReference: REF_DONE, connectionType: 'SERVICE_REQUEST', segment: 'RESIDENTIAL' },
      ],
    },
  });
  // Customer E + a lead booking WITH an estimate on file, but the
  // connection carries a stored CONTACTED stage → stored wins.
  await prisma.customer.create({
    data: { id: IDS.custE, companyId: PLATFORM_COMPANY_ID, name: 'Stored Stella', phone: '9545550205', email: 'stella@test.local', city: '', zip: '' },
  });
  await prisma.connection.create({
    data: {
      id: IDS.connStored, name: 'Stored Stella', phone: '9545550205', email: 'stella@test.local',
      type: 'COMMERCIAL_ACCOUNT_REQUEST', source: 'drill', message: 'Walk-in cooler', reference: REF_STORED,
      pipelineStage: 'CONTACTED',
    },
  });
  await prisma.serviceRequest.create({
    data: {
      id: IDS.bookE, companyId: PLATFORM_COMPANY_ID, customerId: IDS.custE, city: '', zip: '',
      appliance: 'Walk-in cooler', issue: 'Walk-in cooler', referenceCode: 'TS-EJOB1', status: 'CONFIRMED', source: 'COMMERCIAL',
      history: [
        { type: 'BOOKING_CREATED', actor: 'lead-intake', at: isoDaysAgo(4), connectionId: IDS.connStored, connectionReference: REF_STORED, connectionType: 'COMMERCIAL_ACCOUNT_REQUEST', segment: 'COMMERCIAL' },
        { type: 'ESTIMATE_SAVED', actor: 'drill', at: isoDaysAgo(3), estimate: { id: 'est-drill-1', version: 1, kind: 'REPAIR', totalCents: 45000 } },
      ],
    },
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

const boardRow = (board, reference) => {
  for (const col of board?.columns || []) {
    const hit = (col.leads || []).find((l) => l.reference === reference);
    if (hit) return { ...hit, columnStage: col.stage };
  }
  return null;
};
const boardColumn = (board, stage) => (board?.columns || []).find((c) => c.stage === stage) || null;

async function main() {
  await seed();
  server = startServer();
  await waitForServer();

  check('health 200', (await api('/health')).status, 200);
  check('payments/status 200', (await api('/payments/status')).status, 200);

  const ownerToken = await login(EMAILS.owner);
  const setterToken = await login(EMAILS.setter);
  const customerToken = await login(EMAILS.customerUser);
  checkTrue('owner login returns a token', ownerToken);
  checkTrue('setter login returns a token', setterToken);
  checkTrue('customer login returns a token', customerToken);

  // ---- Gates -------------------------------------------------------
  check('GET /crm/pipeline anon → 401', (await api('/crm/pipeline')).status, 401);
  check('GET /crm/pipeline customer role → 403', (await api('/crm/pipeline', { token: customerToken })).status, 403);
  check('POST stage anon → 401', (await api(`/crm/pipeline/${IDS.connDone}/stage`, { method: 'POST', body: { stage: 'LOST' } })).status, 401);
  check('POST flag anon → 401', (await api(`/crm/customers/${IDS.custA}/flag`, { method: 'POST', body: { flag: 'PRIORITY' } })).status, 401);
  check('POST flag customer role → 403', (await api(`/crm/customers/${IDS.custA}/flag`, { token: customerToken, method: 'POST', body: { flag: 'PRIORITY' } })).status, 403);

  // ---- Seeded derivations ------------------------------------------
  const board1 = (await api('/crm/pipeline', { token: setterToken })).json?.data;
  checkTrue('pipeline board returns columns', Array.isArray(board1?.columns));
  check('board column order', (board1?.columns || []).map((c) => c.stage).join(','), 'NEW,CONTACTED,ESTIMATE,WON,LOST');
  check('board totalLeads counts only the seeded leads', board1?.totalLeads, 2);

  const doneRow = boardRow(board1, REF_DONE);
  checkTrue('completed-booking lead is on the board', doneRow);
  check('completed booking derives WON', doneRow?.stage, 'WON');
  check('derived WON is not a stored stage', doneRow?.stageStored, false);
  check('WON lead links its customer', doneRow?.customerId, IDS.custD);
  check('WON lead links its booking', doneRow?.bookingReference, 'TS-DJOB1');
  check('WON lead value is null (no estimate/invoice)', doneRow?.valueCents, null);

  const storedRow = boardRow(board1, REF_STORED);
  checkTrue('stored-stage lead is on the board', storedRow);
  check('stored CONTACTED overrides the estimate derivation', storedRow?.stage, 'CONTACTED');
  check('stored stage reports stageStored', storedRow?.stageStored, true);
  check('estimate value rides the row even in CONTACTED', storedRow?.valueCents, 45000);
  check('CONTACTED column sums the known value', boardColumn(board1, 'CONTACTED')?.valueCents, 45000);
  check('NEW column has no known value yet → null', boardColumn(board1, 'NEW')?.valueCents, null);

  // ---- Live lead flow: NEW → ESTIMATE → WON (paid) ------------------
  const lead1 = await api('/connections', {
    method: 'POST',
    body: { type: 'SERVICE_REQUEST', name: 'Fresh Fred', email: 'fred@test.local', phone: '9545550211', source: 'drill', message: 'Oven will not heat' },
  });
  check('lead 1 intake → 201', lead1.status, 201);
  const refLead1 = lead1.json?.data?.reference || '';

  const lead2 = await api('/connections', {
    method: 'POST',
    body: { type: 'SERVICE_REQUEST', name: 'Money Mona', email: 'mona@test.local', phone: '9545550212', source: 'drill', message: 'Appliance: Refrigerator\nFridge not cooling' },
  });
  check('lead 2 intake → 201', lead2.status, 201);
  const refLead2 = lead2.json?.data?.reference || '';

  const board2 = (await api('/crm/pipeline', { token: setterToken })).json?.data;
  const lead1Row = boardRow(board2, refLead1);
  check('fresh lead derives NEW', lead1Row?.stage, 'NEW');
  check('fresh lead value is null — never invented', lead1Row?.valueCents, null);
  checkTrue('fresh lead carries its linked booking id', lead1Row?.bookingId);
  check('fresh lead type label is human', lead1Row?.typeLabel, 'Service request');
  const lead2Row = boardRow(board2, refLead2);
  checkTrue('lead 2 carries its linked booking id', lead2Row?.bookingId);
  check('lead 2 service comes from the booking', lead2Row?.service, 'Refrigerator');

  const estimate = await api(`/bookos/bookings/${lead2Row.bookingId}/estimate`, {
    token: setterToken, method: 'POST', body: { kind: 'REPAIR' },
  });
  check('estimate save → 201', estimate.status, 201);
  check('estimate total is the Launch Pack math ($210 labor − $99 credit)', estimate.json?.data?.estimate?.totalCents, 11100);

  const board3 = (await api('/crm/pipeline', { token: setterToken })).json?.data;
  const lead2Est = boardRow(board3, refLead2);
  check('estimate on the job derives ESTIMATE', lead2Est?.stage, 'ESTIMATE');
  check('ESTIMATE row value is the estimate total', lead2Est?.valueCents, 11100);
  check('ESTIMATE column sums the known value', boardColumn(board3, 'ESTIMATE')?.valueCents, 11100);

  const decision = await api(`/bookos/bookings/${lead2Row.bookingId}/estimate/decision`, {
    token: setterToken, method: 'POST', body: { decision: 'APPROVED', method: 'PHONE' },
  });
  check('estimate decision → 201', decision.status, 201);
  const invoice = await api(`/bookos/bookings/${lead2Row.bookingId}/invoice`, { token: setterToken, method: 'POST', body: {} });
  check('invoice generate → 201', invoice.status, 201);
  const receipt = await api(`/bookos/bookings/${lead2Row.bookingId}/receipts`, {
    token: setterToken, method: 'POST', body: { method: 'CASH', amountCents: 11100 },
  });
  check('full receipt → 201', receipt.status, 201);

  const board4 = (await api('/crm/pipeline', { token: setterToken })).json?.data;
  const lead2Won = boardRow(board4, refLead2);
  check('fully paid invoice derives WON (job not completed)', lead2Won?.stage, 'WON');
  check('WON row value stays the real figure', lead2Won?.valueCents, 11100);

  // ---- Non-lead intake never reaches the board -----------------------
  const providerApp = await api('/connections', {
    method: 'POST',
    body: { type: 'PROVIDER_APPLICATION', name: 'Pro Pete', email: 'pete@test.local', phone: '9545550213', source: 'drill', message: 'I fix things' },
  });
  check('provider application intake → 201', providerApp.status, 201);
  const advertiser = await api('/connections', {
    method: 'POST',
    body: { type: 'ADVERTISER_CONTACT', name: 'Ad Ada', email: 'ada@test.local', phone: '9545550214', source: 'drill', message: 'Buy ads' },
  });
  check('advertiser contact intake → 201', advertiser.status, 201);

  const board5 = (await api('/crm/pipeline', { token: ownerToken })).json?.data;
  check('board totalLeads still counts only lead types', board5?.totalLeads, 4);
  check('provider application is not on the board', boardRow(board5, providerApp.json?.data?.reference || ''), null);
  check('advertiser contact is not on the board', boardRow(board5, advertiser.json?.data?.reference || ''), null);

  const allConnections = (await api('/connections', { token: setterToken })).json?.data || [];
  const providerConn = allConnections.find((c) => c.reference === providerApp.json?.data?.reference);
  checkTrue('provider application exists in the intake list', providerConn);
  check(
    'stage POST on a non-lead connection → 404',
    (await api(`/crm/pipeline/${providerConn.id}/stage`, { token: setterToken, method: 'POST', body: { stage: 'LOST' } })).status,
    404,
  );

  // ---- Stage moves ----------------------------------------------------
  const lead1Conn = allConnections.find((c) => c.reference === refLead1);
  checkTrue('lead 1 exists in the intake list', lead1Conn);
  const move = await api(`/crm/pipeline/${lead1Conn.id}/stage`, { token: setterToken, method: 'POST', body: { stage: 'LOST' } });
  check('stage move → 200', move.status, 200);
  check('stage move returns the updated row at LOST', move.json?.data?.lead?.stage, 'LOST');
  check('stage move row reports the stored stage', move.json?.data?.lead?.stageStored, true);
  const board6 = (await api('/crm/pipeline', { token: setterToken })).json?.data;
  check('board shows the lead under LOST after the move', boardRow(board6, refLead1)?.columnStage, 'LOST');
  const dbConn = await prisma.connection.findUnique({ where: { id: lead1Conn.id } });
  check('stored stage persisted to the database', dbConn?.pipelineStage, 'LOST');

  check('stage POST invalid stage → 400', (await api(`/crm/pipeline/${lead1Conn.id}/stage`, { token: setterToken, method: 'POST', body: { stage: 'VIP' } })).status, 400);
  check('stage POST missing stage → 400', (await api(`/crm/pipeline/${lead1Conn.id}/stage`, { token: setterToken, method: 'POST', body: {} })).status, 400);
  check('stage POST unknown connection → 404', (await api('/crm/pipeline/f0000000-0000-4000-8000-000000000099/stage', { token: setterToken, method: 'POST', body: { stage: 'NEW' } })).status, 404);
  const moveBack = await api(`/crm/pipeline/${lead1Conn.id}/stage`, { token: setterToken, method: 'POST', body: { stage: 'CONTACTED' } });
  check('a stored stage can be changed again', moveBack.json?.data?.lead?.stage, 'CONTACTED');

  // ---- Lifetime value + customer flag ---------------------------------
  const list = (await api('/crm/customers', { token: setterToken })).json?.data;
  const sumA = (list?.customers || []).find((c) => c.id === IDS.custA);
  const sumB = (list?.customers || []).find((c) => c.id === IDS.custB);
  const sumC = (list?.customers || []).find((c) => c.id === IDS.custC);
  check('LTV sums PAID payments + receipts across bookings (PENDING excluded)', sumA?.lifetimeValueCents, 32400);
  check('LTV for a customer with no bookings is a true 0', sumB?.lifetimeValueCents, 0);
  check('LTV for a customer with no received money is a true 0', sumC?.lifetimeValueCents, 0);
  check('summary flag starts null (Active)', sumA?.crmFlag, null);
  for (const key of ['id', 'name', 'phone', 'email', 'city', 'zip', 'area', 'source', 'bookingsCount', 'lastBooking', 'createdAt']) {
    checkTrue(`list summary keeps pre-existing field ${key}`, sumA && key in sumA);
  }

  const detail = (await api(`/crm/customers/${IDS.custA}`, { token: setterToken })).json?.data;
  check('detail carries the same LTV', detail?.customer?.lifetimeValueCents, 32400);
  check('detail carries the flag field', detail?.customer?.crmFlag, null);
  for (const key of ['customer', 'account', 'properties', 'appliances', 'bookings', 'intake', 'communications', 'emails', 'referrals', 'notes']) {
    checkTrue(`detail keeps pre-existing section ${key}`, detail && key in detail);
  }

  const flagSet = await api(`/crm/customers/${IDS.custA}/flag`, { token: setterToken, method: 'POST', body: { flag: 'PRIORITY' } });
  check('flag set → 200', flagSet.status, 200);
  check('flag set returns PRIORITY', flagSet.json?.data?.customer?.crmFlag, 'PRIORITY');
  check('flag response keeps the LTV alongside', flagSet.json?.data?.customer?.lifetimeValueCents, 32400);
  const dbCust = await prisma.customer.findUnique({ where: { id: IDS.custA } });
  check('flag persisted to the database', dbCust?.crmFlag, 'PRIORITY');
  const list2 = (await api('/crm/customers', { token: setterToken })).json?.data;
  check('list shows the set flag', (list2?.customers || []).find((c) => c.id === IDS.custA)?.crmFlag, 'PRIORITY');

  const flagFollow = await api(`/crm/customers/${IDS.custA}/flag`, { token: ownerToken, method: 'POST', body: { flag: 'FOLLOW_UP' } });
  check('flag can change to FOLLOW_UP', flagFollow.json?.data?.customer?.crmFlag, 'FOLLOW_UP');
  const flagClear = await api(`/crm/customers/${IDS.custA}/flag`, { token: setterToken, method: 'POST', body: { flag: null } });
  check('flag clears back to Active (null)', flagClear.json?.data?.customer?.crmFlag, null);
  check('flag POST invalid value → 400', (await api(`/crm/customers/${IDS.custA}/flag`, { token: setterToken, method: 'POST', body: { flag: 'VIP' } })).status, 400);
  check('flag POST missing flag → 400', (await api(`/crm/customers/${IDS.custA}/flag`, { token: setterToken, method: 'POST', body: {} })).status, 400);
  check('flag POST unknown customer → 404', (await api('/crm/customers/f0000000-0000-4000-8000-000000000099/flag', { token: setterToken, method: 'POST', body: { flag: 'PRIORITY' } })).status, 404);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}

main()
  .catch((error) => {
    console.error('DRILL ERROR', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (server) server.kill('SIGTERM');
    await prisma.$disconnect();
  });
