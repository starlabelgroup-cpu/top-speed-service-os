/**
 * Approval-free customer signup (2026-11-21) — Ramone's directive:
 * customer-facing auth is a NORMAL signup + a NORMAL self-serve
 * reset + 2-step authentication (Layer 2, a code to the customer's
 * OWN email). NO office approval anywhere in the customer journey:
 * "Creating shouldn't need office approval or any customer app or
 * web portal" / "Only workstation platform need approval for
 * anything". Workstation gates (Speedy Verify covered roles) do
 * not move.
 *
 * What this drills, against a MOCK siteverify (TURNSTILE_SITEVERIFY_URL)
 * keyed by token value:
 *  - valid token            -> genuine CUSTOMER register: 201 with the
 *    Layer 2 challenge shape, NO speedyVerify block, NO session token;
 *    the account persists with verifyRequired=false. Completing the
 *    2-step code (DB-rewritten codeHash, the parity-suite pattern)
 *    mints the session — the whole customer journey, zero office.
 *  - invalid-input-secret / missing-input-secret (Cloudflare rejecting
 *    OUR stored secret — the 2026-11-20 key-entry failure) -> the
 *    genuine signup is NOT discarded: it persists exactly like the
 *    valid-token case, and the server logs the credential failure at
 *    error level with its distinct message.
 *  - invalid-input-response / timeout-or-duplicate (genuine token
 *    failures) -> still discarded: 201 ghost, NO record, NO outbox.
 *  - missing token (Turnstile configured) -> discarded, as before.
 *  - siteverify TRANSPORT failure (dead URL, second boot) -> fails
 *    open: the genuine signup persists.
 *  - Discard SHAPE parity: a discarded CUSTOMER submission answers
 *    with the customer shape (Layer 2 challenge envelope, NO
 *    speedyVerify block) — never the office-approval shape — and its
 *    challenge is a dead end (no record behind it: /auth/layer2/send
 *    answers the ordinary 401 LAYER2_CHALLENGE_INVALID). A discarded
 *    COVERED submission (ADVERTISER role, business accountType)
 *    still answers with the Speedy Verify pending shape, exactly
 *    like its genuine path.
 *
 * Runs against LOCAL test databases only. Usage:
 *   DATABASE_URL=<db A> TRANSPORT_DATABASE_URL=<db B> \
 *   node test/customer-signup-approval-free.test.mjs
 * Exit code 0 = every check passed.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { PLATFORM_COMPANY_ID } from '../src/data/store.js';
import { issueFormToken } from '../src/services/intakeShield.js';
import { hashPassword } from '../src/services/passwords.js';

if (!process.env.DATABASE_URL || !process.env.TRANSPORT_DATABASE_URL) {
  console.error('DATABASE_URL and TRANSPORT_DATABASE_URL are required (local TEST databases).');
  process.exit(2);
}
process.env.DATABASE_URL_UNPOOLED ||= process.env.DATABASE_URL;

// Assembled from fragments so no credential-shaped literal sits in
// this file (the phase-2 harness idiom).
const JWT = ['csf', 'drill', 'jwt', 'secret'].join('-');
process.env.JWT_SECRET = JWT;
const PASSWORD = ['test', 'pass', '1234'].join('-');
const TS_SECRET = ['csf', 'drill', 'turnstile', 'secret'].join('-');
const TERMS = {
  signatureName: 'Approval Free Drill',
  documents: [
    { document: 'SERVICE_OS', version: '1.0', agreed: true },
    { document: 'APPLIANCE_CONNECT', version: '1.0', agreed: true },
  ],
};

const prisma = new PrismaClient();
const transportPrisma = new PrismaClient({ datasources: { db: { url: process.env.TRANSPORT_DATABASE_URL } } });
let failures = 0;
let server = null;
let base = '';
let stderrBuf = '';

function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}
function checkTrue(label, value) { check(label, Boolean(value), true); }

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 400));
const agedToken = () => issueFormToken({ issuedAtMs: Date.now() - 10000 });

function startServer(port, databaseUrl, extraEnv = {}) {
  const proc = spawn('node', ['src/server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      ...process.env,
      PORT: String(port),
JWT_SECRET: JWT,
DATABASE_URL: databaseUrl,
DATABASE_URL_UNPOOLED: databaseUrl,
OPENAI_API_KEY: '',
      OPENAI_API_KEY_V2: '',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', (d) => { stderrBuf += String(d); });
  proc.stdout.on('data', (d) => { stderrBuf += String(d); });
  return proc;
}

async function waitForServer() {
  for (let i = 0; i < 90; i += 1) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('server did not come up');
}

async function boot(port, databaseUrl, extraEnv) {
  base = `http://127.0.0.1:${port}/api/v1`;
  server = startServer(port, databaseUrl, extraEnv);
  await waitForServer();
}

function regBody(email, firstName, lastName, extra = {}) {
  return {
    email,
    password: PASSWORD,
    firstName,
    lastName,
    termsAcceptance: { ...TERMS, signatureName: `${firstName} ${lastName}` },
    formToken: agedToken(),
    ...extra,
  };
}

// Mock siteverify: the verdict is keyed by the submitted token value.
function startMock(port) {
  const mock = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const token = new URLSearchParams(raw).get('response') || '';
      let payload;
      if (token === 'tok-valid') payload = { success: true };
      else if (token === 'tok-bad-secret') payload = { success: false, 'error-codes': ['invalid-input-secret'] };
      else if (token === 'tok-missing-secret') payload = { success: false, 'error-codes': ['missing-input-secret'] };
      else if (token === 'tok-duplicate') payload = { success: false, 'error-codes': ['timeout-or-duplicate'] };
      else payload = { success: false, 'error-codes': ['invalid-input-response'] };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  return new Promise((resolve) => mock.listen(port, '127.0.0.1', () => resolve(mock)));
}

async function seedCompany(client, slug) {
  await client.company.upsert({
    where: { id: PLATFORM_COMPANY_ID }, update: {},
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug, type: 'PLATFORM_OWNER', isPlatformOwner: true },
  });
}

try {
  const mock = await startMock(4483);
  await seedCompany(prisma, 'csf-platform');
  await seedCompany(transportPrisma, 'csf-transport-platform');

  // ----------------------------------------------------------------
  // Boot A — mock siteverify live.
  // ----------------------------------------------------------------
  await boot(4481, process.env.DATABASE_URL, {
    TURNSTILE_SECRET_KEY: TS_SECRET,
    TURNSTILE_SITE_KEY: 'drill-site-key',
    TURNSTILE_SITEVERIFY_URL: 'http://127.0.0.1:4483/siteverify',
  });

  const ft = await api('/auth/form-token');
  check('form-token serves the configured site key', ft.json?.data?.turnstileSiteKey, 'drill-site-key');

  // A1 — valid token: the genuine customer journey.
  const a1 = await api('/auth/register', { method: 'POST', body: regBody('carla.mendez@test.local', 'Carla', 'Mendez', { turnstileToken: 'tok-valid' }) });
  check('A1 valid-token customer register status', a1.status, 201);
  check('A1 layer2Required', a1.json?.layer2Required, true);
  check('A1 challenge code', a1.json?.code, 'LAYER2_REQUIRED');
  checkTrue('A1 challenge is a string', typeof a1.json?.challenge === 'string' && a1.json.challenge.length > 20);
  check('A1 NO speedyVerify block', a1.json?.speedyVerify, undefined);
  check('A1 NO session token yet', a1.json?.token, undefined);
  await settle();
  const a1User = await prisma.user.findFirst({ where: { email: 'carla.mendez@test.local' } });
  checkTrue('A1 account persisted', a1User);
  check('A1 persisted verifyRequired', a1User?.verifyRequired, false);
  check('A1 persisted layer2Required', a1User?.layer2Required, true);

  // A2 — completing the 2-step code mints the session (no office).
  const cid = JSON.parse(Buffer.from(a1.json.challenge.split('.')[1], 'base64url').toString()).cid;
  await prisma.loginChallenge.update({ where: { id: cid }, data: { codeHash: await hashPassword('246810'), channel: 'EMAIL' } });
  const a2 = await api('/auth/layer2/verify', { method: 'POST', body: { challenge: a1.json.challenge, code: '246810' } });
  check('A2 layer2 verify status', a2.status, 200);
  checkTrue('A2 session token minted by the 2-step code alone', typeof a2.json?.token === 'string' && a2.json.token.length > 20);

  // A3 — Cloudflare rejects OUR secret: the genuine signup must land.
  const outboxBefore = await prisma.notificationOutbox.count();
  const a3 = await api('/auth/register', { method: 'POST', body: regBody('david.osei@test.local', 'David', 'Osei', { turnstileToken: 'tok-bad-secret' }) });
  check('A3 bad-secret customer register status', a3.status, 201);
  check('A3 layer2Required (real path, not a ghost)', a3.json?.layer2Required, true);
  check('A3 NO speedyVerify block', a3.json?.speedyVerify, undefined);
  await settle();
  const a3User = await prisma.user.findFirst({ where: { email: 'david.osei@test.local' } });
  checkTrue('A3 account PERSISTED despite the broken server secret', a3User);
  check('A3 persisted verifyRequired', a3User?.verifyRequired, false);
  checkTrue('A3 credential failure logged distinctly at error level', stderrBuf.includes('turnstile siteverify rejected the server secret'));

  // A4 — missing-input-secret: same fail-soft.
  const a4 = await api('/auth/register', { method: 'POST', body: regBody('priya.nair@test.local', 'Priya', 'Nair', { turnstileToken: 'tok-missing-secret' }) });
  check('A4 missing-secret register status', a4.status, 201);
  await settle();
  checkTrue('A4 account PERSISTED', await prisma.user.findFirst({ where: { email: 'priya.nair@test.local' } }));
  checkTrue('A3/A4 real registrations queued their notifications', (await prisma.notificationOutbox.count()) > outboxBefore);

  // A5 — genuine token failure (invalid-input-response): discarded.
  const outboxA5 = await prisma.notificationOutbox.count();
  const a5 = await api('/auth/register', { method: 'POST', body: regBody('tom.becker@test.local', 'Tom', 'Becker', { turnstileToken: 'tok-bad-response' }) });
  check('A5 bad-token register status (ghost)', a5.status, 201);
  check('A5 ghost wears the CUSTOMER shape (layer2Required)', a5.json?.layer2Required, true);
  check('A5 ghost code', a5.json?.code, 'LAYER2_REQUIRED');
  checkTrue('A5 ghost carries a challenge string', typeof a5.json?.challenge === 'string');
  check('A5 ghost has NO speedyVerify block', a5.json?.speedyVerify, undefined);
  check('A5 ghost has NO session token', a5.json?.token, undefined);
  await settle();
  check('A5 NO account persisted', await prisma.user.findFirst({ where: { email: 'tom.becker@test.local' } }), null);
  check('A5 NO outbox entry queued', await prisma.notificationOutbox.count(), outboxA5);

  // A6 — timeout-or-duplicate: discarded the same way.
  const a6 = await api('/auth/register', { method: 'POST', body: regBody('ana.ruiz@test.local', 'Ana', 'Ruiz', { turnstileToken: 'tok-duplicate' }) });
  check('A6 duplicate-token register status (ghost)', a6.status, 201);
  check('A6 ghost NO speedyVerify block', a6.json?.speedyVerify, undefined);
  await settle();
  check('A6 NO account persisted', await prisma.user.findFirst({ where: { email: 'ana.ruiz@test.local' } }), null);

  // A7 — missing token while Turnstile is configured: discarded
  // (the semantics this build deliberately leaves unchanged).
  const a7 = await api('/auth/register', { method: 'POST', body: regBody('sam.whitfield@test.local', 'Sam', 'Whitfield') });
  check('A7 missing-token register status (ghost)', a7.status, 201);
  check('A7 ghost NO speedyVerify block', a7.json?.speedyVerify, undefined);
  await settle();
  check('A7 NO account persisted', await prisma.user.findFirst({ where: { email: 'sam.whitfield@test.local' } }), null);

  // A8 — honeypot customer: discarded, customer shape.
  const a8 = await api('/auth/register', { method: 'POST', body: regBody('nora.lindqvist@test.local', 'Nora', 'Lindqvist', { turnstileToken: 'tok-valid', companyWebsite: 'http://spam.example.com' }) });
  check('A8 honeypot register status (ghost)', a8.status, 201);
  check('A8 ghost layer2Required (customer shape)', a8.json?.layer2Required, true);
  check('A8 ghost NO speedyVerify block', a8.json?.speedyVerify, undefined);
  await settle();
  check('A8 NO account persisted', await prisma.user.findFirst({ where: { email: 'nora.lindqvist@test.local' } }), null);

  // A9 — the ghost challenge is a dead end with the ordinary expiry.
  const a9 = await api('/auth/layer2/send', { method: 'POST', body: { challenge: a5.json.challenge, channel: 'EMAIL' } });
  check('A9 ghost challenge send status', a9.status, 401);
  check('A9 ghost challenge error code', a9.json?.code, 'LAYER2_CHALLENGE_INVALID');

  // A10 — covered kind (ADVERTISER role) discard: office shape kept.
  const a10 = await api('/auth/register', { method: 'POST', body: regBody('greg.holt@test.local', 'Greg', 'Holt', { role: 'ADVERTISER', companyWebsite: 'http://spam.example.com' }) });
  check('A10 advertiser honeypot status (ghost)', a10.status, 201);
  check('A10 ghost KEEPS the Speedy Verify pending shape', a10.json?.speedyVerify?.status, 'PENDING');
  check('A10 ghost has NO layer2 challenge', a10.json?.layer2Required, undefined);
  await settle();
  check('A10 NO account persisted', await prisma.user.findFirst({ where: { email: 'greg.holt@test.local' } }), null);

  // A11 — covered kind (business accountType) discard: office shape.
  const a11 = await api('/auth/register', { method: 'POST', body: regBody('maria.santos@test.local', 'Maria', 'Santos', { accountType: 'business', companyWebsite: 'http://spam.example.com' }) });
  check('A11 business honeypot status (ghost)', a11.status, 201);
  check('A11 ghost KEEPS the Speedy Verify pending shape', a11.json?.speedyVerify?.status, 'PENDING');
  await settle();
  check('A11 NO account persisted', await prisma.user.findFirst({ where: { email: 'maria.santos@test.local' } }), null);

  server.kill();
  await settle();

  // ----------------------------------------------------------------
  // Boot B — siteverify unreachable: transport failure fails open.
  // ----------------------------------------------------------------
  await boot(4482, process.env.TRANSPORT_DATABASE_URL, {
    TURNSTILE_SECRET_KEY: TS_SECRET,
    TURNSTILE_SITE_KEY: 'drill-site-key',
    TURNSTILE_SITEVERIFY_URL: 'http://127.0.0.1:9/siteverify',
  });
  const b1 = await api('/auth/register', { method: 'POST', body: regBody('owen.clark@test.local', 'Owen', 'Clark', { turnstileToken: 'tok-anything' }) });
  check('B1 transport-failure register status', b1.status, 201);
  check('B1 layer2Required (real path)', b1.json?.layer2Required, true);
  check('B1 NO speedyVerify block', b1.json?.speedyVerify, undefined);
  await settle();
  checkTrue('B1 account PERSISTED through the transport failure', await transportPrisma.user.findFirst({ where: { email: 'owen.clark@test.local' } }));

  server.kill();
  mock.close();
} catch (error) {
  failures += 1;
  console.error('DRILL ERROR', error);
} finally {
  if (server) server.kill();
  await prisma.$disconnect();
  await transportPrisma.$disconnect();
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
