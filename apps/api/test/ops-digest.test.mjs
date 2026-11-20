/**
 * Pepper morning ops digest (D14, 2026-11-20).
 *
 * Proves, against a real migrated database:
 *  - GET /pepper-console/digest is staff-gated and computes every
 *    section from the real sources: the unassigned job (no active
 *    assignment, no dispatch provider), the exception queue (the
 *    3-day-old awaiting-parts job breaches the 48h parts-delay
 *    threshold), the parts-delay queue, and yesterday's counts on
 *    the America/New_York calendar (created / completed /
 *    assignments approved);
 *  - a section that cannot be read degrades to
 *    { available: false } — never a guessed number (in-process
 *    reader failure);
 *  - POST /pepper-console/digest/draft files exactly one STATUS
 *    report in the Pepper report log and sends NOTHING (the
 *    notification outbox count does not move).
 *
 * Requires DATABASE_URL (a migrated test database). Run:
 *   DATABASE_URL=postgresql://… node test/ops-digest.test.mjs
 */
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/services/passwords.js';
import { PLATFORM_COMPANY_ID } from '../src/data/store.js';
import { persistAssignment, persistBooking, persistCustomer } from '../src/db/bookingsRepo.js';
import { buildOpsDigest, etDateString } from '../src/services/opsDigest.js';

const PORT = Number(process.env.TEST_PORT || 4741);
const JWT_SECRET = 'ops-digest-test-secret';
const PASSWORD = 'OpsDigest!234';
const prisma = new PrismaClient();

const IDS = {
  coA: 'c3000000-0000-4000-8000-000000000001',
  provA: 'c3000000-0000-4000-8000-000000000011',
  staff: 'c3000000-0000-4000-8000-000000000021',
  custUser: 'c3000000-0000-4000-8000-000000000022',
  customer: 'c3000000-0000-4000-8000-000000000031',
};
const B = {
  unassigned: 'c3000000-0000-4000-8000-000000000041',
  parts: 'c3000000-0000-4000-8000-000000000042',
  doneYesterday: 'c3000000-0000-4000-8000-000000000043',
  createdYesterday: 'c3000000-0000-4000-8000-000000000044',
};
const A = {
  parts: 'c3000000-0000-4000-8000-000000000051',
  approvedYesterday: 'c3000000-0000-4000-8000-000000000052',
};

const CUSTOMER = {
  id: IDS.customer, companyId: PLATFORM_COMPANY_ID, userId: null,
  name: 'Digest Test Customer', phone: '9545550161', email: 'digest-customer@test.local',
  address: '3 Test Way', city: 'Fort Lauderdale', zip: '33311', createdAt: new Date().toISOString(),
};

/** ET calendar date N days before today, at a fixed UTC hour. */
function etDateDaysAgo(n, hourUtc = 15) {
  const todayEt = etDateString(new Date());
  const d = new Date(`${todayEt}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return { date: d.toISOString().slice(0, 10), at: `${d.toISOString().slice(0, 10)}T${String(hourUtc).padStart(2, '0')}:00:00.000Z` };
}

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok' : '  FAIL'} ${name}${ok ? '' : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}
function checkTrue(name, value, detail = '') {
  if (!value) failures += 1;
  console.log(`${value ? '  ok' : '  FAIL'} ${name}${value ? '' : ` — ${detail}`}`);
}

async function api(base, path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${base}${path}`, {
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

function mintToken(userId, companyId, email, roles) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: userId, companyId, email, roles,
    exp: Math.floor(Date.now() / 1000) + 3600,
  })).toString('base64url');
  const signature = createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

function spawnServer(port) {
  const env = { ...process.env, PORT: String(port), JWT_SECRET };
  delete env.OPENAI_API_KEY;
  delete env.OPENAI_API_KEY_V2;
  const server = spawn('node', ['src/server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[api:${port}] ${d}`));
  return server;
}

async function waitForServer(base) {
  for (let i = 0; i < 90; i += 1) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('server did not come up');
}

function mkBooking(id, referenceCode, over = {}) {
  const now = new Date().toISOString();
  return {
    id, companyId: PLATFORM_COMPANY_ID, customerId: CUSTOMER.id, customer: CUSTOMER,
    referenceCode, source: 'WEB_FORM', city: 'Fort Lauderdale', area: 'Fort Lauderdale', zip: '33311',
    appliance: 'Refrigerator', issue: 'Not cooling', preferredWindow: null,
    diagnosticFee: 99, diagnosticFeeCreditedTowardRepair: true, feeStatus: 'COLLECTED_AT_BOOKING',
    status: 'PENDING_DISPATCH', areaStatus: 'IN_AREA', history: [], appointment: null, dispatch: null,
    createdAt: now, updatedAt: now, ...over,
  };
}

function mkAssignment(id, bookingId, status, over = {}) {
  const now = new Date().toISOString();
  return {
    id, companyId: PLATFORM_COMPANY_ID, bookingId, providerId: IDS.provA, providerCompanyId: IDS.coA,
    status, dispatchMode: 'HYBRID', approvalRequired: true, matchScore: 90,
    createdAt: now, approvedBy: null, approvedAt: null, ...over,
  };
}

async function seed() {
  const passwordHash = await hashPassword(PASSWORD);
  const twoDays = etDateDaysAgo(2);
  const threeDays = etDateDaysAgo(3);
  const yesterday = etDateDaysAgo(1);
  await prisma.company.upsert({
    where: { id: PLATFORM_COMPANY_ID },
    update: {},
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'digest-test-platform', type: 'PLATFORM_OWNER', isPlatformOwner: true },
  });
  await prisma.company.upsert({
    where: { id: IDS.coA },
    update: {},
    create: { id: IDS.coA, name: 'Digest Provider Co', slug: 'digest-provider-co', type: 'INDEPENDENT_PROVIDER' },
  });
  await prisma.provider.upsert({
    where: { id: IDS.provA },
    update: { active: true },
    create: { id: IDS.provA, companyId: IDS.coA, businessName: 'Digest Appliance Pros', type: 'INDEPENDENT_PROVIDER', specialties: ['Refrigerator'], serviceCities: ['Fort Lauderdale'], rating: null, active: true },
  });
  const users = [
    { id: IDS.staff, companyId: PLATFORM_COMPANY_ID, email: 'digest-staff@test.local', roles: ['DISPATCHER'] },
    { id: IDS.custUser, companyId: PLATFORM_COMPANY_ID, email: 'digest-customer-user@test.local', roles: ['CUSTOMER'] },
  ];
  for (const u of users) {
    await prisma.user.upsert({
      where: { id: u.id },
      update: { passwordHash },
      create: { id: u.id, companyId: u.companyId, email: u.email, passwordHash, phone: '9545550160', roles: u.roles, active: true },
    });
  }
  await persistCustomer(CUSTOMER);
  await persistBooking(mkBooking(B.unassigned, 'TS-DGST01', { createdAt: twoDays.at, updatedAt: twoDays.at }));
  await persistBooking(mkBooking(B.parts, 'TS-DGST02', {
    status: 'IN_PROGRESS',
    createdAt: threeDays.at, updatedAt: threeDays.at,
    history: [{ type: 'JOB_AWAITING_PARTS', at: threeDays.at, actor: 'Digest Appliance Pros' }],
  }));
  await persistBooking(mkBooking(B.doneYesterday, 'TS-DGST03', {
    status: 'COMPLETED', createdAt: threeDays.at, updatedAt: yesterday.at, completedAt: yesterday.at,
  }));
  await persistBooking(mkBooking(B.createdYesterday, 'TS-DGST04', { createdAt: yesterday.at, updatedAt: yesterday.at }));
  await persistAssignment(mkAssignment(A.parts, B.parts, 'ACCEPTED', {
    createdAt: threeDays.at, approvedBy: 'office@test.local', approvedAt: threeDays.at,
  }));
  await persistAssignment(mkAssignment(A.approvedYesterday, B.createdYesterday, 'APPROVED', {
    createdAt: yesterday.at, approvedBy: 'office@test.local', approvedAt: yesterday.at,
  }));
  // bookingToRow does not carry createdAt (Prisma stamps it at
  // insert — the platform's standing behavior), so the drill sets
  // the historical creation times directly, the way real aged
  // records would carry them.
  for (const [id, at] of [
    [B.unassigned, twoDays.at],
    [B.parts, threeDays.at],
    [B.doneYesterday, threeDays.at],
    [B.createdYesterday, yesterday.at],
  ]) {
    await prisma.serviceRequest.update({ where: { id }, data: { createdAt: new Date(at) } });
  }
  return { yesterdayDate: yesterday.date };
}

async function cleanup() {
  try {
    await prisma.pepperReport.deleteMany({ where: { createdByUserId: IDS.staff } });
    await prisma.dispatchAssignment.deleteMany({ where: { id: { in: Object.values(A) } } });
    await prisma.serviceRequest.deleteMany({ where: { id: { in: Object.values(B) } } });
    await prisma.customer.deleteMany({ where: { id: IDS.customer } });
    await prisma.user.deleteMany({ where: { id: { in: [IDS.staff, IDS.custUser] } } });
    await prisma.provider.deleteMany({ where: { id: IDS.provA } });
    await prisma.company.deleteMany({ where: { id: IDS.coA } });
  } catch (error) {
    console.error('cleanup warning:', error.message);
  }
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  await cleanup();
  const { yesterdayDate } = await seed();

  // Honest-unavailable idiom, in-process: a failing reader degrades
  // its section to { available: false } and the rest still compute.
  const broken = await buildOpsDigest({
    readers: {
      unassigned: async () => { throw new Error('boom'); },
      exceptions: async () => ({ count: 0, byType: {}, items: [] }),
      partsDelays: async () => ({ count: 0, items: [] }),
      yesterday: async () => ({ date: yesterdayDate, bookingsCreated: 0, jobsCompleted: 0, assignmentsApproved: 0 }),
    },
  });
  check('a failed section degrades honestly', broken.sections.unassigned.available, false);
  checkTrue('degraded section carries a reason', typeof broken.sections.unassigned.reason === 'string' && broken.sections.unassigned.reason.length > 10);
  check('healthy sections still compute', broken.sections.yesterday.available, true);
  check('digest is marked draft-only', broken.draftOnly, true);

  const base = `http://127.0.0.1:${PORT}/api/v1`;
  const server = spawnServer(PORT);
  try {
    await waitForServer(base);
    const staff = mintToken(IDS.staff, PLATFORM_COMPANY_ID, 'digest-staff@test.local', ['DISPATCHER']);
    const cust = mintToken(IDS.custUser, PLATFORM_COMPANY_ID, 'digest-customer-user@test.local', ['CUSTOMER']);

    check('digest anonymous 401', (await api(base, '/pepper-console/digest')).status, 401);
    check('digest customer 403', (await api(base, '/pepper-console/digest', { token: cust })).status, 403);

    const digest = await api(base, '/pepper-console/digest', { token: staff });
    check('digest staff 200', digest.status, 200);
    const s = digest.json?.data?.sections || {};
    check('unassigned section available', s.unassigned?.available, true);
    check('exactly one unassigned job', s.unassigned?.count, 1);
    check('unassigned job is TS-DGST01', s.unassigned?.items?.[0]?.referenceCode, 'TS-DGST01');
    check('exceptions section available', s.exceptions?.available, true);
    checkTrue('parts-delay exception present', (s.exceptions?.byType?.PARTS_DELAY || 0) >= 1, JSON.stringify(s.exceptions));
    check('parts section available', s.partsDelays?.available, true);
    checkTrue('awaiting-parts job counted', (s.partsDelays?.count || 0) >= 1, JSON.stringify(s.partsDelays));
    const partsRow = (s.partsDelays?.items || []).find((i) => i.referenceCode === 'TS-DGST02');
    checkTrue('awaiting-parts row is TS-DGST02', Boolean(partsRow), JSON.stringify(s.partsDelays?.items));
    check('3-day parts wait is over the 48h threshold', partsRow?.overdue, true);
    check('yesterday section available', s.yesterday?.available, true);
    check('yesterday is the ET calendar yesterday', s.yesterday?.date, yesterdayDate);
    check('yesterday bookings created', s.yesterday?.bookingsCreated, 1);
    check('yesterday jobs completed', s.yesterday?.jobsCompleted, 1);
    check('yesterday assignments approved', s.yesterday?.assignmentsApproved, 1);

    // Draft: files exactly one STATUS report, sends nothing.
    const outboxBefore = await prisma.notificationOutbox.count();
    check('draft customer 403', (await api(base, '/pepper-console/digest/draft', { method: 'POST', token: cust })).status, 403);
    const draft = await api(base, '/pepper-console/digest/draft', { method: 'POST', token: staff });
    check('draft save 201', draft.status, 201);
    check('draft report category is STATUS', draft.json?.data?.report?.category, 'STATUS');
    checkTrue('draft title is the morning digest', (draft.json?.data?.report?.title || '').startsWith('Morning ops digest —'), draft.json?.data?.report?.title);
    checkTrue('draft body carries the real counts', (draft.json?.data?.report?.body || '').includes('Unassigned jobs: 1'), draft.json?.data?.report?.body);
    check('exactly one digest report filed', await prisma.pepperReport.count({ where: { title: { startsWith: 'Morning ops digest' } } }), 1);
    check('the draft sent nothing (outbox unmoved)', await prisma.notificationOutbox.count(), outboxBefore);
  } finally {
    server.kill('SIGTERM');
    await cleanup();
    await prisma.$disconnect();
  }
  console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
