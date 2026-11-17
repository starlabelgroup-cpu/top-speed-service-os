import { DATABASE_ENABLED, db } from './client.js';
import { store } from '../data/store.js';

/**
 * Book OS Inbox persistence: inbound email (Resend webhook) and the
 * staff replies sent back out. Hydrated into store.inboxMessages at
 * startup (add-on module — a missing table mid-deploy degrades to an
 * empty inbox, never blocks the platform) and written through on every
 * create / status change, in the crmRepo pattern.
 */

function iso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function toStoreMessage(row) {
  return {
    id: row.id,
    companyId: row.companyId,
    direction: row.direction,
    providerEmailId: row.providerEmailId || null,
    fromEmail: row.fromEmail,
    fromName: row.fromName || null,
    toEmail: row.toEmail,
    mailbox: row.mailbox || null,
    subject: row.subject,
    textBody: row.textBody || null,
    htmlBody: row.htmlBody || null,
    snippet: row.snippet || null,
    customerId: row.customerId || null,
    connectionId: row.connectionId || null,
    threadRootId: row.threadRootId || null,
    messageIdHeader: row.messageIdHeader || null,
    inReplyToHeader: row.inReplyToHeader || null,
    status: row.status,
    author: row.author || null,
    receivedAt: iso(row.receivedAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export async function hydrateInboxMessages() {
  if (!DATABASE_ENABLED) return { skipped: true };
  const rows = await db().inboxMessage.findMany({ orderBy: { createdAt: 'asc' } });
  store.inboxMessages = rows.map(toStoreMessage);
  return { messages: rows.length };
}

export async function persistInboxMessage(message) {
  if (!DATABASE_ENABLED || !message?.id) return;
  const row = {
    id: message.id,
    companyId: message.companyId,
    direction: message.direction || 'INBOUND',
    providerEmailId: message.providerEmailId || null,
    fromEmail: message.fromEmail,
    fromName: message.fromName || null,
    toEmail: message.toEmail,
    mailbox: message.mailbox || null,
    subject: message.subject,
    textBody: message.textBody || null,
    htmlBody: message.htmlBody || null,
    snippet: message.snippet || null,
    customerId: message.customerId || null,
    connectionId: message.connectionId || null,
    threadRootId: message.threadRootId || null,
    messageIdHeader: message.messageIdHeader || null,
    inReplyToHeader: message.inReplyToHeader || null,
    status: message.status || 'UNREAD',
    author: message.author || null,
    receivedAt: message.receivedAt ? new Date(message.receivedAt) : null,
    createdAt: message.createdAt ? new Date(message.createdAt) : undefined,
  };
  await db().inboxMessage.upsert({
    where: { id: row.id },
    update: row,
    create: row,
  });
}

export async function updateInboxMessageStatus(message, status) {
  message.status = status;
  message.updatedAt = new Date().toISOString();
  if (!DATABASE_ENABLED) return;
  await db().inboxMessage.update({
    where: { id: message.id },
    data: { status, updatedAt: new Date(message.updatedAt) },
  });
}
