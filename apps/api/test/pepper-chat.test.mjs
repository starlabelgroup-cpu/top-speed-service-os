/**
 * Pepper Chat drills (2026-11-18).
 *
 * Ramone: "create a pepper chat bar for me and all workstations
 * for new employees with account sign up." This harness exercises
 * the staff chat behind the bar (POST /api/v1/pepper/chat in
 * routes/pepperConsole.js + services/pepperChat.js) end to end:
 *  - the staff gate: anonymous 401, customer 403, staff 200;
 *  - grounded knowledge answers with the AI provider absent
 *    (answeredBy 'knowledge-pack', honestly labeled);
 *  - the AI path against a stub Responses server (answeredBy
 *    'ai'), and the AI-DOWN fallback: provider configured but
 *    unreachable still answers from the knowledge pack;
 *  - a live-status question answered from the REAL
 *    buildPepperStatus() payload (answeredBy 'status-board');
 *  - a problem report filing a REAL NEEDS_OWNER PepperReport
 *    under the staff member's name (asserted in the report log
 *    AND in the database), with the forwarded-to-Ramone line;
 *  - the web side, read from disk: the shared bar exists with the
 *    new-employee onboarding card markers, every staff console in
 *    the wire list loads it, and public pages (homepage, /book)
 *    do NOT.
 *
 * Run: DATABASE_URL=<local test db> node test/pepper-chat.test.mjs
 */
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/services/passwords.js';
import { PLATFORM_COMPANY_ID } from '../src/data/store.js';
import {
  messageAsksStatus,
  messageReportsProblem,
  searchPepperKnowledge,
} from '../src/services/pepperChat.js';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required (point it at a local TEST database).');
  process.exit(2);
}
if (!process.env.DATABASE_URL_UNPOOLED) process.env.DATABASE_URL_UNPOOLED = process.env.DATABASE_URL;

const PORT_A = Number(process.env.TEST_PORT || 4491);
const PORT_B = PORT_A + 1;
const PORT_C = PORT_A + 2;
const STUB_PORT = PORT_A + 3;
const JWT_SECRET = 'pepper-chat-drill-secret';
const PASSWORD = 'test-pass-1234';

const IDS = {
  staff: '50000000-0000-4000-8000-0000000000e1',
  customer: '50000000-0000-4000-8000-0000000000e3',
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

function mintToken(userId, email, roles) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: userId, companyId: PLATFORM_COMPANY_ID, email, roles,
    exp: Math.floor(Date.now() / 1000) + 3600,
  })).toString('base64url');
  const signature = createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

async function login(base, email) {
  const { status, json } = await api(base, '/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  if (status !== 200 || !json?.token) throw new Error(`login failed for ${email}: ${status} ${JSON.stringify(json)}`);
  return json.token;
}

function spawnServer(port, extraEnv) {
  const env = { ...process.env, PORT: String(port), JWT_SECRET };
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
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
    { id: IDS.staff, email: 'chat-staff@test.local', roles: ['DISPATCHER'] },
    { id: IDS.customer, email: 'chat-customer@test.local', roles: ['CUSTOMER'] },
  ];
  for (const u of users) {
    await prisma.user.upsert({
      where: { id: u.id },
      update: { passwordHash },
      create: { id: u.id, companyId: PLATFORM_COMPANY_ID, email: u.email, passwordHash, phone: '9545550200', roles: u.roles, active: true },
    });
  }
}

async function cleanupDb() {
  try {
    await prisma.pepperReport.deleteMany({ where: { createdByUserId: { in: Object.values(IDS) } } });
    await prisma.user.deleteMany({ where: { id: { in: Object.values(IDS) } } });
  } catch (error) {
    console.error('cleanup warning:', error.message);
  }
}

const NO_AI_ENV = {
  OPENAI_API_KEY: undefined,
  OPENAI_API_KEY_V2: undefined,
  OPENAI_API_BASE: undefined,
};

async function main() {
  // ── Phase A: database mode, AI provider absent ───────────────
  await cleanupDb();
  await seed();
  const baseA = `http://127.0.0.1:${PORT_A}/api/v1`;
  const serverA = spawnServer(PORT_A, {
    DATABASE_URL: process.env.DATABASE_URL,
    DATABASE_URL_UNPOOLED: process.env.DATABASE_URL_UNPOOLED,
    ...NO_AI_ENV,
  });
  await waitForServer(baseA);

  check('chat unauthenticated 401', (await api(baseA, '/pepper/chat', { method: 'POST', body: { message: 'hi' } })).status, 401);

  const staff = await login(baseA, 'chat-staff@test.local');
  const customer = await login(baseA, 'chat-customer@test.local');

  check('customer refused chat (403)', (await api(baseA, '/pepper/chat', { token: customer, method: 'POST', body: { message: 'hi' } })).status, 403);
  check('empty message 400', (await api(baseA, '/pepper/chat', { token: staff, method: 'POST', body: { message: ' ' } })).status, 400);

  // Knowledge answer — AI absent, fallback answers and says so.
  const pricing = await api(baseA, '/pepper/chat', { token: staff, method: 'POST', body: { message: 'How much is the diagnostic fee?' } });
  check('staff knowledge chat 200', pricing.status, 200);
  check('knowledge answer labeled knowledge-pack', pricing.json.data.answeredBy, 'knowledge-pack');
  checkTrue('pricing answer carries the $99 diagnostic', pricing.json.data.reply.includes('$99'));
  checkTrue('pricing answer carries the $210 labor', pricing.json.data.reply.includes('$210'));
  check('chat status reports AI unconfigured', pricing.json.data.chat.configured, false);

  // Onboarding answer.
  const onboard = await api(baseA, '/pepper/chat', { token: staff, method: 'POST', body: { message: 'How do accounts work here for a new employee?' } });
  check('onboarding chat 200', onboard.status, 200);
  checkTrue('onboarding names Work Time Access', onboard.json.data.reply.includes('Work Time Access'));
  checkTrue('onboarding names Ramone as issuer', onboard.json.data.reply.includes('Ramone Williams'));
  checkTrue('onboarding names Speedy Verify step', onboard.json.data.reply.includes('Speedy Verify'));
  checkTrue('onboarding names the Training Academy', onboard.json.data.reply.includes('Training Academy'));

  // Console-map answer (from systemMap.js, not a duplicate).
  const where = await api(baseA, '/pepper/chat', { token: staff, method: 'POST', body: { message: 'Where is the setter exception queue?' } });
  check('console chat 200', where.status, 200);
  checkTrue('console answer gives the location', where.json.data.reply.includes('/dispatch-dashboard'));

  // Live status — composed from the real payload.
  const statusChat = await api(baseA, '/pepper/chat', { token: staff, method: 'POST', body: { message: 'What is the system status?' } });
  check('status chat 200', statusChat.status, 200);
  check('status answer labeled status-board', statusChat.json.data.answeredBy, 'status-board');
  checkTrue('status reply has the board header', statusChat.json.data.reply.includes('live board'));
  checkTrue('status reply reflects the real payload (Stripe unconfigured in drills)', statusChat.json.data.reply.includes('NOT configured'));
  checkTrue('status payload rides along', statusChat.json.data.status.sections.payments.available === true);
  check('status payload payments configured matches drill env', statusChat.json.data.status.sections.payments.configured, false);

  // Problem report — files a real NEEDS_OWNER row.
  const problem = await api(baseA, '/pepper/chat', {
    token: staff, method: 'POST',
    body: { message: 'Report a problem: the booking page is down for customers', surface: '/book-os' },
  });
  check('problem chat 200', problem.status, 200);
  check('problem answer labeled escalation', problem.json.data.answeredBy, 'escalation');
  check('problem report category', problem.json.data.report.category, 'NEEDS_OWNER');
  checkTrue('problem reply carries the report id', problem.json.data.reply.includes(problem.json.data.report.id));
  checkTrue('problem reply names the forward to Ramone', problem.json.data.reply.includes('forwarded to Ramone Williams'));

  const log = await api(baseA, '/pepper-console/reports', { token: staff });
  check('report log has the chat report first', log.json.data[0].id, problem.json.data.report.id);
  check('report log category', log.json.data[0].category, 'NEEDS_OWNER');
  checkTrue('report log title carries the problem', log.json.data[0].title.includes('booking page is down'));
  check('report log filer email', log.json.data[0].createdBy.email, 'chat-staff@test.local');

  const dbRow = await prisma.pepperReport.findUnique({ where: { id: problem.json.data.report.id } });
  checkTrue('report row exists in the database', Boolean(dbRow));
  check('report row filed under the staff user', dbRow.createdByUserId, IDS.staff);
  checkTrue('report row body carries the surface', dbRow.body.includes('/book-os'));

  // Public routes unaffected by the new route.
  check('public payments/status 200', (await api(baseA, '/payments/status')).status, 200);

  serverA.kill();
  await new Promise((r) => setTimeout(r, 500));

  // ── Phase B: memory mode + stub AI provider ──────────────────
  const stub = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'resp_stub', model: 'stub-model-1', output_text: 'Stub Pepper answer for staff.' }));
    });
  });
  await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r));

  const baseB = `http://127.0.0.1:${PORT_B}/api/v1`;
  const serverB = spawnServer(PORT_B, {
    DATABASE_URL: undefined,
    DATABASE_URL_UNPOOLED: undefined,
    OPENAI_API_KEY: undefined,
    OPENAI_API_KEY_V2: 'stub-key',
    OPENAI_API_BASE: `http://127.0.0.1:${STUB_PORT}`,
  });
  await waitForServer(baseB);
  const staffJwt = mintToken(IDS.staff, 'chat-staff@test.local', ['DISPATCHER']);
  const customerJwt = mintToken(IDS.customer, 'chat-customer@test.local', ['CUSTOMER']);

  check('memory: chat unauthenticated 401', (await api(baseB, '/pepper/chat', { method: 'POST', body: { message: 'hi' } })).status, 401);
  check('memory: customer refused (403)', (await api(baseB, '/pepper/chat', { token: customerJwt, method: 'POST', body: { message: 'hi' } })).status, 403);

  const aiAnswer = await api(baseB, '/pepper/chat', { token: staffJwt, method: 'POST', body: { message: 'What are the pricing rules?' } });
  check('memory: AI chat 200', aiAnswer.status, 200);
  check('memory: AI answer labeled ai', aiAnswer.json.data.answeredBy, 'ai');
  check('memory: AI answer is the stub reply', aiAnswer.json.data.reply, 'Stub Pepper answer for staff.');
  check('memory: AI model reported', aiAnswer.json.data.model, 'stub-model-1');

  serverB.kill();
  await new Promise((r) => setTimeout(r, 500));

  // ── Phase C: AI configured but DOWN → knowledge fallback ─────
  const baseC = `http://127.0.0.1:${PORT_C}/api/v1`;
  const serverC = spawnServer(PORT_C, {
    DATABASE_URL: undefined,
    DATABASE_URL_UNPOOLED: undefined,
    OPENAI_API_KEY: undefined,
    OPENAI_API_KEY_V2: 'stub-key',
    OPENAI_API_BASE: `http://127.0.0.1:${STUB_PORT + 50}`, // nothing listens there
  });
  await waitForServer(baseC);
  const downAnswer = await api(baseC, '/pepper/chat', { token: staffJwt, method: 'POST', body: { message: 'How much is the diagnostic fee?' } });
  check('ai-down: chat still 200', downAnswer.status, 200);
  check('ai-down: fallback honestly labeled', downAnswer.json.data.answeredBy, 'knowledge-pack');
  checkTrue('ai-down: fallback answers from knowledge', downAnswer.json.data.reply.includes('$99'));
  serverC.kill();
  stub.close();

  // ── Phase D: unit + web files ────────────────────────────────
  checkTrue('unit: problem detector catches a breakage report', messageReportsProblem('The booking page is down for customers'));
  checkTrue('unit: problem detector catches a report request', messageReportsProblem('Report a problem: setters cannot sign in'));
  check('unit: problem detector ignores a how-to question', messageReportsProblem('How does booking work?'), false);
  checkTrue('unit: status detector catches a status question', messageAsksStatus('What is the system status?'));
  check('unit: status detector ignores a console question', messageAsksStatus('Where is the CRM?'), false);
  const kb = searchPepperKnowledge('dryer vent cleaning price', 4);
  checkTrue('unit: vent question matches the Cleanout Vents rule', kb.length > 0 && kb[0].entry.answer.includes('954-931-7997'));

  const webRoot = fileURLToPath(new URL('../../web/', import.meta.url));
  const widget = readFileSync(`${webRoot}shared/pepper-chat.js`, 'utf8');
  checkTrue('web: widget posts to /pepper/chat', widget.includes('/pepper/chat'));
  checkTrue('web: onboarding card marker class', widget.includes('pepper-chat-onboarding'));
  checkTrue('web: onboarding card heading', widget.includes('New employee?'));
  checkTrue('web: onboarding names Work Time Access', widget.includes('Work Time Access'));
  checkTrue('web: onboarding names Speedy Verify', widget.includes('Speedy Verify'));
  checkTrue('web: onboarding names Layer 2', widget.includes('Layer 2'));
  checkTrue('web: onboarding names Training Academy', widget.includes('Training Academy'));
  checkTrue('web: widget renders messages via textContent', widget.includes('textContent = String('));

  const WIRED = [
    'navigator', 'pepper', 'crm', 'book-os', 'applianceman', 'ad-studio', 'oversight',
    'dispatch-dashboard', 'service-setters-dispatch', 'work-time-access', 'notifications',
    'link-center', 'insights', 'academy', 'turbo-boss', 'manager', 'finance', 'media',
    'chats', 'track-console', 'marketing-os/studio', 'marketing-os/seo', 'marketing-os/google-accounts',
  ];
  for (const page of WIRED) {
    const html = readFileSync(`${webRoot}${page}/index.html`, 'utf8');
    checkTrue(`web: ${page} loads the Pepper bar`, html.includes('/shared/pepper-chat.js'));
  }
  const homepage = readFileSync(`${webRoot}index.html`, 'utf8');
  check('web: homepage has NO Pepper bar', homepage.includes('pepper-chat.js'), false);
  const bookPage = readFileSync(`${webRoot}book/index.html`, 'utf8');
  check('web: public /book has NO Pepper bar', bookPage.includes('pepper-chat.js'), false);

  await cleanupDb();
  await prisma.$disconnect();
  console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error('drill crashed:', error);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
