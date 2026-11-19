/**
 * ZIP-required hygiene fix — verification harness (2026-11-19).
 *
 * Found by the Field Pro integration drill: POST /provider/work-orders
 * with no ZIP anywhere (not in the body, not on the customer record,
 * not on the customer's Property) sailed through the shared create
 * service (services/workOrders.js) and died as a 500 at persistence,
 * because ServiceRequest.zip is a required column. The fix fails the
 * create BEFORE persistence with a clean 400 ZIP_REQUIRED at the
 * shared service layer, so every origination surface (Tech App,
 * Book OS, CRM) behaves identically. ZIPs from any real source —
 * body, customer record, property record — behave exactly as before.
 *
 * CITY mirror (2026-11-19 follow-up): ServiceRequest.city is also a
 * required column, and the same no-source create (no city in the body,
 * none on the customer record, no Property city, no area resolution)
 * died as a 500 at persistence. The shared service now resolves city
 * (area resolution → body → customer record → Property record) and
 * fails BEFORE persistence with a clean 400 CITY_REQUIRED. ZIP is
 * checked first, so a request missing both still gets ZIP_REQUIRED
 * (Case 1 below is exactly that shape). Cases 7–12 cover the city
 * guard; cases 1–6 are the original ZIP checks, unchanged.
 *
 * Runs against a LOCAL test database only. Usage:
 *   DATABASE_URL=postgresql://… TEST_PORT=4437 node test/zip-required.test.mjs
 * Exit code 0 = every check passed.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/services/passwords.js';
import { PLATFORM_COMPANY_ID, store } from '../src/data/store.js';
import { persistCustomer } from '../src/db/bookingsRepo.js';
import { persistProperty } from '../src/db/techPackageRepo.js';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required (point it at a local TEST database).');
  process.exit(2);
}
process.env.DATABASE_URL_UNPOOLED ||= process.env.DATABASE_URL;

const PORT = Number(process.env.TEST_PORT || 4437);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const PASSWORD = 'test-pass-1234';

const IDS = {
  coA: '50000000-0000-4000-8000-0000000000a1',
  provA: '50000000-0000-4000-8000-0000000000a2',
  techA: '50000000-0000-4000-8000-0000000000a3',
  setter: '50000000-0000-4000-8000-0000000000c1',
  custNoZip: '50000000-0000-4000-8000-0000000000d1',
  custPropZip: '50000000-0000-4000-8000-0000000000d2',
  custZip: '50000000-0000-4000-8000-0000000000d3',
  propZip: '50000000-0000-4000-8000-0000000000d4',
  custNoCity: '50000000-0000-4000-8000-0000000000d5',
  custCityOnly: '50000000-0000-4000-8000-0000000000d6',
  custPropCity: '50000000-0000-4000-8000-0000000000d7',
  propCity: '50000000-0000-4000-8000-0000000000d8',
};
const NEW_PHONE = '9545550177';
const NEW_PHONE_CITY = '9545550188';

const prisma = new PrismaClient();
let server = null;
let failures = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}
function checkTrue(label, value) { check(label, Boolean(value), true); }

async function api(path, { token, method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
}

async function login(email) {
  const { status, json } = await api('/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  if (status !== 200 || !json?.token) throw new Error(`login failed for ${email}: ${status} ${JSON.stringify(json)}`);
  return json.token;
}

async function seed() {
  const passwordHash = await hashPassword(PASSWORD);
  await prisma.company.upsert({
    where: { id: PLATFORM_COMPANY_ID }, update: {},
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'zf-platform', type: 'PLATFORM_OWNER', isPlatformOwner: true },
  });
  await prisma.company.upsert({
    where: { id: IDS.coA }, update: {},
    create: { id: IDS.coA, name: 'ZipFix Provider A Co', slug: 'zf-prov-a', type: 'INDEPENDENT_PROVIDER' },
  });
  await prisma.provider.upsert({
    where: { id: IDS.provA }, update: {},
    create: {
      id: IDS.provA, companyId: IDS.coA, businessName: 'ZipFix Provider A', type: 'NETWORK_BUSINESS',
      specialties: ['Refrigerator', 'Washer'], serviceCities: ['Fort Lauderdale', 'Davie'],
    },
  });
  for (const [id, companyId, email, roles] of [
    [IDS.techA, IDS.coA, 'zf-tech-a@test.local', ['PROVIDER_TECH']],
    [IDS.setter, PLATFORM_COMPANY_ID, 'zf-setter@test.local', ['DISPATCHER']],
  ]) {
    await prisma.user.upsert({
      where: { id }, update: { passwordHash, verifyRequired: false, layer2Required: false },
      create: { id, companyId, email, passwordHash, phone: '9545550110', roles, active: true },
    });
  }

  const now = new Date().toISOString();
  const custNoZip = {
    id: IDS.custNoZip, companyId: PLATFORM_COMPANY_ID, userId: null,
    name: 'ZipFix No Zip', phone: '9545550111', email: 'zf-nozip@test.local',
    address: '100 NoZip Way', city: 'Fort Lauderdale', zip: null, createdAt: now,
  };
  const custPropZip = {
    id: IDS.custPropZip, companyId: PLATFORM_COMPANY_ID, userId: null,
    name: 'ZipFix Property Zip', phone: '9545550122', email: 'zf-propzip@test.local',
    address: '200 Prop Lane', city: null, zip: null, createdAt: now,
  };
  const custZip = {
    id: IDS.custZip, companyId: PLATFORM_COMPANY_ID, userId: null,
    name: 'ZipFix Record Zip', phone: '9545550133', email: 'zf-recordzip@test.local',
    address: '300 Record Rd', city: 'Davie', zip: '33311', createdAt: now,
  };
  for (const cust of [custNoZip, custPropZip, custZip]) {
    store.customers.set(cust.id, cust);
    await persistCustomer(cust);
  }
  const prop = {
    id: IDS.propZip, companyId: PLATFORM_COMPANY_ID, customerId: custPropZip.id,
    label: null, address: '200 Prop Lane', city: 'Fort Lauderdale', zip: '33321',
    unit: null, accessNotes: null, createdAt: now, updatedAt: now,
  };
  store.properties.push(prop);
  await persistProperty(prop);

  // CITY-guard fixtures: no city anywhere / city only on the customer
  // record / city only on the Property record. (ZIPs are supplied per
  // case in the request body, or via the Property, so the ZIP guard
  // passes and the city guard is what is exercised.)
  const custNoCity = {
    id: IDS.custNoCity, companyId: PLATFORM_COMPANY_ID, userId: null,
    name: 'CityFix No City', phone: '9545550144', email: 'cf-nocity@test.local',
    address: '400 NoCity Blvd', city: null, zip: null, createdAt: now,
  };
  const custCityOnly = {
    id: IDS.custCityOnly, companyId: PLATFORM_COMPANY_ID, userId: null,
    name: 'CityFix Record City', phone: '9545550155', email: 'cf-recordcity@test.local',
    address: '500 CityOnly Ave', city: 'Davie', zip: null, createdAt: now,
  };
  const custPropCity = {
    id: IDS.custPropCity, companyId: PLATFORM_COMPANY_ID, userId: null,
    name: 'CityFix Property City', phone: '9545550166', email: 'cf-propcity@test.local',
    address: '600 PropCity Ct', city: null, zip: null, createdAt: now,
  };
  for (const cust of [custNoCity, custCityOnly, custPropCity]) {
    store.customers.set(cust.id, cust);
    await persistCustomer(cust);
  }
  const propCity = {
    id: IDS.propCity, companyId: PLATFORM_COMPANY_ID, customerId: custPropCity.id,
    label: null, address: '600 PropCity Ct', city: 'Fort Lauderdale', zip: '33321',
    unit: null, accessNotes: null, createdAt: now, updatedAt: now,
  };
  store.properties.push(propCity);
  await persistProperty(propCity);
}

async function cleanup() {
  try {
    const allCustIds = [IDS.custNoZip, IDS.custPropZip, IDS.custZip, IDS.custNoCity, IDS.custCityOnly, IDS.custPropCity];
    const created = await prisma.serviceRequest.findMany({
      where: { customerId: { in: allCustIds } }, select: { id: true },
    });
    const newCust = await prisma.customer.findMany({ where: { phone: { in: [NEW_PHONE, NEW_PHONE_CITY] } }, select: { id: true } });
    const bookingIds = created.map((r) => r.id);
    await prisma.dispatchAssignment.deleteMany({ where: { serviceRequestId: { in: bookingIds } } });
    await prisma.serviceRequest.deleteMany({ where: { id: { in: bookingIds } } });
    await prisma.property.deleteMany({ where: { customerId: { in: [...allCustIds, ...newCust.map((c) => c.id)] } } });
    await prisma.customer.deleteMany({ where: { id: { in: [...allCustIds, ...newCust.map((c) => c.id)] } } });
    await prisma.user.deleteMany({ where: { id: { in: [IDS.techA, IDS.setter] } } });
    await prisma.provider.deleteMany({ where: { id: IDS.provA } });
    await prisma.company.deleteMany({ where: { id: IDS.coA } });
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

async function main() {
  await cleanup();
  await seed();
  server = spawn('node', ['src/server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      ...process.env,
      PORT: String(PORT),
      JWT_SECRET: 'zip-required-test-secret',
      DATABASE_URL: process.env.DATABASE_URL,
      DATABASE_URL_UNPOOLED: process.env.DATABASE_URL_UNPOOLED,
      OPENAI_API_KEY: '',
      OPENAI_API_KEY_V2: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[api] ${d}`));
  await waitForServer();

  const techA = await login('zf-tech-a@test.local');
  const setter = await login('zf-setter@test.local');

  const countFor = (customerId) => prisma.serviceRequest.count({ where: { customerId } });

  // ---------- Case 1: provider create, brand-new customer, no ZIP anywhere ----------
  const beforeNewCust = await prisma.customer.count({ where: { phone: NEW_PHONE } });
  const c1 = await api('/provider/work-orders', {
    token: techA, method: 'POST',
    body: { customer: { name: 'ZipFix Brand New', phone: NEW_PHONE }, appliance: 'Refrigerator', issue: 'Not cooling at all' },
  });
  check('provider new-customer no-ZIP status', c1.status, 400);
  check('provider new-customer no-ZIP code', c1.json?.code, 'ZIP_REQUIRED');
  checkTrue('provider new-customer no-ZIP error message', /ZIP code is required/.test(c1.json?.error || ''));
  check('no customer row left behind', await prisma.customer.count({ where: { phone: NEW_PHONE } }), beforeNewCust);

  // ---------- Case 2: provider create, existing customer with no ZIP anywhere ----------
  const before2 = await countFor(IDS.custNoZip);
  const c2 = await api('/provider/work-orders', {
    token: techA, method: 'POST',
    body: { customerId: IDS.custNoZip, appliance: 'Washer', issue: 'Leaks on the floor' },
  });
  check('provider existing-customer no-ZIP status', c2.status, 400);
  check('provider existing-customer no-ZIP code', c2.json?.code, 'ZIP_REQUIRED');
  check('no ServiceRequest row created (provider)', await countFor(IDS.custNoZip), before2);

  // ---------- Case 3: Book OS create, no ZIP anywhere ----------
  const c3 = await api('/bookos/work-orders', {
    token: setter, method: 'POST',
    body: { customerId: IDS.custNoZip, appliance: 'Dryer', issue: 'No heat' },
  });
  check('bookos no-ZIP status', c3.status, 400);
  check('bookos no-ZIP code', c3.json?.code, 'ZIP_REQUIRED');
  check('no ServiceRequest row created (bookos)', await countFor(IDS.custNoZip), before2);

  // ---------- Case 4: ZIP only on the Property record → 201, booking carries it ----------
  // (The request carries a city, as every real create form does; only
  // the ZIP is absent from both the body and the customer record.)
  const c4 = await api('/provider/work-orders', {
    token: techA, method: 'POST',
    body: { customerId: IDS.custPropZip, address: '200 Prop Lane', city: 'Fort Lauderdale', appliance: 'Refrigerator', issue: 'Warm fridge' },
  });
  check('provider property-ZIP status', c4.status, 201);
  const row4 = c4.json?.data?.booking?.id
    ? await prisma.serviceRequest.findUnique({ where: { id: c4.json.data.booking.id } })
    : null;
  check('provider property-ZIP persisted', row4?.zip, '33321');

  // ---------- Case 5: ZIP only on the customer record → 201 as today ----------
  const c5 = await api('/provider/work-orders', {
    token: techA, method: 'POST',
    body: { customerId: IDS.custZip, appliance: 'Oven', issue: 'Will not ignite' },
  });
  check('provider customer-ZIP status', c5.status, 201);
  const row5 = c5.json?.data?.booking?.id
    ? await prisma.serviceRequest.findUnique({ where: { id: c5.json.data.booking.id } })
    : null;
  check('provider customer-ZIP persisted', row5?.zip, '33311');

  // ---------- Case 6: ZIP in the body → 201 as today, body wins ----------
  const c6 = await api('/provider/work-orders', {
    token: techA, method: 'POST',
    body: { customerId: IDS.custNoZip, zip: '33301', appliance: 'Dishwasher', issue: 'Will not drain' },
  });
  check('provider body-ZIP status', c6.status, 201);
  const row6 = c6.json?.data?.booking?.id
    ? await prisma.serviceRequest.findUnique({ where: { id: c6.json.data.booking.id } })
    : null;
  check('provider body-ZIP persisted', row6?.zip, '33301');

  // ---------- Case 7: provider create, brand-new customer, ZIP present but no city anywhere ----------
  // (Body ZIP 99999 is in no service area, so area resolution yields no
  // city; the new customer record carries none; there is no Property.)
  const beforeNewCustCity = await prisma.customer.count({ where: { phone: NEW_PHONE_CITY } });
  const c7 = await api('/provider/work-orders', {
    token: techA, method: 'POST',
    body: { customer: { name: 'CityFix Brand New', phone: NEW_PHONE_CITY }, zip: '99999', appliance: 'Refrigerator', issue: 'Not cooling at all' },
  });
  check('provider new-customer no-city status', c7.status, 400);
  check('provider new-customer no-city code', c7.json?.code, 'CITY_REQUIRED');
  checkTrue('provider new-customer no-city error message', /city is required/.test(c7.json?.error || ''));
  check('no customer row left behind (city)', await prisma.customer.count({ where: { phone: NEW_PHONE_CITY } }), beforeNewCustCity);

  // ---------- Case 8: provider create, existing customer, ZIP present but no city anywhere ----------
  const before8 = await countFor(IDS.custNoCity);
  const c8 = await api('/provider/work-orders', {
    token: techA, method: 'POST',
    body: { customerId: IDS.custNoCity, zip: '99999', appliance: 'Washer', issue: 'Leaks on the floor' },
  });
  check('provider existing-customer no-city status', c8.status, 400);
  check('provider existing-customer no-city code', c8.json?.code, 'CITY_REQUIRED');
  check('no ServiceRequest row created (provider, city)', await countFor(IDS.custNoCity), before8);

  // ---------- Case 9: Book OS create, ZIP present but no city anywhere ----------
  const c9 = await api('/bookos/work-orders', {
    token: setter, method: 'POST',
    body: { customerId: IDS.custNoCity, zip: '99999', appliance: 'Dryer', issue: 'No heat' },
  });
  check('bookos no-city status', c9.status, 400);
  check('bookos no-city code', c9.json?.code, 'CITY_REQUIRED');
  check('no ServiceRequest row created (bookos, city)', await countFor(IDS.custNoCity), before8);

  // ---------- Case 10: city only on the customer record → 201 as today ----------
  const c10 = await api('/provider/work-orders', {
    token: techA, method: 'POST',
    body: { customerId: IDS.custCityOnly, zip: '99999', appliance: 'Oven', issue: 'Will not ignite' },
  });
  check('provider customer-city status', c10.status, 201);
  const row10 = c10.json?.data?.booking?.id
    ? await prisma.serviceRequest.findUnique({ where: { id: c10.json.data.booking.id } })
    : null;
  check('provider customer-city persisted', row10?.city, 'Davie');

  // ---------- Case 11: city only on the Property record → 201, booking carries it ----------
  // (No city/ZIP in the body at all: the ZIP also resolves from the
  // Property, exactly as in Case 4, and the city now does too.)
  const c11 = await api('/provider/work-orders', {
    token: techA, method: 'POST',
    body: { customerId: IDS.custPropCity, address: '600 PropCity Ct', appliance: 'Refrigerator', issue: 'Warm fridge' },
  });
  check('provider property-city status', c11.status, 201);
  const row11 = c11.json?.data?.booking?.id
    ? await prisma.serviceRequest.findUnique({ where: { id: c11.json.data.booking.id } })
    : null;
  check('provider property-city persisted', row11?.city, 'Fort Lauderdale');
  check('provider property-city ZIP persisted', row11?.zip, '33321');

  // ---------- Case 12: city in the body → 201 as today, body city wins ----------
  const c12 = await api('/provider/work-orders', {
    token: techA, method: 'POST',
    body: { customerId: IDS.custNoCity, city: 'Davie', zip: '99999', appliance: 'Dishwasher', issue: 'Will not drain' },
  });
  check('provider body-city status', c12.status, 201);
  const row12 = c12.json?.data?.booking?.id
    ? await prisma.serviceRequest.findUnique({ where: { id: c12.json.data.booking.id } })
    : null;
  check('provider body-city persisted', row12?.city, 'Davie');

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
}

main()
  .catch((error) => { console.error(error); failures += 1; })
  .finally(async () => {
    if (server) server.kill('SIGTERM');
    await cleanup();
    await prisma.$disconnect();
    process.exit(failures === 0 ? 0 : 1);
  });
