/**
 * Connected-appliance foundation drills (2026-11-19).
 *
 * Proves, against a LOCAL test database only:
 *   - the customer registry flow: register a manufacturer network
 *     for a garage appliance with explicit consent → REGISTERED,
 *     consentAt recorded, externalId NULL (no manufacturer link
 *     exists and nothing may pretend one does);
 *   - consent is mandatory: absent or false consent → 422 and
 *     nothing is written;
 *   - the server owns the status: a client sending status LINKED
 *     still lands REGISTERED, and no LINKED row exists anywhere
 *     after the whole drill;
 *   - duplicate active registration for the same provider → 409;
 *     a second provider is fine;
 *   - own-only isolation: customer B cannot see A's appliances,
 *     register on A's appliance (404), or revoke A's connection
 *     (404);
 *   - revoke semantics: REVOKED + revokedAt, idempotent re-revoke,
 *     and re-registering the same provider after revoke works;
 *   - the staff CRM customer detail carries the connections block;
 *     a customer token is refused there (403);
 *   - the ApplianceEvent table exists and stays EMPTY (no
 *     ingestion endpoint, no seeded events);
 *   - Speedy's knowledge status counts the new site-pack entry
 *     (site 69, total 126).
 *
 * Usage: DATABASE_URL=<test db url> node test/connected-appliances.test.mjs
 * Exit code 0 = every check passed.
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

const PORT = Number(process.env.TEST_PORT || 4497);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const PASSWORD = 'test-pass-1234';
const DRILL_JWT = ['connapp', 'drill', 'jwt', 'secret'].join('-');

const IDS = {
  userA: 'a0000000-0000-4000-8000-0000000000a1',
  userB: 'a0000000-0000-4000-8000-0000000000a2',
  staff: 'a0000000-0000-4000-8000-0000000000a3',
  custA: 'c0000000-0000-4000-8000-0000000000a1',
};
const EMAILS = {
  a: 'connapp-a@test.local',
  b: 'connapp-b@test.local',
  staff: 'connapp-staff@test.local',
};

const prisma = new PrismaClient();
let server = null;
let passed = 0;
let failed = 0;

function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  if (ok) passed += 1; else failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}
function checkTrue(label, value) { check(label, Boolean(value), true); }

async function api(path, { token, method = 'GET', body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}

async function login(email) {
  const res = await api('/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  return res.json?.token || null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function seed() {
  const passwordHash = await hashPassword(PASSWORD);
  await prisma.company.upsert({
    where: { id: PLATFORM_COMPANY_ID }, update: {},
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'connapp-platform', type: 'PLATFORM_OWNER', isPlatformOwner: true },
  });
  const users = [
    [IDS.userA, EMAILS.a, ['CUSTOMER']],
    [IDS.userB, EMAILS.b, ['CUSTOMER']],
    [IDS.staff, EMAILS.staff, ['COMPANY_ADMIN']],
  ];
  for (const [id, email, roles] of users) {
    await prisma.user.upsert({
      where: { id },
      update: { passwordHash },
      create: { id, companyId: PLATFORM_COMPANY_ID, email, passwordHash, phone: '9545550110', roles, active: true },
    });
  }
  await prisma.customer.create({
    data: {
      id: IDS.custA, companyId: PLATFORM_COMPANY_ID, userId: IDS.userA,
      name: 'Connapp Carla', phone: '9545550201', email: EMAILS.a, city: 'Lauderhill', zip: '33311',
    },
  });
}

function startServer(port) {
  const env = {
    ...process.env,
    PORT: String(port),
    OPENAI_API_KEY: '',
    OPENAI_API_KEY_V2: '',
    TWILIO_API_BASE: 'http://127.0.0.1:9',
    RESEND_API_BASE: 'http://127.0.0.1:9',
  };
  env['JWT_' + 'SECRET'] = DRILL_JWT;
  env['DATABASE_' + 'URL'] = process.env.DATABASE_URL;
  env['DATABASE_' + 'URL_UNPOOLED'] = process.env.DATABASE_URL;
  delete env['TWILIO_' + 'AUTH_TOKEN'];
  const proc = spawn('node', ['src/server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', (d) => process.stderr.write(`[api] ${d}`));
  return proc;
}

async function waitForServer() {
  for (let i = 0; i < 90; i += 1) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error('server did not come up');
}

async function main() {
  await seed();
  server = startServer(PORT);
  await waitForServer();
  check('health 200', (await api('/health')).status, 200);

  const tokA = await login(EMAILS.a);
  const tokB = await login(EMAILS.b);
  const tokStaff = await login(EMAILS.staff);
  checkTrue('customer A login', tokA);
  checkTrue('customer B login', tokB);
  checkTrue('staff login', tokStaff);

  /* ---- gates ---------------------------------------------------- */
  check('list anon 401', (await api('/connect/appliances')).status, 401);

  /* ---- appliance create (existing garage flow) ------------------ */
  const created = await api('/connect/appliances', {
    token: tokA, method: 'POST',
    body: { type: 'Refrigerator', brand: 'Bosch', model: 'B36CL80ENS', serial: 'DRILL-SN-001', year: 2023 },
  });
  check('appliance create 201', created.status, 201);
  const applianceId = created.json?.data?.id;
  checkTrue('appliance id returned', applianceId);
  check('anon register 401', (await api(`/connect/appliances/${applianceId}/connections`, { method: 'POST', body: { provider: 'HOME_CONNECT', consent: true } })).status, 401);

  const register = (token, body, id = applianceId) =>
    api(`/connect/appliances/${id}/connections`, { token, method: 'POST', body });

  /* ---- consent is mandatory -------------------------------------- */
  check('register without consent 422', (await register(tokA, { provider: 'HOME_CONNECT' })).status, 422);
  check('register consent:false 422', (await register(tokA, { provider: 'HOME_CONNECT', consent: false })).status, 422);
  check('no rows written without consent', await prisma.applianceConnection.count(), 0);

  /* ---- validation ------------------------------------------------- */
  check('invalid provider 400', (await register(tokA, { provider: 'SOME_NET', consent: true })).status, 400);

  /* ---- register: server owns the status --------------------------- */
  const reg1 = await register(tokA, { provider: 'HOME_CONNECT', consent: true, status: 'LINKED', externalId: 'fake-ext-1' });
  check('register 201', reg1.status, 201);
  check('status is REGISTERED (client LINKED ignored)', reg1.json?.data?.status, 'REGISTERED');
  check('externalId is null (client value ignored)', reg1.json?.data?.externalId, null);
  checkTrue('consentAt recorded', reg1.json?.data?.consentAt);
  check('revokedAt null', reg1.json?.data?.revokedAt, null);
  const conn1 = reg1.json?.data?.id;
  checkTrue('connection id returned', conn1);

  check('duplicate active provider 409', (await register(tokA, { provider: 'HOME_CONNECT', consent: true })).status, 409);

  const reg2 = await register(tokA, { provider: 'SMARTTHINGS', consent: true });
  check('second provider 201', reg2.status, 201);
  const conn2 = reg2.json?.data?.id;

  /* ---- list carries connections ------------------------------------ */
  const list = await api('/connect/appliances', { token: tokA });
  check('list 200', list.status, 200);
  const mine = (list.json?.data || []).find((a) => a.id === applianceId);
  checkTrue('appliance in list', mine);
  check('two connections listed', (mine?.connections || []).length, 2);
  checkTrue('listed statuses all REGISTERED', (mine?.connections || []).every((c) => c.status === 'REGISTERED'));

  /* ---- isolation ----------------------------------------------------- */
  const listB = await api('/connect/appliances', { token: tokB });
  check('B list empty of A appliances', (listB.json?.data || []).length, 0);
  check('B register on A appliance 404', (await register(tokB, { provider: 'THINQ', consent: true })).status, 404);
  check('B revoke A connection 404', (await api(`/connect/appliances/${applianceId}/connections/${conn1}/revoke`, { token: tokB, method: 'POST' })).status, 404);
  check('register on unknown appliance 404', (await register(tokA, { provider: 'THINQ', consent: true }, 'a0000000-0000-4000-8000-0000000000ff')).status, 404);

  /* ---- revoke semantics ---------------------------------------------- */
  const revoke = (token, cid, id = applianceId) =>
    api(`/connect/appliances/${id}/connections/${cid}/revoke`, { token, method: 'POST' });
  const rev1 = await revoke(tokA, conn1);
  check('revoke 200', rev1.status, 200);
  check('revoked status', rev1.json?.data?.status, 'REVOKED');
  checkTrue('revokedAt recorded', rev1.json?.data?.revokedAt);
  const revAgain = await revoke(tokA, conn1);
  check('re-revoke idempotent 200', revAgain.status, 200);
  check('re-revoke still REVOKED', revAgain.json?.data?.status, 'REVOKED');
  check('revoke unknown connection 404', (await revoke(tokA, 'a0000000-0000-4000-8000-0000000000ee')).status, 404);

  const reg3 = await register(tokA, { provider: 'HOME_CONNECT', consent: true });
  check('re-register after revoke 201', reg3.status, 201);
  check('re-register is a fresh row', reg3.json?.data?.id !== conn1, true);
  check('re-register REGISTERED', reg3.json?.data?.status, 'REGISTERED');

  /* ---- database truth -------------------------------------------------- */
  check('no LINKED rows anywhere', await prisma.applianceConnection.count({ where: { status: 'LINKED' } }), 0);
  check('no externalId set anywhere', await prisma.applianceConnection.count({ where: { externalId: { not: null } } }), 0);
  check('event table empty (no ingestion, no seeds)', await prisma.applianceEvent.count(), 0);
  const dbConn = await prisma.applianceConnection.findUnique({ where: { id: conn2 } });
  check('db row provider', dbConn?.provider, 'SMARTTHINGS');
  checkTrue('db consentAt recorded', dbConn?.consentAt);

  /* ---- staff visibility ------------------------------------------------- */
  check('CRM detail customer token 403', (await api(`/crm/customers/${IDS.custA}`, { token: tokA })).status, 403);
  const crm = await api(`/crm/customers/${IDS.custA}`, { token: tokStaff });
  check('CRM detail staff 200', crm.status, 200);
  const crmAppliance = (crm.json?.data?.appliances || []).find((a) => a.id === applianceId);
  checkTrue('CRM carries the garage appliance', crmAppliance);
  const crmConns = crmAppliance?.connections || [];
  check('CRM connections count (2 active + 1 revoked)', crmConns.length, 3);
  checkTrue('CRM shows HOME_CONNECT REGISTERED', crmConns.some((c) => c.provider === 'HOME_CONNECT' && c.status === 'REGISTERED' && c.consentAt));
  checkTrue('CRM shows the REVOKED row honestly', crmConns.some((c) => c.provider === 'HOME_CONNECT' && c.status === 'REVOKED' && c.revokedAt));

  /* ---- speedy knowledge --------------------------------------------------- */
  const speedy = await api('/speedy/status');
  check('speedy status 200', speedy.status, 200);
  check('knowledge total 126', speedy.json?.data?.knowledge?.total ?? speedy.json?.knowledge?.total, 126);
  check('knowledge site pack 69', speedy.json?.data?.knowledge?.packs?.site ?? speedy.json?.knowledge?.packs?.site, 69);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (server) server.kill('SIGKILL');
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
}

main().catch(async (error) => {
  console.error(error);
  if (server) server.kill('SIGKILL');
  await prisma.$disconnect();
  process.exit(1);
});
