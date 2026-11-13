import { DATABASE_ENABLED, db } from './client.js';
import { store } from '../data/store.js';

/**
 * Postgres persistence for Speedy chat capture (SpeedyChatSession /
 * SpeedyChatMessage) — the same tolerate-the-gap pattern as the CRM
 * repo: hydration is wrapped by the caller so a missing migration can
 * never keep the API from booting, and every persist is guarded by
 * DATABASE_ENABLED. The in-memory store record embeds the messages
 * (oldest first); the tables normalize them for staff analysis.
 */

function rowToSession(row) {
  return {
    id: row.id,
    companyId: row.companyId,
    userId: row.userId,
    source: row.source,
    startedAt: row.startedAt.toISOString(),
    lastMessageAt: row.lastMessageAt.toISOString(),
    messageCount: row.messageCount,
    hadDiagnosis: row.hadDiagnosis,
    convertedBookingReference: row.convertedBookingReference,
    hasUnanswered: row.hasUnanswered,
    messages: (row.messages || []).map((m) => ({
      id: m.id,
      sessionId: m.sessionId,
      role: m.role,
      content: m.content,
      flagged: m.flagged,
      createdAt: m.createdAt.toISOString(),
    })),
  };
}

export async function hydrateChatSessions() {
  if (!DATABASE_ENABLED) return { skipped: true };
  const rows = await db().speedyChatSession.findMany({
    include: { messages: { orderBy: { createdAt: 'asc' } } },
    orderBy: { startedAt: 'asc' },
  });
  store.chatSessions = new Map(rows.map((row) => [row.id, rowToSession(row)]));
  return { sessions: rows.length };
}

export async function persistChatSession(session) {
  if (!DATABASE_ENABLED) return;
  const data = {
    companyId: session.companyId,
    userId: session.userId || null,
    source: session.source || 'unknown',
    startedAt: new Date(session.startedAt),
    lastMessageAt: new Date(session.lastMessageAt),
    messageCount: session.messageCount || 0,
    hadDiagnosis: Boolean(session.hadDiagnosis),
    convertedBookingReference: session.convertedBookingReference || null,
    hasUnanswered: Boolean(session.hasUnanswered),
  };
  await db().speedyChatSession.upsert({
    where: { id: session.id },
    create: { id: session.id, ...data },
    update: data,
  });
}

export async function persistChatMessage(sessionId, message) {
  if (!DATABASE_ENABLED) return;
  await db().speedyChatMessage.upsert({
    where: { id: message.id },
    create: {
      id: message.id,
      sessionId,
      role: message.role,
      content: message.content,
      flagged: Boolean(message.flagged),
      createdAt: new Date(message.createdAt),
    },
    update: { flagged: Boolean(message.flagged) },
  });
}
