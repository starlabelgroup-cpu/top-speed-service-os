/**
 * Owner-only connection delete (2026-11-19) — Ramone approved deleting
 * a prepared list of confirmed-fake intake records (commercial
 * requests, provider applications, PM walkthroughs). Bookings already
 * had an owner-only delete (POST /admin/bookings/delete); connection
 * records had NO delete path anywhere. This suite drills the new
 * POST /admin/connections/delete { reference }:
 *
 *  - Same gate as the bookings delete: anon → 401, non-owner staff
 *    (DISPATCHER, and COMPANY_ADMIN — a manager is not the owner)
 *    → 403, owner → 200.
 *  - Same shapes: missing reference → 400, unknown reference → 404,
 *    success → { ok: true, deleted: { reference, connections: 1,
 *    outbox: N }, remainingConnections }.
 *  - The delete removes the Connection row AND every outbox entry
 *    whose payload/blob references that reference — and the in-memory
 *    store mirrors both (GET /connections no longer lists it).
 *  - ONE record per call, exact reference only: a second connection
 *    with a different reference — and its outbox entries — is
 *    untouched, and re-deleting the same reference is a 404.
 *
 * The target record is created through the REAL public POST
 * /connections (the TS-CC7T8X shape: PROVIDER_APPLICATION via
 * network-site-provider-join, 604 area code) so its notification
 * outbox entries are the genuine linked ones.
 *
 * Runs against a LOCAL test database only. Usage:
 *   DATABASE_URL=postgresql://... node test/admin-connections-delete.test.mjs
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

const PORT = Number(process.env.TEST_PORT || 4479);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const PASSWORD = 'test-pass-1234';

const IDS = {
  owner: '90000000-0000-4000-8000-0000000000b1',
  manager: '90000000-0000-4000-8000-0000000000b2',
  setter: '90000000-0000-4000-8000-0000000000b3',
};
const EMAILS = {
  owner: 'cd-owner@test.local',
  manager: 'cd-manager@test.local',
  setter: 'cd-setter@test.local',
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
  return { status: res.status, json };
}

async function login(email) {
  const res = await api('/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  return res.json?.token || null;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 500));
const connectionCount = () => prisma.connection.count();
const outboxReferencing = async (reference) =>
  (await prisma.notificationOutbox.findMany()).filter((e) => JSON.stringify(e).includes(reference)).length;

async function seed() {
  const passwordHash = await hashPassword(PASSWORD);
  await prisma.company.upsert({
    where: { id: PLATFORM_COMPANY_ID }, update: {},
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'cd-platform', type: 'PLATFORM_OWNER', isPlatformOwner: true },
  });
  const users = [
    [IDS.owner, EMAILS.owner, ['COMPANY_OWNER']],
    [IDS.manager, EMAILS.manager, ['COMPANY_ADMIN']],
    [IDS.setter, EMAILS.setter, ['DISPATCHER']],
  ];
  for (const [id, email, roles] of users) {
    await prisma.user.upsert({
      where: { id },
      update: { passwordHash },
      create: { id, companyId: PLATFORM_COMPANY_ID, email, passwordHash, phone: '9545550110', roles, active: true },
    });
  }
}

async function cleanup() {
  try {
    await prisma.user.deleteMany({ where: { id: { in: Object.values(IDS) } } });
  } catch (error) {
    console.error('cleanup warning:', error.message);
  }
}

function startServer() {
  const proc = spawn('node', ['src/server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      ...process.env,
      PORT: String(PORT),
      JWT_SECRET: 'admin-connections-delete-test-secret',
      DATABASE_URL: process.env.DATABASE_URL,
      DATABASE_URL_UNPOOLED: process.env.DATABASE_URL,
      OPENAI_API_KEY: '',
      OPENAI_API_KEY_V2: '',
    },
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
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('server did not come up');
}

async function main() {
  await seed();
  server = startServer();
  await waitForServer();

  // ---- Public + gated route sanity (shared-prefix trap check) ----
  check('health 200', (await api('/health')).status, 200);
  check('payments/status 200', (await api('/payments/status')).status, 200);

  const ownerToken = await login(EMAILS.owner);
  const managerToken = await login(EMAILS.manager);
  const setterToken = await login(EMAILS.setter);
  checkTrue('owner login returns a token', ownerToken);
  checkTrue('manager login returns a token', managerToken);
  checkTrue('setter login returns a token', setterToken);

  // ---- Seed the records through the real public intake ----
  const target = await api('/connections', {
    method: 'POST',
    body: {
      type: 'PROVIDER_APPLICATION', name: 'Olohlq', email: 'dbond@test.local',
      phone: '6045550142', source: 'network-site-provider-join', message: 'Qwmarlafq LLC — spam application',
    },
  });
  check('target connection created → 201', target.status, 201);
  const refTarget = target.json?.data?.reference || '';
  checkTrue('target carries a TS- reference', /^TS-/.test(refTarget));

  const bystander = await api('/connections', {
    method: 'POST',
    body: {
      type: 'PM_WALKTHROUGH_REQUEST', name: 'Pat Manager', email: 'pat@test.local',
      phone: '9545550101', source: 'flagship-pm', message: 'Portal walkthrough request — Sunrise Property Group',
    },
  });
  check('bystander connection created → 201', bystander.status, 201);
  const refBystander = bystander.json?.data?.reference || '';
  checkTrue('bystander carries a TS- reference', /^TS-/.test(refBystander));
  checkTrue('the two references differ', refTarget !== refBystander);

  await settle();
  check('two connections persisted', await connectionCount(), 2);
  checkTrue('target row is in the database', await prisma.connection.findUnique({ where: { reference: refTarget } }));
  const outboxTargetBefore = await outboxReferencing(refTarget);
  const outboxBystanderBefore = await outboxReferencing(refBystander);
  checkTrue('target has linked outbox entries', outboxTargetBefore >= 1);
  checkTrue('bystander has linked outbox entries', outboxBystanderBefore >= 1);

  // ---- The gate: nobody but the owner can delete ----
  const anon = await api('/admin/connections/delete', { method: 'POST', body: { reference: refTarget } });
  check('anon delete → 401', anon.status, 401);
  const setterTry = await api('/admin/connections/delete', { token: setterToken, method: 'POST', body: { reference: refTarget } });
  check('dispatcher delete → 403', setterTry.status, 403);
  const managerTry = await api('/admin/connections/delete', { token: managerToken, method: 'POST', body: { reference: refTarget } });
  check('manager (COMPANY_ADMIN) delete → 403', managerTry.status, 403);
  checkTrue('record survives the unauthorized attempts', await prisma.connection.findUnique({ where: { reference: refTarget } }));

  // ---- Owner-side request discipline ----
  const missing = await api('/admin/connections/delete', { token: ownerToken, method: 'POST', body: {} });
  check('owner, missing reference → 400', missing.status, 400);
  check('missing reference error text', missing.json?.error, 'A connection reference is required');
  const unknown = await api('/admin/connections/delete', { token: ownerToken, method: 'POST', body: { reference: 'TS-ZZZZZ9' } });
  check('owner, unknown reference → 404', unknown.status, 404);
  check('unknown reference error text', unknown.json?.error, 'No connection found with that reference');
  check('failed owner attempts deleted nothing', await connectionCount(), 2);

  // ---- The delete itself ----
  const del = await api('/admin/connections/delete', { token: ownerToken, method: 'POST', body: { reference: refTarget } });
  check('owner delete → 200', del.status, 200);
  check('delete ok flag', del.json?.ok, true);
  check('deleted.reference echoes the target', del.json?.deleted?.reference, refTarget);
  check('deleted.connections is 1', del.json?.deleted?.connections, 1);
  check('deleted.outbox counts the linked entries', del.json?.deleted?.outbox, outboxTargetBefore);
  check('remainingConnections is 1', del.json?.remainingConnections, 1);

  await settle();
  check('database connection count is 1', await connectionCount(), 1);
  check('target row is gone from the database', await prisma.connection.findUnique({ where: { reference: refTarget } }), null);
  check('target outbox entries are gone', await outboxReferencing(refTarget), 0);
  checkTrue('bystander row is untouched', await prisma.connection.findUnique({ where: { reference: refBystander } }));
  check('bystander outbox entries are untouched', await outboxReferencing(refBystander), outboxBystanderBefore);

  // ---- In-memory mirror: the staff list no longer shows it ----
  const list = await api('/connections', { token: setterToken });
  check('GET /connections (staff) → 200', list.status, 200);
  const listedRefs = (list.json?.data || []).map((c) => c.reference);
  checkTrue('staff list no longer contains the deleted reference', !listedRefs.includes(refTarget));
  checkTrue('staff list still contains the bystander', listedRefs.includes(refBystander));

  // ---- One-shot discipline: deleting it again is a 404 ----
  const again = await api('/admin/connections/delete', { token: ownerToken, method: 'POST', body: { reference: refTarget } });
  check('re-delete the same reference → 404', again.status, 404);
  check('bystander still standing at the end', await connectionCount(), 1);

  console.log(`\n${passed} passed, ${failed} failed`);
  return failed;
}

main()
  .then(async (failuresCount) => {
    if (server) server.kill('SIGTERM');
    await cleanup();
    await prisma.$disconnect();
    process.exit(failuresCount === 0 ? 0 : 1);
  })
  .catch(async (error) => {
    console.error(error);
    if (server) server.kill('SIGTERM');
    await prisma.$disconnect();
    process.exit(1);
  });
