/**
 * Tech App full-package dispatch rebuild — verification harness (2026-11-19).
 *
 * Exercises Ramone's full-package Field Pro build end to end over
 * HTTP: the dispatch overview, the consolidated /full job record,
 * unified job-details editing (field + office variants, round-tripped
 * through the CRM read path — NO SILO), the estimate decision →
 * invoice → payment workflow with overpayment prevention, warranty
 * coverage + claims as first-class records, property records, the
 * suppliers directory, the company card, the repair-knowledge lookup,
 * the AI-fill draft contract (drafts never persist), the review-link
 * flow through the real outbox, ownership enforcement (a second
 * provider gets 404s; oversight reads but cannot work the job), and
 * the assistant-surface statics (Ask Pepper on staff surfaces, the
 * movable launcher, no Speedy widget on /tech).
 *
 * Runs against a LOCAL test database only. Usage:
 *   DATABASE_URL=postgresql://... node test/tech-dispatch-package.test.mjs
 * Exit code 0 = every check passed.
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
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

const PORT = Number(process.env.TEST_PORT || 4427);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const PASSWORD = 'test-pass-1234';

const IDS = {
  providerCompany: '30000000-0000-4000-8000-0000000000a1',
  provider: '30000000-0000-4000-8000-0000000000a2',
  tech: '30000000-0000-4000-8000-0000000000a3',
  providerCompanyB: '30000000-0000-4000-8000-0000000000b1',
  providerB: '30000000-0000-4000-8000-0000000000b2',
  techB: '30000000-0000-4000-8000-0000000000b3',
  owner: '30000000-0000-4000-8000-0000000000c1',
  customerUser: '30000000-0000-4000-8000-0000000000c2',
  customer: '30000000-0000-4000-8000-0000000000d6',
  booking: '30000000-0000-4000-8000-0000000000d7',
  assignment: '30000000-0000-4000-8000-0000000000d8',
  part: '30000000-0000-4000-8000-0000000000d9',
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
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
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
    where: { id: PLATFORM_COMPANY_ID },
    update: {},
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'test-platform', type: 'PLATFORM_OWNER', isPlatformOwner: true },
  });
  for (const [companyId, name, slug] of [
    [IDS.providerCompany, 'Dispatch Test Provider Co', 'dispatch-test-provider'],
    [IDS.providerCompanyB, 'Dispatch Test Provider B', 'dispatch-test-provider-b'],
  ]) {
    await prisma.company.upsert({
      where: { id: companyId },
      update: {},
      create: { id: companyId, name, slug, type: 'INDEPENDENT_PROVIDER' },
    });
  }
  for (const [id, companyId, name] of [
    [IDS.provider, IDS.providerCompany, 'Dispatch Test Provider Co'],
    [IDS.providerB, IDS.providerCompanyB, 'Dispatch Test Provider B'],
  ]) {
    await prisma.provider.upsert({
      where: { id },
      update: {},
      create: { id, companyId, businessName: name, type: 'INDEPENDENT_PROVIDER', specialties: [], serviceCities: [] },
    });
  }
  for (const [id, companyId, email, roles] of [
    [IDS.tech, IDS.providerCompany, 'dispatch-tech@test.local', ['PROVIDER_TECH']],
    [IDS.techB, IDS.providerCompanyB, 'dispatch-tech-b@test.local', ['PROVIDER_TECH']],
    [IDS.owner, PLATFORM_COMPANY_ID, 'dispatch-owner@test.local', ['COMPANY_OWNER']],
    [IDS.customerUser, PLATFORM_COMPANY_ID, 'dispatch-customer@test.local', ['CUSTOMER']],
  ]) {
    await prisma.user.upsert({
      where: { id },
      update: { passwordHash },
      create: { id, companyId, email, passwordHash, phone: '9545550110', roles, active: true },
    });
  }
  await prisma.part.upsert({
    where: { id: IDS.part },
    update: {},
    create: { id: IDS.part, sku: 'TEST-DRAIN-PUMP-2', name: 'Drain Pump (test 2)', category: 'Pumps', brand: 'TestBrand', unitCostCents: 2200, sellPriceCents: 4500, stockOnHand: 10, reorderPoint: 1, active: true },
  });

  const now = new Date().toISOString();
  const customer = {
    id: IDS.customer, companyId: PLATFORM_COMPANY_ID, userId: null,
    name: 'Dispatch Test Customer', phone: '9545550178', email: 'dispatch-customer-record@test.local',
    address: '742 Test Terrace', city: 'Fort Lauderdale', zip: '33311', createdAt: now,
  };
  const booking = {
    id: IDS.booking, companyId: PLATFORM_COMPANY_ID, customerId: customer.id,
    customer, referenceCode: 'TS-DSP001', source: 'TEST',
    city: 'Fort Lauderdale', zip: '33311', serviceAddress: '742 Test Terrace',
    appliance: 'Washer', issue: 'Not draining',
    preferredWindow: null, diagnosticFee: 99, diagnosticFeeCreditedTowardRepair: true,
    feeStatus: 'COLLECTED_AT_BOOKING', status: 'CONFIRMED',
    dispatch: { mode: 'HYBRID', stage: 'ASSIGNED', candidateProviderIds: [], assignmentIds: [IDS.assignment] },
    history: [], createdAt: now, updatedAt: now,
  };
  const assignment = {
    id: IDS.assignment, companyId: PLATFORM_COMPANY_ID, bookingId: booking.id,
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

async function cleanup() {
  try {
    // The outbox is persisted and keyed per booking — a prior run's
    // review request must not leak into the next run's fresh booking.
    await prisma.notificationOutbox.deleteMany({ where: { eventKey: { startsWith: `booking:${IDS.booking}:` } } });
    await prisma.warrantyClaim.deleteMany({ where: { serviceRequestId: IDS.booking } });
    await prisma.warranty.deleteMany({ where: { serviceRequestId: IDS.booking } });
    await prisma.property.deleteMany({ where: { customerId: IDS.customer } });
    await prisma.invoice.deleteMany({ where: { serviceRequestId: IDS.booking } });
    await prisma.dispatchAssignment.deleteMany({ where: { id: IDS.assignment } });
    await prisma.serviceRequest.deleteMany({ where: { id: IDS.booking } });
    await prisma.customer.deleteMany({ where: { id: IDS.customer } });
    await prisma.part.deleteMany({ where: { id: IDS.part } });
    await prisma.user.deleteMany({ where: { id: { in: [IDS.tech, IDS.techB, IDS.owner, IDS.customerUser] } } });
    await prisma.provider.deleteMany({ where: { id: { in: [IDS.provider, IDS.providerB] } } });
    await prisma.company.deleteMany({ where: { id: { in: [IDS.providerCompany, IDS.providerCompanyB] } } });
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
      JWT_SECRET: 'dispatch-package-test-secret',
      DATABASE_URL: process.env.DATABASE_URL,
      DATABASE_URL_UNPOOLED: process.env.DATABASE_URL_UNPOOLED,
      // Speedy deliberately unconfigured in drills: AI-fill and plate
      // read must answer their honest 503, never fabricate a draft.
      OPENAI_API_KEY: '',
      OPENAI_API_KEY_V2: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[api] ${d}`));
  await waitForServer();

  const A = `/provider/assignments/${IDS.assignment}`;
  const tech = await login('dispatch-tech@test.local');
  const techB = await login('dispatch-tech-b@test.local');
  const owner = await login('dispatch-owner@test.local');
  const customer = await login('dispatch-customer@test.local');

  // ---- Gates: anon 401 everywhere new; customer role refused ----
  for (const path of ['/provider/overview', `${A}/full`, '/provider/suppliers', '/provider/company', '/provider/knowledge?q=washer', '/provider/warranty-claims']) {
    check(`anon 401 ${path.split('?')[0]}`, (await api(path)).status, 401);
  }
  check('customer role refused on overview', (await api('/provider/overview', { token: customer })).status, 403);

  // ---- Accept + dispatch overview ----
  check('accept offer', (await api(`${A}/accept`, { token: tech, method: 'POST', body: {} })).status, 200);
  const ov = await api('/provider/overview', { token: tech });
  check('provider overview 200', ov.status, 200);
  check('overview accepted count', ov.json.data.counts.accepted, 1);
  check('overview offers drained', ov.json.data.counts.offers, 0);
  const ovOwner = await api('/provider/overview', { token: owner });
  check('oversight overview 200', ovOwner.status, 200);
  check('oversight flag', ovOwner.json.data.oversight, true);
  checkTrue('oversight per-provider rows', (ovOwner.json.data.perProvider || []).some((p) => p.providerId === IDS.provider));

  // ---- The consolidated /full record ----
  const full = await api(`${A}/full`, { token: tech });
  check('full 200', full.status, 200);
  check('full customer name', full.json.data.customer.record.name, 'Dispatch Test Customer');
  check('full booking history count', full.json.data.customer.bookingHistoryCount, 1);
  check('full appliance type', full.json.data.appliance.type, 'Washer');
  check('full technician business', full.json.data.technician.provider.businessName, 'Dispatch Test Provider Co');
  check('full review link is the real Pepper Lists wall', full.json.data.review.link, 'https://pepperlists.com/#reviews');
  check('full review not yet requested', full.json.data.review.requested, false);
  check('full as oversight 200', (await api(`${A}/full`, { token: owner })).status, 200);
  check('full as other provider 404', (await api(`${A}/full`, { token: techB })).status, 404);
  check('oversight cannot work the job (diagnosis 403)', (await api(`${A}/diagnosis`, { token: owner, method: 'POST', body: { symptoms: 'x', confirmedFault: 'y', recommendedRepair: 'z' } })).status, 403);

  // ---- Unified editing: office variant round-trips through CRM ----
  const officeEdit = await api(`${A}/job-details/office`, { token: owner, method: 'PATCH', body: { customerName: 'Edited By Office' } });
  check('office job-details edit 200', officeEdit.status, 200);
  checkTrue('office edit reports the field', (officeEdit.json.data.updated || []).includes('customerName'));
  const crm = await api(`/crm/customers/${IDS.customer}`, { token: owner });
  check('CRM read 200', crm.status, 200);
  checkTrue('CRM sees the Tech App office edit (no silo)', JSON.stringify(crm.json).includes('Edited By Office'));
  const fieldEdit = await api(`${A}/job-details`, { token: tech, method: 'PATCH', body: { issue: 'Not draining and leaking at the base', preferredWindow: 'Weekday mornings' } });
  check('field job-details edit 200', fieldEdit.status, 200);
  const fullAfterEdit = await api(`${A}/full`, { token: tech });
  check('full shows the field edit', fullAfterEdit.json.data.booking.issue, 'Not draining and leaking at the base');
  check('provider cannot rewrite provenance (source)', (await api(`${A}/job-details`, { token: tech, method: 'PATCH', body: { source: 'FORGED' } })).status, 400);
  check('other provider cannot edit (404)', (await api(`${A}/job-details`, { token: techB, method: 'PATCH', body: { issue: 'hijack attempt' } })).status, 404);

  // ---- Diagnosis + AI-fill draft contract ----
  const diag = await api(`${A}/diagnosis`, {
    token: tech, method: 'POST',
    body: {
      applianceBrand: 'TestBrand', model: 'TB-100', serial: 'SN123',
      symptoms: 'Washer fills but will not drain',
      confirmedFault: 'Drain pump impeller jammed',
      recommendedRepair: 'Replace drain pump',
      readings: [], testChecklist: [], safetyConfirmed: true,
    },
  });
  check('diagnosis saved', diag.status, 201);
  const aiFill = await api(`${A}/ai-diagnosis/preview`, { token: tech, method: 'POST', body: { text: 'drain pump is jammed, replace it' } });
  check('AI-fill honest 503 while Speedy unconfigured', aiFill.status, 503);
  const wsAfterAi = await api(`${A}/workspace`, { token: tech });
  check('AI-fill persisted nothing (diagnosis untouched)', wsAfterAi.json.data.diagnosis.confirmedFault, 'Drain pump impeller jammed');

  // ---- Estimate → decision → invoice → payments ----
  const est = await api(`${A}/estimate`, {
    token: tech, method: 'POST',
    body: { kind: 'REPAIR', parts: [{ description: 'Drain pump', qty: 1, unitPriceCents: 4500 }], taxRatePercent: 7, discountCents: 0 },
  });
  check('estimate saved', est.status, 201);
  check('estimate total (210 + 45 + 3.15 tax − 99 credit)', est.json.data.estimate.totalCents, 15915);
  check('invoice refused before approval', (await api(`${A}/invoice`, { token: tech, method: 'POST', body: {} })).status, 409);
  const declined = await api(`${A}/estimate/decision`, { token: tech, method: 'POST', body: { decision: 'DECLINED', note: 'Customer wants to think it over' } });
  check('decision DECLINED recorded', declined.status, 201);
  check('decision reads back DECLINED', declined.json.data.estimateDecision.decision, 'DECLINED');
  const approved = await api(`${A}/estimate/decision`, { token: tech, method: 'POST', body: { decision: 'APPROVED', method: 'IN_PERSON_VERBAL', authorizedByName: 'Edited By Office' } });
  check('decision APPROVED recorded', approved.status, 201);
  check('decision reads back APPROVED', approved.json.data.estimateDecision.decision, 'APPROVED');
  const inv = await api(`${A}/invoice`, { token: tech, method: 'POST', body: {} });
  check('invoice generated', inv.status, 201);
  check('invoice total dollars', inv.json.data.invoice.total, 159.15);
  const invAgain = await api(`${A}/invoice`, { token: tech, method: 'POST', body: {} });
  check('invoice idempotent', invAgain.status, 200);
  check('invoice idempotent flag', invAgain.json.data.created, false);
  check('overpayment refused', (await api(`${A}/receipts`, { token: tech, method: 'POST', body: { method: 'CASH', amountCents: 15916 } })).status, 409);
  const rc1 = await api(`${A}/receipts`, { token: tech, method: 'POST', body: { method: 'CASH', amountCents: 5915 } });
  check('partial receipt recorded', rc1.status, 201);
  check('invoice partially paid', rc1.json.data.payments.invoice.status, 'PARTIALLY_PAID');
  check('balance after partial', rc1.json.data.payments.balanceDueCents, 10000);
  const rc2 = await api(`${A}/receipts`, { token: tech, method: 'POST', body: { method: 'CHECK', amountCents: 10000 } });
  check('final receipt recorded', rc2.status, 201);
  check('invoice paid in full', rc2.json.data.payments.invoice.status, 'PAID');
  check('balance zero', rc2.json.data.payments.balanceDueCents, 0);

  // ---- Warranty coverage + claims ----
  const war = await api(`${A}/warranty`, { token: tech, method: 'POST', body: { provider: 'Test Home Warranty', policyNumber: 'POL-1', coverage: 'Washer drive system' } });
  check('warranty coverage recorded', war.status, 201);
  const fullWar = await api(`${A}/full`, { token: tech });
  check('full shows one warranty', (fullWar.json.data.warranties || []).length, 1);
  check('warranty provider on record', fullWar.json.data.warranties[0].provider, 'Test Home Warranty');
  const claim = await api(`${A}/warranty-claims`, { token: tech, method: 'POST', body: { description: 'Drain pump failure — covered part' } });
  check('claim filed', claim.status, 201);
  check('claim starts OPEN', claim.json.data.claim.status, 'OPEN');
  const claimId = claim.json.data.claim.id;
  const lookup = await api('/provider/warranty-claims?q=Test%20Home%20Warranty', { token: tech });
  checkTrue('claim lookup finds it', (lookup.json.data.claims || []).some((c) => c.id === claimId));
  check('claim status advance', (await api(`/provider/warranty-claims/${claimId}/status`, { token: tech, method: 'POST', body: { status: 'FILED' } })).json.data.claim.status, 'FILED');
  check('other provider cannot touch the claim (404)', (await api(`/provider/warranty-claims/${claimId}/status`, { token: techB, method: 'POST', body: { status: 'CLOSED' } })).status, 404);

  // ---- Property ----
  const prop = await api(`${A}/property`, { token: tech, method: 'POST', body: { label: 'Main home', accessNotes: 'Gate code 1234' } });
  check('property saved', prop.status, 201);
  const fullProp = await api(`${A}/full`, { token: tech });
  check('full shows the property', fullProp.json.data.property.label, 'Main home');

  // ---- Suppliers / company / knowledge ----
  const suppliers = await api('/provider/suppliers', { token: tech });
  checkTrue('partner supplier listed', (suppliers.json.data.suppliers || []).some((s) => s.name === 'Appliance Plus Parts Supply'));
  const company = await api('/provider/company', { token: tech });
  check('company phone display', company.json.data.business.phoneDisplay, '(954) 931-7997');
  check('company repair labor rule', company.json.data.pricing.repairLaborFlat, 210);
  const knowledge = await api('/provider/knowledge?q=refrigerator', { token: tech });
  checkTrue('knowledge returns real entries', (knowledge.json.data.results || []).length > 0);

  // ---- Plate-read contracts (drill env: Speedy unconfigured → 503;
  //      production, configured, answers 400 to an incomplete body) ----
  check('provider plate-read incomplete body', (await api(`${A}/plate-read`, { token: tech, method: 'POST', body: {} })).status, 503);
  check('standalone plate-read incomplete body', (await api('/pepper-lists/plate-read', { token: customer, method: 'POST', body: {} })).status, 503);

  // ---- Review flow ----
  check('review send refused before completion', (await api(`${A}/review-request`, { token: tech, method: 'POST', body: {} })).status, 409);
  const done = await api(`${A}/complete`, { token: tech, method: 'POST', body: {} });
  check('completion passes the quality gate', done.status, 200);
  const fullDone = await api(`${A}/full`, { token: tech });
  check('review requested at completion', fullDone.json.data.review.requested, true);
  const resend = await api(`${A}/review-request`, { token: tech, method: 'POST', body: {} });
  check('review send endpoint 200', resend.status, 200);
  check('no double-send (outbox dedupe)', resend.json.data.newlyQueued, 0);

  // ---- Assistant-surface statics (Ramone's Ask Pepper rule + movable launcher) ----
  const webRoot = fileURLToPath(new URL('../../web/', import.meta.url));
  const techHtml = await readFile(`${webRoot}tech/index.html`, 'utf8');
  checkTrue('/tech loads Ask Pepper chat', techHtml.includes('/shared/pepper-chat.js'));
  checkTrue('/tech has NO Speedy widget', !techHtml.includes('speedy-widget.js'));
  checkTrue('/tech presents Ask Pepper', techHtml.includes('Ask Pepper'));
  checkTrue('/tech never presents Ask Speedy', !techHtml.includes('Ask Speedy'));
  checkTrue('/tech loads the PLCamera module', techHtml.includes('/pepper-lists-site/pl-camera.js'));
  checkTrue('/tech Plug opens the camera (plugCamOpen + auto-open)', techHtml.includes('plugCamOpen') && techHtml.includes('plugAutoCam'));
  checkTrue('/tech wires the real plate reads', techHtml.includes('/plate-read'));
  const pepperChat = await readFile(`${webRoot}shared/pepper-chat.js`, 'utf8');
  checkTrue('pepper launcher is draggable (pointer events)', pepperChat.includes('pointermove') && pepperChat.includes('setPointerCapture'));
  checkTrue('pepper launcher persists position for the session', pepperChat.includes("sessionStorage") && pepperChat.includes('pcb_pos'));
  checkTrue('pepper launcher docks clear of bottom nav', pepperChat.includes('pcbBottomNavHeight'));
  for (const page of ['service-setters-dispatch/index.html', 'dispatch-dashboard/index.html', 'parts/index.html', 'manager/index.html', 'applianceman/index.html', 'finance/index.html']) {
    const html = await readFile(`${webRoot}${page}`, 'utf8');
    checkTrue(`${page} carries Ask Pepper, no Speedy widget`, html.includes('pepper-chat.js') && !html.includes('speedy-widget.js'));
  }
  const homeHtml = await readFile(`${webRoot}index.html`, 'utf8').catch(() => '');
  checkTrue('homepage (customer surface) keeps Speedy', homeHtml.includes('speedy-widget.js') || homeHtml.includes('Tell Speedy'));

  // ---- Public-route sanity (shared-prefix trap) ----
  check('payments/status public', (await api('/payments/status')).status, 200);

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(async () => {
    if (server) server.kill('SIGTERM');
    await cleanup();
    await prisma.$disconnect();
  });
