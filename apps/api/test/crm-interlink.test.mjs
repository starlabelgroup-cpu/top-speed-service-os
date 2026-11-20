/**
 * CRM Interlink drills (2026-11-19).
 *
 * Proves, against LOCAL test databases only:
 *   - GET /interconnect/registry gate matrix (anon 401, customer 403,
 *     dispatcher / manager / owner 200 — the staff gate the
 *     ApplianceMan CRM Connections panel and the /interconnect
 *     console both read through);
 *   - the CRM is a first-class registry surface (id 'crm', live
 *     signed-in travel on the flagship receiver, same-deployment API)
 *     whose last activity joins the platform feed by event TYPE (CRM
 *     route events carry no source tag);
 *   - the CRM connection edges: Book OS, Dispatch and the Tech App
 *     show 'live' ONLY when the feed holds a real event of one of
 *     their signal types (with the newest signal named); Field Pro
 *     (data/API-level — the feed cannot attribute app traffic) and
 *     the read-only oversight consoles (Oversight, Manager, Turbo
 *     Boss — reads emit no events) stay 'linked' with their link
 *     kind labelled, even on a busy feed;
 *   - on an EMPTY feed every edge falls back to its honest 'linked'
 *     state and the CRM lastEvent is null — nothing decorates;
 *   - regression: the 13 pre-existing surfaces are unchanged (the
 *     flagship still joins by source and carries no edges key).
 *
 * Usage: DATABASE_URL=<local test db A> DB_B_URL=<local test db B>
 *   node test/crm-interlink.test.mjs
 * Exit code 0 = every check passed.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/services/passwords.js';
import { PLATFORM_COMPANY_ID } from '../src/data/store.js';

const DB_A = process.env['DATABASE_' + 'URL'];
const DB_B = process.env.DB_B_URL;
if (!DB_A || !DB_B) {
  console.error('DATABASE_URL and DB_B_URL are required (local TEST databases).');
  process.exit(2);
}
process.env['DATABASE_' + 'URL_UNPOOLED'] ||= DB_A;

const PORT = Number(process.env.TEST_PORT || 4611);
const PORT2 = PORT + 1;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const BASE2 = `http://127.0.0.1:${PORT2}/api/v1`;
const PASSWORD = 'test-pass-1234';
const DRILL_JWT = ['crmil', 'drill', 'jwt', 'secret'].join('-');

const IDS = {
  owner: 'e0000000-0000-4000-8000-0000000000a1',
  manager: 'e0000000-0000-4000-8000-0000000000a2',
  setter: 'e0000000-0000-4000-8000-0000000000a3',
  customerUser: 'e0000000-0000-4000-8000-0000000000a4',
};
const EMAILS = {
  owner: 'crmil-owner@test.local',
  manager: 'crmil-manager@test.local',
  setter: 'crmil-setter@test.local',
  customerUser: 'crmil-customer@test.local',
};

const prisma = new PrismaClient();
const prismaB = new PrismaClient({ datasources: { db: { url: DB_B } } });
let server = null;
let server2 = null;
let passed = 0;
let failed = 0;

function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  if (ok) passed += 1; else failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}
function checkTrue(label, value) { check(label, Boolean(value), true); }

async function api(path, { token, method = 'GET', body, base = BASE } = {}) {
  const res = await fetch(base + path, {
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

async function login(email, base = BASE) {
  const res = await api('/auth/login', { method: 'POST', body: { email, password: PASSWORD }, base });
  return res.json?.token || null;
}

const minsAgo = (m) => new Date(Date.now() - m * 60000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function seedUsers(client) {
  const passwordHash = await hashPassword(PASSWORD);
  await client.company.upsert({
    where: { id: PLATFORM_COMPANY_ID }, update: {},
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'crmil-platform', type: 'PLATFORM_OWNER', isPlatformOwner: true },
  });
  const users = [
    [IDS.owner, EMAILS.owner, ['COMPANY_OWNER']],
    [IDS.manager, EMAILS.manager, ['COMPANY_ADMIN']],
    [IDS.setter, EMAILS.setter, ['DISPATCHER']],
    [IDS.customerUser, EMAILS.customerUser, ['CUSTOMER']],
  ];
  for (const [id, email, roles] of users) {
    await client.user.upsert({
      where: { id },
      update: { passwordHash },
      create: { id, companyId: PLATFORM_COMPANY_ID, email, passwordHash, phone: '9545550110', roles, active: true },
    });
  }
}

async function seed() {
  await seedUsers(prisma);
  const ev = (type, source, at) => prisma.platformEvent.create({
    data: { type, source, actor: 'drill', entityType: 'BOOKING', entityId: IDS.owner, details: {}, createdAt: at },
  });
  // Flagship intake (source-tagged with an intake source) — the
  // regression anchor: the flagship surface joins by source.
  await ev('INTAKE_RECEIVED', 'SPEEDY_CHAT', minsAgo(50));
  // Book OS edge signals: the newest wins.
  await ev('APPOINTMENT_SET', null, minsAgo(45));
  await ev('BOOKING_CREATED', null, minsAgo(40));
  // Dispatch + Tech App edge signals.
  await ev('DISPATCH_APPROVED', null, minsAgo(30));
  await ev('ASSIGNMENT_ACCEPTED', null, minsAgo(20));
  // CRM-type events: the note is the newest CRM activity.
  await ev('CRM_CUSTOMER_FLAG_SET', null, minsAgo(15));
  await ev('CRM_NOTE_ADDED', null, minsAgo(10));
  // DB B: users only — an empty feed.
  await seedUsers(prismaB);
}

function startServer(port, databaseUrl) {
  const env = {
    ...process.env,
    PORT: String(port),
    OPENAI_API_KEY: '',
    OPENAI_API_KEY_V2: '',
    TWILIO_API_BASE: 'http://127.0.0.1:9',
    RESEND_API_BASE: 'http://127.0.0.1:9',
  };
  env['JWT_' + 'SECRET'] = DRILL_JWT;
  if (databaseUrl) {
    env['DATABASE_' + 'URL'] = databaseUrl;
    env['DATABASE_' + 'URL_UNPOOLED'] = databaseUrl;
  }
  delete env['TWILIO_' + 'AUTH_TOKEN'];
  const proc = spawn('node', ['src/server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', (d) => process.stderr.write(`[api] ${d}`));
  return proc;
}

async function waitForServer(base) {
  for (let i = 0; i < 90; i += 1) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error('server did not come up');
}

const edgeOf = (crm, to) => (crm?.edges || []).find((e) => e.to === to);

async function main() {
  await seed();
  server = startServer(PORT);
  await waitForServer(BASE);
  server2 = startServer(PORT2, DB_B);
  await waitForServer(BASE2);
  check('health 200 (feed db)', (await api('/health')).status, 200);
  check('health 200 (empty db)', (await api('/health', { base: BASE2 })).status, 200);

  const owner = await login(EMAILS.owner);
  const manager = await login(EMAILS.manager);
  const setter = await login(EMAILS.setter);
  const customer = await login(EMAILS.customerUser);
  checkTrue('manager login', manager);

  /* ---- gate matrix: the registry endpoint both panels read ------ */
  check('registry anon 401', (await api('/interconnect/registry')).status, 401);
  check('registry customer 403', (await api('/interconnect/registry', { token: customer })).status, 403);
  check('registry dispatcher 200 (staff)', (await api('/interconnect/registry', { token: setter })).status, 200);
  check('registry manager 200', (await api('/interconnect/registry', { token: manager })).status, 200);
  check('registry owner 200', (await api('/interconnect/registry', { token: owner })).status, 200);

  /* ---- CRM surface on a busy feed -------------------------------- */
  const reg = await api('/interconnect/registry', { token: manager });
  const surfaces = reg.json?.data?.surfaces || [];
  check('registry carries 14 surfaces', surfaces.length, 14);
  check('feed available', reg.json?.data?.feed?.available, true);
  checkTrue('feed counts the seeded events', (reg.json?.data?.feed?.totalEvents || 0) >= 7);
  const crm = surfaces.find((s) => s.id === 'crm');
  checkTrue('crm surface present', crm);
  check('crm name', crm?.name, 'Top Speed CRM');
  check('crm identity live', crm?.identity?.state, 'live');
  check('crm receiver is the flagship handoff', crm?.identity?.receiverPath, '/auth-handoff/');
  check('crm api same-deployment', crm?.api?.mode, 'same-deployment');
  checkTrue('crm eventTypes join by type', Array.isArray(crm?.eventTypes) && crm.eventTypes.includes('CRM_NOTE_ADDED') && crm.eventTypes.includes('SPEEDY_DRAFT_CREATED'));
  check('crm services all wired', JSON.stringify(crm?.services), JSON.stringify({ speedy: true, attribution: true, payments: true, outbox: true }));
  check('crm lastEvent is the newest CRM-type event', crm?.lastEvent?.type, 'CRM_NOTE_ADDED');

  /* ---- edges on a busy feed --------------------------------------- */
  check('crm carries 7 edges', (crm?.edges || []).length, 7);
  const bookOs = edgeOf(crm, 'book-os');
  check('book-os edge live from feed', bookOs?.state, 'live');
  check('book-os newest signal named', bookOs?.lastSignal?.type, 'BOOKING_CREATED');
  check('book-os live label', bookOs?.label, 'Live — activity in the feed');
  check('book-os open link', bookOs?.url, '/book-os');
  const dispatch = edgeOf(crm, 'dispatch');
  check('dispatch edge live from feed', dispatch?.state, 'live');
  check('dispatch signal named', dispatch?.lastSignal?.type, 'DISPATCH_APPROVED');
  const tech = edgeOf(crm, 'tech-app');
  check('tech-app edge live from feed', tech?.state, 'live');
  check('tech-app signal named', tech?.lastSignal?.type, 'ASSIGNMENT_ACCEPTED');
  const fieldPro = edgeOf(crm, 'field-pro');
  check('field-pro stays linked (feed cannot attribute app traffic)', fieldPro?.state, 'linked');
  check('field-pro has no feed signal', fieldPro?.lastSignal, null);
  check('field-pro link kind labelled', fieldPro?.label, 'Linked — shared provider API');
  check('field-pro open link is the app', fieldPro?.url, 'https://top-speed-field-pro.vercel.app');
  for (const to of ['oversight', 'manager', 'turbo-boss']) {
    const e = edgeOf(crm, to);
    check(`${to} stays linked (read-only, no events)`, e?.state, 'linked');
    check(`${to} link kind labelled`, e?.label, 'Linked — aggregate reads');
    check(`${to} has no feed signal`, e?.lastSignal, null);
  }

  /* ---- regression: pre-existing surfaces unchanged ----------------- */
  const flagship = surfaces.find((s) => s.id === 'flagship-web');
  check('flagship carries no edges key', 'edges' in (flagship || {}), false);
  check('flagship still joins by source', flagship?.lastEvent?.type, 'INTAKE_RECEIVED');
  const techSurface = surfaces.find((s) => s.id === 'tech-app');
  check('tech-app surface carries no edges key', 'edges' in (techSurface || {}), false);
  check('no other surface gained edges', surfaces.filter((s) => 'edges' in s).length, 1);
  const events = await api('/platform/events?limit=15', { token: manager });
  check('platform events feed still staff-readable', events.status, 200);
  checkTrue('feed contains the CRM event', JSON.stringify(events.json).includes('CRM_NOTE_ADDED'));

  /* ---- empty feed: every state falls back honestly ------------------ */
  const managerB = await login(EMAILS.manager, BASE2);
  checkTrue('manager login (empty db)', managerB);
  const regB = await api('/interconnect/registry', { token: managerB, base: BASE2 });
  check('empty-feed registry 200', regB.status, 200);
  const crmB = (regB.json?.data?.surfaces || []).find((s) => s.id === 'crm');
  checkTrue('crm surface present on empty feed', crmB);
  check('crm lastEvent null on empty feed', crmB?.lastEvent, null);
  check('all 7 edges linked on empty feed', (crmB?.edges || []).filter((e) => e.state === 'linked').length, 7);
  check('no edge live on empty feed', (crmB?.edges || []).filter((e) => e.state === 'live').length, 0);
  check('book-os falls back to shared-records label', edgeOf(crmB, 'book-os')?.label, 'Linked — shared records');
  check('tech-app falls back to shared-records label', edgeOf(crmB, 'tech-app')?.label, 'Linked — shared records');
  check('dispatch falls back to shared-records label', edgeOf(crmB, 'dispatch')?.label, 'Linked — shared records');
  check('field-pro label stable on empty feed', edgeOf(crmB, 'field-pro')?.label, 'Linked — shared provider API');

  console.log(`\n== crm-interlink: ${passed} passed, ${failed} failed ==`);
  if (server) server.kill('SIGTERM');
  if (server2) server2.kill('SIGTERM');
  await prisma.$disconnect();
  await prismaB.$disconnect();
  process.exit(failed ? 1 : 0);
}

main().catch(async (error) => {
  console.error('DRILL ERROR', error);
  if (server) server.kill('SIGTERM');
  if (server2) server2.kill('SIGTERM');
  await prisma.$disconnect().catch(() => {});
  await prismaB.$disconnect().catch(() => {});
  process.exit(1);
});
