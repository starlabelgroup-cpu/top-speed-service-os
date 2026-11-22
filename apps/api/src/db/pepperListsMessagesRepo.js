import { createId } from '../data/store.js';
import { PL_DB_AVAILABLE, plDb } from './plClient.js';

/**
 * Pepper Lists — buyer–seller messaging repository (2026-11-20,
 * recommendations program C18). Same dual-mode discipline as the
 * other Pepper Lists repos: Prisma when DATABASE_URL is set, an
 * in-memory fallback with identical shapes when it is not.
 *
 * Invariants enforced here:
 *  - at most one thread per (listing connection, buyer) — a buyer
 *    who messages about the same listing again lands back in the
 *    same conversation;
 *  - messages are append-only: nothing edits or deletes a message;
 *    read state is a single readAt stamp set when the OTHER party
 *    opens the thread;
 *  - thread status moves OPEN → REPORTED (a party reported it) →
 *    CLOSED (staff), or OPEN → CLOSED; the repo only stores the
 *    status the routes decide — the privacy rules (only the two
 *    parties read/post; staff through the moderation lanes) live in
 *    routes/pepperListsGrowth.js.
 */

const memoryThreads = [];
const memoryMessages = [];

const prismaRepo = {
  async getOrCreate({ connectionId, listingReference, sellerUserId, buyerUserId }) {
    const existing = await plDb().pepperListsThread.findUnique({
      where: { connectionId_buyerUserId: { connectionId, buyerUserId } },
    });
    if (existing) return { thread: existing, created: false };
    try {
      const thread = await plDb().pepperListsThread.create({
        data: { connectionId, listingReference, sellerUserId, buyerUserId },
      });
      return { thread, created: true };
    } catch (error) {
      // A concurrent first message won the unique race — re-read.
      const row = await plDb().pepperListsThread.findUnique({
        where: { connectionId_buyerUserId: { connectionId, buyerUserId } },
      });
      if (row) return { thread: row, created: false };
      throw error;
    }
  },
  async findById(id) {
    return plDb().pepperListsThread.findUnique({ where: { id } });
  },
  async listForUser(userId) {
    return plDb().pepperListsThread.findMany({
      where: { OR: [{ buyerUserId: userId }, { sellerUserId: userId }] },
      orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }],
    });
  },
  async listReported(limit = 100) {
    return plDb().pepperListsThread.findMany({
      where: { status: 'REPORTED' },
      orderBy: { updatedAt: 'asc' },
      take: limit,
    });
  },
  async setStatus(id, status) {
    return plDb().pepperListsThread.update({ where: { id }, data: { status } });
  },
  async addMessage({ threadId, senderUserId, body }) {
    const message = await plDb().pepperListsMessage.create({
      data: { threadId, senderUserId, body },
    });
    await plDb().pepperListsThread.update({
      where: { id: threadId },
      data: { lastMessageAt: message.createdAt },
    });
    return message;
  },
  async listMessages(threadId) {
    return plDb().pepperListsMessage.findMany({
      where: { threadId },
      orderBy: { createdAt: 'asc' },
    });
  },
  async findLastMessage(threadId) {
    return plDb().pepperListsMessage.findFirst({
      where: { threadId },
      orderBy: { createdAt: 'desc' },
    });
  },
  async countUnread(threadId, userId) {
    return plDb().pepperListsMessage.count({
      where: { threadId, senderUserId: { not: userId }, readAt: null },
    });
  },
  async markRead(threadId, readerUserId) {
    return plDb().pepperListsMessage.updateMany({
      where: { threadId, senderUserId: { not: readerUserId }, readAt: null },
      data: { readAt: new Date() },
    });
  },
};

const memoryRepo = {
  async getOrCreate({ connectionId, listingReference, sellerUserId, buyerUserId }) {
    const existing = memoryThreads.find((t) => t.connectionId === connectionId && t.buyerUserId === buyerUserId);
    if (existing) return { thread: existing, created: false };
    const now = new Date().toISOString();
    const thread = {
      id: createId(), connectionId, listingReference, sellerUserId, buyerUserId,
      status: 'OPEN', lastMessageAt: null, createdAt: now, updatedAt: now,
    };
    memoryThreads.push(thread);
    return { thread, created: true };
  },
  async findById(id) {
    return memoryThreads.find((t) => t.id === id) || null;
  },
  async listForUser(userId) {
    return memoryThreads
      .filter((t) => t.buyerUserId === userId || t.sellerUserId === userId)
      .sort((a, b) => String(b.lastMessageAt || b.createdAt).localeCompare(String(a.lastMessageAt || a.createdAt)));
  },
  async listReported(limit = 100) {
    return memoryThreads
      .filter((t) => t.status === 'REPORTED')
      .sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)))
      .slice(0, limit);
  },
  async setStatus(id, status) {
    const thread = memoryThreads.find((t) => t.id === id);
    if (!thread) return null;
    thread.status = status;
    thread.updatedAt = new Date().toISOString();
    return thread;
  },
  async addMessage({ threadId, senderUserId, body }) {
    const message = {
      id: createId(), threadId, senderUserId, body,
      readAt: null, createdAt: new Date().toISOString(),
    };
    memoryMessages.push(message);
    const thread = memoryThreads.find((t) => t.id === threadId);
    if (thread) {
      thread.lastMessageAt = message.createdAt;
      thread.updatedAt = message.createdAt;
    }
    return message;
  },
  async listMessages(threadId) {
    return memoryMessages
      .filter((m) => m.threadId === threadId)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  },
  async findLastMessage(threadId) {
    const rows = await this.listMessages(threadId);
    return rows.length ? rows[rows.length - 1] : null;
  },
  async countUnread(threadId, userId) {
    return memoryMessages.filter((m) => m.threadId === threadId && m.senderUserId !== userId && !m.readAt).length;
  },
  async markRead(threadId, readerUserId) {
    const now = new Date().toISOString();
    let count = 0;
    for (const m of memoryMessages) {
      if (m.threadId === threadId && m.senderUserId !== readerUserId && !m.readAt) {
        m.readAt = now;
        count += 1;
      }
    }
    return { count };
  },
};

export const messagesRepo = PL_DB_AVAILABLE ? prismaRepo : memoryRepo;
