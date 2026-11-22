/**
 * Pepper Lists own-database split — verification harness (2026-11-21).
 *
 * Proves the split is real, not a relabel:
 *  1. With PL_DATABASE_URL set, Pepper Lists writes through the API
 *     land in the PEPPER LISTS database and NOT in the main database
 *     (both databases are queried directly, bypassing the API).
 *  2. Accounts/auth stay in the main database — login works and no
 *     User table exists in the PL database.
 *  3. The operator data-move script
 *     (scripts/migrate-pepper-lists-db.mjs) copies pre-split rows
 *     from main to PL losslessly: it exits 0, the target counts
 *     match, sampled rows are deep-equal, and a re-run is safe.
 *
 * Requires BOTH DATABASE_URL (main test DB) and PL_DATABASE_URL
 * (Pepper Lists test DB). Exit code 0 = every check passed.
 */
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/services/passwords.js';
import { PLATFORM_COMPANY_ID } from '../src/data/store.js';

const execFileP = promisify(execFile);

if (!process.env.DATABASE_URL || !process.env.PL_DATABASE_URL) {
  console.error('DATABASE_URL and PL_DATABASE_URL are both required (local TEST databases).');
  process.exit(2);
}
process.env.DATABASE_URL_UNPOOLED ||= process.env.DATABASE_URL;

const PORT = Number(process.env.TEST_PORT || 4433);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const PASSWORD = 'test-pass-1234';
const SELLER = '20000000-0000-4000-8000-0000000000e1';
const API_DIR = fileURLToPath(new URL('..', import.meta.url));

const prisma = new PrismaClient();
const { PrismaClient: PlClient } = await import('../node_modules/.prisma/pl-client/index.js');
const plPrisma = new PlClient();
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

async function cleanup() {
  try {
    await plPrisma.sellerChannelAudit.deleteMany({ where: { userId: SELLER } });
    await plPrisma.sellerChannelConnection.deleteMany({ where: { userId: SELLER } });
    await plPrisma.savedListing.deleteMany({ where: { userId: SELLER } });
    await prisma.sellerChannelAudit.deleteMany({ where: { userId: SELLER } }).catch(() => {});
    await prisma.sellerChannelConnection.deleteMany({ where: { userId: SELLER } }).catch(() => {});
    await prisma.savedListing.deleteMany({ where: { userId: SELLER } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: SELLER } });
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
  const passwordHash = await hashPassword(PASSWORD);
  await prisma.company.upsert({
    where: { id: PLATFORM_COMPANY_ID },
    update: {},
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'test-platform', type: 'PLATFORM_OWNER', isPlatformOwner: true },
  });
  await prisma.user.upsert({
    where: { id: SELLER },
    update: { passwordHash },
    create: { id: SELLER, companyId: PLATFORM_COMPANY_ID, email: 'split@test.local', passwordHash, phone: '9545550100', roles: ['CUSTOMER'], active: true },
  });

  // The PL database has no User table at all (accounts stay main).
  const plTables = await plPrisma.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`;
  const plTableNames = plTables.map((t) => t.tablename);
  checkTrue('PL database holds SellerChannelConnection', plTableNames.includes('SellerChannelConnection'));
  check('PL database has NO User table', plTableNames.includes('User'), false);
  checkTrue('PL database holds all 17 PL tables', ['ListingProfile', 'ListingComment', 'ListingReport', 'SellerSale', 'SellerReview', 'ListingBump', 'SavedListing', 'SellerPlan', 'SellerSubscription', 'SellerChannelConnection', 'SellerChannelAudit', 'PepperListsCrossPost', 'PepperListsSyndication', 'PepperListsThread', 'PepperListsMessage', 'PepperListsOrder', 'SellerConnectAccount'].every((t) => plTableNames.includes(t)));

  server = spawn('node', ['src/server.js'], {
    cwd: API_DIR,
    env: {
      ...process.env,
      PORT: String(PORT),
      JWT_SECRET: 'test-secret-pl-db-split',
      DATABASE_URL: process.env.DATABASE_URL,
      DATABASE_URL_UNPOOLED: process.env.DATABASE_URL_UNPOOLED,
      PL_DATABASE_URL: process.env.PL_DATABASE_URL,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[api] ${d}`));
  await waitForServer();

  const login = await api('/auth/login', { method: 'POST', body: { email: 'split@test.local', password: PASSWORD } });
  check('login works against the MAIN database (auth never moved)', login.status, 200);
  const token = login.json.token;

  const conn = await api('/pepper-lists/channels/YOUTUBE/connect', { token, method: 'POST', body: { accountLabel: '@split' } });
  check('connect through the API 201', conn.status, 201);

  const inPl = await plPrisma.sellerChannelConnection.findMany({ where: { userId: SELLER } });
  check('the channel row is in the PL database', inPl.length, 1);
  check('the row is the YOUTUBE request', inPl[0]?.channel, 'YOUTUBE');
  const inMain = await prisma.sellerChannelConnection.findMany({ where: { userId: SELLER } });
  check('NO channel row leaked into the main database', inMain.length, 0);
  const auditInPl = await plPrisma.sellerChannelAudit.findMany({ where: { userId: SELLER } });
  checkTrue('the audit row is in the PL database too', auditInPl.length >= 1);
  const auditInMain = await prisma.sellerChannelAudit.findMany({ where: { userId: SELLER } });
  check('NO audit row leaked into the main database', auditInMain.length, 0);

  // ── The operator data move ────────────────────────────────────
  // Simulate pre-split production: a PL row that exists ONLY in main.
  await prisma.savedListing.create({
    data: { id: '50000000-0000-4000-8000-0000000000e1', userId: SELLER, listingId: 'TS-SPLIT-MOVE' },
  });
  check('pre-move: the saved listing is only in main', await plPrisma.savedListing.count({ where: { userId: SELLER } }), 0);

  const env = { ...process.env, DATABASE_URL: process.env.DATABASE_URL, PL_DATABASE_URL: process.env.PL_DATABASE_URL };
  const dry = await execFileP('node', ['scripts/migrate-pepper-lists-db.mjs', '--dry-run'], { cwd: API_DIR, env });
  checkTrue('dry run reports the source row', dry.stdout.includes('savedListing: source=1'));
  check('dry run copied nothing', await plPrisma.savedListing.count({ where: { userId: SELLER } }), 0);

  const run1 = await execFileP('node', ['scripts/migrate-pepper-lists-db.mjs'], { cwd: API_DIR, env });
  checkTrue('copy run verifies savedListing', /savedListing: source=1 copied=1 target=1 spotCheck=ok/.test(run1.stdout));
  const moved = await plPrisma.savedListing.findUnique({ where: { id: '50000000-0000-4000-8000-0000000000e1' } });
  check('the moved row is readable in the PL database', moved?.listingId, 'TS-SPLIT-MOVE');
  const run2 = await execFileP('node', ['scripts/migrate-pepper-lists-db.mjs'], { cwd: API_DIR, env });
  checkTrue('re-run is safe (idempotent upsert)', run2.stdout.includes('verified'));

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`} — pl-db-split`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(async () => {
    if (server) server.kill('SIGTERM');
    await cleanup();
    await prisma.$disconnect();
    await plPrisma.$disconnect();
  });
