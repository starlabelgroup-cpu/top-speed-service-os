/**
 * Pepper — Systems Manager console drills (2026-11-18).
 *
 * Ramone: "I need pepper/muze agent working inside work station as
 * systems manager reporting to me Ramone Williams." This harness
 * exercises the duty post (routes/pepperConsole.js + services/
 * pepperConsole.js + the PepperReport log) end to end over HTTP:
 *  - the staff gate on all three endpoints: anonymous 401,
 *    customers 403, staff 200;
 *  - the status aggregate's shape and honesty: the identity block
 *    (Pepper, the Systems Manager title, reports to Ramone
 *    Williams, the 2026-11-10 authority limits, Rule Zero), and
 *    every section read from the real systems — payments config,
 *    Speedy status + knowledge counts, the notification outbox
 *    counts, Insights connection states, Ad Studio pending
 *    approvals + provider states, Pepper Lists pending channels;
 *  - the honest-unavailable path: buildPepperStatus called with a
 *    throwing reader returns { available: false, reason } for that
 *    section while the others stay available;
 *  - the report log: validation 400s, create 201, list newest
 *    first, staff attribution recorded;
 *  - the Navigator map carries the pepper-console door, cross-linked
 *    from the navigator entry;
 *  - mounting the new router leaves the public routes alone:
 *    payments/status answers and a scenario image still serves.
 *
 * Two phases. Phase A runs against DATABASE_URL (a fresh local drill
 * Postgres) with seeded users, exactly like the other suites.
 * Phase B boots the same server in memory mode (no DATABASE_URL)
 * with hand-minted JWTs, proving the dual-mode repos and the
 * aggregate hold without a database.
* Run: DATABASE_URL=<local drill postgres url>
 */
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/services/passwords.js';
import { PLATFORM_COMPANY_ID } from '../src/data/store.js';
import { buildPepperStatus } from '../src/services/pepperConsole.js';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required (point it at a local TEST database).');
  process.exit(2);
}
if (!process.env.DATABASE_URL_UNPOOLED) process.env.DATABASE_URL_UNPOOLED = process.env['DATABASE' + '_URL'];

const PORT_A = Number(process.env.TEST_PORT || 4471);
const PORT_B = PORT_A + 1;
const JWT_SECRET = 'pepper-drill-jwt-secret';
const PASSWORD = 'test-pass-1234';

const IDS = {
  staff: '40000000-0000-4000-8000-0000000000e1',
  owner: '40000000-0000-4000-8000-0000000000e2',
  customer: '40000000-0000-4000-8000-0000000000e3',
};

const prisma = new PrismaClient();
let failures = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

function checkTrue(label, value) {
  check(label, Boolean(value), true);
}

function api(base, path, { token, method = 'GET', body } = {}) {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (res) => {
    let json = null;
    try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, json, contentType: res.headers.get('content-type') };
  });
}

function mintToken(userId, email, roles) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: userId, companyId: PLATFORM_COMPANY_ID, email, roles,
    exp: Math.floor(Date.now() / 1000) + 3600,
  })).toString('base64url');
  const signature = createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

async function login(base, email) {
  const { status, json } = await api(base, '/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  if (status !== 200 || !json?.token) throw new Error(`login failed for ${email}: ${status} ${JSON.stringify(json)}`);
  return json.token;
}

function spawnServer(port, extraEnv) {
  const env = { ...process.env, PORT: String(port), JWT_SECRET };
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
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

async function seed() {
  const passwordHash = await hashPassword(PASSWORD);
  await prisma.company.upsert({
    where: { id: PLATFORM_COMPANY_ID },
    update: {},
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'test-platform', type: 'PLATFORM_OWNER', isPlatformOwner: true },
  });
  const users = [
    { id: IDS.staff, email: 'pepper-staff@test.local', roles: ['COMPANY_ADMIN'] },
    { id: IDS.owner, email: 'pepper-owner@test.local', roles: ['COMPANY_OWNER'] },
    { id: IDS.customer, email: 'pepper-customer@test.local', roles: ['CUSTOMER'] },
  ];
  for (const u of users) {
    await prisma.user.upsert({
      where: { id: u.id },
      update: { passwordHash },
      create: { id: u.id, companyId: PLATFORM_COMPANY_ID, email: u.email, passwordHash, phone: '9545550200', roles: u.roles, active: true },
    });
  }
}

async function cleanupDb() {
  try {
    await prisma.pepperReport.deleteMany({ where: { createdByUserId: { in: [IDS.staff, IDS.owner] } } });
    await prisma.user.deleteMany({ where: { id: { in: Object.values(IDS) } } });
  } catch (error) {
    console.error('cleanup warning:', error.message);
  }
}

async function main() {
  // ── Phase A: database mode ─────────────────────────────────────
  await cleanupDb();
  await seed();
  const baseA = `http://127.0.0.1:${PORT_A}/api/v1`;
  const serverA = spawnServer(PORT_A, {
    DATABASE_URL: process.env.DATABASE_URL,
    DATABASE_URL_UNPOOLED: process.env.DATABASE_URL_UNPOOLED,
  });
  await waitForServer(baseA);

  check('status unauthenticated', (await api(baseA, '/pepper-console/status')).status, 401);
  check('reports GET unauthenticated', (await api(baseA, '/pepper-console/reports')).status, 401);
  check('reports POST unauthenticated', (await api(baseA, '/pepper-console/reports', { method: 'POST', body: {} })).status, 401);

  const staff = await login(baseA, 'pepper-staff@test.local');
  const owner = await login(baseA, 'pepper-owner@test.local');
  const customer = await login(baseA, 'pepper-customer@test.local');

  check('customer refused status (403)', (await api(baseA, '/pepper-console/status', { token: customer })).status, 403);
  check('customer refused reports GET (403)', (await api(baseA, '/pepper-console/reports', { token: customer })).status, 403);
  check('customer refused reports POST (403)', (await api(baseA, '/pepper-console/reports', { token: customer, method: 'POST', body: { title: 'x', body: 'y', category: 'STATUS' } })).status, 403);

  // ── Status aggregate ───────────────────────────────────────────
  const statusRes = await api(baseA, '/pepper-console/status', { token: staff });
  check('staff status 200', statusRes.status, 200);
  const d = statusRes.json.data;
  check('identity agentName', d.identity.agentName, 'Pepper');
  check('identity title', d.identity.title, 'Pepper Agent — System Operations Manager');
  check('identity reportsTo', d.identity.reportsTo, 'Ramone Williams');
  check('identity reportsToTitle', d.identity.reportsToTitle, 'Owner — Master of Whole Systems');
  check('identity authority limits count', d.identity.authorityLimits.length, 5);
  checkTrue('limits name refund gate', d.identity.authorityLimits.some((x) => x.includes('refunds')));
  checkTrue('limits name safety diagnosis gate', d.identity.authorityLimits.some((x) => x.includes('safety-critical')));
  checkTrue('limits name repair-safety gate', d.identity.authorityLimits.some((x) => x.includes('Certifying repair safety is never AI')));
  checkTrue('limits name credential gate', d.identity.authorityLimits.some((x) => x.includes('technician credentials')));
  checkTrue('limits name compliance gate', d.identity.authorityLimits.some((x) => x.includes('compliance')));
  checkTrue('ruleZero names Ramone', d.identity.ruleZero.includes('Ramone Williams'));
  checkTrue('ruleZero names owner supremacy', d.identity.ruleZero.includes('supreme authority'));

  const s = d.sections;
  checkTrue('payments section present', s.payments.available === true);
  check('payments diagnostic cents', s.payments.diagnosticAmountCents, 9900);
  check('payments configured (drill env: no Stripe keys)', s.payments.configured, false);
  checkTrue('speedy section present', s.speedy.available === true);
  check('speedy not configured in drills', s.speedy.configured, false);
  checkTrue('speedy knowledge total is a number', typeof s.speedy.knowledge.total === 'number' && s.speedy.knowledge.total > 0);
  checkTrue('notifications section present', s.notifications.available === true);
  check('notifications failed (fresh drill outbox)', s.notifications.failed, 0);
  check('notifications gated (fresh drill outbox)', s.notifications.gated, 0);
  checkTrue('insights section present', s.insights.available === true);
  check('insights lists 3 connections', s.insights.connections.length, 3);
  checkTrue('insights GA4 present', s.insights.connections.some((c) => c.id === 'ga4'));
  checkTrue('insights all not_connected in drills', s.insights.connections.every((c) => c.status === 'not_connected'));
  checkTrue('adStudio section present', s.adStudio.available === true);
  check('adStudio pendingApproval is a number', typeof s.adStudio.pendingApproval, 'number');
  checkTrue('adStudio providers readable', s.adStudio.providers.available === true);
  checkTrue('adStudio providers connections is an array', Array.isArray(s.adStudio.providers.connections));
  checkTrue('pepperLists section present', s.pepperLists.available === true);
  check('pepperLists pending is a number', typeof s.pepperLists.pending, 'number');

  // Owner sees the same board.
  const ownerStatus = await api(baseA, '/pepper-console/status', { token: owner });
  check('owner status 200', ownerStatus.status, 200);

  // ── Report log ─────────────────────────────────────────────────
  check('reports GET empty 200', (await api(baseA, '/pepper-console/reports', { token: staff })).status, 200);
  check('reports GET empty list', (await api(baseA, '/pepper-console/reports', { token: staff })).json.data.length, 0);
  check('report missing title 400', (await api(baseA, '/pepper-console/reports', { token: staff, method: 'POST', body: { body: 'x', category: 'STATUS' } })).status, 400);
  check('report empty body 400', (await api(baseA, '/pepper-console/reports', { token: staff, method: 'POST', body: { title: 'x', body: ' ', category: 'STATUS' } })).status, 400);
  check('report bad category 400', (await api(baseA, '/pepper-console/reports', { token: staff, method: 'POST', body: { title: 'x', body: 'y', category: 'URGENT' } })).status, 400);

  const first = await api(baseA, '/pepper-console/reports', { token: staff, method: 'POST', body: { title: 'Drill: board read clean', body: 'First drill report — the board read every system.', category: 'STATUS' } });
  check('report create 201', first.status, 201);
  check('report echoes title', first.json.data.title, 'Drill: board read clean');
  check('report echoes category', first.json.data.category, 'STATUS');
  check('report records staff email', first.json.data.createdBy.email, 'pepper-staff@test.local');
  checkTrue('report serializer has no createdByUserId leak of roles beyond filer', Array.isArray(first.json.data.createdBy.roles));

  const second = await api(baseA, '/pepper-console/reports', { token: owner, method: 'POST', body: { title: 'Drill: needs owner', body: 'Second drill report, from the owner.', category: 'NEEDS_OWNER' } });
  check('owner report create 201', second.status, 201);

  const list = await api(baseA, '/pepper-console/reports', { token: staff });
  check('reports list 2 rows', list.json.data.length, 2);
  check('reports newest first', list.json.data[0].title, 'Drill: needs owner');
  check('reports oldest second', list.json.data[1].title, 'Drill: board read clean');

  // ── Navigator map carries the door ────────────────────────────
  const mapRes = await api(baseA, '/navigator/map', { token: staff });
  check('navigator map 200', mapRes.status, 200);
  const allAreas = mapRes.json.data.groups.flatMap((g) => g.areas);
  const door = allAreas.find((a) => a.id === 'pepper-console');
  checkTrue('map has pepper-console door', Boolean(door));
  check('door name', door.name, 'Pepper — Systems Manager');
  check('door url', door.url, '/pepper');
  const navEntry = allAreas.find((a) => a.id === 'navigator');
  checkTrue('navigator entry cross-links pepper-console', (navEntry.related || []).includes('pepper-console'));

  // ── Public routes unaffected by the new router ────────────────
  const payments = await api(baseA, '/payments/status');
  check('public payments/status 200', payments.status, 200);
  check('public payments diagnostic cents', payments.json.data.diagnosticAmountCents, 9900);
  const image = await fetch(`${baseA}/app/scenario-images/need-warm-fridge.webp`);
  check('public scenario image 200', image.status, 200);
  checkTrue('scenario image is an image', (image.headers.get('content-type') || '').startsWith('image/'));

  serverA.kill();
  await new Promise((r) => setTimeout(r, 500));

  // ── Phase B: memory mode (no DATABASE_URL) ─────────────────────
  const baseB = `http://127.0.0.1:${PORT_B}/api/v1`;
  const serverB = spawnServer(PORT_B, {
    DATABASE_URL: undefined,
    DATABASE_URL_UNPOOLED: undefined,
  });
  await waitForServer(baseB);
  const staffJwt = mintToken(IDS.staff, 'pepper-staff@test.local', ['COMPANY_ADMIN']);
  const customerJwt = mintToken(IDS.customer, 'pepper-customer@test.local', ['CUSTOMER']);

  check('memory: status unauthenticated', (await api(baseB, '/pepper-console/status')).status, 401);
  check('memory: customer refused (403)', (await api(baseB, '/pepper-console/status', { token: customerJwt })).status, 403);
  const memStatus = await api(baseB, '/pepper-console/status', { token: staffJwt });
  check('memory: staff status 200', memStatus.status, 200);
  checkTrue('memory: every section readable', Object.values(memStatus.json.data.sections).every((sec) => sec.available === true));
  check('memory: identity title', memStatus.json.data.identity.title, 'Pepper Agent — System Operations Manager');

  const memPost = await api(baseB, '/pepper-console/reports', { token: staffJwt, method: 'POST', body: { title: 'Memory-mode report', body: 'Filed without a database.', category: 'ACTION_TAKEN' } });
  check('memory: report create 201', memPost.status, 201);
  const memList = await api(baseB, '/pepper-console/reports', { token: staffJwt });
  check('memory: report list 1 row', memList.json.data.length, 1);
  check('memory: report title', memList.json.data[0].title, 'Memory-mode report');
  check('memory: report has no staff attribution without a user row', memList.json.data[0].createdBy, null);

  serverB.kill();
  await new Promise((r) => setTimeout(r, 500));

  // ── Phase C: honest-unavailable path (unit) ────────────────────
  const readers = {
    payments: async () => { throw new Error('stripe down (drill)'); },
    speedy: async () => ({ configured: false, provider: 'openai', model: null, knowledge: { total: 125, packs: { site: 68, glossary: 18, industry: 39 } } }),
    notifications: async () => ({ total: 0, byStatus: {}, queued: 0, sent: 0, failed: 0, gated: 0 }),
    insights: async () => ({ connections: [] }),
    adStudio: async () => ({ totalCampaigns: 0, byStatus: {}, pendingApproval: 0, providers: { available: true, connections: [] } }),
    pepperLists: async () => ({ total: 0, byStatus: {}, pending: 0 }),
  };
  const injected = await buildPepperStatus(readers);
  check('unit: payments section unavailable', injected.sections.payments.available, false);
  checkTrue('unit: payments reason is a sentence', typeof injected.sections.payments.reason === 'string' && injected.sections.payments.reason.length > 10);
  checkTrue('unit: speedy still available', injected.sections.speedy.available === true);
  checkTrue('unit: notifications still available', injected.sections.notifications.available === true);
  checkTrue('unit: insights still available', injected.sections.insights.available === true);
  checkTrue('unit: adStudio still available', injected.sections.adStudio.available === true);
  checkTrue('unit: pepperLists still available', injected.sections.pepperLists.available === true);

  await cleanupDb();
  await prisma.$disconnect();
  console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error('drill crashed:', error);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
