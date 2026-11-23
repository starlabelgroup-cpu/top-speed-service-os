/**
 * ApplianceMan master-workstation options build — drills (2026-11-23).
 *
 * Ramone's directive: "Create options and settings with delete options
 * for everything in applianceman master workstation" + the scope
 * extension (report-card Delete / View / Reset on the management
 * feeds, the same option set on the Service Setters dispatch station,
 * and the duplicate DISPATCH_APPROVED investigation).
 *
 * SKELETON MODE (no DATABASE_URL — this VM has no postgres user, so
 * DB-backed suites cannot run here; production behavior with a
 * database follows the same code paths through the repos, whose
 * durable writes are fire-and-forget / deleteMany by id).
 *
 * Proves, over HTTP against a real boot:
 *  A. Management reports — delete / reset / detail endpoints:
 *     anonymous 401 · manager-tier (COMPANY_ADMIN) delete+reset 403 ·
 *     owner delete removes the row from subsequent reads · delete
 *     covers the same-eventKey unit · reset clears the ack stamp and
 *     a re-ack stamps fresh · reset of a NEW report is alreadyNew ·
 *     detail returns the report + its booking + the booking's
 *     tracking sources exactly as recorded (absent field = null).
 *  B. Pepper reports — owner-only delete; staff create still works;
 *     manager-tier delete refused.
 *  C. Tracking numbers — owner-only delete; the row leaves the
 *     registry; a second delete 404s.
 *  D. Commercial — agreement with generated work orders refuses 409;
 *     a clean agreement deletes; a customer-approved quote refuses
 *     409; a draft quote deletes.
 *  E. Master protection — the owner account cannot be removed
 *     through the account-removal path (self + COMPANY_OWNER target);
 *     a plain customer account with no records removes cleanly.
 *  F. Dispatch station — assign is idempotent (the 2026-11-23
 *     duplicate fix: two identical assigns mint exactly ONE
 *     DISPATCH_APPROVED report and keep ONE assignment); the job
 *     detail endpoint returns booking + tracking sources; reset-
 *     dispatch returns the job to PENDING_DISPATCH with no active
 *     assignment, and a fresh assign works afterwards.
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../src/services/passwords.js';

if (process.env.DATABASE_URL) {
  console.error('DATABASE_URL must NOT be set for the skeleton drill.');
  process.exit(2);
}

const PORT = process.env.TEST_PORT || 4623;
const B = `http://127.0.0.1:${PORT}/api/v1`;
const PW = ['Options', 'Drill', 'Pw', '2026'].join('-');
const JWT = ['options', 'drill', 'jwt', 'secret'].join('-');
const COMPANY = '10000000-0000-4000-8000-000000000001';
const NOW = '2026-11-23T05:00:00.000Z';

const IDS = {
  owner: '20000000-0000-4000-8000-0000000000o1'.replace('o', '0'),
  admin: '20000000-0000-4000-8000-0000000000a1',
  dispatcher: '20000000-0000-4000-8000-0000000000d1',
  customer: '20000000-0000-4000-8000-0000000000c1',
  bookingDetail: '40000000-0000-4000-8000-0000000000b1',
  bookingJob: '40000000-0000-4000-8000-0000000000b2',
  provider: '30000000-0000-4000-8000-000000000003',
  agrClean: '50000000-0000-4000-8000-0000000000g1'.replace('g', '0'),
  agrBusy: '50000000-0000-4000-8000-0000000000e2',
  quoteDraft: '50000000-0000-4000-8000-0000000000q1'.replace('q', '0'),
  quoteApproved: '50000000-0000-4000-8000-0000000000f2',
};
const EMAILS = {
  owner: 'owner@optionsdrill.test',
  admin: 'admin@optionsdrill.test',
  dispatcher: 'setter@optionsdrill.test',
  customer: 'customer@optionsdrill.test',
};
const REPORTS = {
  flow: '60000000-0000-4000-8000-0000000000r1'.replace('r', '0'),
  unit1: '60000000-0000-4000-8000-0000000000e2',
  unit2: '60000000-0000-4000-8000-0000000000e3',
  detail: '60000000-0000-4000-8000-0000000000e4',
};

const [ownerHash, adminHash, dispatcherHash, customerHash] = await Promise.all([
  hashPassword(PW), hashPassword(PW), hashPassword(PW), hashPassword(PW),
]);
const seedUser = (id, email, hash, roles) => ({
  id, companyId: COMPANY, email, passwordHash: hash,
  firstName: 'Drill', lastName: 'User', phone: null, roles,
  active: true, emailVerifiedAt: NOW,
  verifyRequired: false, layer2Required: false, layer2Phone: null, layer2Channel: null,
  createdAt: NOW,
});
const seedReport = (id, over = {}) => ({
  id, department: 'booking', type: 'BOOKING', title: `Drill report ${id.slice(-2)}`,
  detail: { reference: 'TS-OPT0' }, source: 'drill', reference: 'TS-OPT0',
  eventKey: `drill:${id}`, status: 'NEW', ackById: null, ackAt: null, createdAt: NOW, ...over,
});
const seedReports = [
  seedReport(REPORTS.flow),
  seedReport(REPORTS.unit1, { eventKey: 'drill:unit' }),
  seedReport(REPORTS.unit2, { eventKey: 'drill:unit' }),
  seedReport(REPORTS.detail, {
    type: 'BOOKING', reference: 'TS-OPT1',
    detail: { bookingId: IDS.bookingDetail, referenceCode: 'TS-OPT1' },
  }),
];
const seedBookingDetail = {
  id: IDS.bookingDetail, companyId: COMPANY, customerId: null,
  customer: { name: 'Detail Customer', phone: '9545550111', email: 'detail@customer.test' },
  referenceCode: 'TS-OPT1', status: 'CONFIRMED', appliance: 'Refrigerator', issue: 'Not cooling',
  city: 'Fort Lauderdale', zip: '33301', source: 'WEBSITE', sourcePage: '/book',
  viaTag: 'speedy-chat', utmSource: 'google', utmMedium: 'cpc', utmCampaign: 'broward-repair',
  gclid: 'drill-gclid-123', referralCode: 'REF-OPT1',
  feeStatus: 'COLLECTED_AT_BOOKING', diagnosticFee: 9900,
  dispatch: { stage: 'APPROVED_BY_SERVICE_SETTERS', assignmentId: 'asg-drill', providerId: IDS.provider },
  history: [{ type: 'BOOKING_CREATED', at: NOW, actor: 'system' }],
  createdAt: NOW, updatedAt: NOW,
};
const seedBookingJob = {
  id: IDS.bookingJob, companyId: COMPANY, customerId: null,
  customer: { name: 'Job Customer', phone: '9545550122', email: 'job@customer.test' },
  referenceCode: 'TS-OPT2', status: 'PENDING_DISPATCH', appliance: 'Dryer', issue: 'Not heating',
  city: 'Lauderhill', zip: '33313', source: 'WEBSITE', utmSource: 'facebook', fbclid: 'drill-fbclid-9',
  history: [], dispatch: null, feeStatus: 'COLLECTED_AT_BOOKING', createdAt: NOW, updatedAt: NOW,
};
const seedProvider = {
  id: IDS.provider, companyId: COMPANY, businessName: 'Drill Provider', type: 'COMPANY',
  active: true, specialties: ['Dryer'], serviceCities: ['Lauderhill'], rating: 5, createdAt: NOW, updatedAt: NOW,
};
const seedAgreement = (id, over = {}) => ({
  id, companyId: COMPANY, accountId: 'acct-drill', facilityId: 'fac-drill',
  status: 'ACTIVE', cadence: 'MONTHLY', referenceCode: `AGR-${id.slice(-2)}`, createdAt: NOW, updatedAt: NOW, ...over,
});
const seedQuote = (id, over = {}) => ({
  id, companyId: COMPANY, accountId: 'acct-drill', status: 'DRAFT',
  referenceCode: `Q-${id.slice(-2)}`, lineItems: [], totalCents: 12000, createdAt: NOW, updatedAt: NOW, ...over,
});

const preloadPath = fileURLToPath(new URL('./.optionsdrill-preload.mjs', import.meta.url));
writeFileSync(preloadPath, `
import { store } from '../src/data/store.js';
store.users.set(${JSON.stringify(IDS.owner)}, ${JSON.stringify(seedUser(IDS.owner, EMAILS.owner, ownerHash, ['COMPANY_OWNER']))});
store.users.set(${JSON.stringify(IDS.admin)}, ${JSON.stringify(seedUser(IDS.admin, EMAILS.admin, adminHash, ['COMPANY_ADMIN']))});
store.users.set(${JSON.stringify(IDS.dispatcher)}, ${JSON.stringify(seedUser(IDS.dispatcher, EMAILS.dispatcher, dispatcherHash, ['DISPATCHER']))});
store.users.set(${JSON.stringify(IDS.customer)}, ${JSON.stringify(seedUser(IDS.customer, EMAILS.customer, customerHash, ['CUSTOMER']))});
for (const r of ${JSON.stringify(seedReports)}) store.departmentReports.push(r);
store.bookings.set(${JSON.stringify(IDS.bookingDetail)}, ${JSON.stringify(seedBookingDetail)});
store.bookings.set(${JSON.stringify(IDS.bookingJob)}, ${JSON.stringify(seedBookingJob)});
store.providers = [${JSON.stringify(seedProvider)}];
store.maintenanceAgreements.set(${JSON.stringify(IDS.agrClean)}, ${JSON.stringify(seedAgreement(IDS.agrClean))});
store.maintenanceAgreements.set(${JSON.stringify(IDS.agrBusy)}, ${JSON.stringify(seedAgreement(IDS.agrBusy))});
store.commercialWorkOrders.set('wo-drill-1', { id: 'wo-drill-1', companyId: ${JSON.stringify(COMPANY)}, agreementId: ${JSON.stringify(IDS.agrBusy)}, status: 'OPEN', createdAt: ${JSON.stringify(NOW)} });
store.commercialQuotes.set(${JSON.stringify(IDS.quoteDraft)}, ${JSON.stringify(seedQuote(IDS.quoteDraft))});
store.commercialQuotes.set(${JSON.stringify(IDS.quoteApproved)}, ${JSON.stringify(seedQuote(IDS.quoteApproved, { status: 'APPROVED', workOrderId: 'wo-drill-9' }))});
`);

const child = spawn(process.execPath, ['--import', preloadPath, 'src/server.js'], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  env: { ...process.env, PORT: String(PORT), JWT_SECRET: JWT, ALLOW_DEMO_AUTH: 'false' },
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
async function req(method, path, body, token) {
  const r = await fetch(B + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep raw */ }
  return { status: r.status, json, text };
}
const data = (r) => (r.json && (r.json.data || r.json)) || {};
async function waitForHealth(tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    try { const r = await fetch(B + '/health'); if (r.ok) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}
const login = async (email) => data(await req('POST', '/auth/login', { email, password: PW })).token;

try {
  checkTrue('BOOT: API boots and /health answers', await waitForHealth(), childLog.slice(-400));
  const owner = await login(EMAILS.owner);
  const admin = await login(EMAILS.admin);
  const dispatcher = await login(EMAILS.dispatcher);
  checkTrue('owner sign-in returns a token', typeof owner === 'string' && owner.length > 10);
  checkTrue('admin sign-in returns a token', typeof admin === 'string' && admin.length > 10);
  checkTrue('dispatcher sign-in returns a token', typeof dispatcher === 'string' && dispatcher.length > 10);

  /* ── A. Management reports ─────────────────────────────── */
  check('A1 anonymous report delete → 401', (await req('POST', `/management/reports/${REPORTS.flow}/delete`, {})).status, 401);
  check('A2 anonymous report reset → 401', (await req('POST', `/management/reports/${REPORTS.flow}/reset`, {})).status, 401);
  check('A3 anonymous report detail → 401', (await req('GET', `/management/reports/${REPORTS.flow}/detail`)).status, 401);
  check('A4 manager-tier delete → 403 (owner gate)', (await req('POST', `/management/reports/${REPORTS.flow}/delete`, {}, admin)).status, 403);
  check('A5 manager-tier reset → 403 (owner gate)', (await req('POST', `/management/reports/${REPORTS.flow}/reset`, {}, admin)).status, 403);
  check('A6 dispatcher delete → 403', (await req('POST', `/management/reports/${REPORTS.flow}/delete`, {}, dispatcher)).status, 403);
  check('A7 manager-tier detail read → 200', (await req('GET', `/management/reports/${REPORTS.detail}/detail`, undefined, admin)).status, 200);

  const det = await req('GET', `/management/reports/${REPORTS.detail}/detail`, undefined, owner);
  check('A8 owner detail → 200', det.status, 200);
  check('A9 detail carries the eventKey', data(det).report?.eventKey, `drill:${REPORTS.detail}`);
  check('A10 detail resolves the linked booking', data(det).booking?.referenceCode, 'TS-OPT1');
  check('A11 tracking: utmSource as recorded', data(det).booking?.tracking?.utmSource, 'google');
  check('A12 tracking: utmCampaign as recorded', data(det).booking?.tracking?.utmCampaign, 'broward-repair');
  check('A13 tracking: gclid as recorded', data(det).booking?.tracking?.gclid, 'drill-gclid-123');
  check('A14 tracking: viaTag as recorded', data(det).booking?.tracking?.viaTag, 'speedy-chat');
  check('A15 tracking: referralCode as recorded', data(det).booking?.tracking?.referralCode, 'REF-OPT1');
  check('A16 tracking: unrecorded field is null, not invented', data(det).booking?.tracking?.utmTerm, null);
  check('A17 detail: booking dispatch present', data(det).booking?.dispatch?.stage, 'APPROVED_BY_SERVICE_SETTERS');
  check('A18 detail of unknown report → 404', (await req('GET', '/management/reports/nope/detail', undefined, owner)).status, 404);

  const ack = await req('POST', `/management/reports/${REPORTS.flow}/ack`, {}, owner);
  check('A19 ack flow report → 200', ack.status, 200);
  const stamp1 = data(ack).report?.ackAt;
  checkTrue('A20 ack stamps ackAt', typeof stamp1 === 'string' && stamp1.length > 0);
  const reset = await req('POST', `/management/reports/${REPORTS.flow}/reset`, {}, owner);
  check('A21 owner reset → 200', reset.status, 200);
  check('A22 reset returns status NEW', data(reset).report?.status, 'NEW');
  check('A23 reset clears ackAt', data(reset).report?.ackAt, null);
  check('A24 reset clears ackById', data(reset).report?.ackById, null);
  check('A25 reset of a NEW report → alreadyNew true', data(await req('POST', `/management/reports/${REPORTS.flow}/reset`, {}, owner)).alreadyNew, true);
  const reAck = await req('POST', `/management/reports/${REPORTS.flow}/ack`, {}, owner);
  checkTrue('A26 re-ack after reset stamps fresh', typeof data(reAck).report?.ackAt === 'string' && data(reAck).report.ackAt !== stamp1, JSON.stringify(data(reAck)));

  const unitDel = await req('POST', `/management/reports/${REPORTS.unit1}/delete`, {}, owner);
  check('A27 unit delete → 200', unitDel.status, 200);
  check('A28 unit delete removedRows = 2 (same eventKey)', data(unitDel).removedRows, 2);
  const feedAfterUnit = data(await req('GET', '/management/reports?limit=100', undefined, owner)).reports || [];
  checkTrue('A29 both unit rows gone from the feed', !feedAfterUnit.some((r) => r.id === REPORTS.unit1 || r.id === REPORTS.unit2));
  const flowDel = await req('POST', `/management/reports/${REPORTS.flow}/delete`, {}, owner);
  check('A30 owner delete → 200', flowDel.status, 200);
  const feedAfterDel = data(await req('GET', '/management/reports?limit=100', undefined, owner)).reports || [];
  checkTrue('A31 deleted report gone from subsequent reads', !feedAfterDel.some((r) => r.id === REPORTS.flow));
  check('A32 second delete → 404', (await req('POST', `/management/reports/${REPORTS.flow}/delete`, {}, owner)).status, 404);
  check('A33 reset of unknown report → 404', (await req('POST', '/management/reports/nope/reset', {}, owner)).status, 404);

  /* ── B. Pepper reports ─────────────────────────────────── */
  const created = await req('POST', '/pepper-console/reports', { title: 'Drill pepper report', body: 'Filed by the options drill.', category: 'STATUS' }, dispatcher);
  check('B1 staff files a pepper report → 201', created.status, 201);
  const pepperId = data(created).id;
  checkTrue('B2 pepper report has an id', typeof pepperId === 'string' && pepperId.length > 0);
  check('B3 anonymous pepper delete → 401', (await req('POST', `/pepper-console/reports/${pepperId}/delete`, {})).status, 401);
  check('B4 manager-tier pepper delete → 403', (await req('POST', `/pepper-console/reports/${pepperId}/delete`, {}, admin)).status, 403);
  check('B5 owner pepper delete → 200', (await req('POST', `/pepper-console/reports/${pepperId}/delete`, {}, owner)).status, 200);
  const pepperList = data(await req('GET', '/pepper-console/reports', undefined, owner)) || [];
  checkTrue('B6 deleted pepper report gone from the log', !(Array.isArray(pepperList) ? pepperList : []).some((r) => r.id === pepperId));
  check('B7 second pepper delete → 404', (await req('POST', `/pepper-console/reports/${pepperId}/delete`, {}, owner)).status, 404);

  /* ── C. Tracking numbers ───────────────────────────────── */
  const tnCreate = await req('POST', '/admin/tracking-numbers', { kind: 'PHONE', value: '9545550199', label: 'Drill number', surfaceKey: 'flagship-web', status: 'PLANNED' }, admin);
  check('C1 manager registers a tracking number → 200/201', [200, 201].includes(tnCreate.status) ? tnCreate.status : 0, tnCreate.status);
  const tnId = data(tnCreate).id;
  checkTrue('C2 tracking row has an id', typeof tnId === 'string' && tnId.length > 0, JSON.stringify(tnCreate.json).slice(0, 200));
  check('C3 anonymous tracking delete → 401', (await req('POST', `/admin/tracking-numbers/${tnId}/delete`, {})).status, 401);
  check('C4 manager-tier tracking delete → 403 (owner gate)', (await req('POST', `/admin/tracking-numbers/${tnId}/delete`, {}, admin)).status, 403);
  check('C5 owner tracking delete → 200', (await req('POST', `/admin/tracking-numbers/${tnId}/delete`, {}, owner)).status, 200);
  const registry = data(await req('GET', '/admin/tracking-numbers', undefined, owner));
  const regRows = registry.numbers || registry.rows || registry.registry || [];
  checkTrue('C6 deleted row gone from the registry', !regRows.some((r) => r.id === tnId), JSON.stringify(registry).slice(0, 200));
  check('C7 second tracking delete → 404', (await req('POST', `/admin/tracking-numbers/${tnId}/delete`, {}, owner)).status, 404);

  /* ── D. Commercial ─────────────────────────────────────── */
  check('D1 anonymous agreement delete → 401', (await req('POST', `/commercial/agreements/${IDS.agrClean}/delete`, {})).status, 401);
  check('D2 staff-tier agreement delete → 403 (owner gate)', (await req('POST', `/commercial/agreements/${IDS.agrClean}/delete`, {}, dispatcher)).status, 403);
  check('D3 agreement with generated work orders → 409', (await req('POST', `/commercial/agreements/${IDS.agrBusy}/delete`, {}, owner)).status, 409);
  check('D4 clean agreement delete → 200', (await req('POST', `/commercial/agreements/${IDS.agrClean}/delete`, {}, owner)).status, 200);
  const agrList = data(await req('GET', '/commercial/agreements', undefined, owner));
  const agrRows = agrList.agreements || agrList || [];
  checkTrue('D5 deleted agreement gone from the list', !(Array.isArray(agrRows) ? agrRows : []).some((a) => a.id === IDS.agrClean));
  checkTrue('D6 blocked agreement still on file', (Array.isArray(agrRows) ? agrRows : []).some((a) => a.id === IDS.agrBusy));
  check('D7 customer-approved quote delete → 409', (await req('POST', `/commercial/quotes/${IDS.quoteApproved}/delete`, {}, owner)).status, 409);
  check('D8 draft quote delete → 200', (await req('POST', `/commercial/quotes/${IDS.quoteDraft}/delete`, {}, owner)).status, 200);
  check('D9 second quote delete → 404', (await req('POST', `/commercial/quotes/${IDS.quoteDraft}/delete`, {}, owner)).status, 404);

  /* ── E. Master protection on account removal ───────────── */
  check('E1 anonymous account removal → 401', (await req('POST', `/access-control/accounts/${IDS.customer}/remove`, {})).status, 401);
  const selfRemove = await req('POST', `/access-control/accounts/${IDS.owner}/remove`, {}, owner);
  checkTrue('E2 the Master cannot be removed (self-removal refused)', selfRemove.status >= 400, `status ${selfRemove.status}: ${selfRemove.text.slice(0, 160)}`);
  const ownerStillThere = await req('POST', '/auth/login', { email: EMAILS.owner, password: PW });
  check('E3 Master still signs in after the attempt → 200', ownerStillThere.status, 200);
  const custRemove = await req('POST', `/access-control/accounts/${IDS.customer}/remove`, {}, owner);
  check('E4 plain record-free customer account removes → 200', custRemove.status, 200);
  check('E5 removed customer can no longer sign in → 401', (await req('POST', '/auth/login', { email: EMAILS.customer, password: PW })).status, 401);

  /* ── F. Dispatch station ───────────────────────────────── */
  const assign1 = await req('POST', '/tracking/console/TS-OPT2/assign', { providerId: IDS.provider }, dispatcher);
  check('F1 setter assign → 201', assign1.status, 201);
  const asg1 = data(assign1).assignmentId;
  const assign2 = await req('POST', '/tracking/console/TS-OPT2/assign', { providerId: IDS.provider }, dispatcher);
  check('F2 repeat assign (same provider) → 201', assign2.status, 201);
  check('F3 repeat assign reuses the SAME assignment', data(assign2).assignmentId, asg1);
  const feedF = data(await req('GET', '/management/reports?limit=100', undefined, owner)).reports || [];
  const dispatchReports = feedF.filter((r) => r.type === 'DISPATCH_APPROVED' && r.detail?.bookingId === IDS.bookingJob);
  check('F4 two identical assigns mint exactly ONE DISPATCH_APPROVED report', dispatchReports.length, 1);
  const jobDetail = await req('GET', '/tracking/console/TS-OPT2/detail', undefined, dispatcher);
  check('F5 job detail → 200', jobDetail.status, 200);
  check('F6 job detail booking reference', data(jobDetail).booking?.referenceCode, 'TS-OPT2');
  check('F7 job tracking: utmSource as recorded', data(jobDetail).booking?.tracking?.utmSource, 'facebook');
  check('F8 job tracking: fbclid as recorded', data(jobDetail).booking?.tracking?.fbclid, 'drill-fbclid-9');
  check('F9 job tracking: unrecorded gclid is null', data(jobDetail).booking?.tracking?.gclid, null);
  check('F10 anonymous job detail → 401', (await req('GET', '/tracking/console/TS-OPT2/detail')).status, 401);
  const resetDispatch = await req('POST', '/tracking/console/TS-OPT2/reset-dispatch', {}, dispatcher);
  check('F11 reset-dispatch → 201', resetDispatch.status, 201);
  check('F12 job returns to PENDING_DISPATCH', data(resetDispatch).status, 'PENDING_DISPATCH');
  check('F13 job has no active assignment after reset', data(resetDispatch).assignmentId, null);
  const assign3 = await req('POST', '/tracking/console/TS-OPT2/assign', { providerId: IDS.provider }, dispatcher);
  check('F14 fresh assign after reset → 201', assign3.status, 201);
  checkTrue('F15 fresh assign mints a new assignment', typeof data(assign3).assignmentId === 'string' && data(assign3).assignmentId !== asg1);
  const feedF2 = data(await req('GET', '/management/reports?limit=100', undefined, owner)).reports || [];
  check('F16 the fresh approval is a new event: 2 reports total', feedF2.filter((r) => r.type === 'DISPATCH_APPROVED' && r.detail?.bookingId === IDS.bookingJob).length, 2);
  checkTrue('F17 a DISPATCH_RESET report was emitted', feedF2.some((r) => r.type === 'DISPATCH_RESET' && r.detail?.bookingId === IDS.bookingJob));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) { console.log(childLog.slice(-600)); process.exitCode = 1; }
} finally {
  child.kill('SIGKILL');
}
