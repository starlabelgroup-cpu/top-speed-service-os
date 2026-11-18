/**
 * AdStream Providers — verification harness (2026-11-18).
 *
 * Exercises Phase 1 of the Ad Studio ad-serving provider registry
 * (routes/adProviders.js) end to end over HTTP:
 *  - the 5-provider catalog (Kevel, AdButler, Google Ad Manager,
 *    SpringServe, FreeWheel) with honest NOT_CONNECTED defaults and
 *    the read-only publisher inventory of house surfaces;
 *  - the Ad Studio staff gate: anonymous 401, customers 403,
 *    Marketing Manager allowed (same gate as every Ad Studio admin
 *    route);
 *  - connect files a PENDING request (never CONNECTED — Phase 1 has
 *    no completed provider flow, so nothing may invent one), on a
 *    PLATFORM row: one row per provider, shared across staff;
 *  - disconnect clearing the account label;
 *  - the audit log (CONNECT_REQUESTED / DISCONNECTED rows written in
 *    the same calls, with the acting staff member recorded);
 *  - the staff oversight read (statuses + labels + actors only, no
 *    `meta`, customers refused 403, anonymous refused 401);
 *  - the external readiness board carrying the providers as a
 *    separate dated section (campaign counts untouched: 13).
 *
 * Runs against a LOCAL test database only. Usage:
 *   DATABASE_URL=postgresql://... node test/adstream-providers.test.mjs
 * The harness seeds its own users, boots the real API on TEST_PORT
 * (default 4431), and cleans up. Exit code 0 = every check passed.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/services/passwords.js';
import { PLATFORM_COMPANY_ID } from '../src/data/store.js';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required (point it at a local TEST database).');
  process.exit(2);
}
process.env.DATABASE_URL_UNPOOLED ||= process.env.DATABASE_URL;

const PORT = Number(process.env.TEST_PORT || 4431);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const PASSWORD = 'test-pass-1234';

const IDS = {
  staff: '30000000-0000-4000-8000-0000000000d1',
  manager: '30000000-0000-4000-8000-0000000000d2',
  customer: '30000000-0000-4000-8000-0000000000d3',
};

const prisma = new PrismaClient();
let server = null;
let failures = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
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

async function seed() {
  const passwordHash = await hashPassword(PASSWORD);
  await prisma.company.upsert({
    where: { id: PLATFORM_COMPANY_ID },
    update: {},
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'test-platform', type: 'PLATFORM_OWNER', isPlatformOwner: true },
  });
  const users = [
    { id: IDS.staff, email: 'staff@test.local', roles: ['COMPANY_ADMIN'] },
    { id: IDS.manager, email: 'manager@test.local', roles: ['MARKETING_MANAGER'] },
    { id: IDS.customer, email: 'customer@test.local', roles: ['CUSTOMER'] },
  ];
  for (const u of users) {
    await prisma.user.upsert({
      where: { id: u.id },
      update: { passwordHash },
      create: { id: u.id, companyId: PLATFORM_COMPANY_ID, email: u.email, passwordHash, phone: '9545550100', roles: u.roles, active: true },
    });
  }
}

async function cleanup() {
  try {
    await prisma.adProviderAudit.deleteMany({});
    await prisma.adProviderConnection.deleteMany({});
    await prisma.user.deleteMany({ where: { id: { in: Object.values(IDS) } } });
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

function providerOf(listJson, key) {
  return listJson.data.providers.find((p) => p.key === key);
}

async function main() {
  await cleanup();
  await seed();
  server = spawn('node', ['src/server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      ...process.env,
      PORT: String(PORT),
      JWT_SECRET: 'test-secret-adstream-providers',
      DATABASE_URL: process.env.DATABASE_URL,
      DATABASE_URL_UNPOOLED: process.env.DATABASE_URL_UNPOOLED,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[api] ${d}`));
  await waitForServer();

  // ── Auth gates ────────────────────────────────────────────────
  check('providers unauthenticated', (await api('/ad-studio/providers')).status, 401);
  check('connect unauthenticated', (await api('/ad-studio/providers/KEVEL/connect', { method: 'POST', body: {} })).status, 401);
  check('disconnect unauthenticated', (await api('/ad-studio/providers/KEVEL/disconnect', { method: 'POST', body: {} })).status, 401);
  check('oversight unauthenticated', (await api('/ad-studio/providers/oversight')).status, 401);

  const staff = await login('staff@test.local');
  const manager = await login('manager@test.local');
  const customer = await login('customer@test.local');

  check('customer refused providers (403)', (await api('/ad-studio/providers', { token: customer })).status, 403);
  check('customer refused connect (403)', (await api('/ad-studio/providers/KEVEL/connect', { token: customer, method: 'POST', body: {} })).status, 403);
  check('customer refused oversight (403)', (await api('/ad-studio/providers/oversight', { token: customer })).status, 403);

  // ── Catalog defaults ──────────────────────────────────────────
  const before = await api('/ad-studio/providers', { token: staff });
  check('staff providers list 200', before.status, 200);
  check('catalog has 5 providers', before.json.data.providers.length, 5);
  check('catalog order', before.json.data.providers.map((p) => p.key).join(','), 'KEVEL,ADBUTLER,GOOGLE_AD_MANAGER,SPRINGSERVE,FREEWHEEL');
  checkTrue('all start NOT_CONNECTED', before.json.data.providers.every((p) => p.connection.status === 'NOT_CONNECTED'));
  checkTrue('every card carries the Phase 1 note', before.json.data.providers.every((p) => p.phaseNote.includes('Phase 1')));
  checkTrue('Kevel best-for names own infrastructure', providerOf(before.json, 'KEVEL').bestFor.includes('advertising infrastructure'));
  checkTrue('AdButler best-for names multi-format', providerOf(before.json, 'ADBUTLER').bestFor.includes('Multi-format'));
  checkTrue('GAM next steps name Google approval', providerOf(before.json, 'GOOGLE_AD_MANAGER').nextSteps.includes('admanager.google.com'));
  checkTrue('SpringServe next steps name the enterprise agreement', providerOf(before.json, 'SPRINGSERVE').nextSteps.includes('enterprise'));
  checkTrue('FreeWheel next steps say sales-led', providerOf(before.json, 'FREEWHEEL').nextSteps.includes('sales-led'));
  check('publisher inventory has 4 house surfaces', before.json.data.inventory.length, 4);
  checkTrue('inventory names the flagship', before.json.data.inventory.some((s) => s.url === 'https://topspeedserviceos.com'));
  checkTrue('inventory names pepperlists', before.json.data.inventory.some((s) => s.url === 'https://pepperlists.com'));

  const mgrList = await api('/ad-studio/providers', { token: manager });
  check('marketing manager providers list 200 (Ad Studio gate parity)', mgrList.status, 200);

  // ── Connect = PENDING request, never CONNECTED ────────────────
  const kevel = await api('/ad-studio/providers/KEVEL/connect', { token: staff, method: 'POST', body: { accountLabel: 'Kevel acct (pending signup)' } });
  check('staff connect KEVEL 201', kevel.status, 201);
  check('KEVEL lands PENDING (not CONNECTED)', kevel.json.data.connection.status, 'PENDING');
  check('KEVEL label stored', kevel.json.data.connection.externalAccountLabel, 'Kevel acct (pending signup)');
  checkTrue('connect returns next steps', typeof kevel.json.data.nextSteps === 'string' && kevel.json.data.nextSteps.length > 20);
  checkTrue('connection serializer exposes no meta', !('meta' in kevel.json.data.connection));

  const gam = await api('/ad-studio/providers/google_ad_manager/connect', { token: manager, method: 'POST', body: {} });
  check('manager connect GAM (lowercase key) 201', gam.status, 201);
  check('GAM lands PENDING', gam.json.data.connection.status, 'PENDING');

  check('unknown provider 404', (await api('/ad-studio/providers/NOPE/connect', { token: staff, method: 'POST', body: {} })).status, 404);
  check('bad connect body 400', (await api('/ad-studio/providers/KEVEL/connect', { token: staff, method: 'POST', body: { accountLabel: 42 } })).status, 400);

  // ── Platform scope: ONE row per provider, shared across staff ─
  const kevelAgain = await api('/ad-studio/providers/KEVEL/connect', { token: manager, method: 'POST', body: { accountLabel: 'Kevel acct (pending signup)' } });
  check('second staff connect still 201', kevelAgain.status, 201);
  const kevelRows = await prisma.adProviderConnection.count({ where: { provider: 'KEVEL' } });
  check('exactly one KEVEL row for the platform', kevelRows, 1);
  const mgrView = await api('/ad-studio/providers', { token: manager });
  check('manager sees the same platform KEVEL row PENDING', providerOf(mgrView.json, 'KEVEL').connection.status, 'PENDING');
  checkTrue('no provider is CONNECTED anywhere', mgrView.json.data.providers.every((p) => p.connection.status !== 'CONNECTED'));

  // ── Audit rows written, actor recorded ────────────────────────
  const auditMid = await prisma.adProviderAudit.findMany({ orderBy: { createdAt: 'asc' } });
  check('audit: 3 CONNECT_REQUESTED (KEVEL x2 + GAM)', auditMid.filter((x) => x.action === 'CONNECT_REQUESTED').length, 3);
  checkTrue('audit records the acting staff member', auditMid.some((x) => x.actorUserId === IDS.staff));
  checkTrue('audit records the acting manager', auditMid.some((x) => x.actorUserId === IDS.manager));

  // ── Disconnect clears status + label ──────────────────────────
  const disc = await api('/ad-studio/providers/KEVEL/disconnect', { token: staff, method: 'POST', body: {} });
  check('staff disconnect KEVEL 200', disc.status, 200);
  check('KEVEL back to NOT_CONNECTED', disc.json.data.connection.status, 'NOT_CONNECTED');
  check('KEVEL label cleared', disc.json.data.connection.externalAccountLabel, null);
  const auditFinal = await prisma.adProviderAudit.findMany({});
  check('audit: 1 DISCONNECTED row', auditFinal.filter((x) => x.action === 'DISCONNECTED').length, 1);

  // ── Oversight: staff only, no secret material ─────────────────
  const over = await api('/ad-studio/providers/oversight', { token: staff });
  check('staff oversight 200', over.status, 200);
  checkTrue('oversight lists connection rows', over.json.data.connections.length >= 2);
  checkTrue('oversight exposes NO meta field', over.json.data.connections.every((c) => !('meta' in c)));
  checkTrue('oversight includes the audit trail', Array.isArray(over.json.data.audit) && over.json.data.audit.length >= 4);
  checkTrue('oversight audit names the provider', over.json.data.audit.some((a) => a.provider === 'KEVEL'));
  checkTrue('oversight audit carries the actor identity', over.json.data.audit.some((a) => a.actor && a.actor.email === 'staff@test.local'));

  // ── External board: providers as their own dated section ──────
  const board = await api('/ad-studio/external-board', { token: staff });
  check('external board 200', board.status, 200);
  check('board campaign total untouched', board.json.data.counts.total, 13);
  check('board campaigns verified-on untouched', board.json.data.verifiedOn, '2026-11-17');
  check('board providers section has 5 entries', (board.json.data.providers || []).length, 5);
  check('board providers verified-on', board.json.data.providersVerifiedOn, '2026-11-18');
  checkTrue('board providers all NOT CONNECTED', board.json.data.providers.every((p) => p.status === 'NOT CONNECTED'));
  checkTrue('every provider lists missing steps', board.json.data.providers.every((p) => Array.isArray(p.missingSteps) && p.missingSteps.length >= 2));
  checkTrue('every provider flags an owner-only step', board.json.data.providers.every((p) => p.missingSteps.some((s) => s.ownerOnly)));

  await cleanup();
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(async () => {
    if (server) server.kill('SIGTERM');
    await prisma.$disconnect();
  });
