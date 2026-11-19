/**
 * Advanced Workstation Standard — Book OS station (2026-11-19).
 *
 * Ramone's directive: "a more advanced setup for everything
 * workstations with options and CTA methods… including for a
 * appointment setting and Dispatching team." The web-side options
 * panel + CTA bar live in apps/web/book-os/index.html; THIS suite
 * drills the API contracts those controls drive:
 *
 *  - Appointment setting: POST /bookos/appointments persists a SET
 *    appointment with the setter's CHOSEN date + window (the five
 *    two-hour APPOINTMENT_WINDOWS), emits APPOINTMENT_SET, and the
 *    setter queue renders the same state back.
 *  - Past dates are refused (400) against the America/New_York
 *    business clock, on both set and reschedule.
 *  - Reschedule: POST /bookos/appointments/:id/reschedule moves the
 *    SAME appointment (previous slot returned + kept in history),
 *    emits APPOINTMENT_RESCHEDULED.
 *  - Dispatching team: Speedy Suggest (GET /crm/bookings/:id/
 *    speedy-match, the endpoint the board uses) ranks real
 *    candidates with reasons; the roster (GET /bookos/providers)
 *    carries COMPANY / NETWORK system tags; POST /dispatch/match
 *    moves a queue job to MATCH_PENDING_APPROVAL on the board;
 *    POST /dispatch/approve with a non-candidate is refused (422)
 *    and with a candidate dispatches the job (CONFIRMED, assignment
 *    APPROVED, DISPATCH_APPROVED event) — the job leaves the setter
 *    queue and lands in the board's Confirmed / Dispatched column.
 *
 * Runs against a LOCAL test database only. Usage:
 *   DATABASE_URL=postgresql://... node test/workstation-standard.test.mjs
 * Exit code 0 = every check passed.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/services/passwords.js';
import { PLATFORM_COMPANY_ID, store } from '../src/data/store.js';
import { persistCustomer } from '../src/db/bookingsRepo.js';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required (point it at a local TEST database).');
  process.exit(2);
}
process.env.DATABASE_URL_UNPOOLED ||= process.env.DATABASE_URL;

const PORT = Number(process.env.TEST_PORT || 4450);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const PASSWORD = 'test-pass-1234';

const IDS = {
  coA: '60000000-0000-4000-8000-0000000000a1',
  provA: '60000000-0000-4000-8000-0000000000a2',
  coB: '60000000-0000-4000-8000-0000000000b1',
  provB: '60000000-0000-4000-8000-0000000000b2',
  coCrew: '60000000-0000-4000-8000-0000000000e1',
  provCrew: '60000000-0000-4000-8000-0000000000e2',
  setter: '60000000-0000-4000-8000-0000000000c1',
  customerUser: '60000000-0000-4000-8000-0000000000c3',
  cust1: '60000000-0000-4000-8000-0000000000d1',
};

/** A date `offsetDays` from today on the America/New_York clock. */
function etDate(offsetDays = 0) {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

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
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'ws-platform', type: 'PLATFORM_OWNER', isPlatformOwner: true },
  });
  for (const [id, name, slug] of [
    [IDS.coA, 'Workstation Provider A Co', 'ws-prov-a'],
    [IDS.coB, 'Workstation Provider B Co', 'ws-prov-b'],
    [IDS.coCrew, 'Workstation Crew Co', 'ws-crew'],
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
      id: IDS.provCrew, companyId: IDS.coCrew, businessName: 'Top Speed Field Team', type: 'INDEPENDENT_PROVIDER',
      specialties: ['Refrigerator'], serviceCities: ['Fort Lauderdale'], companyCrew: true,
    },
  });
  for (const [id, companyId, email, roles] of [
    [IDS.setter, PLATFORM_COMPANY_ID, 'ws-setter@test.local', ['DISPATCHER']],
    [IDS.customerUser, PLATFORM_COMPANY_ID, 'ws-customer@test.local', ['CUSTOMER']],
  ]) {
    await prisma.user.upsert({
      where: { id }, update: { passwordHash, verifyRequired: false, layer2Required: false },
      create: { id, companyId, email, passwordHash, phone: '9545550110', roles, active: true },
    });
  }
  const cust1 = {
    id: IDS.cust1, companyId: PLATFORM_COMPANY_ID, userId: null,
    name: 'Workstation Test Customer', phone: '9545550150', email: 'ws-cust@test.local',
    address: '100 Workstation Way', city: 'Fort Lauderdale', zip: '33311', createdAt: new Date().toISOString(),
  };
  store.customers.set(cust1.id, cust1);
  await persistCustomer(cust1);
}

async function cleanup() {
  try {
    const created = await prisma.serviceRequest.findMany({
      where: { customerId: IDS.cust1 }, select: { id: true },
    });
    const bookingIds = created.map((r) => r.id);
    await prisma.dispatchAssignment.deleteMany({ where: { serviceRequestId: { in: bookingIds } } });
    await prisma.platformEvent.deleteMany({ where: { entityId: { in: bookingIds } } });
    await prisma.serviceRequest.deleteMany({ where: { id: { in: bookingIds } } });
    await prisma.customer.deleteMany({ where: { id: IDS.cust1 } });
    await prisma.user.deleteMany({ where: { id: { in: [IDS.setter, IDS.customerUser] } } });
    await prisma.provider.deleteMany({ where: { id: { in: [IDS.provA, IDS.provB, IDS.provCrew] } } });
    await prisma.company.deleteMany({ where: { id: { in: [IDS.coA, IDS.coB, IDS.coCrew] } } });
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
      JWT_SECRET: ['wsstd', 'drill', 'secret'].join('-'),
      DATABASE_URL: process.env.DATABASE_URL,
      DATABASE_URL_UNPOOLED: process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL,
      OPENAI_API_KEY: '',
      OPENAI_API_KEY_V2: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[api] ${d}`));
  await waitForServer();

  const setter = await login('ws-setter@test.local');
  const customer = await login('ws-customer@test.local');

  const queueRow = async (bookingId) => {
    const q = await api('/bookos/setter-queue', { token: setter });
    return (q.json.data.queue || []).find((row) => row.bookingId === bookingId) || null;
  };
  const boardGroup = async (status) => {
    const b = await api('/bookos/dispatch-board', { token: setter });
    return (b.json.data.groups || {})[status] || [];
  };
  const eventExists = async (type, bookingId) => {
    const row = await prisma.platformEvent.findFirst({ where: { type, entityId: bookingId } });
    return Boolean(row);
  };
  const makeBooking = async () => {
    const wo = await api('/bookos/work-orders', {
      token: setter, method: 'POST',
      body: { customerId: IDS.cust1, appliance: 'Refrigerator', issue: 'Not cooling', city: 'Fort Lauderdale', zip: '33311' },
    });
    if (wo.status !== 201) throw new Error(`work order create failed: ${wo.status} ${JSON.stringify(wo.json)}`);
    return wo.json.data.booking.id;
  };

  // ---------- Gates ----------
  check('anon 401 POST /bookos/appointments', (await api('/bookos/appointments', { method: 'POST', body: {} })).status, 401);
  check('customer 403 POST /bookos/appointments', (await api('/bookos/appointments', { token: customer, method: 'POST', body: {} })).status, 403);

  // ---------- Appointment setting (chosen date + window) ----------
  const b1 = await makeBooking();
  const setDate = etDate(1);
  const set1 = await api('/bookos/appointments', {
    token: setter, method: 'POST',
    body: { bookingId: b1, date: setDate, window: '10-12', setBy: 'Service Setters' },
  });
  check('set appointment 201', set1.status, 201);
  check('appointment status SET', set1.json.data.appointment?.status, 'SET');
  check('appointment date = chosen date', set1.json.data.appointment?.date, setDate);
  check('appointment window = chosen window', set1.json.data.appointment?.window, '10-12');
  check('appointment windowLabel from the window set', set1.json.data.appointment?.windowLabel, '10 AM–12 PM');
  const row1 = await queueRow(b1);
  checkTrue('queue row carries the SET appointment', row1?.appointment?.status === 'SET' && row1?.appointment?.date === setDate && row1?.appointment?.window === '10-12');
  checkTrue('APPOINTMENT_SET event emitted', await eventExists('APPOINTMENT_SET', b1));
  check('second set on a SET booking -> 409', (await api('/bookos/appointments', {
    token: setter, method: 'POST',
    body: { bookingId: b1, date: etDate(2), window: '08-10', setBy: 'Service Setters' },
  })).status, 409);

  // ---------- Past dates refused ----------
  const b2 = await makeBooking();
  const past = await api('/bookos/appointments', {
    token: setter, method: 'POST',
    body: { bookingId: b2, date: etDate(-1), window: '08-10', setBy: 'Service Setters' },
  });
  check('past-date set -> 400', past.status, 400);
  checkTrue('past-date error names the rule', /past/i.test(past.json?.error || ''));
  const row2 = await queueRow(b2);
  check('past-date booking still has no appointment', row2?.appointment, null);

  // ---------- Reschedule (same form, prefilled semantics) ----------
  const newDate = etDate(3);
  const resched = await api(`/bookos/appointments/${b1}/reschedule`, {
    token: setter, method: 'POST',
    body: { date: newDate, window: '14-16', rescheduledBy: 'Service Setters' },
  });
  check('reschedule 200', resched.status, 200);
  check('rescheduled date persisted', resched.json.data.appointment?.date, newDate);
  check('rescheduled window persisted', resched.json.data.appointment?.window, '14-16');
  check('rescheduled windowLabel', resched.json.data.appointment?.windowLabel, '2–4 PM');
  check('previous slot returned', resched.json.data.previousAppointment?.date, setDate);
  check('previous window returned', resched.json.data.previousAppointment?.window, '10-12');
  const row1b = await queueRow(b1);
  checkTrue('queue row shows the rescheduled slot', row1b?.appointment?.date === newDate && row1b?.appointment?.window === '14-16');
  checkTrue('APPOINTMENT_RESCHEDULED event emitted', await eventExists('APPOINTMENT_RESCHEDULED', b1));
  check('reschedule to a past date -> 400', (await api(`/bookos/appointments/${b1}/reschedule`, {
    token: setter, method: 'POST',
    body: { date: etDate(-2), window: '08-10', rescheduledBy: 'Service Setters' },
  })).status, 400);

  // ---------- Dispatching team ----------
  const b3 = await makeBooking();
  const suggest = await api(`/crm/bookings/${b3}/speedy-match`, { token: setter });
  const suggestions = suggest.json.data.suggestions || [];
  checkTrue('Speedy Suggest returns ranked candidates', suggestions.length >= 1);
  checkTrue('Speedy Suggest includes the matching provider', suggestions.some((s) => s.providerId === IDS.provA));
  checkTrue('Speedy Suggest excludes the non-matching provider', !suggestions.some((s) => s.providerId === IDS.provB));
  checkTrue('Speedy Suggest candidates carry reasons', suggestions.every((s) => Array.isArray(s.reasons) && s.reasons.length >= 1));

  const roster = await api('/bookos/providers', { token: setter });
  const rosterById = Object.fromEntries((roster.json.data || []).map((p) => [p.id, p]));
  check('roster tags network provider NETWORK', rosterById[IDS.provA]?.system, 'NETWORK');
  check('roster tags crew provider COMPANY', rosterById[IDS.provCrew]?.system, 'COMPANY');

  check('approve before match -> 409', (await api('/dispatch/approve', {
    token: setter, method: 'POST',
    body: { bookingId: b3, providerId: IDS.provA, approvedBy: 'Service Setters' },
  })).status, 409);

  const match = await api('/dispatch/match', { token: setter, method: 'POST', body: { bookingId: b3 } });
  check('auto-match 200', match.status, 200);
  check('booking now MATCH_PENDING_APPROVAL', match.json.data.bookingStatus, 'MATCH_PENDING_APPROVAL');
  const candIds = (match.json.data.candidates || []).map((c) => c.providerId);
  checkTrue('match candidates include provider A', candIds.includes(IDS.provA));
  checkTrue('match candidates exclude provider B', !candIds.includes(IDS.provB));
  checkTrue('job appears in board Awaiting Approval', (await boardGroup('MATCH_PENDING_APPROVAL')).some((b) => b.bookingId === b3));

  check('approve a non-candidate -> 422', (await api('/dispatch/approve', {
    token: setter, method: 'POST',
    body: { bookingId: b3, providerId: IDS.provB, approvedBy: 'Service Setters' },
  })).status, 422);

  const approve = await api('/dispatch/approve', {
    token: setter, method: 'POST',
    body: { bookingId: b3, providerId: IDS.provA, approvedBy: 'Service Setters' },
  });
  check('approve candidate 200', approve.status, 200);
  check('booking CONFIRMED after approve', approve.json.data.booking?.status, 'CONFIRMED');
  check('assignment APPROVED', approve.json.data.assignment?.status, 'APPROVED');
  check('assignment provider is the pick', approve.json.data.assignment?.providerId, IDS.provA);
  checkTrue('job lands in board Confirmed / Dispatched', (await boardGroup('CONFIRMED')).some((b) => b.bookingId === b3));
  checkTrue('job leaves board Awaiting Approval', !(await boardGroup('MATCH_PENDING_APPROVAL')).some((b) => b.bookingId === b3));
  check('job leaves the setter queue', await queueRow(b3), null);
  checkTrue('DISPATCH_APPROVED event emitted', await eventExists('DISPATCH_APPROVED', b3));

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
    await cleanup().catch(() => {});
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
