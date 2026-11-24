/**
 * Access badges + customer lockout drills (2026-11-18).
 *
 * Ramone's Part 2 audit: every flagship staff console must lock
 * customers out (anonymous 401, CUSTOMER 403, permitted role 200),
 * carry the shared access badge (apps/web/shared/access-badge.js),
 * and show the shared restricted screen on 403. The badge table is
 * DERIVED from the real route gates — this suite encodes that audited
 * table and fails if the badge file, the system map, or the route
 * sources drift from it.
 *
 * Audited gates (routes/*.js, 2026-11-18):
 *  - STAFF_ROLES gate (DISPATCHER, COMPANY_ADMIN, COMPANY_OWNER,
 *    PLATFORM_ADMIN): navigator, pepperConsole, crm, bookos, chats,
 *    tracking/console, notifications, linkCenter (the primary data
 *    of Navigator, Pepper, CRM, Book OS, Dispatch Dashboard,
 *    Service Setters, Notifications, Link Center, Chats and Track
 *    Console).
 *  - MANAGER_ROLES gate (COMPANY_ADMIN, COMPANY_OWNER, PLATFORM_ADMIN
 *    — the Turbo Boss page gate; 2026-11-18, Ramone's order):
 *    finance/overview + management/reports (the primary data of
 *    ApplianceMan, Finance, Oversight and Manager). Dispatchers 403.
 *  - Marketing gate (MARKETING_MANAGER, AD_SPECIALIST, COMPANY_ADMIN,
 *    COMPANY_OWNER, PLATFORM_ADMIN — no DISPATCHER): adStudio, mediaOs
 *    admin, marketingOs admin, marketingSeo, marketingGoogleAccounts
 *    (Ad Studio, Media, Marketing OS Studio/SEO/Google Accounts).
 *    AD_SPECIALIST joined the set 2026-11-19 (Top Speed's own
 *    ad-specialist account class; its full gate matrix is drilled in
 *    test/ad-specialist.test.mjs).
 *  - Insights gate: STAFF_ROLES + MARKETING_MANAGER + AD_SPECIALIST (insights.js,
 *    scoped router.use('/insights', ...)).
 *  - Badge table completed 2026-11-23 (Ramone's approval): the four
 *    consoles whose badge include shipped in the Step 3 sweep joined
 *    the table from their own audited gates — Pro Booking: the page's
 *    own sign-in gate (the STAFF list in apps/web/pro-booking/
 *    index.html, enforced against /auth/me before the app renders);
 *    Parts: routes/parts.js staff = requireRole(...STAFF_ROLES) on
 *    every /parts/* route + the page's STAFF gate; CocoCane Express:
 *    routes/cococane.js staffOnly = requireRole(...STAFF_ROLES) on
 *    every console route + the page's STAFF gate; Marketing OS hub:
 *    routes/marketingOs.js marketingOnly (the marketing set) on the
 *    admin surface — the same entry as its Studio/SEO/Google
 *    Accounts sub-consoles (the hub's three public GETs are the
 *    published-content contract, not console data).
 *  - Master gate (COMPANY_OWNER only): accessControl (scoped
 *    router.use('/access-control', ...)) + speedyVerify accounts —
 *    Work Time Access.
 *  - Turbo Boss: PAGE gate managers only (MANAGERS = COMPANY_ADMIN,
 *    COMPANY_OWNER, PLATFORM_ADMIN in apps/web/turbo-boss/index.html)
 *    — MANAGER ONLY; its management-reports feed joined the same
 *    manager gate on 2026-11-18.
 *  - Academy: TRAINEE gate (STAFF_ROLES + PROVIDER_TECH +
 *    PROVIDER_OWNER + TECHNICIAN + MARKETING_MANAGER + AD_SPECIALIST) fits none of
 *    the three labels, so the Academy carries NO badge and keeps its
 *    own trainee gate screen. This suite proves the trainee gate
 *    (customer 403, provider 200) instead.
 *  - FIX in this build: GET /bookings listed the full company booking
 *    list (contact details included) to any signed-in account; it now
 *    follows canReadBooking — staff see the company list, everyone
 *    else only their own bookings. Probed below.
 *
 * Run: DATABASE_URL=<local drill Postgres> TEST_PORT=4511 node test/access-badges.test.mjs
 */
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/services/passwords.js';
import { PLATFORM_COMPANY_ID } from '../src/data/store.js';
import { SYSTEM_MAP_AREAS } from '../src/data/systemMap.js';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required (point it at a local TEST database).');
  process.exit(2);
}
if (!process.env.DATABASE_URL_UNPOOLED) process.env.DATABASE_URL_UNPOOLED = process.env.DATABASE_URL;

const PORT_A = Number(process.env.TEST_PORT || 4511);
const PORT_B = PORT_A + 1;
const JWT_SECRET = process.env.JWT_SECRET || 'access-badges-drill-secret';
const PASSWORD = 'test-pass-1234';

const IDS = {
  staff: '60000000-0000-4000-8000-0000000000e1',
  admin: '60000000-0000-4000-8000-0000000000e2',
  owner: '60000000-0000-4000-8000-0000000000e3',
  customer: '60000000-0000-4000-8000-0000000000e4',
  marketing: '60000000-0000-4000-8000-0000000000e5',
  provider: '60000000-0000-4000-8000-0000000000e6',
};
const EMAILS = {
  staff: 'badge-staff@test.local',
  admin: 'badge-admin@test.local',
  owner: 'badge-owner@test.local',
  customer: 'badge-customer@test.local',
  marketing: 'badge-marketing@test.local',
  provider: 'badge-provider@test.local',
};

const prisma = new PrismaClient();
let failures = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}
function checkTrue(label, value) { check(label, Boolean(value), true); }
function sameSet(a, b) {
  const x = [...a].sort(); const y = [...b].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}
function checkSet(label, actual, expected) { check(label, sameSet(actual, expected), true); }

function api(base, path, { token, method = 'GET', body } = {}) {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (res) => {
    let json = null;
    try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, json };
  });
}

function mintToken(userId, email, roles) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: userId, companyId: PLATFORM_COMPANY_ID, email, roles,
    exp: Math.floor(Date.now() / 1000) + 3600,
  })).toString('base64url');
  const signature = createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

async function login(base, email) {
  const { status, json } = await api(base, '/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  if (status !== 200 || !json?.token) throw new Error(`login failed for ${email}: ${status} ${JSON.stringify(json)}`);
  return json.token;
}

function spawnServer(port, extraEnv) {
  const env = { ...process.env, PORT: String(port), JWT_SECRET };
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const server = spawn('node', ['src/server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[api:${port}] ${d}`));
  return server;
}

async function waitForServer(base) {
  for (let i = 0; i < 90; i += 1) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('server did not come up');
}

async function seed() {
  const passwordHash = await hashPassword(PASSWORD);
  await prisma.company.upsert({
    where: { id: PLATFORM_COMPANY_ID },
    update: {},
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'test-platform', type: 'PLATFORM_OWNER', isPlatformOwner: true },
  });
  const users = [
    { id: IDS.staff, email: EMAILS.staff, roles: ['DISPATCHER'] },
    { id: IDS.admin, email: EMAILS.admin, roles: ['COMPANY_ADMIN'] },
    { id: IDS.owner, email: EMAILS.owner, roles: ['COMPANY_OWNER'] },
    { id: IDS.customer, email: EMAILS.customer, roles: ['CUSTOMER'] },
    { id: IDS.marketing, email: EMAILS.marketing, roles: ['MARKETING_MANAGER'] },
    { id: IDS.provider, email: EMAILS.provider, roles: ['PROVIDER_TECH'] },
  ];
  for (const u of users) {
    await prisma.user.upsert({
      where: { id: u.id },
      update: { passwordHash },
      create: { id: u.id, companyId: PLATFORM_COMPANY_ID, email: u.email, passwordHash, phone: '9545550200', roles: u.roles, active: true },
    });
  }
}

let drillBookingId = null;
async function cleanupDb() {
  try {
    if (drillBookingId) await prisma.serviceRequest.deleteMany({ where: { id: drillBookingId } });
    await prisma.customer.deleteMany({ where: { email: 'badge-drill-cust@test.local' } });
    await prisma.user.deleteMany({ where: { id: { in: Object.values(IDS) } } });
  } catch (error) {
    console.error('cleanup warning:', error.message);
  }
}

/* ── The audited badge table (mirrors the route gates above) ────── */
const STAFF = ['DISPATCHER', 'COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'];
const MANAGERS = ['COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'];
const MKTG = ['MARKETING_MANAGER', 'AD_SPECIALIST', 'COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'];
const EXPECTED_TABLE = {
  '/work-time-access': { label: 'OWNER ONLY', roles: ['COMPANY_OWNER'] },
  '/turbo-boss': { label: 'MANAGER ONLY', roles: ['COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'] },
  '/navigator': { label: 'STAFF ONLY', roles: STAFF },
  '/pepper': { label: 'STAFF ONLY', roles: STAFF },
  '/crm': { label: 'STAFF ONLY', roles: STAFF },
  '/book-os': { label: 'STAFF ONLY', roles: STAFF },
  '/pro-booking': { label: 'STAFF ONLY', roles: STAFF },
  '/applianceman': { label: 'MANAGER ONLY', roles: MANAGERS },
  '/oversight': { label: 'MANAGER ONLY', roles: MANAGERS },
  '/dispatch-dashboard': { label: 'STAFF ONLY', roles: STAFF },
  '/service-setters-dispatch': { label: 'STAFF ONLY', roles: STAFF },
  '/notifications': { label: 'STAFF ONLY', roles: STAFF },
  '/link-center': { label: 'STAFF ONLY', roles: STAFF },
  '/insights': { label: 'STAFF ONLY', roles: [...STAFF, 'MARKETING_MANAGER', 'AD_SPECIALIST'] },
  '/ad-studio': { label: 'STAFF ONLY', roles: MKTG },
  '/manager': { label: 'MANAGER ONLY', roles: MANAGERS },
  '/finance': { label: 'MANAGER ONLY', roles: MANAGERS },
  '/media': { label: 'STAFF ONLY', roles: MKTG },
  '/chats': { label: 'STAFF ONLY', roles: STAFF },
  '/track-console': { label: 'STAFF ONLY', roles: STAFF },
  '/parts': { label: 'STAFF ONLY', roles: STAFF },
  '/cococane-express': { label: 'STAFF ONLY', roles: STAFF },
  '/marketing-os': { label: 'STAFF ONLY', roles: MKTG },
  '/marketing-os/studio': { label: 'STAFF ONLY', roles: MKTG },
  '/marketing-os/seo': { label: 'STAFF ONLY', roles: MKTG },
  '/marketing-os/google-accounts': { label: 'STAFF ONLY', roles: MKTG },
  '/interconnect': { label: 'STAFF ONLY', roles: STAFF },
  '/os-updates': { label: 'MANAGER ONLY', roles: MANAGERS },
};
// Pages whose 403 path is NOT showRestricted, by design (see header):
// - service-setters-dispatch: public marketing illustration, no data
//   fetch at all — the badge is its only wiring.
// - media: hybrid public Media OS page; on 403 its protected admin
//   zone is removed entirely (no partial render, no protected data).
// - pro-booking, parts, cococane-express (2026-11-23): each page's own
//   sign-in gate IS its restricted path — boot/enter rejects a
//   non-staff account before the console renders and drops the token,
//   and no console data is fetched before that gate passes.
// - marketing-os hub (2026-11-23): no sign-in wall by design — public
//   hub reads plus staff panels that degrade panel-by-panel (its
//   revenue panel carries Finance-gated data, a different gate than
//   the hub's own); the restricted screen belongs to its gated
//   sub-consoles, which wire it.
const RESTRICTED_EXCEPTIONS = ['/service-setters-dispatch', '/media', '/pro-booking', '/parts', '/cococane-express', '/marketing-os'];
// Badged consoles with no system-map area to extend:
const NO_MAP_AREA = ['/notifications', '/track-console'];

function staticChecks() {
  const root = fileURLToPath(new URL('../../..', import.meta.url)); // repo root
  const read = (rel) => readFileSync(`${root}/${rel}`, 'utf8');

  // Badge table in the shared script deep-equals the audited table.
  const badgeSrc = read('apps/web/shared/access-badge.js');
  const tableMatch = badgeSrc.match(/var CONSOLE_ACCESS = (\{[\s\S]*?\n  \});/);
  checkTrue('badge file declares CONSOLE_ACCESS', Boolean(tableMatch));
  const table = new Function(`return (${tableMatch[1]});`)();
  check('badge table console count', Object.keys(table).length, Object.keys(EXPECTED_TABLE).length);
  for (const [prefix, want] of Object.entries(EXPECTED_TABLE)) {
    const got = table[prefix];
    checkTrue(`badge table has ${prefix}`, Boolean(got));
    if (!got) continue;
    check(`badge label ${prefix}`, got.label, want.label);
    checkSet(`badge roles ${prefix}`, got.roles, want.roles);
  }
  checkTrue('badge exports TSOSAccess.showRestricted', badgeSrc.includes('window.TSOSAccess') && badgeSrc.includes('showRestricted'));
  checkTrue('restricted screen heading', badgeSrc.includes('Restricted area'));
  checkTrue('restricted screen label sentence', badgeSrc.includes("your account doesn't have access."));
  checkTrue('restricted screen home button', badgeSrc.includes('Go to my home'));
  checkTrue('restricted screen portal button', badgeSrc.includes('Service OS Portal'));
  checkTrue('restricted screen lock icon', badgeSrc.includes('<svg') && badgeSrc.includes('rect x="5" y="10.5"'));

  // Every badged page loads the badge script; all but the documented
  // exceptions call showRestricted on their 403 path; Academy does not.
  for (const prefix of Object.keys(EXPECTED_TABLE)) {
    const html = read(`apps/web${prefix}/index.html`);
    checkTrue(`page includes access-badge.js: ${prefix}`, html.includes('/shared/access-badge.js'));
    if (!RESTRICTED_EXCEPTIONS.includes(prefix)) {
      checkTrue(`page wires showRestricted: ${prefix}`, html.includes('TSOSAccess.showRestricted'));
    }
  }
  const academyHtml = read('apps/web/academy/index.html');
  checkTrue('academy carries NO badge (trainee gate)', !academyHtml.includes('/shared/access-badge.js'));

  // System map mirrors the table for every shared console area.
  for (const area of SYSTEM_MAP_AREAS) {
    if (!area.accessLabel) continue;
    const want = EXPECTED_TABLE[area.url];
    checkTrue(`systemMap area ${area.id} url is a badged console`, Boolean(want));
    if (!want) continue;
    check(`systemMap label ${area.id}`, area.accessLabel, want.label);
    checkSet(`systemMap roles ${area.id}`, area.accessRoles, want.roles);
  }
  for (const prefix of Object.keys(EXPECTED_TABLE)) {
    if (NO_MAP_AREA.includes(prefix)) continue;
    checkTrue(`systemMap has an area for ${prefix}`, SYSTEM_MAP_AREAS.some((a) => a.url === prefix && a.accessLabel === EXPECTED_TABLE[prefix].label));
  }
  const academyArea = SYSTEM_MAP_AREAS.find((a) => a.id === 'academy');
  checkTrue('systemMap academy area has no badge fields', Boolean(academyArea) && !academyArea.accessLabel);

  // Route sources still carry the gates the table was derived from.
  const src = (rel) => read(`apps/api/src/${rel}`);
  checkTrue('navigator gate is STAFF_ROLES', src('routes/navigator.js').includes('requireRole(...STAFF_ROLES)'));
  checkTrue('pepperConsole gate is STAFF_ROLES', src('routes/pepperConsole.js').includes('requireRole(...STAFF_ROLES)'));
  checkTrue('crm gate is STAFF_ROLES', src('routes/crm.js').includes('requireRole(...STAFF_ROLES)'));
  checkTrue('bookos gate is STAFF_ROLES', src('routes/bookos.js').includes('requireRole(...STAFF_ROLES)'));
  checkTrue('accessControl master gate scoped to its subpath', src('routes/accessControl.js').includes("router.use('/access-control', ...masterOnly)") && src('routes/accessControl.js').includes('requireRole(ROLES.COMPANY_OWNER)'));
  checkTrue('speedyVerify accounts master gate', src('routes/speedyVerify.js').includes('requireRole(ROLES.COMPANY_OWNER)'));
  checkTrue('adStudio gate is the marketing set', src('routes/adStudio.js').includes('requireRole(ROLES.MARKETING_MANAGER, ROLES.AD_SPECIALIST, ROLES.COMPANY_ADMIN, ROLES.COMPANY_OWNER, ROLES.PLATFORM_ADMIN)'));
  checkTrue('mediaOs admin gate is the marketing set', src('routes/mediaOs.js').includes('requireRole(ROLES.MARKETING_MANAGER, ROLES.AD_SPECIALIST, ROLES.COMPANY_ADMIN, ROLES.COMPANY_OWNER, ROLES.PLATFORM_ADMIN)'));
  checkTrue('marketingOs admin gate is the marketing set', src('routes/marketingOs.js').includes('requireRole(ROLES.MARKETING_MANAGER, ROLES.AD_SPECIALIST, ROLES.COMPANY_ADMIN, ROLES.COMPANY_OWNER, ROLES.PLATFORM_ADMIN)'));
  checkTrue('insights gate is staff + MARKETING_MANAGER + AD_SPECIALIST, scoped', src('routes/insights.js').includes("router.use('/insights', ...insightsStaff)") && src('routes/insights.js').includes('ROLES.MARKETING_MANAGER') && src('routes/insights.js').includes('ROLES.AD_SPECIALIST'));
  checkTrue('academy trainee gate includes providers', src('routes/academy.js').includes('ACADEMY_TRAINEE_ROLES') && src('routes/academy.js').includes('ROLES.PROVIDER_TECH'));
  checkTrue('bookings list scoped by ownership for non-staff', src('routes/bookings.js').includes('isStaff || bookingBelongsToUser(booking, req.user)'));
  checkTrue('management reports gate is MANAGER_ROLES', src('routes/management.js').includes('requireRole(...MANAGER_ROLES)'));
  checkTrue('finance overview gate is MANAGER_ROLES', src('routes/finance.js').includes("'/finance/overview', authenticate, requireCompany, requireRole(...MANAGER_ROLES)"));
  checkTrue('cococane console gate is STAFF_ROLES', src('routes/cococane.js').includes('requireRole(...STAFF_ROLES)'));
  checkTrue('parts gate is STAFF_ROLES', src('routes/parts.js').includes('requireRole(...STAFF_ROLES)'));
  checkTrue('pro-booking page gate is the STAFF list', read('apps/web/pro-booking/index.html').includes("var STAFF=['DISPATCHER','COMPANY_ADMIN','COMPANY_OWNER','PLATFORM_ADMIN']"));
  checkTrue('parts page gate is the STAFF list', read('apps/web/parts/index.html').includes("var STAFF=['DISPATCHER','COMPANY_ADMIN','COMPANY_OWNER','PLATFORM_ADMIN']"));
  checkTrue('cococane-express page gate is the STAFF list', read('apps/web/cococane-express/index.html').includes("var STAFF=['DISPATCHER','COMPANY_ADMIN','COMPANY_OWNER','PLATFORM_ADMIN']"));
  checkTrue('provider reads carry the oversight board gate', src('routes/provider.js').includes('providerBoard') && src('routes/provider.js').includes('OVERSIGHT_ROLES'));
  checkTrue('MANAGER_ROLES mirrors the Turbo Boss page gate', src('config/security.js').includes('MANAGER_ROLES = [ROLES.COMPANY_ADMIN, ROLES.COMPANY_OWNER, ROLES.PLATFORM_ADMIN]'));
  checkTrue('session vault supports expireActive', read('apps/web/shared/session-vault.js').includes('expireActive'));
  for (const page of ['insights', 'crm', 'book-os', 'navigator', 'pepper', 'tech']) {
    checkTrue(`${page} page wires expired-session recovery`, read(`apps/web/${page}/index.html`).includes('expireActive'));
  }
  checkTrue('tech page carries the oversight board renderer', read('apps/web/tech/index.html').includes('renderTechOversight'));
  checkTrue('turbo-boss page gate is managers only', read('apps/web/turbo-boss/index.html').includes("MANAGERS = ['COMPANY_ADMIN','COMPANY_OWNER','PLATFORM_ADMIN']") || read('apps/web/turbo-boss/index.html').includes('MANAGERS = ["COMPANY_ADMIN"'));
}

async function main() {
  staticChecks();

  // ── Phase A: database mode ─────────────────────────────────────
  await cleanupDb();
  await seed();
  const baseA = `http://127.0.0.1:${PORT_A}/api/v1`;
  const serverA = spawnServer(PORT_A, {
    DATABASE_URL: process.env.DATABASE_URL,
    DATABASE_URL_UNPOOLED: process.env.DATABASE_URL_UNPOOLED,
  });
  await waitForServer(baseA);

  const tok = {};
  for (const key of Object.keys(EMAILS)) tok[key] = await login(baseA, EMAILS[key]);

  // Staff-gated consoles: anon 401, customer 403, dispatcher 200.
  const staffEndpoints = [
    '/navigator/status', '/pepper-console/status', '/crm/home',
    '/bookos/setter-queue', '/bookos/dispatch-board',
    '/notifications/summary', '/link-center/options', '/chats/insights',
    '/tracking/console',
  ];
  for (const path of staffEndpoints) {
    check(`staff gate anon 401: ${path}`, (await api(baseA, path)).status, 401);
    check(`staff gate customer 403: ${path}`, (await api(baseA, path, { token: tok.customer })).status, 403);
    check(`staff gate dispatcher 200: ${path}`, (await api(baseA, path, { token: tok.staff })).status, 200);
  }

  // Manager-gated endpoints (2026-11-18): anon 401, customer 403,
  // dispatcher 403, COMPANY_ADMIN 200, COMPANY_OWNER 200.
  const managerEndpoints = [
    '/finance/overview', '/management/reports/summary', '/management/reports',
  ];
  for (const path of managerEndpoints) {
    check(`manager gate anon 401: ${path}`, (await api(baseA, path)).status, 401);
    check(`manager gate customer 403: ${path}`, (await api(baseA, path, { token: tok.customer })).status, 403);
    check(`manager gate dispatcher 403: ${path}`, (await api(baseA, path, { token: tok.staff })).status, 403);
    check(`manager gate admin 200: ${path}`, (await api(baseA, path, { token: tok.admin })).status, 200);
    check(`manager gate owner 200: ${path}`, (await api(baseA, path, { token: tok.owner })).status, 200);
  }

  // Marketing-gated consoles: dispatcher is NOT in the gate.
  const marketingEndpoints = [
    '/ad-studio/campaigns', '/media-os/admin/content',
    '/marketing-os/admin/pages', '/marketing-os/seo/status',
    '/marketing-os/google-accounts',
  ];
  for (const path of marketingEndpoints) {
    check(`marketing gate anon 401: ${path}`, (await api(baseA, path)).status, 401);
    check(`marketing gate customer 403: ${path}`, (await api(baseA, path, { token: tok.customer })).status, 403);
    check(`marketing gate dispatcher 403: ${path}`, (await api(baseA, path, { token: tok.staff })).status, 403);
    check(`marketing gate marketing-manager 200: ${path}`, (await api(baseA, path, { token: tok.marketing })).status, 200);
  }

  // Insights: staff + marketing manager both pass; customer does not.
  check('insights anon 401', (await api(baseA, '/insights/overview')).status, 401);
  check('insights customer 403', (await api(baseA, '/insights/overview', { token: tok.customer })).status, 403);
  check('insights dispatcher 200', (await api(baseA, '/insights/overview', { token: tok.staff })).status, 200);
  check('insights marketing-manager 200', (await api(baseA, '/insights/overview', { token: tok.marketing })).status, 200);

  // Master-only console (Work Time Access). NOTE: /access-control and
  // /speedy-verify share the single auth rate-limit bucket with
  // /auth/login (10 per 15 min per IP in server.js), so the Speedy
  // Verify accounts probes run in Phase B's fresh server instead —
  // together they would 429 here, which is the limiter working.
  for (const path of ['/access-control/accounts']) {
    check(`owner gate anon 401: ${path}`, (await api(baseA, path)).status, 401);
    check(`owner gate customer 403: ${path}`, (await api(baseA, path, { token: tok.customer })).status, 403);
    check(`owner gate manager 403: ${path}`, (await api(baseA, path, { token: tok.admin })).status, 403);
    check(`owner gate owner 200: ${path}`, (await api(baseA, path, { token: tok.owner })).status, 200);
  }

  // Academy trainee gate: customer locked out, provider trainee in.
  check('academy anon 401', (await api(baseA, '/academy/curriculum')).status, 401);
  check('academy customer 403', (await api(baseA, '/academy/curriculum', { token: tok.customer })).status, 403);
  check('academy provider trainee 200', (await api(baseA, '/academy/curriculum', { token: tok.provider })).status, 200);
  check('academy dispatcher trainee 200', (await api(baseA, '/academy/curriculum', { token: tok.staff })).status, 200);

  // The bookings-list fix: a customer cannot enumerate other bookings.
  const created = await api(baseA, '/bookings', {
    token: tok.staff, method: 'POST',
    body: {
      customer: { name: 'Badge Drill', phone: '9545550199', email: 'badge-drill-cust@test.local' },
      city: 'Fort Lauderdale', zip: '33301', appliance: 'Refrigerator', issue: 'Not cooling',
    },
  });
  check('drill booking created 201', created.status, 201);
  drillBookingId = created.json?.data?.id || null;
  checkTrue('drill booking id returned', Boolean(drillBookingId));
  const custList = await api(baseA, '/bookings', { token: tok.customer });
  check('customer bookings list 200 (own only)', custList.status, 200);
  checkTrue('customer list excludes the drill booking', !(custList.json.data || []).some((b) => b.id === drillBookingId));
  const staffList = await api(baseA, '/bookings', { token: tok.staff });
  checkTrue('staff list includes the drill booking', (staffList.json.data || []).some((b) => b.id === drillBookingId));
  check('customer direct read of another booking 403', (await api(baseA, `/bookings/${drillBookingId}`, { token: tok.customer })).status, 403);

  // Public routes stay public after every gate change.
  check('public payments/status 200', (await api(baseA, '/payments/status')).status, 200);
  const image = await fetch(`${baseA}/app/scenario-images/need-warm-fridge.webp`);
  check('public scenario image 200', image.status, 200);

  serverA.kill();
  await new Promise((r) => setTimeout(r, 500));

  // ── Phase B: memory mode (minted JWTs) ─────────────────────────
  const baseB = `http://127.0.0.1:${PORT_B}/api/v1`;
  const serverB = spawnServer(PORT_B, { DATABASE_URL: undefined, DATABASE_URL_UNPOOLED: undefined });
  await waitForServer(baseB);
  const mStaff = mintToken(IDS.staff, EMAILS.staff, ['DISPATCHER']);
  const mCustomer = mintToken(IDS.customer, EMAILS.customer, ['CUSTOMER']);
  const mOwner = mintToken(IDS.owner, EMAILS.owner, ['COMPANY_OWNER']);
  const mAdmin = mintToken(IDS.admin, EMAILS.admin, ['COMPANY_ADMIN']);
  const mMarketing = mintToken(IDS.marketing, EMAILS.marketing, ['MARKETING_MANAGER']);

  check('memory: navigator anon 401', (await api(baseB, '/navigator/status')).status, 401);
  check('memory: navigator customer 403', (await api(baseB, '/navigator/status', { token: mCustomer })).status, 403);
  check('memory: navigator dispatcher 200', (await api(baseB, '/navigator/status', { token: mStaff })).status, 200);
  check('memory: access-control manager 403', (await api(baseB, '/access-control/accounts', { token: mAdmin })).status, 403);
  check('memory: access-control owner 200', (await api(baseB, '/access-control/accounts', { token: mOwner })).status, 200);
  check('memory: ad-studio dispatcher 403', (await api(baseB, '/ad-studio/campaigns', { token: mStaff })).status, 403);
  check('memory: ad-studio marketing 200', (await api(baseB, '/ad-studio/campaigns', { token: mMarketing })).status, 200);
  check('memory: speedy-verify anon 401', (await api(baseB, '/speedy-verify/accounts')).status, 401);
  check('memory: speedy-verify customer 403', (await api(baseB, '/speedy-verify/accounts', { token: mCustomer })).status, 403);
  check('memory: speedy-verify manager 403', (await api(baseB, '/speedy-verify/accounts', { token: mAdmin })).status, 403);
  check('memory: speedy-verify owner 200', (await api(baseB, '/speedy-verify/accounts', { token: mOwner })).status, 200);
  check('memory: public payments/status 200', (await api(baseB, '/payments/status')).status, 200);

  serverB.kill();
  await new Promise((r) => setTimeout(r, 500));

  await cleanupDb();
  await prisma.$disconnect();
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  try { await cleanupDb(); await prisma.$disconnect(); } catch { /* ignore */ }
  process.exit(1);
});
