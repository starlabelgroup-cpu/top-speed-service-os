/**
 * Live arrival-window picker drill (LOCAL ONLY — throwaway test DB).
 *
 * A1 (2026-11-20): proves the public availability read end to end —
 * capacity UNSET → every window OPEN + capacityConfigured false;
 * capacity SET → per-window cap = ceil(day ceiling / 5) derived from
 * the office's real GET /bookos/capacity ceiling; SET appointments
 * count toward their window, CANCELLED/COMPLETED bookings do not;
 * a window filled to its cap reads CLOSED/FULL; yesterday reads
 * CLOSED/PAST; today's passed windows read CLOSED/PAST on the
 * America/New_York clock; POST /speedy/book and POST /bookings
 * store the picked preferredWindow + preferredDate and the setter
 * queue brief carries both; an invalid preferredDate is a 400; the
 * six picker surfaces carry their static markers.
 *
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5487/wave1_window_picker
 */
import { PrismaClient } from '@prisma/client';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

process.env.DATABASE_URL =
  process.env.WINDOW_AVAIL_TEST_DATABASE_URL ||
  'postgresql://postgres@127.0.0.1:5487/wave1_window_picker';
process.env.DATABASE_URL_UNPOOLED = process.env.DATABASE_URL;
process.env.JWT_SECRET = 'window-avail-test-secret';

const { persistBooking, persistCustomer } = await import('../src/db/bookingsRepo.js');
const { hashPassword } = await import('../src/services/passwords.js');

const prisma = new PrismaClient();
const PORT = 3317;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const PLATFORM_COMPANY_ID = '10000000-0000-4000-8000-000000000001';

const IDS = {
  staff: '20000000-0000-4000-8000-0000000000e1',
  customerUser: '20000000-0000-4000-8000-0000000000e2',
  providerCompany: '20000000-0000-4000-8000-0000000000e3',
  providerA: '30000000-0000-4000-8000-0000000000e1',
  providerB: '30000000-0000-4000-8000-0000000000e2',
  providerOff: '30000000-0000-4000-8000-0000000000e3',
  customer: '40000000-0000-4000-8000-0000000000e1',
};

const B = {
  apptActive: '50000000-0000-4000-8000-0000000000e1',
  apptCancelled: '50000000-0000-4000-8000-0000000000e2',
  apptDone1: '50000000-0000-4000-8000-0000000000e3',
  apptDone2: '50000000-0000-4000-8000-0000000000e4',
  fill1: '50000000-0000-4000-8000-0000000000e5',
  fill2: '50000000-0000-4000-8000-0000000000e6',
  fill3: '50000000-0000-4000-8000-0000000000e7',
  fill4: '50000000-0000-4000-8000-0000000000e8',
  fill5: '50000000-0000-4000-8000-0000000000e9',
  fill6: '50000000-0000-4000-8000-0000000000ea',
  fill7: '50000000-0000-4000-8000-0000000000eb',
  fill8: '50000000-0000-4000-8000-0000000000ec',
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
  const res = await api('/auth/login', { method: 'POST', body: { email, password: 'WindowAvail!234' } });
  if (!res.json?.token) throw new Error(`login failed for ${email}: ${JSON.stringify(res.json)}`);
  return res.json.token;
}

// America/New_York calendar helpers — the same clock the API uses.
function nyParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  return { y: get('year'), m: get('month'), d: get('day'), minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}
function nyDay(offsetDays) {
  const { y, m, d } = nyParts();
  return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d) + offsetDays)).toISOString().slice(0, 10);
}
const TODAY = nyDay(0);
const TOMORROW = nyDay(1);
const YESTERDAY = nyDay(-1);

const CUSTOMER = {
  id: IDS.customer, companyId: PLATFORM_COMPANY_ID, userId: null,
  name: 'Window Drill Customer', phone: '9545550139', email: 'wavail-customer@test.local',
  address: '12 Test Way', city: 'Fort Lauderdale', zip: '33311', createdAt: new Date().toISOString(),
};

function mkBooking(id, referenceCode, over = {}) {
  return {
    id, companyId: PLATFORM_COMPANY_ID, customerId: CUSTOMER.id, customer: CUSTOMER,
    referenceCode, source: 'WEB_FORM', city: 'Fort Lauderdale', area: 'Fort Lauderdale', zip: '33311',
    appliance: 'Refrigerator', issue: 'Not cooling', preferredWindow: null, preferredDate: null,
    diagnosticFee: 99, diagnosticFeeCreditedTowardRepair: true, feeStatus: 'COLLECTED_AT_BOOKING',
    status: 'PENDING_DISPATCH', areaStatus: 'IN_AREA', history: [], appointment: null, dispatch: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...over,
  };
}

function setAppt(window, label) {
  return { date: TOMORROW, window, windowLabel: label, status: 'SET', setAt: new Date().toISOString(), setBy: 'drill', history: [] };
}

async function seed() {
  // Fresh-run semantics: capacity starts UNSET for the whole drill DB.
  await prisma.dispatchSetting.deleteMany({});
  const passwordHash = await hashPassword('WindowAvail!234');
  await prisma.company.upsert({
    where: { id: PLATFORM_COMPANY_ID },
    update: {},
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'window-avail-platform', type: 'PLATFORM_OWNER', isPlatformOwner: true },
  });
  await prisma.company.upsert({
    where: { id: IDS.providerCompany },
    update: {},
    create: { id: IDS.providerCompany, name: 'Window Drill Provider Co', slug: 'window-avail-provider', type: 'INDEPENDENT_PROVIDER' },
  });
  for (const [id, name, active] of [
    [IDS.providerA, 'Window Tech A', true],
    [IDS.providerB, 'Window Tech B', true],
    [IDS.providerOff, 'Window Tech Off', false],
  ]) {
    await prisma.provider.upsert({
      where: { id },
      update: { active },
      create: { id, companyId: IDS.providerCompany, businessName: name, type: 'INDEPENDENT_PROVIDER', specialties: ['Refrigerator'], serviceCities: ['Fort Lauderdale'], rating: null, active },
    });
  }
  await prisma.user.upsert({
    where: { id: IDS.staff },
    update: { passwordHash },
    create: { id: IDS.staff, companyId: PLATFORM_COMPANY_ID, email: 'wavail-staff@test.local', passwordHash, phone: '9545550101', roles: ['DISPATCHER'], active: true },
  });
  await prisma.user.upsert({
    where: { id: IDS.customerUser },
    update: { passwordHash },
    create: { id: IDS.customerUser, companyId: PLATFORM_COMPANY_ID, email: 'wavail-user@test.local', passwordHash, phone: '9545550102', roles: ['CUSTOMER'], active: true },
  });
  await persistCustomer(CUSTOMER);
  // Tomorrow 10-12: one live SET appointment + one on a CANCELLED
  // booking (must not count). Tomorrow 12-14: two SET appointments,
  // both on COMPLETED bookings (must not count).
  await persistBooking(mkBooking(B.apptActive, 'TS-WAVAIL-A1', { status: 'CONFIRMED', appointment: setAppt('10-12', '10 AM – 12 PM') }));
  await persistBooking(mkBooking(B.apptCancelled, 'TS-WAVAIL-A2', { status: 'CANCELLED', appointment: setAppt('10-12', '10 AM – 12 PM') }));
  await persistBooking(mkBooking(B.apptDone1, 'TS-WAVAIL-A3', { status: 'COMPLETED', appointment: setAppt('12-14', '12 – 2 PM') }));
  await persistBooking(mkBooking(B.apptDone2, 'TS-WAVAIL-A4', { status: 'COMPLETED', appointment: setAppt('12-14', '12 – 2 PM') }));
  // Plain in-area bookings the drill appoints into 08-10 live (the
  // platform seed adds its own active providers, so the cap is
  // derived from the capacity response, never assumed — seed more
  // fill bookings than any sane cap needs). Each fill sits in its
  // OWN service area: the setter route caps crews per area+window,
  // and this drill fills the company-wide window cap.
  const FILL_AREAS = ['Fort Lauderdale', 'Davie', 'Hollywood', 'Pembroke Pines', 'Miramar', 'Coral Springs', 'Plantation', 'Sunrise'];
  let fillIdx = 0;
  for (const [key, ref] of Object.entries(B)) {
    if (!key.startsWith('fill')) continue;
    await persistBooking(mkBooking(B[key], `TS-WAVAIL-${ref}`, { area: FILL_AREAS[fillIdx % FILL_AREAS.length] }));
    fillIdx += 1;
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

function win(avail, id) {
  return (avail.json?.data?.windows || []).find((w) => w.id === id) || {};
}

async function main() {
  await seed();
  server = spawn('node', ['src/server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      ...process.env,
      PORT: String(PORT),
      JWT_SECRET: 'window-avail-test-secret',
      DATABASE_URL: process.env.DATABASE_URL,
      DATABASE_URL_UNPOOLED: process.env.DATABASE_URL,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[api] ${d}`));
  await waitForServer();

  const staff = await login('wavail-staff@test.local');
  const customer = await login('wavail-user@test.local');

  // ---- Phase 1: capacity UNSET → all OPEN, flagged unconfigured ----
  const unset = await api(`/speedy/availability?date=${TOMORROW}`);
  check('unset availability 200', unset.status, 200);
  check('unset capacityConfigured', unset.json?.data?.capacityConfigured, false);
  check('unset date echoes', unset.json?.data?.date, TOMORROW);
  check('unset five windows', unset.json?.data?.windows?.length, 5);
  checkTrue('unset all OPEN', (unset.json?.data?.windows || []).every((w) => w.status === 'OPEN'),
    JSON.stringify(unset.json?.data?.windows));
  const noDate = await api('/speedy/availability');
  check('no-date defaults to NY today', noDate.json?.data?.date, TODAY);
  check('invalid date 400', (await api('/speedy/availability?date=banana')).status, 400);

  // ---- Phase 2: office sets capacity → ceiling drives the cap ----
  const put = await api('/bookos/capacity-settings', {
    token: staff, method: 'PUT',
    body: { bufferPercent: 25, minutesPerJob: 120, workingHoursPerDay: 8 },
  });
  check('capacity settings save 200', put.status, 200);
  const cap = await api('/bookos/capacity', { token: staff });
  checkTrue('capacity counts at least the 2 drill technicians', (cap.json?.data?.technicians || 0) >= 2,
    `technicians=${cap.json?.data?.technicians}`);
  // The ceiling is exact against the office's own formula:
  // technicians × hours × 60 × (1 − buffer) ÷ minutesPerJob, floored.
  const expectedCeiling = Math.floor((cap.json.data.technicians * 8 * 60 * (1 - 25 / 100)) / 120);
  check('capacity ceiling matches the formula', cap.json?.data?.ceilingJobs, expectedCeiling);
  const perWindowCap = Math.max(1, Math.ceil((cap.json?.data?.ceilingJobs || 0) / 5));
  checkTrue('per-window cap derived from the ceiling', perWindowCap >= 1 && perWindowCap <= 8,
    `cap=${perWindowCap}`);

  // ---- Phase 3: configured; cancelled/completed do not count ----
  const conf = await api(`/speedy/availability?date=${TOMORROW}`);
  check('configured flag', conf.json?.data?.capacityConfigured, true);
  check('10-12 OPEN with 1 of 2 counted (cancelled ignored)', win(conf, '10-12').status, 'OPEN');
  check('12-14 OPEN with 0 counted (completed ignored)', win(conf, '12-14').status, 'OPEN');
  check('08-10 OPEN before fills', win(conf, '08-10').status, 'OPEN');

  // ---- Phase 4: fill 08-10 to the cap through the real setter route ----
  const fillIds = Object.keys(B).filter((k) => k.startsWith('fill')).map((k) => B[k]);
  for (let i = 0; i < perWindowCap; i += 1) {
    const set = await api('/bookos/appointments', {
      token: staff, method: 'POST',
      body: { bookingId: fillIds[i], date: TOMORROW, window: '08-10', setBy: 'drill' },
    });
    check(`appointment ${i + 1} of ${perWindowCap} set`, set.status, 201);
  }
  const filled = await api(`/speedy/availability?date=${TOMORROW}`);
  check('08-10 CLOSED at cap', win(filled, '08-10').status, 'CLOSED');
  check('08-10 reason FULL', win(filled, '08-10').reason, 'FULL');
  check('10-12 still OPEN', win(filled, '10-12').status, 'OPEN');
  check('16-18 still OPEN', win(filled, '16-18').status, 'OPEN');

  // ---- Phase 5: past honesty on the New York clock ----
  const yday = await api(`/speedy/availability?date=${YESTERDAY}`);
  checkTrue('yesterday all CLOSED/PAST',
    (yday.json?.data?.windows || []).every((w) => w.status === 'CLOSED' && w.reason === 'PAST'),
    JSON.stringify(yday.json?.data?.windows));
  const nowMinutes = nyParts().minutes;
  const today = await api(`/speedy/availability?date=${TODAY}`);
  const ENDS = { '08-10': 600, '10-12': 720, '12-14': 840, '14-16': 960, '16-18': 1080 };
  for (const [id, end] of Object.entries(ENDS)) {
    const expected = end <= nowMinutes ? 'CLOSED' : 'OPEN';
    check(`today ${id} ${expected} (NY now ${nowMinutes}m)`, win(today, id).status, expected);
    if (expected === 'CLOSED') check(`today ${id} reason PAST`, win(today, id).reason, 'PAST');
  }

  // ---- Phase 6: public booking stores the picked window + date ----
  const speedyBook = await api('/speedy/book', {
    method: 'POST',
    body: {
      customer: { name: 'Window Picker Guest', phone: '9545550141' },
      city: 'Fort Lauderdale', zip: '33311', appliance: 'Refrigerator',
      issue: 'Not cooling', preferredWindow: '10-12', preferredDate: TOMORROW,
    },
  });
  check('speedy/book 201', speedyBook.status, 201);
  check('speedy/book echoes preferredWindow', speedyBook.json?.data?.preferredWindow, '10-12');
  check('speedy/book echoes preferredDate', speedyBook.json?.data?.preferredDate, TOMORROW);
  const ref = speedyBook.json?.data?.referenceCode;
  const queue = await api('/bookos/setter-queue', { token: staff });
  const row = (queue.json?.data?.queue || []).find((q) => q.referenceCode === ref);
  checkTrue('setter queue carries the booking', !!row, `ref ${ref}`);
  check('queue brief preferredWindow', row?.preferredWindow, '10-12');
  check('queue brief preferredDate', row?.preferredDate, TOMORROW);

  const badDate = await api('/speedy/book', {
    method: 'POST',
    body: {
      customer: { name: 'Bad Date Guest', phone: '9545550142' },
      city: 'Fort Lauderdale', zip: '33311', appliance: 'Washer',
      issue: 'Leaking', preferredWindow: '10-12', preferredDate: '2026-02-30',
    },
  });
  check('speedy/book invalid preferredDate 400', badDate.status, 400);

  // ---- Phase 7: signed-in booking path stores both fields too ----
  const signedBook = await api('/bookings', {
    token: customer, method: 'POST',
    body: {
      customer: { name: 'Window Picker Member', phone: '9545550143' },
      city: 'Fort Lauderdale', zip: '33311', appliance: 'Dryer',
      issue: 'No heat', preferredWindow: '14-16', preferredDate: TOMORROW,
    },
  });
  check('POST /bookings 201', signedBook.status, 201);
  const stored = await prisma.serviceRequest.findUnique({ where: { id: signedBook.json?.data?.id } });
  check('stored preferredWindow', stored?.preferredWindow, '14-16');
  check('stored preferredDate', stored?.preferredDate, TOMORROW);
  const badSigned = await api('/bookings', {
    token: customer, method: 'POST',
    body: {
      customer: { name: 'Bad Date Member', phone: '9545550144' },
      city: 'Fort Lauderdale', zip: '33311', appliance: 'Dryer',
      issue: 'No heat', preferredDate: 'not-a-date',
    },
  });
  check('POST /bookings invalid preferredDate 400', badSigned.status, 400);

  // ---- Phase 8: static picker markers on all six surfaces ----
  const web = (p) => readFile(fileURLToPath(new URL(`../../web/${p}`, import.meta.url)), 'utf8');
  const bookPage = await web('book/index.html');
  checkTrue('/book has the date input', bookPage.includes('id="wDate"'));
  checkTrue('/book reads availability', bookPage.includes('/speedy/availability'));
  checkTrue('/book submits preferredDate', bookPage.includes("preferredDate:val('wDate')"));
  const home = await web('index.html');
  checkTrue('homepage wizard has the date input', home.includes('id="wDate"'));
  checkTrue('homepage Speedy offers windows post-confirm', home.includes('spPostBooking') && home.includes('spSendPick'));
  const speedyPage = await web('speedy/index.html');
  checkTrue('/speedy page offers windows post-confirm', speedyPage.includes('spPostBooking') && speedyPage.includes('/speedy/availability'));
  const widget = await web('speedy-widget.js');
  checkTrue('widget offers windows post-confirm', widget.includes('renderPickCard') && widget.includes('sendBooking'));
  checkTrue('widget sends preferredDate', widget.includes('bookPayload.preferredDate'));
  const app = await web('app/index.html');
  checkTrue('/app form chips read availability', app.includes('loadAppAvail') && app.includes('/speedy/availability'));
  checkTrue('/app Speedy offers windows post-confirm', app.includes('aspOfferWindows') && app.includes('aspSendPick'));
  checkTrue('/app form submits preferredDate', app.includes('preferredDate:booking.date'));
  const bookOs = await web('book-os/index.html');
  checkTrue('Book OS queue shows preferredDate', bookOs.includes('q.preferredDate'));

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
}

main()
  .catch((error) => {
    failures += 1;
    console.error('DRILL ERROR:', error);
  })
  .finally(async () => {
    if (server) server.kill('SIGTERM');
    await prisma.$disconnect();
    process.exit(failures === 0 ? 0 : 1);
  });
