/**
 * Identity & payments trust — verification harness (2026-11-20,
 * Wave 3 items F2/F3/F4/F5).
 *
 * F2 Passkeys: a software WebAuthn authenticator (real EC P-256
 * keys, hand-built attestation/assertion objects) registers a
 * passkey after a normal sign-in and signs in with it. A flagged
 * account (Speedy Verify + Layer 2) that signs in by passkey still
 * hits BOTH code steps, in order, before any session exists — the
 * passkey replaces the password step only.
 * F3 Sessions: two devices sign in; the session list shows both with
 * the current one marked; revoking device A kills A's token (401)
 * while B keeps working; a legacy token WITHOUT a session id still
 * works (Rule Zero shape). A staff account signing in from a new
 * device queues exactly one SIGN_IN_ALERT outbox email; a customer
 * doing the same queues none.
 * F4 Pay over time: with no PAY_OVER_TIME_MIN_CENTS configured the
 * invoice checkout never offers installments (flag false, and the
 * Stripe stub never sees the option); with the threshold set, an
 * invoice at/above it offers them and a smaller one does not. The
 * invoice webhook lands a real receipt (a second checkout then
 * refuses: nothing due).
 * F5 Card on file: a homeowner is refused (403). A property-manager
 * account saves a card through a Stripe setup session (webhook
 * simulated with a correctly signed payload), then: charge without
 * the standing opt-in → refused and Stripe is never called; opt-in
 * on but no per-invoice approval → refused; approval given → the
 * charge succeeds, a PAID Payment row exists, and the invoice
 * balance is gone. A declined card records a FAILED payment and
 * leaves the balance untouched.
 *
 * Stripe and Resend are local stubs (STRIPE_API_BASE /
 * RESEND_API_BASE); Layer 2 codes are read from the captured Resend
 * payloads exactly like the email-change harness. Runs against a
 * LOCAL test database only. The API is booted six times because
 * the /auth rate limiter allows 10 requests per IP per 15 minutes
 * per process. Usage:
 *   set DATABASE_URL to a local TEST database connection string
 *   node test/identity-trust.test.mjs
 * Exit code 0 = every check passed.
 */
import { spawn } from 'node:child_process';
import {
  createHash,
  createHmac,
  createSign,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/services/passwords.js';
import { PLATFORM_COMPANY_ID } from '../src/data/store.js';

const DB_URL = process.env['DATABASE_' + 'URL'];
if (!DB_URL) {
  console.error('DATABASE_URL is required (point it at a local TEST database).');
  process.exit(2);
}
process.env['DATABASE_' + 'URL_UNPOOLED'] ||= DB_URL;
process.env['JWT_' + 'SECRET'] = 'identity-trust-drill-secret';

const { signAccessToken } = await import('../src/services/tokens.js');

const PORT = Number(process.env.TEST_PORT || 4493);
const STUB_PORT = PORT + 1;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const ORIGIN = `http://localhost:${PORT}`;
const RP_ID = 'localhost';
const PW = 'drill-pass-12345';
const VERIFY_CODE = '13572468';
const WEBHOOK_SECRET = 'whsec_identity_drill';

const IDS = {
  owner: '30000000-0000-4000-8000-0000000000a1',
  pkUser: '30000000-0000-4000-8000-0000000000a2',
  flagged: '30000000-0000-4000-8000-0000000000a3',
  staff: '30000000-0000-4000-8000-0000000000a4',
  staff2: '30000000-0000-4000-8000-0000000000a9',
  custSess: '30000000-0000-4000-8000-0000000000a5',
  pmGood: '30000000-0000-4000-8000-0000000000a6',
  pmBad: '30000000-0000-4000-8000-0000000000a7',
  home: '30000000-0000-4000-8000-0000000000a8',
  custPmGood: '30000000-0000-4000-8000-0000000000b1',
  custPmBad: '30000000-0000-4000-8000-0000000000b2',
  bkF5: '30000000-0000-4000-8000-0000000000c1',
  bkBad: '30000000-0000-4000-8000-0000000000c2',
  bkF4a: '30000000-0000-4000-8000-0000000000c3',
  bkF4b: '30000000-0000-4000-8000-0000000000c4',
  bkF4c: '30000000-0000-4000-8000-0000000000c5',
};
const EMAILS = {
  owner: 'owner@test.local',
  pkUser: 'pk-user@test.local',
  flagged: 'flagged@test.local',
  staff: 'staff@test.local',
  staff2: 'staff2@test.local',
  custSess: 'cust-sess@test.local',
  pmGood: 'pm-good@test.local',
  pmBad: 'pm-bad@test.local',
  home: 'home@test.local',
};

const prisma = new PrismaClient();
let server = null;
let failures = 0;
const captures = [];       // Resend payloads
const stripeCalls = [];    // { method, path, params }
let stripeSessionSeq = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

async function waitFor(fn, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function api(path, { method = 'POST', body, token, ua } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(ua ? { 'User-Agent': ua } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function login(email, ua) {
  const res = await api('/auth/login', { body: { email, password: PW }, ua });
  return res;
}

/* ------------------------- stubs ------------------------- */

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

const stub = createServer(async (req, res) => {
  const raw = await readBody(req);
  const url = new URL(req.url, 'http://stub');
  const json = (status, obj) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  if (url.pathname === '/emails') {
    captures.push(JSON.parse(raw || '{}'));
    return json(200, { id: 'stub-email' });
  }
  if (url.pathname.startsWith('/v1/')) {
    const params = Object.fromEntries(new URLSearchParams(raw));
    stripeCalls.push({ method: req.method, path: url.pathname, params });
    if (req.method === 'POST' && url.pathname === '/v1/checkout/sessions') {
      stripeSessionSeq += 1;
      const id = `cs_test_${stripeSessionSeq}`;
      return json(200, { id, url: `https://checkout.stripe.test/pay/${id}`, payment_intent: null, mode: params.mode || 'payment' });
    }
    if (req.method === 'POST' && url.pathname === '/v1/customers') {
      return json(200, { id: 'cus_stub_1' });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/v1/setup_intents/')) {
      return json(200, { id: url.pathname.split('/').pop(), payment_method: 'pm_stub_good', customer: 'cus_stub_1' });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/v1/payment_methods/')) {
      return json(200, { id: url.pathname.split('/').pop(), card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 } });
    }
    if (req.method === 'POST' && url.pathname.endsWith('/detach')) {
      return json(200, {});
    }
    if (req.method === 'POST' && url.pathname === '/v1/payment_intents') {
      if (params.payment_method === 'pm_stub_bad') {
        return json(402, { error: { message: 'Your card was declined.', code: 'card_declined' } });
      }
      return json(200, { id: `pi_stub_${stripeCalls.length}`, status: 'succeeded' });
    }
    return json(200, {});
  }
  return json(404, { error: { message: 'stub: not found' } });
});

function stripeCallsTo(path) {
  return stripeCalls.filter((c) => c.path === path);
}

async function sendWebhook(event) {
  const rawBody = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${rawBody}`).digest('hex');
  const res = await fetch(`${BASE}/payments/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${t},v1=${v1}` },
    body: rawBody,
  });
  return res.status;
}

/* ------------------- software authenticator ------------------- */

function cborHead(major, value) {
  const mt = major << 5;
  if (value < 24) return Buffer.from([mt | value]);
  if (value < 256) return Buffer.from([mt | 24, value]);
  if (value < 65536) { const b = Buffer.alloc(3); b[0] = mt | 25; b.writeUInt16BE(value, 1); return b; }
  const b = Buffer.alloc(5); b[0] = mt | 26; b.writeUInt32BE(value, 1); return b;
}
function cborEncode(v) {
  if (typeof v === 'number') return v >= 0 ? cborHead(0, v) : cborHead(1, -1 - v);
  if (typeof v === 'string') { const b = Buffer.from(v, 'utf8'); return Buffer.concat([cborHead(3, b.length), b]); }
  if (v instanceof Uint8Array) { const b = Buffer.from(v); return Buffer.concat([cborHead(2, b.length), b]); }
  if (Array.isArray(v)) return Buffer.concat([cborHead(4, v.length), ...v.map(cborEncode)]);
  if (v instanceof Map) {
    const parts = [cborHead(5, v.size)];
    for (const [k, val] of v) parts.push(cborEncode(k), cborEncode(val));
    return Buffer.concat(parts);
  }
  throw new Error('cbor: unsupported value');
}

function makeAuthenticator() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const cose = cborEncode(new Map([
    [1, 2], [3, -7], [-1, 1],
    [-2, Buffer.from(jwk.x, 'base64url')],
    [-3, Buffer.from(jwk.y, 'base64url')],
  ]));
  const credentialId = randomBytes(16);
  const credentialIdB64 = credentialId.toString('base64url');
  const rpIdHash = createHash('sha256').update(RP_ID).digest();
  let counter = 0;
  const clientData = (type, challenge) => Buffer.from(JSON.stringify({ type, challenge, origin: ORIGIN, crossOrigin: false }), 'utf8');
  return {
    credentialIdB64,
    create(challenge) {
      const cd = clientData('webauthn.create', challenge);
      const lenBuf = Buffer.alloc(2);
      lenBuf.writeUInt16BE(credentialId.length);
      const authData = Buffer.concat([
        rpIdHash, Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), lenBuf, credentialId, cose,
      ]);
      const attestationObject = cborEncode(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
      return {
        id: credentialIdB64, rawId: credentialIdB64, type: 'public-key',
        response: {
          attestationObject: attestationObject.toString('base64url'),
          clientDataJSON: cd.toString('base64url'),
          transports: ['internal'],
        },
        clientExtensionResults: {},
      };
    },
    get(challenge) {
      counter += 1;
      const cd = clientData('webauthn.get', challenge);
      const countBuf = Buffer.alloc(4);
      countBuf.writeUInt32BE(counter);
      const authData = Buffer.concat([rpIdHash, Buffer.from([0x05]), countBuf]);
      const sigBase = Buffer.concat([authData, createHash('sha256').update(cd).digest()]);
      const signature = createSign('SHA256').update(sigBase).sign(privateKey);
      return {
        id: credentialIdB64, rawId: credentialIdB64, type: 'public-key',
        response: {
          authenticatorData: authData.toString('base64url'),
          clientDataJSON: cd.toString('base64url'),
          signature: signature.toString('base64url'),
        },
        clientExtensionResults: {},
      };
    },
  };
}

/* ------------------------- server phases ------------------------- */

async function waitForServer() {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/v1/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('server did not come up');
}

function bootServer(extraEnv = {}) {
  const childEnv = { ...process.env, PORT: String(PORT), ...extraEnv };
  childEnv['JWT_' + 'SECRET'] = 'identity-trust-drill-secret';
  childEnv['RESEND_' + 'API_KEY'] = 'drill-resend-key';
  childEnv['RESEND_' + 'API_BASE'] = `http://127.0.0.1:${STUB_PORT}`;
  childEnv['EMAIL_' + 'FROM'] = 'Top Speed Appliance <service@topspeedappliance.net>';
  childEnv['STRIPE_' + 'SECRET_KEY'] = 'sk_test_stub';
  childEnv['STRIPE_' + 'API_BASE'] = `http://127.0.0.1:${STUB_PORT}`;
  childEnv['STRIPE_' + 'WEBHOOK_SECRET'] = WEBHOOK_SECRET;
  childEnv['WEBAUTHN_' + 'RP_ID'] = RP_ID;
  childEnv['WEBAUTHN_' + 'ORIGINS'] = ORIGIN;
  server = spawn('node', ['src/server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[api] ${d}`));
  return waitForServer();
}

async function stopServer() {
  if (!server) return;
  const stopped = new Promise((resolve) => server.once('exit', resolve));
  server.kill('SIGTERM');
  await Promise.race([stopped, new Promise((r) => setTimeout(r, 5000))]);
  server = null;
}

/* ------------------------- seeding ------------------------- */

async function seed() {
  const passwordHash = await hashPassword(PW);
  await prisma.company.upsert({
    where: { id: PLATFORM_COMPANY_ID },
    update: {},
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'identity-drill', type: 'PLATFORM_OWNER', isPlatformOwner: true },
  });
  const base = { companyId: PLATFORM_COMPANY_ID, passwordHash, phone: '9545550110', active: true };
  const users = [
    { ...base, id: IDS.owner, email: EMAILS.owner, firstName: 'Owner', lastName: 'Drill', roles: ['COMPANY_OWNER'] },
    { ...base, id: IDS.pkUser, email: EMAILS.pkUser, firstName: 'Pass', lastName: 'Key', roles: ['CUSTOMER'] },
    {
      ...base, id: IDS.flagged, email: EMAILS.flagged, firstName: 'Flag', lastName: 'Ged', roles: ['TECHNICIAN'],
      verifyRequired: true, layer2Required: true, layer2Channel: 'EMAIL',
    },
    { ...base, id: IDS.staff, email: EMAILS.staff, firstName: 'Staff', lastName: 'Setter', roles: ['DISPATCHER'] },
    { ...base, id: IDS.staff2, email: EMAILS.staff2, firstName: 'Staff', lastName: 'Two', roles: ['DISPATCHER'] },
    { ...base, id: IDS.custSess, email: EMAILS.custSess, firstName: 'Sess', lastName: 'Customer', roles: ['CUSTOMER'] },
    { ...base, id: IDS.pmGood, email: EMAILS.pmGood, firstName: 'Pm', lastName: 'Good', roles: ['CUSTOMER'], signupAudience: 'property-manager' },
    { ...base, id: IDS.pmBad, email: EMAILS.pmBad, firstName: 'Pm', lastName: 'Bad', roles: ['CUSTOMER'], signupAudience: 'commercial' },
    { ...base, id: IDS.home, email: EMAILS.home, firstName: 'Home', lastName: 'Owner', roles: ['CUSTOMER'], signupAudience: 'homeowner' },
  ];
  for (const user of users) {
    await prisma.user.upsert({ where: { id: user.id }, update: { passwordHash }, create: user });
  }
  // The flagged account's issued Speedy Verify code (hash only).
  await prisma.speedyVerifyCode.create({
    data: {
      id: randomUUID(),
      userId: IDS.flagged,
      codeHash: await hashPassword(VERIFY_CODE),
      status: 'ACTIVE',
      issuedById: IDS.owner,
    },
  });
  // Customers + bookings + invoices for the money phases.
  await prisma.customer.create({
    data: { id: IDS.custPmGood, companyId: PLATFORM_COMPANY_ID, userId: IDS.pmGood, name: 'Pm Good', phone: '9545550201', email: EMAILS.pmGood, city: 'Davie', zip: '33314' },
  });
  await prisma.customer.create({
    data: { id: IDS.custPmBad, companyId: PLATFORM_COMPANY_ID, userId: IDS.pmBad, name: 'Pm Bad', phone: '9545550202', email: EMAILS.pmBad, city: 'Davie', zip: '33314' },
  });
  const bookings = [
    [IDS.bkF5, IDS.custPmGood, 'TS-W3F5', 300],
    [IDS.bkBad, IDS.custPmBad, 'TS-W3BAD', 120],
    [IDS.bkF4a, IDS.custPmGood, 'TS-W3F4A', 300],
    [IDS.bkF4b, IDS.custPmGood, 'TS-W3F4B', 500],
    [IDS.bkF4c, IDS.custPmGood, 'TS-W3F4C', 50],
  ];
  for (const [id, customerId, referenceCode, total] of bookings) {
    await prisma.serviceRequest.create({
      data: {
        id, companyId: PLATFORM_COMPANY_ID, customerId, city: 'Davie', zip: '33314',
        appliance: 'Washer', issue: 'Leaks', referenceCode, status: 'CONFIRMED', history: [],
      },
    });
    await prisma.invoice.create({
      data: {
        id: randomUUID(), companyId: PLATFORM_COMPANY_ID, serviceRequestId: id, customerId,
        status: 'SENT', subtotal: total, diagnosticFee: 99, diagnosticCredit: 99, total,
      },
    });
  }
  // The declined-card account starts with a card already on file and
  // auto-pay on — its per-invoice approval is given through the API.
  await prisma.storedCard.create({
    data: {
      id: randomUUID(), userId: IDS.pmBad, companyId: PLATFORM_COMPANY_ID,
      stripeCustomerId: 'cus_stub_1', stripePaymentMethodId: 'pm_stub_bad',
      brand: 'visa', last4: '0002', expMonth: 12, expYear: 2030, autoPayEnabled: true,
    },
  });
}

function capturesWithSubject(email, subjectPart) {
  return captures.filter((c) => JSON.stringify(c.to || '').includes(email) && String(c.subject || '').includes(subjectPart));
}
function codeFromCapture(capture) {
  const match = /code is: (\d{6})/.exec(capture?.text || '');
  return match ? match[1] : null;
}
async function layer2CodeFor(email, sendsBefore) {
  const found = await waitFor(() => capturesWithSubject(email, 'sign-in code').length > sendsBefore);
  if (!found) return null;
  return codeFromCapture(capturesWithSubject(email, 'sign-in code').at(-1));
}

/* ------------------------- phases ------------------------- */

async function phaseA() {
  console.log('\n— Phase A: passkey register + sign-in (F2) —');
  await bootServer();
  const auth = makeAuthenticator();

  const loginRes = await login(EMAILS.pkUser);
  check('A password login still works', loginRes.status, 200);
  const token = loginRes.json?.token;
  check('A password login issues a session', typeof token, 'string');

  const optRes = await api('/auth/passkeys/register/options', { token, body: {} });
  check('A register options', optRes.status, 200);
  const regVerify = await api('/auth/passkeys/register/verify', {
    token,
    body: { deviceLabel: 'Drill phone', response: auth.create(optRes.json?.data?.options?.challenge) },
  });
  check('A register verify', regVerify.status, 201);
  check('A credential stored without key material', regVerify.json?.data?.publicKey, undefined);
  check('A credential view issued', typeof regVerify.json?.data?.id, 'string');
  check('A credential label kept', regVerify.json?.data?.deviceLabel, 'Drill phone');

  const loginOpt = await api('/auth/passkeys/login/options', { body: { email: EMAILS.pkUser } });
  check('A login options', loginOpt.status, 200);
  check('A login options allow the credential', loginOpt.json?.data?.options?.allowCredentials?.length, 1);
  const loginVerify = await api('/auth/passkeys/login/verify', {
    body: { response: auth.get(loginOpt.json?.data?.options?.challenge) },
  });
  check('A passkey sign-in issues a session', typeof loginVerify.json?.token, 'string');
  const pkToken = loginVerify.json?.token;

  const me = await api('/auth/me', { method: 'GET', token: pkToken });
  check('A passkey session opens /auth/me', me.status, 200);
  check('A passkey session is the right user', me.json?.user?.email, EMAILS.pkUser);

  // A legacy token with NO session id (the pre-F3 shape, and the
  // Master's safety net) is untouched by the session machinery.
  const legacy = signAccessToken({ id: IDS.pkUser, companyId: PLATFORM_COMPANY_ID, email: EMAILS.pkUser, roles: ['CUSTOMER'] });
  const meLegacy = await api('/auth/me', { method: 'GET', token: legacy.token });
  check('A sid-less legacy token still works', meLegacy.status, 200);

  const list = await api('/auth/passkeys', { method: 'GET', token });
  check('A passkey list shows one', list.json?.data?.length, 1);

  const removed = await api(`/auth/passkeys/${list.json?.data?.[0]?.id}`, { method: 'DELETE', token });
  check('A passkey remove', removed.status, 200);
  const gone = await api('/auth/passkeys/login/options', { body: { email: EMAILS.pkUser } });
  check('A removed passkey no longer signs in', gone.status, 400);
  check('A removed passkey error code', gone.json?.code, 'PASSKEY_NOT_AVAILABLE');

  await stopServer();
}

let flaggedAuth = null;

async function phaseB1() {
  console.log('\n— Phase B1: flagged account — password pipeline + passkey registration (F2 gates) —');
  await bootServer();
  const auth = makeAuthenticator();
  flaggedAuth = auth;

  // Password path first: unchanged — verify challenge, then Layer 2.
  const loginRes = await login(EMAILS.flagged);
  check('B password login hits Speedy Verify', loginRes.json?.verifyRequired, true);
  const verifyRes = await api('/speedy-verify/verify', {
    body: { challenge: loginRes.json?.challenge, code: VERIFY_CODE },
  });
  check('B verify exchange demands Layer 2 next', verifyRes.json?.layer2Required, true);
  const sendsBefore = capturesWithSubject(EMAILS.flagged, 'sign-in code').length;
  await api('/auth/layer2/send', { body: { challenge: verifyRes.json?.challenge } });
  const code = await layer2CodeFor(EMAILS.flagged, sendsBefore);
  check('B layer 2 code delivered', typeof code, 'string');
  const l2 = await api('/auth/layer2/verify', { body: { challenge: verifyRes.json?.challenge, code } });
  const flaggedToken = l2.json?.token;
  check('B full pipeline issues a session', typeof flaggedToken, 'string');

  // Register a passkey from inside that hard-won session.
  const optRes = await api('/auth/passkeys/register/options', { token: flaggedToken, body: {} });
  check('B register options', optRes.status, 200);
  const regVerify = await api('/auth/passkeys/register/verify', {
    token: flaggedToken,
    body: { deviceLabel: 'Drill tech phone', response: auth.create(optRes.json?.data?.options?.challenge) },
  });
  check('B register verify', regVerify.status, 201);

  await stopServer();
}

async function phaseB2() {
  console.log('\n— Phase B2: flagged account — passkey sign-in hits the same gates (F2) —');
  await bootServer();
  const auth = flaggedAuth;

  // Passkey sign-in: the SAME gates, in the SAME order.
  const loginOpt = await api('/auth/passkeys/login/options', { body: { email: EMAILS.flagged } });
  check('B passkey login options', loginOpt.status, 200);
  const loginVerify = await api('/auth/passkeys/login/verify', {
    body: { response: auth.get(loginOpt.json?.data?.options?.challenge) },
  });
  check('B passkey sign-in does NOT issue a session yet', loginVerify.json?.token, undefined);
  check('B passkey sign-in hits Speedy Verify', loginVerify.json?.verifyRequired, true);
  const verifyRes2 = await api('/speedy-verify/verify', {
    body: { challenge: loginVerify.json?.challenge, code: VERIFY_CODE },
  });
  check('B passkey path then demands Layer 2', verifyRes2.json?.layer2Required, true);
  const sendsBefore2 = capturesWithSubject(EMAILS.flagged, 'sign-in code').length;
  await api('/auth/layer2/send', { body: { challenge: verifyRes2.json?.challenge } });
  const code2 = await layer2CodeFor(EMAILS.flagged, sendsBefore2);
  const l2b = await api('/auth/layer2/verify', { body: { challenge: verifyRes2.json?.challenge, code: code2 } });
  check('B passkey path completes to a session', typeof l2b.json?.token, 'string');
  const me = await api('/auth/me', { method: 'GET', token: l2b.json?.token });
  check('B final session opens /auth/me', me.status, 200);

  await stopServer();
}

const UA_A = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 DrilPhone';
const UA_B = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 DrillDesktop';
const UA_C = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 DrillLaptop';

async function phaseC1() {
  console.log('\n— Phase C1: new-device sign-in alerts (F3) —');
  await bootServer();

  const staffA = await login(EMAILS.staff, UA_A);
  const staffB = await login(EMAILS.staff, UA_B);
  check('C1 staff device A sign-in', staffA.status, 200);
  check('C1 staff device B sign-in', staffB.status, 200);

  // The new-device alert: exactly one outbox email for the staff
  // account's second device; the first sign-in is the silent baseline.
  const alertFound = await waitFor(async () => {
    const rows = await prisma.notificationOutbox.findMany({
      where: { template: 'SIGN_IN_ALERT', to: EMAILS.staff },
    });
    return rows.length >= 1;
  });
  check('C1 staff new-device alert queued', alertFound, true);
  const alertRows = await prisma.notificationOutbox.findMany({
    where: { template: 'SIGN_IN_ALERT', to: EMAILS.staff },
  });
  check('C1 exactly one staff alert', alertRows.length, 1);

  // A customer doing the same gets NO alert.
  await login(EMAILS.custSess, UA_A);
  await login(EMAILS.custSess, UA_B);
  await new Promise((r) => setTimeout(r, 1200));
  const custAlerts = await prisma.notificationOutbox.findMany({
    where: { template: 'SIGN_IN_ALERT', to: EMAILS.custSess },
  });
  check('C1 customer new-device alert absent', custAlerts.length, 0);

  await stopServer();
}

async function phaseC2() {
  console.log('\n— Phase C2: session manager (F3) —');
  await bootServer();

  const staffA = await login(EMAILS.staff2, UA_A);
  const staffB = await login(EMAILS.staff2, UA_B);
  check('C staff device A sign-in', staffA.status, 200);
  check('C staff device B sign-in', staffB.status, 200);
  const staffTokenA = staffA.json?.token;
  const staffTokenB = staffB.json?.token;

  // Session list: both devices, current marked on B.
  const sessions = await api('/auth/sessions', { method: 'GET', token: staffTokenB });
  check('C session list status', sessions.status, 200);
  check('C session list shows both devices', sessions.json?.data?.length, 2);
  const current = sessions.json?.data?.find((s) => s.current);
  check('C current session marked', typeof current?.id, 'string');
  const deviceA = sessions.json?.data?.find((s) => !s.current);
  check('C other device listed', typeof deviceA?.id, 'string');
  check('C device label derived from UA', /iPhone/.test(deviceA?.deviceLabel || ''), true);

  // Revoke device A: A's token dies, B's keeps working.
  const revoke = await api(`/auth/sessions/${deviceA?.id}`, { method: 'DELETE', token: staffTokenB });
  check('C revoke device A', revoke.status, 200);
  const meA = await api('/auth/me', { method: 'GET', token: staffTokenA });
  check('C revoked device token refused', meA.status, 401);
  const meB = await api('/auth/me', { method: 'GET', token: staffTokenB });
  check('C surviving device token works', meB.status, 200);

  // Revoke-others from a third device kills B, keeps C.
  const staffC = await login(EMAILS.staff2, UA_C);
  const staffTokenC = staffC.json?.token;
  const revokeOthers = await api('/auth/sessions/revoke-others', { token: staffTokenC, body: {} });
  check('C revoke-others status', revokeOthers.status, 200);
  check('C revoke-others count', revokeOthers.json?.data?.revoked, 1);
  const meB2 = await api('/auth/me', { method: 'GET', token: staffTokenB });
  check('C device B now refused', meB2.status, 401);
  const meC = await api('/auth/me', { method: 'GET', token: staffTokenC });
  check('C device C still works', meC.status, 200);

  await stopServer();
}

async function phaseD() {
  console.log('\n— Phase D: pay over time hidden (F4) + card on file gates (F5) —');
  await bootServer(); // NOTE: no PAY_OVER_TIME_MIN_CENTS in this phase.
  const staff = (await login(EMAILS.staff)).json?.token;
  const pm = (await login(EMAILS.pmGood)).json?.token;
  const home = (await login(EMAILS.home)).json?.token;
  const pmBad = (await login(EMAILS.pmBad)).json?.token;
  check('D staff session', typeof staff, 'string');
  check('D pm session', typeof pm, 'string');

  /* F4 without the owner's threshold: hidden everywhere. */
  const checkout = await api('/payments/invoice/checkout', { token: staff, body: { bookingId: IDS.bkF4a } });
  check('D invoice checkout created', checkout.status, 201);
  check('D pay-over-time flag off without config', checkout.json?.data?.payOverTimeAvailable, false);
  check('D threshold reported unconfigured', checkout.json?.data?.payOverTimeThresholdConfigured, false);
  const sessionCall = stripeCallsTo('/v1/checkout/sessions').at(-1);
  check('D stripe never saw installments', sessionCall?.params?.['payment_method_options[card][installments][enabled]'], undefined);
  const sessionId = String(checkout.json?.data?.url || '').split('/').pop();
  const whStatus = await sendWebhook({
    id: 'evt_drill_f4a', type: 'checkout.session.completed',
    data: { object: { id: sessionId, payment_intent: 'pi_stub_f4a', metadata: { bookingId: IDS.bkF4a, purpose: 'INVOICE' } } },
  });
  check('D invoice webhook accepted', whStatus, 200);
  const paidRow = await prisma.payment.findFirst({ where: { serviceRequestId: IDS.bkF4a, purpose: 'INVOICE', status: 'PAID' } });
  check('D invoice payment marked PAID', typeof paidRow?.id, 'string');
  const again = await api('/payments/invoice/checkout', { token: staff, body: { bookingId: IDS.bkF4a } });
  check('D receipt landed — nothing left due', again.status, 409);
  check('D nothing-due code', again.json?.code, 'NOTHING_DUE');

  /* F5 eligibility + setup + webhook save. */
  const homeSetup = await api('/payments/card-on-file/setup', { token: home, body: {} });
  check('D homeowner refused card setup', homeSetup.status, 403);
  check('D homeowner refusal code', homeSetup.json?.code, 'NOT_BUSINESS_ACCOUNT');

  const before = await api('/payments/card-on-file', { method: 'GET', token: pm });
  check('D pm eligible', before.json?.data?.eligible, true);
  check('D pm starts with no card', before.json?.data?.card, null);
  const setup = await api('/payments/card-on-file/setup', { token: pm, body: {} });
  check('D pm setup session', setup.status, 200);
  check('D setup url returned', typeof setup.json?.data?.url, 'string');
  const setupCall = stripeCallsTo('/v1/checkout/sessions').at(-1);
  check('D setup session is setup mode', setupCall?.params?.mode, 'setup');
  const setupSessionId = String(setup.json?.data?.url || '').split('/').pop();
  const wh2 = await sendWebhook({
    id: 'evt_drill_setup', type: 'checkout.session.completed',
    data: {
      object: {
        id: setupSessionId, mode: 'setup', setup_intent: 'seti_stub_1', customer: 'cus_stub_1',
        metadata: { purpose: 'CARD_ON_FILE', userId: IDS.pmGood },
      },
    },
  });
  check('D setup webhook accepted', wh2, 200);
  const cardSaved = await waitFor(async () => Boolean(await prisma.storedCard.findUnique({ where: { userId: IDS.pmGood } })));
  check('D card persisted from webhook', cardSaved, true);
  const after = await api('/payments/card-on-file', { method: 'GET', token: pm });
  check('D card brand', after.json?.data?.card?.brand, 'visa');
  check('D card last4', after.json?.data?.card?.last4, '4242');
  check('D auto-pay starts OFF', after.json?.data?.card?.autoPayEnabled, false);

  /* The three gates, in order. */
  const intentsBefore = stripeCallsTo('/v1/payment_intents').length;
  const charge1 = await api('/payments/invoice/autopay-charge', { token: staff, body: { bookingId: IDS.bkF5 } });
  check('D charge refused without opt-in', charge1.status, 409);
  check('D refusal code: opt-in', charge1.json?.code, 'AUTOPAY_NOT_ENABLED');
  const toggle = await api('/payments/card-on-file/autopay', { token: pm, body: { enabled: true } });
  check('D opt-in toggle', toggle.status, 200);
  const charge2 = await api('/payments/invoice/autopay-charge', { token: staff, body: { bookingId: IDS.bkF5 } });
  check('D charge refused without invoice approval', charge2.status, 409);
  check('D refusal code: approval', charge2.json?.code, 'INVOICE_NOT_APPROVED');
  check('D stripe never called while gated', stripeCallsTo('/v1/payment_intents').length, intentsBefore);

  const approval = await api(`/payments/invoice/${IDS.bkF5}/autopay-approval`, { token: pm, body: { approved: true } });
  check('D account holder approves invoice', approval.status, 200);
  check('D approval state', approval.json?.data?.autoPayApproval, 'APPROVED');
  const staffApproval = await api(`/payments/invoice/${IDS.bkF5}/autopay-approval`, { token: staff, body: { approved: true } });
  check('D staff cannot approve for the customer', staffApproval.status, 403);

  const charge3 = await api('/payments/invoice/autopay-charge', { token: staff, body: { bookingId: IDS.bkF5 } });
  check('D charge succeeds with both gates open', charge3.status, 200);
  check('D charge amount is the invoice balance', charge3.json?.data?.amountCents, 30000);
  check('D receipt applied', charge3.json?.data?.receiptApplied, true);
  const intentCall = stripeCallsTo('/v1/payment_intents').at(-1);
  check('D stripe charged off-session', intentCall?.params?.off_session, 'true');
  check('D stripe charged the balance', intentCall?.params?.amount, '30000');
  const paidF5 = await prisma.payment.findFirst({ where: { serviceRequestId: IDS.bkF5, purpose: 'INVOICE', status: 'PAID' } });
  check('D autopay payment row PAID', typeof paidF5?.id, 'string');
  const charge4 = await api('/payments/invoice/autopay-charge', { token: staff, body: { bookingId: IDS.bkF5 } });
  check('D second charge finds nothing due', charge4.status, 409);
  check('D second charge code', charge4.json?.code, 'NOTHING_DUE');

  /* Declined card: FAILED payment recorded, balance untouched. */
  const badApproval = await api(`/payments/invoice/${IDS.bkBad}/autopay-approval`, { token: pmBad, body: { approved: true } });
  check('D bad-card account approves its invoice', badApproval.status, 200);
  const badCharge = await api('/payments/invoice/autopay-charge', { token: pmBad, body: { bookingId: IDS.bkBad } });
  check('D declined charge is a 402', badCharge.status, 402);
  check('D declined code', badCharge.json?.code, 'CARD_CHARGE_FAILED');
  const failedRow = await prisma.payment.findFirst({ where: { serviceRequestId: IDS.bkBad, purpose: 'INVOICE', status: 'FAILED' } });
  check('D declined payment recorded FAILED', typeof failedRow?.id, 'string');
  const badCharge2 = await api('/payments/invoice/autopay-charge', { token: pmBad, body: { bookingId: IDS.bkBad } });
  check('D balance untouched after decline (still 402, not NOTHING_DUE)', badCharge2.status, 402);

  await stopServer();
}

async function phaseE() {
  console.log('\n— Phase E: pay over time with the owner threshold set (F4) —');
  await bootServer({ PAY_OVER_TIME_MIN_CENTS: '10000' });
  const staff = (await login(EMAILS.staff)).json?.token;

  const big = await api('/payments/invoice/checkout', { token: staff, body: { bookingId: IDS.bkF4b } });
  check('E big invoice checkout', big.status, 201);
  check('E pay-over-time offered at/above threshold', big.json?.data?.payOverTimeAvailable, true);
  const bigCall = stripeCallsTo('/v1/checkout/sessions').at(-1);
  check('E stripe saw installments enabled', bigCall?.params?.['payment_method_options[card][installments][enabled]'], 'true');

  const small = await api('/payments/invoice/checkout', { token: staff, body: { bookingId: IDS.bkF4c } });
  check('E small invoice checkout', small.status, 201);
  check('E pay-over-time hidden below threshold', small.json?.data?.payOverTimeAvailable, false);
  const smallCall = stripeCallsTo('/v1/checkout/sessions').at(-1);
  check('E stripe saw no installments for small invoice', smallCall?.params?.['payment_method_options[card][installments][enabled]'], undefined);

  await stopServer();
}

/* ------------------------- main ------------------------- */

await new Promise((resolve) => stub.listen(STUB_PORT, resolve));
try {
  await seed();
  await phaseA();
  await phaseB1();
  await phaseB2();
  await phaseC1();
  await phaseC2();
  await phaseD();
  await phaseE();
} finally {
  await stopServer();
  stub.close();
  await prisma.$disconnect();
}
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
