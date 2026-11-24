import { osUpdatesRepo } from '../db/osUpdatesRepo.js';

/**
 * OS Systems Updating System — the service (2026-11-23, Ramone's
 * directive). A registry of every OS platform and the tech packs
 * each one runs, plus the 6-MONTH UPDATE CYCLE that keeps the whole
 * ecosystem current:
 *
 *  - registerPlatform / registerTechPack / setInstalledVersion are
 *    idempotent upserts — the deploy-time seed (Phase 6) and staff
 *    can re-run them freely;
 *  - refreshLatestVersions() reads the npm registry for NPM packs
 *    and records what it ACTUALLY got (version + checkedAt). A
 *    failed read leaves the previous values untouched and notes
 *    the failure — a latest version is never invented;
 *  - openCycle(key) computes drift (installed vs latest) for every
 *    recorded (platform, pack) pair and generates the cycle's
 *    update plan as UpdateTasks. Tasks are born PENDING (a real
 *    update) or PLANNED (a verify task, when either side's version
 *    is unknown). Platforms whose versions have never been read
 *    get one platform-level verify task. Re-opening the same key
 *    returns the existing cycle and generates nothing twice.
 *
 * The system PREPARES, TRACKS and VERIFIES. Applying an update is
 * the normal build + push + owner-approval flow; a person then
 * moves the task APPLIED → VERIFIED here.
 */

function fail(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

export const UPDATE_TASK_STATUSES = ['PENDING', 'PLANNED', 'APPLIED', 'VERIFIED', 'SKIPPED', 'BLOCKED'];
export const CYCLE_MONTHS = 6;
export const BASELINE_CYCLE_KEY = '2026-11-baseline';
export const BASELINE_CYCLE_DUE = '2027-05-23T00:00:00.000Z';
export const STACK_AUDIT_PACK_KEY = 'platform-stack-audit';

// ─── Version comparison ───────────────────────────────────────────
// Versions in this registry are recorded strings: resolved versions
// from lockfiles ("5.3.0"), ranges from package.json ("^6.19.3"),
// or engine ranges (">=20"). Comparison extracts the first numeric
// dotted core; anything without one is UNKNOWN — never guessed.

export function parseVersionCore(value) {
  if (value == null) return null;
  const match = String(value).match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] || 0)];
}

export function driftOf(installedVersion, latestVersion) {
  const installed = parseVersionCore(installedVersion);
  const latest = parseVersionCore(latestVersion);
  if (!installed || !latest) return 'UNKNOWN';
  if (installed[0] !== latest[0]) return installed[0] < latest[0] ? 'MAJOR_BEHIND' : 'CURRENT';
  if (installed[1] !== latest[1]) return installed[1] < latest[1] ? 'MINOR_BEHIND' : 'CURRENT';
  if (installed[2] !== latest[2]) return installed[2] < latest[2] ? 'MINOR_BEHIND' : 'CURRENT';
  return 'CURRENT';
}

const DRIFT_RANK = { CURRENT: 0, MINOR_BEHIND: 1, MAJOR_BEHIND: 2, UNKNOWN: 3 };

function addMonths(date, months) {
  const d = new Date(date);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

// ─── Registry writes (idempotent upserts) ─────────────────────────

export async function registerDivision(data) {
  if (!data?.key || !data?.name || !data?.role) {
    throw fail(400, 'DIVISION_INVALID', 'A division needs a key, a name and a role.');
  }
  return osUpdatesRepo.upsertDivision(data);
}

export async function registerPlatform(data) {
  if (!data?.key || !data?.name || !data?.kind) {
    throw fail(400, 'PLATFORM_INVALID', 'A platform needs a key, a name and a kind.');
  }
  return osUpdatesRepo.upsertPlatform(data);
}

export async function registerTechPack(data) {
  if (!data?.key || !data?.name || !data?.ecosystem) {
    throw fail(400, 'PACK_INVALID', 'A tech pack needs a key, a name and an ecosystem.');
  }
  return osUpdatesRepo.upsertPack(data);
}

export async function setInstalledVersion(platformKey, packKey, data) {
  const platform = await osUpdatesRepo.findPlatformByKey(platformKey);
  if (!platform) throw fail(404, 'PLATFORM_NOT_FOUND', `No platform registered as ${platformKey}.`);
  const pack = await osUpdatesRepo.findPackByKey(packKey);
  if (!pack) throw fail(404, 'PACK_NOT_FOUND', `No tech pack registered as ${packKey}.`);
  if (!data?.installedVersion) throw fail(400, 'VERSION_REQUIRED', 'An installed version string is required.');
  return osUpdatesRepo.setInstalled(platform.id, pack.id, data);
}

// ─── Latest-version refresh (npm registry) ────────────────────────
// The fetch is injectable so drills can stub the registry. Bounded
// timeout per pack; one pack's failure never stops the others and
// never overwrites a previously recorded latest.

export async function refreshLatestVersions({ fetchImpl, timeoutMs = 8000 } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const packs = await osUpdatesRepo.listPacks();
  const results = [];
  for (const pack of packs) {
    if (pack.ecosystem !== 'NPM') {
      results.push({ key: pack.key, refreshed: false, reason: 'not-npm' });
      continue;
    }
    const url = `https://registry.npmjs.org/${encodeURIComponent(pack.key)}/latest`;
    try {
      const res = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`registry answered ${res.status}`);
      const body = await res.json();
      if (!body?.version) throw new Error('registry response carried no version');
      await osUpdatesRepo.updatePackLatest(pack.id, {
        currentLatestVersion: String(body.version),
        latestCheckedAt: new Date(),
        latestNote: null,
      });
      results.push({ key: pack.key, refreshed: true, latest: String(body.version) });
    } catch (error) {
      await osUpdatesRepo.updatePackLatest(pack.id, {
        latestNote: `Refresh failed ${new Date().toISOString()}: ${error.message}`.slice(0, 500),
      });
      results.push({ key: pack.key, refreshed: false, reason: error.message });
    }
  }
  return { checkedAt: new Date().toISOString(), results };
}

// ─── The 6-month cycle ────────────────────────────────────────────

export async function openCycle(key, { openedAt, dueAt, note } = {}) {
  if (!key) throw fail(400, 'CYCLE_KEY_REQUIRED', 'A cycle key is required (e.g. "2027-05").');
  const existing = await osUpdatesRepo.findCycleByKey(key);
  if (existing) {
    const tasks = await osUpdatesRepo.listTasks(existing.id);
    return { cycle: existing, created: 0, taskCount: tasks.length, alreadyOpen: true };
  }
  const opened = openedAt ? new Date(openedAt) : new Date();
  const due = dueAt ? new Date(dueAt) : addMonths(opened, CYCLE_MONTHS);
  const cycle = await osUpdatesRepo.createCycle({
    key, openedAt: opened, dueAt: due, note: note ?? null,
  });

  const [platforms, packs, installed] = await Promise.all([
    osUpdatesRepo.listPlatforms(),
    osUpdatesRepo.listPacks(),
    osUpdatesRepo.listInstalled(),
  ]);
  const packById = new Map(packs.map((p) => [p.id, p]));
  const platformById = new Map(platforms.map((p) => [p.id, p]));
  const auditPack = packs.find((p) => p.key === STACK_AUDIT_PACK_KEY) || null;

  const tasks = [];
  const platformsWithRows = new Set();
  for (const row of installed) {
    const platform = platformById.get(row.platformId);
    const pack = packById.get(row.techPackId);
    if (!platform || !pack || !platform.active) continue;
    platformsWithRows.add(platform.id);
    const drift = driftOf(row.installedVersion, pack.currentLatestVersion);
    if (drift === 'CURRENT') continue;
    const isVerify = drift === 'UNKNOWN';
    tasks.push({
      cycleId: cycle.id,
      platformId: platform.id,
      techPackId: pack.id,
      kind: isVerify ? 'VERIFY' : 'UPDATE',
      drift,
      fromVersion: row.installedVersion,
      toVersion: isVerify ? null : pack.currentLatestVersion,
      status: isVerify ? 'PLANNED' : 'PENDING',
      note: isVerify
        ? 'Latest version unknown — run Refresh latest versions, then re-check drift before planning an update.'
        : `${pack.name} ${row.installedVersion} → ${pack.currentLatestVersion} on ${platform.name}.`,
    });
  }
  // Platforms whose stack has never been read: one verify task each
  // (against the audit pack), so the plan covers the WHOLE OS —
  // their versions are recorded by hand from their package files,
  // never guessed here.
  if (auditPack) {
    for (const platform of platforms) {
      if (!platform.active || platformsWithRows.has(platform.id)) continue;
      tasks.push({
        cycleId: cycle.id,
        platformId: platform.id,
        techPackId: auditPack.id,
        kind: 'VERIFY',
        drift: 'UNKNOWN',
        fromVersion: null,
        toVersion: null,
        status: 'PLANNED',
        note: `No tech-pack versions have been read for ${platform.name} yet — read its package files and record the installed versions in this registry.`,
      });
    }
  }
  const created = await osUpdatesRepo.createTasks(tasks);
  return { cycle, created, taskCount: tasks.length, alreadyOpen: false };
}

export async function setTaskStatus(taskId, status, note) {
  if (!UPDATE_TASK_STATUSES.includes(status)) {
    throw fail(400, 'TASK_STATUS_INVALID', `Status must be one of ${UPDATE_TASK_STATUSES.join(', ')}.`);
  }
  const task = await osUpdatesRepo.findTaskById(taskId);
  if (!task) throw fail(404, 'TASK_NOT_FOUND', `No update task ${taskId}.`);
  const data = { status };
  if (note !== undefined) data.note = note;
  if (status === 'APPLIED' && !task.appliedAt) data.appliedAt = new Date();
  if (status === 'VERIFIED') {
    if (!task.appliedAt && !data.appliedAt) data.appliedAt = new Date();
    data.verifiedAt = new Date();
  }
  return osUpdatesRepo.updateTask(taskId, data);
}

// ─── Reads + summary ──────────────────────────────────────────────

export async function listPlatforms() {
  const [platforms, packs, installed] = await Promise.all([
    osUpdatesRepo.listPlatforms(),
    osUpdatesRepo.listPacks(),
    osUpdatesRepo.listInstalled(),
  ]);
  const packById = new Map(packs.map((p) => [p.id, p]));
  return platforms.map((platform) => {
    const rows = installed.filter((r) => r.platformId === platform.id);
    let drift = 'UNKNOWN';
    const packRows = rows.map((row) => {
      const pack = packById.get(row.techPackId);
      const rowDrift = driftOf(row.installedVersion, pack?.currentLatestVersion);
      if (DRIFT_RANK[rowDrift] > DRIFT_RANK[drift]) drift = rowDrift;
      return {
        packKey: pack?.key ?? null,
        packName: pack?.name ?? null,
        installedVersion: row.installedVersion,
        latestVersion: pack?.currentLatestVersion ?? null,
        drift: rowDrift,
        sourceNote: row.sourceNote,
      };
    });
    return { ...platform, drift, packs: packRows, packsBehind: packRows.filter((r) => r.drift === 'MINOR_BEHIND' || r.drift === 'MAJOR_BEHIND').length };
  });
}

export async function listPacks() {
  return osUpdatesRepo.listPacks();
}

/** Divisions with their platform counts (the corporate structure:
 * Top Speed OS main, Service OS the service side, Sales OS the
 * retailing side). */
export async function listDivisions() {
  const [divisions, platforms] = await Promise.all([
    osUpdatesRepo.listDivisions(),
    osUpdatesRepo.listPlatforms(),
  ]);
  return divisions.map((division) => ({
    ...division,
    platformCount: platforms.filter((p) => p.divisionKey === division.key).length,
  }));
}

export async function listCycles() {
  const cycles = await osUpdatesRepo.listCycles();
  const out = [];
  for (const cycle of cycles) {
    const tasks = await osUpdatesRepo.listTasks(cycle.id);
    const byStatus = {};
    for (const task of tasks) byStatus[task.status] = (byStatus[task.status] || 0) + 1;
    out.push({ ...cycle, taskCount: tasks.length, tasksByStatus: byStatus });
  }
  return out;
}

export async function listCycleTasks(cycleKey) {
  const cycle = await osUpdatesRepo.findCycleByKey(cycleKey);
  if (!cycle) throw fail(404, 'CYCLE_NOT_FOUND', `No cycle ${cycleKey}.`);
  const [platforms, packs, tasks] = await Promise.all([
    osUpdatesRepo.listPlatforms(),
    osUpdatesRepo.listPacks(),
    osUpdatesRepo.listTasks(cycle.id),
  ]);
  const platformById = new Map(platforms.map((p) => [p.id, p]));
  const packById = new Map(packs.map((p) => [p.id, p]));
  return tasks.map((task) => ({
    ...task,
    platformKey: platformById.get(task.platformId)?.key ?? null,
    platformName: platformById.get(task.platformId)?.name ?? null,
    packKey: packById.get(task.techPackId)?.key ?? null,
    packName: packById.get(task.techPackId)?.name ?? null,
  }));
}

export async function osUpdatesSummary() {
  const [platforms, packs, installed, cycles, divisions] = await Promise.all([
    osUpdatesRepo.listPlatforms(),
    osUpdatesRepo.listPacks(),
    osUpdatesRepo.listInstalled(),
    osUpdatesRepo.listCycles(),
    osUpdatesRepo.listDivisions(),
  ]);
  const divisionsOut = {};
  for (const division of divisions) divisionsOut[division.key] = 0;
  for (const platform of platforms) {
    divisionsOut[platform.divisionKey] = (divisionsOut[platform.divisionKey] || 0) + 1;
  }
  const packById = new Map(packs.map((p) => [p.id, p]));
  const drift = { CURRENT: 0, MINOR_BEHIND: 0, MAJOR_BEHIND: 0, UNKNOWN: 0 };
  for (const row of installed) {
    drift[driftOf(row.installedVersion, packById.get(row.techPackId)?.currentLatestVersion)] += 1;
  }
  const open = cycles.find((c) => c.status === 'OPEN') || null;
  let openCycle = null;
  if (open) {
    const tasks = await osUpdatesRepo.listTasks(open.id);
    const byStatus = {};
    for (const task of tasks) byStatus[task.status] = (byStatus[task.status] || 0) + 1;
    openCycle = { ...open, taskCount: tasks.length, tasksByStatus: byStatus };
  }
  return {
    platforms: platforms.length,
    platformsActive: platforms.filter((p) => p.active).length,
    divisions: divisionsOut,
    packs: packs.length,
    packsWithLatest: packs.filter((p) => p.currentLatestVersion).length,
    installedRows: installed.length,
    drift,
    cycleMonths: CYCLE_MONTHS,
    openCycle,
    cycles: cycles.length,
  };
}

// ─── Seed inventory (Phase 6) ─────────────────────────────────────
// The REAL fleet, cross-checked against the Campaign Engine
// division list and the Ads OS platforms feed. Versions below were
// read from the repos' own package files on 2026-11-23 (resolved
// versions from lockfiles where a lockfile carries them). Platforms
// whose package files could not be read carry NO installed rows —
// the baseline cycle gives them verify tasks instead of guesses.
// Appliance Plus Air, LLC (separate company) is NOT a platform
// here; the Appliance Plus APP below is the parts-supply Expo app,
// a different thing that does exist.

// The corporate division structure (Ramone, 2026-11-23): Top Speed
// OS is the MAIN division — the parent for everything, including
// all new platforms. Top Speed Service OS is the SERVICE side of
// the business (repair / installation services). Top Speed Sales OS
// is the RETAILING side (the used-appliance shop). Exactly these
// three divisions are registered; FUTURE divisions are the owner's
// to define.
export const DIVISION_SEEDS = [
  {
    key: 'TOP_SPEED_OS',
    name: 'Top Speed OS',
    role: 'MAIN',
    parentKey: null,
    description: 'The main division — parent of the whole ecosystem and the home of every new platform. Ecosystem-wide and cross-division platforms live here.',
    homeUrl: 'https://topspeedserviceos.com',
    sortOrder: 0,
  },
  {
    key: 'SERVICE_OS',
    name: 'Top Speed Service OS',
    role: 'SERVICE',
    parentKey: 'TOP_SPEED_OS',
    description: 'The service side of the business — appliance repair and installation services: booking, dispatch, the tech platforms, and the customer service surfaces.',
    homeUrl: 'https://topspeedserviceos.com',
    sortOrder: 1,
  },
  {
    key: 'SALES_OS',
    name: 'Top Speed Sales OS',
    role: 'RETAIL',
    parentKey: 'TOP_SPEED_OS',
    description: 'The retailing side of the business — Top Speed Appliances, the used-appliance shop at topspeedappliances.com, run from the /sales-os console.',
    homeUrl: 'https://topspeedappliances.com',
    sortOrder: 2,
  },
];

// Division assignment for the seeded platforms (everything not
// listed here belongs to TOP_SPEED_OS, the main division):
//  - SERVICE_OS: the service side — Book OS / Service Setters,
//    dispatch + Service Book, CRM, the tech doors (Company Tech,
//    Network Tech, Field Pro web + app), the Service OS portal,
//    Speedy booking, the customer service surfaces (/app, Appliance
//    Connect web + Pro + their Expo apps, AppliancePro + its app),
//    Training Academy, Work Time Access, Oversight, Finance, and
//    the Service OS API itself.
//  - SALES_OS: the retailing side — the Sales OS console and the
//    topspeedappliances.com shop.
//  - TOP_SPEED_OS: the main division — ApplianceMan (the master
//    console over everything), Pepper Lists, the marketing/media
//    consoles (Media OS, Marketing OS, Local OS, Ads OS, Facebook
//    OS, Ad Studio, Page Studio), the flagship web + satellite
//    websites, Rewards + Referrals, the Pepper Console, this
//    Updating System's own console, and the remaining Expo apps.
export const PLATFORM_DIVISIONS = {
  'book-os': 'SERVICE_OS',
  dispatch: 'SERVICE_OS',
  crm: 'SERVICE_OS',
  'tech-portal': 'SERVICE_OS',
  'network-tech': 'SERVICE_OS',
  'field-pro-web': 'SERVICE_OS',
  'service-os-portal': 'SERVICE_OS',
  'speedy-booking': 'SERVICE_OS',
  'customer-app': 'SERVICE_OS',
  'appliance-connect-web': 'SERVICE_OS',
  'connect-pro': 'SERVICE_OS',
  'appliancepro-portal': 'SERVICE_OS',
  'training-academy': 'SERVICE_OS',
  'work-time-access': 'SERVICE_OS',
  oversight: 'SERVICE_OS',
  finance: 'SERVICE_OS',
  'service-os-api': 'SERVICE_OS',
  'app-field-pro': 'SERVICE_OS',
  'app-appliance-connect': 'SERVICE_OS',
  'app-appliance-pro': 'SERVICE_OS',
  'sales-os': 'SALES_OS',
  'topspeedappliances-shop': 'SALES_OS',
};

export const OS_PLATFORM_SEEDS = [
  // Consoles / workstations (flagship)
  { key: 'service-os-portal', name: 'Service OS Portal', kind: 'CONSOLE', surface: 'https://topspeedserviceos.com/portal' },
  { key: 'book-os', name: 'Book OS — Service Setters', kind: 'CONSOLE', surface: 'https://topspeedserviceos.com/book-os' },
  { key: 'dispatch', name: 'Dispatch Dashboard / Service Book', kind: 'CONSOLE', surface: 'https://topspeedserviceos.com/dispatch-dashboard' },
  { key: 'crm', name: 'Top Speed CRM / Service Book', kind: 'CONSOLE', surface: 'https://topspeedserviceos.com/crm' },
  { key: 'tech-portal', name: 'Company Tech Portal (/tech)', kind: 'CONSOLE', surface: 'https://topspeedserviceos.com/tech' },
  { key: 'network-tech', name: 'Network Tech Portal', kind: 'CONSOLE', surface: 'https://topspeedserviceos.com/tech-network' },
  { key: 'field-pro-web', name: 'Field Pro (web)', kind: 'CONSOLE', surface: 'https://top-speed-field-pro.vercel.app/' },
  { key: 'applianceman', name: 'ApplianceMan — Master Super Manager', kind: 'CONSOLE', surface: 'https://topspeedserviceos.com/applianceman' },
  { key: 'sales-os', name: 'Top Speed Sales OS', kind: 'CONSOLE', surface: 'https://topspeedserviceos.com/sales-os' },
  { key: 'facebook-os', name: 'Facebook OS Manager', kind: 'CONSOLE', surface: 'https://topspeedserviceos.com/facebook-os' },
  { key: 'ads-os', name: 'Top Speed Ads OS', kind: 'CONSOLE', surface: 'https://topspeedserviceos.com/ads' },
  { key: 'media-os', name: 'Top Speed Media OS', kind: 'CONSOLE', surface: 'https://topspeedserviceos.com/media' },
  { key: 'page-studio', name: 'Page Studio', kind: 'CONSOLE', surface: 'https://topspeedserviceos.com/marketing-os/studio' },
  { key: 'ad-studio', name: 'Top Speed Ad Studio', kind: 'CONSOLE', surface: 'https://topspeedserviceos.com/ad-studio' },
  { key: 'local-os', name: 'Top Speed Local OS', kind: 'CONSOLE', surface: 'https://topspeedserviceos.com/local' },
  { key: 'marketing-os', name: 'Top Speed Marketing OS', kind: 'CONSOLE', surface: 'https://topspeedserviceos.com/marketing-os' },
  { key: 'work-time-access', name: 'Work Time Access', kind: 'CONSOLE', surface: 'https://topspeedserviceos.com/work-time-access' },
  { key: 'oversight', name: 'Oversight', kind: 'CONSOLE', surface: 'https://topspeedserviceos.com/oversight' },
  { key: 'finance', name: 'Finance', kind: 'CONSOLE', surface: 'https://topspeedserviceos.com/finance' },
  { key: 'training-academy', name: 'Training Academy', kind: 'CONSOLE', surface: 'https://topspeedserviceos.com/academy' },
  { key: 'pepper-console', name: 'Pepper Console', kind: 'CONSOLE', surface: 'https://topspeedserviceos.com/pepper' },
  { key: 'os-updates', name: 'OS Systems — Updates (this console)', kind: 'CONSOLE', surface: 'https://topspeedserviceos.com/os-updates' },
  // Customer surfaces
  { key: 'customer-app', name: 'Appliance Connect — customer app (web)', kind: 'CUSTOMER_APP', surface: 'https://topspeedserviceos.com/app' },
  { key: 'pepper-lists', name: 'Pepper Lists', kind: 'CUSTOMER_APP', surface: 'https://pepperlists.com/' },
  { key: 'appliance-connect-web', name: 'Appliance Connect (web portal)', kind: 'CUSTOMER_APP', surface: 'https://topspeedserviceos.com/appliance-connect' },
  { key: 'connect-pro', name: 'Appliance Connect Pro', kind: 'CUSTOMER_APP', surface: 'https://topspeedserviceos.com/connect-pro' },
  { key: 'appliancepro-portal', name: 'AppliancePro (commercial portal)', kind: 'CUSTOMER_APP', surface: 'https://appliancepro.net/' },
  { key: 'speedy-booking', name: 'Smart AI Booking by Speedy', kind: 'CUSTOMER_APP', surface: 'https://topspeedserviceos.com/speedy' },
  { key: 'referrals', name: 'Rewards + Referrals', kind: 'CUSTOMER_APP', surface: 'https://topspeedserviceos.com/refer' },
  // Websites + satellite sites
  { key: 'flagship-web', name: 'topspeedserviceos.com — flagship web', kind: 'WEBSITE', surface: 'https://topspeedserviceos.com/' },
  { key: 'service-os-api', name: 'Service OS API', kind: 'SERVICE', surface: 'https://top-speed-service-os.vercel.app/api/v1' },
  { key: 'topspeedappliance-net', name: 'topspeedappliance.net', kind: 'SATELLITE_SITE', surface: 'https://www.topspeedappliance.net/' },
  { key: 'appliancepro-net', name: 'appliancepro.net', kind: 'SATELLITE_SITE', surface: 'https://appliancepro.net/' },
  { key: 'totalhomeappliance-com', name: 'totalhomeappliance.com', kind: 'SATELLITE_SITE', surface: 'https://totalhomeappliance.com/' },
  { key: 'topspeedappliancerepair-com', name: 'topspeedappliancerepair.com', kind: 'SATELLITE_SITE', surface: 'https://topspeedappliancerepair.com/' },
  { key: 'browardapplianceservice-com', name: 'browardapplianceservice.com', kind: 'SATELLITE_SITE', surface: 'https://browardapplianceservice.com/' },
  { key: 'cleanoutvents-site', name: 'Cleanout Vents site (sister brand)', kind: 'SATELLITE_SITE', surface: 'https://cleanoutvents.com/', ownerNote: 'Cleanout Vents keeps its own brand identity and phone number; it is registered here only so its stack joins the update cycle.' },
  { key: 'topspeedappliances-shop', name: 'topspeedappliances.com — used-appliance shop', kind: 'SATELLITE_SITE', surface: 'https://topspeedappliances.com/' },
  // Mobile apps (the 9 Expo projects)
  { key: 'app-pepperlists', name: 'Pepper Lists (Expo app)', kind: 'MOBILE_APP', surface: 'expo:pepperlists-app' },
  { key: 'app-applianceman', name: 'ApplianceMan Super Manager (Expo app)', kind: 'MOBILE_APP', surface: 'expo:applianceman-super-manager' },
  { key: 'app-appliance-pro', name: 'Appliance Pro (Expo app)', kind: 'MOBILE_APP', surface: 'expo:appliance-pro-app' },
  { key: 'app-cococane', name: 'CocoCane Express (Expo app)', kind: 'MOBILE_APP', surface: 'expo:cococane-app' },
  { key: 'app-appliance-plus', name: 'Appliance Plus (Expo app — parts supply)', kind: 'MOBILE_APP', surface: 'expo:appliance-plus-app', ownerNote: 'The Appliance Plus parts-supply app (Appliance Plus Parts Supply, the partner distributor). NOT Appliance Plus Air, LLC — that separate company is not a platform in this registry.' },
  { key: 'app-appliance-connect', name: 'Appliance Connect (Expo app)', kind: 'MOBILE_APP', surface: 'expo:appliance-connect-app' },
  { key: 'app-ads-os-manager', name: 'Ads OS Manager (Expo app)', kind: 'MOBILE_APP', surface: 'expo:top-speed-ads-os-manager' },
  { key: 'app-field-pro', name: 'Field Pro (Expo app)', kind: 'MOBILE_APP', surface: 'expo:top-speed-field-pro' },
  { key: 'app-top-speed', name: 'Top Speed (Expo app)', kind: 'MOBILE_APP', surface: 'expo:top-speed-1' },
];

export const TECH_PACK_SEEDS = [
  { key: 'node', name: 'Node.js runtime', ecosystem: 'RUNTIME', registryUrl: 'https://nodejs.org/' },
  { key: 'express', name: 'Express', ecosystem: 'NPM', registryUrl: 'https://www.npmjs.com/package/express' },
  { key: 'cors', name: 'CORS (Express middleware)', ecosystem: 'NPM', registryUrl: 'https://www.npmjs.com/package/cors' },
  { key: 'helmet', name: 'Helmet', ecosystem: 'NPM', registryUrl: 'https://www.npmjs.com/package/helmet' },
  { key: 'zod', name: 'Zod', ecosystem: 'NPM', registryUrl: 'https://www.npmjs.com/package/zod' },
  { key: 'prisma', name: 'Prisma CLI', ecosystem: 'NPM', registryUrl: 'https://www.npmjs.com/package/prisma' },
  { key: '@prisma/client', name: 'Prisma Client', ecosystem: 'NPM', registryUrl: 'https://www.npmjs.com/package/@prisma/client' },
  { key: '@simplewebauthn/server', name: 'SimpleWebAuthn Server (passkeys)', ecosystem: 'NPM', registryUrl: 'https://www.npmjs.com/package/@simplewebauthn/server' },
  { key: '@vercel/functions', name: 'Vercel Functions', ecosystem: 'NPM', registryUrl: 'https://www.npmjs.com/package/@vercel/functions' },
  { key: 'web-push', name: 'web-push', ecosystem: 'NPM', registryUrl: 'https://www.npmjs.com/package/web-push' },
  { key: 'react', name: 'React', ecosystem: 'NPM', registryUrl: 'https://www.npmjs.com/package/react' },
  { key: 'react-dom', name: 'React DOM', ecosystem: 'NPM', registryUrl: 'https://www.npmjs.com/package/react-dom' },
  { key: 'vite', name: 'Vite', ecosystem: 'NPM', registryUrl: 'https://www.npmjs.com/package/vite' },
  { key: '@vitejs/plugin-react', name: 'Vite React plugin', ecosystem: 'NPM', registryUrl: 'https://www.npmjs.com/package/@vitejs/plugin-react' },
  { key: 'typescript', name: 'TypeScript', ecosystem: 'NPM', registryUrl: 'https://www.npmjs.com/package/typescript' },
  { key: STACK_AUDIT_PACK_KEY, name: 'Platform stack audit', ecosystem: 'PLATFORM', registryUrl: null },
];

// [platformKey, packKey, installedVersion, sourceNote] — every
// version below was read from the named file on 2026-11-23.
export const INSTALLED_SEEDS = [
  // Service OS API (flagship repo, resolved in the root lockfile)
  ['service-os-api', 'node', '>=20 (engines)', 'apps/api/package.json engines.node — a range, not a resolved runtime'],
  ['service-os-api', 'express', '5.3.0', 'apps/api/package-lock.json (resolved)'],
  ['service-os-api', 'cors', '2.8.6', 'apps/api/package-lock.json (resolved)'],
  ['service-os-api', 'helmet', '8.3.0', 'apps/api/package-lock.json (resolved)'],
  ['service-os-api', 'zod', '4.6.7', 'package-lock.json (resolved, workspace root)'],
  ['service-os-api', 'prisma', '6.19.3', 'package-lock.json (resolved, workspace root)'],
  ['service-os-api', '@prisma/client', '6.19.3', 'package-lock.json (resolved, workspace root)'],
  ['service-os-api', '@simplewebauthn/server', '14.1.0', 'package-lock.json (resolved, workspace root)'],
  ['service-os-api', '@vercel/functions', '3.11.3', 'package-lock.json (resolved, workspace root)'],
  ['service-os-api', 'web-push', '4.0.0', 'package-lock.json (resolved, workspace root)'],
  // Flagship web (apps/web — "latest" ranges in its package.json,
  // resolved in the workspace-root lockfile)
  ['flagship-web', 'node', '>=20 (engines)', 'package.json engines.node (workspace root) — a range, not a resolved runtime'],
  ['flagship-web', 'react', '19.3.1', 'package-lock.json (resolved, workspace root)'],
  ['flagship-web', 'react-dom', '19.3.1', 'package-lock.json (resolved, workspace root)'],
  ['flagship-web', 'vite', '8.3.6', 'package-lock.json (resolved, workspace root)'],
  ['flagship-web', '@vitejs/plugin-react', '6.2.1', 'package-lock.json (resolved, workspace root)'],
  // topspeedappliance.net (its own repo, read from its local clone)
  ['topspeedappliance-net', 'react', '18.3.1', 'Top-Speed-Appliance-Ai repo package-lock.json (resolved)'],
  ['topspeedappliance-net', 'react-dom', '18.3.1', 'Top-Speed-Appliance-Ai repo package-lock.json (resolved)'],
  ['topspeedappliance-net', 'vite', '5.4.21', 'Top-Speed-Appliance-Ai repo package-lock.json (resolved)'],
  ['topspeedappliance-net', '@vitejs/plugin-react', '4.7.0', 'Top-Speed-Appliance-Ai repo package-lock.json (resolved)'],
  // browardapplianceservice.com (its own repo, read from its local clone)
  ['browardapplianceservice-com', 'react', '18.3.1', 'broward-appliance-services repo package-lock.json (resolved)'],
  ['browardapplianceservice-com', 'react-dom', '18.3.1', 'broward-appliance-services repo package-lock.json (resolved)'],
  ['browardapplianceservice-com', 'vite', '5.4.21', 'broward-appliance-services repo package-lock.json (resolved)'],
  ['browardapplianceservice-com', '@vitejs/plugin-react', '4.7.0', 'broward-appliance-services repo package-lock.json (resolved)'],
  ['browardapplianceservice-com', 'typescript', '5.9.3', 'broward-appliance-services repo package-lock.json (resolved)'],
  // totalhomeappliance.com (its own repo, read from its local clone)
  ['totalhomeappliance-com', 'react', '18.3.1', 'Total-Home-Appliance-Repair repo package-lock.json (resolved)'],
  ['totalhomeappliance-com', 'react-dom', '18.3.1', 'Total-Home-Appliance-Repair repo package-lock.json (resolved)'],
  ['totalhomeappliance-com', 'vite', '5.4.21', 'Total-Home-Appliance-Repair repo package-lock.json (resolved)'],
  ['totalhomeappliance-com', '@vitejs/plugin-react', '4.7.0', 'Total-Home-Appliance-Repair repo package-lock.json (resolved)'],
  ['totalhomeappliance-com', 'typescript', '5.9.3', 'Total-Home-Appliance-Repair repo package-lock.json (resolved)'],
];

/** Register the whole seed inventory (idempotent). Used by the
 * deploy-time seed (Phase 6) through the Prisma repo, and by the
 * drills through the in-memory repo. */
export async function seedOsUpdatesRegistry() {
  for (const division of DIVISION_SEEDS) await registerDivision(division);
  for (const platform of OS_PLATFORM_SEEDS) {
    await registerPlatform({ ...platform, divisionKey: PLATFORM_DIVISIONS[platform.key] ?? 'TOP_SPEED_OS' });
  }
  for (const pack of TECH_PACK_SEEDS) await registerTechPack(pack);
  for (const [platformKey, packKey, installedVersion, sourceNote] of INSTALLED_SEEDS) {
    await setInstalledVersion(platformKey, packKey, { installedVersion, sourceNote });
  }
  return {
    divisions: DIVISION_SEEDS.length,
    platforms: OS_PLATFORM_SEEDS.length,
    packs: TECH_PACK_SEEDS.length,
    installed: INSTALLED_SEEDS.length,
  };
}
