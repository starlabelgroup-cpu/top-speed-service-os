/**
 * Master Pepper Presence drills (2026-11-20).
 *
 * Ramone's directive: "every time I'm logged in app you must be there
 * to assist me always with anything due your title and the builder of
 * the system." The web build answers it two ways: the Ask Pepper bar
 * keeps riding the staff consoles (shared/pepper-chat.js), and on
 * surfaces whose signed-in users are NOT staff — the customer app
 * (/app), the Pepper Lists account area, the Advertiser Console — a
 * COMPANY_OWNER-only gate (shared/pepper-master-gate.js) mounts the
 * same bar for the Master and for nobody else.
 *
 * This harness proves the two halves that make that safe:
 *  - the API gate behind the bar (POST /api/v1/pepper/chat):
 *    anonymous 401, customer 403, PROVIDER token 403 (providers have
 *    their own scoped lane), staff 200, and the Master
 *    (COMPANY_OWNER) 200 — the session the gate mounts for is a
 *    session the endpoint actually serves;
 *  - /auth/me carries the roles ARRAY the web gate reads, with
 *    COMPANY_OWNER present for the Master and absent for a provider;
 *  - the web files, read from disk: the gate + its per-surface hooks
 *    are wired exactly where intended, the one staff console that
 *    lacked the bar (Marketing OS Expander) now loads it directly,
 *    and public pages (homepage, /book) carry NEITHER the bar nor
 *    the gate.
 *
 * Run: DATABASE_URL=<local test db> node test/master-pepper-presence.test.mjs
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/services/passwords.js';
import { PLATFORM_COMPANY_ID } from '../src/data/store.js';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required (point it at a local TEST database).');
  process.exit(2);
}
if (!process.env.DATABASE_URL_UNPOOLED) process.env.DATABASE_URL_UNPOOLED = process.env.DATABASE_URL;

const PORT = Number(process.env.TEST_PORT || 4577);
const JWT_SECRET = process.env.JWT_SECRET || 'master-pepper-drill-secret';
const PASSWORD = 'test-pass-1234';

const IDS = {
  staff: '60000000-0000-4000-8000-0000000000e1',
  master: '60000000-0000-4000-8000-0000000000e2',
  provider: '60000000-0000-4000-8000-0000000000e3',
  customer: '60000000-0000-4000-8000-0000000000e4',
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
    return { status: res.status, json };
  });
}

async function login(base, email) {
  const { status, json } = await api(base, '/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  if (status !== 200 || !json?.token) throw new Error(`login failed for ${email}: ${status} ${JSON.stringify(json)}`);
  return json.token;
}

function spawnServer(port) {
  const env = { ...process.env, PORT: String(port), JWT_SECRET };
  delete env.OPENAI_API_KEY;
  delete env.OPENAI_API_KEY_V2;
  delete env.OPENAI_API_BASE;
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
    { id: IDS.staff, email: 'presence-staff@test.local', roles: ['DISPATCHER'] },
    { id: IDS.master, email: 'presence-master@test.local', roles: ['COMPANY_OWNER'] },
    { id: IDS.provider, email: 'presence-provider@test.local', roles: ['PROVIDER_OWNER'] },
    { id: IDS.customer, email: 'presence-customer@test.local', roles: ['CUSTOMER'] },
  ];
  for (const u of users) {
    await prisma.user.upsert({
      where: { id: u.id },
      update: { passwordHash, roles: u.roles },
      create: { id: u.id, companyId: PLATFORM_COMPANY_ID, email: u.email, passwordHash, phone: '9545550200', roles: u.roles, active: true },
    });
  }
}

async function cleanupDb() {
  try {
    await prisma.user.deleteMany({ where: { id: { in: Object.values(IDS) } } });
  } catch (error) {
    console.error('cleanup warning:', error.message);
  }
}

async function main() {
  await cleanupDb();
  await seed();
  const base = `http://127.0.0.1:${PORT}/api/v1`;
  const server = spawnServer(PORT);
  try {
    await waitForServer(base);

    check('chat unauthenticated 401', (await api(base, '/pepper/chat', { method: 'POST', body: { message: 'hi' } })).status, 401);

    const staff = await login(base, 'presence-staff@test.local');
    const master = await login(base, 'presence-master@test.local');
    const provider = await login(base, 'presence-provider@test.local');
    const customer = await login(base, 'presence-customer@test.local');

    check('customer refused chat (403)', (await api(base, '/pepper/chat', { token: customer, method: 'POST', body: { message: 'hi' } })).status, 403);
    check('provider refused staff chat (403)', (await api(base, '/pepper/chat', { token: provider, method: 'POST', body: { message: 'hi' } })).status, 403);

    const staffChat = await api(base, '/pepper/chat', { token: staff, method: 'POST', body: { message: 'What are the pricing rules?' } });
    check('staff chat 200', staffChat.status, 200);
    checkTrue('staff chat answers', typeof staffChat.json?.data?.reply === 'string' && staffChat.json.data.reply.length > 0);

    const masterChat = await api(base, '/pepper/chat', { token: master, method: 'POST', body: { message: 'What are the pricing rules?' } });
    check('master chat 200', masterChat.status, 200);
    checkTrue('master chat answers', typeof masterChat.json?.data?.reply === 'string' && masterChat.json.data.reply.length > 0);
    check('master chat labeled knowledge-pack (no AI in drills)', masterChat.json?.data?.answeredBy, 'knowledge-pack');

    // The web gate's data source: /auth/me roles array.
    const meMaster = await api(base, '/auth/me', { token: master });
    check('master /auth/me 200', meMaster.status, 200);
    const masterUser = meMaster.json?.user || meMaster.json?.data || {};
    checkTrue('master roles is an array', Array.isArray(masterUser.roles));
    checkTrue('master roles include COMPANY_OWNER', Array.isArray(masterUser.roles) && masterUser.roles.includes('COMPANY_OWNER'));

    const meProvider = await api(base, '/auth/me', { token: provider });
    const providerUser = meProvider.json?.user || meProvider.json?.data || {};
    checkTrue('provider roles lack COMPANY_OWNER (gate stays closed)', Array.isArray(providerUser.roles) && !providerUser.roles.includes('COMPANY_OWNER'));

    const meCustomer = await api(base, '/auth/me', { token: customer });
    const customerUser = meCustomer.json?.user || meCustomer.json?.data || {};
    checkTrue('customer roles lack COMPANY_OWNER (gate stays closed)', Array.isArray(customerUser.roles) && !customerUser.roles.includes('COMPANY_OWNER'));
  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 500));
  }

  // ── Web files, read from disk ────────────────────────────────
  const webRoot = fileURLToPath(new URL('../../web/', import.meta.url));
  const read = (p) => readFileSync(`${webRoot}${p}`, 'utf8');

  const gate = read('shared/pepper-master-gate.js');
  checkTrue('gate: exists and checks COMPANY_OWNER', gate.includes('COMPANY_OWNER'));
  checkTrue('gate: roles read as an array', gate.includes('Array.isArray(user.roles)'));
  checkTrue('gate: loads the shared bar unchanged', gate.includes('/shared/pepper-chat.js'));
  checkTrue('gate: honors per-surface token keys', gate.includes('PEPPER_MASTER_TOKEN_KEYS'));
  checkTrue('gate: exposes the checkUser hook', gate.includes('PepperMasterGate'));

  const app = read('app/index.html');
  checkTrue('/app: loads the master gate', app.includes('/shared/pepper-master-gate.js'));
  checkTrue('/app: session hook feeds the gate', app.includes('PepperMasterGate.checkUser'));
  check('/app: does NOT load the bar directly (gate-only)', app.includes('/shared/pepper-chat.js'), false);
  checkTrue('/app: Speedy widget untouched', app.includes('/speedy-widget.js'));

  const pl = read('pepper-lists-site/index.html');
  checkTrue('pepper-lists: loads the master gate', pl.includes('/shared/pepper-master-gate.js'));
  checkTrue('pepper-lists: session hook feeds the gate', pl.includes('PepperMasterGate.checkUser'));
  check('pepper-lists: does NOT load the bar directly (gate-only)', pl.includes('/shared/pepper-chat.js'), false);

  const adv = read('advertiser/index.html');
  checkTrue('advertiser: names its own session key for the gate', adv.includes("PEPPER_MASTER_TOKEN_KEYS=['tsos_adv_token'"));
  checkTrue('advertiser: loads the master gate', adv.includes('/shared/pepper-master-gate.js'));
  checkTrue('advertiser: session hook feeds the gate', adv.includes('PepperMasterGate.checkUser'));
  check('advertiser: does NOT load the bar directly (gate-only)', adv.includes('/shared/pepper-chat.js'), false);

  const expander = read('marketing-os/expander/index.html');
  checkTrue('expander (staff tool): loads the bar directly', expander.includes('/shared/pepper-chat.js'));

  for (const page of ['tech/index.html', 'crm/index.html', 'book-os/index.html', 'pepper/index.html']) {
    checkTrue(`staff console unchanged: ${page} still loads the bar`, read(page).includes('/shared/pepper-chat.js'));
  }

  const homepage = read('index.html');
  check('homepage: NO bar', homepage.includes('pepper-chat'), false);
  check('homepage: NO gate', homepage.includes('pepper-master-gate'), false);
  const book = read('book/index.html');
  check('/book: NO bar', book.includes('pepper-chat'), false);
  check('/book: NO gate', book.includes('pepper-master-gate'), false);

  await cleanupDb();
  await prisma.$disconnect();
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  try { await prisma.$disconnect(); } catch { /* ignore */ }
  process.exit(1);
});
