/**
 * Pepper Lists Channel Connections — verification harness (2026-11-17).
 *
 * Exercises Phase 1 of the Pepper Lists channel registry
 * (routes/pepperListsChannels.js) end to end over HTTP:
 *  - the 10-channel catalog with honest NOT_CONNECTED defaults;
 *  - connect files a PENDING request (never CONNECTED — Phase 1 has
 *    no completed third-party flow, so nothing may invent one);
 *  - the Muse-agent access grant toggle;
 *  - per-seller isolation (seller B never sees or changes seller A's
 *    rows — every route is scoped to the token's userId);
 *  - disconnect clearing label + grant;
 *  - the audit log (CONNECT_REQUESTED / AGENT_ACCESS_GRANTED /
 *    DISCONNECTED rows written in the same calls);
 *  - the staff oversight read (statuses + labels only, no `meta`,
 *    customers refused 403, anonymous refused 401).
 *
 * Runs against a LOCAL test database only. Usage:
 *   DATABASE_URL=postgresql://... node test/pepper-lists-channels.test.mjs
 * The harness seeds its own users, boots the real API on TEST_PORT
 * (default 4427), and cleans up. Exit code 0 = every check passed.
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

const PORT = Number(process.env.TEST_PORT || 4427);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const PASSWORD = 'test-pass-1234';

const IDS = {
  sellerA: '20000000-0000-4000-8000-0000000000c1',
  sellerB: '20000000-0000-4000-8000-0000000000c2',
  staff: '20000000-0000-4000-8000-0000000000c3',
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
    { id: IDS.sellerA, email: 'seller-a@test.local', roles: ['CUSTOMER'] },
    { id: IDS.sellerB, email: 'seller-b@test.local', roles: ['CUSTOMER'] },
    { id: IDS.staff, email: 'staff@test.local', roles: ['COMPANY_ADMIN'] },
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
    await prisma.sellerChannelAudit.deleteMany({ where: { userId: { in: Object.values(IDS) } } });
    await prisma.sellerChannelConnection.deleteMany({ where: { userId: { in: Object.values(IDS) } } });
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

function channelOf(listJson, key) {
  return listJson.data.channels.find((c) => c.key === key);
}

async function main() {
  await cleanup();
  await seed();
  server = spawn('node', ['src/server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      ...process.env,
      PORT: String(PORT),
      JWT_SECRET: 'test-secret-pepper-lists-channels',
      DATABASE_URL: process.env.DATABASE_URL,
      DATABASE_URL_UNPOOLED: process.env.DATABASE_URL_UNPOOLED,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[api] ${d}`));
  await waitForServer();

  // ── Auth gates ────────────────────────────────────────────────
  check('channels unauthenticated', (await api('/pepper-lists/channels')).status, 401);
  check('connect unauthenticated', (await api('/pepper-lists/channels/EBAY/connect', { method: 'POST', body: {} })).status, 401);
  check('agent-access unauthenticated', (await api('/pepper-lists/channels/EBAY/agent-access', { method: 'PATCH', body: { granted: true } })).status, 401);
  check('oversight unauthenticated', (await api('/pepper-lists/channels/oversight')).status, 401);

  const a = await login('seller-a@test.local');
  const b = await login('seller-b@test.local');
  const staff = await login('staff@test.local');

  // ── Catalog defaults ──────────────────────────────────────────
  const before = await api('/pepper-lists/channels', { token: a });
  check('A channel list 200', before.status, 200);
  check('catalog has 10 channels', before.json.data.channels.length, 10);
  checkTrue('all start NOT_CONNECTED', before.json.data.channels.every((c) => c.connection.status === 'NOT_CONNECTED'));
  checkTrue('no grants by default', before.json.data.channels.every((c) => c.connection.agentAccessGranted === false));
  check('FACEBOOK kind is SELL', channelOf(before.json, 'FACEBOOK').kind, 'SELL');
  check('TIKTOK kind is POST', channelOf(before.json, 'TIKTOK').kind, 'POST');
  check('WALMART next steps name Walmart approval', channelOf(before.json, 'WALMART').nextSteps.includes('marketplace.walmart.com'), true);

  // ── Connect = PENDING request, never CONNECTED ────────────────
  const fb = await api('/pepper-lists/channels/FACEBOOK/connect', { token: a, method: 'POST', body: { accountLabel: 'Jane Seller' } });
  check('A connect FACEBOOK 201', fb.status, 201);
  check('FACEBOOK lands PENDING (not CONNECTED)', fb.json.data.connection.status, 'PENDING');
  check('FACEBOOK label stored', fb.json.data.connection.externalAccountLabel, 'Jane Seller');
  checkTrue('connect returns next steps', typeof fb.json.data.nextSteps === 'string' && fb.json.data.nextSteps.length > 20);

  const ebay = await api('/pepper-lists/channels/EBAY/connect', { token: a, method: 'POST', body: {} });
  check('A connect EBAY 201', ebay.status, 201);
  check('EBAY lands PENDING', ebay.json.data.connection.status, 'PENDING');

  check('unknown channel 404', (await api('/pepper-lists/channels/NOPE/connect', { token: a, method: 'POST', body: {} })).status, 404);

  // ── Agent-access grant ────────────────────────────────────────
  const grant = await api('/pepper-lists/channels/EBAY/agent-access', { token: a, method: 'PATCH', body: { granted: true } });
  check('A grant EBAY agent access 200', grant.status, 200);
  check('EBAY grant stored', grant.json.data.connection.agentAccessGranted, true);
  check('bad grant body 400', (await api('/pepper-lists/channels/EBAY/agent-access', { token: a, method: 'PATCH', body: { granted: 'yes' } })).status, 400);

  // ── Duplicate connect keeps ONE row ───────────────────────────
  const fbAgain = await api('/pepper-lists/channels/FACEBOOK/connect', { token: a, method: 'POST', body: { accountLabel: 'Jane Seller' } });
  check('duplicate connect still 201', fbAgain.status, 201);
  const fbRows = await prisma.sellerChannelConnection.count({ where: { userId: IDS.sellerA, channel: 'FACEBOOK' } });
  check('exactly one FACEBOOK row for A', fbRows, 1);

  // ── Audit rows written ────────────────────────────────────────
  const auditAfterConnects = await prisma.sellerChannelAudit.findMany({ where: { userId: IDS.sellerA }, orderBy: { createdAt: 'asc' } });
  check('audit: 3 CONNECT_REQUESTED (FB x2 + EBAY)', auditAfterConnects.filter((x) => x.action === 'CONNECT_REQUESTED').length, 3);
  check('audit: 1 AGENT_ACCESS_GRANTED', auditAfterConnects.filter((x) => x.action === 'AGENT_ACCESS_GRANTED').length, 1);

  // ── Isolation: B sees none of A's state ───────────────────────
  const bList = await api('/pepper-lists/channels', { token: b });
  check('B list 200', bList.status, 200);
  checkTrue('B sees all NOT_CONNECTED', bList.json.data.channels.every((c) => c.connection.status === 'NOT_CONNECTED'));
  check('B EBAY grant is B\u2019s own (false)', channelOf(bList.json, 'EBAY').connection.agentAccessGranted, false);

  // B toggling B's own EBAY grant must not touch A's row.
  await api('/pepper-lists/channels/EBAY/agent-access', { token: b, method: 'PATCH', body: { granted: false } });
  const aListMid = await api('/pepper-lists/channels', { token: a });
  check('A EBAY still PENDING after B activity', channelOf(aListMid.json, 'EBAY').connection.status, 'PENDING');
  check('A EBAY grant untouched by B', channelOf(aListMid.json, 'EBAY').connection.agentAccessGranted, true);
  check('A FACEBOOK still PENDING', channelOf(aListMid.json, 'FACEBOOK').connection.status, 'PENDING');

  // ── Disconnect clears status + label + grant ──────────────────
  const ebayGrantOff = await api('/pepper-lists/channels/EBAY/agent-access', { token: a, method: 'PATCH', body: { granted: true } });
  check('setup: EBAY grant on before disconnect', ebayGrantOff.json.data.connection.agentAccessGranted, true);
  const disc = await api('/pepper-lists/channels/FACEBOOK/disconnect', { token: a, method: 'POST', body: {} });
  check('A disconnect FACEBOOK 200', disc.status, 200);
  check('FACEBOOK back to NOT_CONNECTED', disc.json.data.connection.status, 'NOT_CONNECTED');
  check('FACEBOOK label cleared', disc.json.data.connection.externalAccountLabel, null);
  const discEbay = await api('/pepper-lists/channels/EBAY/disconnect', { token: a, method: 'POST', body: {} });
  check('disconnect clears the agent grant too', discEbay.json.data.connection.agentAccessGranted, false);
  const auditFinal = await prisma.sellerChannelAudit.findMany({ where: { userId: IDS.sellerA } });
  check('audit: 2 DISCONNECTED rows', auditFinal.filter((x) => x.action === 'DISCONNECTED').length, 2);

  // ── Oversight: staff only, no secret material ─────────────────
  const over = await api('/pepper-lists/channels/oversight', { token: staff });
  check('staff oversight 200', over.status, 200);
  checkTrue('oversight lists connections', over.json.data.connections.length >= 2);
  checkTrue('oversight carries seller identity', over.json.data.connections.some((c) => c.user && c.user.email === 'seller-a@test.local'));
  checkTrue('oversight exposes NO meta field', over.json.data.connections.every((c) => !('meta' in c)));
  checkTrue('oversight includes audit trail', Array.isArray(over.json.data.audit) && over.json.data.audit.length >= 4);
  check('seller refused oversight (403)', (await api('/pepper-lists/channels/oversight', { token: a })).status, 403);

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
