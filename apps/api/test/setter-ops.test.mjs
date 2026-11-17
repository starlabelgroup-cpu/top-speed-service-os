/**
 * Service Setters operations drill (LOCAL ONLY — fresh test database).
 *
 * Seeds the real job states the Operations Blueprint views derive
 * from, boots the real API, and proves: exceptions derive from job
 * state (missed acceptance / late arrival / parts delay / unresolved
 * estimate / escalated-review complaint, with sub-threshold jobs
 * correctly absent), the P1–P4 tier derives, is set by staff and
 * PERSISTS, the ranked assignment aid orders providers with reasons
 * and creates NO assignment (no auto-dispatch), the recovery queues
 * populate (awaiting parts / pending estimates / return visits /
 * cancellations / unpaid), the capacity math is exact and its
 * settings persist, an office reply clears a complaint, and the staff
 * gates hold (401 anonymous, 403 customer).
 *
 *   DATABASE_URL=postgresql://… node test/setter-ops.test.mjs
 */
import { PrismaClient } from '@prisma/client';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.DATABASE_URL =
  process.env.SETTER_OPS_TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgresql://postgres@127.0.0.1:5434/postgres';
process.env.DATABASE_URL_UNPOOLED = process.env.DATABASE_URL;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'setter-ops-test-secret';

const { store } = await import('../src/data/store.js');
const { persistAssignment, persistBooking, persistCustomer } = await import('../src/db/bookingsRepo.js');
const { addReviewComment } = await import('../src/db/reviewsRepo.js');
const { hashPassword } = await import('../src/services/passwords.js');

const prisma = new PrismaClient();
const PORT = 3299;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const PLATFORM_COMPANY_ID = '10000000-0000-4000-8000-000000000001';

const IDS = {
  staff: '20000000-0000-4000-8000-0000000000d1',
  customerUser: '20000000-0000-4000-8000-0000000000d2',
  providerCompanyA: '20000000-0000-4000-8000-0000000000a1',
  providerCompanyB: '20000000-0000-4000-8000-0000000000a2',
  providerA: '30000000-0000-4000-8000-0000000000a1',
  providerB: '30000000-0000-4000-8000-0000000000a2',
  providerC: '30000000-0000-4000-8000-0000000000a3',
  customer: '40000000-0000-4000-8000-0000000000c1',
  review: '80000000-0000-4000-8000-0000000000d1',
  part1: '70000000-0000-4000-8000-0000000000f1',
  part2: '70000000-0000-4000-8000-0000000000f2',
};

const B = {
  miss: '50000000-0000-4000-8000-0000000000b1',
  late: '50000000-0000-4000-8000-0000000000b2',
  partsOld: '50000000-0000-4000-8000-0000000000b3',
  partsNew: '50000000-0000-4000-8000-0000000000b4',
  estOld: '50000000-0000-4000-8000-0000000000b5',
  estNew: '50000000-0000-4000-8000-0000000000b6',
  complaint: '50000000-0000-4000-8000-0000000000b7',
  unpaid: '50000000-0000-4000-8000-0000000000b8',
  install: '50000000-0000-4000-8000-0000000000b9',
  routine: '50000000-0000-4000-8000-0000000000ba',
  cap1: '50000000-0000-4000-8000-0000000000bb',
  cap2: '50000000-0000-4000-8000-0000000000bc',
  rank: '50000000-0000-4000-8000-0000000000bd',
};

const A = {
  miss: '60000000-0000-4000-8000-0000000000e1',
  late: '60000000-0000-4000-8000-0000000000e2',
  parts: '60000000-0000-4000-8000-0000000000e3',
  done1: '60000000-0000-4000-8000-0000000000e4',
  done2: '60000000-0000-4000-8000-0000000000e5',
  done3: '60000000-0000-4000-8000-0000000000e6',
};

let failures = 0;
let server = null;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}
function checkTrue(name, cond, detail = '') {
  if (!cond) failures += 1;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : ` — ${detail}`}`);
}

async function api(path, { token, method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep null */ }
  return { status: res.status, json };
}

async function login(email) {
  const res = await api('/auth/login', { method: 'POST', body: { email, password: 'SetterOps!234' } });
  if (!res.json?.token) throw new Error(`login failed for ${email}: ${JSON.stringify(res.json)}`);
  return res.json.token;
}

const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString();
const daysAgo = (d) => hoursAgo(d * 24);
const todayStr = () => new Date().toISOString().slice(0, 10);
const yesterdayStr = () => new Date(Date.now() - 86400_000).toISOString().slice(0, 10);

const CUSTOMER = {
  id: IDS.customer, companyId: PLATFORM_COMPANY_ID, userId: null,
  name: 'Setter Ops Customer', phone: '9545550139', email: 'sops-customer@test.local',
  address: '12 Test Way', city: 'Fort Lauderdale', zip: '33311', createdAt: daysAgo(9),
};

function mkBooking(id, referenceCode, over = {}) {
  return {
    id, companyId: PLATFORM_COMPANY_ID, customerId: CUSTOMER.id, customer: CUSTOMER,
    referenceCode, source: 'WEB_FORM', city: 'Fort Lauderdale', area: 'Fort Lauderdale', zip: '33311',
    appliance: 'Refrigerator', issue: 'Not cooling', preferredWindow: null,
    diagnosticFee: 99, diagnosticFeeCreditedTowardRepair: true, feeStatus: 'COLLECTED_AT_BOOKING',
    status: 'PENDING_DISPATCH', areaStatus: 'IN_AREA', history: [], appointment: null, dispatch: null,
    createdAt: daysAgo(4), updatedAt: daysAgo(1), ...over,
  };
}

function mkAssignment(id, bookingId, providerId, providerCompanyId, status, over = {}) {
  return {
    id, companyId: PLATFORM_COMPANY_ID, bookingId, providerId, providerCompanyId,
    status, dispatchMode: 'HYBRID', approvalRequired: true, matchScore: 90,
    createdAt: daysAgo(2), approvedBy: null, approvedAt: null, ...over,
  };
}

async function seed() {
  const passwordHash = await hashPassword('SetterOps!234');
  await prisma.company.upsert({
    where: { id: PLATFORM_COMPANY_ID },
    update: {},
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'setter-ops-platform', type: 'PLATFORM_OWNER', isPlatformOwner: true },
  });
  for (const [id, name, slug] of [
    [IDS.providerCompanyA, 'Alpha Appliance Pros Co', 'setter-ops-alpha'],
    [IDS.providerCompanyB, 'Beta Cooling Co', 'setter-ops-beta'],
  ]) {
    await prisma.company.upsert({ where: { id }, update: {}, create: { id, name, slug, type: 'INDEPENDENT_PROVIDER' } });
  }
  await prisma.provider.upsert({
    where: { id: IDS.providerA },
    update: { rating: '5.00', active: true },
    create: { id: IDS.providerA, companyId: IDS.providerCompanyA, businessName: 'Alpha Appliance Pros', type: 'INDEPENDENT_PROVIDER', specialties: ['Refrigerator', 'Washer'], serviceCities: ['Fort Lauderdale', 'Davie'], rating: '5.00', active: true },
  });
  await prisma.provider.upsert({
    where: { id: IDS.providerB },
    update: { active: true },
    create: { id: IDS.providerB, companyId: IDS.providerCompanyB, businessName: 'Beta Cooling', type: 'INDEPENDENT_PROVIDER', specialties: ['Washer'], serviceCities: ['Miami'], rating: null, active: true },
  });
  await prisma.provider.upsert({
    where: { id: IDS.providerC },
    update: { active: false },
    create: { id: IDS.providerC, companyId: IDS.providerCompanyB, businessName: 'Closed Cooling', type: 'INDEPENDENT_PROVIDER', specialties: ['Refrigerator'], serviceCities: ['Fort Lauderdale'], rating: null, active: false },
  });
  await prisma.user.upsert({
    where: { id: IDS.staff },
    update: { passwordHash },
    create: { id: IDS.staff, companyId: PLATFORM_COMPANY_ID, email: 'setterops@test.local', passwordHash, phone: '9545550101', roles: ['DISPATCHER'], active: true },
  });
  await prisma.user.upsert({
    where: { id: IDS.customerUser },
    update: { passwordHash },
    create: { id: IDS.customerUser, companyId: PLATFORM_COMPANY_ID, email: 'setterops-customer@test.local', passwordHash, phone: '9545550102', roles: ['CUSTOMER'], active: true },
  });
  for (const [id, sku] of [[IDS.part1, 'TEST-SOPS-FILTER'], [IDS.part2, 'TEST-SOPS-RELAY']]) {
    await prisma.part.upsert({
      where: { id },
      update: {},
      create: { id, sku, name: `Part ${sku}`, category: 'Test', brand: 'TestBrand', unitCostCents: 500, sellPriceCents: 1500, stockOnHand: 5, reorderPoint: 1, active: true },
    });
  }
  await prisma.vanStock.upsert({
    where: { providerId_partId: { providerId: IDS.providerA, partId: IDS.part1 } },
    update: { qty: 2 },
    create: { providerId: IDS.providerA, partId: IDS.part1, qty: 2 },
  });
  await prisma.vanStock.upsert({
    where: { providerId_partId: { providerId: IDS.providerA, partId: IDS.part2 } },
    update: { qty: 1 },
    create: { providerId: IDS.providerA, partId: IDS.part2, qty: 1 },
  });

  store.customers.set(CUSTOMER.id, CUSTOMER);
  await persistCustomer(CUSTOMER);

  const bookings = [
    mkBooking(B.miss, 'TS-SOPS01', {
      status: 'CONFIRMED',
      dispatch: { mode: 'HYBRID', stage: 'APPROVED_BY_SERVICE_SETTERS', assignmentId: A.miss, providerId: IDS.providerA, approvedBy: 'setterops@test.local', approvedAt: hoursAgo(3) },
    }),
    mkBooking(B.late, 'TS-SOPS02', {
      status: 'CONFIRMED',
      appointment: { date: yesterdayStr(), window: '08-10', windowLabel: '8–10 AM', status: 'SET', setAt: daysAgo(2), setBy: 'Setter One', history: [] },
      dispatch: { mode: 'HYBRID', stage: 'ASSIGNED', assignmentId: A.late, providerId: IDS.providerA },
      history: [{ type: 'ASSIGNMENT_ACCEPTED', at: daysAgo(1), actor: 'Alpha Appliance Pros' }],
    }),
    mkBooking(B.partsOld, 'TS-SOPS03', {
      status: 'IN_PROGRESS',
      dispatch: { mode: 'HYBRID', stage: 'ASSIGNED', assignmentId: A.parts, providerId: IDS.providerA },
      history: [{ type: 'JOB_AWAITING_PARTS', at: daysAgo(3), actor: 'Alpha Appliance Pros' }],
    }),
    mkBooking(B.partsNew, 'TS-SOPS04', {
      status: 'IN_PROGRESS',
      history: [{ type: 'JOB_AWAITING_PARTS', at: hoursAgo(2), actor: 'Alpha Appliance Pros' }],
    }),
    mkBooking(B.estOld, 'TS-SOPS05', {
      status: 'IN_PROGRESS',
      history: [{ type: 'ESTIMATE_SAVED', at: daysAgo(2), actor: 'Alpha Appliance Pros', estimate: { id: 'est-old', totalCents: 25500 } }],
    }),
    mkBooking(B.estNew, 'TS-SOPS06', {
      status: 'IN_PROGRESS',
      history: [{ type: 'ESTIMATE_SAVED', at: hoursAgo(1), actor: 'Alpha Appliance Pros', estimate: { id: 'est-new', totalCents: 21000 } }],
    }),
    mkBooking(B.complaint, 'TS-SOPS07', { status: 'COMPLETED', completedAt: daysAgo(1) }),
    mkBooking(B.unpaid, 'TS-SOPS08', {
      status: 'COMPLETED', completedAt: daysAgo(2),
      history: [
        { type: 'ESTIMATE_SAVED', at: daysAgo(3), actor: 'Alpha Appliance Pros', estimate: { id: 'est-unpaid', totalCents: 30000 } },
        { type: 'ESTIMATE_APPROVED', at: daysAgo(3), actor: 'Alpha Appliance Pros', method: 'VERBAL', approvedByName: 'Setter Ops Customer' },
        { type: 'RECEIPT_RECORDED', at: daysAgo(2), actor: 'Alpha Appliance Pros', receipt: { id: 'rcpt-1', amountCents: 10000, method: 'CARD' } },
      ],
    }),
    mkBooking(B.install, 'TS-SOPS09', { appliance: 'Installation', issue: 'New dishwasher install' }),
    mkBooking(B.routine, 'TS-SOPS10', {}),
    mkBooking(B.cap1, 'TS-SOPS11', {
      status: 'CONFIRMED',
      appointment: { date: todayStr(), window: '10-12', windowLabel: '10 AM–12 PM', status: 'SET', setAt: hoursAgo(5), setBy: 'Setter One', history: [] },
    }),
    mkBooking(B.cap2, 'TS-SOPS12', {
      status: 'CONFIRMED',
      appointment: { date: todayStr(), window: '14-16', windowLabel: '2–4 PM', status: 'SET', setAt: hoursAgo(5), setBy: 'Setter One', history: [] },
    }),
    mkBooking(B.rank, 'TS-SOPS13', {}),
  ];
  for (const booking of bookings) {
    store.bookings.set(booking.id, booking);
    await persistBooking(booking);
  }

  const assignments = [
    mkAssignment(A.miss, B.miss, IDS.providerA, IDS.providerCompanyA, 'APPROVED', { approvedBy: 'setterops@test.local', approvedAt: hoursAgo(3) }),
    mkAssignment(A.late, B.late, IDS.providerA, IDS.providerCompanyA, 'ACCEPTED', { approvedBy: 'setterops@test.local', approvedAt: daysAgo(1) }),
    mkAssignment(A.parts, B.partsOld, IDS.providerA, IDS.providerCompanyA, 'ACCEPTED', { approvedBy: 'setterops@test.local', approvedAt: daysAgo(3) }),
    mkAssignment(A.done1, B.unpaid, IDS.providerA, IDS.providerCompanyA, 'COMPLETED'),
    mkAssignment(A.done2, B.complaint, IDS.providerA, IDS.providerCompanyA, 'COMPLETED'),
    mkAssignment(A.done3, B.partsOld, IDS.providerA, IDS.providerCompanyA, 'COMPLETED'),
  ];
  for (const assignment of assignments) {
    store.dispatchAssignments.set(assignment.id, assignment);
    await persistAssignment(assignment);
  }

  await prisma.review.upsert({
    where: { id: IDS.review },
    update: { escalated: true },
    create: {
      id: IDS.review, companyId: PLATFORM_COMPANY_ID, customerId: CUSTOMER.id, bookingId: B.complaint,
      rating: 1, title: 'Still not fixed', body: 'The fridge is warm again and nobody called me back.',
      escalated: true, escalationReason: 'Low rating (1 star)', createdAt: new Date(hoursAgo(2)),
    },
  });
}

async function cleanup() {
  try {
    await prisma.reviewComment.deleteMany({ where: { reviewId: IDS.review } });
    await prisma.review.deleteMany({ where: { id: IDS.review } });
    await prisma.dispatchSetting.deleteMany({ where: { companyId: PLATFORM_COMPANY_ID } });
    await prisma.vanStock.deleteMany({ where: { providerId: IDS.providerA } });
    await prisma.part.deleteMany({ where: { id: { in: [IDS.part1, IDS.part2] } } });
    await prisma.dispatchAssignment.deleteMany({ where: { id: { in: Object.values(A) } } });
    await prisma.serviceRequest.deleteMany({ where: { id: { in: Object.values(B) } } });
    await prisma.customer.deleteMany({ where: { id: IDS.customer } });
    await prisma.user.deleteMany({ where: { id: { in: [IDS.staff, IDS.customerUser] } } });
    await prisma.provider.deleteMany({ where: { id: { in: [IDS.providerA, IDS.providerB, IDS.providerC] } } });
    await prisma.company.deleteMany({ where: { id: { in: [IDS.providerCompanyA, IDS.providerCompanyB] } } });
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
  await seed();
  server = spawn('node', ['src/server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      ...process.env,
      PORT: String(PORT),
      JWT_SECRET: 'setter-ops-test-secret',
      DATABASE_URL: process.env.DATABASE_URL,
      DATABASE_URL_UNPOOLED: process.env.DATABASE_URL,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[api] ${d}`));
  await waitForServer();

  const staff = await login('setterops@test.local');
  const customer = await login('setterops-customer@test.local');

  // ---- staff gates hold ----
  check('exceptions unauthenticated', (await api('/bookos/exceptions')).status, 401);
  check('exceptions as customer', (await api('/bookos/exceptions', { token: customer })).status, 403);
  check('recovery as customer', (await api('/bookos/recovery-queues', { token: customer })).status, 403);
  check('capacity as customer', (await api('/bookos/capacity', { token: customer })).status, 403);
  check('priority write as customer', (await api(`/bookos/bookings/${B.routine}/priority`, { token: customer, method: 'POST', body: { tier: 'P1' } })).status, 403);
  check('suggestions as customer', (await api(`/bookos/bookings/${B.rank}/assignment-suggestions`, { token: customer })).status, 403);

  // ---- priority derivation in the setter queue ----
  const queue = await api('/bookos/setter-queue', { token: staff });
  check('setter-queue 200', queue.status, 200);
  const qBy = new Map((queue.json.data.queue || []).map((i) => [i.bookingId, i]));
  check('installation derives P4', qBy.get(B.install)?.priorityTier, 'P4');
  check('routine repair derives P3', qBy.get(B.routine)?.priorityTier, 'P3');
  check('rank job derives P3', qBy.get(B.rank)?.priorityTier, 'P3');

  // ---- exception queue derives from job state ----
  const exc = await api('/bookos/exceptions', { token: staff });
  check('exceptions 200', exc.status, 200);
  const excItems = exc.json.data.items || [];
  const excPairs = excItems.map((i) => `${i.bookingId}:${i.type}`).sort();
  check('exception set is exactly the five seeded states', excPairs, [
    `${B.complaint}:COMPLAINT`,
    `${B.estOld}:UNRESOLVED_ESTIMATE`,
    `${B.late}:LATE_ARRIVAL`,
    `${B.miss}:MISSED_ACCEPTANCE`,
    `${B.partsOld}:PARTS_DELAY`,
  ].sort());
  const missRow = excItems.find((i) => i.type === 'MISSED_ACCEPTANCE');
  check('missed acceptance owner is the provider', missRow?.owner?.providerName, 'Alpha Appliance Pros');
  checkTrue('missed acceptance has a next action + due time', Boolean(missRow?.nextAction && missRow?.dueAt));
  const estRow = excItems.find((i) => i.type === 'UNRESOLVED_ESTIMATE');
  check('unresolved estimate carries its total', estRow?.detail?.estimateTotalCents, 25500);
  const complaintRow = excItems.find((i) => i.type === 'COMPLAINT');
  check('complaint row carries the review id', complaintRow?.detail?.reviewId, IDS.review);

  // ---- recovery queues populate ----
  let rec = await api('/bookos/recovery-queues', { token: staff });
  check('recovery 200', rec.status, 200);
  const rq = rec.json.data.queues;
  check('awaiting parts holds both waits', (rq.awaitingParts || []).map((r) => r.bookingId).sort(), [B.partsNew, B.partsOld].sort());
  check('pending estimates holds both estimates', (rq.pendingEstimates || []).map((r) => r.bookingId).sort(), [B.estNew, B.estOld].sort());
  check('unpaid holds the one balance', (rq.unpaid || []).map((r) => r.bookingId), [B.unpaid]);
  check('unpaid balance is exact', rq.unpaid?.[0]?.detail?.balanceDueCents, 20000);
  check('missed calls honestly null', rec.json.data.missedCalls, null);
  check('return visits empty before flagging', (rq.returnVisits || []).length, 0);
  check('cancellations empty before any cancel', (rq.cancellations || []).length, 0);

  // ---- return-visit flag feeds its queue ----
  const flag = await api(`/bookos/bookings/${B.routine}/return-visit`, { token: staff, method: 'POST', body: { needed: true, note: 'Recheck the repair' } });
  check('return-visit flag 200', flag.status, 200);
  rec = await api('/bookos/recovery-queues', { token: staff });
  check('return visits now holds the flagged job', (rec.json.data.queues.returnVisits || []).map((r) => r.bookingId), [B.routine]);

  // ---- priority set by staff persists ----
  const setP = await api(`/bookos/bookings/${B.routine}/priority`, { token: staff, method: 'POST', body: { tier: 'P1' } });
  check('priority set 200', setP.status, 200);
  check('priority set echoes P1', setP.json.data.priorityTier, 'P1');
  const queue2 = await api('/bookos/setter-queue', { token: staff });
  const q2By = new Map((queue2.json.data.queue || []).map((i) => [i.bookingId, i]));
  check('queue now shows stored P1', q2By.get(B.routine)?.priorityTier, 'P1');
  const dbRow = await prisma.serviceRequest.findUnique({ where: { id: B.routine } });
  check('priority persisted to the database', dbRow?.priorityTier, 'P1');

  // ---- cancellation feeds the win-back list ----
  const cancel = await api(`/bookos/bookings/${B.install}/cancel`, { token: staff, method: 'POST', body: { reason: 'Customer asked to hold' } });
  check('cancel 200', cancel.status, 200);
  check('cancel echoes CANCELLED', cancel.json.data.status, 'CANCELLED');
  rec = await api('/bookos/recovery-queues', { token: staff });
  check('cancellations holds the cancelled job', (rec.json.data.queues.cancellations || []).map((r) => r.bookingId), [B.install]);
  check('cancellation carries its reason', rec.json.data.queues.cancellations?.[0]?.detail?.reason, 'Customer asked to hold');
  check('double cancel refused', (await api(`/bookos/bookings/${B.install}/cancel`, { token: staff, method: 'POST', body: {} })).status, 409);

  // ---- ranked assignment aid: order, reasons, NO auto-dispatch ----
  const sug = await api(`/bookos/bookings/${B.rank}/assignment-suggestions`, { token: staff });
  check('suggestions 200', sug.status, 200);
  const cands = sug.json.data.candidates || [];
  // The platform also ensures its seeded network partner (Cleanout
  // Vents, provider …0004) at boot — it ranks honestly in the middle:
  // no Refrigerator specialty, but it serves Fort Lauderdale and is
  // free. The inactive provider must not appear at all.
  check('ranked order: alpha, seeded partner, beta', cands.map((c) => c.providerId), [IDS.providerA, '30000000-0000-4000-8000-000000000004', IDS.providerB]);
  checkTrue('inactive provider excluded', !cands.some((c) => c.providerId === IDS.providerC));
  check('alpha score exact', cands[0]?.score, 107);
  check('alpha eligible', cands[0]?.eligible, true);
  checkTrue('alpha reasons name the specialty match', (cands[0]?.reasons || []).some((r) => r.label.includes('Specialty match')));
  checkTrue('alpha reasons name the van stock', (cands[0]?.reasons || []).some((r) => r.label.includes('Van stocked')));
  checkTrue('alpha reasons name the heavy load', (cands[0]?.reasons || []).some((r) => r.label.includes('Heavy load')));
  check('beta score exact', cands[2]?.score, 10);
  check('beta not eligible', cands[2]?.eligible, false);
  const rankAssignments = await prisma.dispatchAssignment.count({ where: { serviceRequestId: B.rank } });
  check('suggestions created NO assignment (no auto-dispatch)', rankAssignments, 0);

  // ---- capacity math is exact; settings persist ----
  const cap = await api('/bookos/capacity', { token: staff });
  check('capacity 200', cap.status, 200);
  // Technicians = the drill's two active providers + the platform's
  // seeded active network partner (Cleanout Vents) = 3.
  check('capacity technicians', cap.json.data.technicians, 3);
  check('capacity ceiling with blueprint defaults', cap.json.data.ceilingJobs, 9);
  check('capacity booked today', cap.json.data.bookedToday, 2);
  check('capacity remaining', cap.json.data.remainingJobs, 7);
  check('capacity default buffer', cap.json.data.settings.bufferPercent, 25);
  const put = await api('/bookos/capacity-settings', { token: staff, method: 'PUT', body: { bufferPercent: 50, minutesPerJob: 120, workingHoursPerDay: 8 } });
  check('capacity settings save 200', put.status, 200);
  const cap2 = await api('/bookos/capacity', { token: staff });
  check('ceiling after buffer 50%', cap2.json.data.ceilingJobs, 6);
  check('remaining after buffer 50%', cap2.json.data.remainingJobs, 4);
  const dbSetting = await prisma.dispatchSetting.findUnique({ where: { companyId: PLATFORM_COMPANY_ID } });
  check('capacity settings persisted', dbSetting?.bufferPercent, 50);
  check('invalid capacity settings refused', (await api('/bookos/capacity-settings', { token: staff, method: 'PUT', body: { bufferPercent: 99, minutesPerJob: 120, workingHoursPerDay: 8 } })).status, 400);

  // ---- an office reply clears the complaint ----
  await addReviewComment({ reviewId: IDS.review, authorId: IDS.staff, authorKind: 'STAFF', body: 'Office reply: we are making this right today.' });
  const exc2 = await api('/bookos/exceptions', { token: staff });
  check('complaint cleared after office reply', (exc2.json.data.items || []).some((i) => i.type === 'COMPLAINT'), false);
  check('four exceptions remain', (exc2.json.data.items || []).length, 4);

  console.log(failures === 0 ? '\nSETTER-OPS DRILL: ALL CHECKS PASSED' : `\nSETTER-OPS DRILL: ${failures} FAILURE(S)`);
}

main()
  .catch((error) => {
    failures += 1;
    console.error('drill error:', error);
  })
  .finally(async () => {
    if (server) server.kill('SIGTERM');
    await cleanup();
    await prisma.$disconnect();
    process.exit(failures === 0 ? 0 : 1);
  });
