/**
 * Satellite Website Tracking Number System drills (2026-11-19).
 *
 * Proves, against a LOCAL test database only:
 *   - the ApplianceMan registry endpoints' gate matrix (anon 401,
 *     customer 403, dispatcher 403 — managers only, owner 200);
 *   - the idempotent seed: the shared 844 line + three mailboxes
 *     ACTIVE, eight PLANNED rows with null values (no invented
 *     numbers), and re-reads never duplicating rows;
 *   - registry CRUD: register (validation, duplicate 409, ACTIVE
 *     requires a value), update (assign a planned row its number,
 *     retire it), and NO delete route (404);
 *   - surface resolution: via tag -> satellite surface, FLAGSHIP_NET
 *     -> topspeed-net, lead-connection join -> appliancepro, unknown
 *     source -> null (honest), and the label riding the CRM booking
 *     brief, the Book OS setter queue + dispatch board, the provider
 *     overview and the provider /full record;
 *   - contact logging from simulated Twilio payloads: voice + SMS
 *     events land on the shared row's surface, MessageSid/CallSid
 *     dedupe collapses retries, an unregistered dialed number logs
 *     unattributed (platform, null row), and a dedicated number
 *     registered mid-drill starts attributing to its surface;
 *   - counts exactness: 28-day window boundary (a 29-day-old event
 *     and booking never count), per-surface booking counts, the
 *     platform count including flagship bookings, unattributed
 *     totals;
 *   - FAIL-OPEN: with the ContactEvent table dropped under a second
 *     server, the voice webhook returns TwiML byte-identical to the
 *     healthy server's — logging can never break a live call.
 *
 * Usage: DATABASE_URL=<local test db> node test/tracking-numbers.test.mjs
 * Exit code 0 = every check passed.
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
process.env.DATABASE_URL_UNPOOLED ||= process.env.DATABASE_URL;

const PORT = Number(process.env.TEST_PORT || 4495);
const PORT2 = PORT + 1;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const BASE2 = `http://127.0.0.1:${PORT2}/api/v1`;
const PASSWORD = 'test-pass-1234';
const DRILL_JWT = ['track', 'drill', 'jwt', 'secret'].join('-');
const SHARED_LINE = '+18444607038';

const IDS = {
  owner: '90000000-0000-4000-8000-0000000000d1',
  setter: '90000000-0000-4000-8000-0000000000d2',
  customerUser: '90000000-0000-4000-8000-0000000000d3',
  providerUser: '90000000-0000-4000-8000-0000000000d4',
  providerCompany: '90000000-0000-4000-8000-0000000000d5',
  provider: '90000000-0000-4000-8000-0000000000d6',
  custA: 'a0000000-0000-4000-8000-0000000000d1',
  bookTsar: 'b0000000-0000-4000-8000-0000000000d1',
  bookNet: 'b0000000-0000-4000-8000-0000000000d2',
  bookUnknown: 'b0000000-0000-4000-8000-0000000000d3',
  bookLead: 'b0000000-0000-4000-8000-0000000000d4',
  bookPepper: 'b0000000-0000-4000-8000-0000000000d5',
  bookFlagship: 'b0000000-0000-4000-8000-0000000000d6',
  bookOld: 'b0000000-0000-4000-8000-0000000000d7',
  bookProv: 'b0000000-0000-4000-8000-0000000000d8',
  connLead: 'd0000000-0000-4000-8000-0000000000d4',
  assignment: 'f0000000-0000-4000-8000-0000000000d1',
};
const EMAILS = {
  owner: 'track-owner@test.local',
  setter: 'track-setter@test.local',
  customerUser: 'track-customer@test.local',
  providerUser: 'track-provider@test.local',
};

const prisma = new PrismaClient();
let server = null;
let server2 = null;
let passed = 0;
let failed = 0;

function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  if (ok) passed += 1; else failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}
function checkTrue(label, value) { check(label, Boolean(value), true); }

async function api(path, { token, method = 'GET', body, base = BASE } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}

async function login(email) {
  const res = await api('/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  return res.json?.token || null;
}

async function twilioPost(path, fields, base = BASE) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'drill.example',
    },
    body: new URLSearchParams(fields).toString(),
  });
  return { status: res.status, text: await res.text() };
}

const isoDaysAgo = (days) => new Date(Date.now() - days * 86400000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForEvent(sid, tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    const rows = await prisma.contactEvent.findMany({ where: { externalSid: sid } });
    if (rows.length) return rows;
    await sleep(150);
  }
  return [];
}

async function seed() {
  const passwordHash = await hashPassword(PASSWORD);
  await prisma.company.upsert({
    where: { id: PLATFORM_COMPANY_ID }, update: {},
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'track-platform', type: 'PLATFORM_OWNER', isPlatformOwner: true },
  });
  await prisma.company.upsert({
    where: { id: IDS.providerCompany }, update: {},
    create: { id: IDS.providerCompany, name: 'Drill Appliance Co', slug: 'track-provider-co', type: 'NETWORK_BUSINESS' },
  });
  const users = [
    [IDS.owner, EMAILS.owner, ['COMPANY_OWNER'], PLATFORM_COMPANY_ID],
    [IDS.setter, EMAILS.setter, ['DISPATCHER'], PLATFORM_COMPANY_ID],
    [IDS.customerUser, EMAILS.customerUser, ['CUSTOMER'], PLATFORM_COMPANY_ID],
    [IDS.providerUser, EMAILS.providerUser, ['PROVIDER_OWNER'], IDS.providerCompany],
  ];
  for (const [id, email, roles, companyId] of users) {
    await prisma.user.upsert({
      where: { id },
      update: { passwordHash },
      create: { id, companyId, email, passwordHash, phone: '9545550110', roles, active: true },
    });
  }
  await prisma.provider.upsert({
    where: { id: IDS.provider }, update: {},
    create: { id: IDS.provider, companyId: IDS.providerCompany, businessName: 'Drill Appliance Co', type: 'NETWORK_BUSINESS', specialties: [], serviceCities: [] },
  });
  await prisma.customer.create({
    data: { id: IDS.custA, companyId: PLATFORM_COMPANY_ID, name: 'Track Tara', phone: '9545550201', email: 'tara@test.local', city: 'Lauderhill', zip: '33311' },
  });
  const booking = (data) => prisma.serviceRequest.create({ data: { companyId: PLATFORM_COMPANY_ID, customerId: IDS.custA, city: 'Lauderhill', zip: '33311', appliance: 'Refrigerator', issue: 'Not cooling', history: [], ...data } });
  // via tag names the satellite surface outright.
  await booking({ id: IDS.bookTsar, referenceCode: 'TS-TRKTSAR', source: 'SPEEDY_CHAT', viaTag: 'topspeedappliancerepair.com', status: 'PENDING_DISPATCH' });
  // The .net booking source resolves to topspeed-net.
  await booking({ id: IDS.bookNet, referenceCode: 'TS-TRKNET', source: 'FLAGSHIP_NET', status: 'PENDING_DISPATCH' });
  // An unmapped source resolves to null — counted nowhere.
  await booking({ id: IDS.bookUnknown, referenceCode: 'TS-TRKUNK', source: 'API', status: 'PENDING_DISPATCH' });
  // A lead booking: source is generic WEB_FORM, but the connection
  // behind it (BOOKING_CREATED history join) is appliancepro's.
  await prisma.connection.create({
    data: { id: IDS.connLead, name: 'Track Tara', phone: '9545550201', type: 'SERVICE_REQUEST', source: 'appliancepro-net', message: 'Fridge warm', reference: 'TS-TRKLEAD' },
  });
  await booking({
    id: IDS.bookLead, referenceCode: 'TS-TRKLEADBK', source: 'WEB_FORM', status: 'PENDING_DISPATCH',
    history: [{ type: 'BOOKING_CREATED', actor: 'lead-intake', at: new Date().toISOString(), connectionReference: 'TS-TRKLEAD', connectionType: 'SERVICE_REQUEST' }],
  });
  // The widget's pepperlists.com via (fixed in this build).
  await booking({ id: IDS.bookPepper, referenceCode: 'TS-TRKPEP', source: 'SPEEDY_CHAT', viaTag: 'pepperlists.com', status: 'PENDING_DISPATCH' });
  // A plain flagship chat booking.
  await booking({ id: IDS.bookFlagship, referenceCode: 'TS-TRKFLAG', source: 'SPEEDY_CHAT', status: 'PENDING_DISPATCH' });
  // Outside the 28-day window: never counted.
  await booking({ id: IDS.bookOld, referenceCode: 'TS-TRKOLD', source: 'SPEEDY_CHAT', viaTag: 'topspeedappliancerepair.com', status: 'PENDING_DISPATCH', createdAt: isoDaysAgo(29), updatedAt: isoDaysAgo(29) });
  // The provider's job: via names appliancepro.
  await booking({ id: IDS.bookProv, referenceCode: 'TS-TRKPROV', source: 'SPEEDY_CHAT', viaTag: 'appliancepro.net', status: 'CONFIRMED' });
  await prisma.dispatchAssignment.create({
    data: { id: IDS.assignment, companyId: PLATFORM_COMPANY_ID, serviceRequestId: IDS.bookProv, providerId: IDS.provider, status: 'APPROVED', dispatchMode: 'HYBRID', approvalRequired: false },
  });
}

function startServer(port, databaseUrl) {
  const env = {
    ...process.env,
    PORT: String(port),
    OPENAI_API_KEY: '',
    OPENAI_API_KEY_V2: '',
    TWILIO_API_BASE: 'http://127.0.0.1:9',
    RESEND_API_BASE: 'http://127.0.0.1:9',
  };
  env['JWT_' + 'SECRET'] = DRILL_JWT;
  if (databaseUrl) {
    env['DATABASE_' + 'URL'] = databaseUrl;
    env['DATABASE_' + 'URL_UNPOOLED'] = databaseUrl;
  }
  delete env['TWILIO_' + 'AUTH_TOKEN'];
  const proc = spawn('node', ['src/server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', (d) => process.stderr.write(`[api] ${d}`));
  return proc;
}

async function waitForServer(base) {
  for (let i = 0; i < 90; i += 1) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error('server did not come up');
}

async function main() {
  await seed();
  server = startServer(PORT);
  await waitForServer(BASE);
  check('health 200', (await api('/health')).status, 200);

  const owner = await login(EMAILS.owner);
  const setter = await login(EMAILS.setter);
  const customer = await login(EMAILS.customerUser);
  const provider = await login(EMAILS.providerUser);
  checkTrue('owner login', owner);
  checkTrue('provider login', provider);

  /* ---- gate matrix --------------------------------------------- */
  check('registry anon 401', (await api('/admin/tracking-numbers')).status, 401);
  check('registry customer 403', (await api('/admin/tracking-numbers', { token: customer })).status, 403);
  check('registry dispatcher 403 (not a manager)', (await api('/admin/tracking-numbers', { token: setter })).status, 403);
  check('register as customer 403', (await api('/admin/tracking-numbers', { token: customer, method: 'POST', body: { kind: 'PHONE', value: '+19545550100', surfaceKey: 'flagship-web', label: 'x' } })).status, 403);

  /* ---- seed shape ---------------------------------------------- */
  const reg1 = await api('/admin/tracking-numbers', { token: owner });
  check('registry owner 200', reg1.status, 200);
  const rows = reg1.json?.data?.numbers || [];
  check('seeded rows = 12', rows.length, 12);
  const shared = rows.find((r) => r.value === SHARED_LINE);
  checkTrue('shared 844 row exists', shared);
  check('shared row ACTIVE', shared?.status, 'ACTIVE');
  check('shared row surface platform', shared?.surfaceKey, 'platform');
  check('shared row shared=true', shared?.shared, true);
  check('shared row channels', JSON.stringify(shared?.channels), JSON.stringify(['VOICE', 'SMS']));
  const emails = rows.filter((r) => r.kind === 'EMAIL');
  check('three mailbox rows', emails.length, 3);
  checkTrue('mailboxes all ACTIVE', emails.every((r) => r.status === 'ACTIVE'));
  const planned = rows.filter((r) => r.status === 'PLANNED');
  check('eight PLANNED rows', planned.length, 8);
  checkTrue('PLANNED rows carry null value (no invented numbers)', planned.every((r) => r.value === null));
  checkTrue('planned topspeed-net row exists', planned.some((r) => r.surfaceKey === 'topspeed-net'));
  checkTrue('planned tsar row exists', planned.some((r) => r.surfaceKey === 'tsar'));
  checkTrue('planned topspeedrepairs row rides flagship-web', planned.some((r) => r.surfaceKey === 'flagship-web' && /topspeedrepairs/.test(r.label)));
  const reg2 = await api('/admin/tracking-numbers', { token: owner });
  check('seed idempotent on re-read', (reg2.json?.data?.numbers || []).length, 12);

  /* ---- counts: window + surfaces -------------------------------- */
  await prisma.contactEvent.create({ data: { channel: 'VOICE', trackingNumberId: shared.id, surfaceKey: 'platform', fromNumber: '+19545550101', toNumber: SHARED_LINE, externalSid: 'CA-SEED-1', createdAt: isoDaysAgo(2) } });
  await prisma.contactEvent.create({ data: { channel: 'VOICE', trackingNumberId: shared.id, surfaceKey: 'platform', fromNumber: '+19545550102', toNumber: SHARED_LINE, externalSid: 'CA-SEED-2', createdAt: isoDaysAgo(5) } });
  await prisma.contactEvent.create({ data: { channel: 'SMS', trackingNumberId: shared.id, surfaceKey: 'platform', fromNumber: '+19545550103', toNumber: SHARED_LINE, externalSid: 'SM-SEED-1', createdAt: isoDaysAgo(1) } });
  await prisma.contactEvent.create({ data: { channel: 'VOICE', trackingNumberId: shared.id, surfaceKey: 'platform', fromNumber: '+19545550104', toNumber: SHARED_LINE, externalSid: 'CA-SEED-OLD', createdAt: isoDaysAgo(29) } });
  await prisma.contactEvent.create({ data: { channel: 'SMS', trackingNumberId: null, surfaceKey: 'platform', fromNumber: '+19545550105', toNumber: '+19545550123', externalSid: 'SM-SEED-UNATTR', createdAt: isoDaysAgo(1) } });

  const reg3 = await api('/admin/tracking-numbers', { token: owner });
  const rows3 = reg3.json?.data?.numbers || [];
  const shared3 = rows3.find((r) => r.id === shared.id);
  check('shared calls28d excludes the 29-day-old call', shared3?.calls28d, 2);
  check('shared texts28d', shared3?.texts28d, 1);
  check('shared bookings28d = platform incl. flagship (1)', shared3?.bookings28d, 1);
  const bySurface = (key) => rows3.find((r) => r.surfaceKey === key && r.status === 'PLANNED');
  check('tsar bookings28d (old booking excluded)', bySurface('tsar')?.bookings28d, 1);
  check('topspeed-net bookings28d', bySurface('topspeed-net')?.bookings28d, 1);
  check('appliancepro bookings28d (lead join + provider job)', bySurface('appliancepro')?.bookings28d, 2);
  check('pepper-lists bookings28d', bySurface('pepper-lists')?.bookings28d, 1);
  check('cleanoutvents bookings28d is a real 0', bySurface('cleanoutvents')?.bookings28d, 0);
  const serviceMailbox = rows3.find((r) => r.value === 'service@topspeedserviceos.com');
  check('EMAIL row calls28d is null (kind does not support it)', serviceMailbox?.calls28d, null);
  check('EMAIL row bookings are surface-level (platform = 1)', serviceMailbox?.bookings28d, 1);
  check('unattributed texts28d', reg3.json?.data?.unattributedContacts28d?.texts, 1);
  check('unattributed calls28d', reg3.json?.data?.unattributedContacts28d?.calls, 0);

  /* ---- surfaceLabel in the four payloads ------------------------- */
  const detail = await api(`/crm/customers/${IDS.custA}`, { token: owner });
  check('crm detail 200', detail.status, 200);
  const brief = (ref) => (detail.json?.data?.bookings || []).find((b) => b.referenceCode === ref);
  check('crm brief: tsar surfaceKey', brief('TS-TRKTSAR')?.surfaceKey, 'tsar');
  check('crm brief: tsar label', brief('TS-TRKTSAR')?.surfaceLabel, 'topspeedappliancerepair.com');
  check('crm brief: net label', brief('TS-TRKNET')?.surfaceLabel, 'topspeedappliance.net');
  check('crm brief: unknown source -> null key', brief('TS-TRKUNK')?.surfaceKey, null);
  check('crm brief: unknown source -> null label', brief('TS-TRKUNK')?.surfaceLabel, null);
  check('crm brief: lead join -> appliancepro', brief('TS-TRKLEADBK')?.surfaceKey, 'appliancepro');
  check('crm brief: pepper via -> pepper-lists', brief('TS-TRKPEP')?.surfaceKey, 'pepper-lists');

  const queue = await api('/bookos/setter-queue', { token: setter });
  const qRow = (ref) => (queue.json?.data?.queue || []).find((q) => q.referenceCode === ref);
  check('setter queue: tsar label rides', qRow('TS-TRKTSAR')?.surfaceLabel, 'topspeedappliancerepair.com');
  check('setter queue: unknown -> null label', qRow('TS-TRKUNK')?.surfaceLabel, null);
  check('setter queue: lead join -> appliancepro label', qRow('TS-TRKLEADBK')?.surfaceLabel, 'appliancepro.net (Appliance Pro)');

  const board = await api('/bookos/dispatch-board', { token: setter });
  const boardRow = (board.json?.data?.groups?.PENDING_DISPATCH || []).find((b) => b.referenceCode === 'TS-TRKTSAR');
  check('dispatch board: tsar key rides', boardRow?.surfaceKey, 'tsar');

  const overview = await api('/provider/overview', { token: provider });
  check('provider overview 200', overview.status, 200);
  const offerRow = (overview.json?.data?.offers || []).find((a) => a.booking?.referenceCode === 'TS-TRKPROV');
  checkTrue('overview offer row present', offerRow);
  check('overview row: appliancepro label', offerRow?.booking?.surfaceLabel, 'appliancepro.net (Appliance Pro)');

  const full = await api(`/provider/assignments/${IDS.assignment}/full`, { token: provider });
  check('provider /full 200', full.status, 200);
  check('/full booking: appliancepro key', full.json?.data?.booking?.surfaceKey, 'appliancepro');
  check('/full booking: appliancepro label', full.json?.data?.booking?.surfaceLabel, 'appliancepro.net (Appliance Pro)');

  /* ---- Twilio contact logging ------------------------------------ */
  const voice = await twilioPost('/twilio/voice/incoming', { From: '+19545550199', To: SHARED_LINE, CallSid: 'CA-DRILL-1' });
  check('voice webhook 200', voice.status, 200);
  checkTrue('voice TwiML dials the office line presenting the caller', voice.text.includes('<Dial callerId="+19545550199" timeout="30"><Number>+19549317997</Number></Dial>'));
  const vRows = await waitForEvent('CA-DRILL-1');
  check('voice event logged once', vRows.length, 1);
  check('voice event on the shared row', vRows[0]?.trackingNumberId, shared.id);
  check('voice event surface platform', vRows[0]?.surfaceKey, 'platform');
  await twilioPost('/twilio/voice/incoming', { From: '+19545550199', To: SHARED_LINE, CallSid: 'CA-DRILL-1' });
  await sleep(400);
  check('voice retry dedupes on CallSid', (await prisma.contactEvent.findMany({ where: { externalSid: 'CA-DRILL-1' } })).length, 1);

  const sms = await twilioPost('/twilio/sms/incoming', { From: '+19545550199', To: SHARED_LINE, Body: 'fridge is warm', MessageSid: 'SM-DRILL-1' });
  check('sms webhook 200', sms.status, 200);
  checkTrue('sms auto-reply TwiML intact', sms.text.includes('<Message>Thanks for texting Top Speed Appliance'));
  const sRows = await waitForEvent('SM-DRILL-1');
  check('sms event logged once', sRows.length, 1);
  check('sms event channel', sRows[0]?.channel, 'SMS');
  await twilioPost('/twilio/sms/incoming', { From: '+19545550199', To: SHARED_LINE, Body: 'fridge is warm', MessageSid: 'SM-DRILL-1' });
  await sleep(400);
  check('sms retry dedupes on MessageSid', (await prisma.contactEvent.findMany({ where: { externalSid: 'SM-DRILL-1' } })).length, 1);

  const unreg = await twilioPost('/twilio/voice/incoming', { From: '+19545550199', To: '+19545550123', CallSid: 'CA-DRILL-UNREG' });
  check('unregistered-number call still 200', unreg.status, 200);
  const uRows = await waitForEvent('CA-DRILL-UNREG');
  check('unregistered event logged', uRows.length, 1);
  check('unregistered event unattributed (null row)', uRows[0]?.trackingNumberId, null);
  check('unregistered event surface platform', uRows[0]?.surfaceKey, 'platform');

  /* ---- registry CRUD ---------------------------------------------- */
  const badPhone = await api('/admin/tracking-numbers', { token: owner, method: 'POST', body: { kind: 'PHONE', value: '123', surfaceKey: 'flagship-web', label: 'Bad' } });
  check('register invalid phone 400', badPhone.status, 400);
  const activeNoValue = await api('/admin/tracking-numbers', { token: owner, method: 'POST', body: { kind: 'PHONE', surfaceKey: 'flagship-web', label: 'No number', status: 'ACTIVE' } });
  check('ACTIVE without a value 400', activeNoValue.status, 400);
  const dup = await api('/admin/tracking-numbers', { token: owner, method: 'POST', body: { kind: 'PHONE', value: SHARED_LINE, surfaceKey: 'flagship-web', label: 'Duplicate line' } });
  check('duplicate live value 409', dup.status, 409);
  const created = await api('/admin/tracking-numbers', { token: owner, method: 'POST', body: { kind: 'PHONE', value: '(954) 555-0142', surfaceKey: 'cleanoutvents', label: 'Cleanout Vents line (drill)' } });
  check('register 201', created.status, 201);
  check('register normalizes to E.164', created.json?.data?.value, '+19545550142');
  check('register with a value starts ACTIVE', created.json?.data?.status, 'ACTIVE');
  const createdId = created.json?.data?.id;

  // The newly registered dedicated number attributes immediately.
  await twilioPost('/twilio/voice/incoming', { From: '+19545550199', To: '+19545550142', CallSid: 'CA-DRILL-DEDICATED' });
  const dRows = await waitForEvent('CA-DRILL-DEDICATED');
  check('dedicated number attributes to its row', dRows[0]?.trackingNumberId, createdId);
  check('dedicated number attributes to its surface', dRows[0]?.surfaceKey, 'cleanoutvents');

  // Assign the PLANNED topspeed-net row its number and activate it.
  const netRow = rows.find((r) => r.surfaceKey === 'topspeed-net' && r.status === 'PLANNED');
  const activated = await api(`/admin/tracking-numbers/${netRow.id}`, { token: owner, method: 'POST', body: { value: '+19545550177', status: 'ACTIVE' } });
  check('planned row update 200', activated.status, 200);
  check('planned row now ACTIVE with value', activated.json?.data?.status, 'ACTIVE');
  check('planned row value set', activated.json?.data?.value, '+19545550177');
  await twilioPost('/twilio/sms/incoming', { From: '+19545550199', To: '+19545550177', Body: 'need a dryer fixed', MessageSid: 'SM-DRILL-NET' });
  const nRows = await waitForEvent('SM-DRILL-NET');
  check('activated row attributes texts to topspeed-net', nRows[0]?.surfaceKey, 'topspeed-net');

  // Retire it: attribution stops, the row remains (no delete).
  const retired = await api(`/admin/tracking-numbers/${netRow.id}`, { token: owner, method: 'POST', body: { status: 'RETIRED' } });
  check('retire 200', retired.status, 200);
  await twilioPost('/twilio/voice/incoming', { From: '+19545550199', To: '+19545550177', CallSid: 'CA-DRILL-RETIRED' });
  const rRows = await waitForEvent('CA-DRILL-RETIRED');
  check('retired number no longer attributes', rRows[0]?.trackingNumberId, null);
  const del = await fetch(`${BASE}/admin/tracking-numbers/${netRow.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${owner}` } });
  check('DELETE is not a route (404)', del.status, 404);
  const regFinal = await api('/admin/tracking-numbers', { token: owner });
  checkTrue('retired row still listed', (regFinal.json?.data?.numbers || []).some((r) => r.id === netRow.id && r.status === 'RETIRED'));

  /* ---- fail-open: logging down, TwiML identical -------------------- */
  const healthy = await twilioPost('/twilio/voice/incoming', { From: '+19545550199', To: SHARED_LINE, CallSid: 'CA-DRILL-HEALTHY' });
  const admin = new PrismaClient({ datasources: { db: { url: 'postgresql://postgres@127.0.0.1:5434/postgres' } } });
  await admin.$executeRawUnsafe('DROP DATABASE IF EXISTS track_failopen');
  await admin.$executeRawUnsafe('CREATE DATABASE track_failopen');
  await admin.$disconnect();
  const failUrl = 'postgresql://postgres@127.0.0.1:5434/track_failopen';
  const { spawnSync } = await import('node:child_process');
  const apiDir = fileURLToPath(new URL('..', import.meta.url));
  const mig = spawnSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: apiDir,
    env: { ...process.env, DATABASE_URL: failUrl, DATABASE_URL_UNPOOLED: failUrl },
    encoding: 'utf8',
  });
  check('fail-open db migrated', mig.status, 0);
  const migrator = new PrismaClient({ datasources: { db: { url: failUrl } } });
  server2 = startServer(PORT2, failUrl);
  await waitForServer(BASE2);
  await migrator.$executeRawUnsafe('DROP TABLE "ContactEvent"');
  await migrator.$disconnect();
  const broken = await twilioPost('/twilio/voice/incoming', { From: '+19545550199', To: SHARED_LINE, CallSid: 'CA-DRILL-BROKEN' }, BASE2);
  check('fail-open voice webhook still 200', broken.status, 200);
  check('fail-open TwiML byte-identical', broken.text, healthy.text);

  console.log(`\n== tracking-numbers: ${passed} passed, ${failed} failed ==`);
  if (server) server.kill('SIGTERM');
  if (server2) server2.kill('SIGTERM');
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
}

main().catch(async (error) => {
  console.error('DRILL ERROR', error);
  if (server) server.kill('SIGTERM');
  if (server2) server2.kill('SIGTERM');
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
