/**
 * Management report acknowledgment drills (2026-11-23, Ramone's bug
 * report with photos): acknowledging an ad-campaign submission in the
 * management feed did not stick — "when I acknowledged each campaign
 * they all go back to acknowledge again. That's not helping me with
 * recording keeping. Each campaign must start acknowledged date and
 * time."
 *
 * Root cause (production): serverless instances hydrate the in-memory
 * working set ONCE at cold start and never refresh it. The ack wrote
 * through to the durable DepartmentReport table on the instance that
 * served it, but every other warm instance kept serving its pre-ack
 * snapshot — the next feed load (a different instance) showed the
 * campaign NEW again with a live Acknowledge button, and two surfaces
 * open at once disagreed (ACKED with its stamp vs NEW).
 *
 * The fix (services/managementReports.js + routes/management.js):
 * the management read paths and ackReport re-sync the working set
 * from the durable table before reading/stamping, so an ack recorded
 * anywhere is visible everywhere; a stale instance can never re-stamp
 * over the first acknowledgment (its date/time is the record); and an
 * ack covers the submission as the unit — still-NEW rows carrying the
 * same eventKey are stamped with the same ack date/time.
 *
 * These drills run in SKELETON MODE (no DATABASE_URL — this VM has no
 * postgres user, so no local cluster; the refresh is a no-op without
 * a database and the cross-instance convergence rests on the refresh
 * being the same cold-start hydration, proven here for semantics):
 *
 *  1. Gates unchanged: anonymous → 401; DISPATCHER → 403.
 *  2. Seeded campaign-submission reports start NEW with no ack stamp.
 *  3. Ack campaign 1 → 200, ACKED, ackAt + ackById stamped.
 *  4. A FRESH feed read shows campaign 1 ACKED with that exact stamp;
 *     its same-eventKey sibling row is ACKED with the SAME stamp;
 *     campaign 2 and the control report are still NEW.
 *  5. Re-acking campaign 1 → alreadyAcked, original stamp preserved.
 *  6. Ack campaign 2 → its OWN ack date/time.
 *  7. Summary counts only the control report as NEW; the status=NEW
 *     feed holds only the control report. Unknown id ack → 404.
 *
 * Usage: node test/management-reports-ack.test.mjs
 * (Skeleton mode: DATABASE_URL must NOT be set. TEST_PORT defaults
 * to 4611.) Exit code 0 = every check passed.
 */
import { spawn } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../src/services/passwords.js';

if (process.env.DATABASE_URL) {
  console.error('DATABASE_URL is set — this harness runs in skeleton mode only. Unset it and re-run.');
  process.exit(2);
}

const PORT = Number(process.env.TEST_PORT || 4611);
const B = `http://127.0.0.1:${PORT}/api/v1`;
// Assembled from fragments on purpose (AGENTS.md credential-
// expression rule for tool writes). Test-only values.
const PW = ['drill', 'pass', '1234'].join('-');
const JWT = ['ack', 'drill', 'jwt', 'secret'].join('-');
const PLATFORM_COMPANY_ID = '10000000-0000-4000-8000-000000000001';

const IDS = {
  owner: '30000000-0000-4000-8000-0000000000a1',
  dispatcher: '30000000-0000-4000-8000-0000000000a2',
};
const EMAILS = { owner: 'owner@ackdrill.test', dispatcher: 'setter@ackdrill.test' };
const CAMPAIGNS = {
  c1: '60939e19-2bcc-42d8-a486-a36813db4892',
  c2: '70939e19-2bcc-42d8-a486-a36813db4893',
};
const SUBMITTED_AT = '2026-11-23T04:47:00.000Z';
const REPORTS = {
  r1: '40000000-0000-4000-8000-0000000000b1',
  r1dup: '40000000-0000-4000-8000-0000000000b2',
  r2: '40000000-0000-4000-8000-0000000000b3',
  control: '40000000-0000-4000-8000-0000000000b4',
};

const [ownerHash, dispatcherHash] = await Promise.all([hashPassword(PW), hashPassword(PW)]);
const seedUser = (id, email, hash, roles) => ({
  id, companyId: PLATFORM_COMPANY_ID, email, passwordHash: hash,
  firstName: 'Drill', lastName: 'User', phone: null, roles,
  active: true, emailVerifiedAt: new Date().toISOString(),
  verifyRequired: false, layer2Required: false, layer2Phone: null, layer2Channel: null,
  createdAt: new Date().toISOString(),
});
const campaignReport = (id, campaignId, tag, name, format) => ({
  id, department: 'marketing', type: 'AD_CAMPAIGN_SUBMITTED',
  title: `Ad campaign submitted for approval — ${name}`,
  detail: { campaignId, name, businessLine: 'TOP_SPEED', sourceTag: tag, destinationUrl: 'https://topspeedserviceos.com/book', placement: 'STREAMING', format, actor: EMAILS.owner },
  source: 'ad-studio-streaming-pack', reference: tag,
  eventKey: `ad-campaign:${campaignId}:PENDING_APPROVAL:${SUBMITTED_AT}`,
  status: 'NEW', ackById: null, ackAt: null, createdAt: SUBMITTED_AT,
});
const seedReports = [
  campaignReport(REPORTS.r1, CAMPAIGNS.c1, 'flywheel-streaming-10', 'Streaming — Tri-County Coverage, 104 Cities (Display)', 'DISPLAY'),
  // The same submission emitted twice into a working set: same
  // eventKey, different row id — the phantom a stale instance serves.
  campaignReport(REPORTS.r1dup, CAMPAIGNS.c1, 'flywheel-streaming-10', 'Streaming — Tri-County Coverage, 104 Cities (Display)', 'DISPLAY'),
  campaignReport(REPORTS.r2, CAMPAIGNS.c2, 'flywheel-streaming-09', 'Streaming — Referral Program (Text)', 'TEXT'),
  { id: REPORTS.control, department: 'booking', type: 'BOOKING', title: 'New booking — control report', detail: { reference: 'TS-CTRL1' }, source: 'drill', reference: 'TS-CTRL1', eventKey: 'drill:control:1', status: 'NEW', ackById: null, ackAt: null, createdAt: SUBMITTED_AT },
];

const preloadPath = fileURLToPath(new URL('./.ackdrill-preload.mjs', import.meta.url));
writeFileSync(preloadPath, `
import { store } from '../src/data/store.js';
store.users.set(${JSON.stringify(IDS.owner)}, ${JSON.stringify(seedUser(IDS.owner, EMAILS.owner, ownerHash, ['COMPANY_OWNER']))});
store.users.set(${JSON.stringify(IDS.dispatcher)}, ${JSON.stringify(seedUser(IDS.dispatcher, EMAILS.dispatcher, dispatcherHash, ['DISPATCHER']))});
for (const r of ${JSON.stringify(seedReports)}) store.departmentReports.push(r);
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
const byId = (reports, id) => reports.find((r) => r.id === id) || {};

try {
  checkTrue('BOOT: API boots and /health answers', await waitForHealth(), childLog.slice(-400));

  /* 1. Gates unchanged. */
  check('anonymous feed read → 401', (await req('GET', '/management/reports')).status, 401);
  const dLogin = await req('POST', '/auth/login', { email: EMAILS.dispatcher, password: PW });
  check('dispatcher sign-in → 200', dLogin.status, 200);
  check('dispatcher feed read → 403 (manager gate unchanged)', (await req('GET', '/management/reports', undefined, data(dLogin).token)).status, 403);
  check('dispatcher ack attempt → 403', (await req('POST', `/management/reports/${REPORTS.r1}/ack`, {}, data(dLogin).token)).status, 403);

  const oLogin = await req('POST', '/auth/login', { email: EMAILS.owner, password: PW });
  check('owner sign-in → 200', oLogin.status, 200);
  const owner = data(oLogin).token;

  /* 2. Seeded submissions start NEW with no stamp. */
  const feed0 = await req('GET', '/management/reports?limit=100', undefined, owner);
  check('owner feed read → 200', feed0.status, 200);
  const rows0 = data(feed0).reports || [];
  check('campaign 1 starts NEW', byId(rows0, REPORTS.r1).status, 'NEW');
  check('campaign 1 starts with no ack stamp', byId(rows0, REPORTS.r1).ackAt, null);
  check('campaign 2 starts NEW', byId(rows0, REPORTS.r2).status, 'NEW');

  /* 3. Ack campaign 1. */
  const ack1 = await req('POST', `/management/reports/${REPORTS.r1}/ack`, {}, owner);
  check('ack campaign 1 → 200', ack1.status, 200);
  check('ack campaign 1 → alreadyAcked false', data(ack1).alreadyAcked, false);
  check('ack campaign 1 → status ACKED', data(ack1).report?.status, 'ACKED');
  check('ack campaign 1 → ackById is the owner', data(ack1).report?.ackById, IDS.owner);
  const stamp1 = data(ack1).report?.ackAt;
  checkTrue('ack campaign 1 → ackAt stamped', typeof stamp1 === 'string' && stamp1.length > 0, JSON.stringify(data(ack1)));

  /* 4. Fresh read: stamp persists, sibling covered, others untouched. */
  const feed1 = await req('GET', '/management/reports?limit=100', undefined, owner);
  const rows1 = data(feed1).reports || [];
  check('fresh read: campaign 1 ACKED', byId(rows1, REPORTS.r1).status, 'ACKED');
  check('fresh read: campaign 1 keeps the exact stamp', byId(rows1, REPORTS.r1).ackAt, stamp1);
  check('fresh read: same-submission sibling ACKED too', byId(rows1, REPORTS.r1dup).status, 'ACKED');
  check('fresh read: sibling carries the SAME stamp', byId(rows1, REPORTS.r1dup).ackAt, stamp1);
  check('fresh read: campaign 2 still NEW', byId(rows1, REPORTS.r2).status, 'NEW');
  check('fresh read: control report still NEW', byId(rows1, REPORTS.control).status, 'NEW');

  /* 5. Re-ack preserves the original stamp. */
  const ack1b = await req('POST', `/management/reports/${REPORTS.r1}/ack`, {}, owner);
  check('re-ack campaign 1 → alreadyAcked true', data(ack1b).alreadyAcked, true);
  check('re-ack campaign 1 → original stamp preserved', data(ack1b).report?.ackAt, stamp1);

  /* 6. Campaign 2 gets its own stamp. */
  const ack2 = await req('POST', `/management/reports/${REPORTS.r2}/ack`, {}, owner);
  check('ack campaign 2 → status ACKED', data(ack2).report?.status, 'ACKED');
  const stamp2 = data(ack2).report?.ackAt;
  checkTrue('ack campaign 2 → its own stamp (>= campaign 1 stamp)', typeof stamp2 === 'string' && stamp2 >= stamp1, `stamp2=${stamp2} stamp1=${stamp1}`);

  /* 7. Summary + NEW-only feed + unknown id. */
  const summary = await req('GET', '/management/reports/summary', undefined, owner);
  check('summary totalNew counts only the control report', data(summary).totalNew, 1);
  const feedNew = await req('GET', '/management/reports?status=NEW&limit=100', undefined, owner);
  const newRows = data(feedNew).reports || [];
  check('status=NEW feed holds exactly one report', newRows.length, 1);
  check('status=NEW feed holds the control report', newRows[0]?.id, REPORTS.control);
  check('ack unknown id → 404', (await req('POST', '/management/reports/40000000-0000-4000-8000-000000000099/ack', {}, owner)).status, 404);
} finally {
  child.kill('SIGTERM');
  try { rmSync(preloadPath); } catch { /* ignore */ }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
