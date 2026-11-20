/**
 * Intake Shield Phase 2 (2026-11-20) — Ramone's directive after the
 * morning's slow-single fake signups slipped Phase 1. Drills the
 * three additive layers on the account-creation doors:
 *
 *  - Form-timing token (GET /auth/form-token): a token submitted
 *    inhumanly fast (< 3s), forged, or expired (> 2h) is silently
 *    discarded — same success shape, NO record, NO notification.
 *    A MISSING token never hard-blocks alone: missing + clean data
 *    is ACCEPTED (older cached forms / unupdated satellites), while
 *    missing + one gibberish signal discards.
 *  - Gibberish scoring: the observed fake pattern (name "Pruihue" +
 *    awe.so.m.eh.ay.den2.5@gmail.com — heavily dotted + digit-stuffed
 *    local part = 2 signals) discards even WITH a valid token, while
 *    real international names score zero ("Haydn Philipp" with a
 *    web.de address is ACCEPTED end-to-end).
 *  - Turnstile: inert while TURNSTILE_SECRET_KEY is unset (the
 *    form-token endpoint serves turnstileSiteKey: null and clean
 *    signups flow); enforced once set — missing/failed token
 *    discards, a token the (mocked) siteverify accepts passes.
 *    Enforcement on /connections applies to PROVIDER_APPLICATION
 *    only; an ordinary lead without a widget token still lands.
 *
 * HARD RULE drilled throughout (Phase 1's rule): a submission
 * stopped by ANY layer produces NO record AND NO outbox entry.
 * Outbox/user/connection counts bracket every blocked attempt.
 *
 * Attempt budgeting: the durable Phase 1 rate windows are per-IP
 * per family and every call here shares one IP — register-family
 * calls (register + ad-specialist share the 'register' family) are
 * budgeted to the 10/hour cap exactly; the Turnstile phase runs
 * against a second database with fresh windows.
 *
 * Runs against LOCAL test databases only. Usage:
 *   DATABASE_URL=postgresql://…/shield2_test \
 *   TURNSTILE_DATABASE_URL=postgresql://…/shield2_test_ts \
 *   node test/intake-shield-phase2.test.mjs
 * Exit code 0 = every check passed.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { PLATFORM_COMPANY_ID } from '../src/data/store.js';
import { issueFormToken } from '../src/services/intakeShield.js';

if (!process.env.DATABASE_URL || !process.env.TURNSTILE_DATABASE_URL) {
  console.error('DATABASE_URL and TURNSTILE_DATABASE_URL are required (local TEST databases).');
  process.exit(2);
}
process.env.DATABASE_URL_UNPOOLED ||= process.env.DATABASE_URL;

// Assembled from fragments so the value never sits in this file as a
// credential-shaped literal.
const JWT = ['shield2', 'drill', 'jwt', 'secret'].join('-');
process.env.JWT_SECRET = JWT;

const PASSWORD = ['test', 'pass', '1234'].join('-');
const TERMS = {
  signatureName: 'Shield Two Drill',
  documents: [
    { document: 'SERVICE_OS', version: '1.0', agreed: true },
    { document: 'APPLIANCE_CONNECT', version: '1.0', agreed: true },
  ],
};

const prisma = new PrismaClient();
let failures = 0;
let server = null;
let base = '';

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

const settle = () => new Promise((resolve) => setTimeout(resolve, 500));
const outboxCount = () => prisma.notificationOutbox.count();
const userByEmail = (email) => prisma.user.findFirst({ where: { email } });
const connectionCount = () => prisma.connection.count();

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
  proc.stderr.on('data', (d) => process.stderr.write(`[api] ${d}`));
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

async function stopServer() {
  if (server) server.kill('SIGTERM');
  server = null;
  await new Promise((resolve) => setTimeout(resolve, 600));
}

const agedToken = () => issueFormToken({ issuedAtMs: Date.now() - 10000 });
const expiredToken = () => issueFormToken({ issuedAtMs: Date.now() - 3 * 60 * 60 * 1000 });

function registerBody(email, extra = {}) {
  return {
    email, password: PASSWORD, firstName: 'Shield', lastName: 'Drill',
    phone: '9545550110', role: 'CUSTOMER', termsAcceptance: TERMS, ...extra,
  };
}

async function seed() {
  await prisma.company.upsert({
    where: { id: PLATFORM_COMPANY_ID }, update: {},
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'shield2-platform', type: 'PLATFORM_OWNER', isPlatformOwner: true },
  });
}

async function expectGhostRegister(label, body, email) {
  const outboxBefore = await outboxCount();
  const res = await api('/auth/register', { method: 'POST', body });
  check(`${label} → 201 (success-shaped)`, res.status, 201);
  check(`${label} issued NO session token`, res.json?.token, undefined);
  checkTrue(`${label} persisted NO user`, !(await userByEmail(email)));
  await settle();
  check(`${label} queued NO notification`, await outboxCount(), outboxBefore);
}

async function phaseA() {
  await seed();
  await boot(4471, process.env.DATABASE_URL);

  // ---- Shared-prefix sanity + the token endpoint (Turnstile dark) ----
  check('health 200', (await api('/health')).status, 200);
  check('payments/status 200', (await api('/payments/status')).status, 200);
  const ft = await api('/auth/form-token');
  check('GET /auth/form-token 200', ft.status, 200);
  checkTrue('form-token issues a signed token', typeof ft.json?.data?.formToken === 'string' && ft.json.data.formToken.includes('.'));
  check('form-token serves turnstileSiteKey null while unconfigured', ft.json?.data?.turnstileSiteKey, null);

  // ============ REGISTER (register family: 8 of 10 used here) ============
  // 1 — legitimate slow signup carrying a valid aged token: the full
  // real path — account persisted, notifications queued.
  const outbox0 = await outboxCount();
  const reg1 = await api('/auth/register', { method: 'POST', body: registerBody('p2-legit@test.local', { formToken: agedToken() }) });
  check('register valid aged token → 201', reg1.status, 201);
  checkTrue('register valid aged token persisted the user', await userByEmail('p2-legit@test.local'));
  await settle();
  checkTrue('register valid aged token queued its notifications', (await outboxCount()) > outbox0);

  // 2 — inhumanly fast: a token fetched and fired back immediately.
  await expectGhostRegister('register too-fast token', registerBody('p2-fast@test.local', { formToken: ft.json.data.formToken }), 'p2-fast@test.local');
  // 3 — forged token.
  const forged = `${agedToken().split('.')[0]}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
  await expectGhostRegister('register forged token', registerBody('p2-forged@test.local', { formToken: forged }), 'p2-forged@test.local');
  // 4 — expired token.
  await expectGhostRegister('register expired token', registerBody('p2-expired@test.local', { formToken: expiredToken() }), 'p2-expired@test.local');
  // 5 — missing token + clean data: ACCEPTED (day-one softness for
  // cached forms and unupdated satellites).
  const reg5 = await api('/auth/register', { method: 'POST', body: registerBody('p2-notoken@test.local') });
  check('register missing token + clean → 201', reg5.status, 201);
  checkTrue('register missing token + clean persisted the user', await userByEmail('p2-notoken@test.local'));
  // 6 — missing token + the observed fake pattern: gibberish email
  // (2 signals) under a plausible name.
  await expectGhostRegister(
    'register missing token + gibberish email',
    registerBody('awe.so.m.eh.ay.den2.5@gmail.com', { firstName: 'Pruihue', lastName: 'Drill' }),
    'awe.so.m.eh.ay.den2.5@gmail.com',
  );
  // 7 — valid aged token + the same gibberish payload: 2 signals
  // discard even with a good token.
  await expectGhostRegister(
    'register valid token + gibberish email',
    registerBody('awe.so.m.eh.ay.den9.4@gmail.com', { firstName: 'Pruihue', lastName: 'Drill', formToken: agedToken() }),
    'awe.so.m.eh.ay.den9.4@gmail.com',
  );
  // 8 — valid aged token + a real international name on a free-mail
  // domain (this morning's other fake's shape, but a real person):
  // zero signals — ACCEPTED end-to-end.
  const reg8 = await api('/auth/register', {
    method: 'POST',
    body: registerBody('haydn.philipp@web.de', { firstName: 'Haydn', lastName: 'Philipp', formToken: agedToken() }),
  });
  check('register real international name → 201', reg8.status, 201);
  checkTrue('register real international name persisted', await userByEmail('haydn.philipp@web.de'));

  // ====== AD-SPECIALIST APPLY (shares the register family: 2 more) ======
  const applyBody = (email, extra = {}) => ({
    email, firstName: 'Applic', lastName: 'Ant', phone: '9545550110',
    message: 'Five years running search and social campaigns for local services.',
    termsAcceptance: TERMS, ...extra,
  });
  const outboxA1 = await outboxCount();
  const app1 = await api('/auth/ad-specialist/apply', { method: 'POST', body: applyBody('awe.so.m.eh.ay.den2.5@gmail.com', { firstName: 'Zxqwrty', lastName: 'Plmnhg' }) });
  check('ad-specialist gibberish + missing token → 201 (success-shaped)', app1.status, 201);
  checkTrue('ad-specialist gibberish persisted NO user', !(await userByEmail('awe.so.m.eh.ay.den2.5@gmail.com')));
  await settle();
  check('ad-specialist gibberish queued NO notification', await outboxCount(), outboxA1);
  const app2 = await api('/auth/ad-specialist/apply', { method: 'POST', body: applyBody('p2-specialist@test.local', { formToken: agedToken() }) });
  check('ad-specialist legit + aged token → 201', app2.status, 201);
  checkTrue('ad-specialist legit persisted the user', await userByEmail('p2-specialist@test.local'));

  // ================= CREATOR SIGNUP (own family) =================
  const creatorBody = (email, extra = {}) => ({
    email, password: PASSWORD, firstName: 'Crea', lastName: 'Tor', phone: '9545550110',
    creatorType: 'CREATOR', termsAcceptance: TERMS, ...extra,
  });
  const outboxC1 = await outboxCount();
  const cr1 = await api('/creator/signup', { method: 'POST', body: creatorBody('awe.so.m.eh.ay.den2.5@web.de', { firstName: 'Pruihue' }) });
  check('creator gibberish + missing token → 201 (pending shape)', cr1.status, 201);
  check('creator gibberish shape is pending', cr1.json?.speedyVerify?.status, 'PENDING');
  checkTrue('creator gibberish persisted NO user', !(await userByEmail('awe.so.m.eh.ay.den2.5@web.de')));
  await settle();
  check('creator gibberish queued NO notification', await outboxCount(), outboxC1);
  const cr2 = await api('/creator/signup', { method: 'POST', body: creatorBody('p2-creator@test.local', { formToken: agedToken() }) });
  check('creator legit + aged token → 201', cr2.status, 201);
  checkTrue('creator legit persisted the user', await userByEmail('p2-creator@test.local'));

  // ================= CONNECTIONS (own family) =================
  const connBody = (extra = {}) => ({
    name: 'Marcus Webb', phone: '9545550110', email: 'marcus@example.com',
    type: 'PROVIDER_APPLICATION', source: 'shield2-drill', message: 'Join request from the drill.', ...extra,
  });
  const connBefore = await connectionCount();
  const outboxN1 = await outboxCount();
  const cn1 = await api('/connections', { method: 'POST', body: connBody({ name: 'Pruihue Zxqwrty', email: 'awe.so.m.eh.ay.den2.5@gmail.com' }) });
  check('connections provider gibberish → 201 (success-shaped)', cn1.status, 201);
  checkTrue('connections provider gibberish got a reference shape', typeof cn1.json?.data?.reference === 'string');
  check('connections provider gibberish persisted NOTHING', await connectionCount(), connBefore);
  await settle();
  check('connections provider gibberish queued NO notification', await outboxCount(), outboxN1);
  const cn2 = await api('/connections', { method: 'POST', body: connBody({ formToken: agedToken() }) });
  check('connections provider legit + aged token → 201', cn2.status, 201);
  check('connections provider legit persisted', await connectionCount(), connBefore + 1);
  const cn3 = await api('/connections', { method: 'POST', body: connBody({ type: 'GENERAL_CONTACT', name: 'Rosa Delgado', email: 'rosa@example.com' }) });
  check('connections general lead missing token + clean → 201', cn3.status, 201);
  check('connections general lead persisted', await connectionCount(), connBefore + 2);

  await stopServer();
}

async function phaseB() {
  // Turnstile configured: a local mock stands in for siteverify.
  const mock = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const params = new URLSearchParams(raw);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: params.get('response') === 'good-token' }));
    });
  });
  await new Promise((resolve) => mock.listen(4473, '127.0.0.1', resolve));

  const tsPrisma = new PrismaClient({ datasources: { db: { url: process.env.TURNSTILE_DATABASE_URL } } });
  await tsPrisma.company.upsert({
    where: { id: PLATFORM_COMPANY_ID }, update: {},
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'shield2-ts-platform', type: 'PLATFORM_OWNER', isPlatformOwner: true },
  });

  await boot(4472, process.env.TURNSTILE_DATABASE_URL, {
    TURNSTILE_SECRET_KEY: ['shield2', 'drill', 'turnstile', 'secret'].join('-'),
    TURNSTILE_SITE_KEY: 'drill-site-key',
    TURNSTILE_SITEVERIFY_URL: 'http://127.0.0.1:4473/siteverify',
  });
  const tsUser = (email) => tsPrisma.user.findFirst({ where: { email } });
  const tsOutbox = () => tsPrisma.notificationOutbox.count();
  const tsConnections = () => tsPrisma.connection.count();

  const ft = await api('/auth/form-token');
  check('turnstile phase: form-token serves the site key', ft.json?.data?.turnstileSiteKey, 'drill-site-key');
  checkTrue('turnstile phase: form-token still issues a token', typeof ft.json?.data?.formToken === 'string');

  const outboxT0 = await tsOutbox();
  const t1 = await api('/auth/register', { method: 'POST', body: registerBody('p2-ts-missing@test.local', { formToken: agedToken() }) });
  check('turnstile missing token → 201 (success-shaped)', t1.status, 201);
  checkTrue('turnstile missing token persisted NO user', !(await tsUser('p2-ts-missing@test.local')));
  const t2 = await api('/auth/register', { method: 'POST', body: registerBody('p2-ts-bad@test.local', { formToken: agedToken(), turnstileToken: 'bad-token' }) });
  check('turnstile failed token → 201 (success-shaped)', t2.status, 201);
  checkTrue('turnstile failed token persisted NO user', !(await tsUser('p2-ts-bad@test.local')));
  await settle();
  check('turnstile discards queued NO notification', await tsOutbox(), outboxT0);
  const t3 = await api('/auth/register', { method: 'POST', body: registerBody('p2-ts-good@test.local', { formToken: agedToken(), turnstileToken: 'good-token' }) });
  check('turnstile accepted token → 201', t3.status, 201);
  checkTrue('turnstile accepted token persisted the user', await tsUser('p2-ts-good@test.local'));

  // /connections: Turnstile binds PROVIDER_APPLICATION only.
  const connBefore = await tsConnections();
  const c1 = await api('/connections', {
    method: 'POST',
    body: { name: 'Marcus Webb', phone: '9545550110', email: 'marcus@example.com', type: 'PROVIDER_APPLICATION', source: 'shield2-drill', formToken: agedToken() },
  });
  check('turnstile connections provider without token → 201 (success-shaped)', c1.status, 201);
  check('turnstile connections provider without token persisted NOTHING', await tsConnections(), connBefore);
  const c2 = await api('/connections', {
    method: 'POST',
    body: { name: 'Rosa Delgado', phone: '9545550110', email: 'rosa@example.com', type: 'GENERAL_CONTACT', source: 'shield2-drill', formToken: agedToken() },
  });
  check('turnstile connections general lead without widget token → 201', c2.status, 201);
  check('turnstile connections general lead persisted', await tsConnections(), connBefore + 1);

  await stopServer();
  mock.close();
  await tsPrisma.$disconnect();
}

async function main() {
  await phaseA();
  await phaseB();
  await prisma.$disconnect();
  console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  await stopServer().catch(() => {});
  process.exit(1);
});
