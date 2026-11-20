/**
 * Media OS Content Creator / Publisher accounts — drill suite.
 *
 * Proves the CONTENT_CREATOR account class end to end on an isolated DB:
 *   - Work Time Access creation (owner-only; verifyRequired on; Layer 2
 *     flagged on; NO employee number — external accounts are not employees)
 *   - Public /creator/signup → PENDING (Speedy Verify gate denies login),
 *     Intake Shield wiring (honeypot persists nothing, NANP phone check,
 *     terms required, duplicate refused)
 *   - Activation = the office issuing a Speedy Verify code (ApplianceMan
 *     Speedy Verify panel endpoints)
 *   - MANDATORY Layer 2 by role: after activation the login pipeline runs
 *     password → Speedy Verify → Layer 2, and Layer 2 is STILL required
 *     after the per-account layer2Required flag is flipped off in the DB;
 *     the account-facing disable/update endpoints refuse (LAYER2_ROLE_REQUIRED)
 *   - Creator workspace ownership scoping (A vs B: list/detail/PATCH/submit/
 *     asset-create all 404 across owners), draft-only edits, submit →
 *     IN_REVIEW, staff send-back + publish through the existing admin flow,
 *     published item visible on the public feed
 *   - Gate matrix: creator refused at Media OS admin + the OUT consoles;
 *     staff/customer tokens refused at the creator surface
 *   - Forgot/reset password completes for a creator; /auth/register still
 *     refuses CONTENT_CREATOR self-registration
 *
 * Run (isolated DB):
 *   DATABASE_URL=postgresql://.../creator_drill node test/media-creator-accounts.test.mjs
 */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/services/passwords.js';
import { PLATFORM_COMPANY_ID } from '../src/data/store.js';

const PORT = 8931;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const TEST_JWT_SECRET = ['creator', 'drill', 'secret', '2026'].join('-');
const LAYER2_CODE = '246810';
const VERIFY_CODE = '87654321';

let passed = 0;
let failed = 0;
const failures = [];
function check(name, condition, detail = '') {
  if (condition) { passed += 1; console.log(`  PASS ${name}`); }
  else { failed += 1; failures.push(`${name} ${detail}`); console.log(`  FAIL ${name} ${detail}`); }
}
async function req(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* TwiML etc. */ }
  return { status: res.status, json };
}

const prisma = new PrismaClient();
let server = null;
let serverLog = '';
function startServer() {
  server = spawn('node', ['src/server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: 'test',
      JWT_SECRET: TEST_JWT_SECRET,
      RESEND_API_KEY: '',
      OPENAI_API_KEY: '',
      DATABASE_URL: process.env.DATABASE_URL,
      DATABASE_URL_UNPOOLED: process.env.DATABASE_URL,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
}
startServer();

async function waitForServer() {
  for (let i = 0; i < 90; i += 1) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await delay(500);
  }
  return false;
}

/* The auth rate limiter (10 / 15 min / IP across /auth, /speedy-verify and
   /access-control) is in-memory: restarting the server resets its buckets.
   The suite restarts at section boundaries, the established drill pattern. */
async function restartServer() {
  if (server) server.kill('SIGTERM');
  await delay(600);
  startServer();
  if (!(await waitForServer())) throw new Error('server did not restart');
}

const TERMS = {
  signatureName: 'Casey Creator',
  documents: [
    { document: 'SERVICE_OS', version: '1.0', agreed: true },
    { document: 'APPLIANCE_CONNECT', version: '1.0', agreed: true },
  ],
};

async function seedUser({ email, roles, verifyRequired = false, layer2Required = false, password = 'Password123!' }) {
  return prisma.user.create({
    data: {
      companyId: PLATFORM_COMPANY_ID,
      email, passwordHash: await hashPassword(password),
      firstName: 'Seed', lastName: 'User', roles,
      signupSource: 'DRILL', verifyRequired, layer2Required,
      emailVerifiedAt: new Date(),
    },
  });
}

/** Decode the LoginChallenge row id (claim `cid`) out of a Layer 2
 *  challenge JWT so the drill can plant the known code hash on the row —
 *  the established suite pattern for completing Layer 2 without a mailbox. */
function challengeRowId(jwt) {
  try {
    const payload = JSON.parse(Buffer.from(String(jwt).split('.')[1], 'base64url').toString('utf8'));
    return payload.cid || null;
  } catch { return null; }
}

/** Full creator login: password → Speedy Verify → Layer 2 → session token.
 *  (Auth responses are FLAT bodies: { user, token }, the Verify challenge
 *  { verifyRequired, code, challenge }, the Layer 2 challenge
 *  { layer2Required, code, challenge } — no envelope.) */
async function creatorLogin(email, password) {
  const login = await req('POST', '/auth/login', { body: { email, password } });
  const challenge = login.json?.challenge;
  if (!challenge) return { login, stage: 'login' };
  const verify = await req('POST', '/speedy-verify/verify', { body: { challenge, code: VERIFY_CODE } });
  const l2jwt = verify.json?.challenge;
  const l2RowId = l2jwt ? challengeRowId(l2jwt) : null;
  if (!l2RowId) return { login, verify, stage: 'verify' };
  await prisma.loginChallenge.update({
    where: { id: l2RowId },
    data: { codeHash: await hashPassword(LAYER2_CODE) },
  });
  const l2 = await req('POST', '/auth/layer2/verify', { body: { challenge: l2jwt, code: LAYER2_CODE } });
  return { login, verify, l2, token: l2.json?.token, stage: 'done' };
}

async function main() {
  console.log('\n== Media OS creator accounts drill ==');
  if (!(await waitForServer())) {
    console.log(serverLog.slice(-3000));
    throw new Error('server did not start');
  }

  // The platform Company row is created lazily by the API on first user
  // write; direct-Prisma seeds need it in place first.
  await prisma.company.upsert({
    where: { id: PLATFORM_COMPANY_ID },
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'top-speed-appliance', type: 'PLATFORM_OWNER', isPlatformOwner: true },
    update: {},
  });

  // Clean any prior run's drill rows.
  const old = await prisma.user.findMany({ where: { email: { endsWith: '@creator-drill.test' } }, select: { id: true } });
  const oldIds = old.map((u) => u.id);
  if (oldIds.length) {
    await prisma.mediaContent.deleteMany({ where: { ownerId: { in: oldIds } } });
    await prisma.speedyVerifyCode.deleteMany({ where: { userId: { in: oldIds } } });
    await prisma.user.deleteMany({ where: { id: { in: oldIds } } });
  }
  await prisma.mediaContent.deleteMany({ where: { slug: { startsWith: 'creator-a-first' } } });

  const owner = await seedUser({ email: 'owner@creator-drill.test', roles: ['COMPANY_OWNER'] }).catch(() => null)
    || await prisma.user.findFirst({ where: { email: 'owner@creator-drill.test' } });
  const manager = await seedUser({ email: 'manager@creator-drill.test', roles: ['MARKETING_MANAGER'] }).catch(() => null)
    || await prisma.user.findFirst({ where: { email: 'manager@creator-drill.test' } });
  await seedUser({ email: 'staff@creator-drill.test', roles: ['DISPATCHER'] }).catch(() => null);
  await seedUser({ email: 'customer@creator-drill.test', roles: ['CUSTOMER'] }).catch(() => null);

  const ownerLogin = await req('POST', '/auth/login', { body: { email: owner.email, password: 'Password123!' } });
  const ownerToken = ownerLogin.json?.token;
  check('owner login issues a session', Boolean(ownerToken), JSON.stringify(ownerLogin.json).slice(0, 200));
  const managerLogin = await req('POST', '/auth/login', { body: { email: manager.email, password: 'Password123!' } });
  const managerToken = managerLogin.json?.token;
  check('marketing manager login issues a session', Boolean(managerToken));
  const staffLogin = await req('POST', '/auth/login', { body: { email: 'staff@creator-drill.test', password: 'Password123!' } });
  const staffToken = staffLogin.json?.token;
  const customerLogin = await req('POST', '/auth/login', { body: { email: 'customer@creator-drill.test', password: 'Password123!' } });
  const customerToken = customerLogin.json?.token;

  /* ---- /auth/register still refuses the role -------------------------- */
  const reg = await req('POST', '/auth/register', {
    body: { email: 'sneak@creator-drill.test', password: 'Password123!', firstName: 'Sneak', role: 'CONTENT_CREATOR', termsAcceptance: TERMS },
  });
  check('POST /auth/register refuses CONTENT_CREATOR self-registration (403)', reg.status === 403, `got ${reg.status}`);
  const sneak = await prisma.user.findFirst({ where: { email: 'sneak@creator-drill.test' } });
  check('refused registration persisted no account', !sneak);

  /* ---- Work Time Access creation -------------------------------------- */
  const wtCreate = await req('POST', '/access-control/accounts', {
    token: ownerToken,
    body: { surface: 'content-creator', email: 'wt-creator@creator-drill.test', password: 'CreatorPass123', firstName: 'Wanda', lastName: 'Worktime' },
  });
  check('Work Time creates a CONTENT_CREATOR account (201)', wtCreate.status === 201, `got ${wtCreate.status} ${JSON.stringify(wtCreate.json).slice(0, 200)}`);
  const wtUser = wtCreate.json?.user || {};
  check('Work Time creator roles = [CONTENT_CREATOR]', JSON.stringify(wtUser.roles) === JSON.stringify(['CONTENT_CREATOR']), JSON.stringify(wtUser.roles));
  check('Work Time creator starts Speedy-Verify-unverified', wtUser.verifyRequired === true, JSON.stringify(wtUser.verifyRequired));
  check('Work Time creator Layer 2 flagged on', wtUser.layer2Required === true, JSON.stringify(wtUser.layer2Required));
  check('Work Time creator has NO employee number (external account)', !wtUser.employeeNumber, JSON.stringify(wtUser.employeeNumber));
  const wtDenied = await req('POST', '/access-control/accounts', {
    token: managerToken,
    body: { surface: 'content-creator', email: 'wt-second@creator-drill.test', password: 'CreatorPass123', firstName: 'Nope' },
  });
  check('Work Time creation is owner-only (manager 403)', wtDenied.status === 403, `got ${wtDenied.status}`);
  const wtLoginPending = await req('POST', '/auth/login', { body: { email: 'wt-creator@creator-drill.test', password: 'CreatorPass123' } });
  check('Work Time creator login denied before activation (SPEEDY_VERIFY_NO_CODE)',
    wtLoginPending.status === 403 && wtLoginPending.json?.code === 'SPEEDY_VERIFY_NO_CODE',
    `got ${wtLoginPending.status} ${JSON.stringify(wtLoginPending.json).slice(0, 200)}`);

  /* ---- Public signup --------------------------------------------------- */
  const signupBody = {
    email: 'casey@creator-drill.test', password: 'CreatorPass123', firstName: 'Casey', lastName: 'Creator',
    phone: '9545551234', creatorType: 'CREATOR', organization: 'Casey Films',
    portfolioLinks: ['https://example.com/casey-reel'], termsAcceptance: TERMS, companyWebsite: '',
  };
  const signup = await req('POST', '/creator/signup', { body: signupBody });
  check('public creator signup succeeds (201)', signup.status === 201, `got ${signup.status} ${JSON.stringify(signup.json).slice(0, 240)}`);
  check('signup answers PENDING Speedy Verify (no session issued)',
    signup.json?.speedyVerify?.status === 'PENDING' && !signup.json?.token,
    JSON.stringify(signup.json).slice(0, 200));
  const caseyRow = await prisma.user.findFirst({ where: { email: 'casey@creator-drill.test' } });
  check('signup persisted a CONTENT_CREATOR user', Boolean(caseyRow) && caseyRow.roles.includes('CONTENT_CREATOR'));
  check('signup user starts verifyRequired', caseyRow?.verifyRequired === true);
  check('signup user Layer 2 flagged on', caseyRow?.layer2Required === true);
  check('signup user has no employee number', !caseyRow?.employeeNumber);
  // Event persistence is fire-and-forget (platformEventsRepo) — poll briefly.
  let appEvent = null;
  for (let i = 0; i < 10 && !appEvent; i += 1) {
    appEvent = await prisma.platformEvent.findFirst({ where: { type: 'CREATOR_APPLICATION', entityId: caseyRow?.id } });
    if (!appEvent) await delay(300);
  }
  check('application details recorded as a CREATOR_APPLICATION event', Boolean(appEvent)
    && appEvent.details?.creatorType === 'CREATOR'
    && Array.isArray(appEvent.details?.portfolioLinks) && appEvent.details.portfolioLinks.length === 1,
    JSON.stringify(appEvent?.details).slice(0, 200));
  const pendingLogin = await req('POST', '/auth/login', { body: { email: 'casey@creator-drill.test', password: 'CreatorPass123' } });
  check('pending creator cannot sign in (SPEEDY_VERIFY_NO_CODE)',
    pendingLogin.status === 403 && pendingLogin.json?.code === 'SPEEDY_VERIFY_NO_CODE', `got ${pendingLogin.status}`);

  const dup = await req('POST', '/creator/signup', { body: signupBody });
  check('duplicate signup email refused (409)', dup.status === 409, `got ${dup.status}`);
  const noTerms = await req('POST', '/creator/signup', { body: { ...signupBody, email: 'noterms@creator-drill.test', termsAcceptance: undefined } });
  check('signup without terms refused (422)', noTerms.status === 422, `got ${noTerms.status}`);
  const badPhone = await req('POST', '/creator/signup', { body: { ...signupBody, email: 'badphone@creator-drill.test', phone: '5551234567' } });
  check('signup with an unassigned NANP area code refused (400 INVALID_PHONE)',
    badPhone.status === 400 && badPhone.json?.code === 'INVALID_PHONE', `got ${badPhone.status} ${JSON.stringify(badPhone.json).slice(0, 160)}`);
  const honey = await req('POST', '/creator/signup', { body: { ...signupBody, email: 'bot@creator-drill.test', companyWebsite: 'https://spam.example' } });
  check('honeypot signup gets the success shape (201)', honey.status === 201, `got ${honey.status}`);
  const botRow = await prisma.user.findFirst({ where: { email: 'bot@creator-drill.test' } });
  check('honeypot signup persisted NOTHING', !botRow);

  /* ---- Activation via the Speedy Verify panel endpoints ---------------- */
  await restartServer();
  const accounts = await req('GET', '/speedy-verify/accounts', { token: ownerToken });
  const caseyListed = (accounts.json?.data || []).find((a) => a.user?.email === 'casey@creator-drill.test');
  check('pending creator appears in the Speedy Verify accounts list', Boolean(caseyListed), `emails: ${JSON.stringify((accounts.json?.data || []).map((a) => a.user?.email))}`);
  check('pending creator listed with codeStatus NONE (no code yet)', caseyListed?.verify?.codeStatus === 'NONE' && caseyListed?.verify?.covered === true, JSON.stringify(caseyListed?.verify).slice(0, 160));
  const issue = await req('POST', '/speedy-verify/issue', { token: ownerToken, body: { userId: caseyRow.id } });
  check('owner issues the creator an access code (200, 8-digit formatted)',
    issue.status === 200 && /^\d{4} \d{4}$/.test(issue.json?.code || ''), `got ${issue.status} ${JSON.stringify(issue.json).slice(0, 120)}`);
  // Point the stored code at the drill-known value so the login helper can use it.
  await prisma.speedyVerifyCode.updateMany({
    where: { userId: caseyRow.id, status: 'ACTIVE' },
    data: { codeHash: await hashPassword(VERIFY_CODE) },
  });

  /* ---- Login pipeline: password → Speedy Verify → Layer 2 -------------- */
  const login1 = await req('POST', '/auth/login', { body: { email: 'casey@creator-drill.test', password: 'CreatorPass123' } });
  check('activated creator login asks for the Speedy Verify code (no token yet)',
    login1.status === 200 && login1.json?.code === 'SPEEDY_VERIFY_REQUIRED' && Boolean(login1.json?.challenge) && !login1.json?.token,
    `got ${login1.status} ${JSON.stringify(login1.json).slice(0, 200)}`);
  const verify1 = await req('POST', '/speedy-verify/verify', {
    body: { challenge: login1.json.challenge, code: VERIFY_CODE },
  });
  check('Speedy Verify passes into a Layer 2 challenge (still no token)',
    verify1.status === 200 && verify1.json?.layer2Required === true && Boolean(verify1.json?.challenge) && !verify1.json?.token,
    `got ${verify1.status} ${JSON.stringify(verify1.json).slice(0, 200)}`);
  const l2ChallengeJwt = verify1.json?.challenge;
  const l2RowId = l2ChallengeJwt ? challengeRowId(l2ChallengeJwt) : null;
  const l2Row = l2RowId ? await prisma.loginChallenge.findUnique({ where: { id: l2RowId } }) : null;
  check('Layer 2 challenge row exists for the creator', Boolean(l2Row));
  if (l2Row) {
    await prisma.loginChallenge.update({ where: { id: l2RowId }, data: { codeHash: await hashPassword(LAYER2_CODE) } });
  }
  const l2Verify = await req('POST', '/auth/layer2/verify', { body: { challenge: l2ChallengeJwt, code: LAYER2_CODE } });
  const creatorToken = l2Verify.json?.token;
  check('Layer 2 verify completes the creator session', l2Verify.status === 200 && Boolean(creatorToken), `got ${l2Verify.status}`);
  check('session user carries the CONTENT_CREATOR role', JSON.stringify(l2Verify.json?.user?.roles) === JSON.stringify(['CONTENT_CREATOR']));

  /* Role-mandatory Layer 2: flip the per-account flag OFF in the DB and
     prove the pipeline still challenges. */
  await prisma.user.update({ where: { id: caseyRow.id }, data: { layer2Required: false } });
  const login2 = await req('POST', '/auth/login', { body: { email: 'casey@creator-drill.test', password: 'CreatorPass123' } });
  const verify2 = await req('POST', '/speedy-verify/verify', {
    body: { challenge: login2.json?.challenge, code: VERIFY_CODE },
  });
  check('Layer 2 STILL required with layer2Required=false in the DB (role-mandatory)',
    verify2.status === 200 && verify2.json?.layer2Required === true && Boolean(verify2.json?.challenge) && !verify2.json?.token,
    `got ${verify2.status} ${JSON.stringify(verify2.json).slice(0, 200)}`);
  const l2Status = await req('GET', '/auth/layer2/status', { token: creatorToken });
  const l2s = l2Status.json?.layer2 ?? {};
  check('Layer 2 status view reports required + roleRequired for creators',
    l2s.required === true && l2s.roleRequired === true,
    JSON.stringify(l2s).slice(0, 200));
  const disable = await req('POST', '/auth/layer2/disable', { token: creatorToken, body: { password: 'CreatorPass123' } });
  check('creator cannot disable Layer 2 (400 LAYER2_ROLE_REQUIRED)',
    disable.status === 400 && disable.json?.code === 'LAYER2_ROLE_REQUIRED', `got ${disable.status} ${JSON.stringify(disable.json).slice(0, 160)}`);
  // The settings-update route accepts only phone/channel for ANY account —
  // `required` is not an updatable field there. Prove a creator's attempt
  // to smuggle required:false through it changes nothing: the returned
  // status view still reports the role-mandated requirement.
  const upd = await req('POST', '/auth/layer2/update', { token: creatorToken, body: { required: false, channel: 'EMAIL' } });
  check('settings update cannot switch Layer 2 off for a creator (still required)',
    upd.status === 200 && upd.json?.layer2?.required === true && upd.json?.layer2?.roleRequired === true,
    `upd ${upd.status}, view: ${JSON.stringify(upd.json?.layer2).slice(0, 160)}`);

  /* Challenge tokens are not sessions. */
  const l2ChallengeToken = verify2.json?.challenge;
  const misuse = await req('GET', '/media-os/creator/content', { token: l2ChallengeToken });
  check('a Layer 2 challenge id is not a session (401)', misuse.status === 401, `got ${misuse.status}`);

  /* ---- Work Time creator completes the same pipeline --------------------- */
  await restartServer();
  const wtRow = await prisma.user.findFirst({ where: { email: 'wt-creator@creator-drill.test' } });
  check('Work Time creator DB row has NO employee number', wtRow && !wtRow.employeeNumber, JSON.stringify(wtRow?.employeeNumber));
  await prisma.speedyVerifyCode.upsert({
    where: { id: `drill-wt-${wtRow.id}` },
    create: { id: `drill-wt-${wtRow.id}`, userId: wtRow.id, codeHash: await hashPassword(VERIFY_CODE), status: 'ACTIVE', issuedById: owner.id },
    update: { codeHash: await hashPassword(VERIFY_CODE), status: 'ACTIVE' },
  }).catch(async () => {
    await prisma.speedyVerifyCode.create({ data: { userId: wtRow.id, codeHash: await hashPassword(VERIFY_CODE), status: 'ACTIVE', issuedById: owner.id } });
  });
  const wtFlow = await creatorLogin('wt-creator@creator-drill.test', 'CreatorPass123');
  check('Work Time creator completes password → Verify → Layer 2', wtFlow.stage === 'done' && Boolean(wtFlow.token), `stage ${wtFlow.stage}`);
  const wtList = await req('GET', '/media-os/creator/content', { token: wtFlow.token });
  check('Work Time creator reaches the workspace', wtList.status === 200, `got ${wtList.status}`);

  /* ---- Creator B (ownership counterparty) -------------------------------- */
  const creatorB = await seedUser({ email: 'bella@creator-drill.test', roles: ['CONTENT_CREATOR'], verifyRequired: true, layer2Required: true, password: 'CreatorPass123' });
  await prisma.speedyVerifyCode.create({ data: { userId: creatorB.id, codeHash: await hashPassword(VERIFY_CODE), status: 'ACTIVE', issuedById: owner.id } });
  const bFlow = await creatorLogin('bella@creator-drill.test', 'CreatorPass123');
  check('creator B completes the pipeline', bFlow.stage === 'done' && Boolean(bFlow.token), `stage ${bFlow.stage}`);
  const tokenB = bFlow.token;

  /* ---- Workspace: create, scope, edit, submit ---------------------------- */
  const emptyList = await req('GET', '/media-os/creator/content', { token: creatorToken });
  check('creator A workspace starts empty', emptyList.status === 200 && (emptyList.json?.data || []).length === 0, `got ${emptyList.status}`);
  const created = await req('POST', '/media-os/creator/content', {
    token: creatorToken,
    body: { type: 'VIDEO', division: 'VIDEOS', title: 'Creator A first video', description: 'Fridge cooling basics', assetUrl: 'https://example.com/a-first.mp4', tags: ['refrigerator'] },
  });
  check('creator creates content (201, DRAFT)', created.status === 201 && created.json?.data?.status === 'DRAFT', `got ${created.status} ${JSON.stringify(created.json).slice(0, 200)}`);
  const itemA = created.json?.data?.id;
  check('created item carries the creator as owner', created.json?.data?.ownerId === caseyRow.id, JSON.stringify(created.json?.data?.ownerId));
  const dbItem = await prisma.mediaContent.findUnique({ where: { id: itemA } });
  check('DB row ownerId = creator A', dbItem?.ownerId === caseyRow.id);

  const bList = await req('GET', '/media-os/creator/content', { token: tokenB });
  check('creator B list does NOT contain A\u2019s item', bList.status === 200 && !(bList.json?.data || []).some((c) => c.id === itemA));
  const bDetail = await req('GET', `/media-os/creator/content/${itemA}`, { token: tokenB });
  check('creator B detail on A\u2019s item → 404', bDetail.status === 404, `got ${bDetail.status}`);
  const bPatch = await req('PATCH', `/media-os/creator/content/${itemA}`, { token: tokenB, body: { title: 'Hijacked title' } });
  check('creator B PATCH on A\u2019s item → 404', bPatch.status === 404, `got ${bPatch.status}`);
  const bSubmit = await req('POST', `/media-os/creator/content/${itemA}/submit`, { token: tokenB, body: {} });
  check('creator B submit on A\u2019s item → 404', bSubmit.status === 404, `got ${bSubmit.status}`);
  const bAsset = await req('POST', '/media-os/creator/assets', { token: tokenB, body: { contentId: itemA, kind: 'VIDEO', name: 'B asset' } });
  check('creator B asset-create on A\u2019s item → 404', bAsset.status === 404, `got ${bAsset.status}`);
  const bAssetsRead = await req('GET', `/media-os/creator/assets?contentId=${itemA}`, { token: tokenB });
  check('creator B asset-read on A\u2019s item → 404', bAssetsRead.status === 404, `got ${bAssetsRead.status}`);
  const afterB = await prisma.mediaContent.findUnique({ where: { id: itemA } });
  check('A\u2019s item untouched by B\u2019s attempts', afterB?.title === 'Creator A first video' && afterB?.status === 'DRAFT');

  const aPatch = await req('PATCH', `/media-os/creator/content/${itemA}`, { token: creatorToken, body: { title: 'Creator A first video (revised)' } });
  check('creator A edits own DRAFT (200)', aPatch.status === 200 && aPatch.json?.data?.title === 'Creator A first video (revised)', `got ${aPatch.status}`);
  const aAsset = await req('POST', '/media-os/creator/assets', { token: creatorToken, body: { contentId: itemA, kind: 'VIDEO', name: 'Main cut', url: 'https://example.com/a-first.mp4', rightsStatus: 'OWNED' } });
  check('creator A attaches an asset to own DRAFT (201)', aAsset.status === 201, `got ${aAsset.status} ${JSON.stringify(aAsset.json).slice(0, 160)}`);
  const aAssets = await req('GET', `/media-os/creator/assets?contentId=${itemA}`, { token: creatorToken });
  check('creator A reads own assets', aAssets.status === 200 && (aAssets.json?.data || []).length === 1, `got ${aAssets.status}`);

  const submit = await req('POST', `/media-os/creator/content/${itemA}/submit`, { token: creatorToken, body: {} });
  check('creator submits own item → IN_REVIEW', submit.status === 200 && submit.json?.data?.status === 'IN_REVIEW', `got ${submit.status}`);
  const editLocked = await req('PATCH', `/media-os/creator/content/${itemA}`, { token: creatorToken, body: { title: 'Sneaky edit' } });
  check('edits locked while IN_REVIEW (422)', editLocked.status === 422, `got ${editLocked.status}`);
  const assetLocked = await req('POST', '/media-os/creator/assets', { token: creatorToken, body: { contentId: itemA, kind: 'IMAGE', name: 'Late asset' } });
  check('asset attach locked while IN_REVIEW (422)', assetLocked.status === 422, `got ${assetLocked.status}`);
  const resubmit = await req('POST', `/media-os/creator/content/${itemA}/submit`, { token: creatorToken, body: {} });
  check('double submit refused (422)', resubmit.status === 422, `got ${resubmit.status}`);

  /* ---- Staff admin flow unaffected --------------------------------------- */
  const adminList = await req('GET', '/media-os/admin/content', { token: managerToken });
  const adminSees = (adminList.json?.data || []).find((c) => c.id === itemA);
  check('Media OS admin list includes the creator item with ownerId', Boolean(adminSees) && adminSees.ownerId === caseyRow.id, `found ${Boolean(adminSees)}`);
  const sendBack = await req('POST', `/media-os/admin/content/${itemA}/status`, { token: managerToken, body: { status: 'DRAFT' } });
  check('staff send-back IN_REVIEW → DRAFT works (existing transition)', sendBack.status === 200 && sendBack.json?.data?.status === 'DRAFT', `got ${sendBack.status}`);
  const editAgain = await req('PATCH', `/media-os/creator/content/${itemA}`, { token: creatorToken, body: { description: 'Revised after send-back' } });
  check('creator can edit again after send-back', editAgain.status === 200, `got ${editAgain.status}`);
  const submit2 = await req('POST', `/media-os/creator/content/${itemA}/submit`, { token: creatorToken, body: {} });
  check('creator resubmits after send-back', submit2.status === 200 && submit2.json?.data?.status === 'IN_REVIEW', `got ${submit2.status}`);
  const approve = await req('POST', `/media-os/admin/content/${itemA}/status`, { token: managerToken, body: { status: 'APPROVED' } });
  check('staff approve works', approve.status === 200 && approve.json?.data?.status === 'APPROVED', `got ${approve.status}`);
  const schedule = await req('POST', `/media-os/admin/content/${itemA}/status`, { token: managerToken, body: { status: 'SCHEDULED', publishAt: new Date(Date.now() + 3600_000).toISOString() } });
  check('staff schedule works', schedule.status === 200 && schedule.json?.data?.status === 'SCHEDULED', `got ${schedule.status}`);
  const publish = await req('POST', `/media-os/admin/content/${itemA}/status`, { token: managerToken, body: { status: 'PUBLISHED' } });
  check('staff publish works (creators never publish)', publish.status === 200 && publish.json?.data?.status === 'PUBLISHED', `got ${publish.status}`);
  const publicFeed = await req('GET', '/media-os/content?division=VIDEOS');
  check('published creator item is on the public Media OS feed',
    (publicFeed.json?.data || []).some((c) => c.id === itemA), `got ${publicFeed.status}`);
  const aFinal = await req('GET', `/media-os/creator/content/${itemA}`, { token: creatorToken });
  check('creator sees the recorded outcome (PUBLISHED + publishedAt)',
    aFinal.status === 200 && aFinal.json?.data?.status === 'PUBLISHED' && Boolean(aFinal.json?.data?.publishedAt), `got ${aFinal.status}`);

  /* ---- Gate matrix -------------------------------------------------------- */
  const creatorAdminList = await req('GET', '/media-os/admin/content', { token: creatorToken });
  check('creator refused at Media OS admin list (403)', creatorAdminList.status === 403, `got ${creatorAdminList.status}`);
  const creatorAdminCreate = await req('POST', '/media-os/admin/content', { token: creatorToken, body: { type: 'VIDEO', division: 'VIDEOS', title: 'Admin path attempt' } });
  check('creator refused at Media OS admin create (403)', creatorAdminCreate.status === 403, `got ${creatorAdminCreate.status}`);
  const staffOnCreator = await req('GET', '/media-os/creator/content', { token: staffToken });
  check('staff token refused at the creator surface (403)', staffOnCreator.status === 403, `got ${staffOnCreator.status}`);
  const customerOnCreator = await req('GET', '/media-os/creator/content', { token: customerToken });
  check('customer token refused at the creator surface (403)', customerOnCreator.status === 403, `got ${customerOnCreator.status}`);
  const anonCreator = await req('GET', '/media-os/creator/content');
  check('anonymous refused at the creator surface (401)', anonCreator.status === 401, `got ${anonCreator.status}`);

  const outChecks = [
    ['Book OS setter queue', 'GET', '/bookos/setter-queue'],
    ['CRM customers', 'GET', '/crm/customers'],
    ['Finance overview', 'GET', '/finance/overview'],
    ['Ad Studio campaigns', 'GET', '/ad-studio/campaigns'],
    ['Work Time Access surfaces', 'GET', '/access-control/surfaces'],
    ['Insights overview', 'GET', '/insights/overview'],
    ['Link Center options', 'GET', '/link-center/options'],
    ['Provider overview (Tech doors)', 'GET', '/provider/overview'],
    ['Platform events (staff feed)', 'GET', '/platform/events'],
  ];
  for (const [name, method, path] of outChecks) {
    const r = await req(method, path, { token: creatorToken });
    check(`creator refused OUT: ${name} (403)`, r.status === 403, `got ${r.status}`);
  }
  const pepperChat = await req('POST', '/pepper/chat', { token: creatorToken, body: { message: 'hello' } });
  check('creator refused OUT: Pepper chat (403)', pepperChat.status === 403, `got ${pepperChat.status}`);

  /* ---- Forgot / reset password -------------------------------------------- */
  await restartServer();
  const forgot = await req('POST', '/auth/forgot-password', { body: { email: 'casey@creator-drill.test' } });
  check('creator forgot-password answers the generic 200', forgot.status === 200, `got ${forgot.status}`);
  await delay(300);
  const outbox = await prisma.notificationOutbox.findMany({
    where: { to: 'casey@creator-drill.test' }, orderBy: { createdAt: 'desc' }, take: 10,
  });
  let resetToken = null;
  for (const row of outbox) {
    const text = JSON.stringify(row.payload || {});
    const m = text.match(/token=([A-Za-z0-9._-]+)/);
    if (m) { resetToken = m[1]; break; }
  }
  check('reset email reached the outbox with a token link', Boolean(resetToken), `rows ${outbox.length}`);
  if (resetToken) {
    const reset = await req('POST', '/auth/reset-password', { body: { token: resetToken, newPassword: 'NewCreatorPass1!' } });
    check('creator reset-password completes (200)', reset.status === 200, `got ${reset.status} ${JSON.stringify(reset.json).slice(0, 160)}`);
    const oldPw = await req('POST', '/auth/login', { body: { email: 'casey@creator-drill.test', password: 'CreatorPass123' } });
    check('old password no longer signs the creator in (401)', oldPw.status === 401, `got ${oldPw.status}`);
    const newPw = await req('POST', '/auth/login', { body: { email: 'casey@creator-drill.test', password: 'NewCreatorPass1!' } });
    check('new password enters the pipeline (Speedy Verify challenge)',
      newPw.status === 200 && Boolean(newPw.json?.challenge), `got ${newPw.status}`);
  }

  console.log(`\n== RESULT: ${passed} passed, ${failed} failed ==`);
  if (failures.length) { console.log('Failures:'); failures.forEach((f) => console.log(' -', f)); }
  return failed;
}

main()
  .catch((err) => { console.error(err); return 1; })
  .then(async (failCount) => {
    server.kill('SIGTERM');
    await prisma.$disconnect();
    process.exit(failCount ? 1 : 0);
  });
