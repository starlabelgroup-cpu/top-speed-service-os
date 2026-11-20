import { createId } from '../data/store.js';
import { DATABASE_ENABLED, db } from './client.js';

/**
 * Connect Pro — PM Portfolio repository (2026-11-20, recommendations
 * B5 + B6). Same dual-mode discipline as pepperListsCrossPostsRepo:
 * Prisma when DATABASE_URL is set, an in-memory fallback with
 * identical shapes when it is not.
 *
 * Invariants enforced here and in routes/pmPortfolio.js:
 *  - every row carries ownerId (the PM's User id); reads are always
 *    owner-scoped — a PM can never see another PM's portfolio;
 *  - tenant link tokens and tenant status tokens exist ONLY as
 *    SHA-256 hashes (tokenHash / statusTokenHash) — the raw values
 *    are shown once, at creation, and never stored;
 *  - a TENANT_LINK request is born PENDING_APPROVAL and gains its
 *    connectionId / bookingId only when the PM approves it (the
 *    route performs that hand-off into the universal intake); this
 *    repo never creates bookings or connections itself.
 */

const memory = {
  properties: [],
  units: [],
  tenantLinks: [],
  requests: [],
};

function iso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function propertyOut(row) {
  if (!row) return null;
  return { ...row, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) };
}

function unitOut(row) {
  if (!row) return null;
  return { ...row, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) };
}

function linkOut(row) {
  if (!row) return null;
  const { tokenHash, ...rest } = row;
  return { ...rest, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt), lastUsedAt: iso(row.lastUsedAt) };
}

function requestOut(row) {
  if (!row) return null;
  const { statusTokenHash, ...rest } = row;
  return { ...rest, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt), decidedAt: iso(row.decidedAt) };
}

/* ------------------------------ properties ------------------------------ */

export async function createProperty({ companyId, ownerId, name, address, city, zip }) {
  const data = { id: createId(), companyId, ownerId, name, address, city, zip };
  if (!DATABASE_ENABLED) {
    const row = { ...data, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    memory.properties.push(row);
    return propertyOut(row);
  }
  return propertyOut(await db().pmProperty.create({ data }));
}

export async function listProperties(ownerId) {
  if (!DATABASE_ENABLED) {
    return memory.properties.filter((p) => p.ownerId === ownerId).map(propertyOut);
  }
  const rows = await db().pmProperty.findMany({ where: { ownerId }, orderBy: { createdAt: 'asc' } });
  return rows.map(propertyOut);
}

export async function getProperty(ownerId, id) {
  if (!DATABASE_ENABLED) {
    return propertyOut(memory.properties.find((p) => p.id === id && p.ownerId === ownerId) || null);
  }
  return propertyOut(await db().pmProperty.findFirst({ where: { id, ownerId } }));
}

/* --------------------------------- units -------------------------------- */

export async function createUnit({ companyId, ownerId, propertyId, label, tenantName, tenantPhone, tenantEmail }) {
  const data = {
    id: createId(),
    companyId,
    ownerId,
    propertyId,
    label,
    tenantName: tenantName || null,
    tenantPhone: tenantPhone || null,
    tenantEmail: tenantEmail || null,
  };
  if (!DATABASE_ENABLED) {
    const row = { ...data, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    memory.units.push(row);
    return unitOut(row);
  }
  return unitOut(await db().pmUnit.create({ data }));
}

export async function listUnits(propertyId) {
  if (!DATABASE_ENABLED) {
    return memory.units.filter((u) => u.propertyId === propertyId).map(unitOut);
  }
  const rows = await db().pmUnit.findMany({ where: { propertyId }, orderBy: { createdAt: 'asc' } });
  return rows.map(unitOut);
}

export async function getUnit(id) {
  if (!DATABASE_ENABLED) {
    return unitOut(memory.units.find((u) => u.id === id) || null);
  }
  return unitOut(await db().pmUnit.findUnique({ where: { id } }));
}

/* ------------------------------ tenant links ----------------------------- */

export async function rotateTenantLink({ companyId, ownerId, propertyId, tokenHash }) {
  const now = new Date();
  if (!DATABASE_ENABLED) {
    let row = memory.tenantLinks.find((l) => l.propertyId === propertyId);
    if (row) {
      row.tokenHash = tokenHash;
      row.status = 'ACTIVE';
      row.updatedAt = now.toISOString();
    } else {
      row = {
        id: createId(), companyId, ownerId, propertyId, tokenHash,
        status: 'ACTIVE', lastUsedAt: null,
        createdAt: now.toISOString(), updatedAt: now.toISOString(),
      };
      memory.tenantLinks.push(row);
    }
    return linkOut(row);
  }
  const existing = await db().pmTenantLink.findUnique({ where: { propertyId } });
  if (existing) {
    const row = await db().pmTenantLink.update({
      where: { propertyId },
      data: { tokenHash, status: 'ACTIVE', updatedAt: now },
    });
    return linkOut(row);
  }
  const row = await db().pmTenantLink.create({
    data: { companyId, ownerId, propertyId, tokenHash, status: 'ACTIVE' },
  });
  return linkOut(row);
}

export async function getTenantLinkByProperty(propertyId) {
  if (!DATABASE_ENABLED) {
    return linkOut(memory.tenantLinks.find((l) => l.propertyId === propertyId) || null);
  }
  return linkOut(await db().pmTenantLink.findUnique({ where: { propertyId } }));
}

export async function findTenantLinkByHash(tokenHash) {
  if (!DATABASE_ENABLED) {
    const row = memory.tenantLinks.find((l) => l.tokenHash === tokenHash) || null;
    return row ? { ...linkOut(row), tokenHash: row.tokenHash } : null;
  }
  const row = await db().pmTenantLink.findUnique({ where: { tokenHash } });
  return row ? { ...linkOut(row), tokenHash: row.tokenHash } : null;
}

export async function setTenantLinkStatus(propertyId, status) {
  if (!DATABASE_ENABLED) {
    const row = memory.tenantLinks.find((l) => l.propertyId === propertyId);
    if (!row) return null;
    row.status = status;
    row.updatedAt = new Date().toISOString();
    return linkOut(row);
  }
  const row = await db().pmTenantLink.update({ where: { propertyId }, data: { status } });
  return linkOut(row);
}

export async function touchTenantLink(id) {
  const now = new Date();
  if (!DATABASE_ENABLED) {
    const row = memory.tenantLinks.find((l) => l.id === id);
    if (row) row.lastUsedAt = now.toISOString();
    return;
  }
  await db().pmTenantLink.update({ where: { id }, data: { lastUsedAt: now } }).catch(() => {});
}

/* ------------------------------- requests -------------------------------- */

export async function createRequest(data) {
  const row = { id: createId(), ...data };
  if (!DATABASE_ENABLED) {
    const stored = { ...row, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), decidedAt: row.decidedAt || null };
    memory.requests.push(stored);
    return requestOut(stored);
  }
  return requestOut(await db().pmServiceRequest.create({ data: row }));
}

export async function getRequest(ownerId, id) {
  if (!DATABASE_ENABLED) {
    return requestOut(memory.requests.find((r) => r.id === id && r.ownerId === ownerId) || null);
  }
  return requestOut(await db().pmServiceRequest.findFirst({ where: { id, ownerId } }));
}

export async function listRequests(ownerId, { status = null, propertyId = null, unitId = null } = {}) {
  const match = (r) =>
    r.ownerId === ownerId &&
    (!status || r.status === status) &&
    (!propertyId || r.propertyId === propertyId) &&
    (!unitId || r.unitId === unitId);
  if (!DATABASE_ENABLED) {
    return memory.requests.filter(match).map(requestOut).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  const rows = await db().pmServiceRequest.findMany({
    where: {
      ownerId,
      ...(status ? { status } : {}),
      ...(propertyId ? { propertyId } : {}),
      ...(unitId ? { unitId } : {}),
    },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(requestOut);
}

export async function findRequestByStatusHash(statusTokenHash) {
  if (!DATABASE_ENABLED) {
    return requestOut(memory.requests.find((r) => r.statusTokenHash === statusTokenHash) || null);
  }
  return requestOut(await db().pmServiceRequest.findUnique({ where: { statusTokenHash } }));
}

export async function updateRequest(id, patch) {
  if (!DATABASE_ENABLED) {
    const row = memory.requests.find((r) => r.id === id);
    if (!row) return null;
    Object.assign(row, patch, { updatedAt: new Date().toISOString() });
    return requestOut(row);
  }
  const row = await db().pmServiceRequest.update({ where: { id }, data: patch });
  return requestOut(row);
}
