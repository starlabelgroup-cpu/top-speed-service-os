/**
 * Conversion tracking — verification harness (2026-11-20).
 *
 * Exercises the offline ad-conversion foundation end to end over
 * HTTP against a LOCAL test database:
 *   - click-ID / UTM capture on BOTH booking intakes (POST
 *     /speedy/book and POST /bookings) — every field stored verbatim
 *     in the ServiceRequest columns, nulls when absent, junk click
 *     IDs can never fail a booking, and the intake shield's honeypot
 *     discard still creates nothing when attribution rides along;
 *   - the offline-conversion export (GET /admin/conversions/export):
 *     manager-gated (anon 401, customer 403), Google-format CSV with
 *     the timezone Parameters line, a LEAD row at 99.00 for every
 *     gclid booking, a REVENUE row at the exact recorded amount only
 *     where a completed job has real money (PAID payment or recorded
 *     receipt), nothing for click-less bookings, and the parallel
 *     Microsoft (msclkid) file;
 *   - the Oversight summary read model (GET
 *     /admin/conversions/summary): captured counts by source +
 *     campaign, lead/revenue readiness, and the honest export state
 *     (manual CSV import; API upload awaiting the Google Ads API
 *     connection);
 *   - the shared client capture script (apps/web/shared/
 *     attribution-capture.js) in a stubbed browser: first touch
 *     inside the 30-day window wins over a later click, an expired
 *     touch is replaced, and TSOSBookingSubmitted pushes the
 *     booking_submitted dataLayer event.
 *
 * Usage: DATABASE_URL=<local test db> TEST_PORT=4437 node test/conversion-tracking.test.mjs
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/services/passwords.js';
import { PLATFORM_COMPANY_ID } from '../src/data/store.js';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required (point it at a local TEST database).');
  process.exit(2);
}
process.env.DATABASE_URL_UNPOOLED ||= process.env.DATABASE_URL;

const PORT = Number(process.env.TEST_PORT || 4437);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const PASSWORD = 'test-pass-1234';

const IDS = {
  owner: '20000000-0000-4000-8000-0000000000c1',
  manager: '20000000-0000-4000-8000-0000000000c2',
  customer: '20000000-0000-4000-8000-0000000000c3',
  seedCustomer: '20000000-0000-4000-8000-0000000000c4',
};
const SEED_BOOKINGS = {
  thaCompleted: '30000000-0000-4000-8000-0000000000c1',
  flagPaid: '30000000-0000-4000-8000-0000000000c2',
  noPay: '30000000-0000-4000-8000-0000000000c3',
  msOnly: '30000000-0000-4000-8000-0000000000c4',
  noClick: '30000000-0000-4000-8000-0000000000c5',
};

const prisma = new PrismaClient();
let server = null;
let failures = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}
function checkTrue(label, value) {
  check(label, Boolean(value), true);
}

async function api(path, { token, method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* CSV or empty */ }
  return { status: res.status, json };
}
async function apiText(path, { token } = {}) {
  const res = await fetch(`${BASE}${path}`, { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  return { status: res.status, text: await res.text(), headers: res.headers };
}
async function login(email) {
  const { status, json } = await api('/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  if (status !== 200 || !json?.token) throw new Error(`login failed for ${email}: ${status} ${JSON.stringify(json)}`);
  return json.token;
}

async function seed() {
  const passwordHash = await hashPassword(PASSWORD);
  await prisma.company.upsert({
    where: { id: PLATFORM_COMPANY_ID },
    update: {},
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'test-platform', type: 'PLATFORM_OWNER', isPlatformOwner: true },
  });
  const users = [
    { id: IDS.owner, email: 'owner@test.local', roles: ['COMPANY_OWNER'] },
    { id: IDS.manager, email: 'manager@test.local', roles: ['COMPANY_ADMIN'] },
    { id: IDS.customer, email: 'customer@test.local', roles: ['CUSTOMER'] },
  ];
  for (const u of users) {
    await prisma.user.upsert({
      where: { id: u.id },
      update: { passwordHash },
      create: { id: u.id, companyId: PLATFORM_COMPANY_ID, email: u.email, passwordHash, phone: '9545550100', roles: u.roles, active: true },
    });
  }
  await prisma.customer.upsert({
    where: { id: IDS.seedCustomer },
    update: {},
    create: { id: IDS.seedCustomer, companyId: PLATFORM_COMPANY_ID, name: 'Seed Customer', phone: '9545550199', city: 'Fort Lauderdale', zip: '33311' },
  });

  const base = {
    companyId: PLATFORM_COMPANY_ID,
    customerId: IDS.seedCustomer,
    city: 'Fort Lauderdale',
    zip: '33311',
    appliance: 'Refrigerator',
    issue: 'Seeded conversion-tracking drill booking',
    source: 'WEB_FORM',
    area: 'Fort Lauderdale',
    areaStatus: 'IN_AREA',
  };
  const rows = [
    {
      ...base, id: SEED_BOOKINGS.thaCompleted, referenceCode: 'TS-SEEDTHA1',
      sourcePage: 'https://totalhomeappliance.com/book', viaTag: 'totalhomeappliancerepair.com',
      utmSource: 'google', utmMedium: 'cpc', utmCampaign: 'tha-search-launch', utmTerm: 'refrigerator repair', utmContent: 'headline-a',
      gclid: 'G-SEED-THA', status: 'COMPLETED',
      createdAt: new Date('2026-11-18T14:00:00Z'), completedAt: new Date('2026-11-19T15:04:05Z'), updatedAt: new Date('2026-11-19T15:04:05Z'),
      history: [{ type: 'RECEIPT_RECORDED', at: '2026-11-19T15:04:05.000Z', receipt: { id: 'seed-receipt-1', method: 'CARD_EXTERNAL', amountCents: 25915, at: '2026-11-19T15:04:05.000Z' } }],
    },
    {
      ...base, id: SEED_BOOKINGS.flagPaid, referenceCode: 'TS-SEEDFLAG1',
      sourcePage: 'https://topspeedserviceos.com/book', viaTag: 'topspeedserviceos.com',
      utmSource: 'google', utmMedium: 'cpc', utmCampaign: 'brand-core', gclid: 'G-SEED-FLAG', status: 'COMPLETED',
      createdAt: new Date('2026-11-18T16:30:00Z'), completedAt: new Date('2026-11-19T18:00:00Z'), updatedAt: new Date('2026-11-19T18:00:00Z'),
      history: [],
    },
    {
      ...base, id: SEED_BOOKINGS.noPay, referenceCode: 'TS-SEEDNOPAY',
      utmSource: 'google', utmMedium: 'cpc', utmCampaign: 'brand-core', gclid: 'G-SEED-NOPAY', status: 'COMPLETED',
      createdAt: new Date('2026-11-18T17:00:00Z'), completedAt: new Date('2026-11-19T19:00:00Z'), updatedAt: new Date('2026-11-19T19:00:00Z'),
      history: [],
    },
    {
      ...base, id: SEED_BOOKINGS.msOnly, referenceCode: 'TS-SEEDMS001',
      utmSource: 'bing', utmMedium: 'cpc', utmCampaign: 'bing-core', msclkid: 'MS-SEED-1', status: 'CONFIRMED',
      createdAt: new Date('2026-11-18T18:00:00Z'), updatedAt: new Date('2026-11-18T18:00:00Z'),
      history: [],
    },
    {
      ...base, id: SEED_BOOKINGS.noClick, referenceCode: 'TS-SEEDNOCLK',
      utmSource: 'newsletter', utmMedium: 'email', utmCampaign: 'nov-newsletter', status: 'CONFIRMED',
      createdAt: new Date('2026-11-18T19:00:00Z'), updatedAt: new Date('2026-11-18T19:00:00Z'),
      history: [],
    },
  ];
  for (const row of rows) {
    await prisma.serviceRequest.upsert({ where: { id: row.id }, update: row, create: row });
  }
  await prisma.payment.upsert({
    where: { id: '40000000-0000-4000-8000-0000000000c1' },
    update: {},
    create: {
      id: '40000000-0000-4000-8000-0000000000c1', companyId: PLATFORM_COMPANY_ID,
      serviceRequestId: SEED_BOOKINGS.flagPaid, customerId: IDS.seedCustomer,
      purpose: 'DIAGNOSTIC', amountCents: 9900, currency: 'usd', status: 'PAID',
      paidAt: new Date('2026-11-19T17:55:00Z'),
    },
  });
}

async function cleanup() {
  try {
    await prisma.payment.deleteMany({ where: { id: '40000000-0000-4000-8000-0000000000c1' } });
    await prisma.serviceRequest.deleteMany({ where: { OR: [{ id: { in: Object.values(SEED_BOOKINGS) } }, { referenceCode: { startsWith: 'TS-' }, customer: { phone: '9545550111' } }] } });
    await prisma.customer.deleteMany({ where: { phone: { in: ['9545550111', '9545550199'] } } });
    await prisma.user.deleteMany({ where: { id: { in: [IDS.owner, IDS.manager, IDS.customer] } } });
  } catch (error) {
    console.error('cleanup warning:', error.message);
  }
}

async function waitForServer() {
  for (let i = 0; i < 90; i += 1) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('server did not come up');
}

const BOOKING_CORE = {
  customer: { name: 'Conversion Tester', phone: '9545550111', address: '123 Test Ave' },
  city: 'Fort Lauderdale', zip: '33311', appliance: 'Refrigerator', issue: 'Not cooling at all',
};

async function main() {
  await cleanup();
  await seed();
  server = spawn('node', ['src/server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, PORT: String(PORT), JWT_SECRET: 'conversion-tracking-test-secret', DATABASE_URL: process.env.DATABASE_URL, DATABASE_URL_UNPOOLED: process.env.DATABASE_URL_UNPOOLED },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[api] ${d}`));
  await waitForServer();

  // ── Export gates ──────────────────────────────────────────────
  check('export anon → 401', (await api('/admin/conversions/export')).status, 401);
  check('summary anon → 401', (await api('/admin/conversions/summary')).status, 401);
  const owner = await login('owner@test.local');
  const manager = await login('manager@test.local');
  const customer = await login('customer@test.local');
  check('export customer → 403', (await api('/admin/conversions/export', { token: customer })).status, 403);
  check('summary customer → 403', (await api('/admin/conversions/summary', { token: customer })).status, 403);

  // ── Seeded export: Google CSV ─────────────────────────────────
  const csv1 = await apiText('/admin/conversions/export', { token: manager });
  check('export manager → 200', csv1.status, 200);
  check('export mode header', csv1.headers.get('x-conversion-export-mode'), 'MANUAL_CSV_IMPORT');
  check('export api-upload header', csv1.headers.get('x-conversion-api-upload'), 'AWAITING_API_CONNECTION');
  const lines = csv1.text.trim().split('\n');
  check('csv line 1 is the timezone Parameters line', lines[0], 'Parameters:TimeZone=America/New_York');
  check('csv header row', lines[1], 'Google Click ID,Conversion Name,Conversion Time,Conversion Value,Conversion Currency');
  checkTrue('THA lead row at 99.00 with NY time', lines.some((l) => l === 'G-SEED-THA,THA — Booking Submitted,2026-11-18 09:00:00,99.00,USD'));
  checkTrue('THA revenue row at the exact receipt amount', lines.some((l) => l === 'G-SEED-THA,THA — Job Completed,2026-11-19 10:04:05,259.15,USD'));
  checkTrue('flagship lead row', lines.some((l) => l.startsWith('G-SEED-FLAG,Top Speed — Booking Submitted,') && l.endsWith(',99.00,USD')));
  checkTrue('flagship revenue row from the PAID payment (99.00)', lines.some((l) => l.startsWith('G-SEED-FLAG,Top Speed — Job Completed,') && l.endsWith(',99.00,USD')));
  checkTrue('completed-but-unpaid booking has a lead row', lines.some((l) => l.startsWith('G-SEED-NOPAY,Top Speed — Booking Submitted,')));
  check('completed-but-unpaid booking has NO revenue row', lines.filter((l) => l.startsWith('G-SEED-NOPAY') && l.includes('Job Completed')).length, 0);
  check('msclkid-only booking absent from the Google file', lines.filter((l) => l.includes('MS-SEED-1')).length, 0);
  check('seeded google rows = 3 leads + 2 revenues', lines.slice(2).filter((l) => l.includes('SEED')).length, 5);

  // ── Seeded export: Microsoft + JSON ───────────────────────────
  const msCsv = await apiText('/admin/conversions/export?platform=microsoft', { token: owner });
  const msLines = msCsv.text.trim().split('\n');
  check('microsoft header row', msLines[1], 'Microsoft Click ID,Conversion Name,Conversion Time,Conversion Value,Conversion Currency');
  checkTrue('msclkid lead row present', msLines.some((l) => l.startsWith('MS-SEED-1,Top Speed — Booking Submitted,')));
  check('gclid absent from the Microsoft file', msLines.filter((l) => l.includes('G-SEED')).length, 0);

  const jsonExport = await api('/admin/conversions/export?format=json', { token: owner });
  check('json export mode', jsonExport.json?.data?.mode, 'MANUAL_CSV_IMPORT');
  check('json export apiUpload state', jsonExport.json?.data?.apiUpload, 'AWAITING_API_CONNECTION');
  check('json export timezone', jsonExport.json?.data?.timezone, 'America/New_York');

  // ── Summary read model (seeded state) ─────────────────────────
  const summary1 = await api('/admin/conversions/summary', { token: owner });
  const s1 = summary1.json?.data || {};
  check('summary captured bookings (seeded)', s1.totals?.captured, 5);
  check('summary withGclid (seeded)', s1.totals?.withGclid, 3);
  check('summary withMsclkid (seeded)', s1.totals?.withMsclkid, 1);
  const thaGroup = (s1.bySourceCampaign || []).find((g) => g.source === 'totalhomeappliance.com' && g.campaign === 'tha-search-launch');
  checkTrue('summary THA source/campaign group exists', thaGroup);
  check('summary THA group bookings', thaGroup?.bookings, 1);
  check('summary THA group withGclid', thaGroup?.withGclid, 1);
  check('summary leads ready (seeded)', s1.leadConversionsReady, 3);
  check('summary revenue count (seeded)', s1.revenueConversions?.count, 2);
  check('summary revenue total = 259.15 + 99.00', s1.revenueConversions?.totalValue, 358.15);
  check('summary exportState mode', s1.exportState?.mode, 'MANUAL_CSV_IMPORT');
  check('summary exportState apiUpload', s1.exportState?.apiUpload, 'AWAITING_API_CONNECTION');

  // ── Live capture: guest intake stores everything verbatim ─────
  const full = await api('/speedy/book', {
    method: 'POST',
    body: {
      ...BOOKING_CORE, source: 'WEB_FORM',
      page: 'https://totalhomeappliance.com/?utm_source=google&utm_medium=cpc&utm_campaign=tha-search-launch&utm_term=fridge+repair&utm_content=video-a',
      via: 'totalhomeappliancerepair.com',
      utmSource: 'google', utmMedium: 'cpc', utmCampaign: 'tha-search-launch', utmTerm: 'fridge repair', utmContent: 'video-a',
      gclid: 'G-LIVE-THA', fbclid: 'FB-LIVE-1', msclkid: 'MS-LIVE-1',
    },
  });
  check('live THA booking → 201', full.status, 201);
  const liveRow = await prisma.serviceRequest.findUnique({ where: { referenceCode: full.json?.data?.referenceCode } });
  checkTrue('live booking row exists', liveRow);
  check('stored utmTerm verbatim', liveRow?.utmTerm, 'fridge repair');
  check('stored utmContent verbatim', liveRow?.utmContent, 'video-a');
  check('stored gclid verbatim', liveRow?.gclid, 'G-LIVE-THA');
  check('stored fbclid verbatim', liveRow?.fbclid, 'FB-LIVE-1');
  check('stored msclkid verbatim', liveRow?.msclkid, 'MS-LIVE-1');
  check('stored utmCampaign verbatim', liveRow?.utmCampaign, 'tha-search-launch');
  check('stored viaTag', liveRow?.viaTag, 'totalhomeappliancerepair.com');

  const bare = await api('/speedy/book', { method: 'POST', body: { ...BOOKING_CORE, source: 'WEB_FORM' } });
  check('bare booking → 201', bare.status, 201);
  const bareRow = await prisma.serviceRequest.findUnique({ where: { referenceCode: bare.json?.data?.referenceCode } });
  check('bare booking gclid is null', bareRow?.gclid, null);
  check('bare booking utmTerm is null', bareRow?.utmTerm, null);
  check('bare booking utmContent is null', bareRow?.utmContent, null);

  const junk = await api('/speedy/book', { method: 'POST', body: { ...BOOKING_CORE, source: 'WEB_FORM', gclid: 12345, utmTerm: 'kw' } });
  check('junk click id never fails the booking', junk.status, 201);
  const junkRow = await prisma.serviceRequest.findUnique({ where: { referenceCode: junk.json?.data?.referenceCode } });
  check('junk gclid stored as null', junkRow?.gclid, null);
  check('valid utmTerm beside junk still stored', junkRow?.utmTerm, 'kw');

  // ── Live capture: authenticated intake, snake_case fields ─────
  const auth = await api('/bookings', {
    token: customer, method: 'POST',
    body: { ...BOOKING_CORE, utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'brand-core', utm_term: 'appliance repair', utm_content: 'text-b', gclid: 'G-LIVE-FLAG' },
  });
  check('authenticated booking → 201', auth.status, 201);
  const authRow = await prisma.serviceRequest.findUnique({ where: { referenceCode: auth.json?.data?.referenceCode } });
  check('snake_case utm_term stored', authRow?.utmTerm, 'appliance repair');
  check('snake_case utm_content stored', authRow?.utmContent, 'text-b');
  check('authenticated gclid stored', authRow?.gclid, 'G-LIVE-FLAG');

  // ── Shield: honeypot + attribution still discards silently ────
  const before = await prisma.serviceRequest.count();
  const ghost = await api('/speedy/book', {
    method: 'POST',
    body: { ...BOOKING_CORE, source: 'WEB_FORM', companyWebsite: 'http://spam.example', gclid: 'G-GHOST', utmCampaign: 'ghost' },
  });
  check('honeypot booking still answers 201-shaped', ghost.status, 201);
  check('honeypot created no booking row', await prisma.serviceRequest.count(), before);

  // ── Export after live bookings ────────────────────────────────
  const json2 = await api('/admin/conversions/export?format=json', { token: owner });
  const rows2 = json2.json?.data?.rows || [];
  checkTrue('live THA booking became a THA lead row', rows2.some((r) => r.clickId === 'G-LIVE-THA' && r.conversionName === 'THA — Booking Submitted' && r.conversionValue === 99));
  checkTrue('live flagship booking became a Top Speed lead row', rows2.some((r) => r.clickId === 'G-LIVE-FLAG' && r.conversionName === 'Top Speed — Booking Submitted'));
  check('ghost click never reaches the export', rows2.filter((r) => r.clickId === 'G-GHOST').length, 0);

  const summary2 = await api('/admin/conversions/summary', { token: manager });
  const thaGroup2 = (summary2.json?.data?.bySourceCampaign || []).find((g) => g.source === 'totalhomeappliance.com' && g.campaign === 'tha-search-launch');
  check('summary THA group grows with the live booking', thaGroup2?.bookings, 2);

  // ── Client capture script: first touch + dataLayer event ──────
  const scriptSource = readFileSync(fileURLToPath(new URL('../../web/shared/attribution-capture.js', import.meta.url)), 'utf8');
  function fakeBrowser(search, stored) {
    const storage = new Map(stored ? [['tsos_attribution', stored]] : []);
    const window = {
      location: { search, href: `https://topspeedserviceos.com/book${search}` },
      localStorage: {
        getItem: (k) => (storage.has(k) ? storage.get(k) : null),
        setItem: (k, v) => storage.set(k, v),
      },
      dataLayer: [],
    };
    const context = vm.createContext({ window, localStorage: window.localStorage, URLSearchParams, Date, JSON, console });
    context.window.window = context.window;
    vm.runInContext(scriptSource, context);
    return { window, storage };
  }
  const first = fakeBrowser('?utm_source=google&utm_medium=cpc&utm_campaign=one&gclid=FIRST&utm_term=kw1&utm_content=ad1', null);
  const firstStored = first.storage.get('tsos_attribution');
  checkTrue('first touch stored', firstStored);
  check('first touch keeps utmTerm', JSON.parse(firstStored).utmTerm, 'kw1');
  check('first touch keeps utmContent', JSON.parse(firstStored).utmContent, 'ad1');
  const second = fakeBrowser('?utm_source=google&utm_campaign=two&gclid=SECOND', firstStored);
  const attached = {};
  second.window.TSOSAttribution.attach(attached);
  check('first touch wins over a later click (gclid)', attached.gclid, 'FIRST');
  check('first touch wins over a later click (campaign)', attached.utmCampaign, 'one');
  const stale = JSON.stringify({ ...JSON.parse(firstStored), ts: Date.now() - 31 * 24 * 60 * 60 * 1000 });
  const third = fakeBrowser('?gclid=AFTER-EXPIRY&utm_campaign=fresh', stale);
  const attached3 = {};
  third.window.TSOSAttribution.attach(attached3);
  check('expired touch is replaced by the new click', attached3.gclid, 'AFTER-EXPIRY');
  first.window.TSOSBookingSubmitted('TS-TEST-REF');
  check('dataLayer event name', first.window.dataLayer[0]?.event, 'booking_submitted');
  check('dataLayer event reference', first.window.dataLayer[0]?.reference_code, 'TS-TEST-REF');

  // ── google-tag.js Ads slot: inert while unset, fires when set ──
  const tagSource = readFileSync(fileURLToPath(new URL('../../web/google-tag.js', import.meta.url)), 'utf8');
  function fakeTagPage(src) {
    const appended = [];
    const window = {
      document: {
        createElement: () => ({}),
        head: { appendChild: (el) => appended.push(el) },
      },
    };
    window.window = window;
    const context = vm.createContext({ window, document: window.document, Date, JSON, console, encodeURIComponent });
    vm.runInContext(src, context);
    return { window, appended };
  }
  const conversionsIn = (dl) => (dl || []).filter((a) => a && a[0] === 'event' && a[1] === 'conversion');
  const tagUnset = fakeTagPage(tagSource);
  tagUnset.window.dataLayer.push({ event: 'booking_submitted', reference_code: 'TS-DRILL' });
  check('tag slot inert while unset (no conversion fired)', conversionsIn(tagUnset.window.dataLayer).length, 0);
  checkTrue('GA4 still loads while the Ads slot is unset', tagUnset.appended.some((el) => String(el.src || '').includes('G-30WFYN49DP')));
  const tagSetSource = tagSource
    .replace("GOOGLE_ADS_CONVERSION_ID: ''", "GOOGLE_ADS_CONVERSION_ID: 'AW-DRILL'")
    .replace("GOOGLE_ADS_CONVERSION_LABEL: ''", "GOOGLE_ADS_CONVERSION_LABEL: 'lbl-drill'");
  const tagSet = fakeTagPage(tagSetSource);
  tagSet.window.dataLayer.push({ event: 'booking_submitted', reference_code: 'TS-DRILL-9' });
  const conv = conversionsIn(tagSet.window.dataLayer)[0];
  checkTrue('tag slot fires the conversion once set', Boolean(conv));
  check('tag slot send_to', conv && conv[2] && conv[2].send_to, 'AW-DRILL/lbl-drill');
  check('tag slot transaction_id is the booking reference', conv && conv[2] && conv[2].transaction_id, 'TS-DRILL-9');

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  return failures;
}

main()
  .then(async (failures) => {
    if (server) server.kill('SIGTERM');
    await cleanup();
    await prisma.$disconnect();
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(async (error) => {
    console.error(error);
    if (server) server.kill('SIGTERM');
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
