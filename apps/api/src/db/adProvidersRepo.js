import { createId } from '../data/store.js';
import { DATABASE_ENABLED, db } from './client.js';

/**
 * AdStream Providers — repository (2026-11-18, Phase 1).
 *
 * The platform-level counterpart of the Pepper Lists seller-channel
 * repo (db/sellerChannelsRepo.js), with the same dual-mode discipline:
 * Prisma when DATABASE_URL is set, an in-memory fallback with
 * identical shapes when it is not.
 *
 * Scope difference, by design: seller channels belong to a seller
 * account (one row per user + channel); ad-serving providers belong
 * to the PLATFORM (one row per provider, full stop) because they
 * serve Top Speed's own ad stack. Ad Studio staff manage the rows;
 * the acting staff member is recorded on every audit entry.
 *
 * Phase 1 invariants enforced here:
 *  - a connect request moves the row to PENDING — nothing in Phase 1
 *    ever writes CONNECTED (no completed provider flow exists yet),
 *    so no code path can invent a connection;
 *  - disconnect clears the account label and the connected/sync
 *    timestamps along with the status;
 *  - every mutation writes an AdProviderAudit row in the same call.
 */

const AUDIT = {
  CONNECT_REQUESTED: 'CONNECT_REQUESTED',
  DISCONNECTED: 'DISCONNECTED',
  STATUS_CHANGED: 'STATUS_CHANGED',
};

export const AD_PROVIDER_AUDIT = AUDIT;

const memoryConnections = [];
const memoryAudit = [];

function memoryEnsure(provider) {
  let row = memoryConnections.find((c) => c.provider === provider);
  if (!row) {
    const now = new Date().toISOString();
    row = {
      id: createId(), provider,
      status: 'NOT_CONNECTED', externalAccountLabel: null,
      connectedAt: null, lastSyncAt: null,
      meta: null, createdAt: now, updatedAt: now,
    };
    memoryConnections.push(row);
  }
  return row;
}

function memoryWriteAudit(connectionId, actorUserId, action, detail) {
  memoryAudit.push({
    id: createId(), connectionId, actorUserId, action,
    detail: detail ?? null, createdAt: new Date().toISOString(),
    actor: null, connection: null,
  });
}

const prismaRepo = {
  async listConnections() {
    return db().adProviderConnection.findMany({ orderBy: { createdAt: 'asc' } });
  },
  async ensure(provider) {
    return db().adProviderConnection.upsert({
      where: { provider },
      create: { provider },
      update: {},
    });
  },
  async writeAudit(connectionId, actorUserId, action, detail) {
    return db().adProviderAudit.create({
      data: { connectionId, actorUserId: actorUserId ?? null, action, detail: detail ?? null },
    });
  },
  async requestConnect(provider, accountLabel, actorUserId) {
    const existing = await this.ensure(provider);
    const row = existing.status === 'CONNECTED'
      ? existing
      : await db().adProviderConnection.update({
          where: { id: existing.id },
          data: {
            status: 'PENDING',
            externalAccountLabel: accountLabel ?? existing.externalAccountLabel,
          },
        });
    await this.writeAudit(row.id, actorUserId, AUDIT.CONNECT_REQUESTED,
      accountLabel ? `Account reference: ${accountLabel}` : 'Connection requested');
    return row;
  },
  async disconnect(provider, actorUserId) {
    const existing = await this.ensure(provider);
    const row = await db().adProviderConnection.update({
      where: { id: existing.id },
      data: {
        status: 'NOT_CONNECTED',
        externalAccountLabel: null,
        connectedAt: null,
        lastSyncAt: null,
      },
    });
    await this.writeAudit(row.id, actorUserId, AUDIT.DISCONNECTED, 'Provider disconnected from Ad Studio');
    return row;
  },
  async listRecentAudit(limit = 100) {
    return db().adProviderAudit.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        actor: { select: { email: true, firstName: true, lastName: true, roles: true } },
        connection: { select: { provider: true } },
      },
    });
  },
  async listAuditForConnection(connectionId) {
    return db().adProviderAudit.findMany({
      where: { connectionId }, orderBy: { createdAt: 'asc' },
    });
  },
};

const memoryRepo = {
  async listConnections() {
    return [...memoryConnections];
  },
  async ensure(provider) {
    return memoryEnsure(provider);
  },
  async writeAudit(connectionId, actorUserId, action, detail) {
    memoryWriteAudit(connectionId, actorUserId, action, detail);
    return null;
  },
  async requestConnect(provider, accountLabel, actorUserId) {
    const row = memoryEnsure(provider);
    if (row.status !== 'CONNECTED') {
      row.status = 'PENDING';
      if (accountLabel) row.externalAccountLabel = accountLabel;
      row.updatedAt = new Date().toISOString();
    }
    memoryWriteAudit(row.id, actorUserId, AUDIT.CONNECT_REQUESTED,
      accountLabel ? `Account reference: ${accountLabel}` : 'Connection requested');
    return row;
  },
  async disconnect(provider, actorUserId) {
    const row = memoryEnsure(provider);
    row.status = 'NOT_CONNECTED';
    row.externalAccountLabel = null;
    row.connectedAt = null;
    row.lastSyncAt = null;
    row.updatedAt = new Date().toISOString();
    memoryWriteAudit(row.id, actorUserId, AUDIT.DISCONNECTED, 'Provider disconnected from Ad Studio');
    return row;
  },
  async listRecentAudit(limit = 100) {
    const byId = new Map(memoryConnections.map((c) => [c.id, c]));
    return [...memoryAudit].reverse().slice(0, limit).map((entry) => ({
      ...entry,
      connection: byId.get(entry.connectionId)
        ? { provider: byId.get(entry.connectionId).provider }
        : null,
    }));
  },
  async listAuditForConnection(connectionId) {
    return memoryAudit.filter((a) => a.connectionId === connectionId);
  },
};

export const adProvidersRepo = DATABASE_ENABLED ? prismaRepo : memoryRepo;
