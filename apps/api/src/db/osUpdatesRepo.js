import { createId } from '../data/store.js';
import { DATABASE_ENABLED, db } from './client.js';

/**
 * OS Systems Updating System repository (2026-11-23). Same
 * dual-mode discipline as campaignEngineRepo / facebookOsRepo:
 * Prisma when DATABASE_URL is set, an in-memory fallback with
 * identical shapes when it is not.
 *
 * Invariants enforced here:
 *  - platform keys, pack keys and cycle keys are unique, and a
 *    (platform, pack) pair and a (cycle, platform, pack) task are
 *    unique — every registration and cycle-open is idempotent by
 *    construction;
 *  - an UpdateTask is BORN PENDING (update) or PLANNED (verify) —
 *    createTasks accepts only those two; the working states
 *    (APPLIED / VERIFIED / SKIPPED / BLOCKED) are reachable only
 *    through the status transition door in the service.
 */

function iso(value) {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function platformFromDb(row) {
  if (!row) return null;
  return { ...row, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) };
}

function divisionFromDb(row) {
  if (!row) return null;
  return { ...row, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) };
}

function packFromDb(row) {
  if (!row) return null;
  return {
    ...row,
    latestCheckedAt: iso(row.latestCheckedAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function linkFromDb(row) {
  if (!row) return null;
  return { ...row, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) };
}

function cycleFromDb(row) {
  if (!row) return null;
  return {
    ...row,
    openedAt: iso(row.openedAt),
    dueAt: iso(row.dueAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function taskFromDb(row) {
  if (!row) return null;
  return {
    ...row,
    appliedAt: iso(row.appliedAt),
    verifiedAt: iso(row.verifiedAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

const TASK_BORN_STATUSES = ['PENDING', 'PLANNED'];

function pick(source, fields) {
  const out = {};
  for (const field of fields) {
    if (source[field] !== undefined) out[field] = source[field];
  }
  return out;
}

// ─── Prisma mode ──────────────────────────────────────────────────

const prismaRepo = {
  async upsertDivision(data) {
    const row = await db().division.upsert({
      where: { key: data.key },
      update: pick(data, ['name', 'role', 'parentKey', 'description', 'homeUrl', 'sortOrder']),
      create: {
        key: data.key,
        name: data.name,
        role: data.role,
        parentKey: data.parentKey ?? null,
        description: data.description ?? null,
        homeUrl: data.homeUrl ?? null,
        sortOrder: data.sortOrder ?? 0,
      },
    });
    return divisionFromDb(row);
  },
  async listDivisions() {
    const rows = await db().division.findMany({ orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }] });
    return rows.map(divisionFromDb);
  },
  async upsertPlatform(data) {
    const row = await db().osPlatform.upsert({
      where: { key: data.key },
      update: pick(data, ['name', 'kind', 'divisionKey', 'surface', 'ownerNote', 'active']),
      create: {
        key: data.key,
        name: data.name,
        kind: data.kind,
        divisionKey: data.divisionKey ?? 'TOP_SPEED_OS',
        surface: data.surface ?? null,
        ownerNote: data.ownerNote ?? null,
        active: data.active ?? true,
      },
    });
    return platformFromDb(row);
  },
  async listPlatforms() {
    const rows = await db().osPlatform.findMany({ orderBy: { key: 'asc' } });
    return rows.map(platformFromDb);
  },
  async findPlatformByKey(key) {
    return platformFromDb(await db().osPlatform.findUnique({ where: { key } }));
  },
  async upsertPack(data) {
    const row = await db().techPack.upsert({
      where: { key: data.key },
      update: pick(data, ['name', 'ecosystem', 'registryUrl']),
      create: {
        key: data.key,
        name: data.name,
        ecosystem: data.ecosystem,
        registryUrl: data.registryUrl ?? null,
      },
    });
    return packFromDb(row);
  },
  async listPacks() {
    const rows = await db().techPack.findMany({ orderBy: { key: 'asc' } });
    return rows.map(packFromDb);
  },
  async findPackByKey(key) {
    return packFromDb(await db().techPack.findUnique({ where: { key } }));
  },
  async updatePackLatest(id, data) {
    const row = await db().techPack.update({
      where: { id },
      data: pick(data, ['currentLatestVersion', 'latestCheckedAt', 'latestNote']),
    });
    return packFromDb(row);
  },
  async setInstalled(platformId, techPackId, data) {
    const row = await db().platformTechPack.upsert({
      where: { platformId_techPackId: { platformId, techPackId } },
      update: pick(data, ['installedVersion', 'sourceNote']),
      create: {
        platformId,
        techPackId,
        installedVersion: data.installedVersion,
        sourceNote: data.sourceNote ?? null,
      },
    });
    return linkFromDb(row);
  },
  async listInstalled() {
    const rows = await db().platformTechPack.findMany({
      orderBy: [{ platformId: 'asc' }, { techPackId: 'asc' }],
    });
    return rows.map(linkFromDb);
  },
  async findCycleByKey(key) {
    return cycleFromDb(await db().updateCycle.findUnique({ where: { key } }));
  },
  async createCycle(data) {
    const existing = await db().updateCycle.findUnique({ where: { key: data.key } });
    if (existing) return cycleFromDb(existing);
    return cycleFromDb(await db().updateCycle.create({
      data: {
        key: data.key,
        openedAt: data.openedAt ? new Date(data.openedAt) : undefined,
        dueAt: new Date(data.dueAt),
        status: 'OPEN',
        note: data.note ?? null,
      },
    }));
  },
  async listCycles() {
    const rows = await db().updateCycle.findMany({ orderBy: { openedAt: 'desc' } });
    return rows.map(cycleFromDb);
  },
  async createTasks(tasks) {
    let created = 0;
    for (const task of tasks) {
      const existing = await db().updateTask.findUnique({
        where: {
          cycleId_platformId_techPackId: {
            cycleId: task.cycleId, platformId: task.platformId, techPackId: task.techPackId,
          },
        },
        select: { id: true },
      });
      if (existing) continue;
      await db().updateTask.create({
        data: {
          cycleId: task.cycleId,
          platformId: task.platformId,
          techPackId: task.techPackId,
          kind: task.kind,
          drift: task.drift,
          fromVersion: task.fromVersion ?? null,
          toVersion: task.toVersion ?? null,
          status: TASK_BORN_STATUSES.includes(task.status) ? task.status : 'PENDING',
          note: task.note ?? null,
        },
      });
      created += 1;
    }
    return created;
  },
  async listTasks(cycleId) {
    const where = cycleId ? { cycleId } : {};
    const rows = await db().updateTask.findMany({ where, orderBy: { createdAt: 'asc' } });
    return rows.map(taskFromDb);
  },
  async findTaskById(id) {
    return taskFromDb(await db().updateTask.findUnique({ where: { id } }));
  },
  async updateTask(id, data) {
    const row = await db().updateTask.update({
      where: { id },
      data: pick(data, ['status', 'note', 'appliedAt', 'verifiedAt']),
    });
    return taskFromDb(row);
  },
};

// ─── In-memory mode ───────────────────────────────────────────────

const memoryDivisions = [];
const memoryPlatforms = [];
const memoryPacks = [];
const memoryInstalled = [];
const memoryCycles = [];
const memoryTasks = [];

const memoryRepo = {
  async upsertDivision(data) {
    const existing = memoryDivisions.find((d) => d.key === data.key);
    const now = new Date().toISOString();
    if (existing) {
      Object.assign(existing, pick(data, ['name', 'role', 'parentKey', 'description', 'homeUrl', 'sortOrder']), { updatedAt: now });
      return existing;
    }
    const row = {
      id: createId(),
      key: data.key,
      name: data.name,
      role: data.role,
      parentKey: data.parentKey ?? null,
      description: data.description ?? null,
      homeUrl: data.homeUrl ?? null,
      sortOrder: data.sortOrder ?? 0,
      createdAt: now,
      updatedAt: now,
    };
    memoryDivisions.push(row);
    return row;
  },
  async listDivisions() {
    return [...memoryDivisions].sort((a, b) => (a.sortOrder - b.sortOrder) || a.key.localeCompare(b.key));
  },
  async upsertPlatform(data) {
    const existing = memoryPlatforms.find((p) => p.key === data.key);
    const now = new Date().toISOString();
    if (existing) {
      Object.assign(existing, pick(data, ['name', 'kind', 'divisionKey', 'surface', 'ownerNote', 'active']), { updatedAt: now });
      return existing;
    }
    const row = {
      id: createId(),
      key: data.key,
      name: data.name,
      kind: data.kind,
      divisionKey: data.divisionKey ?? 'TOP_SPEED_OS',
      surface: data.surface ?? null,
      ownerNote: data.ownerNote ?? null,
      active: data.active ?? true,
      createdAt: now,
      updatedAt: now,
    };
    memoryPlatforms.push(row);
    return row;
  },
  async listPlatforms() {
    return [...memoryPlatforms].sort((a, b) => a.key.localeCompare(b.key));
  },
  async findPlatformByKey(key) {
    return memoryPlatforms.find((p) => p.key === key) || null;
  },
  async upsertPack(data) {
    const existing = memoryPacks.find((p) => p.key === data.key);
    const now = new Date().toISOString();
    if (existing) {
      Object.assign(existing, pick(data, ['name', 'ecosystem', 'registryUrl']), { updatedAt: now });
      return existing;
    }
    const row = {
      id: createId(),
      key: data.key,
      name: data.name,
      ecosystem: data.ecosystem,
      registryUrl: data.registryUrl ?? null,
      currentLatestVersion: null,
      latestCheckedAt: null,
      latestNote: null,
      createdAt: now,
      updatedAt: now,
    };
    memoryPacks.push(row);
    return row;
  },
  async listPacks() {
    return [...memoryPacks].sort((a, b) => a.key.localeCompare(b.key));
  },
  async findPackByKey(key) {
    return memoryPacks.find((p) => p.key === key) || null;
  },
  async updatePackLatest(id, data) {
    const row = memoryPacks.find((p) => p.id === id);
    if (!row) return null;
    Object.assign(row, pick(data, ['currentLatestVersion', 'latestCheckedAt', 'latestNote']), { updatedAt: new Date().toISOString() });
    return row;
  },
  async setInstalled(platformId, techPackId, data) {
    const existing = memoryInstalled.find((r) => r.platformId === platformId && r.techPackId === techPackId);
    const now = new Date().toISOString();
    if (existing) {
      Object.assign(existing, pick(data, ['installedVersion', 'sourceNote']), { updatedAt: now });
      return existing;
    }
    const row = {
      id: createId(),
      platformId,
      techPackId,
      installedVersion: data.installedVersion,
      sourceNote: data.sourceNote ?? null,
      createdAt: now,
      updatedAt: now,
    };
    memoryInstalled.push(row);
    return row;
  },
  async listInstalled() {
    return [...memoryInstalled];
  },
  async findCycleByKey(key) {
    return memoryCycles.find((c) => c.key === key) || null;
  },
  async createCycle(data) {
    const existing = memoryCycles.find((c) => c.key === data.key);
    if (existing) return existing;
    const now = new Date().toISOString();
    const row = {
      id: createId(),
      key: data.key,
      openedAt: data.openedAt ? new Date(data.openedAt).toISOString() : now,
      dueAt: new Date(data.dueAt).toISOString(),
      status: 'OPEN',
      note: data.note ?? null,
      createdAt: now,
      updatedAt: now,
    };
    memoryCycles.push(row);
    return row;
  },
  async listCycles() {
    return [...memoryCycles].sort((a, b) => String(b.openedAt).localeCompare(String(a.openedAt)));
  },
  async createTasks(tasks) {
    let created = 0;
    for (const task of tasks) {
      const dupe = memoryTasks.some(
        (t) => t.cycleId === task.cycleId && t.platformId === task.platformId && t.techPackId === task.techPackId,
      );
      if (dupe) continue;
      const now = new Date().toISOString();
      memoryTasks.push({
        id: createId(),
        cycleId: task.cycleId,
        platformId: task.platformId,
        techPackId: task.techPackId,
        kind: task.kind,
        drift: task.drift,
        fromVersion: task.fromVersion ?? null,
        toVersion: task.toVersion ?? null,
        status: TASK_BORN_STATUSES.includes(task.status) ? task.status : 'PENDING',
        note: task.note ?? null,
        appliedAt: null,
        verifiedAt: null,
        createdAt: now,
        updatedAt: now,
      });
      created += 1;
    }
    return created;
  },
  async listTasks(cycleId) {
    return memoryTasks.filter((t) => !cycleId || t.cycleId === cycleId);
  },
  async findTaskById(id) {
    return memoryTasks.find((t) => t.id === id) || null;
  },
  async updateTask(id, data) {
    const row = memoryTasks.find((t) => t.id === id);
    if (!row) return null;
    Object.assign(row, pick(data, ['status', 'note', 'appliedAt', 'verifiedAt']), { updatedAt: new Date().toISOString() });
    return row;
  },
};

export const osUpdatesRepo = DATABASE_ENABLED ? prismaRepo : memoryRepo;
