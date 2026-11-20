/**
 * Top Speed Ad Specialist account — drills (2026-11-19, Ramone's
 * directive: a marketing account for Top Speed's own ad specialists,
 * separate from the advertiser marketplace, with secured login and
 * sign up / reset).
 *
 * What these drills prove, end to end over HTTP on a fresh database:
 *
 *  Phase A — creation under the Master's authority:
 *   - the Work Time Access surface catalog carries 'ad-specialist';
 *   - a MANAGER (COMPANY_ADMIN) cannot create one (owner-only, 403);
 *   - the OWNER creates one: 201, roles [AD_SPECIALIST], Speedy
 *     Verify pending approval, an employee number (TS-####) minted,
 *     and the DB row starts verifyRequired + layer2Required;
 *   - POST /auth/register still refuses AD_SPECIALIST as a public
 *     self-registration role (403, administrator-created message);
 *   - the pending specialist's sign-in is denied at the Speedy
 *     Verify gate (403 SPEEDY_VERIFY_NO_CODE) — pending is pending.
 *
 *  Phase B — the public application door (POST /auth/ad-specialist/apply):
 *   - a valid application → 201 PENDING shape, NO session token; the
 *     DB row is an AD_SPECIALIST with verifyRequired + layer2Required
 *     and an employee number; the application of record exists as an
 *     AD_SPECIALIST_APPLICATION connection; NO lead booking is minted;
 *   - duplicate email → 409; missing terms → 422; a non-NANP phone →
 *     400 INVALID_PHONE;
 *   - a tripped honeypot → the same 201 shape with NOTHING persisted
 *     (no user, no connection);
 *   - the applied account cannot sign in with any password (401) —
 *     its stored hash is of a random secret nobody knows.
 *
 *  Phase C — activation + the full gate matrix:
 *   - the Master issues the specialist's Speedy Verify code
 *     (POST /speedy-verify/issue) — issuing IS the activation;
 *   - sign-in runs the real pipeline: password → SPEEDY_VERIFY_REQUIRED
 *     challenge → wrong code 401 → right code → Layer 2 challenge →
 *     Layer 2 verify → session; /auth/me answers 200 with the role;
 *   - IN (200): Ad Studio campaigns + external board + providers,
 *     Marketing OS admin pages + taxonomy (Page Studio's backend),
 *     Media OS admin content, Insights overview, Academy curriculum,
 *     Draft with Speedy (any non-403 answer proves the gate passed);
 *   - campaign lifecycle split: specialist create/submit/pause/end
 *     work; approve + resume stay OWNER-ONLY (403 for the specialist,
 *     200 for the owner);
 *   - OUT (403): Book OS setter queue + dispatch board, CRM
 *     customers, dispatch match, Finance overview, management
 *     reports (Oversight), Pepper chat, Work Time Access list,
 *     Link Center, Navigator map, provider overview (Tech door),
 *     and the advertiser plan catalog (no marketplace powers);
 *   - reverse: an ADVERTISER is still refused at Ad Studio staff
 *     actions (403) and still reads its own plan catalog (200).
 *
 *  Phase D — the applied account's activation + password reset:
 *   - the Master issues a temporary password + a Speedy Verify code;
 *   - sign-in with the temp runs temp → Verify → Layer 2 → forced
 *     password change (PASSWORD_CHANGE_REQUIRED + changeToken);
 *   - POST /auth/set-password completes it and returns a session;
 *   - forgot-password for the specialist email → the generic 200 and
 *     a reset email captured at a local Resend stub; reset-password
 *     with the captured token → 200; the stored hash then matches
 *     only the reset password, and signing in with it passes the
 *     password stage (the pipeline answers with the Verify challenge).
 *
 * Four server phases: /auth + /speedy-verify + /access-control share
 * one 10-calls / 15-min / IP rate-limit bucket, so each phase boots a
 * fresh server (fresh in-memory buckets) and stays under the limit.
 *
 * Run: DATABASE_URL=<local test db> node test/ad-specialist.test.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { hashPassword, verifyPassword } from '../src/services/passwords.js';
import { PLATFORM_COMPANY_ID } from '../src/data/store.js';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required (point it at a local TEST database).');
  process.exit(2);
}
if (!process.env.DATABASE_URL_UNPOOLED) process.env.DATABASE_URL_UNPOOLED = process.env.DATABASE_URL;

const PORT = Number(process.env.TEST_PORT || 4521);
const STUB_PORT = PORT + 9;
const JWT_SECRET = 'adspecialist-drill-secret';
const OWNER_PW = 'owner-pass-1234';
const MANAGER_PW = 'manager-pass-1234';
const ADVERTISER_PW = 'advertiser-pass-1';
const WTA_PW = 'specialist-pass-123';
const OWN_PW = 'my-own-pass-12345';
const RESET_PW = 'reset-pass-12345';
const LAYER2_CODE = '246810';

const IDS = {
  owner: '50000000-0000-4000-8000-0000000000a1',
  manager: '50000000-0000-4000-8000-0000000000a2',
  advertiser: '50000000-0000-4000-8000-0000000000a3',
};
const EMAILS = {
  owner: 'adspec-owner@test.local',
  manager: 'adspec-manager@test.local',
  advertiser: 'adspec-advertiser@test.local',
  wta: 'adspec-wta@test.local',
  applied: 'adspec-applied@test.local',
  ghost: 'adspec-ghost@test.local',
  registerAttempt: 'adspec-register-attempt@test.local',
};
const TERMS = {
  signatureName: 'Adspec Drill Applicant',
  documents: [
    { document: 'SERVICE_OS', version: '1.0', agreed: true },
    { document: 'APPLIANCE_CONNECT', version: '1.0', agreed: true },
  ],
};

const prisma = new PrismaClient();
let failures = 0;
let server = null;

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

function spawnServer(port, extraEnv = {}) {
  const env = {
    ...process.env,
    PORT: String(port),
    JWT_SECRET,
    DATABASE_URL: process.env.DATABASE_URL,
    DATABASE_URL_UNPOOLED: process.env.DATABASE_URL_UNPOOLED,
    ...extraEnv,
  };
  const child = spawn('node', ['src/server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`[api:${port}] ${d}`));
  return child;
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

async function boot(port, extraEnv = {}) {
  server = spawnServer(port, extraEnv);
  const base = `http://127.0.0.1:${port}/api/v1`;
  await waitForServer(base);
  return base;
}

async function stop() {
  if (!server) return;
  const stopped = new Promise((resolve) => server.once('exit', resolve));
  server.kill('SIGTERM');
  await Promise.race([stopped, new Promise((r) => setTimeout(r, 5000))]);
  server = null;
}

async function cleanupDb() {
  try {
    const users = await prisma.user.findMany({
      where: { OR: [{ id: { in: Object.values(IDS) } }, { email: { in: Object.values(EMAILS) } }] },
      select: { id: true },
    });
    const ids = users.map((u) => u.id);
    if (ids.length) await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await prisma.connection.deleteMany({
      where: { email: { in: [EMAILS.applied, EMAILS.ghost] } },
    });
  } catch (error) {
    console.error('cleanup warning:', error.message);
  }
}

async function seed() {
  await prisma.company.upsert({
    where: { id: PLATFORM_COMPANY_ID },
    update: {},
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'test-platform', type: 'PLATFORM_OWNER', isPlatformOwner: true },
  });
  const rows = [
    { id: IDS.owner, email: EMAILS.owner, password: OWNER_PW, roles: ['COMPANY_OWNER'], firstName: 'Drill', lastName: 'Owner' },
    { id: IDS.manager, email: EMAILS.manager, password: MANAGER_PW, roles: ['COMPANY_ADMIN'], firstName: 'Drill', lastName: 'Manager' },
    { id: IDS.advertiser, email: EMAILS.advertiser, password: ADVERTISER_PW, roles: ['ADVERTISER'], firstName: 'Drill', lastName: 'Advertiser' },
  ];
  for (const row of rows) {
    const passwordHash = await hashPassword(row.password);
    await prisma.user.upsert({
      where: { id: row.id },
      update: { passwordHash, verifyRequired: false, layer2Required: false },
      create: {
        id: row.id, companyId: PLATFORM_COMPANY_ID, email: row.email, passwordHash,
        firstName: row.firstName, lastName: row.lastName, phone: '9545550100', roles: row.roles,
        active: true, verifyRequired: false, layer2Required: false,
      },
    });
  }
}

async function login(base, email, password) {
  return api(base, '/auth/login', { method: 'POST', body: { email, password } });
}

/* Complete a Layer 2 challenge the way the suites stand in for the
 * emailed code: write the code's hash onto the challenge row, then
 * verify over HTTP for real. */
async function completeLayer2(base, challenge) {
  const payload = JSON.parse(Buffer.from(challenge.split('.')[1], 'base64url').toString('utf8'));
  await prisma.loginChallenge.update({
    where: { id: payload.cid },
    data: { codeHash: await hashPassword(LAYER2_CODE), channel: 'EMAIL' },
  });
  return api(base, '/auth/layer2/verify', { method: 'POST', body: { challenge, code: LAYER2_CODE } });
}

/* ── Phase A — creation under the Master's authority ─────────────── */
async function phaseA() {
  console.log('\n── Phase A: Work Time Access creation ──');
  const base = await boot(PORT);
  try {
    const ownerLogin = await login(base, EMAILS.owner, OWNER_PW);
    check('A owner login 200', ownerLogin.status, 200);
    const ownerToken = ownerLogin.json.token;
    const managerLogin = await login(base, EMAILS.manager, MANAGER_PW);
    check('A manager login 200', managerLogin.status, 200);
    const managerToken = managerLogin.json.token;

    const surfaces = await api(base, '/access-control/surfaces', { token: ownerToken });
    check('A surfaces 200', surfaces.status, 200);
    const surfaceList = surfaces.json.data || surfaces.json.surfaces || [];
    const adSurface = surfaceList.find((s) => s.key === 'ad-specialist');
    checkTrue('A surface catalog carries ad-specialist', Boolean(adSurface));
    check('A ad-specialist surface role', adSurface && adSurface.role, 'AD_SPECIALIST');
    check('A ad-specialist surface starts unverified', adSurface && adSurface.defaults && adSurface.defaults.speedyVerifyRequired, true);
    check('A ad-specialist surface is an employee account', adSurface && adSurface.employee, true);

    const managerCreate = await api(base, '/access-control/accounts', {
      token: managerToken, method: 'POST',
      body: { surface: 'ad-specialist', email: EMAILS.wta, password: WTA_PW, firstName: 'Wanda', lastName: 'Worktime', phone: '9545550171' },
    });
    check('A manager creating a specialist is refused 403', managerCreate.status, 403);

    const created = await api(base, '/access-control/accounts', {
      token: ownerToken, method: 'POST',
      body: { surface: 'ad-specialist', email: EMAILS.wta, password: WTA_PW, firstName: 'Wanda', lastName: 'Worktime', phone: '9545550171' },
    });
    check('A owner creates specialist 201', created.status, 201);
    checkTrue('A created roles are [AD_SPECIALIST]', Array.isArray(created.json.user?.roles) && created.json.user.roles.length === 1 && created.json.user.roles[0] === 'AD_SPECIALIST');
    checkTrue('A employee number minted (TS-####)', /^TS-\d+$/.test(created.json.employeeNumber || ''));
    check('A created account is pending Speedy Verify approval', created.json.user?.verify?.pendingApproval, true);
    const wtaRow = await prisma.user.findFirst({ where: { email: EMAILS.wta } });
    check('A DB verifyRequired on', wtaRow?.verifyRequired, true);
    check('A DB layer2Required on', wtaRow?.layer2Required, true);
    check('A DB employeeNumber matches response', wtaRow?.employeeNumber, created.json.employeeNumber);

    const registerAttempt = await api(base, '/auth/register', {
      method: 'POST',
      body: { email: EMAILS.registerAttempt, password: WTA_PW, firstName: 'Sneaky', lastName: 'Selfserve', phone: '9545550172', role: 'AD_SPECIALIST', termsAcceptance: TERMS, accountType: 'homeowner' },
    });
    check('A register refuses AD_SPECIALIST 403', registerAttempt.status, 403);
    check('A register refusal message', registerAttempt.json.error, 'Staff and provider accounts are created by an administrator');
    const attemptRow = await prisma.user.findFirst({ where: { email: EMAILS.registerAttempt } });
    check('A no account persisted from the refusal', attemptRow, null);

    const pendingLogin = await login(base, EMAILS.wta, WTA_PW);
    check('A pending specialist login denied 403', pendingLogin.status, 403);
    check('A pending denial is the no-code gate', pendingLogin.json.code, 'SPEEDY_VERIFY_NO_CODE');
  } finally {
    await stop();
  }
}

/* ── Phase B — the public application door ───────────────────────── */
async function phaseB() {
  console.log('\n── Phase B: public application ──');
  const base = await boot(PORT + 1);
  try {
    const applied = await api(base, '/auth/ad-specialist/apply', {
      method: 'POST',
      body: {
        firstName: 'Andy', lastName: 'Applicant', email: EMAILS.applied, phone: '(954) 555-0173',
        message: 'Five years running Google Ads and Meta campaigns for local service businesses; managed six-figure annual budgets.',
        termsAcceptance: TERMS,
      },
    });
    check('B apply 201', applied.status, 201);
    check('B apply speedyVerify PENDING', applied.json.speedyVerify?.status, 'PENDING');
    check('B apply issues NO token', applied.json.token, undefined);
    checkTrue('B apply roles are [AD_SPECIALIST]', Array.isArray(applied.json.user?.roles) && applied.json.user.roles[0] === 'AD_SPECIALIST');
    checkTrue('B apply returns an application reference', typeof applied.json.application?.reference === 'string' && applied.json.application.reference.length > 3);

    const row = await prisma.user.findFirst({ where: { email: EMAILS.applied } });
    checkTrue('B DB row exists', Boolean(row));
    check('B DB verifyRequired on (pending)', row?.verifyRequired, true);
    check('B DB layer2Required on', row?.layer2Required, true);
    checkTrue('B DB employee number minted', /^TS-\d+$/.test(row?.employeeNumber || ''));
    check('B DB signupSource', row?.signupSource, 'AD_SPECIALIST_APPLY');

    const connection = await prisma.connection.findFirst({ where: { email: EMAILS.applied, type: 'AD_SPECIALIST_APPLICATION' } });
    checkTrue('B application of record filed as a connection', Boolean(connection));
    check('B connection reference matches the response', connection?.reference, applied.json.application?.reference);
    // AD_SPECIALIST_APPLICATION is not a lead type, so no booking may
    // exist anywhere on this fresh database after the application.
    const anyBooking = await prisma.serviceRequest.findFirst({});
    check('B no lead booking minted for the application', anyBooking, null);

    const duplicate = await api(base, '/auth/ad-specialist/apply', {
      method: 'POST',
      body: { firstName: 'Andy', lastName: 'Again', email: EMAILS.applied, phone: '(954) 555-0173', message: 'Applying twice with the same email address here.', termsAcceptance: TERMS },
    });
    check('B duplicate email 409', duplicate.status, 409);

    const noTerms = await api(base, '/auth/ad-specialist/apply', {
      method: 'POST',
      body: { firstName: 'No', lastName: 'Terms', email: 'adspec-noterms@test.local', phone: '(954) 555-0174', message: 'This application skips the legal acceptance step.' },
    });
    check('B missing terms 422', noTerms.status, 422);
    check('B missing terms code', noTerms.json.code, 'TERMS_ACCEPTANCE_REQUIRED');

    const badPhone = await api(base, '/auth/ad-specialist/apply', {
      method: 'POST',
      body: { firstName: 'Bad', lastName: 'Phone', email: 'adspec-badphone@test.local', phone: '5550134', message: 'This application carries an impossible phone number.', termsAcceptance: TERMS },
    });
    check('B non-NANP phone 400', badPhone.status, 400);
    check('B non-NANP phone code', badPhone.json.code, 'INVALID_PHONE');

    const ghost = await api(base, '/auth/ad-specialist/apply', {
      method: 'POST',
      body: {
        firstName: 'Ghost', lastName: 'Bot', email: EMAILS.ghost, phone: '(954) 555-0175',
        message: 'Automated filler that tripped the honeypot field on the form.',
        termsAcceptance: TERMS, companyWebsite: 'https://spam.example.com',
      },
    });
    check('B honeypot gets the same 201 shape', ghost.status, 201);
    check('B honeypot speedyVerify PENDING shape', ghost.json.speedyVerify?.status, 'PENDING');
    const ghostUser = await prisma.user.findFirst({ where: { email: EMAILS.ghost } });
    check('B honeypot persisted NO user', ghostUser, null);
    const ghostConnection = await prisma.connection.findFirst({ where: { email: EMAILS.ghost } });
    check('B honeypot persisted NO connection', ghostConnection, null);

    const appliedLogin = await login(base, EMAILS.applied, 'any-password-123');
    check('B applied account cannot sign in with any password (401)', appliedLogin.status, 401);
  } finally {
    await stop();
  }
}

/* ── Phase C — activation + the full gate matrix ─────────────────── */
async function phaseC() {
  console.log('\n── Phase C: activation + gate matrix ──');
  const base = await boot(PORT + 2);
  try {
    const ownerLogin = await login(base, EMAILS.owner, OWNER_PW);
    check('C owner login 200', ownerLogin.status, 200);
    const ownerToken = ownerLogin.json.token;

    const wtaRow = await prisma.user.findFirst({ where: { email: EMAILS.wta } });
    checkTrue('C WTA specialist row carried over', Boolean(wtaRow));

    // The pending account is visible in the Master's approval queue.
    const queue = await api(base, '/speedy-verify/accounts', { token: ownerToken });
    check('C verify accounts list 200 (owner)', queue.status, 200);
    const queueRows = queue.json.data || queue.json.accounts || [];
    const queueRow = queueRows.find((r) => (r.user?.id || r.id) === wtaRow.id);
    checkTrue('C pending specialist is in the Master approval queue', Boolean(queueRow));

    // Activation = the Master issues the account's access code.
    const issued = await api(base, '/speedy-verify/issue', { token: ownerToken, method: 'POST', body: { userId: wtaRow.id } });
    check('C owner issues the verify code 200', issued.status, 200);
    const verifyCode = issued.json.code;
    checkTrue('C issued code is 8 digits (4+4 display grouping)', /^\d{8}$/.test(String(verifyCode || '').replace(/\s/g, '')));

    // Sign-in pipeline: password → Verify challenge → Layer 2 → session.
    const specLogin = await login(base, EMAILS.wta, WTA_PW);
    check('C activated specialist login reaches the code step', specLogin.json.code, 'SPEEDY_VERIFY_REQUIRED');
    checkTrue('C login returns a verify challenge', typeof specLogin.json.challenge === 'string');

    const wrongCode = await api(base, '/speedy-verify/verify', { method: 'POST', body: { challenge: specLogin.json.challenge, code: '00000000' } });
    check('C wrong verify code 401', wrongCode.status, 401);

    const verified = await api(base, '/speedy-verify/verify', { method: 'POST', body: { challenge: specLogin.json.challenge, code: verifyCode } });
    check('C verify passes to the Layer 2 step', verified.json.code, 'LAYER2_REQUIRED');
    checkTrue('C Layer 2 challenge issued', typeof verified.json.challenge === 'string');

    const session = await completeLayer2(base, verified.json.challenge);
    check('C Layer 2 verify 200', session.status, 200);
    const specToken = session.json.token;
    checkTrue('C session token issued', typeof specToken === 'string' && specToken.length > 20);
    checkTrue('C session user carries AD_SPECIALIST', Array.isArray(session.json.user?.roles) && session.json.user.roles.includes('AD_SPECIALIST'));

    const me = await api(base, '/auth/me', { token: specToken });
    check('C /auth/me 200 for the activated specialist', me.status, 200);

    /* ── IN: the marketing workstations ── */
    const inMatrix = [
      ['GET', '/ad-studio/campaigns'],
      ['GET', '/ad-studio/external-board'],
      ['GET', '/ad-studio/providers'],
      ['GET', '/marketing-os/admin/pages'],
      ['GET', '/marketing-os/admin/taxonomy'],
      ['GET', '/media-os/admin/content'],
      ['GET', '/insights/overview'],
      ['GET', '/academy/curriculum'],
    ];
    for (const [method, path] of inMatrix) {
      const res = await api(base, path, { token: specToken, method });
      check(`C IN ${method} ${path} → 200`, res.status, 200);
    }
    const draft = await api(base, '/ad-studio/draft-copy', { token: specToken, method: 'POST', body: { name: 'Drill draft', topic: 'Refrigerator repair in Broward' } });
    checkTrue('C IN POST /ad-studio/draft-copy passes the gate (not 403)', draft.status !== 403 && draft.status !== 401);

    /* ── Campaign lifecycle: staff actions yes, owner actions no ── */
    const campaign = await api(base, '/ad-studio/campaigns', {
      token: specToken, method: 'POST',
      body: { name: 'Ad Specialist Drill Campaign', businessLine: 'TOP_SPEED', objective: 'Prove the specialist campaign gate split', destinationUrl: 'https://topspeedserviceos.com/book' },
    });
    check('C specialist creates a campaign 201', campaign.status, 201);
    const campaignId = campaign.json.data?.id || campaign.json.id;
    check('C campaign starts DRAFT', campaign.json.data?.status || campaign.json.status, 'DRAFT');

    const submit = await api(base, `/ad-studio/campaigns/${campaignId}/submit`, { token: specToken, method: 'POST', body: {} });
    check('C specialist submits 200', submit.status, 200);
    check('C submitted → PENDING_APPROVAL', submit.json.data?.status || submit.json.status, 'PENDING_APPROVAL');

    const approveSpec = await api(base, `/ad-studio/campaigns/${campaignId}/approve`, { token: specToken, method: 'POST', body: {} });
    check('C specialist approve refused 403 (owner-only)', approveSpec.status, 403);
    const approveOwner = await api(base, `/ad-studio/campaigns/${campaignId}/approve`, { token: ownerToken, method: 'POST', body: {} });
    check('C owner approve 200', approveOwner.status, 200);
    check('C approved → ACTIVE', approveOwner.json.data?.status || approveOwner.json.status, 'ACTIVE');

    const pause = await api(base, `/ad-studio/campaigns/${campaignId}/pause`, { token: specToken, method: 'POST', body: {} });
    check('C specialist pause 200', pause.status, 200);
    check('C paused → PAUSED', pause.json.data?.status || pause.json.status, 'PAUSED');

    const resumeSpec = await api(base, `/ad-studio/campaigns/${campaignId}/resume`, { token: specToken, method: 'POST', body: {} });
    check('C specialist resume refused 403 (owner-only)', resumeSpec.status, 403);
    const resumeOwner = await api(base, `/ad-studio/campaigns/${campaignId}/resume`, { token: ownerToken, method: 'POST', body: {} });
    check('C owner resume 200', resumeOwner.status, 200);

    const end = await api(base, `/ad-studio/campaigns/${campaignId}/end`, { token: specToken, method: 'POST', body: {} });
    check('C specialist end 200', end.status, 200);
    check('C ended → ENDED', end.json.data?.status || end.json.status, 'ENDED');

    /* ── OUT: everything that is not a marketing workstation ── */
    const outMatrix = [
      ['GET', '/bookos/setter-queue'],
      ['GET', '/bookos/dispatch-board'],
      ['GET', '/crm/customers'],
      ['GET', '/finance/overview'],
      ['GET', '/management/reports'],
      ['GET', '/access-control/accounts'],
      ['GET', '/link-center/options'],
      ['GET', '/navigator/map'],
      ['GET', '/provider/overview'],
      ['GET', '/advertiser/plans'],
    ];
    for (const [method, path] of outMatrix) {
      const res = await api(base, path, { token: specToken, method });
      check(`C OUT ${method} ${path} → 403`, res.status, 403);
    }
    const dispatchMatch = await api(base, '/dispatch/match', { token: specToken, method: 'POST', body: { bookingId: 'drill-nonexistent' } });
    check('C OUT POST /dispatch/match → 403', dispatchMatch.status, 403);
    const pepperChat = await api(base, '/pepper/chat', { token: specToken, method: 'POST', body: { message: 'status please' } });
    check('C OUT POST /pepper/chat → 403', pepperChat.status, 403);

    /* ── Reverse: the advertiser gains nothing, keeps its own door ── */
    const advLogin = await login(base, EMAILS.advertiser, ADVERTISER_PW);
    check('C advertiser login 200', advLogin.status, 200);
    const advToken = advLogin.json.token;
    const advList = await api(base, '/ad-studio/campaigns', { token: advToken });
    check('C advertiser refused at Ad Studio list 403', advList.status, 403);
    const advCreate = await api(base, '/ad-studio/campaigns', {
      token: advToken, method: 'POST',
      body: { name: 'Advertiser Attempt Campaign', businessLine: 'EXTERNAL', objective: 'Must never be creatable by an advertiser', destinationUrl: 'https://example.com' },
    });
    check('C advertiser refused at Ad Studio create 403', advCreate.status, 403);
    const advPlans = await api(base, '/advertiser/plans', { token: advToken });
    check('C advertiser still reads its own plan catalog 200', advPlans.status, 200);
  } finally {
    await stop();
  }
}

/* ── Phase D — applied-account activation + password reset ───────── */
async function phaseD() {
  console.log('\n── Phase D: temp-password activation + password reset ──');
  const captures = [];
  const stub = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try { captures.push(JSON.parse(raw || '{}')); } catch { /* ignore */ }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'drill-stub-message' }));
    });
  });
  await new Promise((resolve) => stub.listen(STUB_PORT, '127.0.0.1', resolve));
  const base = await boot(PORT + 3, {
    RESEND_API_KEY: 'drill-resend-key',
    RESEND_API_BASE: `http://127.0.0.1:${STUB_PORT}`,
    EMAIL_FROM: 'Top Speed Appliance <service@topspeedappliance.net>',
  });
  try {
    const ownerLogin = await login(base, EMAILS.owner, OWNER_PW);
    check('D owner login 200', ownerLogin.status, 200);
    const ownerToken = ownerLogin.json.token;

    const appliedRow = await prisma.user.findFirst({ where: { email: EMAILS.applied } });
    checkTrue('D applied row carried over', Boolean(appliedRow));

    const temp = await api(base, '/access-control/temp-password/issue', { token: ownerToken, method: 'POST', body: { userId: appliedRow.id } });
    check('D owner issues a temporary password 201', temp.status, 201);
    const tempPassword = temp.json.tempPassword;
    checkTrue('D temp password returned once to the Master', typeof tempPassword === 'string' && tempPassword.length >= 8);

    const issued = await api(base, '/speedy-verify/issue', { token: ownerToken, method: 'POST', body: { userId: appliedRow.id } });
    check('D owner issues the verify code 200 (activation)', issued.status, 200);
    const verifyCode = issued.json.code;

    const tempLogin = await login(base, EMAILS.applied, tempPassword);
    check('D temp sign-in reaches the code step', tempLogin.json.code, 'SPEEDY_VERIFY_REQUIRED');
    const verified = await api(base, '/speedy-verify/verify', { method: 'POST', body: { challenge: tempLogin.json.challenge, code: verifyCode } });
    check('D temp verify passes to the Layer 2 step', verified.json.code, 'LAYER2_REQUIRED');
    const changed = await completeLayer2(base, verified.json.challenge);
    check('D temp pipeline ends in the forced password change', changed.json.code, 'PASSWORD_CHANGE_REQUIRED');
    checkTrue('D change token issued', typeof changed.json.changeToken === 'string');

    const setPw = await api(base, '/auth/set-password', { method: 'POST', body: { changeToken: changed.json.changeToken, newPassword: OWN_PW } });
    check('D set-password 200', setPw.status, 200);
    checkTrue('D set-password returns a session', typeof setPw.json.token === 'string' && setPw.json.token.length > 20);

    // Forgot / reset — role-agnostic, proven for the specialist.
    const forgot = await api(base, '/auth/forgot-password', { method: 'POST', body: { email: EMAILS.applied } });
    check('D forgot-password generic 200', forgot.status, 200);
    let rawToken = null;
    for (let i = 0; i < 40 && !rawToken; i += 1) {
      const hit = captures.find((entry) => Array.isArray(entry.to) && entry.to.includes(EMAILS.applied));
      const text = hit ? JSON.stringify(hit) : '';
      const match = text.match(/reset-password\?token=([A-Za-z0-9_-]+)/);
      if (match) rawToken = match[1];
      if (!rawToken) await new Promise((r) => setTimeout(r, 250));
    }
    checkTrue('D reset email captured with a raw token', typeof rawToken === 'string');
    const tokenRow = await prisma.passwordResetToken.findFirst({ where: { userId: appliedRow.id, usedAt: null } });
    checkTrue('D reset token row stored (hash only)', Boolean(tokenRow));
    if (tokenRow && rawToken) {
      check('D stored value is the SHA-256 of the token', tokenRow.tokenHash, createHash('sha256').update(rawToken).digest('hex'));
    }
    const reset = await api(base, '/auth/reset-password', { method: 'POST', body: { token: rawToken, newPassword: RESET_PW } });
    check('D reset-password 200', reset.status, 200);

    // The stored hash now matches the reset password and not the
    // pre-reset one (checked in-process to stay inside the shared
    // /auth rate-limit budget for this phase).
    const afterReset = await prisma.user.findFirst({ where: { email: EMAILS.applied } });
    check('D stored hash matches the reset password', await verifyPassword(RESET_PW, afterReset.passwordHash), true);
    check('D stored hash no longer matches the pre-reset password', await verifyPassword(OWN_PW, afterReset.passwordHash), false);
    const newLogin = await login(base, EMAILS.applied, RESET_PW);
    check('D reset password passes the password stage (verify challenge next)', newLogin.json.code, 'SPEEDY_VERIFY_REQUIRED');
  } finally {
    await stop();
    stub.close();
  }
}

async function main() {
  await cleanupDb();
  await seed();
  try {
    await phaseA();
    await phaseB();
    await phaseC();
    await phaseD();
  } finally {
    await stop();
    await cleanupDb();
    await prisma.$disconnect();
  }
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error('DRILL ERROR', error);
  await stop().catch(() => {});
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
