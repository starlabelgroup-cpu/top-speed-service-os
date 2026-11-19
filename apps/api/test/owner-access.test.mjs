/**
 * Owner-access matrix + provider oversight + auth pipeline drills
 * (2026-11-18, Ramone's orders).
 *
 * Rule Zero says the Master can never be locked out, and Ramone's
 * follow-up orders say: "Create a log in for everything for me — same
 * way like others" and "I should be able to login in anywhere
 * anytime." Tonight he signed into the Tech App with the owner
 * account, the password was ACCEPTED, and the jobs board answered
 * "Insufficient role" because the provider endpoints required a
 * provider role. This suite proves the class fix:
 *
 *  1. Provider jobs board (GET /provider/*): COMPANY_OWNER and
 *     COMPANY_ADMIN are OVERSIGHT viewers — they load the whole live
 *     board (every provider's assignments, annotated with the
 *     provider's business name) with an explicit oversight marker.
 *     A provider still sees only its own assignments. CUSTOMER 403,
 *     anonymous 401. Job WORKFLOW actions stay bound to the assigned
 *     provider: the owner POSTing accept gets 403 (gate), another
 *     provider POSTing accept on someone else's job gets 404
 *     (per-record binding).
 *  2. Owner-access matrix: one owner token probed against the
 *     primary endpoint of every gated surface — all 200.
 *  3. Auth pipeline: forgot-password → reset-password → login with
 *     the new password → /auth/me carries COMPANY_OWNER; the old
 *     password is refused. (Ramone: "I reset password still not
 *     working" — the pipeline is proven healthy here; tonight's
 *     failure was the role gate, fixed above.)
 *
 * Boots the real API in database mode against a local TEST database
 * and cleans up. Run:
 *   DATABASE_URL=postgresql://... node test/owner-access.test.mjs
 */
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/services/passwords.js';
import { PLATFORM_COMPANY_ID, store } from '../src/data/store.js';
import { persistAssignment, persistBooking, persistCustomer } from '../src/db/bookingsRepo.js';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required (point it at a local TEST database).');
  process.exit(2);
}
if (!process.env.DATABASE_URL_UNPOOLED) process.env.DATABASE_URL_UNPOOLED = process.env.DATABASE_URL;

const PORT = Number(process.env.TEST_PORT || 4611);
const STUB_PORT = PORT + 100;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const JWT_SECRET = 'owner-access-drill-secret';
const PASSWORD = 'test-pass-1234';
const NEW_PASSWORD = 'new-owner-pass-99';

const IDS = {
  owner: '70000000-0000-4000-8000-0000000000a1',
  admin: '70000000-0000-4000-8000-0000000000a2',
  customer: '70000000-0000-4000-8000-0000000000a3',
  techA: '70000000-0000-4000-8000-0000000000a4',
  techB: '70000000-0000-4000-8000-0000000000a5',
  companyA: '70000000-0000-4000-8000-0000000000b1',
  companyB: '70000000-0000-4000-8000-0000000000b2',
  providerA: '70000000-0000-4000-8000-0000000000c1',
  providerB: '70000000-0000-4000-8000-0000000000c2',
  custRecord: '70000000-0000-4000-8000-0000000000d1',
  bookingA: '70000000-0000-4000-8000-0000000000d2',
  bookingB: '70000000-0000-4000-8000-0000000000d3',
  assignmentA: '70000000-0000-4000-8000-0000000000e1',
  assignmentB: '70000000-0000-4000-8000-0000000000e2',
};
const EMAILS = {
  owner: 'owner-access-owner@test.local',
  admin: 'owner-access-admin@test.local',
  customer: 'owner-access-customer@test.local',
  techA: 'owner-access-techa@test.local',
  techB: 'owner-access-techb@test.local',
};

const prisma = new PrismaClient();
let failures = 0;
const captures = [];

function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}
function checkTrue(label, value) { check(label, Boolean(value), true); }

function api(path, { token, method = 'GET', body } = {}) {
  return fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (res) => {
    let json = null;
    try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, json };
  });
}

async function login(email, password = PASSWORD) {
  const { status, json } = await api('/auth/login', { method: 'POST', body: { email, password } });
  if (status !== 200 || !json?.token) throw new Error(`login failed for ${email}: ${status} ${JSON.stringify(json)}`);
  return json.token;
}

/* The /auth rate-limit bucket covers the whole /auth prefix
   (10 / 15 min / IP), and the pipeline leg below needs most of it —
   so the non-owner actors use hand-minted tokens (same pattern as
   the access-badges suite's memory phase). Only the owner and admin
   log in for real before the pipeline leg. */
function mintToken(userId, companyId, email, roles) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: userId, companyId, email, roles,
    exp: Math.floor(Date.now() / 1000) + 3600,
  })).toString('base64url');
  const signature = createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

async function seed() {
  const passwordHash = await hashPassword(PASSWORD);
  await prisma.company.upsert({
    where: { id: PLATFORM_COMPANY_ID },
    update: {},
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'test-platform', type: 'PLATFORM_OWNER', isPlatformOwner: true },
  });
  for (const [id, name, slug] of [[IDS.companyA, 'Owner Drill Provider A', 'owner-drill-a'], [IDS.companyB, 'Owner Drill Provider B', 'owner-drill-b']]) {
    await prisma.company.upsert({
      where: { id },
      update: {},
      create: { id, name, slug, type: 'INDEPENDENT_PROVIDER' },
    });
  }
  await prisma.provider.upsert({
    where: { id: IDS.providerA },
    update: {},
    create: { id: IDS.providerA, companyId: IDS.companyA, businessName: 'Owner Drill Provider A', type: 'INDEPENDENT_PROVIDER', specialties: [], serviceCities: [] },
  });
  await prisma.provider.upsert({
    where: { id: IDS.providerB },
    update: {},
    create: { id: IDS.providerB, companyId: IDS.companyB, businessName: 'Owner Drill Provider B', type: 'INDEPENDENT_PROVIDER', specialties: [], serviceCities: [] },
  });
  const users = [
    { id: IDS.owner, email: EMAILS.owner, companyId: PLATFORM_COMPANY_ID, roles: ['COMPANY_OWNER'] },
    { id: IDS.admin, email: EMAILS.admin, companyId: PLATFORM_COMPANY_ID, roles: ['COMPANY_ADMIN'] },
    { id: IDS.customer, email: EMAILS.customer, companyId: PLATFORM_COMPANY_ID, roles: ['CUSTOMER'] },
    { id: IDS.techA, email: EMAILS.techA, companyId: IDS.companyA, roles: ['PROVIDER_TECH'] },
    { id: IDS.techB, email: EMAILS.techB, companyId: IDS.companyB, roles: ['PROVIDER_TECH'] },
  ];
  for (const u of users) {
    await prisma.user.upsert({
      where: { id: u.id },
      update: { passwordHash },
      create: { id: u.id, companyId: u.companyId, email: u.email, passwordHash, phone: '9545550300', roles: u.roles, active: true },
    });
  }

  const now = new Date().toISOString();
  const customer = {
    id: IDS.custRecord, companyId: PLATFORM_COMPANY_ID, userId: null,
    name: 'Owner Drill Customer', phone: '9545550311', email: 'owner-drill-cust@test.local',
    address: '100 Drill Way', city: 'Fort Lauderdale', zip: '33311', createdAt: now,
  };
  const mkBooking = (id, ref, assignmentId) => ({
    id, companyId: PLATFORM_COMPANY_ID, customerId: customer.id,
    customer, referenceCode: ref, source: 'TEST',
    city: 'Fort Lauderdale', zip: '33311', appliance: 'Dryer', issue: 'Not heating',
    preferredWindow: null, diagnosticFee: 99, diagnosticFeeCreditedTowardRepair: true,
    feeStatus: 'COLLECTED_AT_BOOKING', status: 'CONFIRMED',
    dispatch: { mode: 'HYBRID', stage: 'ASSIGNED', candidateProviderIds: [], assignmentIds: [assignmentId] },
    history: [], createdAt: now, updatedAt: now,
  });
  const bookingA = mkBooking(IDS.bookingA, 'TS-OWNA1', IDS.assignmentA);
  const bookingB = mkBooking(IDS.bookingB, 'TS-OWNB1', IDS.assignmentB);
  const assignmentA = {
    id: IDS.assignmentA, companyId: PLATFORM_COMPANY_ID, bookingId: bookingA.id,
    providerId: IDS.providerA, providerCompanyId: IDS.companyA,
    status: 'ACCEPTED', dispatchMode: 'HYBRID', approvalRequired: true,
    approvedBy: 'Service Setters', approvedAt: now,
  };
  const assignmentB = {
    id: IDS.assignmentB, companyId: PLATFORM_COMPANY_ID, bookingId: bookingB.id,
    providerId: IDS.providerB, providerCompanyId: IDS.companyB,
    status: 'APPROVED', dispatchMode: 'HYBRID', approvalRequired: true,
    approvedBy: 'Service Setters', approvedAt: now,
  };
  store.customers.set(customer.id, customer);
  store.bookings.set(bookingA.id, bookingA);
  store.bookings.set(bookingB.id, bookingB);
  store.dispatchAssignments.set(assignmentA.id, assignmentA);
  store.dispatchAssignments.set(assignmentB.id, assignmentB);
  await persistCustomer(customer);
  await persistBooking(bookingA);
  await persistBooking(bookingB);
  await persistAssignment(assignmentA);
  await persistAssignment(assignmentB);
}

async function cleanup() {
  try {
    await prisma.passwordResetToken.deleteMany({ where: { userId: { in: [IDS.owner, IDS.admin, IDS.customer, IDS.techA, IDS.techB] } } });
    await prisma.dispatchAssignment.deleteMany({ where: { id: { in: [IDS.assignmentA, IDS.assignmentB] } } });
    await prisma.serviceRequest.deleteMany({ where: { id: { in: [IDS.bookingA, IDS.bookingB] } } });
    await prisma.customer.deleteMany({ where: { id: IDS.custRecord } });
    await prisma.provider.deleteMany({ where: { id: { in: [IDS.providerA, IDS.providerB] } } });
    await prisma.user.deleteMany({ where: { id: { in: [IDS.owner, IDS.admin, IDS.customer, IDS.techA, IDS.techB] } } });
    await prisma.company.deleteMany({ where: { id: { in: [IDS.companyA, IDS.companyB] } } });
  } catch (error) {
    console.error('cleanup warning:', error.message);
  }
}

function spawnServer() {
  const env = { ...process.env, PORT: String(PORT), JWT_SECRET };
  env.RESEND_API_KEY = 'drill-resend-key';
  env.RESEND_API_BASE = `http://127.0.0.1:${STUB_PORT}`;
  env.EMAIL_FROM = 'Top Speed Appliance <service@topspeedappliance.net>';
  const server = spawn('node', ['src/server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[api] ${d}`));
  return server;
}

async function waitForServer() {
  for (let i = 0; i < 90; i += 1) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('server did not come up');
}

async function waitForResetToken(email, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const entry of captures) {
      if (Array.isArray(entry.to) && entry.to.includes(email)) {
        const text = `${entry.text || ''} ${entry.html || ''} ${entry.subject || ''}`;
        const match = text.match(/reset-password\?token=([A-Za-z0-9_-]+)/);
        if (match) return match[1];
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

async function main() {
  const stub = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/emails') {
        try { captures.push(JSON.parse(raw)); } catch { /* ignore */ }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'stub-message-id' }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((resolve) => stub.listen(STUB_PORT, '127.0.0.1', resolve));

  await cleanup();
  await seed();
  const server = spawnServer();
  try {
    await waitForServer();
    const tok = {
      owner: await login(EMAILS.owner),
      admin: await login(EMAILS.admin),
      customer: mintToken(IDS.customer, PLATFORM_COMPANY_ID, EMAILS.customer, ['CUSTOMER']),
      techA: mintToken(IDS.techA, IDS.companyA, EMAILS.techA, ['PROVIDER_TECH']),
      techB: mintToken(IDS.techB, IDS.companyB, EMAILS.techB, ['PROVIDER_TECH']),
    };

    /* ── 1. Provider jobs board: oversight vs provider vs refused ── */
    check('provider board anon 401', (await api('/provider/assignments')).status, 401);
    check('provider board customer 403', (await api('/provider/assignments', { token: tok.customer })).status, 403);

    const ownerBoard = await api('/provider/assignments', { token: tok.owner });
    check('provider board owner 200', ownerBoard.status, 200);
    check('owner board is oversight', ownerBoard.json?.data?.oversight, true);
    check('owner board has no own provider', ownerBoard.json?.data?.provider, null);
    const ownerIds = (ownerBoard.json?.data?.assignments || []).map((a) => a.id);
    checkTrue('owner board includes provider A job', ownerIds.includes(IDS.assignmentA));
    checkTrue('owner board includes provider B job', ownerIds.includes(IDS.assignmentB));
    const annotated = (ownerBoard.json?.data?.assignments || []).find((a) => a.id === IDS.assignmentB);
    check('oversight rows name the provider', annotated?.providerBusinessName, 'Owner Drill Provider B');

    const adminBoard = await api('/provider/assignments', { token: tok.admin });
    check('provider board admin 200', adminBoard.status, 200);
    check('admin board is oversight', adminBoard.json?.data?.oversight, true);

    const techBoard = await api('/provider/assignments', { token: tok.techA });
    check('provider board assigned tech 200', techBoard.status, 200);
    checkTrue('tech board is NOT oversight', !techBoard.json?.data?.oversight);
    const techIds = (techBoard.json?.data?.assignments || []).map((a) => a.id);
    checkTrue('tech A sees own job', techIds.includes(IDS.assignmentA));
    checkTrue('tech A does NOT see provider B job', !techIds.includes(IDS.assignmentB));

    const ownerMe = await api('/provider/me', { token: tok.owner });
    check('provider /me owner 200', ownerMe.status, 200);
    check('provider /me owner oversight marker', ownerMe.json?.data?.oversight, true);
    const techMe = await api('/provider/me', { token: tok.techA });
    check('provider /me tech 200', techMe.status, 200);
    check('provider /me tech provider id', techMe.json?.data?.provider?.id, IDS.providerA);

    check('owner opens any job workspace 200', (await api(`/provider/assignments/${IDS.assignmentA}/workspace`, { token: tok.owner })).status, 200);
    check('other provider workspace 404', (await api(`/provider/assignments/${IDS.assignmentA}/workspace`, { token: tok.techB })).status, 404);
    check('owner parts-orders 200', (await api('/provider/parts-orders', { token: tok.owner })).status, 200);
    check('owner van-stock 200', (await api('/provider/van-stock', { token: tok.owner })).status, 200);

    /* Workflow actions stay bound to the assigned provider. */
    check('owner accept is gate-refused 403', (await api(`/provider/assignments/${IDS.assignmentA}/accept`, { token: tok.owner, method: 'POST', body: {} })).status, 403);
    check('other provider accept is record-refused 404', (await api(`/provider/assignments/${IDS.assignmentA}/accept`, { token: tok.techB, method: 'POST', body: {} })).status, 404);

    /* ── 2. Owner-access matrix: every gated surface, one token ──── */
    const matrix = [
      '/navigator/status', '/pepper-console/status', '/crm/home',
      '/bookos/setter-queue', '/notifications/summary', '/link-center/options',
      '/chats/insights', '/tracking/console', '/insights/overview',
      '/academy/curriculum', '/ad-studio/campaigns', '/advertiser/plans',
      '/access-control/accounts', '/finance/overview',
      '/management/reports/summary', '/provider/assignments',
    ];
    for (const path of matrix) {
      check(`owner matrix 200: ${path}`, (await api(path, { token: tok.owner })).status, 200);
    }
    // Admin where the surface is a staff/manager console:
    for (const path of ['/navigator/status', '/crm/home', '/finance/overview', '/management/reports/summary', '/provider/assignments', '/insights/overview']) {
      check(`admin matrix 200: ${path}`, (await api(path, { token: tok.admin })).status, 200);
    }

    /* ── 3. Auth pipeline: forgot → reset → login → /auth/me ─────── */
    const forgot = await api('/auth/forgot-password', { method: 'POST', body: { email: EMAILS.owner } });
    check('forgot-password generic 200', forgot.status, 200);
    const rawToken = await waitForResetToken(EMAILS.owner);
    checkTrue('reset email carried a raw token', typeof rawToken === 'string' && rawToken.length > 10);
    const reset = await api('/auth/reset-password', { method: 'POST', body: { token: rawToken, newPassword: NEW_PASSWORD } });
    check('reset-password 200', reset.status, 200);
    const oldLogin = await api('/auth/login', { method: 'POST', body: { email: EMAILS.owner, password: PASSWORD } });
    check('old password refused 401', oldLogin.status, 401);
    const newToken = await login(EMAILS.owner, NEW_PASSWORD);
    checkTrue('login with new password issues a token', typeof newToken === 'string' && newToken.length > 10);
    const me = await api('/auth/me', { token: newToken });
    check('/auth/me 200 after reset', me.status, 200);
    checkTrue('/auth/me carries COMPANY_OWNER', (me.json?.user?.roles || []).includes('COMPANY_OWNER'));
  } finally {
    server.kill('SIGTERM');
    stub.close();
    await cleanup();
    await prisma.$disconnect();
  }

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  await cleanup().catch(() => {});
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
