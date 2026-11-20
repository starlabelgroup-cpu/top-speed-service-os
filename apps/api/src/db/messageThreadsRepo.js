import { DATABASE_ENABLED, db } from './client.js';
import { store } from '../data/store.js';

/**
 * Setter–customer message thread persistence (2026-11-20, Wave 1
 * setter comms). Hydrated into store.messageThreads /
 * store.threadMessages at startup (add-on module — a missing table
 * mid-deploy degrades to no threads, never blocks the platform) and
 * written through on every create, in the crmRepo / inboxRepo
 * pattern.
 */

function iso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function toStoreThread(row) {
  return {
    id: row.id,
    companyId: row.companyId,
    customerId: row.customerId || null,
    bookingId: row.bookingId || null,
    status: row.status || 'OPEN',
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    lastMessageAt: iso(row.lastMessageAt),
  };
}

function toStoreMessage(row) {
  return {
    id: row.id,
    threadId: row.threadId,
    companyId: row.companyId,
    direction: row.direction,
    channel: row.channel,
    kind: row.kind || 'MESSAGE',
    body: row.body,
    subject: row.subject || null,
    author: row.author || null,
    outboxEntryId: row.outboxEntryId || null,
    deliveryStatus: row.deliveryStatus || 'RECEIVED',
    deliveryError: row.deliveryError || null,
    externalId: row.externalId || null,
    createdAt: iso(row.createdAt),
  };
}

export async function hydrateMessageThreads() {
  if (!DATABASE_ENABLED) return { skipped: true };
  const [threads, messages] = await Promise.all([
    db().messageThread.findMany({ orderBy: { createdAt: 'asc' } }),
    db().threadMessage.findMany({ orderBy: { createdAt: 'asc' } }),
  ]);
  store.messageThreads = threads.map(toStoreThread);
  store.threadMessages = messages.map(toStoreMessage);
  return { threads: threads.length, messages: messages.length };
}

export async function persistMessageThread(thread) {
  if (!DATABASE_ENABLED || !thread?.id) return;
  const row = {
    id: thread.id,
    companyId: thread.companyId,
    customerId: thread.customerId || null,
    bookingId: thread.bookingId || null,
    status: thread.status || 'OPEN',
    lastMessageAt: thread.lastMessageAt ? new Date(thread.lastMessageAt) : null,
  };
  await db().messageThread.upsert({
    where: { id: thread.id },
    update: row,
    create: {
      ...row,
      createdAt: thread.createdAt ? new Date(thread.createdAt) : undefined,
      updatedAt: thread.updatedAt ? new Date(thread.updatedAt) : undefined,
    },
  });
}

export async function persistThreadMessage(message) {
  if (!DATABASE_ENABLED || !message?.id) return;
  const row = {
    id: message.id,
    threadId: message.threadId,
    companyId: message.companyId,
    direction: message.direction,
    channel: message.channel,
    kind: message.kind || 'MESSAGE',
    body: message.body,
    subject: message.subject || null,
    author: message.author || null,
    outboxEntryId: message.outboxEntryId || null,
    deliveryStatus: message.deliveryStatus || 'RECEIVED',
    deliveryError: message.deliveryError || null,
    externalId: message.externalId || null,
  };
  await db().threadMessage.upsert({
    where: { id: message.id },
    update: row,
    create: {
      ...row,
      createdAt: message.createdAt ? new Date(message.createdAt) : undefined,
    },
  });
}
