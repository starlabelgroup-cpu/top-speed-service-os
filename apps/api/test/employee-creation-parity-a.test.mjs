/**
 * Employee creation parity — DRILL A (audit 2026-11-20, Ramone's order:
 * "make sure employees can create accounts with same level security").
 *
 * Covers the paths the existing suites do NOT:
 *  - Work Time Access (POST /access-control/accounts) creation for EVERY
 *    surface: gate (Master-only), per-surface verifyRequired /
 *    layer2Required / employee-number defaults read back from the DB.
 *  - The Master-tier smuggle attempts + the password floor.
 *  - The Master's explicit verifyRequired toggle at creation.
 *  - The full office-activation chain for an office-created provider:
 *    WTA password → denied (no code) → temp password → still denied →
 *    Master issues code → temp login → Verify challenge → wrong code →
 *    right code → Layer 2 → forced password change → session ONLY then.
 *  - Intake Shield Phase 2 session-skip (FIX 2, 2026-11-20): a signed-in
 *    CUSTOMER session's register POST is now Phase-2 scored exactly like
 *    an anonymous one (gibberish ghosts, nothing persists); the skip
 *    survives ONLY for grant-capable admin sessions (Master drill below);
 *    the honeypot still ghosts even with a session.
 *
 * LOCAL test database only. Usage:
 *   DATABASE_URL=<local test db> node test/employee-creation-parity-a.test.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { PLATFORM_COMPANY_ID } from '../src/data/store.js';
import { hashPassword } from '../src/services/passwords.js';
import { issueFormToken } from '../src/services/intakeShield.js';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required (local TEST database).');
  process.exit(2);
}
process.env.DATABASE_URL_UNPOOLED ||= process.env.DATABASE_URL;
const JWT = ['parity', 'drill', 'jwt', 'secret'].join('-');
process.env.JWT_SECRET = JWT;

const PORT = Number(process.env.TEST_PORT || 4595);
const base = `http://127.0.0.1:${PORT}/api/v1`;
const PW = 'parity-pass-1234';
const prisma = new PrismaClient();
let failures = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}
function checkTrue(label, value) { check(label, Boolean(value), true); }

function api(path, { token, method = 'GET', body } = {}) {
  return fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (res) => {
    let json = null;
    try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, json };
  });
}

const IDS = {
  master: '60000000-0000-4000-8000-0000000000a1',
  padmin: '60000000-0000-4000-8000-0000000000a2',
  manager: '60000000-0000-4000-8000-0000000000a3',
  setter: '60000000-0000-4000-8000-0000000000a4',
  customer: '60000000-0000-4000-8000-0000000000a5',
};
const TERMS = {
  signatureName: 'Parity Drill',
  documents: [
    { document: 'SERVICE_OS', version: '1.0', agreed: true },
    { document: 'APPLIANCE_CONNECT', version: '1.0', agreed: true },
  ],
};

async function seed() {
  await prisma.company.upsert({
    where: { id: PLATFORM_COMPANY_ID },
    update: {},
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'parity-platform', type: 'PLATFORM_OWNER', isPlatformOwner: true },
  });
  const mk = async (id, email, roles) => {
    const passwordHash = await hashPassword(PW);
    await prisma.user.upsert({
      where: { id },
      update: { passwordHash, verifyRequired: false, layer2Required: false },
      create: {
        id, companyId: PLATFORM_COMPANY_ID, email, passwordHash,
        firstName: 'Parity', lastName: 'Seed', phone: '9545550299', roles, active: true,
        verifyRequired: false, layer2Required: false,
      },
    });
  };
  await mk(IDS.master, 'parity-master@test.local', ['COMPANY_OWNER']);
  await mk(IDS.padmin, 'parity-padmin@test.local', ['PLATFORM_ADMIN']);
  await mk(IDS.manager, 'parity-manager@test.local', ['COMPANY_ADMIN']);
  await mk(IDS.setter, 'parity-setter@test.local', ['DISPATCHER']);
  await mk(IDS.customer, 'parity-customer@test.local', ['CUSTOMER']);
}

const userByEmail = (email) => prisma.user.findUnique({ where: { companyId_email: { companyId: PLATFORM_COMPANY_ID, email } } });

async function main() {
  await seed();
  const server = spawn('node', ['src/server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, PORT: String(PORT), JWT_SECRET: JWT },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[api] ${d}`));
  try {
    for (let i = 0; i < 90; i += 1) {
      try { const r = await fetch(`${base}/health`); if (r.ok) break; } catch { /* wait */ }
      await new Promise((r) => setTimeout(r, 1000));
    }
    const login = async (email) => (await api('/auth/login', { method: 'POST', body: { email, password: PW } })).json?.token;
    const masterTok = await login('parity-master@test.local');
    const padminTok = await login('parity-padmin@test.local');
    const managerTok = await login('parity-manager@test.local');
    const setterTok = await login('parity-setter@test.local');
    const customerTok = await login('parity-customer@test.local');
    checkTrue('seed logins issued tokens', [masterTok, padminTok, managerTok, setterTok, customerTok].every((t) => typeof t === 'string'));

    // ---- S1: Work Time Access gate ----
    const createBody = (surface, email, extra = {}) => ({ surface, email, password: PW, firstName: 'Parity', lastName: 'Wta', phone: '9545550110', ...extra });
    check('WTA create anon → 401', (await api('/access-control/accounts', { method: 'POST', body: createBody('service-setter', 'wta-anon@test.local') })).status, 401);
    check('WTA create as setter → 403', (await api('/access-control/accounts', { token: setterTok, method: 'POST', body: createBody('service-setter', 'wta-setter@test.local') })).status, 403);
    check('WTA create as manager → 403', (await api('/access-control/accounts', { token: managerTok, method: 'POST', body: createBody('service-setter', 'wta-manager@test.local') })).status, 403);
    check('WTA create as platform admin → 403', (await api('/access-control/accounts', { token: padminTok, method: 'POST', body: createBody('service-setter', 'wta-padmin@test.local') })).status, 403);
    const surfaces = await api('/access-control/surfaces', { token: masterTok });
    check('WTA surfaces as master → 200', surfaces.status, 200);
    check('WTA surfaces count', surfaces.json?.count, 11);
    const surfDefaults = Object.fromEntries((surfaces.json?.data || []).map((s) => [s.key, s.defaults]));
    check('surface default: service-setter verify', surfDefaults['service-setter']?.speedyVerifyRequired, true);
    check('surface default: customer verify', surfDefaults['customer']?.speedyVerifyRequired, false);
    check('surface default: customer layer2', surfDefaults['customer']?.layer2Required, true);
    check('surface default: flywheel-manager verify', surfDefaults['flywheel-manager']?.speedyVerifyRequired, true);

    // ---- S2: create one account per surface; verify DB defaults ----
    const expectations = [
      ['service-setter', true, true, true],
      ['manager', true, true, true],
      ['provider', true, true, true],
      ['business', true, true, false],
      ['property-manager', true, true, false],
      ['commercial', true, true, false],
      ['customer', false, true, false],
      ['advertiser', true, true, false],
      ['flywheel-manager', true, true, false],
      ['ad-specialist', true, true, true],
      ['content-creator', true, true, false],
    ];
    for (const [surface, wantVerify, wantLayer2, wantNumber] of expectations) {
      const email = `wta-${surface}@test.local`;
      const res = await api('/access-control/accounts', { token: masterTok, method: 'POST', body: createBody(surface, email) });
      check(`WTA create ${surface} → 201`, res.status, 201);
      const row = await userByEmail(email);
      check(`${surface} verifyRequired`, row?.verifyRequired, wantVerify);
      check(`${surface} layer2Required`, row?.layer2Required, wantLayer2);
      check(`${surface} employeeNumber ${wantNumber ? 'minted' : 'absent'}`, Boolean(row?.employeeNumber), wantNumber);
    }

    // ---- S3: Master-tier smuggle ----
    const smuggle = await api('/access-control/accounts', { token: masterTok, method: 'POST', body: { ...createBody('customer', 'wta-smuggle@test.local'), role: 'COMPANY_OWNER' } });
    check('WTA role=COMPANY_OWNER smuggle → 403', smuggle.status, 403);
    checkTrue('smuggled account NOT created', !(await userByEmail('wta-smuggle@test.local')));

    // ---- S4: password floor ----
    check('WTA create 9-char password → 400', (await api('/access-control/accounts', { token: masterTok, method: 'POST', body: createBody('customer', 'wta-short@test.local', { password: 'short-9ch' }) })).status, 400);

    // ---- S5: Master's explicit verifyRequired toggle ----
    const toggled = await api('/access-control/accounts', { token: masterTok, method: 'POST', body: createBody('service-setter', 'wta-toggle@test.local', { verifyRequired: false }) });
    check('WTA create with verifyRequired:false toggle → 201', toggled.status, 201);
    check('toggled setter verifyRequired is false (Master discretion)', (await userByEmail('wta-toggle@test.local'))?.verifyRequired, false);

    // ---- S6: office-activation chain (provider from S2) ----
    const provEmail = 'wta-provider@test.local';
    const provRow = await userByEmail(provEmail);
    const loginProv = await api('/auth/login', { method: 'POST', body: { email: provEmail, password: PW } });
    check('provider login before code issued → 403', loginProv.status, 403);
    check('provider login denial code', loginProv.json?.code, 'SPEEDY_VERIFY_NO_CODE');
    const tempVsMaster = await api('/access-control/temp-password/issue', { token: masterTok, method: 'POST', body: { userId: IDS.master } });
    check('temp password vs Master → 403', tempVsMaster.status, 403);
    const temp = await api('/access-control/temp-password/issue', { token: masterTok, method: 'POST', body: { userId: provRow.id } });
    check('temp password issue → 201', temp.status, 201);
    checkTrue('temp password shown once in issue response', typeof temp.json?.tempPassword === 'string' && temp.json.tempPassword.length >= 10);
    const tempLogin1 = await api('/auth/login', { method: 'POST', body: { email: provEmail, password: temp.json.tempPassword } });
    check('temp login before Verify code exists → 403 NO_CODE', tempLogin1.json?.code, 'SPEEDY_VERIFY_NO_CODE');
    const issued = await api('/speedy-verify/issue', { token: masterTok, method: 'POST', body: { userId: provRow.id } });
    check('master issues verify code → 200/201', [200, 201].includes(issued.status), true);
    const plainCode = issued.json?.code || issued.json?.data?.code;
    checkTrue('issue response carries the one-time code', typeof plainCode === 'string' && /^\d{8}$/.test(String(plainCode).replace(/[\s-]/g, '')));
    const tempLogin2 = await api('/auth/login', { method: 'POST', body: { email: provEmail, password: temp.json.tempPassword } });
    checkTrue('temp login after code → Verify challenge, NO token', tempLogin2.json?.code === 'SPEEDY_VERIFY_REQUIRED' && !tempLogin2.json?.token);
    const wrong = await api('/speedy-verify/verify', { method: 'POST', body: { challenge: tempLogin2.json.challenge, code: '00000000' } });
    checkTrue('wrong verify code rejected, no token', [401, 403].includes(wrong.status) && !wrong.json?.token);
    const right = await api('/speedy-verify/verify', { method: 'POST', body: { challenge: tempLogin2.json.challenge, code: plainCode } });
    checkTrue('right verify code → Layer 2 challenge, NO token', right.json?.layer2Required === true && !right.json?.token);
    const payload = JSON.parse(Buffer.from(String(right.json.challenge).split('.')[1], 'base64url').toString());
    await prisma.loginChallenge.update({ where: { id: payload.cid }, data: { codeHash: await hashPassword('246810'), channel: 'EMAIL' } });
    const l2 = await api('/auth/layer2/verify', { method: 'POST', body: { challenge: right.json.challenge, code: '246810' } });
    checkTrue('temp chain after Layer 2 → forced change state, NO session token', l2.json?.mustChangePassword === true && typeof l2.json?.changeToken === 'string' && !l2.json?.token);
    const setPw = await api('/auth/set-password', { method: 'POST', body: { changeToken: l2.json.changeToken, newPassword: 'holder-own-pass-99' } });
    check('set-password → 200', setPw.status, 200);
    checkTrue('session exists ONLY after holder sets own password', typeof setPw.json?.token === 'string');

    // ---- S8: Intake Shield Phase 2 session-skip on /auth/register ----
    const gibberish = (email) => ({
      email, password: PW, firstName: 'Pruihue', lastName: 'Zxqwrty',
      phone: '9545550110', role: 'CUSTOMER', termsAcceptance: TERMS, companyWebsite: '',
    });
    const anonGib = await api('/auth/register', { method: 'POST', body: gibberish('awe.so.m.eh.ay.den2.5@gmail.com') });
    check('anon gibberish register → 201 ghost shape', anonGib.status, 201);
    checkTrue('anon gibberish persisted NO user', !(await userByEmail('awe.so.m.eh.ay.den2.5@gmail.com')));
    const sessGib = await api('/auth/register', { token: customerTok, method: 'POST', body: gibberish('awe.so.m.eh.ay.den9.9@gmail.com') });
    check('signed-in (CUSTOMER) gibberish register → 201 ghost shape', sessGib.status, 201);
    checkTrue('signed-in (CUSTOMER) gibberish persisted NO user (FIX 2: Phase 2 applies to non-admin sessions)', !(await userByEmail('awe.so.m.eh.ay.den9.9@gmail.com')));
    const adminGib = await api('/auth/register', { token: masterTok, method: 'POST', body: gibberish('officer.creation@test.local') });
    check('signed-in (MASTER) register → 201', adminGib.status, 201);
    checkTrue('signed-in (MASTER) creation PERSISTED a user (skip kept for grant-capable admins only)', Boolean(await userByEmail('officer.creation@test.local')));
    checkTrue('MASTER-created response carries NO session token (FIX 1)', !adminGib.json?.token);
    const sessHoney = await api('/auth/register', { token: customerTok, method: 'POST', body: { ...gibberish('honeypot-session@test.local'), companyWebsite: 'http://spam.example' } });
    check('signed-in honeypot register → 201 ghost shape', sessHoney.status, 201);
    checkTrue('signed-in honeypot persisted NO user (honeypot still applies)', !(await userByEmail('honeypot-session@test.local')));
    checkTrue('aged-token helper sanity (unused here)', typeof issueFormToken === 'function');
  } finally {
    server.kill('SIGTERM');
    await prisma.$disconnect();
  }
  console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => { console.error(error); process.exit(1); });
