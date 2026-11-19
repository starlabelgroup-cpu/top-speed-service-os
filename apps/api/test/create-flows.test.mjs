/**
 * Create flows + upgraded tech menu — verification harness (2026-11-19).
 *
 * Ramone's directives 1–4 and 6–8, exercised end to end over HTTP:
 * work orders ORIGINATE inside the apps (Tech App, Book OS, CRM,
 * dispatch dashboard) and land on the SAME Service OS records — no
 * silo. The money chain (estimate → decision → invoice → receipt,
 * overpayment refused) runs from BOTH the Tech App and Book OS
 * against one shared implementation. Dispatch is ONE pipeline:
 * setters dispatch to company crew and network providers from the
 * same board, with the side attributed on every target. Settings
 * write the tech's real records. Overview buckets carry every job
 * for the bucket pages.
 *
 * Runs against a LOCAL test database only. Usage:
 *   DATABASE_URL=postgresql://... node test/create-flows.test.mjs
 * Exit code 0 = every check passed.
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/services/passwords.js';
import { PLATFORM_COMPANY_ID, store } from '../src/data/store.js';
import { persistAssignment, persistBooking, persistCustomer } from '../src/db/bookingsRepo.js';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required (point it at a local TEST database).');
  process.exit(2);
}
process.env.DATABASE_URL_UNPOOLED ||= process.env.DATABASE_URL;

const PORT = Number(process.env.TEST_PORT || 4431);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const PASSWORD = 'test-pass-1234';

const GAMMA_COMPANY = '20000000-0000-4000-8000-000000000003';
const GAMMA_PROVIDER = '30000000-0000-4000-8000-000000000003';
const IDS = {
  coA: '40000000-0000-4000-8000-0000000000a1',
  provA: '40000000-0000-4000-8000-0000000000a2',
  techA: '40000000-0000-4000-8000-0000000000a3',
  coB: '40000000-0000-4000-8000-0000000000b1',
  provB: '40000000-0000-4000-8000-0000000000b2',
  techB: '40000000-0000-4000-8000-0000000000b3',
  setter: '40000000-0000-4000-8000-0000000000c1',
  owner: '40000000-0000-4000-8000-0000000000c2',
  customerUser: '40000000-0000-4000-8000-0000000000c3',
  crewTech: '40000000-0000-4000-8000-0000000000c4',
  cust1: '40000000-0000-4000-8000-0000000000d1',
  bk1: '40000000-0000-4000-8000-0000000000d2',
  as1: '40000000-0000-4000-8000-0000000000d3',
};
const BUCKETS = {
  offer: ['40000000-0000-4000-8000-0000000000e1', '40000000-0000-4000-8000-0000000000e2'],
  progress: ['40000000-0000-4000-8000-0000000000e3', '40000000-0000-4000-8000-0000000000e4'],
  parts: ['40000000-0000-4000-8000-0000000000e5', '40000000-0000-4000-8000-0000000000e6'],
  diagnosis: ['40000000-0000-4000-8000-0000000000e7', '40000000-0000-4000-8000-0000000000e8'],
  done: ['40000000-0000-4000-8000-0000000000e9', '40000000-0000-4000-8000-0000000000ea'],
};

const prisma = new PrismaClient();
let server = null;
let failures = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}
function checkTrue(label, value) { check(label, Boolean(value), true); }

async function api(path, { token, method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
}

async function login(email) {
  const { status, json } = await api('/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  if (status !== 200 || !json?.token) throw new Error(`login failed for ${email}: ${status} ${JSON.stringify(json)}`);
  return json.token;
}

async function seed() {
  const passwordHash = await hashPassword(PASSWORD);
  await prisma.company.upsert({
    where: { id: PLATFORM_COMPANY_ID }, update: {},
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'cf-platform', type: 'PLATFORM_OWNER', isPlatformOwner: true },
  });
  await prisma.company.upsert({
    where: { id: GAMMA_COMPANY }, update: {},
    create: { id: GAMMA_COMPANY, name: 'Top Speed Field Team Co', slug: 'cf-gamma', type: 'INDEPENDENT_PROVIDER' },
  });
  for (const [id, name, slug] of [[IDS.coA, 'CreateFlow Provider A Co', 'cf-prov-a'], [IDS.coB, 'CreateFlow Provider B Co', 'cf-prov-b']]) {
    await prisma.company.upsert({ where: { id }, update: {}, create: { id, name, slug, type: 'INDEPENDENT_PROVIDER' } });
  }
  await prisma.provider.upsert({
    where: { id: GAMMA_PROVIDER },
    update: { companyCrew: true },
    create: {
      id: GAMMA_PROVIDER, companyId: GAMMA_COMPANY, businessName: 'Top Speed Field Team', type: 'INDEPENDENT_PROVIDER',
      specialties: ['Refrigerator', 'Washer', 'Dryer'], serviceCities: ['Fort Lauderdale', 'Sunrise'], companyCrew: true,
    },
  });
  for (const [id, companyId, name] of [[IDS.provA, IDS.coA, 'CreateFlow Provider A'], [IDS.provB, IDS.coB, 'CreateFlow Provider B']]) {
    await prisma.provider.upsert({
      where: { id }, update: {},
      create: { id, companyId, businessName: name, type: 'NETWORK_BUSINESS', specialties: ['Refrigerator', 'Washer'], serviceCities: ['Fort Lauderdale', 'Davie'] },
    });
  }
  for (const [id, companyId, email, roles] of [
    [IDS.techA, IDS.coA, 'cf-tech-a@test.local', ['PROVIDER_TECH']],
    [IDS.techB, IDS.coB, 'cf-tech-b@test.local', ['PROVIDER_TECH']],
    [IDS.setter, PLATFORM_COMPANY_ID, 'cf-setter@test.local', ['DISPATCHER']],
    [IDS.owner, PLATFORM_COMPANY_ID, 'cf-owner@test.local', ['COMPANY_OWNER']],
    [IDS.customerUser, PLATFORM_COMPANY_ID, 'cf-customer@test.local', ['CUSTOMER']],
    [IDS.crewTech, PLATFORM_COMPANY_ID, 'cf-crew@test.local', ['TECHNICIAN']],
  ]) {
    await prisma.user.upsert({
      where: { id }, update: { passwordHash, verifyRequired: false, layer2Required: false },
      create: { id, companyId, email, passwordHash, phone: '9545550110', roles, active: true },
    });
  }

  const now = new Date().toISOString();
  const cust1 = {
    id: IDS.cust1, companyId: PLATFORM_COMPANY_ID, userId: null,
    name: 'CreateFlow Existing Customer', phone: '9545550199', email: 'cf-existing@test.local',
    address: '100 Test Way', city: 'Fort Lauderdale', zip: '33311', createdAt: now,
  };
  store.customers.set(cust1.id, cust1);
  await persistCustomer(cust1);

  // BK1: tech A's accepted job — the money-chain stage.
  const bk1 = {
    id: IDS.bk1, companyId: PLATFORM_COMPANY_ID, customerId: cust1.id, customer: cust1,
    referenceCode: 'TS-CF0001', source: 'TEST', segment: 'RESIDENTIAL',
    city: 'Fort Lauderdale', zip: '33311', area: 'Fort Lauderdale', areaStatus: 'IN_AREA',
    serviceAddress: '100 Test Way', appliance: 'Refrigerator', issue: 'Not cooling',
    preferredWindow: null, diagnosticFee: 99, diagnosticFeeCurrency: 'USD', diagnosticFeeCreditedTowardRepair: true,
    feeStatus: 'not_collected', status: 'CONFIRMED',
    dispatch: { mode: 'HYBRID', stage: 'ASSIGNED_TO_PROVIDER', candidateProviderIds: [], assignmentIds: [IDS.as1] },
    history: [], createdAt: now, updatedAt: now,
  };
  const as1 = {
    id: IDS.as1, companyId: PLATFORM_COMPANY_ID, bookingId: bk1.id,
    providerId: IDS.provA, providerCompanyId: IDS.coA,
    status: 'ACCEPTED', dispatchMode: 'HYBRID', approvalRequired: true,
    approvedBy: 'cf-setter@test.local', approvedAt: now, acceptedAt: now, createdAt: now, updatedAt: now,
  };
  store.bookings.set(bk1.id, bk1);
  store.dispatchAssignments.set(as1.id, as1);
  await persistBooking(bk1);
  await persistAssignment(as1);

  // Bucket fixtures for tech A (Directive 7).
  const bucketDefs = [
    [BUCKETS.offer, 'APPROVED', 'CONFIRMED', []],
    [BUCKETS.progress, 'ACCEPTED', 'CONFIRMED', [{ type: 'TECH_WORK_STARTED', at: now, actor: 'cf-tech-a@test.local' }]],
    [BUCKETS.parts, 'ACCEPTED', 'CONFIRMED', [{ type: 'JOB_AWAITING_PARTS', at: now, actor: 'cf-tech-a@test.local' }]],
    [BUCKETS.diagnosis, 'ACCEPTED', 'CONFIRMED', [{ type: 'JOB_AWAITING_DIAGNOSIS', at: now, actor: 'cf-tech-a@test.local' }]],
    [BUCKETS.done, 'ACCEPTED', 'COMPLETED', []],
  ];
  for (const [[bkId, asId], aStatus, bStatus, history] of bucketDefs) {
    const bk = {
      id: bkId, companyId: PLATFORM_COMPANY_ID, customerId: cust1.id, customer: cust1,
      referenceCode: 'TS-CF' + bkId.slice(-4).toUpperCase(), source: 'TEST', segment: 'RESIDENTIAL',
      city: 'Fort Lauderdale', zip: '33311', area: 'Fort Lauderdale', areaStatus: 'IN_AREA',
      serviceAddress: '100 Test Way', appliance: 'Washer', issue: 'Bucket fixture',
      preferredWindow: null, diagnosticFee: 99, diagnosticFeeCurrency: 'USD', diagnosticFeeCreditedTowardRepair: true,
      feeStatus: 'not_collected', status: bStatus,
      ...(bStatus === 'COMPLETED' ? { completedAt: now } : {}),
      dispatch: { mode: 'HYBRID', stage: 'ASSIGNED_TO_PROVIDER', candidateProviderIds: [], assignmentIds: [asId] },
      history, createdAt: now, updatedAt: now,
    };
    const asg = {
      id: asId, companyId: PLATFORM_COMPANY_ID, bookingId: bkId,
      providerId: IDS.provA, providerCompanyId: IDS.coA,
      status: aStatus, dispatchMode: 'HYBRID', approvalRequired: true,
      approvedBy: 'cf-setter@test.local', approvedAt: now,
      ...(aStatus === 'ACCEPTED' ? { acceptedAt: now } : {}),
      createdAt: now, updatedAt: now,
    };
    store.bookings.set(bk.id, bk);
    store.dispatchAssignments.set(asg.id, asg);
    await persistBooking(bk);
    await persistAssignment(asg);
  }
}

async function cleanup() {
  try {
    const bookingIds = [IDS.bk1, ...Object.values(BUCKETS).map(([b]) => b)];
    const created = await prisma.serviceRequest.findMany({ where: { source: { in: ['OFFICE', 'TECH_APP'] } }, select: { id: true } });
    const allBookings = [...new Set([...bookingIds, ...created.map((r) => r.id)])];
    await prisma.invoice.deleteMany({ where: { serviceRequestId: { in: allBookings } } });
    await prisma.property.deleteMany({ where: { customerId: IDS.cust1 } });
    await prisma.dispatchAssignment.deleteMany({ where: { serviceRequestId: { in: allBookings } } });
    await prisma.serviceRequest.deleteMany({ where: { id: { in: allBookings } } });
    const createdCustomers = await prisma.customer.findMany({ where: { phone: { in: ['9545550142', '9545550160'] } }, select: { id: true } });
    await prisma.property.deleteMany({ where: { customerId: { in: createdCustomers.map((c) => c.id) } } });
    await prisma.customer.deleteMany({ where: { id: { in: [IDS.cust1, ...createdCustomers.map((c) => c.id)] } } });
    await prisma.user.deleteMany({ where: { id: { in: [IDS.techA, IDS.techB, IDS.setter, IDS.owner, IDS.customerUser, IDS.crewTech] } } });
    await prisma.provider.deleteMany({ where: { id: { in: [IDS.provA, IDS.provB] } } });
    await prisma.company.deleteMany({ where: { id: { in: [IDS.coA, IDS.coB] } } });
  } catch (error) {
    console.error('cleanup warning:', error.message);
  }
}

async function waitForServer() {
  for (let i = 0; i < 90; i += 1) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('server did not come up');
}

async function main() {
  await cleanup();
  await seed();
  server = spawn('node', ['src/server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      ...process.env,
      PORT: String(PORT),
      JWT_SECRET: 'create-flows-test-secret',
      DATABASE_URL: process.env.DATABASE_URL,
      DATABASE_URL_UNPOOLED: process.env.DATABASE_URL_UNPOOLED,
      OPENAI_API_KEY: '',
      OPENAI_API_KEY_V2: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[api] ${d}`));
  await waitForServer();

  const techA = await login('cf-tech-a@test.local');
  const techB = await login('cf-tech-b@test.local');
  const setter = await login('cf-setter@test.local');
  const owner = await login('cf-owner@test.local');
  const customer = await login('cf-customer@test.local');
  const crew = await login('cf-crew@test.local');

  // ---------- Gates ----------
  check('anon 401 POST /provider/work-orders', (await api('/provider/work-orders', { method: 'POST', body: {} })).status, 401);
  check('anon 401 GET /provider/customers', (await api('/provider/customers?q=954')).status, 401);
  check('anon 401 GET /provider/profile', (await api('/provider/profile')).status, 401);
  check('anon 401 POST /bookos/work-orders', (await api('/bookos/work-orders', { method: 'POST', body: {} })).status, 401);
  check('anon 401 GET /bookos/bookings/:id/money', (await api(`/bookos/bookings/${IDS.bk1}/money`)).status, 401);
  check('anon 401 POST /crm/customers/:id/work-orders', (await api(`/crm/customers/${IDS.cust1}/work-orders`, { method: 'POST', body: {} })).status, 401);
  check('customer 403 POST /provider/work-orders', (await api('/provider/work-orders', { token: customer, method: 'POST', body: {} })).status, 403);
  check('customer 403 POST /bookos/work-orders', (await api('/bookos/work-orders', { token: customer, method: 'POST', body: {} })).status, 403);
  check('tech 403 POST /bookos/work-orders (staff only)', (await api('/bookos/work-orders', { token: techA, method: 'POST', body: {} })).status, 403);
  check('setter 403 POST /provider/work-orders (provider only)', (await api('/provider/work-orders', { token: setter, method: 'POST', body: {} })).status, 403);

  // ---------- Tech App create (Directive 3) ----------
  const woSelf = await api('/provider/work-orders', {
    token: techA, method: 'POST',
    body: { customer: { name: 'Field Created Customer', phone: '9545550142' }, city: 'Fort Lauderdale', zip: '33311', address: '22 Field Rd', appliance: 'Dryer', issue: 'Not heating', assign: 'SELF' },
  });
  check('tech create WO (self) 201', woSelf.status, 201);
  check('tech WO status CONFIRMED', woSelf.json.data.booking.status, 'CONFIRMED');
  check('tech WO assignment ACCEPTED', woSelf.json.data.assignment?.status, 'ACCEPTED');
  check('tech WO assignment points at the booking', woSelf.json.data.assignment?.bookingId, woSelf.json.data.booking.id);
  checkTrue('tech WO has reference code', /^TS-/.test(woSelf.json.data.booking.referenceCode || ''));
  const ovA1 = await api('/provider/overview', { token: techA });
  checkTrue('tech WO visible on own dispatch board (accepted)',
    (ovA1.json.data.accepted || []).some((a) => a.bookingId === woSelf.json.data.booking.id));

  const woQueue = await api('/provider/work-orders', {
    token: techA, method: 'POST',
    body: { customer: { name: 'Queue Released Customer', phone: '9545550160' }, city: 'Sunrise', zip: '33351', appliance: 'Washer', issue: 'Leaking', assign: 'QUEUE' },
  });
  check('tech create WO (queue) 201', woQueue.status, 201);
  check('queue WO has no assignment', woQueue.json.data.assignment, null);
  check('queue WO status PENDING_DISPATCH', woQueue.json.data.booking.status, 'PENDING_DISPATCH');
  const queue1 = await api('/bookos/setter-queue', { token: setter });
  const queueRow = (queue1.json.data.queue || []).find((q) => q.bookingId === woQueue.json.data.booking.id);
  checkTrue('queue WO lands in the setter queue', Boolean(queueRow));
  check('queue WO source attributed TECH_APP', queueRow?.source, 'TECH_APP');

  // Phone dedupe: creating with the existing customer's phone reuses the record.
  const crmBefore = await api(`/crm/customers/${IDS.cust1}`, { token: setter });
  const bookingsBefore = (crmBefore.json.data.bookings || []).length;
  const woDedupe = await api('/provider/work-orders', {
    token: techA, method: 'POST',
    body: { customer: { name: 'CreateFlow Existing Customer', phone: '9545550199' }, city: 'Fort Lauderdale', zip: '33311', appliance: 'Oven / Range', issue: 'Not heating evenly', assign: 'QUEUE' },
  });
  check('dedupe WO 201', woDedupe.status, 201);
  check('dedupe WO customerCreated false', woDedupe.json.data.customerCreated, false);
  const crmAfter = await api(`/crm/customers/${IDS.cust1}`, { token: setter });
  check('CRM history grew by exactly the deduped job', (crmAfter.json.data.bookings || []).length, bookingsBefore + 1);

  // Customer lookup scoping.
  const lookA = await api('/provider/customers?q=9545550199', { token: techA });
  checkTrue('tech A finds the customer they worked', (lookA.json.data || []).some((c) => c.id === IDS.cust1));
  const lookB = await api('/provider/customers?q=9545550199', { token: techB });
  check('tech B cannot see tech A\u2019s customer', (lookB.json.data || []).length, 0);
  const lookSetter = await api('/bookos/customers?q=9545550199', { token: setter });
  checkTrue('setter finds the customer (whole book)', (lookSetter.json.data || []).some((c) => c.id === IDS.cust1));

  // ---------- Book OS create + dispatch unity (Directives 3 + 8) ----------
  const woOffice = await api('/bookos/work-orders', {
    token: setter, method: 'POST',
    body: { customerId: IDS.cust1, appliance: 'Dishwasher', issue: 'Not draining', city: 'Fort Lauderdale', zip: '33311' },
  });
  check('bookos create WO 201', woOffice.status, 201);
  check('bookos WO source OFFICE', woOffice.json.data.booking.source, 'OFFICE');
  const queue2 = await api('/bookos/setter-queue', { token: setter });
  const officeRow = (queue2.json.data.queue || []).find((q) => q.bookingId === woOffice.json.data.booking.id);
  checkTrue('office WO in setter queue', Boolean(officeRow));
  check('office WO queue source OFFICE', officeRow?.source, 'OFFICE');

  // Dispatch to a NETWORK provider from the same board.
  const woToB = await api('/bookos/work-orders', {
    token: setter, method: 'POST',
    body: { customerId: IDS.cust1, appliance: 'Refrigerator', issue: 'Warm fridge', providerId: IDS.provB },
  });
  check('bookos dispatch-to-network 201', woToB.status, 201);
  check('network assignment APPROVED (offer)', woToB.json.data.assignment?.status, 'APPROVED');
  const ovB = await api('/provider/overview', { token: techB });
  checkTrue('network provider sees the offer in Network Tech',
    (ovB.json.data.offers || []).some((a) => a.bookingId === woToB.json.data.booking.id));
  const ovA2 = await api('/provider/overview', { token: techA });
  checkTrue('provider A does NOT see provider B\u2019s offer',
    !(ovA2.json.data.offers || []).some((a) => a.bookingId === woToB.json.data.booking.id));

  // Dispatch to the COMPANY crew from the same board.
  const woToCrew = await api('/bookos/work-orders', {
    token: setter, method: 'POST',
    body: { customerId: IDS.cust1, appliance: 'Washer', issue: 'No spin', providerId: GAMMA_PROVIDER },
  });
  check('bookos dispatch-to-crew 201', woToCrew.status, 201);
  const ovCrew = await api('/provider/overview', { token: crew });
  checkTrue('company tech sees the offer in Company Tech',
    (ovCrew.json.data.offers || []).some((a) => a.bookingId === woToCrew.json.data.booking.id));
  checkTrue('company tech does NOT see the network offer',
    !(ovCrew.json.data.offers || []).some((a) => a.bookingId === woToB.json.data.booking.id));

  // Setter roster: both sides, attributed.
  const roster = await api('/bookos/providers', { token: setter });
  const rosterGamma = (roster.json.data || []).find((p) => p.id === GAMMA_PROVIDER);
  const rosterA = (roster.json.data || []).find((p) => p.id === IDS.provA);
  check('roster tags crew as COMPANY', rosterGamma?.system, 'COMPANY');
  check('roster tags provider A as NETWORK', rosterA?.system, 'NETWORK');
  const sugg = await api(`/bookos/bookings/${woOffice.json.data.booking.id}/assignment-suggestions`, { token: setter });
  checkTrue('assignment candidates carry a system tag',
    (sugg.json.data.candidates || []).length > 0 && (sugg.json.data.candidates || []).every((c) => c.system === 'COMPANY' || c.system === 'NETWORK'));

  // ---------- Money chain: Book OS originates, Tech App reads (one record) ----------
  const est = await api(`/bookos/bookings/${IDS.bk1}/estimate`, {
    token: setter, method: 'POST',
    body: { kind: 'REPAIR', parts: [{ description: 'Compressor relay', qty: 1, unitPriceCents: 4500 }], taxRatePercent: 7 },
  });
  check('bookos estimate 201', est.status, 201);
  check('estimate total = 21000+4500+315-9900', est.json.data.estimate.totalCents, 15915);
  const full = await api(`/provider/assignments/${IDS.as1}/full`, { token: techA });
  checkTrue('tech workspace reads the SAME estimate (15915)',
    JSON.stringify(full.json).includes('"totalCents":15915'));
  const dec = await api(`/bookos/bookings/${IDS.bk1}/estimate/decision`, {
    token: setter, method: 'POST', body: { decision: 'APPROVED', method: 'PHONE', authorizedByName: 'CreateFlow Existing Customer' },
  });
  check('bookos decision APPROVED 201', dec.status, 201);
  check('decision recorded APPROVED', dec.json.data.estimateDecision?.decision, 'APPROVED');
  const inv = await api(`/provider/assignments/${IDS.as1}/invoice`, { token: techA, method: 'POST', body: {} });
  check('tech generates invoice 201', inv.status, 201);
  check('invoice total 159.15', inv.json.data.invoice?.total, 159.15);
  const invAgain = await api(`/provider/assignments/${IDS.as1}/invoice`, { token: techA, method: 'POST', body: {} });
  check('invoice generation idempotent', invAgain.json.data?.created, false);
  const rc1 = await api(`/provider/assignments/${IDS.as1}/receipts`, {
    token: techA, method: 'POST', body: { method: 'CASH', amountCents: 10000 },
  });
  check('receipt 10000 recorded', rc1.status, 201);
  check('balance after partial receipt', rc1.json.data.payments?.balanceDueCents, 5915);
  const rcOver = await api(`/provider/assignments/${IDS.as1}/receipts`, {
    token: techA, method: 'POST', body: { method: 'CASH', amountCents: 5916 },
  });
  check('overpayment refused 409', rcOver.status, 409);
  check('overpayment refusal carries balance due', rcOver.json.balanceDueCents, 5915);
  const rc2 = await api(`/bookos/bookings/${IDS.bk1}/receipts`, {
    token: setter, method: 'POST', body: { method: 'ZELLE', amountCents: 5915 },
  });
  check('bookos records the closing receipt', rc2.status, 201);
  check('balance zero after closing receipt', rc2.json.data.payments?.balanceDueCents, 0);
  const moneyView = await api(`/bookos/bookings/${IDS.bk1}/money`, { token: setter });
  check('invoice PAID in the shared money view', moneyView.json.data.invoice?.status, 'PAID');
  check('receipts total in money view', moneyView.json.data.payments?.receiptsTotalCents, 15915);

  // Commercial: no $99 anywhere; labor required.
  const woComm = await api('/bookos/work-orders', {
    token: setter, method: 'POST',
    body: { customerId: IDS.cust1, segment: 'COMMERCIAL', appliance: 'Refrigerator', issue: 'Walk-in cooler warm' },
  });
  check('commercial WO 201', woComm.status, 201);
  const commNoLabor = await api(`/bookos/bookings/${woComm.json.data.booking.id}/estimate`, {
    token: setter, method: 'POST', body: { kind: 'REPAIR' },
  });
  check('commercial estimate without quoted labor refused', commNoLabor.status, 400);
  const commEst = await api(`/bookos/bookings/${woComm.json.data.booking.id}/estimate`, {
    token: setter, method: 'POST', body: { kind: 'REPAIR', laborCents: 50000 },
  });
  check('commercial estimate total = quoted labor only', commEst.json.data.estimate?.totalCents, 50000);
  check('commercial estimate diagnostic is 0', commEst.json.data.estimate?.diagnosticFeeCents, 0);
  check('commercial estimate credit is 0', commEst.json.data.estimate?.diagnosticCreditCents, 0);

  // ---------- CRM create ----------
  const woCrm = await api(`/crm/customers/${IDS.cust1}/work-orders`, {
    token: setter, method: 'POST',
    body: { appliance: 'Microwave', issue: 'Sparking inside' },
  });
  check('crm create WO 201', woCrm.status, 201);
  check('crm WO source OFFICE', woCrm.json.data.booking.source, 'OFFICE');
  const queue3 = await api('/bookos/setter-queue', { token: setter });
  checkTrue('crm WO lands in the setter queue',
    (queue3.json.data.queue || []).some((q) => q.bookingId === woCrm.json.data.booking.id));

  // ---------- Settings round-trip (Directive 6) ----------
  const profA = await api('/provider/profile', { token: techA });
  check('profile system NETWORK for provider A', profA.json.data.system, 'NETWORK');
  const patchA = await api('/provider/profile', {
    token: techA, method: 'PATCH',
    body: {
      firstName: 'Tech', lastName: 'Alpha',
      vehicle: { year: '2022', make: 'Ford', model: 'Transit', color: 'White', plate: 'TS-TEST-1' },
      notifications: { jobOffers: false },
      myAreas: ['Davie'], myAppliances: ['Washer'],
    },
  });
  check('profile PATCH 200', patchA.status, 200);
  const profA2 = await api('/provider/profile', { token: techA });
  check('vehicle round-trips', profA2.json.data.vehicle?.plate, 'TS-TEST-1');
  check('notification preference round-trips', profA2.json.data.notifications?.jobOffers, false);
  check('network areas read back from provider record', JSON.stringify(profA2.json.data.myAreas), JSON.stringify(['Davie']));
  const provArow = await prisma.provider.findUnique({ where: { id: IDS.provA } });
  check('provider record persisted serviceCities', JSON.stringify(provArow.serviceCities), JSON.stringify(['Davie']));
  const gammaBefore = await prisma.provider.findUnique({ where: { id: GAMMA_PROVIDER } });
  const patchCrew = await api('/provider/profile', {
    token: crew, method: 'PATCH', body: { myAreas: ['Sunrise'], myAppliances: ['Dryer'] },
  });
  check('crew profile PATCH 200', patchCrew.status, 200);
  const profCrew = await api('/provider/profile', { token: crew });
  check('crew personal areas round-trip per-account', JSON.stringify(profCrew.json.data.myAreas), JSON.stringify(['Sunrise']));
  const gammaAfter = await prisma.provider.findUnique({ where: { id: GAMMA_PROVIDER } });
  check('shared crew record areas untouched by a personal save',
    JSON.stringify(gammaAfter.serviceCities), JSON.stringify(gammaBefore.serviceCities));

  // ---------- Overview buckets (Directive 7) ----------
  const ov = await api('/provider/overview', { token: techA });
  const inBucket = (list, bkId) => (list || []).some((a) => a.bookingId === bkId);
  checkTrue('bucket: offers lists the offer job', inBucket(ov.json.data.offers, BUCKETS.offer[0]));
  checkTrue('bucket: inProgress lists the started job', inBucket(ov.json.data.inProgress, BUCKETS.progress[0]));
  checkTrue('bucket: awaitingParts lists the parts job', inBucket(ov.json.data.awaitingParts, BUCKETS.parts[0]));
  checkTrue('bucket: awaitingDiagnosis lists the diagnosis job', inBucket(ov.json.data.awaitingDiagnosis, BUCKETS.diagnosis[0]));
  checkTrue('bucket: completedToday lists today\u2019s completion', inBucket(ov.json.data.completedToday, BUCKETS.done[0]));
  checkTrue('bucket rows carry provider attribution',
    (ov.json.data.offers || []).every((a) => a.providerBusinessName && a.providerSystem));
  const ovOwner = await api('/provider/overview', { token: owner });
  check('oversight overview flag', ovOwner.json.data.oversight, true);
  checkTrue('oversight sees BOTH sides\u2019 jobs',
    inBucket(ovOwner.json.data.offers, woToB.json.data.booking.id) || inBucket(ovOwner.json.data.accepted, woToB.json.data.booking.id));
  const gammaRow = (ovOwner.json.data.perProvider || []).find((p) => p.providerId === GAMMA_PROVIDER);
  check('oversight per-provider row tags crew COMPANY', gammaRow?.system, 'COMPANY');
  const ovLimited = await api('/provider/overview?limit=1', { token: owner });
  checkTrue('overview limit honored for bucket pages', (ovLimited.json.data.accepted || []).length <= 1);

  // ---------- Page statics (Directives 1, 2, 4, 5, 6) ----------
  const webRoot = fileURLToPath(new URL('../../web/', import.meta.url));
  const techHtml = await readFile(webRoot + 'tech/index.html', 'utf8');
  checkTrue('D1: no Customer app row in /tech', !techHtml.includes('/app">Appliance Connect') && !techHtml.includes('Customer app <'));
  checkTrue('D1: no Service OS web portal row in /tech', !techHtml.includes('Service OS web portal'));
  checkTrue('D1: provider portal door kept', techHtml.includes('Provider portal'));
  checkTrue('D2: no separate More page (s-more gone)', !techHtml.includes('id="s-more"'));
  checkTrue('D2: More pop-up sheet exists', techHtml.includes('id="moreSheet"') && techHtml.includes('moreSheetOpen'));
  checkTrue('D2: sheet sits below the Pepper launcher layer', techHtml.includes('z-index:9990'));
  checkTrue('D6: sheet carries the CREATE group', techHtml.includes("'CREATE'") || techHtml.includes('CREATE'));
  checkTrue('D6: sheet carries New estimate / invoice / receipt', techHtml.includes('New estimate') && techHtml.includes('New invoice') && techHtml.includes('Record receipt'));
  checkTrue('D3: tech page posts work orders', techHtml.includes('/provider/work-orders'));
  checkTrue('D6: tech page wires settings', techHtml.includes('/provider/profile'));
  checkTrue('D7: bucket pages wired', techHtml.includes('openBucket') && techHtml.includes('openTeamPage'));
  checkTrue('D5: door config + wrong-door present', techHtml.includes('TECH_DOOR') && techHtml.includes('techWrongDoor'));
  checkTrue('D5: company door states office-issued accounts', techHtml.includes('issued by the office'));
  const netHtml = await readFile(webRoot + 'tech-network/index.html', 'utf8');
  checkTrue('D5: network door sets TECH_DOOR NETWORK', netHtml.includes("TECH_DOOR='NETWORK'"));
  checkTrue('D5: network door has the apply-to-join form', netHtml.includes('netApplySubmit') && netHtml.includes('PROVIDER_APPLICATION'));
  checkTrue('D5: both doors carry the forgot-password link', techHtml.includes('/reset-password') && netHtml.includes('/reset-password'));
  const bookosHtml = await readFile(webRoot + 'book-os/index.html', 'utf8');
  checkTrue('D3: Book OS page creates work orders', bookosHtml.includes('/bookos/work-orders'));
  checkTrue('D3: Book OS page has the money panel', bookosHtml.includes('toggleMoney') && bookosHtml.includes('/money'));
  const crmHtml = await readFile(webRoot + 'crm/index.html', 'utf8');
  checkTrue('D3: CRM page creates from the customer record', crmHtml.includes('crmCreateWo') && crmHtml.includes('/work-orders'));
  const ddHtml = await readFile(webRoot + 'dispatch-dashboard/index.html', 'utf8');
  checkTrue('D3: dispatch dashboard has a New work order entry', ddHtml.includes('ddWoOpen') && ddHtml.includes('/bookos/work-orders'));

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  return failures;
}

main()
  .then(async (failures) => {
    if (server) server.kill('SIGTERM');
    await cleanup();
    await prisma.$disconnect();
    process.exit(failures ? 1 : 0);
  })
  .catch(async (error) => {
    console.error(error);
    if (server) server.kill('SIGTERM');
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
