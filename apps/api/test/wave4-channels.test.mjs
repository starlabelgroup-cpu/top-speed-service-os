/**
 * Wave-4 channels — verification harness (2026-11-20).
 *
 * F7 WhatsApp (owner flag, Meta Cloud API through the outbox),
 * F8 after-hours AI message-taking (ships dark; byte-identity of the
 * pre-existing voice flow with the flag off), F9 Sign in with Apple
 * (inert until configured; Google-identical account rules), F10
 * Stripe Terminal tap-to-pay (server money only).
 *
 * Two API boots against one LOCAL test database: server A with every
 * new channel UNconfigured/OFF, server B with all providers stubbed
 * in-process (Meta, OpenAI, Stripe, Apple). No real provider is ever
 * contacted. Usage:
 *   DATABASE_URL=postgresql://... DATABASE_URL_UNPOOLED=postgresql://...
 *   node test/wave4-channels.test.mjs
 * Exit code 0 = every check passed.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHmac, createSign, generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/services/passwords.js';
import { PLATFORM_COMPANY_ID, store } from '../src/data/store.js';
import { persistAssignment, persistBooking, persistCustomer } from '../src/db/bookingsRepo.js';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required (point it at a local TEST database).');
  process.exit(2);
}
process.env.DATABASE_URL_UNPOOLED ||= process.env.DATABASE_URL;

const PORT_A = 4781;
const PORT_B = 4782;
const BASE_A = `http://127.0.0.1:${PORT_A}/api/v1`;
const BASE_B = `http://127.0.0.1:${PORT_B}/api/v1`;
const PASSWORD = 'test-pass-1234';
const API_CWD = fileURLToPath(new URL('..', import.meta.url));

const IDS = {
  providerCompany: '40000000-0000-4000-8000-0000000000a1',
  provider: '40000000-0000-4000-8000-0000000000a2',
  tech: '40000000-0000-4000-8000-0000000000a3',
  providerCompany2: '40000000-0000-4000-8000-0000000000a4',
  provider2: '40000000-0000-4000-8000-0000000000a5',
  tech2: '40000000-0000-4000-8000-0000000000a6',
  owner: '40000000-0000-4000-8000-0000000000a7',
  dispatcher: '40000000-0000-4000-8000-0000000000a8',
  appleExisting: '40000000-0000-4000-8000-0000000000a9',
};
// One assignment per terminal scenario (+ T0 for the unconfigured boot).
const ASSIGNMENTS = ['b0', 'b1', 'b2', 'b3'].map((suffix, i) => ({
  customer: `40000000-0000-4000-8000-0000000000c${i}`,
  booking: `40000000-0000-4000-8000-0000000000d${i}`,
  assignment: `40000000-0000-4000-8000-0000000000e${i}`,
  suffix,
}));

const prisma = new PrismaClient();
let failures = 0;
let server = null;

function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}
function checkIncludes(label, haystack, needle) {
  const ok = String(haystack || '').includes(needle);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (want substring ${JSON.stringify(needle)})`);
}
function checkTrue(label, value) {
  if (!value) failures += 1;
  console.log(`${value ? 'PASS' : 'FAIL'}  ${label}`);
}

async function api(base, path, { token, method = 'GET', body, form, raw, headers = {} } = {}) {
  const finalHeaders = { ...headers };
  let payload;
  if (form) {
    finalHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
    payload = new URLSearchParams(form).toString();
  } else if (raw !== undefined) {
    payload = raw;
  } else if (body !== undefined) {
    finalHeaders['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  if (token) finalHeaders.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${path}`, { method, headers: finalHeaders, body: payload, redirect: 'manual' });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* TwiML / redirects */ }
  return { status: res.status, json, text, location: res.headers.get('location') };
}

async function login(base, email) {
  const { status, json } = await api(base, '/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  if (status !== 200 || !json?.token) throw new Error(`login failed for ${email}: ${status} ${JSON.stringify(json)}`);
  return json.token;
}

async function waitForServer(base) {
  // Generous window: this VM shares 1.5 CPUs across many parallel
  // drill suites, and a cold Prisma hydration can take minutes.
  for (let i = 0; i < 240; i += 1) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`server did not come up at ${base}`);
}

async function waitFor(label, fn, timeoutMs = 15000) {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 400));
  }
}

function bootApi(port, extraEnv) {
  server = spawn('node', ['src/server.js'], {
    cwd: API_CWD,
    env: {
      ...process.env,
      PORT: String(port),
      JWT_SECRET: 'wave4-test-secret',
      DATABASE_URL: process.env.DATABASE_URL,
      DATABASE_URL_UNPOOLED: process.env.DATABASE_URL_UNPOOLED,
      TWILIO_PHONE_NUMBER: '+18445550100',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[api] ${d}`));
  // Drain stdout: server.js logs boot + hydration there, and an
  // undrained pipe can block the child once its buffer fills.
  server.stdout.on('data', () => {});
  server.on('exit', (code, signal) => {
    console.error(`[api] child exited code=${code} signal=${signal}`);
  });
  return server;
}

async function stopApi() {
  if (!server) return;
  const current = server;
  server = null;
  current.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 600));
}

/* ------------------------- provider stubs ------------------------- */

const stubState = {
  metaRequests: [],
  openAiMode: 'ok',
  stripeIntents: new Map(),
  stripeRequests: [],
  appleClaims: null,
  appleBadKey: false,
};

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const rsaOther = generateKeyPairSync('rsa', { modulusLength: 2048 });
const APPLE_KID = 'drill-key-1';
const appleJwk = { ...rsa.publicKey.export({ format: 'jwk' }), kid: APPLE_KID, alg: 'RS256', use: 'sig' };
const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const APPLE_PRIVATE_KEY_PEM = ec.privateKey.export({ type: 'pkcs8', format: 'pem' });
const APPLE_CLIENT_ID = 'com.topspeed.drill';

function signIdToken(claims, badKey = false) {
  const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const input = `${enc({ alg: 'RS256', kid: APPLE_KID, typ: 'JWT' })}.${enc(claims)}`;
  const signer = createSign('RSA-SHA256');
  signer.update(input);
  const signature = signer.sign(badKey ? rsaOther.privateKey : rsa.privateKey).toString('base64url');
  return `${input}.${signature}`;
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function startStub(port, handler) {
  return new Promise((resolve) => {
    const stub = createServer(handler);
    stub.listen(port, '127.0.0.1', () => resolve(stub));
  });
}

async function startStubs() {
  const stubs = [];
  // Meta WhatsApp Cloud API: accept + record, return a message id.
  stubs.push(await startStub(4791, async (req, res) => {
    const body = JSON.parse((await readBody(req)) || '{}');
    stubState.metaRequests.push({ url: req.url, body, auth: req.headers.authorization });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ messaging_product: 'whatsapp', messages: [{ id: 'wamid.drill1' }] }));
  }));
  // OpenAI Responses API: structured extraction, or down.
  stubs.push(await startStub(4792, async (req, res) => {
    await readBody(req);
    if (stubState.openAiMode !== 'ok') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'drill outage' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      output_text: JSON.stringify({
        name: 'Jamie Rivera', appliance: 'Refrigerator', issue: 'Not cooling', callbackWindow: 'Tomorrow morning',
      }),
    }));
  }));
  // Stripe API: connection tokens + PaymentIntents with settable state.
  stubs.push(await startStub(4793, async (req, res) => {
    const raw = await readBody(req);
    const params = new URLSearchParams(raw);
    stubState.stripeRequests.push({ method: req.method, url: req.url, params: Object.fromEntries(params) });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url.startsWith('/v1/terminal/connection_tokens')) {
      res.end(JSON.stringify({ id: 'ct_drill', object: 'terminal.connection_token', secret: 'pst_test_secret' }));
      return;
    }
    if (req.method === 'POST' && req.url.startsWith('/v1/payment_intents')) {
      const id = `pi_drill_${stubState.stripeIntents.size + 1}`;
      stubState.stripeIntents.set(id, { status: 'requires_payment_method' });
      res.end(JSON.stringify({ id, object: 'payment_intent', client_secret: `${id}_secret`, status: 'requires_payment_method', amount: Number(params.get('amount') || 0) }));
      return;
    }
    const getMatch = req.url.match(/^\/v1\/payment_intents\/([\w-]+)$/);
    if (req.method === 'GET' && getMatch) {
      const intent = stubState.stripeIntents.get(getMatch[1]) || { status: 'requires_payment_method' };
      res.end(JSON.stringify({ id: getMatch[1], object: 'payment_intent', status: intent.status }));
      return;
    }
    res.end(JSON.stringify({}));
  }));
  // Apple: token exchange + JWKS.
  stubs.push(await startStub(4794, async (req, res) => {
    if (req.url.startsWith('/auth/keys')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ keys: [appleJwk] }));
      return;
    }
    if (req.url.startsWith('/auth/token')) {
      const params = new URLSearchParams(await readBody(req));
      const clientSecret = params.get('client_secret') || '';
      const header = JSON.parse(Buffer.from(clientSecret.split('.')[0] || '', 'base64url').toString('utf8') || '{}');
      stubState.appleClientSecretHeader = header;
      const claims = stubState.appleClaims || {};
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id_token: signIdToken(claims, stubState.appleBadKey), token_type: 'Bearer', expires_in: 3600 }));
      return;
    }
    res.writeHead(404);
    res.end('{}');
  }));
  return stubs;
}

/* ----------------------------- seeding ----------------------------- */

async function seed() {
  const passwordHash = await hashPassword(PASSWORD);
  await prisma.company.upsert({
    where: { id: PLATFORM_COMPANY_ID },
    update: {},
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'wave4-platform', type: 'PLATFORM_OWNER', isPlatformOwner: true },
  });
  for (const [companyId, providerId, techId, email, slug] of [
    [IDS.providerCompany, IDS.provider, IDS.tech, 'wave4-tech@test.local', 'wave4-provider'],
    [IDS.providerCompany2, IDS.provider2, IDS.tech2, 'wave4-tech2@test.local', 'wave4-provider2'],
  ]) {
    await prisma.company.upsert({
      where: { id: companyId },
      update: {},
      create: { id: companyId, name: `Wave4 Provider ${slug}`, slug, type: 'INDEPENDENT_PROVIDER' },
    });
    await prisma.provider.upsert({
      where: { id: providerId },
      update: {},
      create: { id: providerId, companyId, businessName: `Wave4 Provider ${slug}`, type: 'INDEPENDENT_PROVIDER', specialties: [], serviceCities: [] },
    });
    await prisma.user.upsert({
      where: { id: techId },
      update: { passwordHash },
      create: { id: techId, companyId, email, passwordHash, phone: '9545550110', roles: ['PROVIDER_TECH'], active: true },
    });
  }
  await prisma.user.upsert({
    where: { id: IDS.owner },
    update: { passwordHash },
    create: { id: IDS.owner, companyId: PLATFORM_COMPANY_ID, email: 'wave4-owner@test.local', passwordHash, phone: '9545550100', roles: ['COMPANY_OWNER'], active: true },
  });
  await prisma.user.upsert({
    where: { id: IDS.dispatcher },
    update: { passwordHash },
    create: { id: IDS.dispatcher, companyId: PLATFORM_COMPANY_ID, email: 'wave4-dispatch@test.local', passwordHash, phone: '9545550101', roles: ['DISPATCHER'], active: true },
  });
  // Pre-existing account the Apple callback must FIND, not duplicate:
  // Layer 2 off for it, so a successful Apple sign-in ends in a token.
  await prisma.user.upsert({
    where: { id: IDS.appleExisting },
    update: { passwordHash },
    create: {
      id: IDS.appleExisting, companyId: PLATFORM_COMPANY_ID, email: 'apple.existing@test.local',
      passwordHash, phone: null, roles: ['CUSTOMER'], active: true, layer2Required: false,
      emailVerifiedAt: new Date(), signupSource: 'WEB',
    },
  });

  const now = new Date().toISOString();
  for (const item of ASSIGNMENTS) {
    const customer = {
      id: item.customer, companyId: PLATFORM_COMPANY_ID, userId: null,
      name: `Wave4 Customer ${item.suffix}`, phone: '9545550178', email: `wave4-customer-${item.suffix}@test.local`,
      address: '742 Test Terrace', city: 'Fort Lauderdale', zip: '33311', createdAt: now,
    };
    const booking = {
      id: item.booking, companyId: PLATFORM_COMPANY_ID, customerId: customer.id,
      customer, referenceCode: `TS-W4${item.suffix.toUpperCase()}`, source: 'TEST',
      city: 'Fort Lauderdale', zip: '33311', appliance: 'Washer', issue: 'Not draining',
      preferredWindow: null, diagnosticFee: 99, diagnosticFeeCreditedTowRepair: true,
      diagnosticFeeCreditedTowardRepair: true, feeStatus: 'COLLECTED_AT_BOOKING',
      status: 'CONFIRMED',
      dispatch: { mode: 'HYBRID', stage: 'ASSIGNED', candidateProviderIds: [], assignmentIds: [item.assignment] },
      history: [], createdAt: now, updatedAt: now,
    };
    const assignment = {
      id: item.assignment, companyId: PLATFORM_COMPANY_ID, bookingId: booking.id,
      providerId: IDS.provider, providerCompanyId: IDS.providerCompany,
      status: 'APPROVED', dispatchMode: 'HYBRID', approvalRequired: true,
      approvedBy: 'Service Setters', approvedAt: now,
    };
    store.customers.set(customer.id, customer);
    store.bookings.set(booking.id, booking);
    store.dispatchAssignments.set(assignment.id, assignment);
    await persistCustomer(customer);
    await persistBooking(booking);
    await persistAssignment(assignment);
  }
}

async function cleanup() {
  try {
    await prisma.payment.deleteMany({ where: { serviceRequestId: { in: ASSIGNMENTS.map((a) => a.booking) } } });
    await prisma.invoice.deleteMany({ where: { serviceRequestId: { in: ASSIGNMENTS.map((a) => a.booking) } } }).catch(() => {});
    await prisma.dispatchAssignment.deleteMany({ where: { id: { in: ASSIGNMENTS.map((a) => a.assignment) } } });
    await prisma.serviceRequest.deleteMany({ where: { id: { in: ASSIGNMENTS.map((a) => a.booking) } } });
    await prisma.customer.deleteMany({ where: { id: { in: ASSIGNMENTS.map((a) => a.customer) } } });
    await prisma.user.deleteMany({ where: { email: { in: ['wave4-tech@test.local', 'wave4-tech2@test.local', 'wave4-owner@test.local', 'wave4-dispatch@test.local', 'apple.existing@test.local', 'apple.new@test.local'] } } });
    await prisma.provider.deleteMany({ where: { id: { in: [IDS.provider, IDS.provider2] } } });
    await prisma.company.deleteMany({ where: { id: { in: [IDS.providerCompany, IDS.providerCompany2] } } });
    await prisma.connection.deleteMany({ where: { source: 'TWILIO_AFTER_HOURS' } });
    await prisma.notificationOutbox.deleteMany({ where: {} }).catch(() => {});
    await prisma.notificationSetting.deleteMany({ where: { key: 'whatsappEnabled' } }).catch(() => {});
  } catch (error) {
    console.error('cleanup warning:', error.message);
  }
}

/* --------------------------- scenarios ----------------------------- */

const BOOKING_BODY = (name, phone) => ({
  customer: { name, phone, email: 'wave4-booker@test.local', address: '100 Test Ave' },
  city: 'Fort Lauderdale',
  zip: '33311',
  appliance: 'Refrigerator',
  issue: 'Not cooling',
});

async function whatsappEntries(base, token) {
  const { json } = await api(base, '/notifications?channel=whatsapp&limit=100', { token });
  return json?.data || [];
}

async function serverA() {
  console.log('\n--- Server A: all new channels OFF / unconfigured ---');
  // Explicit blanks: the OFF state must hold regardless of any
  // ambient environment the suite happens to run under.
  bootApi(PORT_A, {
    STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '',
    WHATSAPP_PHONE_NUMBER_ID: '', WHATSAPP_ACCESS_TOKEN: '',
    APPLE_CLIENT_ID: '', APPLE_TEAM_ID: '', APPLE_KEY_ID: '', APPLE_PRIVATE_KEY: '',
    AFTER_HOURS_AI_ENABLED: '', AFTER_HOURS_AI_ALWAYS: '',
    OPENAI_API_KEY: '', OPENAI_API_KEY_V2: '',
  });
  await waitForServer(BASE_A);
  const owner = await login(BASE_A, 'wave4-owner@test.local');
  const dispatcher = await login(BASE_A, 'wave4-dispatch@test.local');
  const tech = await login(BASE_A, 'wave4-tech@test.local');

  // F8 regression: the live voice flow, byte-identical with flags off.
  const voice = await api(BASE_A, '/twilio/voice/incoming', {
    method: 'POST',
    form: { To: '+18445550100', From: '+19545550199', CallSid: 'CA_drill_off' },
  });
  const expectedVoice =
    `<?xml version="1.0" encoding="UTF-8"?>\n<Response>` +
    `<Dial callerId="+19545550199" timeout="30"><Number>+19549317997</Number></Dial>` +
    `<Say voice="Polly.Joanna">Thanks for calling Top Speed Appliance. We&apos;re with another customer right now — please leave your name, number, and what appliance needs help, or book anytime at topspeedserviceos.com.</Say>` +
    `<Record maxLength="120" playBeep="true" method="POST" recordingStatusCallback="http://127.0.0.1:${PORT_A}/api/v1/twilio/voice/recording" recordingStatusCallbackMethod="POST"/>` +
    `<Say voice="Polly.Joanna">Thank you — we&apos;ll get back to you shortly. Goodbye.</Say></Response>`;
  check('F8 flag-off voice TwiML byte-identical', voice.text, expectedVoice);

  // F8: the step endpoint is inert while disabled.
  const step = await api(BASE_A, '/twilio/voice/after-hours/step?step=name', {
    method: 'POST',
    form: { SpeechResult: 'Jamie', From: '+19545550199', CallSid: 'CA_drill_off' },
  });
  check('F8 step endpoint inert when disabled', step.text, `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`);

  // F7 flag off: compose refused, bookings queue no WhatsApp entries.
  const composeOff = await api(BASE_A, '/notifications/whatsapp/send', {
    token: owner, method: 'POST', body: { to: '+19545550199', body: 'Hello from the office' },
  });
  check('F7 compose refused while flag off', composeOff.status, 403);
  check('F7 compose refusal reason', composeOff.json?.error, 'whatsapp_disabled');

  const booking1 = await api(BASE_A, '/bookings', { token: owner, method: 'POST', body: BOOKING_BODY('Wave4 Booker One', '9545550130') });
  check('F7 booking created (flag off)', booking1.status, 201);
  await new Promise((r) => setTimeout(r, 2500));
  check('F7 no WhatsApp entries while flag off', (await whatsappEntries(BASE_A, owner)).length, 0);

  // F7: the flag is owner-only.
  const flipByDispatcher = await api(BASE_A, '/notifications/settings', {
    token: dispatcher, method: 'PUT', body: { whatsappEnabled: true },
  });
  check('F7 dispatcher cannot flip the flag', flipByDispatcher.status, 403);
  check('F7 dispatcher flip refusal', flipByDispatcher.json?.error, 'whatsapp_owner_only');
  const flipByOwner = await api(BASE_A, '/notifications/settings', {
    token: owner, method: 'PUT', body: { whatsappEnabled: true },
  });
  check('F7 owner flips the flag', flipByOwner.status, 200);
  check('F7 flag now on', flipByOwner.json?.data?.whatsappEnabled, true);

  // F7 flag on but Meta unconfigured: entries queue and GATE honestly.
  const booking2 = await api(BASE_A, '/bookings', { token: owner, method: 'POST', body: BOOKING_BODY('Wave4 Booker Two', '9545550131') });
  check('F7 booking created (flag on, unconfigured)', booking2.status, 201);
  const gated = await waitFor('gated whatsapp entry', async () => {
    const entries = await whatsappEntries(BASE_A, owner);
    return entries.find((e) => e.status === 'GATED') || null;
  });
  check('F7 unconfigured entry gated', gated.status, 'GATED');
  check('F7 gated reason', gated.reason, 'WHATSAPP_NOT_CONFIGURED');
  check('F7 gated entry is the booking confirmation', gated.template, 'BOOKING_CONFIRMATION');

  // F9 unconfigured: status false + start 501 (the button stays hidden).
  const appleStatus = await api(BASE_A, '/auth/apple/status');
  check('F9 status unconfigured', appleStatus.json?.configured, false);
  const appleStart = await api(BASE_A, '/auth/apple');
  check('F9 start 501 unconfigured', appleStart.status, 501);

  // F10 unconfigured: connection token refuses honestly.
  const t0 = ASSIGNMENTS[0];
  await api(BASE_A, `/provider/assignments/${t0.assignment}/accept`, { token: tech, method: 'POST', body: {} });
  const tokenOff = await api(BASE_A, `/provider/assignments/${t0.assignment}/terminal/connection-token`, { token: tech, method: 'POST', body: {} });
  check('F10 connection-token 503 unconfigured', tokenOff.status, 503);
  check('F10 503 reason', tokenOff.json?.error, 'payments_not_configured');

  // Public sanity after all router changes (shared-prefix trap).
  check('payments/status public', (await api(BASE_A, '/payments/status')).status, 200);
  await stopApi();
}

function gatherAction(twiml) {
  const match = String(twiml).match(/<Gather[^>]*action="([^"]+)"/);
  return match ? match[1].replace(/&amp;/g, '&') : null;
}

async function afterHoursWalk(base, callSid, answers) {
  const entry = await api(base, '/twilio/voice/incoming', {
    method: 'POST',
    form: { To: '+18444607038', From: '+19545550199', CallSid: callSid },
  });
  let action = gatherAction(entry.text);
  let last = entry;
  for (const answer of answers) {
    if (!action) break;
    // The Gather action is an absolute URL on the API origin — post
    // the step answer to it exactly as Twilio would.
    const res = await fetch(action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...answer, From: '+19545550199', CallSid: callSid }).toString(),
    });
    last = { status: res.status, text: await res.text(), json: null };
    action = gatherAction(last.text);
  }
  return last;
}

async function serverB() {
  console.log('\n--- Server B: providers stubbed, channels configured ---');
  bootApi(PORT_B, {
    WHATSAPP_PHONE_NUMBER_ID: '10987654321',
    WHATSAPP_ACCESS_TOKEN: 'drill-meta-token',
    WHATSAPP_API_BASE: 'http://127.0.0.1:4791',
    AFTER_HOURS_AI_ENABLED: '1',
    AFTER_HOURS_AI_ALWAYS: '1',
    OPENAI_API_KEY: 'drill-openai-key',
    OPENAI_API_BASE: 'http://127.0.0.1:4792',
    STRIPE_SECRET_KEY: 'sk_test_drill',
    STRIPE_API_BASE: 'http://127.0.0.1:4793',
    STRIPE_WEBHOOK_SECRET: 'whsec_drill',
    APPLE_CLIENT_ID,
    APPLE_TEAM_ID: 'TEAMDRILL1',
    APPLE_KEY_ID: 'KEYDRILL1',
    APPLE_PRIVATE_KEY: APPLE_PRIVATE_KEY_PEM,
    APPLE_AUTH_BASE: 'http://127.0.0.1:4794',
  });
  await waitForServer(BASE_B);
  const owner = await login(BASE_B, 'wave4-owner@test.local');
  const tech = await login(BASE_B, 'wave4-tech@test.local');
  const tech2 = await login(BASE_B, 'wave4-tech2@test.local');

  /* F7 — flag on (set on server A; re-assert here), Meta configured. */
  await api(BASE_B, '/notifications/settings', { token: owner, method: 'PUT', body: { whatsappEnabled: true } });
  const health = await api(BASE_B, '/notifications/health', { token: owner });
  check('F7 health whatsapp enabled', health.json?.data?.whatsapp?.enabled, true);
  check('F7 health whatsapp configured', health.json?.data?.whatsapp?.configured, true);

  const booking3 = await api(BASE_B, '/bookings', { token: owner, method: 'POST', body: BOOKING_BODY('Wave4 Booker Three', '9545550132') });
  check('F7 booking created (configured)', booking3.status, 201);
  const sent = await waitFor('sent whatsapp confirmation', async () => {
    const entries = await whatsappEntries(BASE_B, owner);
    return entries.find((e) => e.status === 'SENT') || null;
  });
  check('F7 confirmation SENT via Meta', sent.provider, 'meta-whatsapp');
  check('F7 provider message id recorded', sent.providerId, 'wamid.drill1');
  const templateCall = stubState.metaRequests.find((r) => r.body?.type === 'template');
  checkTrue('F7 Meta received a template send', Boolean(templateCall));
  check('F7 Meta template name', templateCall?.body?.template?.name, 'booking_confirmation');
  check('F7 Meta recipient digits-only', templateCall?.body?.to, '19545550132');
  check('F7 Meta auth header', templateCall?.auth, 'Bearer drill-meta-token');
  checkIncludes('F7 Meta path carries number id', stubState.metaRequests[0]?.url || '', '/v21.0/10987654321/messages');
  const refParam = templateCall?.body?.template?.components?.[0]?.parameters?.[3]?.text;
  checkTrue('F7 template param 4 is the booking reference', typeof refParam === 'string' && refParam.startsWith('TS-'));

  const office = await api(BASE_B, '/notifications/whatsapp/send', {
    token: owner, method: 'POST', body: { to: '+19545550199', body: 'Drill office reply — your tech is on the way.' },
  });
  check('F7 office reply queued', office.status, 201);
  await waitFor('sent office reply', async () => {
    const entries = await whatsappEntries(BASE_B, owner);
    return entries.find((e) => e.template === 'OFFICE_MESSAGE' && e.status === 'SENT') || null;
  });
  const textCall = stubState.metaRequests.find((r) => r.body?.type === 'text');
  check('F7 office reply sent as session text', textCall?.body?.text?.body, 'Drill office reply — your tech is on the way.');

  /* F8 — full walk with the AI structuring stub up. */
  const finalOk = await afterHoursWalk(BASE_B, 'CA_drill_ok', [
    { SpeechResult: 'Jamie Rivera' },
    { SpeechResult: 'refrigerator' },
    { SpeechResult: 'not cooling at all' },
    { Digits: '9545550142' },
    { SpeechResult: 'tomorrow morning' },
  ]);
  checkIncludes('F8 closing thanks the caller', finalOk.text, 'we have your message, reference TS-');
  checkIncludes('F8 closing promises only a callback', finalOk.text, 'will call you back');
  const connections = await api(BASE_B, '/connections', { token: owner });
  const record = (connections.json?.data || []).find((c) => c.type === 'AFTER_HOURS_MESSAGE');
  checkTrue('F8 callback task filed as a connection record', Boolean(record));
  checkIncludes('F8 record carries the structured name', record?.message || '', 'Jamie Rivera');
  checkIncludes('F8 record carries the AI-structured appliance', record?.message || '', 'Refrigerator');
  checkIncludes('F8 record carries the callback number', record?.message || '', '+19545550142');
  checkIncludes('F8 record notes AI structuring', record?.message || '', 'structured by: ai');
  checkIncludes('F8 record states no booking was made', record?.message || '', 'no booking was made');
  const allBookings = await api(BASE_B, '/bookings', { token: owner });
  const jamieBookings = (allBookings.json?.data || []).filter((b) => String(b.customer?.name || '').includes('Jamie'));
  check('F8 no booking created by the message service', jamieBookings.length, 0);
  const allEntries = await api(BASE_B, '/notifications?limit=300', { token: owner });
  checkTrue('F8 staff alert queued', (allEntries.json?.data || []).some((e) => e.template === 'STAFF_SUBMISSION_ALERT' && e.reference === record.reference));

  /* F8 — AI down: the verbatim fallback still files the task. */
  stubState.openAiMode = 'down';
  const finalDown = await afterHoursWalk(BASE_B, 'CA_drill_down', [
    { SpeechResult: 'Pat Lee' },
    { SpeechResult: 'oven' },
    { SpeechResult: 'will not heat' },
    { Digits: '3055550111' },
    { SpeechResult: 'after five' },
  ]);
  checkIncludes('F8 AI-down walk still closes politely', finalDown.text, 'we have your message, reference TS-');
  const connections2 = await api(BASE_B, '/connections', { token: owner });
  const record2 = (connections2.json?.data || []).find((c) => c.type === 'AFTER_HOURS_MESSAGE' && (c.message || '').includes('Pat Lee'));
  checkTrue('F8 AI-down task filed verbatim', Boolean(record2));
  checkIncludes('F8 verbatim fallback noted', record2?.message || '', 'structured by: verbatim');
  stubState.openAiMode = 'ok';

  /* F9 — Apple configured against the stub. */
  const appleStatus = await api(BASE_B, '/auth/apple/status');
  check('F9 status configured', appleStatus.json?.configured, true);
  const appleStart = await api(BASE_B, '/auth/apple?next=/connect-pro-app');
  check('F9 start redirects to Apple', appleStart.status, 302);
  checkIncludes('F9 authorize URL is Apple-shaped', appleStart.location || '', 'http://127.0.0.1:4794/auth/authorize?');
  checkIncludes('F9 authorize carries the client id', appleStart.location || '', `client_id=${encodeURIComponent(APPLE_CLIENT_ID)}`);
  checkIncludes('F9 authorize uses form_post', appleStart.location || '', 'response_mode=form_post');

  const stateFor = (next) => Buffer.from(JSON.stringify({ next }), 'utf8').toString('base64url');
  const nowSec = Math.floor(Date.now() / 1000);
  stubState.appleClaims = {
    iss: 'https://appleid.apple.com', aud: APPLE_CLIENT_ID, sub: 'apple-user-new',
    exp: nowSec + 600, iat: nowSec, email: 'apple.new@test.local', email_verified: 'true',
  };
  const cbNew = await api(BASE_B, '/auth/apple/callback', {
    method: 'POST',
    form: {
      code: 'drill-code', state: stateFor('/app'),
      user: JSON.stringify({ name: { firstName: 'Apple', lastName: 'New' } }),
    },
  });
  check('F9 new-user callback redirects', cbNew.status, 302);
  checkIncludes('F9 new user lands in the Layer 2 step', cbNew.location || '', 'layer2=');
  check('F9 client secret is an ES256 JWT with the key id', stubState.appleClientSecretHeader?.kid, 'KEYDRILL1');
  check('F9 client secret alg', stubState.appleClientSecretHeader?.alg, 'ES256');
  const createdUser = await prisma.user.findFirst({ where: { email: 'apple.new@test.local' } });
  check('F9 account created with Apple source', createdUser?.signupSource, 'APPLE_SIGNIN');
  check('F9 account name from first consent', createdUser?.firstName, 'Apple');
  check('F9 account starts Layer-2 required', createdUser?.layer2Required, true);

  stubState.appleClaims = {
    iss: 'https://appleid.apple.com', aud: APPLE_CLIENT_ID, sub: 'apple-user-existing',
    exp: nowSec + 600, iat: nowSec, email: 'apple.existing@test.local', email_verified: true,
  };
  const cbExisting = await api(BASE_B, '/auth/apple/callback', {
    method: 'POST',
    form: { code: 'drill-code', state: stateFor('/connect-pro-app') },
  });
  check('F9 existing-user callback redirects', cbExisting.status, 302);
  checkIncludes('F9 existing user gets a session token', cbExisting.location || '', 'token=');
  const existingCount = await prisma.user.count({ where: { email: 'apple.existing@test.local' } });
  check('F9 existing account not duplicated', existingCount, 1);

  stubState.appleBadKey = true;
  stubState.appleClaims = {
    iss: 'https://appleid.apple.com', aud: APPLE_CLIENT_ID, sub: 'apple-user-bad',
    exp: nowSec + 600, iat: nowSec, email: 'apple.bad@test.local', email_verified: 'true',
  };
  const cbBad = await api(BASE_B, '/auth/apple/callback', {
    method: 'POST',
    form: { code: 'drill-code', state: stateFor('/app') },
  });
  checkTrue('F9 forged id_token refused (5xx, no session)', cbBad.status >= 500 && !(cbBad.location || '').includes('token='));
  const badCount = await prisma.user.count({ where: { email: 'apple.bad@test.local' } });
  check('F9 forged sign-in creates no account', badCount, 0);
  stubState.appleBadKey = false;

  /* F10 — Terminal: estimate → authorize → invoice → collect. */
  async function jobWithInvoice(assignmentId) {
    const A = `/provider/assignments/${assignmentId}`;
    await api(BASE_B, `${A}/accept`, { token: tech, method: 'POST', body: {} });
    const est = await api(BASE_B, `${A}/estimate`, {
      token: tech, method: 'POST',
      body: { kind: 'REPAIR', parts: [{ description: 'Drain pump', qty: 1, unitPriceCents: 4500 }], taxRatePercent: 7, discountCents: 0 },
    });
    check('F10 estimate saved', est.status, 201);
    await api(BASE_B, `${A}/estimate/authorize`, { token: tech, method: 'POST', body: { method: 'IN_PERSON_VERBAL', authorizedByName: 'Wave4 Customer' } });
    const inv = await api(BASE_B, `${A}/invoice`, { token: tech, method: 'POST', body: {} });
    checkTrue('F10 invoice generated', inv.status === 200 || inv.status === 201);
    return A;
  }

  // Happy path: webhook settles.
  const t1 = ASSIGNMENTS[1];
  const A1 = await jobWithInvoice(t1.assignment);
  const connToken = await api(BASE_B, `${A1}/terminal/connection-token`, { token: tech, method: 'POST', body: {} });
  check('F10 connection token issued', connToken.status, 200);
  check('F10 connection token secret', connToken.json?.data?.secret, 'pst_test_secret');
  const pay1 = await api(BASE_B, `${A1}/terminal/payment`, { token: tech, method: 'POST', body: {} });
  check('F10 payment intent created', pay1.status, 201);
  check('F10 intent amount is the exact balance due', pay1.json?.data?.amountCents, 15915);
  const intentCreate = stubState.stripeRequests.find((r) => r.method === 'POST' && r.url.startsWith('/v1/payment_intents'));
  check('F10 Stripe saw card_present', intentCreate?.params?.['payment_method_types[0]'] || intentCreate?.params?.payment_method_types, 'card_present');
  check('F10 Stripe metadata purpose', intentCreate?.params?.['metadata[purpose]'] || intentCreate?.params?.purpose, 'TERMINAL_JOB_PAYMENT');
  const intent1 = pay1.json.data.paymentIntentId;
  const payment1 = pay1.json.data.paymentId;

  const webhook = async (type, intentId) => {
    const raw = JSON.stringify({ id: 'evt_drill', type, data: { object: { id: intentId, metadata: { purpose: 'TERMINAL_JOB_PAYMENT' } } } });
    const t = Math.floor(Date.now() / 1000);
    const v1 = createHmac('sha256', 'whsec_drill').update(`${t}.${raw}`).digest('hex');
    return api(BASE_B, '/payments/webhook', { method: 'POST', raw, headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${t},v1=${v1}` } });
  };
  check('F10 webhook accepted', (await webhook('payment_intent.succeeded', intent1)).status, 200);
  const status1 = await api(BASE_B, `${A1}/terminal/payment/${payment1}`, { token: tech });
  check('F10 payment PAID after webhook', status1.json?.data?.status, 'PAID');
  check('F10 invoice PAID after webhook', status1.json?.data?.invoiceStatus, 'PAID');
  check('F10 balance zero after webhook', status1.json?.data?.balanceDueCents, 0);

  // Overpay protection: balance settled by hand first — the collected
  // payment stays PAID and the office is alerted, never clamped.
  const t2 = ASSIGNMENTS[2];
  const A2 = await jobWithInvoice(t2.assignment);
  const pay2 = await api(BASE_B, `${A2}/terminal/payment`, { token: tech, method: 'POST', body: {} });
  check('F10 second intent created', pay2.status, 201);
  const manual = await api(BASE_B, `${A2}/receipts`, { token: tech, method: 'POST', body: { method: 'CASH', amountCents: 15915, note: 'Paid cash instead' } });
  check('F10 manual receipt recorded', manual.status, 201);
  await webhook('payment_intent.succeeded', pay2.json.data.paymentIntentId);
  const status2 = await api(BASE_B, `${A2}/terminal/payment/${pay2.json.data.paymentId}`, { token: tech });
  check('F10 collected payment still PAID (real money)', status2.json?.data?.status, 'PAID');
  const allEntries2 = await api(BASE_B, '/notifications?limit=300', { token: owner });
  checkTrue('F10 office alerted to reconcile', (allEntries2.json?.data || []).some((e) => e.template === 'STAFF_SUBMISSION_ALERT' && e.reference === 'TS-W4B2' && String(e.message || '').includes('tap-to-pay payment needing reconciliation')));

  // Status-poll settlement: no webhook, Stripe reports succeeded.
  const t3 = ASSIGNMENTS[3];
  const A3 = await jobWithInvoice(t3.assignment);
  const pay3 = await api(BASE_B, `${A3}/terminal/payment`, { token: tech, method: 'POST', body: {} });
  stubState.stripeIntents.set(pay3.json.data.paymentIntentId, { status: 'succeeded' });
  const status3 = await api(BASE_B, `${A3}/terminal/payment/${pay3.json.data.paymentId}`, { token: tech });
  check('F10 status poll settles the payment', status3.json?.data?.status, 'PAID');
  check('F10 status poll zeroes the balance', status3.json?.data?.balanceDueCents, 0);

  // Another provider cannot see the payment.
  const foreign = await api(BASE_B, `${A1}/terminal/payment/${payment1}`, { token: tech2 });
  check('F10 foreign provider gets 404', foreign.status, 404);

  check('payments/status configured', (await api(BASE_B, '/payments/status')).json?.data?.configured, true);
  await stopApi();
}

async function main() {
  await seed();
  const stubs = await startStubs();
  try {
    await serverA();
    await serverB();
  } finally {
    for (const stub of stubs) stub.close();
  }
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(async () => {
    await stopApi();
    await cleanup();
    await prisma.$disconnect();
  });
