/**
 * Intake shield — provider-join gap check (2026-11-19).
 *
 * Companion to intake-shield.test.mjs (which drills the shield with
 * commercial / PM shapes). This file drills the PROVIDER-JOIN shape
 * specifically — the door the confirmed fake TS-CC7T8X came through:
 *
 *   POST /connections
 *   { type: 'PROVIDER_APPLICATION', source: 'network-site-provider-join' }
 *
 * Its phone uses area code 604 — an ASSIGNED NANP area code, so the
 * phone gate passes it (exactly like the real fake). The honeypot is
 * the layer that must stop this shape:
 *
 *  - companyWebsite filled  → 201 success shape with a TS- reference,
 *    but NO Connection record persisted and NO outbox entry queued.
 *  - companyWebsite empty   → 201, record persisted, staff alert queued.
 *
 * Runs against a LOCAL test database only. Usage:
 *   DATABASE_URL=postgresql://... node test/intake-shield-provider-join.test.mjs
 * Exit code 0 = every check passed.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { PLATFORM_COMPANY_ID } from '../src/data/store.js';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required (point it at a local TEST database).');
  process.exit(2);
}
process.env.DATABASE_URL_UNPOOLED ||= process.env.DATABASE_URL;

const PORT = Number(process.env.TEST_PORT || 4464);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;

const prisma = new PrismaClient();
let server = null;
let failures = 0;

function startServer() {
  const proc = spawn('node', ['src/server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      ...process.env,
      PORT: String(PORT),
      JWT_SECRET: 'intake-shield-provider-join-test-secret',
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

function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}
function checkTrue(label, value) { check(label, Boolean(value), true); }

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 500));
const outboxCount = () => prisma.notificationOutbox.count();
const connectionCount = () => prisma.connection.count();

// The provider-join form's payload shape (apps/web/provider-join):
// payload built field-by-field; message lines mirror the form's.
function providerJoinBody(extra = {}) {
  return {
    type: 'PROVIDER_APPLICATION',
    name: 'Join Drill Provider',
    phone: '6045550142', // 604: assigned NANP area code — passes the phone gate
    email: 'join-drill@test.local',
    source: 'network-site-provider-join',
    message: [
      'Main trade: Refrigeration',
      'Business: Drill Refrigeration LLC',
      'Service area: Fort Lauderdale',
      'Experience: 5-10 years',
    ].join('\n'),
    ...extra,
  };
}

async function seed() {
  await prisma.company.upsert({
    where: { id: PLATFORM_COMPANY_ID }, update: {},
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'shield-pj-platform', type: 'PLATFORM_OWNER', isPlatformOwner: true },
  });
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

  check('health 200', (await api('/health')).status, 200);
  check('connections start empty', await connectionCount(), 0);

  // ---- Legitimate provider-join submission (empty honeypot) ----
  const outbox0 = await outboxCount();
  const legit = await api('/connections', { method: 'POST', body: providerJoinBody() });
  check('provider-join legit → 201', legit.status, 201);
  checkTrue('provider-join legit returns a TS- reference', /^TS-/.test(legit.json?.data?.reference || ''));
  const saved = await prisma.connection.findFirst({ where: { reference: legit.json.data.reference } });
  checkTrue('provider-join legit persisted', saved);
  check('provider-join legit type', saved?.type, 'PROVIDER_APPLICATION');
  check('provider-join legit source', saved?.source, 'network-site-provider-join');
  await settle();
  checkTrue('provider-join legit queued the staff alert', (await outboxCount()) > outbox0);
  check('connections after legit', await connectionCount(), 1);

  // ---- Bot provider-join submission (honeypot filled) ----
  await settle(); // let the legit submission's outbox write-through land first
  const outboxBefore = await outboxCount();
  const bot = await api('/connections', {
    method: 'POST',
    body: providerJoinBody({ name: 'Xviadaa', email: 'bot@test.local', companyWebsite: 'http://spam.example/cheap' }),
  });
  check('provider-join honeypot → 201 (success-shaped)', bot.status, 201);
  checkTrue('provider-join honeypot returns a TS- reference', /^TS-/.test(bot.json?.data?.reference || ''));
  check('provider-join honeypot persisted NOTHING', await connectionCount(), 1);
  checkTrue('provider-join honeypot reference is not in the database',
    !(await prisma.connection.findFirst({ where: { reference: bot.json.data.reference } })));
  await settle();
  check('provider-join honeypot queued NO notification', await outboxCount(), outboxBefore);

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(async () => {
    if (server) server.kill('SIGTERM');
    await prisma.$disconnect();
  });
