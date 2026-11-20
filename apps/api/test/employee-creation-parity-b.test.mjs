/**
 * Employee creation parity — DRILL B (audit 2026-11-20).
 *
 * Covers accounts created BY employees (Path B) and the remaining
 * public doors:
 *  - POST /auth/register with an administrator session (the Turbo Boss /
 *    Portal accounts-panel path): which roles a PLATFORM_ADMIN can
 *    create, the flags those accounts start with, and WHAT THE RESPONSE
 *    CONTAINS — a flagged covered account gets the PENDING shape with
 *    no session, and (FIX 1, 2026-11-20) a non-covered account's
 *    response ALSO carries no session: an admin creating an account
 *    for someone else never mints a session for it; the new holder's
 *    first session comes only through the gated sign-in pipeline.
 *  - Role-grant refusals: manager and customer sessions cannot create
 *    staff roles.
 *  - Public self-serve parity: ADVERTISER and declared-business
 *    signups start flagged with no token; the password floor holds on
 *    register + creator signup.
 *  - POST /connections PROVIDER_APPLICATION files an intake record and
 *    mints NO account — activation happens only through the gated
 *    creation paths.
 *
 * Register-family rate budget: this file makes 9 register-family calls
 * (cap 10/hr/IP) — keep it that way.
 *
 * LOCAL test database only. Usage:
 *   DATABASE_URL=<local test db> node test/employee-creation-parity-b.test.mjs
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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

const PORT = Number(process.env.TEST_PORT || 4597);
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
  master: '70000000-0000-4000-8000-0000000000a1',
  padmin: '70000000-0000-4000-8000-0000000000a2',
  manager: '70000000-0000-4000-8000-0000000000a3',
  customer: '70000000-0000-4000-8000-0000000000a4',
};
const PROVIDER_COMPANY_ID = randomUUID();
const TERMS = {
  signatureName: 'Parity Drill',
  documents: [
    { document: 'SERVICE_OS', version: '1.0', agreed: true },
    { document: 'APPLIANCE_CONNECT', version: '1.0', agreed: true },
  ],
};
const agedToken = () => issueFormToken({ issuedAtMs: Date.now() - 10000 });

async function seed() {
  await prisma.company.upsert({
    where: { id: PLATFORM_COMPANY_ID },
    update: {},
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'parity-platform-b', type: 'PLATFORM_OWNER', isPlatformOwner: true },
  });
  await prisma.company.upsert({
    where: { id: PROVIDER_COMPANY_ID },
    update: {},
    create: { id: PROVIDER_COMPANY_ID, name: 'Parity Provider Co', slug: 'parity-provider-co', type: 'INDEPENDENT_PROVIDER', isPlatformOwner: false },
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
  await mk(IDS.master, 'parityb-master@test.local', ['COMPANY_OWNER']);
  await mk(IDS.padmin, 'parityb-padmin@test.local', ['PLATFORM_ADMIN']);
  await mk(IDS.manager, 'parityb-manager@test.local', ['COMPANY_ADMIN']);
  await mk(IDS.customer, 'parityb-customer@test.local', ['CUSTOMER']);
}

const userByEmail = (email, companyId = PLATFORM_COMPANY_ID) =>
  prisma.user.findUnique({ where: { companyId_email: { companyId, email } } });

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
    const padminTok = await login('parityb-padmin@test.local');
    const managerTok = await login('parityb-manager@test.local');
    const customerTok = await login('parityb-customer@test.local');
    checkTrue('seed logins issued tokens', [padminTok, managerTok, customerTok].every((t) => typeof t === 'string'));

    const regBody = (email, extra = {}) => ({
      email, password: PW, firstName: 'Parity', lastName: 'Reg',
      phone: '9545550110', termsAcceptance: TERMS, ...extra,
    });

    // ---- S7: register with an administrator session ----
    const provOwner = await api('/auth/register', { token: padminTok, method: 'POST', body: regBody('reg-provider-owner@test.local', { role: 'PROVIDER_OWNER' }) });
    check('admin register PROVIDER_OWNER → 201', provOwner.status, 201);
    check('PROVIDER_OWNER response speedyVerify status', provOwner.json?.speedyVerify?.status, 'PENDING');
    checkTrue('PROVIDER_OWNER response carries NO session token', !provOwner.json?.token);
    const provOwnerRow = await userByEmail('reg-provider-owner@test.local');
    check('PROVIDER_OWNER verifyRequired', provOwnerRow?.verifyRequired, true);
    check('PROVIDER_OWNER layer2Required', provOwnerRow?.layer2Required, true);
    checkTrue('PROVIDER_OWNER employee number minted', Boolean(provOwnerRow?.employeeNumber));
    const provOwnerLogin = await api('/auth/login', { method: 'POST', body: { email: 'reg-provider-owner@test.local', password: PW } });
    check('PROVIDER_OWNER login before code → 403 NO_CODE', provOwnerLogin.json?.code, 'SPEEDY_VERIFY_NO_CODE');

    const tech = await api('/auth/register', { token: padminTok, method: 'POST', body: regBody('reg-tech@test.local', { role: 'TECHNICIAN', companyId: PROVIDER_COMPANY_ID }) });
    check('admin register TECHNICIAN (foreign company) → 201', tech.status, 201);
    const techRow = await userByEmail('reg-tech@test.local', PROVIDER_COMPANY_ID);
    checkTrue('TECHNICIAN landed in the provider company', Boolean(techRow));
    check('TECHNICIAN verifyRequired', techRow?.verifyRequired, true);

    const mm = await api('/auth/register', { token: padminTok, method: 'POST', body: regBody('reg-marketing-mgr@test.local', { role: 'MARKETING_MANAGER' }) });
    check('admin register MARKETING_MANAGER → 201', mm.status, 201);
    const mmRow = await userByEmail('reg-marketing-mgr@test.local');
    check('MARKETING_MANAGER verifyRequired (office-issued)', mmRow?.verifyRequired, true);
    checkTrue('MARKETING_MANAGER response carries NO session token (FIX 1: no mint for admin-created accounts)', !mm.json?.token);
    check('MARKETING_MANAGER response flags adminCreated', mm.json?.adminCreated, true);
    const mmBadLogin = await api('/auth/login', { method: 'POST', body: { email: 'reg-marketing-mgr@test.local', password: 'wrong-password-99' } });
    check('new account wrong-password login → 401', mmBadLogin.status, 401);

    const cust = await api('/auth/register', { token: padminTok, method: 'POST', body: regBody('reg-customer@test.local', { role: 'CUSTOMER' }) });
    check('admin register CUSTOMER → 201', cust.status, 201);
    checkTrue('CUSTOMER response carries NO session token (FIX 1)', !cust.json?.token);
    check('CUSTOMER response flags adminCreated', cust.json?.adminCreated, true);

    check('manager register DISPATCHER → 403', (await api('/auth/register', { token: managerTok, method: 'POST', body: regBody('reg-setter@test.local', { role: 'DISPATCHER' }) })).status, 403);
    check('customer register DISPATCHER → 403', (await api('/auth/register', { token: customerTok, method: 'POST', body: regBody('reg-setter2@test.local', { role: 'DISPATCHER' }) })).status, 403);
    checkTrue('refused staff accounts NOT created', !(await userByEmail('reg-setter@test.local')) && !(await userByEmail('reg-setter2@test.local')));

    // ---- S9: public self-serve parity ----
    const adv = await api('/auth/register', { method: 'POST', body: regBody('pub-advertiser@test.local', { role: 'ADVERTISER', formToken: agedToken() }) });
    check('anon self-serve ADVERTISER → 201', adv.status, 201);
    check('ADVERTISER response speedyVerify status', adv.json?.speedyVerify?.status, 'PENDING');
    checkTrue('ADVERTISER response carries NO session token', !adv.json?.token);
    check('ADVERTISER verifyRequired', (await userByEmail('pub-advertiser@test.local'))?.verifyRequired, true);

    const biz = await api('/auth/register', { method: 'POST', body: regBody('pub-business@test.local', { role: 'CUSTOMER', accountType: 'business', formToken: agedToken() }) });
    check('anon declared-business signup → 201', biz.status, 201);
    checkTrue('declared-business response carries NO session token', !biz.json?.token);
    const bizRow = await userByEmail('pub-business@test.local');
    check('declared-business verifyRequired', bizRow?.verifyRequired, true);
    check('declared-business signupAudience', bizRow?.signupAudience, 'commercial');

    check('register 9-char password → 400', (await api('/auth/register', { method: 'POST', body: regBody('pub-short@test.local', { password: 'short-9ch', formToken: agedToken() }) })).status, 400);
    check('creator signup 9-char password → 400', (await api('/creator/signup', { method: 'POST', body: { email: 'pub-creator-short@test.local', password: 'short-9ch', firstName: 'Crea', lastName: 'Tor', phone: '9545550110', termsAcceptance: TERMS, formToken: agedToken() } })).status, 400);

    // ---- S10: provider application mints NO account ----
    const usersBefore = await prisma.user.count();
    const conn = await api('/connections', {
      method: 'POST',
      body: {
        name: 'Applicant Andy', phone: '9545550110', email: 'applicant-andy@test.local',
        type: 'PROVIDER_APPLICATION', source: 'parity-drill', message: 'I run a two-truck appliance shop.',
        businessName: 'Andy Appliance LLC', serviceAreas: ['Fort Lauderdale'], appliances: ['Refrigerator'],
        formToken: agedToken(),
      },
    });
    check('PROVIDER_APPLICATION → 201 with reference', conn.status, 201);
    checkTrue('application reference issued', typeof conn.json?.data?.reference === 'string');
    const connRows = await prisma.connection.count({ where: { email: 'applicant-andy@test.local', type: 'PROVIDER_APPLICATION' } });
    check('application filed as ONE intake record', connRows, 1);
    check('NO user account minted by the application', await prisma.user.count(), usersBefore);
    checkTrue('no user row for the applicant email', !(await userByEmail('applicant-andy@test.local')));
  } finally {
    server.kill('SIGTERM');
    await prisma.$disconnect();
  }
  console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => { console.error(error); process.exit(1); });
