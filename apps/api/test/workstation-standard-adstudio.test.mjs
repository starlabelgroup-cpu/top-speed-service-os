/**
 * Workstation Standard — AD STUDIO station verification harness
 * (2026-11-19).
 *
 * The Ad Studio console (apps/web/ad-studio) received the same
 * additive treatment as Book OS (1f4e5f1), CRM (e7aea1b), Tech web
 * (74911a2), Dispatch (c9bfba9) and ApplianceMan/Oversight
 * (f8e03a4): an Options panel (this-device preferences — campaigns
 * list sort + status filter + auto-refresh), click-to-open
 * campaign detail, and a CTA bar inside the detail that surfaces
 * the campaign's OWN existing action buttons. Ramone's standing
 * rule for the rollout: "Don't change — just integrate." The page
 * code is ADDITIVE and changes no API; this suite proves the
 * contracts the integration leans on:
 *
 *   - The console's real staff gate: /ad-studio/* reads are
 *     MARKETING_MANAGER / COMPANY_ADMIN / COMPANY_OWNER /
 *     PLATFORM_ADMIN only (anon 401; CUSTOMER 403; DISPATCHER 403 —
 *     the restricted-screen path the page's boot handles).
 *   - GET /ad-studio/campaigns returns the exact record shape the
 *     detail renders (publicCampaign: status, businessLine,
 *     objective, destinationUrl, trackedUrl, sourceTag, placement,
 *     creative, advertiser + streaming fields as stored, banner,
 *     notes, approvedById/approvedAt, createdAt/updatedAt), in the
 *     platform's own order (most recently updated first — the
 *     page's "As loaded" default), plus counts { total, byStatus,
 *     pendingApproval }.
 *   - GET /ad-studio/campaigns/:id (the detail's enrichment read)
 *     returns the same record plus its attributed results.
 *   - GET /ad-studio/results carries the per-campaign bookings /
 *     connections the detail shows (honest zeros here).
 *   - The CTA endpoints behave exactly as the list buttons drive
 *     them, with the AD RULES intact: submit (staff) lands
 *     PENDING_APPROVAL; approve is OWNER-only (staff 403) and sets
 *     approvedAt/approvedById + activates the banner; pause is
 *     staff and deactivates the banner; resume is OWNER-only;
 *     end is staff; an illegal move (submit an ENDED campaign)
 *     is a 422. Nothing in the flow auto-publishes: a created
 *     campaign is a DRAFT until a human submits and the owner
 *     approves.
 *   - POST /ad-studio/draft-copy with Speedy unconfigured answers
 *     the honest 503 and creates NOTHING (no draft appears).
 *   - GET /ad-studio/streaming-pack (read-only status) answers for
 *     staff. The pack LOADER is never invoked by this suite — it
 *     stays owner-clicked, exactly as built.
 *   - GET /auth/me carries the roles array the page's isOwner
 *     read depends on.
 *
 * Runs against a LOCAL test database only. Usage:
 *   DATABASE_URL=<local test db> node test/workstation-standard-adstudio.test.mjs
 * Exit code 0 = every check passed.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/services/passwords.js';
import { signAccessToken } from '../src/services/tokens.js';
import { PLATFORM_COMPANY_ID } from '../src/data/store.js';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required (point it at a local TEST database).');
  process.exit(2);
}
process.env.DATABASE_URL_UNPOOLED ||= process.env.DATABASE_URL;
process.env.JWT_SECRET ||= 'workstation-adstudio-secret';

const PORT = Number(process.env.TEST_PORT || 4479);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const PASSWORD = 'test-pass-1234';

const IDS = {
  owner: '90000000-0000-4000-8000-0000000000b1',
  staff: '90000000-0000-4000-8000-0000000000b2',
  setter: '90000000-0000-4000-8000-0000000000b3',
  customer: '90000000-0000-4000-8000-0000000000b4',
};
const EMAILS = {
  owner: 'as-owner@test.local',
  staff: 'as-staff@test.local',
  setter: 'as-setter@test.local',
  customer: 'as-customer@test.local',
};

const prisma = new PrismaClient();
let server;
let passed = 0;
let failed = 0;

function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  if (ok) passed += 1; else failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}
function checkTrue(label, value) { check(label, Boolean(value), true); }

async function api(path, { token, method = 'GET', body } = {}) {
  const res = await fetch(BASE + path, {
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
  return { status: res.status, json };
}

async function login(email) {
  const res = await api('/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  return res.json?.token || null;
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

async function seed() {
  const passwordHash = await hashPassword(PASSWORD);
  await prisma.company.upsert({
    where: { id: PLATFORM_COMPANY_ID }, update: {},
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'as-platform', type: 'PLATFORM_OWNER', isPlatformOwner: true },
  });
  const users = [
    [IDS.owner, EMAILS.owner, ['COMPANY_OWNER']],
    [IDS.staff, EMAILS.staff, ['COMPANY_ADMIN']],
    [IDS.setter, EMAILS.setter, ['DISPATCHER']],
    [IDS.customer, EMAILS.customer, ['CUSTOMER']],
  ];
  for (const [id, email, roles] of users) {
    await prisma.user.upsert({
      where: { id },
      update: { passwordHash },
      create: { id, companyId: PLATFORM_COMPANY_ID, email, passwordHash, phone: '9545550110', roles, active: true },
    });
  }
}

async function cleanup() {
  try {
    const ids = Object.values(IDS);
    await prisma.loginChallenge.deleteMany({ where: { userId: { in: ids } } });
    await prisma.emailVerificationToken.deleteMany({ where: { userId: { in: ids } } });
    await prisma.termsAcceptance.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await prisma.user.deleteMany({ where: { email: { endsWith: '@test.local' } } });
  } catch (error) {
    console.error('cleanup warning:', error.message);
  }
}

function startServer() {
  const apiDir = fileURLToPath(new URL('..', import.meta.url));
  server = spawn('node', ['src/server.js'], {
    cwd: apiDir,
    // Speedy deliberately unconfigured: draft-copy must answer
    // its honest 503 and create nothing.
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'test', OPENAI_API_KEY: '', OPENAI_API_KEY_V2: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  return waitForServer();
}

async function stopServer() {
  if (!server) return;
  const done = new Promise((r) => server.once('exit', r));
  server.kill('SIGTERM');
  await done;
  server = null;
}

async function mint(key) {
  const user = await prisma.user.findUnique({ where: { id: IDS[key] } });
  return signAccessToken(user).token;
}

async function main() {
  await seed();
  await startServer();

  const owner = await login(EMAILS.owner);
  checkTrue('owner real login issues a session (master)', Boolean(owner));
  const staff = await mint('staff');
  const setter = await mint('setter');
  const customer = await mint('customer');
  checkTrue('minted staff/setter/customer sessions', Boolean(staff && setter && customer));

  /* ---------- /auth/me: the roles array the isOwner read uses ---------- */
  const meOwner = await api('/auth/me', { token: owner });
  check('GET /auth/me as owner -> 200', meOwner.status, 200);
  checkTrue('owner roles carry COMPANY_OWNER (isOwner)', (meOwner.json?.user?.roles || []).includes('COMPANY_OWNER'));
  const meStaff = await api('/auth/me', { token: staff });
  checkTrue('staff roles do NOT carry COMPANY_OWNER', !(meStaff.json?.user?.roles || []).includes('COMPANY_OWNER'));

  /* ---------- The console's real staff gate ---------- */
  check('anon 401 GET /ad-studio/campaigns', (await api('/ad-studio/campaigns')).status, 401);
  check('customer 403 GET /ad-studio/campaigns', (await api('/ad-studio/campaigns', { token: customer })).status, 403);
  check('dispatcher 403 GET /ad-studio/campaigns (console gate is marketing/admin/owner)', (await api('/ad-studio/campaigns', { token: setter })).status, 403);
  check('staff 200 GET /ad-studio/campaigns', (await api('/ad-studio/campaigns', { token: staff })).status, 200);
  check('customer 403 GET /ad-studio/results', (await api('/ad-studio/results', { token: customer })).status, 403);
  check('anon 401 POST /ad-studio/campaigns', (await api('/ad-studio/campaigns', { method: 'POST', body: {} })).status, 401);

  /* ---------- Create: a draft is a draft (nothing auto-publishes) ---------- */
  const createdA = await api('/ad-studio/campaigns', {
    token: staff, method: 'POST',
    body: {
      name: 'WS AdStudio Banner Drill', businessLine: 'TOP_SPEED',
      objective: 'Bookings for refrigerator repair from the published city pages',
      destinationUrl: 'https://topspeedserviceos.com/book', placement: 'BANNER',
      notes: 'Drill campaign for the workstation suite.',
    },
  });
  check('staff create banner campaign -> 201', createdA.status, 201);
  const a = createdA.json?.data || {};
  check('created campaign is a DRAFT (never auto-live)', a.status, 'DRAFT');
  checkTrue('server generated the sourceTag', /^adstudio-/.test(a.sourceTag || ''));
  checkTrue('trackedUrl carries the sourceTag', String(a.trackedUrl || '').includes(a.sourceTag || '###'));
  check('placement stored as BANNER', a.placement, 'BANNER');
  check('no banner before approval', a.banner, null);
  check('approvedAt starts null', a.approvedAt, null);
  checkTrue('record carries createdAt + updatedAt (detail renders both)', Boolean(a.createdAt && a.updatedAt));
  checkTrue('record carries the detail fields: objective/destination/notes',
    a.objective?.includes('refrigerator') && a.destinationUrl === 'https://topspeedserviceos.com/book' && a.notes === 'Drill campaign for the workstation suite.');

  const createdB = await api('/ad-studio/campaigns', {
    token: staff, method: 'POST',
    body: {
      name: 'WS AdStudio Streaming Drill', businessLine: 'TOP_SPEED',
      objective: 'Streaming reach for dryer repair',
      destinationUrl: 'https://topspeedserviceos.com/book', placement: 'STREAMING',
      streamingFormat: 'TEXT', streamingProviders: ['ROKU'],
      headlines: ['Dryer Repair Near You'], descriptions: ['Same-day service windows across the tri-county area.'],
      displayPath: 'Dryer-Repair',
    },
  });
  check('staff create streaming campaign -> 201', createdB.status, 201);
  const b = createdB.json?.data || {};
  check('streaming format stored', b.streamingFormat, 'TEXT');
  check('streaming headlines round-trip as stored', (b.headlines || [])[0], 'Dryer Repair Near You');
  check('streaming providers round-trip as stored', (b.streamingProviders || [])[0], 'ROKU');
  check('streaming displayPath round-trip', b.displayPath, 'Dryer-Repair');

  check('invalid create (no name) -> 400', (await api('/ad-studio/campaigns', {
    token: staff, method: 'POST',
    body: { businessLine: 'TOP_SPEED', objective: 'x'.repeat(10), destinationUrl: 'https://topspeedserviceos.com/book' },
  })).status, 400);

  /* ---------- List: platform order + counts ---------- */
  const list1 = await api('/ad-studio/campaigns', { token: staff });
  check('list -> 200', list1.status, 200);
  const items1 = list1.json?.data || [];
  checkTrue('list carries both drill campaigns', items1.some((c) => c.id === a.id) && items1.some((c) => c.id === b.id));
  check('list order is most-recently-updated first (the "As loaded" default)', items1[0]?.id, b.id);
  check('counts.total counts the campaigns', list1.json?.counts?.total, items1.length);
  check('counts.byStatus.DRAFT counts both drafts', list1.json?.counts?.byStatus?.DRAFT, 2);
  check('counts.pendingApproval starts at 0', list1.json?.counts?.pendingApproval, 0);

  /* ---------- The detail's enrichment read ---------- */
  check('anon 401 GET /ad-studio/campaigns/:id', (await api(`/ad-studio/campaigns/${a.id}`)).status, 401);
  check('customer 403 GET /ad-studio/campaigns/:id', (await api(`/ad-studio/campaigns/${a.id}`, { token: customer })).status, 403);
  const read1 = await api(`/ad-studio/campaigns/${a.id}`, { token: staff });
  check('staff 200 GET /ad-studio/campaigns/:id', read1.status, 200);
  check('single read returns the same record', read1.json?.data?.id, a.id);
  checkTrue('single read carries attributed results (bookings/connections)',
    typeof read1.json?.data?.results?.bookings === 'number' && typeof read1.json?.data?.results?.connections === 'number');
  check('results are honest zeros for a fresh campaign', read1.json?.data?.results?.bookings, 0);
  check('unknown campaign id -> 404', (await api('/ad-studio/campaigns/00000000-0000-4000-8000-0000000000ff', { token: staff })).status, 404);

  const results = await api('/ad-studio/results', { token: staff });
  check('staff 200 GET /ad-studio/results', results.status, 200);
  const rowA = (results.json?.data || []).find((r) => r.campaignId === a.id);
  checkTrue('results carry a row for the campaign', Boolean(rowA));
  check('results row bookings = 0 (honest zero)', rowA?.bookings, 0);
  check('results row connections = 0 (honest zero)', rowA?.connections, 0);

  /* ---------- The CTA lifecycle, with the owner gate intact ---------- */
  const submitted = await api(`/ad-studio/campaigns/${a.id}/submit`, { token: staff, method: 'POST', body: {} });
  check('staff submit -> 200', submitted.status, 200);
  check('submitted campaign is PENDING_APPROVAL', submitted.json?.data?.status, 'PENDING_APPROVAL');
  const list2 = await api('/ad-studio/campaigns', { token: staff });
  check('counts.pendingApproval is now 1', list2.json?.counts?.pendingApproval, 1);

  check('staff approve -> 403 (approve is OWNER-only)', (await api(`/ad-studio/campaigns/${a.id}/approve`, { token: staff, method: 'POST', body: {} })).status, 403);
  check('customer approve -> 403', (await api(`/ad-studio/campaigns/${a.id}/approve`, { token: customer, method: 'POST', body: {} })).status, 403);
  const stillPending = await api(`/ad-studio/campaigns/${a.id}`, { token: staff });
  check('campaign is STILL pending after the refused approvals', stillPending.json?.data?.status, 'PENDING_APPROVAL');

  const approved = await api(`/ad-studio/campaigns/${a.id}/approve`, { token: owner, method: 'POST', body: {} });
  check('owner approve -> 200', approved.status, 200);
  check('approved campaign is ACTIVE', approved.json?.data?.status, 'ACTIVE');
  checkTrue('approve stamps approvedAt', Boolean(approved.json?.data?.approvedAt));
  check('approve stamps approvedById with the owner', approved.json?.data?.approvedById, IDS.owner);
  checkTrue('approve activates the banner for a BANNER campaign', Boolean(approved.json?.data?.banner && approved.json.data.banner.active === true));

  const paused = await api(`/ad-studio/campaigns/${a.id}/pause`, { token: staff, method: 'POST', body: {} });
  check('staff pause -> 200', paused.status, 200);
  check('paused campaign is PAUSED', paused.json?.data?.status, 'PAUSED');
  check('pause deactivates the banner', paused.json?.data?.banner?.active, false);

  check('staff resume -> 403 (resume is OWNER-only)', (await api(`/ad-studio/campaigns/${a.id}/resume`, { token: staff, method: 'POST', body: {} })).status, 403);
  const resumed = await api(`/ad-studio/campaigns/${a.id}/resume`, { token: owner, method: 'POST', body: {} });
  check('owner resume -> 200 ACTIVE', resumed.json?.data?.status, 'ACTIVE');

  const ended = await api(`/ad-studio/campaigns/${a.id}/end`, { token: staff, method: 'POST', body: {} });
  check('staff end -> 200', ended.status, 200);
  check('ended campaign is ENDED', ended.json?.data?.status, 'ENDED');
  check('submit an ENDED campaign -> 422 (illegal transition)', (await api(`/ad-studio/campaigns/${a.id}/submit`, { token: staff, method: 'POST', body: {} })).status, 422);

  /* ---------- Draft with Speedy: honest unavailability, no draft ---------- */
  const before = await api('/ad-studio/campaigns', { token: staff });
  const draftTry = await api('/ad-studio/draft-copy', {
    token: staff, method: 'POST',
    body: { name: 'WS Speedy Draft Attempt', businessLine: 'TOP_SPEED', placement: 'BANNER', destinationUrl: 'https://topspeedserviceos.com/book' },
  });
  check('draft-copy with Speedy unconfigured -> 503 (honest unavailable)', draftTry.status, 503);
  const after = await api('/ad-studio/campaigns', { token: staff });
  check('draft-copy created NOTHING while unavailable', after.json?.counts?.total, before.json?.counts?.total);

  /* ---------- Streaming pack: the read-only status only ---------- */
  const pack = await api('/ad-studio/streaming-pack', { token: staff });
  check('staff 200 GET /ad-studio/streaming-pack (status read)', pack.status, 200);
  check('pack reports its total (10 ads)', pack.json?.data?.total, 10);
  check('customer 403 GET /ad-studio/streaming-pack', (await api('/ad-studio/streaming-pack', { token: customer })).status, 403);
}

main()
  .catch((error) => { console.error(error); failed += 1; })
  .finally(async () => {
    if (server) server.kill('SIGTERM');
    await cleanup();
    await prisma.$disconnect();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
  });
