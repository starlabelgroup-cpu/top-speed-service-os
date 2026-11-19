/**
 * Advanced Workstation Standard — CRM station (2026-11-19).
 *
 * Station 2 of the rollout (Book OS, workstation-standard.test.mjs,
 * set the pattern). The CRM web-side Options panel + CTA bar live
 * in apps/web/crm/index.html and are ADDITIVE — they change no API
 * contract. THIS suite drills the existing contracts the CRM
 * controls drive, from the CRM surface's perspective:
 *
 *  - The customer list (GET /crm/customers): staff-gated, newest
 *    customers first (the order the console renders by default),
 *    summaries carrying bookingsCount and lastBooking.createdAt —
 *    the two fields the Options panel's sorts stand on.
 *  - The customer record (GET /crm/customers/:id): bookings carry
 *    status / areaStatus / preferredWindow / appointment — the
 *    fields the CTA bar's per-booking blocks render.
 *  - The record's own New work order flow (POST
 *    /crm/customers/:id/work-orders) still creates on the shared
 *    intake and the booking reads back on the same record.
 *  - Appointment setting from the record: POST
 *    /bookos/appointments with a CHOSEN date + window (the five
 *    two-hour APPOINTMENT_WINDOWS) persists a SET appointment that
 *    the CRM record renders back; past dates are refused (400) on
 *    the America/New_York clock; reschedule moves the same slot.
 *  - Enrichment + money: GET /bookings/:id carries the diagnostic
 *    payment state the Send-links block gates on; GET
 *    /bookos/bookings/:id/money returns the read-only summary.
 *  - Link Center sends from the record: a BOOKING link send is
 *    accepted (201) and reports the outbox's TRUE state (with no
 *    providers configured in this drill env it cannot be SENT);
 *    a PAYMENT send without a booking reference is refused (400)
 *    and with one, while Stripe is unconfigured, is refused
 *    honestly (503) — never an invented URL.
 *
 * Runs against a LOCAL test database only. Usage:
 *   DATABASE_URL=postgresql://... node test/workstation-standard-crm.test.mjs
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
  setter: '70000000-0000-4000-8000-0000000000c1',
  customerUser: '70000000-0000-4000-8000-0000000000c3',
  custOld: '70000000-0000-4000-8000-0000000000d1',
  custNew: '70000000-0000-4000-8000-0000000000d2',
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
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'wscrm-platform', type: 'PLATFORM_OWNER', isPlatformOwner: true },
  });
  for (const [id, email, roles] of [
    [IDS.setter, 'wscrm-setter@test.local', ['DISPATCHER']],
    [IDS.customerUser, 'wscrm-customer@test.local', ['CUSTOMER']],
  ]) {
    await prisma.user.upsert({
      where: { id }, update: { passwordHash, verifyRequired: false, layer2Required: false },
      create: { id, companyId: PLATFORM_COMPANY_ID, email, passwordHash, phone: '9545550110', roles, active: true },
    });
  }
  for (const cust of [
    {
      id: IDS.custOld, companyId: PLATFORM_COMPANY_ID, userId: null,
      name: 'CRM Older Customer', phone: '9545550160', email: 'crm-old@test.local',
      address: '200 CRM Station Road', city: 'Fort Lauderdale', zip: '33311',
      createdAt: '2026-11-01T12:00:00.000Z',
    },
    {
      id: IDS.custNew, companyId: PLATFORM_COMPANY_ID, userId: null,
      name: 'CRM Newer Customer', phone: '9545550161', email: 'crm-new@test.local',
      address: '100 Workstation Way', city: 'Fort Lauderdale', zip: '33311',
      createdAt: '2026-11-10T12:00:00.000Z',
    },
  ]) {
    store.customers.set(cust.id, cust);
    await persistCustomer(cust);
  }
}

async function cleanup() {
  try {
    const created = await prisma.serviceRequest.findMany({
      where: { customerId: { in: [IDS.custOld, IDS.custNew] } }, select: { id: true },
    });
    const bookingIds = created.map((r) => r.id);
    await prisma.dispatchAssignment.deleteMany({ where: { serviceRequestId: { in: bookingIds } } });
    await prisma.platformEvent.deleteMany({ where: { entityId: { in: bookingIds } } });
    await prisma.serviceRequest.deleteMany({ where: { id: { in: bookingIds } } });
    await prisma.customer.deleteMany({ where: { id: { in: [IDS.custOld, IDS.custNew] } } });
    await prisma.user.deleteMany({ where: { id: { in: [IDS.setter, IDS.customerUser] } } });
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
  const childEnv = {
    ...process.env,
    PORT: String(PORT),
    JWT_SECRET: ['wscrm', 'drill', 'secret'].join('-'),
    DATABASE_URL: process.env.DATABASE_URL,
    DATABASE_URL_UNPOOLED: process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL,
    OPENAI_API_KEY: '',
    OPENAI_API_KEY_V2: '',
  };
  // No payment / messaging providers in the drill env: sends must
  // report their true unconfigured state, never a fake success.
  childEnv['STRIPE_' + 'SECRET_KEY'] = '';
  childEnv['RESEND_' + 'API_KEY'] = '';
  childEnv['TWILIO_' + 'ACCOUNT_SID'] = '';
  childEnv['TWILIO_' + 'AUTH_TOKEN'] = '';
  childEnv['TWILIO_' + 'PHONE_NUMBER'] = '';
  server = spawn('node', ['src/server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[api] ${d}`));
  await waitForServer();

  const setter = await login('wscrm-setter@test.local');
  const customer = await login('wscrm-customer@test.local');

  const listCustomers = async () => (await api('/crm/customers', { token: setter })).json.data.customers || [];
  const detail = async (id) => (await api(`/crm/customers/${id}`, { token: setter })).json.data;
  const makeWo = async (custId) => {
    const wo = await api(`/crm/customers/${custId}/work-orders`, {
      token: setter, method: 'POST',
      body: { appliance: 'Refrigerator', issue: 'Not cooling', city: 'Fort Lauderdale', zip: '33311' },
    });
    if (wo.status !== 201) throw new Error(`CRM work order create failed: ${wo.status} ${JSON.stringify(wo.json)}`);
    return wo.json.data.booking;
  };

  // ---------- Gates ----------
  check('anon 401 GET /crm/customers', (await api('/crm/customers')).status, 401);
  check('customer 403 GET /crm/customers', (await api('/crm/customers', { token: customer })).status, 403);
  check('anon 401 GET /crm/customers/:id', (await api(`/crm/customers/${IDS.custNew}`)).status, 401);
  check('customer 403 GET /crm/customers/:id', (await api(`/crm/customers/${IDS.custNew}`, { token: customer })).status, 403);

  // ---------- Customer list contract (the Options sorts stand on it) ----------
  const list1 = await listCustomers();
  checkTrue('list returns both seeded customers', [IDS.custOld, IDS.custNew].every((id) => list1.some((c) => c.id === id)));
  const idxNew = list1.findIndex((c) => c.id === IDS.custNew);
  const idxOld = list1.findIndex((c) => c.id === IDS.custOld);
  checkTrue('server order is newest customer first', idxNew > -1 && idxOld > -1 && idxNew < idxOld);
  const sumNew0 = list1.find((c) => c.id === IDS.custNew) || {};
  check('summary bookingsCount starts at 0', sumNew0.bookingsCount, 0);
  checkTrue('summary carries the customer createdAt', typeof sumNew0.createdAt === 'string' && sumNew0.createdAt.length >= 10);

  // ---------- Customer record contract ----------
  const d0 = await detail(IDS.custNew);
  check('record customer phone', d0.customer.phone, '9545550161');
  check('record customer email', d0.customer.email, 'crm-new@test.local');
  check('record bookings starts empty', (d0.bookings || []).length, 0);

  // ---------- New work order from the record (existing flow) ----------
  const bk1 = await makeWo(IDS.custNew);
  checkTrue('work order reference code issued', typeof bk1.referenceCode === 'string' && bk1.referenceCode.startsWith('TS-'));
  const d1 = await detail(IDS.custNew);
  check('record shows the new booking', (d1.bookings || []).length, 1);
  const row1 = (d1.bookings || [])[0] || {};
  check('record booking id matches the create', row1.id, bk1.id);
  check('record booking status', row1.status, 'PENDING_DISPATCH');
  check('record booking areaStatus', row1.areaStatus, 'IN_AREA');
  check('record booking appointment starts unset', row1.appointment, null);
  checkTrue('record booking carries preferredWindow field', 'preferredWindow' in row1);
  const sumNew1 = (await listCustomers()).find((c) => c.id === IDS.custNew) || {};
  check('list bookingsCount now 1', sumNew1.bookingsCount, 1);
  check('list lastBooking reference matches', sumNew1.lastBooking?.referenceCode, bk1.referenceCode);
  checkTrue('list lastBooking carries createdAt (activity sort field)', typeof sumNew1.lastBooking?.createdAt === 'string');

  // ---------- Appointment setting from the record ----------
  const setDate = etDate(2);
  const set1 = await api('/bookos/appointments', {
    token: setter, method: 'POST',
    body: { bookingId: bk1.id, date: setDate, window: '12-14' },
  });
  check('set appointment 201', set1.status, 201);
  check('appointment status SET', set1.json.data.appointment?.status, 'SET');
  check('appointment date = chosen date', set1.json.data.appointment?.date, setDate);
  check('appointment window = chosen window', set1.json.data.appointment?.window, '12-14');
  check('appointment windowLabel from the window set', set1.json.data.appointment?.windowLabel, '12\u20132 PM');
  const d2 = await detail(IDS.custNew);
  const row2 = (d2.bookings || []).find((b) => b.id === bk1.id) || {};
  checkTrue('record renders the SET appointment back', row2.appointment?.status === 'SET' && row2.appointment?.date === setDate && row2.appointment?.window === '12-14');

  const bk2 = await makeWo(IDS.custNew);
  check('past-date set -> 400', (await api('/bookos/appointments', {
    token: setter, method: 'POST',
    body: { bookingId: bk2.id, date: etDate(-1), window: '08-10' },
  })).status, 400);

  const newDate = etDate(4);
  const resched = await api(`/bookos/appointments/${bk1.id}/reschedule`, {
    token: setter, method: 'POST',
    body: { date: newDate, window: '16-18' },
  });
  check('reschedule 200', resched.status, 200);
  const d3 = await detail(IDS.custNew);
  const row3 = (d3.bookings || []).find((b) => b.id === bk1.id) || {};
  checkTrue('record renders the rescheduled slot', row3.appointment?.date === newDate && row3.appointment?.window === '16-18');

  // ---------- Enrichment + money summary ----------
  const full = await api(`/bookings/${bk1.id}`, { token: setter });
  check('enrichment diagnosticPaid false', full.json.data.payment?.diagnosticPaid, false);
  check('enrichment customer phone', full.json.data.customer?.phone, '9545550161');
  const money = await api(`/bookos/bookings/${bk1.id}/money`, { token: setter });
  check('money summary 200', money.status, 200);
  check('money summary estimate starts null', money.json.data.estimate, null);
  check('money summary receipts total 0', money.json.data.payments?.receiptsTotalCents, 0);

  // ---------- Link Center sends from the record ----------
  const send = await api('/link-center/send', {
    token: setter, method: 'POST',
    body: { linkType: 'BOOKING', channel: 'EMAIL', email: 'crm-new@test.local', recipientName: 'CRM Newer Customer', bookingRef: bk1.referenceCode },
  });
  check('booking link send 201', send.status, 201);
  check('booking link type echoed', send.json.data.linkType, 'BOOKING');
  check('booking link url is the real booking door', send.json.data.url, 'https://topspeedserviceos.com/book?src=linkcenter');
  check('booking link reports the true unconfigured state', send.json.data.status, 'GATED');
  check('payment link without a booking ref -> 400', (await api('/link-center/send', {
    token: setter, method: 'POST',
    body: { linkType: 'PAYMENT', channel: 'SMS', phone: '9545550161' },
  })).status, 400);
  check('payment link with Stripe unconfigured -> 503 (no invented URL)', (await api('/link-center/send', {
    token: setter, method: 'POST',
    body: { linkType: 'PAYMENT', channel: 'SMS', phone: '9545550161', bookingRef: bk1.referenceCode },
  })).status, 503);

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
