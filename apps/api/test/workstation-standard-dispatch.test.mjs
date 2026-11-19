/**
 * Workstation Standard — DISPATCH CONSOLE station drills.
 *
 * Proves the contracts the Dispatch Dashboard (apps/web/dispatch-dashboard)
 * workstation-standard integration is wired against, all on endpoints
 * the console already used or that the shared CTA standard reuses:
 *   - Staff gates on every console read (setter queue, tracking
 *     console, dispatch board, exceptions, recovery, capacity)
 *   - Queue / console / board payload shapes the page renders
 *   - Detail enrichment (GET /bookings/:id: customer phone/email,
 *     payment.diagnosticPaid, appointment, dispatch candidates)
 *   - The console's native assignment flow (suggestions -> tracking
 *     assign -> CONFIRMED, leaves the queue)
 *   - CTA contracts: appointment set/reschedule (past-date refusal),
 *     read-only money summary, Link Center sends (true outbox state;
 *     PAYMENT refuses without a reference and while Stripe is
 *     unconfigured), Speedy Suggest, match -> approve (non-candidate
 *     422)
 *   - The detail panel's existing ops (priority, return visit,
 *     cancel) still land and surface in the recovery queues
 *
 * Fresh DB per run (runner supplies DATABASE_URL); providers are
 * seeded BEFORE the server spawns because the store hydrates at boot.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { PLATFORM_COMPANY_ID, store } from '../src/data/store.js';
import { persistCustomer } from '../src/db/bookingsRepo.js';
import { hashPassword } from '../src/services/passwords.js';

const PASSWORD = 'test-pass-1234';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_DIR = path.resolve(__dirname, '..');
const PORT = process.env.TEST_PORT || 4463;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;

const IDS = {
  setter: '70000000-0000-4000-8000-0000000000c1',
  customer: '70000000-0000-4000-8000-0000000000c3',
  custRec: '70000000-0000-4000-8000-0000000000d1',
  provA: '70000000-0000-4000-8000-0000000000a2',
  provB: '70000000-0000-4000-8000-0000000000b2',
  provCrew: '70000000-0000-4000-8000-0000000000e2',
  coA: '70000000-0000-4000-8000-0000000000a1',
  coB: '70000000-0000-4000-8000-0000000000b1',
  coCrew: '70000000-0000-4000-8000-0000000000e1',
};
const EMAILS = {
  setter: 'wsdd-setter@test.local',
  customer: 'wsdd-customer@test.local',
};

let passed = 0;
let failed = 0;
const failures = [];
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  if (ok) passed += 1;
  else {
    failed += 1;
    failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
}

async function api(p, { token, method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep null */ }
  return { status: res.status, json };
}

async function waitForServer(proc) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`server exited early with ${proc.exitCode}`);
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('server did not come up within 90s');
}

const etDate = (offsetDays) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' })
  .format(new Date(Date.now() + offsetDays * 86_400_000));

const prisma = new PrismaClient();
let server = null;

try {
  const passwordHash = await hashPassword(PASSWORD);
  await prisma.company.upsert({
    where: { id: PLATFORM_COMPANY_ID },
    update: {},
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'wsdd-platform', type: 'PLATFORM_OWNER', isPlatformOwner: true },
  });
  for (const [id, name, slug] of [
    [IDS.coA, 'Workstation Provider A Co', 'wsdd-prov-a'],
    [IDS.coB, 'Workstation Provider B Co', 'wsdd-prov-b'],
    [IDS.coCrew, 'Workstation Crew Co', 'wsdd-crew'],
  ]) {
    await prisma.company.upsert({ where: { id }, update: {}, create: { id, name, slug, type: 'INDEPENDENT_PROVIDER' } });
  }
  await prisma.provider.upsert({
    where: { id: IDS.provA }, update: {},
    create: {
      id: IDS.provA, companyId: IDS.coA, businessName: 'Workstation Provider A', type: 'NETWORK_BUSINESS',
      specialties: ['Refrigerator', 'Washer'], serviceCities: ['Fort Lauderdale', 'Davie'],
    },
  });
  await prisma.provider.upsert({
    where: { id: IDS.provB }, update: {},
    create: {
      id: IDS.provB, companyId: IDS.coB, businessName: 'Workstation Provider B', type: 'NETWORK_BUSINESS',
      specialties: ['Oven'], serviceCities: ['Miami'],
    },
  });
  await prisma.provider.upsert({
    where: { id: IDS.provCrew }, update: { companyCrew: true },
    create: {
      id: IDS.provCrew, companyId: IDS.coCrew, businessName: 'Company Crew Provider', type: 'INDEPENDENT_PROVIDER',
      specialties: ['Refrigerator'], serviceCities: ['Fort Lauderdale'], companyCrew: true,
    },
  });
  for (const [id, email, roles] of [
    [IDS.setter, EMAILS.setter, ['DISPATCHER']],
    [IDS.customer, EMAILS.customer, ['CUSTOMER']],
  ]) {
    await prisma.user.upsert({
      where: { id }, update: { passwordHash, verifyRequired: false, layer2Required: false },
      create: { id, companyId: PLATFORM_COMPANY_ID, email, passwordHash, phone: '9545550110', roles, active: true },
    });
  }

  // The seeded customer record the work orders hang off.
  const custRec = {
    id: IDS.custRec, companyId: PLATFORM_COMPANY_ID, userId: null,
    name: 'Dispatch Customer', phone: '9545550161', email: 'wsdd-cust1@test.local',
    address: '100 Dispatch Way', city: 'Fort Lauderdale', zip: '33311', segment: 'RESIDENTIAL',
    createdAt: new Date().toISOString(),
  };
  store.customers.set(custRec.id, custRec);
  await persistCustomer(custRec);

  server = spawn('node', ['src/server.js'], {
    cwd: API_DIR,
    env: {
      ...process.env, PORT: String(PORT), NODE_ENV: 'test',
      JWT_SECRET: ['wsdd', 'drill', 'secret'].join('-'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
  await waitForServer(server).catch((e) => { console.error(serverLog.slice(-3000)); throw e; });

  const login = async (email) => {
    const r = await api('/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
    if (r.status !== 200 || !r.json?.token) throw new Error(`login failed for ${email}: ${r.status} ${JSON.stringify(r.json)}`);
    return r.json.token;
  };
  const setter = await login(EMAILS.setter);
  const customer = await login(EMAILS.customer);

  const makeBooking = async () => {
    const wo = await api('/bookos/work-orders', {
      token: setter,
      method: 'POST',
      body: { customerId: IDS.custRec, appliance: 'Refrigerator', issue: 'Not cooling', city: 'Fort Lauderdale', zip: '33311' },
    });
    if (wo.status !== 201) throw new Error(`work order create failed: ${wo.status} ${JSON.stringify(wo.json)}`);
    return wo.json.data.booking;
  };

  // ---------- Staff gates on the console's reads ----------
  check('anon 401 setter queue', (await api('/bookos/setter-queue')).status, 401);
  check('customer 403 setter queue', (await api('/bookos/setter-queue', { token: customer })).status, 403);
  check('anon 401 tracking console', (await api('/tracking/console')).status, 401);
  check('customer 403 tracking console', (await api('/tracking/console', { token: customer })).status, 403);
  check('customer 403 dispatch board', (await api('/bookos/dispatch-board', { token: customer })).status, 403);
  check('customer 403 exceptions', (await api('/bookos/exceptions', { token: customer })).status, 403);
  check('customer 403 recovery queues', (await api('/bookos/recovery-queues', { token: customer })).status, 403);
  check('customer 403 capacity', (await api('/bookos/capacity', { token: customer })).status, 403);

  // ---------- Console payload contracts ----------
  const b1 = await makeBooking();
  const queue = (await api('/bookos/setter-queue', { token: setter })).json.data.queue || [];
  const qItem = queue.find((row) => row.bookingId === b1.id);
  check('created booking lands in the setter queue', Boolean(qItem), true);
  check('queue item carries the reference code', qItem?.referenceCode, b1.referenceCode);
  check('queue item carries a numeric age', typeof qItem?.ageMinutes, 'number');
  check('queue item carries the segment', qItem?.segment, 'RESIDENTIAL');

  const consoleData = (await api('/tracking/console', { token: setter })).json.data;
  const job = (consoleData.jobs || []).find((j) => j.reference === b1.referenceCode);
  check('tracking console job id is the booking id', job?.id, b1.id);
  check('tracking console job starts at stage 0', job?.stageIndex, 0);
  check('tracking console job carries the customer name', job?.customerName, 'Dispatch Customer');
  check('tracking console job carries the customer phone', job?.customerPhone, '9545550161');
  check('tracking console job carries the customer email', job?.customerEmail, 'wsdd-cust1@test.local');
  const rosterRow = (consoleData.providers || []).find((p) => p.id === IDS.provA);
  check('provider roster carries the seeded provider', rosterRow?.businessName, 'Workstation Provider A');
  check('console summary counts the awaiting job', (consoleData.summary?.awaitingAssignment || 0) >= 1, true);

  const board = (await api('/bookos/dispatch-board', { token: setter })).json.data;
  check('dispatch board groups the pending job', (board.groups?.PENDING_DISPATCH || [])
    .some((r) => (r.bookingId || r.id) === b1.id || r.referenceCode === b1.referenceCode), true);
  const exceptions = (await api('/bookos/exceptions', { token: setter })).json.data;
  check('exception queue returns an items array', Array.isArray(exceptions.items), true);
  const recovery0 = (await api('/bookos/recovery-queues', { token: setter })).json.data;
  check('recovery queues carry the five lanes', ['awaitingParts', 'pendingEstimates', 'returnVisits', 'cancellations', 'unpaid']
    .every((k) => Array.isArray(recovery0.queues?.[k])), true);

  const cap1 = (await api('/bookos/capacity', { token: setter })).json.data;
  check('capacity carries a ceiling and a booked count', typeof cap1.ceilingJobs === 'number' && typeof cap1.bookedToday === 'number', true);
  const capPut = await api('/bookos/capacity-settings', {
    token: setter, method: 'PUT', body: { bufferPercent: 20, minutesPerJob: 120, workingHoursPerDay: 8 },
  });
  check('capacity settings save 200', capPut.status, 200);
  const cap2 = (await api('/bookos/capacity', { token: setter })).json.data;
  check('capacity setting reads back', cap2.settings?.bufferPercent, 20);

  // ---------- Detail enrichment ----------
  const detail1 = (await api(`/bookings/${b1.id}`, { token: setter })).json.data;
  check('detail carries the customer phone', detail1.customer?.phone, '9545550161');
  check('detail carries the customer email', detail1.customer?.email, 'wsdd-cust1@test.local');
  check('detail reports the diagnostic unpaid', detail1.payment?.diagnosticPaid, false);
  check('detail appointment starts unset', detail1.appointment == null, true);
  check('detail dispatch candidates is an array', Array.isArray(detail1.dispatch?.candidateProviderIds), true);

  // ---------- The console's native assignment flow ----------
  const sugg = await api(`/bookos/bookings/${b1.id}/assignment-suggestions`, { token: setter });
  check('assignment suggestions 200', sugg.status, 200);
  const suggA = (sugg.json.data.candidates || []).find((c) => c.providerId === IDS.provA);
  check('suggestions rank the matching provider', Boolean(suggA), true);
  check('suggestion carries score and reasons', typeof suggA?.score === 'number' && Array.isArray(suggA?.reasons), true);
  const assign = await api(`/tracking/console/${b1.referenceCode}/assign`, {
    token: setter, method: 'POST', body: { providerId: IDS.provA },
  });
  check('tracking assign 201', assign.status, 201);
  check('assign lands CONFIRMED', assign.json.data.status, 'CONFIRMED');
  check('assign names the provider on the job', assign.json.data.providerId, IDS.provA);
  const queueAfter = (await api('/bookos/setter-queue', { token: setter })).json.data.queue || [];
  check('assigned booking leaves the setter queue', queueAfter.some((row) => row.bookingId === b1.id), false);

  // ---------- CTA contracts on a fresh booking ----------
  const b2 = await makeBooking();

  const speedy = await api(`/crm/bookings/${b2.id}/speedy-match`, { token: setter });
  const sugIds = (speedy.json.data.suggestions || []).map((s) => s.providerId);
  check('Speedy Suggest includes the matching provider', sugIds.includes(IDS.provA), true);
  check('Speedy Suggest excludes the non-matching provider', sugIds.includes(IDS.provB), false);

  const roster = (await api('/bookos/providers', { token: setter })).json.data || [];
  check('roster tags the network provider', roster.find((p) => p.id === IDS.provA)?.system, 'NETWORK');
  check('roster tags the company crew', roster.find((p) => p.id === IDS.provCrew)?.system, 'COMPANY');

  const set1 = await api('/bookos/appointments', {
    token: setter, method: 'POST',
    body: { bookingId: b2.id, date: etDate(2), window: '12-14', setBy: 'Service Setters' },
  });
  check('CTA appointment set 201', set1.status, 201);
  check('CTA appointment window label', set1.json.data.appointment.windowLabel, '12\u20132 PM');
  const detail2 = (await api(`/bookings/${b2.id}`, { token: setter })).json.data;
  check('set appointment reads back on the detail', detail2.appointment?.status, 'SET');

  const b3 = await makeBooking();
  const past = await api('/bookos/appointments', {
    token: setter, method: 'POST',
    body: { bookingId: b3.id, date: etDate(-1), window: '10-12', setBy: 'Service Setters' },
  });
  check('past-date appointment refused 400', past.status, 400);

  const re = await api(`/bookos/appointments/${b2.id}/reschedule`, {
    token: setter, method: 'POST',
    body: { date: etDate(3), window: '16-18', rescheduledBy: 'Service Setters' },
  });
  check('CTA reschedule 200', re.status, 200);
  const detail2b = (await api(`/bookings/${b2.id}`, { token: setter })).json.data;
  check('rescheduled slot reads back', `${detail2b.appointment?.date}|${detail2b.appointment?.window}`, `${etDate(3)}|16-18`);

  const money = await api(`/bookos/bookings/${b2.id}/money`, { token: setter });
  check('money summary 200', money.status, 200);
  check('money summary estimate starts empty', money.json.data.estimate, null);
  check('money summary receipts total is zero', money.json.data.payments?.receiptsTotalCents, 0);

  const match = await api('/dispatch/match', { token: setter, method: 'POST', body: { bookingId: b2.id } });
  check('dispatch match 200', match.status, 200);
  const candIds = (match.json.data.candidates || []).map((c) => c.providerId);
  check('match proposes the matching provider', candIds.includes(IDS.provA), true);
  check('match excludes the non-matching provider', candIds.includes(IDS.provB), false);
  const detailAfterMatch = (await api(`/bookings/${b2.id}`, { token: setter })).json.data;
  check('match moves the booking to pending approval', detailAfterMatch.status, 'MATCH_PENDING_APPROVAL');
  const approveBad = await api('/dispatch/approve', {
    token: setter, method: 'POST', body: { bookingId: b2.id, providerId: IDS.provB, approvedBy: 'Service Setters' },
  });
  check('approve refuses a non-candidate 422', approveBad.status, 422);
  const approve = await api('/dispatch/approve', {
    token: setter, method: 'POST', body: { bookingId: b2.id, providerId: IDS.provA, approvedBy: 'Service Setters' },
  });
  check('approve accepts a candidate', approve.json.data.assignment?.providerId, IDS.provA);

  // ---------- Link Center sends ----------
  const link = await api('/link-center/send', {
    token: setter, method: 'POST',
    body: { linkType: 'BOOKING', channel: 'SMS', bookingRef: b2.referenceCode, phone: '9545550161', recipientName: 'Dispatch Customer' },
  });
  check('booking link send accepted 201', link.status, 201);
  check('booking link reports the true outbox state', link.json.data.status, 'GATED');
  const payNoRef = await api('/link-center/send', {
    token: setter, method: 'POST',
    body: { linkType: 'PAYMENT', channel: 'EMAIL', email: 'wsdd-cust1@test.local' },
  });
  check('payment link without a booking refused 400', payNoRef.status, 400);
  const payRef = await api('/link-center/send', {
    token: setter, method: 'POST',
    body: { linkType: 'PAYMENT', channel: 'EMAIL', bookingRef: b2.referenceCode, email: 'wsdd-cust1@test.local' },
  });
  check('payment link needs Stripe configured 503', payRef.status, 503);

  // ---------- The detail panel's existing ops ----------
  const prio = await api(`/bookos/bookings/${b3.id}/priority`, {
    token: setter, method: 'POST', body: { tier: 'P2' },
  });
  check('priority op 200', prio.status, 200);
  const detail3 = (await api(`/bookings/${b3.id}`, { token: setter })).json.data;
  check('priority reads back on the detail', detail3.priorityTier, 'P2');
  const rv = await api(`/bookos/bookings/${b3.id}/return-visit`, {
    token: setter, method: 'POST', body: { needed: true },
  });
  check('return-visit op 200', rv.status, 200);
  const recovery1 = (await api('/bookos/recovery-queues', { token: setter })).json.data;
  check('return visit surfaces in the recovery queue', (recovery1.queues?.returnVisits || []).some((r) => (r.bookingId || r.id) === b3.id), true);
  const cancel = await api(`/bookos/bookings/${b3.id}/cancel`, {
    token: setter, method: 'POST', body: { reason: 'Dispatch drill cleanup' },
  });
  check('cancel op 200', cancel.status, 200);
  const detail3b = (await api(`/bookings/${b3.id}`, { token: setter })).json.data;
  check('cancelled booking reads back cancelled', detail3b.status, 'CANCELLED');
  const recovery2 = (await api('/bookos/recovery-queues', { token: setter })).json.data;
  check('cancellation surfaces in the recovery queue', (recovery2.queues?.cancellations || []).some((r) => (r.bookingId || r.id) === b3.id), true);
} finally {
  if (server) server.kill('SIGTERM');
  try {
    const created = await prisma.serviceRequest.findMany({
      where: { customerId: IDS.custRec }, select: { id: true },
    });
    const bookingIds = created.map((r) => r.id);
    await prisma.dispatchAssignment.deleteMany({ where: { serviceRequestId: { in: bookingIds } } });
    await prisma.platformEvent.deleteMany({ where: { entityId: { in: bookingIds } } });
    await prisma.serviceRequest.deleteMany({ where: { id: { in: bookingIds } } });
    await prisma.customer.deleteMany({ where: { id: IDS.custRec } });
    await prisma.user.deleteMany({ where: { id: { in: [IDS.setter, IDS.customer] } } });
    await prisma.provider.deleteMany({ where: { id: { in: [IDS.provA, IDS.provB, IDS.provCrew] } } });
    await prisma.company.deleteMany({ where: { id: { in: [IDS.coA, IDS.coB, IDS.coCrew] } } });
  } catch (error) {
    console.error('cleanup warning:', error.message);
  }
  await prisma.$disconnect();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log('Failures:');
  failures.forEach((f) => console.log(`  - ${f}`));
}
console.log(failed === 0 ? 'ALL CHECKS PASSED' : 'CHECKS FAILED');
process.exit(failed === 0 ? 0 : 1);
