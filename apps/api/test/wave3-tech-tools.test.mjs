/**
 * Wave 3 field & parts tools drills (2026-11-20) — Ramone's approved
 * recommendations D9 + D10 + D11 + D15:
 *
 *  D9  GET /provider/earnings — a JOB VALUE statement. The platform
 *      records what a job billed (invoice, else estimate) and what
 *      was collected (receipts + PAID Stripe payments); it records NO
 *      tech pay rate or split, so the suite pins payDataAvailable
 *      false and the exact value math per period (America/New_York).
 *  D10 GET /parts/reorder-list — low company-shelf parts tied to the
 *      jobs that consumed them, plus the low-stock alert that fires
 *      ONCE when a part crosses its reorder point (usage + adjust
 *      doors), never when it was already low.
 *  D11 GET /provider/assignments/:id/qr + POST /provider/jobs/resolve —
 *      the job QR payload, and Plug's resolve: a scanned/typed code
 *      binds to the tech's OWN active assignment or fails with its
 *      own clean error (unrecognized / not found / not yours / not
 *      active); photos then attach through the existing door.
 *  D15 GET /link-center/qr — print QRs for the catalog links +
 *      referral + job; PAYMENT is refused (checkout URLs expire).
 *
 * Everything is local: the API boots against DATABASE_URL (a fresh
 * drill Postgres). No external provider is contacted.
 *
 * Run: DATABASE_URL=postgresql://postgres@127.0.0.1:5561/wave3drill \
 *      node test/wave3-tech-tools.test.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { PLATFORM_COMPANY_ID } from '../src/data/store.js';
import { hashPassword } from '../src/services/passwords.js';
import { jobPlugUrl, parseJobCode, qrSvg, referralUrl } from '../src/services/qrCodes.js';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required for the wave3 drills');
  process.exit(2);
}

const PORT = Number(process.env.TEST_PORT || 4493);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const PASSWORD = 'Wave3-Drill-Pass-123!';
const P = 'd9000000-0000-4000-8000-0000000000';
const IDS = {
  companyA: `${P}c1`,
  companyB: `${P}c2`,
  staff: `${P}01`,
  customerUser: `${P}02`,
  owner: `${P}03`,
  techA: `${P}04`,
  techB: `${P}05`,
  customer: `${P}06`,
  provA: `${P}11`,
  provB: `${P}12`,
  supplier: `${P}21`,
  part1: `${P}31`,
  part2: `${P}32`,
  part3: `${P}33`,
};
const B = {
  job1: `${P}41`, job2: `${P}42`, job3: `${P}43`, job4: `${P}44`, job5: `${P}45`,
  job6: `${P}46`, job7: `${P}47`, job8: `${P}48`, job9: `${P}49`,
};
const A = {
  job1: `${P}51`, job2: `${P}52`, job3: `${P}53`, job4: `${P}54`, job5: `${P}55`,
  job6: `${P}56`, job7: `${P}57`, job8: `${P}58`, job9: `${P}59`,
};
const EMAILS = {
  staff: 'w3-staff@test.local',
  customer: 'w3-customer@test.local',
  owner: 'w3-owner@test.local',
  techA: 'w3-techa@test.local',
  techB: 'w3-techb@test.local',
};
const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAwMCAO+ip1sAAAAASUVORK5CYII=';

// Period fixtures in America/New_York calendar terms.
const nyToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const [nyY, nyM] = nyToday.split('-').map(Number);
const firstOfMonth = new Date(Date.UTC(nyY, nyM - 1, 1, 16, 0, 0));
const lastMonth15 = new Date(Date.UTC(nyY, nyM - 2, 15, 16, 0, 0));

const prisma = new PrismaClient();
let server = null;
let failures = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}
function checkIncludes(label, haystack, needle) {
  const ok = typeof haystack === 'string' && haystack.includes(needle);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (want text containing ${JSON.stringify(needle)})`);
}
function checkTrue(label, value) {
  check(label, Boolean(value), true);
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
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
}

async function login(email) {
  const { status, json } = await api('/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  if (status !== 200 || !json?.token) throw new Error(`login failed for ${email}: ${status} ${JSON.stringify(json)}`);
  return json.token;
}

async function waitForServer() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/v1/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('server did not come up');
}

function bootServer() {
  const childEnv = { ...process.env, PORT: String(PORT) };
  childEnv['JWT_' + 'SECRET'] = 'wave3-drill-secret';
  delete childEnv['RESEND_' + 'API_KEY'];
  delete childEnv['TWILIO_' + 'ACCOUNT_SID'];
  delete childEnv['STRIPE_' + 'SECRET_KEY'];
  server = spawn('node', ['src/server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[api] ${d}`));
  return waitForServer();
}

async function stopServer() {
  if (!server) return;
  const stopped = new Promise((resolve) => server.once('exit', resolve));
  server.kill('SIGTERM');
  await Promise.race([stopped, new Promise((r) => setTimeout(r, 5000))]);
  server = null;
}

async function seed() {
  const passwordHash = await hashPassword(PASSWORD);
  await prisma.company.upsert({
    where: { id: PLATFORM_COMPANY_ID },
    update: {},
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'w3-platform', type: 'PLATFORM_OWNER', isPlatformOwner: true },
  });
  for (const [id, name, slug] of [
    [IDS.companyA, 'Drill Tech A Co', 'w3-tech-a'],
    [IDS.companyB, 'Drill Tech B Co', 'w3-tech-b'],
  ]) {
    await prisma.company.upsert({
      where: { id },
      update: {},
      create: { id, name, slug, type: 'NETWORK_BUSINESS', isPlatformOwner: false },
    });
  }
  const users = [
    [IDS.staff, PLATFORM_COMPANY_ID, EMAILS.staff, ['DISPATCHER']],
    [IDS.customerUser, PLATFORM_COMPANY_ID, EMAILS.customer, ['CUSTOMER']],
    [IDS.owner, PLATFORM_COMPANY_ID, EMAILS.owner, ['COMPANY_OWNER']],
    [IDS.techA, IDS.companyA, EMAILS.techA, ['PROVIDER_OWNER']],
    [IDS.techB, IDS.companyB, EMAILS.techB, ['PROVIDER_OWNER']],
  ];
  for (const [id, companyId, email, roles] of users) {
    await prisma.user.upsert({
      where: { id },
      update: { passwordHash },
      create: { id, companyId, email, firstName: 'Wave3', lastName: 'Drill', passwordHash, roles, active: true },
    });
  }
  await prisma.customer.upsert({
    where: { id: IDS.customer },
    update: {},
    create: { id: IDS.customer, companyId: PLATFORM_COMPANY_ID, userId: IDS.customerUser, name: 'Drill Customer', phone: '9545550123', email: EMAILS.customer, city: 'Fort Lauderdale', zip: '33301' },
  });
  for (const [id, companyId, businessName] of [
    [IDS.provA, IDS.companyA, 'Drill Tech A LLC'],
    [IDS.provB, IDS.companyB, 'Drill Tech B LLC'],
  ]) {
    await prisma.provider.upsert({
      where: { id },
      update: {},
      create: { id, companyId, businessName, type: 'NETWORK_BUSINESS', specialties: [], serviceCities: [], active: true },
    });
  }
  const booking = (id, referenceCode, status, completedAt, history = []) => ({
    id, companyId: PLATFORM_COMPANY_ID, customerId: IDS.customer,
    city: 'Fort Lauderdale', zip: '33301', appliance: 'Refrigerator', issue: 'Not cooling',
    referenceCode, source: 'wave3-drill', status, completedAt, history,
  });
  const bookings = [
    booking(B.job1, 'TS-W3JOB1', 'COMPLETED', new Date(), [
      { type: 'RECEIPT_RECORDED', receipt: { amountCents: 10000, method: 'CARD', recordedAt: new Date().toISOString() } },
    ]),
    booking(B.job2, 'TS-W3JOB2', 'COMPLETED', firstOfMonth, [
      { type: 'ESTIMATE_SAVED', estimate: { totalCents: 21000, status: 'APPROVED' } },
    ]),
    booking(B.job3, 'TS-W3JOB3', 'COMPLETED', lastMonth15, []),
    booking(B.job4, 'TS-W3JOB4', 'COMPLETED', null, []),
    booking(B.job5, 'TS-W3JOB5', 'IN_PROGRESS', null, []),
    booking(B.job6, 'TS-W3JOB6', 'COMPLETED', new Date(), [
      { type: 'ESTIMATE_SAVED', estimate: { totalCents: 9900, status: 'APPROVED' } },
    ]),
    booking(B.job7, 'TS-W3JOB7', 'CONFIRMED', null, []),
    booking(B.job8, 'TS-W3JOB8', 'CONFIRMED', null, []),
    booking(B.job9, 'TS-W3JOB9', 'CONFIRMED', null, []),
  ];
  for (const data of bookings) {
    await prisma.serviceRequest.upsert({ where: { id: data.id }, update: { status: data.status, completedAt: data.completedAt, history: data.history }, create: data });
  }
  const assignment = (id, serviceRequestId, providerId, status) => ({
    id, companyId: PLATFORM_COMPANY_ID, serviceRequestId, providerId, status,
  });
  const assignments = [
    assignment(A.job1, B.job1, IDS.provA, 'COMPLETED'),
    assignment(A.job2, B.job2, IDS.provA, 'COMPLETED'),
    assignment(A.job3, B.job3, IDS.provA, 'COMPLETED'),
    assignment(A.job4, B.job4, IDS.provA, 'COMPLETED'),
    assignment(A.job5, B.job5, IDS.provA, 'ACCEPTED'),
    assignment(A.job6, B.job6, IDS.provB, 'COMPLETED'),
    assignment(A.job7, B.job7, IDS.provA, 'ACCEPTED'),
    assignment(A.job8, B.job8, IDS.provB, 'ACCEPTED'),
    assignment(A.job9, B.job9, IDS.provA, 'PROPOSED'),
  ];
  for (const data of assignments) {
    await prisma.dispatchAssignment.upsert({ where: { id: data.id }, update: { status: data.status }, create: data });
  }
  await prisma.invoice.upsert({
    where: { id: `${P}61` },
    update: { total: 300.0 },
    create: { id: `${P}61`, companyId: PLATFORM_COMPANY_ID, serviceRequestId: B.job1, customerId: IDS.customer, status: 'SENT', subtotal: 300.0, total: 300.0 },
  });
  await prisma.invoice.upsert({
    where: { id: `${P}62` },
    update: { total: 150.0 },
    create: { id: `${P}62`, companyId: PLATFORM_COMPANY_ID, serviceRequestId: B.job3, customerId: IDS.customer, status: 'PAID', subtotal: 150.0, total: 150.0 },
  });
  await prisma.payment.upsert({
    where: { id: `${P}63` },
    update: { status: 'PAID', amountCents: 5000 },
    create: { id: `${P}63`, companyId: PLATFORM_COMPANY_ID, serviceRequestId: B.job1, customerId: IDS.customer, purpose: 'REPAIR', amountCents: 5000, status: 'PAID' },
  });
  await prisma.supplier.upsert({
    where: { id: IDS.supplier },
    update: {},
    create: { id: IDS.supplier, name: 'Drill Supply Co', active: true },
  });
  const parts = [
    [IDS.part1, 'W3-PUMP', 'Drain pump', 6, 5],
    [IDS.part2, 'W3-BELT', 'Drive belt', 2, 5],
    [IDS.part3, 'W3-VALVE', 'Water valve', 10, 2],
  ];
  for (const [id, sku, name, stockOnHand, reorderPoint] of parts) {
    await prisma.part.upsert({
      where: { id },
      update: { stockOnHand, reorderPoint },
      create: { id, sku, name, category: 'WASHER', unitCostCents: 4200, stockOnHand, reorderPoint, supplierId: IDS.supplier, active: true },
    });
  }
}

async function waitForReport(eventKey, tries = 12) {
  for (let i = 0; i < tries; i += 1) {
    const row = await prisma.departmentReport.findUnique({ where: { eventKey } });
    if (row) return row;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

async function main() {
  /* ---------- Unit: QR service ---------- */
  check('unit parseJobCode plug URL', parseJobCode('https://applianceplug.app/?job=TS-W3JOB7'), 'TS-W3JOB7');
  check('unit parseJobCode bare lowercase', parseJobCode('ts-w3job7'), 'TS-W3JOB7');
  check('unit parseJobCode garbage', parseJobCode('no code here'), null);
  check('unit parseJobCode empty', parseJobCode(''), null);
  check('unit jobPlugUrl', jobPlugUrl('ts-w3job7'), 'https://applianceplug.app/?job=TS-W3JOB7');
  check('unit referralUrl', referralUrl('FRIEND25'), 'https://topspeedserviceos.com/refer?c=FRIEND25');
  const svg = qrSvg(jobPlugUrl('TS-W3JOB7'));
  checkTrue('unit qrSvg is an svg', svg.startsWith('<svg'));
  checkIncludes('unit qrSvg viewBox 37 (29 modules + quiet zone)', svg, 'viewBox="0 0 37 37"');
  checkTrue('unit qrSvg has dark modules', svg.includes('<path d="M'));

  await seed();
  await bootServer();
  const staffTok = await login(EMAILS.staff);
  const customerTok = await login(EMAILS.customer);
  const ownerTok = await login(EMAILS.owner);
  const techATok = await login(EMAILS.techA);
  const techBTok = await login(EMAILS.techB);

  /* ---------- D9: earnings ---------- */
  const anon = await api('/provider/earnings');
  check('D9 earnings anon 401', anon.status, 401);
  const cust = await api('/provider/earnings', { token: customerTok });
  check('D9 earnings customer 403', cust.status, 403);
  const staffTry = await api('/provider/earnings', { token: staffTok });
  check('D9 earnings dispatcher 403 (provider board only)', staffTry.status, 403);

  const month = await api('/provider/earnings?period=month', { token: techATok });
  check('D9 month status', month.status, 200);
  const md = month.json?.data || {};
  check('D9 month basis is JOB_VALUE', md.basis, 'JOB_VALUE');
  check('D9 month payDataAvailable false', md.payDataAvailable, false);
  checkIncludes('D9 month note is honest about pay', md.note || '', 'does not record tech pay rates');
  check('D9 month totals jobs', md.totals?.jobs, 2);
  check('D9 month totals job value', md.totals?.jobValueCents, 51000);
  check('D9 month totals collected', md.totals?.collectedCents, 15000);
  check('D9 month totals balance', md.totals?.balanceCents, 36000);
  check('D9 month totals without value', md.totals?.jobsWithoutValue, 0);
  checkTrue('D9 counts today >= 1', (md.counts?.completedToday || 0) >= 1);
  const row1 = (md.jobs || []).find((r) => r.referenceCode === 'TS-W3JOB1');
  check('D9 job1 value from invoice', row1?.jobValueCents, 30000);
  check('D9 job1 basis INVOICE', row1?.valueBasis, 'INVOICE');
  check('D9 job1 collected receipts+stripe', row1?.collectedCents, 15000);
  check('D9 job1 balance', row1?.balanceCents, 15000);
  const row2 = (md.jobs || []).find((r) => r.referenceCode === 'TS-W3JOB2');
  check('D9 job2 value from estimate', row2?.jobValueCents, 21000);
  check('D9 job2 basis ESTIMATE', row2?.valueBasis, 'ESTIMATE');
  checkTrue('D9 month excludes last-month job', !(md.jobs || []).some((r) => r.referenceCode === 'TS-W3JOB3'));
  checkTrue('D9 month excludes other provider job', !(md.jobs || []).some((r) => r.referenceCode === 'TS-W3JOB6'));

  const lastMonth = await api('/provider/earnings?period=lastMonth', { token: techATok });
  const lm = lastMonth.json?.data || {};
  check('D9 lastMonth jobs', lm.totals?.jobs, 1);
  check('D9 lastMonth value', lm.totals?.jobValueCents, 15000);

  const all = await api('/provider/earnings?period=all', { token: techATok });
  const ad = all.json?.data || {};
  check('D9 all jobs (incl. no completedAt)', ad.totals?.jobs, 4);
  check('D9 all value', ad.totals?.jobValueCents, 66000);
  check('D9 all jobsWithoutValue', ad.totals?.jobsWithoutValue, 1);
  const row4 = (ad.jobs || []).find((r) => r.referenceCode === 'TS-W3JOB4');
  check('D9 job4 value null, never invented', row4 ? row4.jobValueCents : 'missing', null);

  const week = await api('/provider/earnings?period=week', { token: techATok });
  checkTrue('D9 week includes today job', (week.json?.data?.jobs || []).some((r) => r.referenceCode === 'TS-W3JOB1'));

  const bStmt = await api('/provider/earnings?period=month', { token: techBTok });
  check('D9 tech B own jobs only', bStmt.json?.data?.totals?.jobs, 1);
  check('D9 tech B value', bStmt.json?.data?.totals?.jobValueCents, 9900);

  const over = await api('/provider/earnings?period=month', { token: ownerTok });
  check('D9 oversight flag', over.json?.data?.oversight, true);
  const perA = (over.json?.data?.perProvider || []).find((p) => p.providerId === IDS.provA);
  check('D9 oversight per-provider A month jobs', perA?.totals?.jobs, 2);
  const overOne = await api(`/provider/earnings?period=month&providerId=${IDS.provA}`, { token: ownerTok });
  check('D9 oversight drill-in jobs', overOne.json?.data?.totals?.jobs, 2);
  const overBad = await api(`/provider/earnings?period=month&providerId=${P}99`, { token: ownerTok });
  check('D9 oversight unknown provider 404', overBad.status, 404);

  /* ---------- D11: job QR + resolve + photo attach ---------- */
  const qrAnon = await api(`/provider/assignments/${A.job7}/qr`);
  check('D11 assignment QR anon 401', qrAnon.status, 401);
  const qr = await api(`/provider/assignments/${A.job7}/qr`, { token: techATok });
  check('D11 assignment QR status', qr.status, 200);
  check('D11 assignment QR url', qr.json?.data?.url, 'https://applianceplug.app/?job=TS-W3JOB7');
  check('D11 assignment QR ref', qr.json?.data?.referenceCode, 'TS-W3JOB7');
  checkTrue('D11 assignment QR svg', String(qr.json?.data?.svg || '').startsWith('<svg'));
  const qrOther = await api(`/provider/assignments/${A.job7}/qr`, { token: techBTok });
  check('D11 assignment QR other provider 404', qrOther.status, 404);
  const qrOver = await api(`/provider/assignments/${A.job7}/qr`, { token: ownerTok });
  check('D11 assignment QR oversight 200', qrOver.status, 200);

  const resolve = (token, code) => api('/provider/jobs/resolve', { token, method: 'POST', body: { code } });
  const rUrl = await resolve(techATok, 'https://applianceplug.app/?job=TS-W3JOB7');
  check('D11 resolve plug URL status', rUrl.status, 200);
  check('D11 resolve assignment', rUrl.json?.data?.assignmentId, A.job7);
  check('D11 resolve canAttachPhotos', rUrl.json?.data?.canAttachPhotos, true);
  check('D11 resolve photoCount 0', rUrl.json?.data?.photoCount, 0);
  const rBare = await resolve(techATok, 'ts-w3job7');
  check('D11 resolve bare lowercase ref', rBare.status, 200);
  const rGarbage = await resolve(techATok, 'hello world');
  check('D11 resolve garbage 400', rGarbage.status, 400);
  check('D11 resolve garbage code', rGarbage.json?.code, 'JOB_CODE_UNRECOGNIZED');
  const rMissing = await resolve(techATok, 'TS-NOPE99');
  check('D11 resolve unknown 404', rMissing.status, 404);
  check('D11 resolve unknown code', rMissing.json?.code, 'JOB_NOT_FOUND');
  const rYours = await resolve(techATok, 'TS-W3JOB8');
  check('D11 resolve other provider job 403', rYours.status, 403);
  check('D11 resolve other provider code', rYours.json?.code, 'JOB_NOT_YOURS');
  const rInactive = await resolve(techATok, 'TS-W3JOB9');
  check('D11 resolve proposed job 409', rInactive.status, 409);
  check('D11 resolve proposed code', rInactive.json?.code, 'JOB_NOT_ACTIVE');
  const rCust = await resolve(customerTok, 'TS-W3JOB7');
  check('D11 resolve customer 403', rCust.status, 403);

  const photo = await api(`/provider/assignments/${A.job7}/photos`, {
    token: techATok, method: 'POST',
    body: { category: 'BEFORE', dataUrl: PNG_1PX, caption: 'Drill photo' },
  });
  check('D11 photo attach after resolve 201', photo.status, 201);
  const rAfter = await resolve(techATok, 'TS-W3JOB7');
  check('D11 resolve photoCount 1 after attach', rAfter.json?.data?.photoCount, 1);
  const photoOther = await api(`/provider/assignments/${A.job7}/photos`, {
    token: techBTok, method: 'POST',
    body: { category: 'BEFORE', dataUrl: PNG_1PX },
  });
  check('D11 photo attach by other provider 404', photoOther.status, 404);

  /* ---------- D10: reorder list + low-stock alerts ---------- */
  const roAnon = await api('/parts/reorder-list');
  check('D10 reorder anon 401', roAnon.status, 401);
  const roCust = await api('/parts/reorder-list', { token: customerTok });
  check('D10 reorder customer 403', roCust.status, 403);

  const todayUtc = new Date().toISOString().slice(0, 10);
  const key1 = `low-stock:${IDS.part1}:${todayUtc}`;
  const key3 = `low-stock:${IDS.part3}:${todayUtc}`;

  const use1 = await api('/parts/usage', { token: staffTok, method: 'POST', body: { bookingReference: 'TS-W3JOB7', partId: IDS.part1, qty: 2 } });
  check('D10 usage crossing 201', use1.status, 201);
  const report1 = await waitForReport(key1);
  checkTrue('D10 low-stock alert fired on crossing', Boolean(report1));
  check('D10 alert department', report1?.department, 'parts');
  check('D10 alert type', report1?.type, 'LOW_STOCK');
  check('D10 alert detail stock', report1?.detail?.stockOnHand, 4);

  const use2 = await api('/parts/usage', { token: staffTok, method: 'POST', body: { bookingReference: 'TS-W3JOB7', partId: IDS.part1, qty: 1 } });
  check('D10 usage while low 201', use2.status, 201);
  await new Promise((r) => setTimeout(r, 600));
  const reportsP1 = await prisma.departmentReport.count({ where: { eventKey: key1 } });
  check('D10 alert fired once only', reportsP1, 1);

  const ro1 = await api('/parts/reorder-list', { token: staffTok });
  check('D10 reorder status', ro1.status, 200);
  const rows1 = ro1.json?.data || [];
  const rp1 = rows1.find((r) => r.id === IDS.part1);
  check('D10 reorder P1 on hand after usage', rp1?.stockOnHand, 3);
  check('D10 reorder P1 deficit', rp1?.deficit, 2);
  check('D10 reorder P1 used 30d', rp1?.usedLast30Days, 3);
  check('D10 reorder P1 suggested', rp1?.suggestedReorderQty, 5);
  check('D10 reorder P1 recent job ref', rp1?.recentJobs?.[0]?.bookingReference, 'TS-W3JOB7');
  checkIncludes('D10 reorder P1 basis stated', rp1?.suggestedBasis || '', 'last 30 days');
  const rp2 = rows1.find((r) => r.id === IDS.part2);
  check('D10 reorder P2 (already low) present', rp2?.stockOnHand, 2);
  check('D10 reorder P2 suggested', rp2?.suggestedReorderQty, 3);
  checkTrue('D10 reorder P3 absent (healthy)', !rows1.some((r) => r.id === IDS.part3));

  const overUse = await api('/parts/usage', { token: staffTok, method: 'POST', body: { bookingReference: 'TS-W3JOB7', partId: IDS.part2, qty: 99 } });
  check('D10 usage beyond stock refused 422', overUse.status, 422);

  const adj2 = await api(`/parts/parts/${IDS.part2}/adjust-stock`, { token: staffTok, method: 'POST', body: { delta: -1, reason: 'drill' } });
  check('D10 adjust already-low 200', adj2.status, 200);
  await new Promise((r) => setTimeout(r, 600));
  const reportsP2 = await prisma.departmentReport.count({ where: { eventKey: `low-stock:${IDS.part2}:${todayUtc}` } });
  check('D10 no alert when already low', reportsP2, 0);

  const adj3 = await api(`/parts/parts/${IDS.part3}/adjust-stock`, { token: staffTok, method: 'POST', body: { delta: -9, reason: 'drill crossing' } });
  check('D10 adjust crossing 200', adj3.status, 200);
  const report3 = await waitForReport(key3);
  checkTrue('D10 low-stock alert fired on adjust crossing', Boolean(report3));
  check('D10 alert 3 source', report3?.source, 'parts-adjust');

  const ro2 = await api('/parts/reorder-list', { token: staffTok });
  checkTrue('D10 reorder P3 present after crossing', (ro2.json?.data || []).some((r) => r.id === IDS.part3));

  /* ---------- D15: Link Center QR ---------- */
  const lcAnon = await api('/link-center/qr?type=BOOKING');
  check('D15 qr anon 401', lcAnon.status, 401);
  const lcCust = await api('/link-center/qr?type=BOOKING', { token: customerTok });
  check('D15 qr customer 403', lcCust.status, 403);
  const lcBook = await api('/link-center/qr?type=BOOKING', { token: staffTok });
  check('D15 booking url', lcBook.json?.data?.url, 'https://topspeedserviceos.com/book?src=linkcenter');
  checkTrue('D15 booking svg', String(lcBook.json?.data?.svg || '').startsWith('<svg'));
  const lcReview = await api('/link-center/qr?type=REVIEW', { token: staffTok });
  check('D15 review url', lcReview.json?.data?.url, 'https://pepperlists.com/#reviews');
  const lcAccount = await api('/link-center/qr?type=ACCOUNT', { token: staffTok });
  check('D15 account url', lcAccount.json?.data?.url, 'https://topspeedserviceos.com/app');
  const lcPay = await api('/link-center/qr?type=PAYMENT', { token: staffTok });
  check('D15 payment refused 400', lcPay.status, 400);
  check('D15 payment code', lcPay.json?.code, 'payment_qr_not_printable');
  const lcRefNo = await api('/link-center/qr?type=REFERRAL', { token: staffTok });
  check('D15 referral without code 400', lcRefNo.status, 400);
  check('D15 referral code required code', lcRefNo.json?.code, 'referral_code_required');
  const lcRefBad = await api('/link-center/qr?type=REFERRAL&code=BAD%20CODE!', { token: staffTok });
  check('D15 referral bad code 400', lcRefBad.status, 400);
  const lcRef = await api('/link-center/qr?type=REFERRAL&code=FRIEND25', { token: staffTok });
  check('D15 referral url', lcRef.json?.data?.url, 'https://topspeedserviceos.com/refer?c=FRIEND25');
  const lcJob404 = await api('/link-center/qr?type=JOB&ref=TS-ZZZZ99', { token: staffTok });
  check('D15 job unknown ref 404', lcJob404.status, 404);
  check('D15 job unknown code', lcJob404.json?.code, 'booking_not_found');
  const lcJob = await api('/link-center/qr?type=JOB&ref=TS-W3JOB7', { token: staffTok });
  check('D15 job url', lcJob.json?.data?.url, 'https://applianceplug.app/?job=TS-W3JOB7');
  checkIncludes('D15 job label carries ref', lcJob.json?.data?.label || '', 'TS-W3JOB7');
  const lcBogus = await api('/link-center/qr?type=BOGUS', { token: staffTok });
  check('D15 bogus type 400', lcBogus.status, 400);

  await stopServer();
  console.log(failures === 0 ? '\nALL WAVE3 DRILLS PASSED' : `\n${failures} WAVE3 DRILL(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main()
  .catch(async (error) => {
    console.error('WAVE3 DRILL ERROR', error);
    await stopServer();
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
