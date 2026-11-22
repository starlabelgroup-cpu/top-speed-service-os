import { createId } from '../data/store.js';
import { PL_DB_AVAILABLE, plDb } from './plClient.js';

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
  // Phase 2 (2026-11-21): the office-fulfillment lifecycle and the
  // agent-action log the seller page copy promises ("every agent
  // action on your channels is logged on your account").
  OFFICE_STARTED: 'OFFICE_STARTED',
  OFFICE_FULFILLED: 'OFFICE_FULFILLED',
  OFFICE_DECLINED: 'OFFICE_DECLINED',
  AGENT_ACTION: 'AGENT_ACTION',
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
    return plDb().sellerChannelConnection.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
  },
  async ensure(userId, channel, kind) {
    return plDb().sellerChannelConnection.upsert({
      where: { userId_channel: { userId, channel } },
      create: { userId, channel, kind },
      update: {},
    });
  },
  async writeAudit(connectionId, userId, action, detail) {
    return plDb().sellerChannelAudit.create({
      data: { connectionId, userId, action, detail: detail ?? null },
    });
  },
  async requestConnect(userId, channel, kind, accountLabel) {
    const existing = await this.ensure(userId, channel, kind);
    const meta = { ...(existing.meta && typeof existing.meta === 'object' ? existing.meta : {}) };
    delete meta.fulfillment;
    const row = existing.status === 'CONNECTED'
      ? existing
      : await plDb().sellerChannelConnection.update({
          where: { id: existing.id },
          data: {
            status: 'PENDING',
            externalAccountLabel: accountLabel ?? existing.externalAccountLabel,
            meta,
          },
        });
    await this.writeAudit(row.id, userId, AUDIT.CONNECT_REQUESTED,
      accountLabel ? `Account reference: ${accountLabel}` : 'Connection requested');
    return row;
  },
  async disconnect(userId, channel, kind) {
    const existing = await this.ensure(userId, channel, kind);
    const row = await plDb().sellerChannelConnection.update({
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
    const row = await plDb().sellerChannelConnection.update({
      where: { id: existing.id },
      data: { agentAccessGranted: granted },
    });
    await this.writeAudit(row.id, userId,
      granted ? AUDIT.AGENT_ACCESS_GRANTED : AUDIT.AGENT_ACCESS_REVOKED,
      granted ? 'Seller granted the Pepper Lists agent access to this channel' : 'Seller revoked the Pepper Lists agent access to this channel');
    return row;
  },
  // Phase 2 syndication support (2026-11-20, C16): read a seller's
  // row for one channel WITHOUT creating it (the syndication gate
  // must distinguish "no request on file" from a filed request),
  // list a channel's rows (the Google Shopping feed-token lookup),
  // and merge non-secret context into `meta` (the feed token's HASH
  // — the raw token is shown to the seller once and never stored).
  async findForUserChannel(userId, channel) {
    return plDb().sellerChannelConnection.findUnique({
      where: { userId_channel: { userId, channel } },
    });
  },
  async listByChannel(channel) {
    return plDb().sellerChannelConnection.findMany({ where: { channel } });
  },
  async setMeta(userId, channel, kind, metaPatch) {
    const existing = await this.ensure(userId, channel, kind);
    const meta = { ...(existing.meta && typeof existing.meta === 'object' ? existing.meta : {}), ...metaPatch };
    return plDb().sellerChannelConnection.update({
      where: { id: existing.id },
      data: { meta },
    });
  },
  async listAll() {
    // No `user` include: in the Pepper Lists database there is no
    // User table (accounts stay in the main database) — the route
    // resolves seller identity through the app layer.
    return plDb().sellerChannelConnection.findMany({
      orderBy: { updatedAt: 'desc' },
      take: 500,
    });
  },
  async findById(id) {
    return plDb().sellerChannelConnection.findUnique({ where: { id } });
  },
  // Phase 2: the office-fulfillment lifecycle. `transition` moves a
  // PENDING / IN_PROGRESS request to IN_PROGRESS, ACTIVE (with the
  // real evidence URL recorded in meta.fulfillment) or DECLINED
  // (with the reason). The route layer enforces the grant gate and
  // the per-action rules; this only performs legal moves and audits
  // each one in the same call.
  async transition(id, action, { url, reason, byId } = {}) {
    const existing = await plDb().sellerChannelConnection.findUnique({ where: { id } });
    if (!existing) return { row: null, conflict: false };
    const from = existing.status;
    const legal =
      (action === 'start' && from === 'PENDING') ||
      (action === 'fulfill' && (from === 'PENDING' || from === 'IN_PROGRESS')) ||
      (action === 'decline' && (from === 'PENDING' || from === 'IN_PROGRESS'));
    if (!legal) return { row: existing, conflict: true };
    const meta = { ...(existing.meta && typeof existing.meta === 'object' ? existing.meta : {}) };
    const data = {};
    if (action === 'start') {
      data.status = 'IN_PROGRESS';
      meta.fulfillment = { ...(meta.fulfillment || {}), startedAt: new Date().toISOString(), startedById: byId ?? null };
    } else if (action === 'fulfill') {
      data.status = 'ACTIVE';
      data.connectedAt = new Date();
      meta.fulfillment = {
        ...(meta.fulfillment || {}),
        url, fulfilledAt: new Date().toISOString(), fulfilledById: byId ?? null, declineReason: undefined,
      };
    } else {
      data.status = 'DECLINED';
      meta.fulfillment = { ...(meta.fulfillment || {}), declineReason: reason, declinedAt: new Date().toISOString(), declinedById: byId ?? null };
    }
    data.meta = meta;
    const row = await plDb().sellerChannelConnection.update({ where: { id }, data });
    const auditAction = action === 'start' ? AUDIT.OFFICE_STARTED : action === 'fulfill' ? AUDIT.OFFICE_FULFILLED : AUDIT.OFFICE_DECLINED;
    const detail = action === 'start'
      ? 'The Top Speed office started work on this connection request'
      : action === 'fulfill'
        ? `The Top Speed office completed this connection — evidence: ${url}`
        : `The Top Speed office declined this connection request — ${reason}`;
    await this.writeAudit(row.id, row.userId, auditAction, detail);
    return { row, conflict: false };
  },
  // Phase 2: record an agent/office action (a posting outcome on one
  // of the seller's channels) in the seller's own audit log — the
  // log the page copy promises. Ensures the channel row exists so
  // the entry always has a home.
  async recordAgentAction(userId, channel, kind, detail) {
    const conn = await this.ensure(userId, channel, kind);
    await this.writeAudit(conn.id, userId, AUDIT.AGENT_ACTION, detail);
    return conn;
  },
  async listRecentAudit(limit = 100) {
    return plDb().sellerChannelAudit.findMany({ orderBy: { createdAt: 'desc' }, take: limit });
  },
  async listAuditForConnection(connectionId) {
    return plDb().sellerChannelAudit.findMany({
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
      if (row.meta && typeof row.meta === 'object') {
        row.meta = { ...row.meta };
        delete row.meta.fulfillment;
      }
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
  // Phase 2 syndication support (2026-11-20, C16) — see prismaRepo.
  async findForUserChannel(userId, channel) {
    return memoryConnections.find((c) => c.userId === userId && c.channel === channel) || null;
  },
  async listByChannel(channel) {
    return memoryConnections.filter((c) => c.channel === channel);
  },
  async setMeta(userId, channel, kind, metaPatch) {
    const row = memoryEnsure(userId, channel, kind);
    row.meta = { ...(row.meta && typeof row.meta === 'object' ? row.meta : {}), ...metaPatch };
    row.updatedAt = new Date().toISOString();
    return row;
  },
  async listAll() {
    return [...memoryConnections].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  },
  async findById(id) {
    return memoryConnections.find((c) => c.id === id) || null;
  },
  async transition(id, action, { url, reason, byId } = {}) {
    const row = memoryConnections.find((c) => c.id === id);
    if (!row) return { row: null, conflict: false };
    const from = row.status;
    const legal =
      (action === 'start' && from === 'PENDING') ||
      (action === 'fulfill' && (from === 'PENDING' || from === 'IN_PROGRESS')) ||
      (action === 'decline' && (from === 'PENDING' || from === 'IN_PROGRESS'));
    if (!legal) return { row, conflict: true };
    const meta = { ...(row.meta && typeof row.meta === 'object' ? row.meta : {}) };
    if (action === 'start') {
      row.status = 'IN_PROGRESS';
      meta.fulfillment = { ...(meta.fulfillment || {}), startedAt: new Date().toISOString(), startedById: byId ?? null };
    } else if (action === 'fulfill') {
      row.status = 'ACTIVE';
      row.connectedAt = new Date().toISOString();
      meta.fulfillment = { ...(meta.fulfillment || {}), url, fulfilledAt: new Date().toISOString(), fulfilledById: byId ?? null, declineReason: undefined };
    } else {
      row.status = 'DECLINED';
      meta.fulfillment = { ...(meta.fulfillment || {}), declineReason: reason, declinedAt: new Date().toISOString(), declinedById: byId ?? null };
    }
    row.meta = meta;
    row.updatedAt = new Date().toISOString();
    const auditAction = action === 'start' ? AUDIT.OFFICE_STARTED : action === 'fulfill' ? AUDIT.OFFICE_FULFILLED : AUDIT.OFFICE_DECLINED;
    const detail = action === 'start'
      ? 'The Top Speed office started work on this connection request'
      : action === 'fulfill'
        ? `The Top Speed office completed this connection — evidence: ${url}`
        : `The Top Speed office declined this connection request — ${reason}`;
    memoryWriteAudit(row.id, row.userId, auditAction, detail);
    return { row, conflict: false };
  },
  async recordAgentAction(userId, channel, kind, detail) {
    const row = memoryEnsure(userId, channel, kind);
    memoryWriteAudit(row.id, userId, AUDIT.AGENT_ACTION, detail);
    return row;
  },
  async listRecentAudit(limit = 100) {
    return [...memoryAudit].reverse().slice(0, limit);
  },
  async listAuditForConnection(connectionId) {
    return memoryAudit.filter((a) => a.connectionId === connectionId);
  },
};

export const sellerChannelsRepo = PL_DB_AVAILABLE ? prismaRepo : memoryRepo;
