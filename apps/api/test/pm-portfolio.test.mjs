/**
 * PM portfolio console (B5) + tenant request links (B6) drill suite.
 *
 * Boots the real API against a throwaway Postgres (DATABASE_URL) and
 * proves, end to end:
 *  - the PM gate: property-manager accounts (and staff) only — a
 *    homeowner account gets 403 PM_ACCOUNT_REQUIRED (business-gate
 *    intact), anonymous gets 401;
 *  - portfolio isolation: a PM sees ONLY their own properties/units/
 *    requests; another PM gets 404 on them;
 *  - tenant link isolation: the public link payload carries the property
 *    + unit labels and NOTHING else (no tenant contacts, no PM data);
 *    garbage/revoked/rotated-out tokens 404;
 *  - approval is the ONLY path to dispatch: before approval there is no
 *    connection record and no setter-queue booking; approving creates
 *    both (type PM_SERVICE_REQUEST) in the SAME Book OS pipeline;
 *  - rejection closes the request with the PM's note visible to the
 *    tenant on their private status page, and creates nothing;
 *  - the intake shield holds on the public doors (honeypot discards
 *    silently with the same success shape; bad NANP phone 400s);
 *  - structured bulk intake: one form → individual request records with
 *    a shared batch reference, each independently dispatched;
 *  - monthly statement math on seeded completed jobs: invoice totals and
 *    receipts fold exactly (server money only), an empty month says so,
 *    and another PM's statement never shows these jobs.
 *
 * Usage: DATABASE_URL=postgresql://... node test/pm-portfolio.test.mjs
 * (exits 2 without DATABASE_URL; never run against production.)
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required (throwaway Postgres only).');
  process.exit(2);
}
process.env.DATABASE_URL_UNPOOLED = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;

const { PrismaClient } = await import('@prisma/client');
const { hashPassword } = await import('../src/services/passwords.js');
const prisma = new PrismaClient();

const PORT = 4501;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const COMPANY_ID = '10000000-0000-4000-8000-000000000001';
const PASSWORD = 'DrillPass-1234';
const MONTH = new Date().toISOString().slice(0, 7);

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failed += 1; console.log(`  ✗ ${name} ${extra}`); }
}
async function req(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
}
async function login(email) {
  const r = await req('POST', '/auth/login', { body: { email, password: PASSWORD } });
  if (r.status !== 200 || !r.json?.token) throw new Error(`login failed for ${email}: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.token;
}

async function seedUser({ email, roles, signupAudience, phone }) {
  const passwordHash = await hashPassword(PASSWORD);
  return prisma.user.create({
    data: {
      companyId: COMPANY_ID, email, passwordHash, firstName: 'Drill', lastName: email.split('@')[0],
      phone: phone || null, roles, signupAudience: signupAudience || null,
      active: true, layer2Required: false, verifyRequired: false,
    },
  });
}

console.log('— seeding users —');
// Idempotent re-runs: clear anything a previous drill run left behind.
// (The intake shield's rate windows persist in the DB — without this,
// repeated runs share one 127.0.0.1 bucket and 429 each other.)
await prisma.intakeRateWindow.deleteMany({});
await prisma.pmServiceRequest.deleteMany({});
await prisma.pmTenantLink.deleteMany({});
await prisma.pmUnit.deleteMany({});
await prisma.pmProperty.deleteMany({});
const priorStmt = await prisma.serviceRequest.findMany({ where: { referenceCode: { in: ['TS-STMT01', 'TS-STMT02'] } }, select: { id: true } });
await prisma.invoice.deleteMany({ where: { serviceRequestId: { in: priorStmt.map((b) => b.id) } } });
await prisma.serviceRequest.deleteMany({ where: { id: { in: priorStmt.map((b) => b.id) } } });
await prisma.customer.deleteMany({ where: { name: { startsWith: 'Stmt Tenant' } } });
await prisma.user.deleteMany({ where: { email: { in: ['pm-a@drill.test', 'pm-b@drill.test', 'home@drill.test', 'staff@drill.test'] } } });
// Prior runs' approved tenant requests left real intake artifacts behind
// (connections + lead bookings) — the "nothing exists before approval"
// checks read the global setter queue, so clear those too.
await prisma.connection.deleteMany({ where: { message: { contains: 'DRILLMARK' } } });
await prisma.serviceRequest.deleteMany({ where: { issue: { contains: 'DRILLMARK' } } });
await prisma.company.upsert({ where: { id: COMPANY_ID }, update: {}, create: { id: COMPANY_ID, name: 'Top Speed Appliance', slug: 'test-platform', type: 'PLATFORM_OWNER', isPlatformOwner: true } });
const pmA = await seedUser({ email: 'pm-a@drill.test', roles: ['CUSTOMER'], signupAudience: 'property-manager', phone: '9545550101' });
const pmB = await seedUser({ email: 'pm-b@drill.test', roles: ['CUSTOMER'], signupAudience: 'property-manager', phone: '9545550102' });
await seedUser({ email: 'home@drill.test', roles: ['CUSTOMER'], signupAudience: 'homeowner', phone: '9545550103' });
await seedUser({ email: 'staff@drill.test', roles: ['DISPATCHER'], phone: '9545550104' });

console.log('— booting API —');
const server = spawn('node', ['src/server.js'], {
  cwd: new URL('../', import.meta.url).pathname,
  env: { ...process.env, PORT: String(PORT), NODE_ENV: 'test', ['JWT_' + 'SECRET']: 'pm-portfolio-drill-secret' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let bootLog = '';
server.stdout.on('data', (d) => { bootLog += d; });
server.stderr.on('data', (d) => { bootLog += d; });
async function waitHealthy() {
  for (let i = 0; i < 60; i += 1) {
    try { const r = await fetch(`${BASE}/health`); if (r.ok) return true; } catch { /* not up yet */ }
    await sleep(1000);
  }
  return false;
}
if (!(await waitHealthy())) { console.error('API did not become healthy.\n' + bootLog.slice(-3000)); server.kill(); process.exit(1); }

try {
  const tokA = await login('pm-a@drill.test');
  const tokB = await login('pm-b@drill.test');
  const tokHome = await login('home@drill.test');
  const tokStaff = await login('staff@drill.test');

  console.log('— gate: PM accounts + staff only —');
  const anon = await req('GET', '/pm/properties');
  check('anonymous /pm/properties → 401', anon.status === 401, `got ${anon.status}`);
  const homeGate = await req('GET', '/pm/properties', { token: tokHome });
  check('homeowner → 403 PM_ACCOUNT_REQUIRED (business gate intact)',
    homeGate.status === 403 && homeGate.json?.code === 'PM_ACCOUNT_REQUIRED', `got ${homeGate.status} ${JSON.stringify(homeGate.json)}`);
  const staffGate = await req('GET', '/pm/properties', { token: tokStaff });
  check('staff passes the PM gate', staffGate.status === 200, `got ${staffGate.status}`);

  console.log('— properties + isolation —');
  const prop = await req('POST', '/pm/properties', { token: tokA, body: { name: 'Coral Palms', address: '2200 NW 39th St', zip: '33313' } });
  check('PM-A creates a property (city resolved from ZIP)', prop.status === 201 && prop.json?.data?.city === 'Lauderhill', `got ${prop.status} ${JSON.stringify(prop.json)}`);
  const propId = prop.json.data.id;
  const outArea = await req('POST', '/pm/properties', { token: tokA, body: { name: 'Far Away', address: '1 Nowhere Rd', zip: '90210' } });
  check('out-of-area ZIP → 422', outArea.status === 422, `got ${outArea.status}`);
  const bList = await req('GET', '/pm/properties', { token: tokB });
  check('PM-B portfolio is empty (own portfolio only)', bList.status === 200 && (bList.json?.data || []).length === 0,
    `got ${bList.status} ${JSON.stringify(bList.json).slice(0, 300)}`);
  const bPeek = await req('GET', `/pm/properties/${propId}`, { token: tokB });
  check('PM-B opening PM-A property → 404', bPeek.status === 404, `got ${bPeek.status}`);
  const bUnit = await req('POST', `/pm/properties/${propId}/units`, { token: tokB, body: { label: 'Unit 99' } });
  check('PM-B adding a unit to PM-A property → 404', bUnit.status === 404, `got ${bUnit.status}`);

  console.log('— units —');
  const unit12 = await req('POST', `/pm/properties/${propId}/units`, { token: tokA, body: { label: 'Unit 12', tenantName: 'Tessa Tenant', tenantPhone: '9545550142', tenantEmail: 'tessa@drill.test' } });
  check('PM-A adds Unit 12', unit12.status === 201, `got ${unit12.status}`);
  const unit7 = await req('POST', `/pm/properties/${propId}/units`, { token: tokA, body: { label: 'Unit 7' } });
  check('PM-A adds Unit 7', unit7.status === 201, `got ${unit7.status}`);
  const unit12Id = unit12.json.data.id; const unit7Id = unit7.json.data.id;

  console.log('— tenant link: isolation of the public payload —');
  const link = await req('POST', `/pm/properties/${propId}/tenant-link`, { token: tokA, body: {} });
  check('PM-A creates a tenant link (token shown once)', link.status === 201 && typeof link.json?.data?.token === 'string' && link.json.data.token.length >= 24, `got ${link.status}`);
  const token1 = link.json.data.token;
  const pub = await req('GET', `/tenant-link/${token1}`);
  check('public link resolves', pub.status === 200, `got ${pub.status}`);
  const pubStr = JSON.stringify(pub.json);
  check('payload carries property + unit labels', pub.json?.data?.property?.name === 'Coral Palms' && (pub.json?.data?.units || []).length === 2);
  check('payload leaks NOTHING else (no tenant contacts, no PM data)',
    !pubStr.includes('Tessa') && !pubStr.includes('9545550142') && !pubStr.includes('tessa@drill.test') && !pubStr.includes('pm-a@drill.test') && !pubStr.includes('tokenHash'),
    pubStr.slice(0, 300));
  const garbage = await req('GET', '/tenant-link/definitely-not-a-real-token-000');
  check('garbage token → 404', garbage.status === 404, `got ${garbage.status}`);

  console.log('— tenant request waits for approval (no auto-dispatch) —');
  const ISSUE1 = 'Fridge not cooling at all since yesterday DRILLMARK1';
  const tReq = await req('POST', `/tenant-link/${token1}/requests`, { body: {
    unitId: unit12Id, tenantName: 'Tessa Tenant', tenantPhone: '954-555-0142', tenantEmail: 'tessa@drill.test',
    appliance: 'Refrigerator', issue: ISSUE1, urgency: 'urgent', accessNotes: 'Gate 4411',
  } });
  check('tenant submits → 201 PENDING_APPROVAL + private status token',
    tReq.status === 201 && tReq.json?.data?.status === 'PENDING_APPROVAL' && !!tReq.json?.data?.statusToken, `got ${tReq.status} ${JSON.stringify(tReq.json)}`);
  const statusToken1 = tReq.json.data.statusToken;
  const queueBefore = await req('GET', '/bookos/setter-queue', { token: tokStaff });
  check('NO setter-queue booking before approval',
    !(queueBefore.json?.data?.queue || []).some((q) => String(q.issue || '').includes('DRILLMARK1')));
  const connsBefore = await req('GET', '/connections', { token: tokStaff });
  check('NO connection record before approval',
    !(connsBefore.json?.data || []).some((c) => String(c.message || '').includes('DRILLMARK1')));
  const pending = await req('GET', '/pm/requests?status=PENDING_APPROVAL', { token: tokA });
  check('request waits in the PM approval queue', pending.status === 200 && (pending.json?.data || []).length === 1 && pending.json.data[0].unitLabel === 'Unit 12',
    `got ${pending.status} ${JSON.stringify(pending.json).slice(0, 300)}`);
  const reqId = pending.json.data[0].id;
  const tStatus0 = await req('GET', `/tenant-request-status/${statusToken1}`);
  check('tenant status page: PENDING, no booking reference yet',
    tStatus0.status === 200 && tStatus0.json.data.status === 'PENDING_APPROVAL' && tStatus0.json.data.bookingReference === null);

  console.log('— approval → the SAME setter pipeline —');
  const bApprove = await req('POST', `/pm/requests/${reqId}/approve`, { token: tokB, body: {} });
  check('PM-B approving PM-A request → 404', bApprove.status === 404, `got ${bApprove.status}`);
  const approved = await req('POST', `/pm/requests/${reqId}/approve`, { token: tokA, body: {} });
  check('PM-A approves → dispatched with booking + connection references',
    approved.status === 200 && approved.json.data.status === 'APPROVED' && !!approved.json.data.bookingReference && !!approved.json.data.connectionReference,
    `got ${approved.status} ${JSON.stringify(approved.json)}`);
  const queueAfter = await req('GET', '/bookos/setter-queue', { token: tokStaff });
  const inQueue = (queueAfter.json?.data?.queue || []).find((q) => String(q.issue || '').includes('DRILLMARK1'));
  check('approved request is IN the Book OS setter queue as a PM_SERVICE_REQUEST lead',
    !!inQueue && inQueue.lead?.connectionType === 'PM_SERVICE_REQUEST', JSON.stringify(inQueue?.lead || null));
  const connsAfter = await req('GET', '/connections', { token: tokStaff });
  check('connection record exists after approval',
    (connsAfter.json?.data || []).some((c) => String(c.message || '').includes('DRILLMARK1')));
  const tStatus1 = await req('GET', `/tenant-request-status/${statusToken1}`);
  check('tenant status page: APPROVED with the same booking reference',
    tStatus1.json?.data?.status === 'APPROVED' && tStatus1.json.data.bookingReference === approved.json.data.bookingReference);
  const approveAgain = await req('POST', `/pm/requests/${reqId}/approve`, { token: tokA, body: {} });
  check('approving twice → 409', approveAgain.status === 409, `got ${approveAgain.status}`);

  console.log('— rejection closes with notice, creates nothing —');
  const tReq2 = await req('POST', `/tenant-link/${token1}/requests`, { body: {
    unitId: unit7Id, tenantName: 'Uma Unit7', tenantPhone: '954-555-0143', appliance: 'Dryer', issue: 'Dryer squeals loudly DRILLMARK2',
  } });
  check('second tenant request → 201', tReq2.status === 201, `got ${tReq2.status}`);
  const pending2 = await req('GET', '/pm/requests?status=PENDING_APPROVAL', { token: tokA });
  const req2 = (pending2.json?.data || []).find((r) => String(r.issue).includes('DRILLMARK2'));
  const rejected = await req('POST', `/pm/requests/${req2.id}/reject`, { token: tokA, body: { note: 'Please use the building portal for this one.' } });
  check('PM-A rejects with a note', rejected.status === 200 && rejected.json.data.status === 'REJECTED', `got ${rejected.status}`);
  const tStatus2 = await req('GET', `/tenant-request-status/${tReq2.json.data.statusToken}`);
  check('tenant sees REJECTED + the PM note on their status page',
    tStatus2.json?.data?.status === 'REJECTED' && tStatus2.json.data.decisionNote === 'Please use the building portal for this one.');
  const queueFinal = await req('GET', '/bookos/setter-queue', { token: tokStaff });
  check('rejected request never reached the setter queue',
    !(queueFinal.json?.data?.queue || []).some((q) => String(q.issue || '').includes('DRILLMARK2')));

  console.log('— shield on the public doors —');
  const queueCountBefore = (queueFinal.json?.data?.queue || []).length;
  const honey = await req('POST', `/tenant-link/${token1}/requests`, { body: {
    unitId: unit12Id, tenantName: 'Bot Bot', tenantPhone: '954-555-0144', appliance: 'Washer', issue: 'spam spam spam DRILLMARK3', companyWebsite: 'http://spam.example',
  } });
  check('honeypot → same 201 success shape, NO status token issued',
    honey.status === 201 && honey.json?.data?.status === 'PENDING_APPROVAL' && !honey.json?.data?.statusToken, `got ${honey.status} ${JSON.stringify(honey.json)}`);
  const pendingAfterHoney = await req('GET', '/pm/requests?status=PENDING_APPROVAL', { token: tokA });
  check('honeypot persisted NOTHING (queue still empty)', (pendingAfterHoney.json?.data || []).length === 0);
  const badPhone = await req('POST', `/tenant-link/${token1}/requests`, { body: {
    unitId: unit12Id, tenantName: 'Real Person', tenantPhone: '123-456-7890', appliance: 'Washer', issue: 'Washer leaks DRILLMARK4',
  } });
  check('invalid phone → 400 INVALID_PHONE', badPhone.status === 400 && badPhone.json?.code === 'INVALID_PHONE', `got ${badPhone.status}`);
  const crossUnit = await req('POST', `/tenant-link/${token1}/requests`, { body: {
    unitId: '00000000-0000-4000-8000-0000000000ff', tenantName: 'Real Person', tenantPhone: '954-555-0145', appliance: 'Washer', issue: 'Wrong unit DRILLMARK5',
  } });
  check('unit from another property → 400', crossUnit.status === 400, `got ${crossUnit.status}`);
  const queueAfterShield = await req('GET', '/bookos/setter-queue', { token: tokStaff });
  check('setter queue unchanged by shield probes', (queueAfterShield.json?.data?.queue || []).length === queueCountBefore);

  console.log('— link revoke + rotate —');
  // The public tenant doors share the shield's connections family
  // (10/hour/IP) — the drill has legitimately used the hour's budget by
  // here, so reset the window on this throwaway DB to keep exercising
  // the link lifecycle (production keeps the real limit, untouched).
  await prisma.intakeRateWindow.deleteMany({});
  const revoked = await req('POST', `/pm/properties/${propId}/tenant-link/revoke`, { token: tokA, body: {} });
  check('PM-A revokes the link', revoked.status === 200 && revoked.json.data.status === 'REVOKED');
  const afterRevoke = await req('GET', `/tenant-link/${token1}`);
  check('revoked link → 404', afterRevoke.status === 404, `got ${afterRevoke.status}`);
  const link2 = await req('POST', `/pm/properties/${propId}/tenant-link`, { token: tokA, body: {} });
  const token2 = link2.json.data.token;
  check('rotated link differs from the old one', !!token2 && token2 !== token1);
  const oldStill = await req('GET', `/tenant-link/${token1}`);
  check('old token stays dead after rotation', oldStill.status === 404);
  const newWorks = await req('GET', `/tenant-link/${token2}`);
  check('new token resolves', newWorks.status === 200);

  console.log('— structured bulk intake: one form, individual records —');
  const bulk = await req('POST', '/pm/requests/bulk', { token: tokA, body: { propertyId: propId, requests: [
    { unitId: unit12Id, appliance: 'Washer', issue: 'Washer will not drain DRILLMARK6' },
    { unitId: unit7Id, appliance: 'Oven / Range', issue: 'Oven will not heat DRILLMARK7', urgency: 'urgent' },
  ] } });
  check('bulk → 201, count 2, shared batch reference',
    bulk.status === 201 && bulk.json.data.count === 2 && !!bulk.json.data.batchReference, `got ${bulk.status} ${JSON.stringify(bulk.json)}`);
  check('each row got its OWN connection + booking references',
    bulk.json.data.requests[0].connectionReference !== bulk.json.data.requests[1].connectionReference
    && bulk.json.data.requests[0].bookingReference !== bulk.json.data.requests[1].bookingReference);
  const queueBulk = await req('GET', '/bookos/setter-queue', { token: tokStaff });
  check('both bulk jobs are independently in the setter queue',
    (queueBulk.json?.data?.queue || []).some((q) => String(q.issue || '').includes('DRILLMARK6'))
    && (queueBulk.json?.data?.queue || []).some((q) => String(q.issue || '').includes('DRILLMARK7')));
  const bulkBad = await req('POST', '/pm/requests/bulk', { token: tokA, body: { propertyId: propId, requests: [
    { unitId: unit12Id, appliance: 'Washer', issue: 'Fine one DRILLMARK8' },
    { unitId: '00000000-0000-4000-8000-0000000000ee', appliance: 'Dryer', issue: 'Bad unit DRILLMARK9' },
  ] } });
  check('bulk with one bad unit → 400 (whole batch refused)', bulkBad.status === 400, `got ${bulkBad.status}`);
  const allReqs = await req('GET', '/pm/requests', { token: tokA });
  check('refused batch created NOTHING',
    !(allReqs.json?.data || []).some((r) => String(r.issue).includes('DRILLMARK8') || String(r.issue).includes('DRILLMARK9')));

  console.log('— per-unit service history —');
  const detail = await req('GET', `/pm/properties/${propId}`, { token: tokA });
  const u12 = (detail.json.data.units || []).find((u) => u.id === unit12Id);
  check('Unit 12 history carries its approved + bulk requests',
    !!u12 && u12.history.length >= 2 && u12.history.some((h) => h.bookingReference), JSON.stringify(u12?.history || null).slice(0, 300));
} finally {
  server.kill('SIGTERM');
  await sleep(500);
}

console.log('— statement fixtures (seeded at the DB, server restarts to hydrate) —');
const now = new Date();
const completedAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 10, 15, 0, 0));
async function seedCompletedJob({ ref, invoiceTotal, status, receiptsCents }) {
  const customer = await prisma.customer.create({ data: { companyId: COMPANY_ID, name: `Stmt Tenant ${ref}`, phone: '9545550199', city: 'Lauderhill', zip: '33313' } });
  const history = receiptsCents.map((amountCents, i) => ({
    type: 'RECEIPT_RECORDED', at: completedAt.toISOString(), actor: 'drill',
    receipt: { receiptId: `stmt-${ref}-${i}`, amountCents, method: 'CARD', recordedBy: 'drill' },
  }));
  const booking = await prisma.serviceRequest.create({ data: {
    companyId: COMPANY_ID, customerId: customer.id, referenceCode: ref, source: 'WEB_FORM',
    status: 'COMPLETED', city: 'Lauderhill', zip: '33313', appliance: 'Refrigerator', issue: 'Statement drill job',
    history, completedAt,
  } });
  await prisma.invoice.create({ data: {
    companyId: COMPANY_ID, serviceRequestId: booking.id, customerId: customer.id, status,
    subtotal: invoiceTotal, diagnosticFee: 99, diagnosticCredit: 99, total: invoiceTotal, currency: 'USD',
  } });
  const pmRow = await prisma.pmServiceRequest.create({ data: {
    companyId: COMPANY_ID, ownerId: pmA.id, propertyId: (await prisma.pmProperty.findFirst({ where: { ownerId: pmA.id } })).id,
    origin: 'CONSOLE', reference: `PM-STMT-${ref}`, contactName: 'Tessa Tenant', contactPhone: '9545550142',
    appliance: 'Refrigerator', issue: 'Statement drill job', status: 'SENT', bookingId: booking.id, bookingReference: ref,
  } });
  return pmRow;
}
await seedCompletedJob({ ref: 'TS-STMT01', invoiceTotal: 459.0, status: 'PAID', receiptsCents: [20000, 25900] });
await seedCompletedJob({ ref: 'TS-STMT02', invoiceTotal: 210.0, status: 'PARTIALLY_PAID', receiptsCents: [10000] });

const server2 = spawn('node', ['src/server.js'], {
  cwd: new URL('../', import.meta.url).pathname,
  env: { ...process.env, PORT: String(PORT), NODE_ENV: 'test', ['JWT_' + 'SECRET']: 'pm-portfolio-drill-secret' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let bootLog2 = '';
server2.stdout.on('data', (d) => { bootLog2 += d; });
server2.stderr.on('data', (d) => { bootLog2 += d; });
try {
  if (!(await waitHealthy())) { console.error('API (phase 2) did not become healthy.\n' + bootLog2.slice(-3000)); process.exit(1); }
  const tokA2 = await login('pm-a@drill.test');
  const tokB2 = await login('pm-b@drill.test');
  console.log('— monthly statement math —');
  const stmt = await req('GET', `/pm/statements/${MONTH}`, { token: tokA2 });
  check('statement loads for the current month', stmt.status === 200, `got ${stmt.status} ${JSON.stringify(stmt.json).slice(0, 300)}`);
  const lines = stmt.json?.data?.lines || [];
  const l1 = lines.find((l) => l.bookingReference === 'TS-STMT01');
  const l2 = lines.find((l) => l.bookingReference === 'TS-STMT02');
  check('job 1: invoiced 45900, paid 45900 (two receipts folded), balance 0',
    !!l1 && l1.invoiceTotalCents === 45900 && l1.paidCents === 45900 && l1.balanceDueCents === 0, JSON.stringify(l1 || null));
  check('job 2: invoiced 21000, paid 10000, balance 11000',
    !!l2 && l2.invoiceTotalCents === 21000 && l2.paidCents === 10000 && l2.balanceDueCents === 11000, JSON.stringify(l2 || null));
  const totals = stmt.json?.data?.totals || {};
  check('totals: 2 jobs, invoiced 66900, paid 55900, balance 11000',
    totals.jobs === 2 && totals.invoicedCents === 66900 && totals.paidCents === 55900 && totals.balanceDueCents === 11000,
    JSON.stringify(totals));
  const empty = await req('GET', '/pm/statements/2020-01', { token: tokA2 });
  check('empty month says so (no invented figures)',
    empty.status === 200 && empty.json.data.lines.length === 0 && empty.json.data.totals.jobs === 0
    && /No completed jobs/.test(empty.json.data.note || ''), JSON.stringify(empty.json?.data || null).slice(0, 300));
  const stmtB = await req('GET', `/pm/statements/${MONTH}`, { token: tokB2 });
  check('PM-B statement shows NONE of PM-A jobs', (stmtB.json?.data?.lines || []).length === 0);
} finally {
  server2.kill('SIGTERM');
  await sleep(500);
  await prisma.$disconnect();
}

console.log(`\nPM PORTFOLIO DRILLS: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
