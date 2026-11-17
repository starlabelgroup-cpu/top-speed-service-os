import { createId } from '../data/store.js';
import { DATABASE_ENABLED, db } from './client.js';

/**
 * Pepper Lists Channel Connections — repository (2026-11-17, Phase 1).
 *
 * Same dual-mode discipline as the Advertiser Console's ChannelLink
 * repo (routes/marketing.js): Prisma when DATABASE_URL is set, an
 * in-memory fallback with identical shapes when it is not.
 *
 * Phase 1 invariants enforced here:
 *  - a connect request moves a row to PENDING — nothing in Phase 1
 *    ever writes CONNECTED (no completed third-party flow exists
 *    yet), so no code path can invent a connection;
 *  - disconnect clears the account label, the connected timestamp
 *    and the agent grant along with the status;
 *  - every mutation writes a SellerChannelAudit row in the same call.
 */

const AUDIT = {
  CONNECT_REQUESTED: 'CONNECT_REQUESTED',
  DISCONNECTED: 'DISCONNECTED',
  AGENT_ACCESS_GRANTED: 'AGENT_ACCESS_GRANTED',
  AGENT_ACCESS_REVOKED: 'AGENT_ACCESS_REVOKED',
  STATUS_CHANGED: 'STATUS_CHANGED',
};

export const SELLER_CHANNEL_AUDIT = AUDIT;

const memoryConnections = [];
const memoryAudit = [];

function memoryEnsure(userId, channel, kind) {
  let row = memoryConnections.find((c) => c.userId === userId && c.channel === channel);
  if (!row) {
    const now = new Date().toISOString();
    row = {
      id: createId(), userId, channel, kind,
      status: 'NOT_CONNECTED', externalAccountLabel: null,
      agentAccessGranted: false, connectedAt: null, lastSyncAt: null,
      meta: null, createdAt: now, updatedAt: now,
    };
    memoryConnections.push(row);
  }
  return row;
}

function memoryWriteAudit(connectionId, userId, action, detail) {
  memoryAudit.push({
    id: createId(), connectionId, userId, action,
    detail: detail ?? null, createdAt: new Date().toISOString(),
  });
}

const prismaRepo = {
  async listForUser(userId) {
    return db().sellerChannelConnection.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
  },
  async ensure(userId, channel, kind) {
    return db().sellerChannelConnection.upsert({
      where: { userId_channel: { userId, channel } },
      create: { userId, channel, kind },
      update: {},
    });
  },
  async writeAudit(connectionId, userId, action, detail) {
    return db().sellerChannelAudit.create({
      data: { connectionId, userId, action, detail: detail ?? null },
    });
  },
  async requestConnect(userId, channel, kind, accountLabel) {
    const existing = await this.ensure(userId, channel, kind);
    const row = existing.status === 'CONNECTED'
      ? existing
      : await db().sellerChannelConnection.update({
          where: { id: existing.id },
          data: {
            status: 'PENDING',
            externalAccountLabel: accountLabel ?? existing.externalAccountLabel,
          },
        });
    await this.writeAudit(row.id, userId, AUDIT.CONNECT_REQUESTED,
      accountLabel ? `Account reference: ${accountLabel}` : 'Connection requested');
    return row;
  },
  async disconnect(userId, channel, kind) {
    const existing = await this.ensure(userId, channel, kind);
    const row = await db().sellerChannelConnection.update({
      where: { id: existing.id },
      data: {
        status: 'NOT_CONNECTED',
        externalAccountLabel: null,
        agentAccessGranted: false,
        connectedAt: null,
        lastSyncAt: null,
      },
    });
    await this.writeAudit(row.id, userId, AUDIT.DISCONNECTED, 'Seller disconnected this channel');
    return row;
  },
  async setAgentAccess(userId, channel, kind, granted) {
    const existing = await this.ensure(userId, channel, kind);
    const row = await db().sellerChannelConnection.update({
      where: { id: existing.id },
      data: { agentAccessGranted: granted },
    });
    await this.writeAudit(row.id, userId,
      granted ? AUDIT.AGENT_ACCESS_GRANTED : AUDIT.AGENT_ACCESS_REVOKED,
      granted ? 'Seller granted the Pepper Lists agent access to this channel' : 'Seller revoked the Pepper Lists agent access to this channel');
    return row;
  },
  async listAll() {
    return db().sellerChannelConnection.findMany({
      orderBy: { updatedAt: 'desc' },
      take: 500,
      include: { user: { select: { email: true, firstName: true, lastName: true, roles: true } } },
    });
  },
  async listRecentAudit(limit = 100) {
    return db().sellerChannelAudit.findMany({ orderBy: { createdAt: 'desc' }, take: limit });
  },
  async listAuditForConnection(connectionId) {
    return db().sellerChannelAudit.findMany({
      where: { connectionId }, orderBy: { createdAt: 'asc' },
    });
  },
};

const memoryRepo = {
  async listForUser(userId) {
    return memoryConnections.filter((c) => c.userId === userId);
  },
  async ensure(userId, channel, kind) {
    return memoryEnsure(userId, channel, kind);
  },
  async writeAudit(connectionId, userId, action, detail) {
    memoryWriteAudit(connectionId, userId, action, detail);
    return null;
  },
  async requestConnect(userId, channel, kind, accountLabel) {
    const row = memoryEnsure(userId, channel, kind);
    if (row.status !== 'CONNECTED') {
      row.status = 'PENDING';
      if (accountLabel) row.externalAccountLabel = accountLabel;
      row.updatedAt = new Date().toISOString();
    }
    memoryWriteAudit(row.id, userId, AUDIT.CONNECT_REQUESTED,
      accountLabel ? `Account reference: ${accountLabel}` : 'Connection requested');
    return row;
  },
  async disconnect(userId, channel, kind) {
    const row = memoryEnsure(userId, channel, kind);
    row.status = 'NOT_CONNECTED';
    row.externalAccountLabel = null;
    row.agentAccessGranted = false;
    row.connectedAt = null;
    row.lastSyncAt = null;
    row.updatedAt = new Date().toISOString();
    memoryWriteAudit(row.id, userId, AUDIT.DISCONNECTED, 'Seller disconnected this channel');
    return row;
  },
  async setAgentAccess(userId, channel, kind, granted) {
    const row = memoryEnsure(userId, channel, kind);
    row.agentAccessGranted = granted;
    row.updatedAt = new Date().toISOString();
    memoryWriteAudit(row.id, userId,
      granted ? AUDIT.AGENT_ACCESS_GRANTED : AUDIT.AGENT_ACCESS_REVOKED,
      granted ? 'Seller granted the Pepper Lists agent access to this channel' : 'Seller revoked the Pepper Lists agent access to this channel');
    return row;
  },
  async listAll() {
    return [...memoryConnections].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  },
  async listRecentAudit(limit = 100) {
    return [...memoryAudit].reverse().slice(0, limit);
  },
  async listAuditForConnection(connectionId) {
    return memoryAudit.filter((a) => a.connectionId === connectionId);
  },
};

export const sellerChannelsRepo = DATABASE_ENABLED ? prismaRepo : memoryRepo;
