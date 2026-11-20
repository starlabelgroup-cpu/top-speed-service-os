/**
 * Security audit drills — Master protection + password integrity
 * (2026-11-20, Ramone's final warning on security issues).
 *
 * Proves, over HTTP against a throwaway local database:
 *  - a wrong password is a 401 with no token on the password path —
 *    for a bogus account, for the Master, and with an empty password;
 *  - the Master (COMPANY_OWNER) signs straight in: no Speedy Verify
 *    challenge, no Layer 2 challenge, session issued;
 *  - the auth rate-limit bucket now counts FAILED credential attempts
 *    only: console boot reads (GET /auth/me, authed or not) never
 *    consume it, successful sign-ins never consume it, and a success
 *    CLEARS the failures before it — so the Master cannot rate-limit
 *    himself out by retrying (the 2026-11-20 00:51 EST incident);
 *  - the anti-guessing budget itself is unchanged: 10 consecutive
 *    failed credential attempts from one IP still earn a 429 window;
 *  - non-master gates are exactly as before: a flagged tech still
 *    hits Speedy Verify then Layer 2 before any session exists, a
 *    wrong Verify code is a 401, 5 wrong codes lock the flagged
 *    account (403 SPEEDY_VERIFY_LOCKED, correct code refused while
 *    locked), and the Master's sign-in is unaffected by that lock;
 *  - the Master can issue a Verify code end to end (the issuance that
 *    silently failed for Ramone tonight).
 *
 * Two server phases: each boots a fresh server (fresh in-memory
 * limiter buckets). Run: DATABASE_URL=<local test db> node
 * test/security-audit-master-protection.test.mjs
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
if (!process.env.DATABASE_URL_UNPOOLED) process.env.DATABASE_URL_UNPOOLED = process.env.DATABASE_URL;

const PORT = Number(process.env.TEST_PORT || 4591);
const PORT_B = PORT + 1;
const JWT_SECRET = 'audit-test-secret';
const MASTER_PW = 'master-pass-1234';
const TECH_PW = 'tech-pass-1234';
const SETTER_PW = 'setter-pass-1234';
const SETTER_CODE = '87654321';
const LAYER2_CODE = '246810';

const IDS = {
  master: '50000000-0000-4000-8000-0000000000a1',
  tech: '50000000-0000-4000-8000-0000000000a2',
  setter: '50000000-0000-4000-8000-0000000000a3',
};
const EMAILS = {
  master: 'audit-master@test.local',
  tech: 'audit-tech@test.local',
  setter: 'audit-setter@test.local',
  bogus: 'audit-nobody@test.local',
};

const prisma = new PrismaClient();
let failures = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}
function checkTrue(label, value) { check(label, Boolean(value), true); }

function api(base, path, { token, method = 'GET', body } = {}) {
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

function spawnServer(port) {
  const env = { ...process.env, PORT: String(port), JWT_SECRET, DATABASE_URL: process.env.DATABASE_URL, DATABASE_URL_UNPOOLED: process.env.DATABASE_URL_UNPOOLED };
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

async function cleanupDb() {
  try {
    await prisma.user.deleteMany({ where: { OR: [{ id: { in: Object.values(IDS) } }, { email: { in: Object.values(EMAILS) } }] } });
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
  const mk = async (id, email, password, roles, flags) => {
    const passwordHash = await hashPassword(password);
    await prisma.user.upsert({
      where: { id },
      update: { passwordHash, ...flags },
      create: {
        id, companyId: PLATFORM_COMPANY_ID, email, passwordHash,
        firstName: 'Audit', lastName: 'Drill', phone: '9545550299', roles, active: true, ...flags,
      },
    });
  };
  await mk(IDS.master, EMAILS.master, MASTER_PW, ['COMPANY_OWNER'], { verifyRequired: false, layer2Required: false });
  await mk(IDS.tech, EMAILS.tech, TECH_PW, ['PROVIDER_TECH'], { verifyRequired: true, layer2Required: true });
  await mk(IDS.setter, EMAILS.setter, SETTER_PW, ['DISPATCHER'], { verifyRequired: true, layer2Required: false });
  const codeHash = await hashPassword(SETTER_CODE);
  await prisma.speedyVerifyCode.upsert({
    where: { userId: IDS.setter },
    update: { codeHash, status: 'ACTIVE', failedAttempts: 0, lockedUntil: null },
    create: { userId: IDS.setter, codeHash, status: 'ACTIVE', issuedAt: new Date(), failedAttempts: 0 },
  });
  // The tech starts with NO code — the Master issues it in phase A.
  await prisma.speedyVerifyCode.deleteMany({ where: { userId: IDS.tech } });
}

async function phaseA() {
  const base = `http://127.0.0.1:${PORT}/api/v1`;
  const server = spawnServer(PORT);
  await waitForServer(base);
  try {
    // --- Password integrity -------------------------------------------
    const bogus = await api(base, '/auth/login', { method: 'POST', body: { email: EMAILS.bogus, password: 'whatever-1234' } });
    check('bogus account + wrong password → 401', bogus.status, 401);
    checkTrue('bogus login returns no token', !bogus.json?.token);

    const masterWrong = await api(base, '/auth/login', { method: 'POST', body: { email: EMAILS.master, password: 'not-the-master-pw' } });
    check('master + wrong password → 401', masterWrong.status, 401);
    checkTrue('master wrong password returns no token', !masterWrong.json?.token);
    checkTrue('master wrong password returns no challenge', !masterWrong.json?.challenge);

    const empty = await api(base, '/auth/login', { method: 'POST', body: { email: EMAILS.master, password: '' } });
    checkTrue('master + empty password rejected (400/401)', empty.status === 400 || empty.status === 401);
    checkTrue('empty password returns no token', !empty.json?.token);

    // --- Master signs straight in --------------------------------------
    const masterOk = await api(base, '/auth/login', { method: 'POST', body: { email: EMAILS.master, password: MASTER_PW } });
    check('master + correct password → 200', masterOk.status, 200);
    checkTrue('master session token issued', typeof masterOk.json?.token === 'string' && masterOk.json.token.length > 20);
    checkTrue('master faces NO verify challenge', !masterOk.json?.verifyRequired && !masterOk.json?.challenge);
    checkTrue('master faces NO layer2 challenge', !masterOk.json?.layer2Required);
    const masterToken = masterOk.json.token;
    const me = await api(base, '/auth/me', { token: masterToken });
    check('/auth/me with master session → 200', me.status, 200);
    checkTrue('master roles include COMPANY_OWNER', (me.json?.user?.roles || me.json?.roles || []).includes('COMPANY_OWNER'));

    // --- Reads never consume the bucket --------------------------------
    let readsOk = true;
    for (let i = 0; i < 12; i += 1) {
      const r = await api(base, '/auth/me', { token: masterToken });
      if (r.status !== 200) readsOk = false;
    }
    checkTrue('12 authed /auth/me reads → all 200, none 429', readsOk);

    // --- Failures-then-success: the Master cannot wall himself out -----
    for (let round = 0; round < 2; round += 1) {
      let failsOk = true;
      for (let i = 0; i < 9; i += 1) {
        const r = await api(base, '/auth/login', { method: 'POST', body: { email: EMAILS.master, password: `wrong-${round}-${i}` } });
        if (r.status !== 401) failsOk = false;
      }
      checkTrue(`round ${round + 1}: 9 wrong-password attempts → all 401, none 429`, failsOk);
      const ok = await api(base, '/auth/login', { method: 'POST', body: { email: EMAILS.master, password: MASTER_PW } });
      check(`round ${round + 1}: correct password after 9 failures → 200 (success clears the bucket)`, ok.status, 200);
    }

    // --- Failed READS never consume the bucket --------------------------
    let anonReadsOk = true;
    for (let i = 0; i < 15; i += 1) {
      const r = await api(base, '/auth/me');
      if (r.status !== 401) anonReadsOk = false;
    }
    checkTrue('15 unauthenticated /auth/me reads → all 401, none 429', anonReadsOk);
    const afterReads = await api(base, '/auth/login', { method: 'POST', body: { email: EMAILS.master, password: MASTER_PW } });
    check('master login after 15 failed reads → 200', afterReads.status, 200);

    // --- Master issues a Verify code end to end --------------------------
    const accounts = await api(base, '/speedy-verify/accounts', { token: masterToken });
    check('master reads the verify accounts list → 200', accounts.status, 200);
    const anonAccounts = await api(base, '/speedy-verify/accounts');
    check('verify accounts list without a session → 401', anonAccounts.status, 401);
    const issued = await api(base, '/speedy-verify/issue', { token: masterToken, method: 'POST', body: { userId: IDS.tech } });
    check('master issues a code for the flagged tech → 200', issued.status, 200);
    checkTrue('issued code is 8 digits (display format), shown once', /^\d{4} \d{4}$/.test(String(issued.json?.code || '')));
    return issued.json.code;
  } finally {
    server.kill();
  }
}

async function phaseB(techCode) {
  const base = `http://127.0.0.1:${PORT_B}/api/v1`;
  const server = spawnServer(PORT_B);
  await waitForServer(base);
  try {
    // --- Flagged tech: Verify gate, then Layer 2, then session ---------
    const techLogin = await api(base, '/auth/login', { method: 'POST', body: { email: EMAILS.tech, password: TECH_PW } });
    check('flagged tech login → 200 challenge (password verified first)', techLogin.status, 200);
    check('tech login code is SPEEDY_VERIFY_REQUIRED', techLogin.json?.code, 'SPEEDY_VERIFY_REQUIRED');
    checkTrue('tech login returns NO token before the code step', !techLogin.json?.token);

    const wrongCode = await api(base, '/speedy-verify/verify', { method: 'POST', body: { challenge: techLogin.json.challenge, code: '00000000' } });
    check('wrong verify code → 401', wrongCode.status, 401);
    check('wrong verify code code', wrongCode.json?.code, 'SPEEDY_VERIFY_INVALID_CODE');
    checkTrue('wrong verify code returns no token', !wrongCode.json?.token);

    const rightCode = await api(base, '/speedy-verify/verify', { method: 'POST', body: { challenge: techLogin.json.challenge, code: techCode } });
    check('correct verify code → 200', rightCode.status, 200);
    checkTrue('correct verify code advances to Layer 2 (still no session)', rightCode.json?.layer2Required === true && !rightCode.json?.token);

    const payload = JSON.parse(Buffer.from(String(rightCode.json.challenge).split('.')[1], 'base64url').toString('utf8'));
    checkTrue('layer2 challenge carries a challenge id', typeof payload.cid === 'string');
    await prisma.loginChallenge.update({ where: { id: payload.cid }, data: { codeHash: await hashPassword(LAYER2_CODE), channel: 'EMAIL' } });
    const l2Wrong = await api(base, '/auth/layer2/verify', { method: 'POST', body: { challenge: rightCode.json.challenge, code: '111111' } });
    checkTrue('wrong layer2 code rejected (401/403), no session', (l2Wrong.status === 401 || l2Wrong.status === 403) && !l2Wrong.json?.token);
    const l2 = await api(base, '/auth/layer2/verify', { method: 'POST', body: { challenge: rightCode.json.challenge, code: LAYER2_CODE } });
    check('correct layer2 code → 200 session', l2.status, 200);
    checkTrue('layer2 completion returns a token', typeof l2.json?.token === 'string');
    const techMe = await api(base, '/auth/me', { token: l2.json.token });
    check('/auth/me with the fully-gated tech session → 200', techMe.status, 200);

    // --- 5 wrong codes still lock a flagged account ---------------------
    const setterLogin = await api(base, '/auth/login', { method: 'POST', body: { email: EMAILS.setter, password: SETTER_PW } });
    checkTrue('flagged setter login → verify challenge, no token', Boolean(setterLogin.json?.challenge) && !setterLogin.json?.token);
    let lockStatuses = [];
    for (let i = 0; i < 5; i += 1) {
      const r = await api(base, '/speedy-verify/verify', { method: 'POST', body: { challenge: setterLogin.json.challenge, code: '00000000' } });
      lockStatuses.push(`${r.status}:${r.json?.code}`);
    }
    check('wrong codes 1-4 → 401 INVALID_CODE', lockStatuses.slice(0, 4).join(','), '401:SPEEDY_VERIFY_INVALID_CODE,401:SPEEDY_VERIFY_INVALID_CODE,401:SPEEDY_VERIFY_INVALID_CODE,401:SPEEDY_VERIFY_INVALID_CODE');
    check('5th wrong code → 403 SPEEDY_VERIFY_LOCKED', lockStatuses[4], '403:SPEEDY_VERIFY_LOCKED');
    const lockedCorrect = await api(base, '/speedy-verify/verify', { method: 'POST', body: { challenge: setterLogin.json.challenge, code: SETTER_CODE } });
    check('correct code while locked → 403 SPEEDY_VERIFY_LOCKED', `${lockedCorrect.status}:${lockedCorrect.json?.code}`, '403:SPEEDY_VERIFY_LOCKED');
    checkTrue('locked account never receives a token', !lockedCorrect.json?.token);

    // --- The Master's sign-in is unaffected by the flagged lock ---------
    const masterOk = await api(base, '/auth/login', { method: 'POST', body: { email: EMAILS.master, password: MASTER_PW } });
    check('master login while a flagged account is locked → 200', masterOk.status, 200);
    checkTrue('master session issued, no verify/layer2 challenge', Boolean(masterOk.json?.token) && !masterOk.json?.challenge);

    // --- The anti-guessing budget itself is unchanged -------------------
    let budgetOk = true;
    for (let i = 0; i < 10; i += 1) {
      const r = await api(base, '/auth/login', { method: 'POST', body: { email: EMAILS.bogus, password: `guess-${i}` } });
      if (r.status !== 401) budgetOk = false;
    }
    checkTrue('10 consecutive failed credential attempts → all reach the handler (401)', budgetOk);
    const eleventh = await api(base, '/auth/login', { method: 'POST', body: { email: EMAILS.bogus, password: 'guess-11' } });
    check('11th attempt inside the window → 429', eleventh.status, 429);
    check('429 body is the standard message', eleventh.json?.error, 'Too many requests');
  } finally {
    server.kill();
  }
}

async function main() {
  await cleanupDb();
  await seed();
  const techCode = await phaseA();
  await phaseB(techCode);
  await cleanupDb();
  await prisma.$disconnect();
  if (failures) {
    console.log(`\n${failures} CHECK(S) FAILED`);
    process.exit(1);
  }
  console.log('\nALL CHECKS PASSED');
}

main().catch(async (error) => {
  console.error(error);
  try { await prisma.$disconnect(); } catch { /* ignore */ }
  process.exit(1);
});
