/**
 * PEPPER LISTS SIGN-IN FIX drills (2026-11-22).
 *
 * Covers the two server-side changes in the sign-in fix build, plus
 * the master-protection gate (this build touches auth):
 *
 *   1. Layer 2 SMS honesty: a Twilio create call that returns HTTP
 *      201 WITH an error_code / failed status in the body (the
 *      rejected toll-free verification case — the message is blocked
 *      carrier-side and never arrives) must surface as a FAILED send:
 *      POST /auth/layer2/send answers 502 LAYER2_SEND_FAILED, never
 *      "sent". A synchronous Twilio HTTP error behaves the same.
 *   2. Channel-switch escape: after a successful send on one channel,
 *      switching channels sends IMMEDIATELY (no 60s cooldown) so the
 *      email code can finish the sign-in when a text never arrives;
 *      a same-channel resend inside the window still gets the 429.
 *   3. Master protection: wrong password → 401 for master, staff and
 *      customer alike; the master (seeded layer2Required ON) signs
 *      in directly, repeatedly, never Verify/Layer-2 gated, and is
 *      not locked out by failed attempts; a flagged staff account
 *      still hits the Speedy Verify gate; a flagged customer still
 *      hits Layer 2, a wrong code is a 401 with attempts counted,
 *      and the email code completes the sign-in.
 *
 * Skeleton mode (no DATABASE_URL): the API runs on its in-memory
 * store; Twilio and Resend are stubbed on localhost via the
 * TWILIO_API_BASE / RESEND_API_BASE env seams — no real message
 * ever leaves the machine. Run: node test/pl-signin-fix.test.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../src/services/passwords.js';

if (process.env.DATABASE_URL) {
  console.error('DATABASE_URL must NOT be set for these drills (skeleton mode only).');
  process.exit(2);
}

const PORT = Number(process.env.TEST_PORT || 4597);
const STUB_PORT = PORT + 1;
const B = `http://127.0.0.1:${PORT}/api/v1`;
const PW = ['drill', 'pass', '1234'].join('-');
const WRONG_PW = ['wrong', 'pass', '9999'].join('-');
const PLATFORM_COMPANY_ID = '10000000-0000-4000-8000-000000000001';

const IDS = {
  master: '20000000-0000-4000-8000-0000000000m1'.replace('m', 'a'),
  staff: '20000000-0000-4000-8000-0000000000a2',
  customer: '20000000-0000-4000-8000-0000000000a3',
};
const EMAILS = {
  master: 'owner@plfix.test',
  staff: 'setter@plfix.test',
  customer: 'eric@plfix.test',
};

/* ---------------- provider stubs (Twilio + Resend) --------------- */
let twilioMode = 'blocked-in-body'; // 'blocked-in-body' | 'http-error' | 'ok'
const resendBodies = [];
const stub = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.url.includes('/Messages.json')) {
      if (twilioMode === 'blocked-in-body') return send(201, { sid: 'SM-stub-1', status: 'queued', error_code: 30032, error_message: 'Message blocked: toll-free messaging verification rejected' });
      if (twilioMode === 'http-error') return send(400, { code: 21612, message: 'The From phone number is not a valid, SMS-capable inbound phone number' });
      return send(201, { sid: 'SM-stub-2', status: 'queued', error_code: null, error_message: null });
    }
    if (req.url.includes('/Accounts/')) return send(200, { type: 'Full', status: 'active' });
    if (req.url === '/emails' && req.method === 'POST') {
      try { resendBodies.push(JSON.parse(raw)); } catch { resendBodies.push({}); }
      return send(200, { id: `stub-${resendBodies.length}` });
    }
    return send(404, { error: 'stub: unhandled' });
  });
});
await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r));

/* ---------------- seed + boot ------------------------------------ */
const [masterHash, staffHash, custHash, staffCodeHash] = await Promise.all([hashPassword(PW), hashPassword(PW), hashPassword(PW), hashPassword('24681357')]);
const STAFF_CODE = '24681357';
const seedUser = (id, email, hash, roles, extra = {}) => ({
  id, companyId: PLATFORM_COMPANY_ID, email, passwordHash: hash,
  firstName: 'Drill', lastName: 'User', phone: null, roles,
  active: true, emailVerifiedAt: new Date().toISOString(),
  verifyRequired: false, layer2Required: false, layer2Phone: null, layer2Channel: null,
  createdAt: new Date().toISOString(), ...extra,
});
const preloadPath = fileURLToPath(new URL('./.plfix-preload.mjs', import.meta.url));
writeFileSync(preloadPath, `
import { store } from '../src/data/store.js';
const seed = (u) => store.users.set(u.id, u);
seed(${JSON.stringify(seedUser(IDS.master, EMAILS.master, masterHash, ['COMPANY_OWNER'], { layer2Required: true, layer2Phone: '+15555550123', layer2Channel: 'SMS' }))});
seed(${JSON.stringify(seedUser(IDS.staff, EMAILS.staff, staffHash, ['DISPATCHER'], { verifyRequired: true }))});
store.speedyVerifyCodes.set(${JSON.stringify(IDS.staff)}, { id: 'svc-drill-1', userId: ${JSON.stringify(IDS.staff)}, codeHash: ${JSON.stringify(staffCodeHash)}, status: 'ACTIVE', issuedById: ${JSON.stringify(IDS.master)}, issuedAt: new Date().toISOString(), revokedAt: null, lastUsedAt: null, failedAttempts: 0, lockedUntil: null });
seed(${JSON.stringify(seedUser(IDS.customer, EMAILS.customer, custHash, ['CUSTOMER'], { layer2Required: true, layer2Phone: '+15555550123', layer2Channel: 'SMS' }))});
`);

const child = spawn(process.execPath, ['--import', preloadPath, 'src/server.js'], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  env: {
    ...process.env,
    PORT: String(PORT),
    JWT_SECRET: ['plfix', 'jwt', 'secret'].join('-'),
    ALLOW_DEMO_AUTH: 'false',
    RESEND_API_KEY: ['resend', 'stub', 'key'].join('-'),
    RESEND_API_BASE: `http://127.0.0.1:${STUB_PORT}`,
    TWILIO_ACCOUNT_SID: 'ACstub00000000000000000000000000',
    TWILIO_AUTH_TOKEN: ['twilio', 'stub', 'token'].join('-'),
    TWILIO_PHONE_NUMBER: '+18444607038',
    TWILIO_API_BASE: `http://127.0.0.1:${STUB_PORT}`,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let childLog = '';
child.stdout.on('data', (d) => { childLog += d; });
child.stderr.on('data', (d) => { childLog += d; });

let passed = 0, failed = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  if (ok) passed += 1; else failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}
function checkTrue(label, cond, detail = '') {
  if (cond) passed += 1; else failed += 1;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${cond ? '' : ` — ${detail}`}`);
}
async function req(method, path, body, headers = {}) {
  const r = await fetch(B + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep raw */ }
  return { status: r.status, json, text };
}
/* Auth routes answer with a FLAT body ({user, token, ...} /
   {error, code, ...}); some other routes nest under data. Read both. */
const data = (r) => (r.json && (r.json.data || r.json)) || {};
async function waitForHealth(tries = 90) {
  for (let i = 0; i < tries; i += 1) {
    try { const r = await fetch(B + '/health'); if (r.ok) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

try {
  /* Boot check — the production entry itself must come up. */
  checkTrue('BOOT: API boots and /health answers', await waitForHealth(), childLog.slice(-400));

  /* 1. Wrong password → 401 on the password path, for every tier. */
  for (const [tier, email] of Object.entries(EMAILS)) {
    const r = await req('POST', '/auth/login', { email, password: WRONG_PW });
    check(`wrong password → 401 (${tier})`, r.status, 401);
    checkTrue(`wrong password mints no session (${tier})`, !data(r).token);
  }

  /* 2. Master: direct session, repeatedly, never gated, no lockout. */
  for (let i = 1; i <= 3; i += 1) {
    const r = await req('POST', '/auth/login', { email: EMAILS.master, password: PW });
    check(`master sign-in #${i} → 200`, r.status, 200);
    checkTrue(`master sign-in #${i} mints a session directly`, typeof data(r).token === 'string');
    checkTrue(`master sign-in #${i} is NOT Layer-2 gated (despite layer2Required seed)`, data(r).layer2Required !== true);
    checkTrue(`master sign-in #${i} is NOT Speedy-Verify gated`, data(r).verifyRequired !== true);
  }
  {
    const bad = await req('POST', '/auth/login', { email: EMAILS.master, password: WRONG_PW });
    check('master wrong password still → 401', bad.status, 401);
    const good = await req('POST', '/auth/login', { email: EMAILS.master, password: PW });
    check('master signs in right after failed attempts (never locked out)', good.status, 200);
    const me = await req('GET', '/auth/me', undefined, { Authorization: `Bearer ${data(good).token}` });
    check('master /auth/me → 200', me.status, 200);
    check('master /auth/me email', data(me).user && data(me).user.email, EMAILS.master);
  }

  /* 3. Flagged staff: Speedy Verify gate intact — no session until
        the issued code verifies; a wrong code is rejected. */
  {
    const r = await req('POST', '/auth/login', { email: EMAILS.staff, password: PW });
    check('flagged staff login → 200 envelope', r.status, 200);
    check('flagged staff hits Speedy Verify', data(r).verifyRequired, true);
    checkTrue('flagged staff gets NO session before Verify', !data(r).token);
    checkTrue('flagged staff gets a Verify challenge', typeof data(r).challenge === 'string');
    const bad = await req('POST', '/speedy-verify/verify', { challenge: data(r).challenge, code: '00000000' });
    checkTrue('wrong Verify code is rejected (no session)', bad.status !== 200 && !data(bad).token, `status ${bad.status}`);
    const good = await req('POST', '/speedy-verify/verify', { challenge: data(r).challenge, code: STAFF_CODE });
    check('correct Verify code → 200', good.status, 200);
    checkTrue('correct Verify code mints the session', typeof data(good).token === 'string');
  }

  /* 4. Flagged customer: Layer 2 + the SMS honesty path. */
  const login = await req('POST', '/auth/login', { email: EMAILS.customer, password: PW });
  check('customer login → 200 envelope', login.status, 200);
  check('customer hits Layer 2', data(login).layer2Required, true);
  const challenge = data(login).challenge;
  checkTrue('customer gets a Layer 2 challenge', typeof challenge === 'string');
  const chList = data(login).channels || [];
  checkTrue('challenge offers EMAIL', chList.some((c) => c.channel === 'EMAIL' && c.available !== false), JSON.stringify(chList));
  checkTrue('challenge offers SMS (phone on file)', chList.some((c) => c.channel === 'SMS'), JSON.stringify(chList));

  /* 4a. Twilio accepts the API call but the message is blocked
         (error_code in a 201 body) → the API must NOT claim sent. */
  twilioMode = 'blocked-in-body';
  {
    const r = await req('POST', '/auth/layer2/send', { challenge, channel: 'SMS' });
    check('SMS blocked-in-body → 502 (not "sent")', r.status, 502);
    check('SMS blocked-in-body → LAYER2_SEND_FAILED', (r.json && r.json.code) || data(r).code, 'LAYER2_SEND_FAILED');
    checkTrue('SMS blocked-in-body does not claim sent', data(r).sent !== true);
  }
  /* 4b. Synchronous Twilio HTTP error → same honest failure. */
  twilioMode = 'http-error';
  {
    const r = await req('POST', '/auth/layer2/send', { challenge, channel: 'SMS' });
    check('SMS http-error → 502', r.status, 502);
    check('SMS http-error → LAYER2_SEND_FAILED', (r.json && r.json.code) || data(r).code, 'LAYER2_SEND_FAILED');
  }
  /* 4c. A genuinely accepted SMS send reports sent... */
  twilioMode = 'ok';
  {
    const r = await req('POST', '/auth/layer2/send', { challenge, channel: 'SMS' });
    check('SMS accepted → 200', r.status, 200);
    check('SMS accepted → sent:true', data(r).sent, true);
    check('SMS accepted → channel SMS', data(r).channel, 'SMS');
  }
  /* 4d. ...and switching to EMAIL inside the cooldown window sends
         immediately (the escape hatch), while a same-channel resend
         is still cooled down. */
  {
    const r = await req('POST', '/auth/layer2/send', { challenge, channel: 'EMAIL' });
    check('channel switch SMS→EMAIL inside cooldown → 200 (no 429)', r.status, 200);
    check('email send → sent:true', data(r).sent, true);
    checkTrue('email actually reached the provider stub', resendBodies.length >= 1);
    const again = await req('POST', '/auth/layer2/send', { challenge, channel: 'EMAIL' });
    check('same-channel resend inside cooldown → 429 (limit intact)', again.status, 429);
    check('same-channel resend → LAYER2_RESEND_COOLDOWN', (again.json && again.json.code) || data(again).code, 'LAYER2_RESEND_COOLDOWN');
  }
  /* 4e. Wrong code → 401 with attempts counted; the email code then
         completes the sign-in. */
  {
    const mail = resendBodies[resendBodies.length - 1] || {};
    const text = [mail.subject, mail.text, mail.html].filter(Boolean).join(' ');
    const m = text.match(/code is:?\s*(\d{6})/i) || text.match(/\b(\d{6})\b/);
    checkTrue('email code extractable from the provider capture', Boolean(m), text.slice(0, 160));
    const code = m && m[1];
    const wrong = code === '000000' ? '111111' : '000000';
    const bad = await req('POST', '/auth/layer2/verify', { challenge, code: wrong });
    check('wrong 2-step code → 401', bad.status, 401);
    check('wrong 2-step code → LAYER2_INVALID_CODE', (bad.json && bad.json.code) || data(bad).code, 'LAYER2_INVALID_CODE');
    check('wrong 2-step code → attemptsRemaining 4', data(bad).attemptsRemaining, 4);
    checkTrue('wrong 2-step code mints no session', !data(bad).token);
    const good = await req('POST', '/auth/layer2/verify', { challenge, code });
    check('email code completes sign-in → 200', good.status, 200);
    checkTrue('email code mints the session', typeof data(good).token === 'string');
    const me = await req('GET', '/auth/me', undefined, { Authorization: `Bearer ${data(good).token}` });
    check('post-Layer-2 /auth/me → 200', me.status, 200);
    check('post-Layer-2 /auth/me email', data(me).user && data(me).user.email, EMAILS.customer);
  }
} finally {
  child.kill('SIGTERM');
  stub.close();
  try { rmSync(preloadPath); } catch { /* ignore */ }
}

console.log(`\nPL SIGN-IN FIX DRILLS: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
