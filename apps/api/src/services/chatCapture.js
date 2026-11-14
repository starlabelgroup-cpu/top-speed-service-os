import { PLATFORM_COMPANY_ID, createId, store } from '../data/store.js';
import { persistChatMessage, persistChatSession } from '../db/chatsRepo.js';
import { emitReport } from './managementReports.js';
import {
  MARKETING_BRANDS,
  MARKETING_SERVICES,
  MARKETING_SYMPTOMS,
} from '../data/marketingTaxonomy.js';

/**
 * Speedy chat capture (2026-11-12) — Ramone's direction: "Every
 * customer chat is valuable information for developing new features
 * and methods of operations." Every Speedy exchange is recorded into
 * the SpeedyChatSession / SpeedyChatMessage tables (via the in-memory
 * store, like every other record) so staff can mine it in the Chat
 * Insights console (/chats).
 *
 * RESILIENCE RULE: capture is passive and must never break or
 * noticeably slow the chat. Routes call capture through
 * captureSafely(), which bounds the wait and swallows every error
 * (server-side log only). If the tables are missing mid-deploy, the
 * chat still answers — that exchange simply isn't recorded.
 *
 * Governance: capture is read-only observation. Speedy never learns
 * new claims from chats; the analysis is for humans (staff-only
 * endpoints in routes/chats.js). Photo diagnoses record that a
 * diagnosis happened plus the customer's note — never the image.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const CAPTURE_TIMEOUT_MS = 1500;
const MAX_MESSAGE_CHARS = 4000;

/** Clients may pass their own session id (a UUID) to continue a
 *  thread; anything else is normalized away and the server issues one. */
export function normalizeChatSessionId(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return UUID_RE.test(value) ? value.toLowerCase() : null;
}

/** Surface tag: flagship-widget, net-float, speedy-page, app,
 *  connect-pro, appliance-pro, tech… anything unrecognized becomes
 *  'unknown' — a chat is NEVER rejected over capture fields. */
export function normalizeChatSource(raw) {
  if (typeof raw !== 'string') return 'unknown';
  const value = raw.trim().toLowerCase();
  return SOURCE_RE.test(value) ? value : 'unknown';
}

/**
 * Unanswered detection. The knowledge base is closed: for anything
 * outside it, Speedy's instructions (services/speedyKnowledge.js) are
 * to say plainly "I don't have that detail" and offer the phone or
 * the Service Setters. That boundary family — plus exchanges that
 * error out — is what Chat Insights mines as "unanswered", so staff
 * can see the exact customer questions Speedy couldn't answer and
 * decide what knowledge or feature to add. Governance refusals are
 * policy answers, not boundary hits, and are not mined.
 */
const UNANSWERED_PATTERNS = [
  /don'?t have that detail/i,
  /don'?t have (that|the|those|these) (detail|details|information|info)/i,
  /don'?t have (a|an|any) (detail|record|listing|information)/i,
  /i don'?t know/i,
  /not (a detail|something) i (have|can)/i,
];

export function isUnansweredReply(text) {
  if (!text) return false;
  return UNANSWERED_PATTERNS.some((pattern) => pattern.test(text));
}

function logCaptureError(error) {
  console.error(
    JSON.stringify({
      level: 'error',
      message: 'speedy chat capture failed (chat unaffected)',
      error: String((error && error.message) || error),
    }),
  );
}

/**
 * Run a capture step with a hard time bound and total error
 * swallowing. Returns the step's result, or undefined when capture
 * failed or timed out — the caller proceeds either way.
 */
export async function captureSafely(step) {
  try {
    return await Promise.race([
      step(),
      new Promise((resolve) => setTimeout(() => resolve(undefined), CAPTURE_TIMEOUT_MS)),
    ]);
  } catch (error) {
    logCaptureError(error);
    return undefined;
  }
}

async function persistQuietly(promise) {
  try {
    await promise;
  } catch (error) {
    logCaptureError(error);
  }
}

export function getOrCreateChatSession({ sessionId, source, userId } = {}) {
  const id = normalizeChatSessionId(sessionId) || createId();
  let session = store.chatSessions.get(id);
  let created = false;
  if (!session) {
    const now = new Date().toISOString();
    session = {
      id,
      companyId: PLATFORM_COMPANY_ID,
      userId: userId || null,
      source: normalizeChatSource(source),
      startedAt: now,
      lastMessageAt: now,
      messageCount: 0,
      hadDiagnosis: false,
      convertedBookingReference: null,
      hasUnanswered: false,
      messages: [],
    };
    store.chatSessions.set(id, session);
    created = true;
    // Management reporting (2026-11-14): a Speedy Class session is a
    // training activity — report its start to the Training department.
    // emitReport is failure-proof, so capture stays passive.
    if (session.source === 'speedy_class') {
      emitReport({
        department: 'training',
        type: 'SPEEDY_CLASS_SESSION_STARTED',
        title: 'Speedy Class session started',
        detail: { sessionId: session.id, source: session.source, startedAt: session.startedAt, signedIn: Boolean(userId) },
        source: 'SPEEDY_CLASS',
        reference: null,
        eventKey: `speedy-class:${session.id}:started:report`,
      });
    }
  } else if (!session.userId && userId) {
    // A signed-in user joined a thread that started anonymously.
    session.userId = userId;
    created = true; // persist before any message insert (FK order)
  }
  return { session, created };
}

/** The session row must land before its message rows (the message
 *  table has a foreign key to the session). Capture callers await
 *  this first whenever the session is new or changed hands. */
async function ensureSessionPersisted(session, created) {
  if (created) await persistQuietly(persistChatSession(session));
}

function appendMessage(session, role, content, flagged = false) {
  const message = {
    id: createId(),
    sessionId: session.id,
    role,
    content: String(content || '').slice(0, MAX_MESSAGE_CHARS),
    flagged: Boolean(flagged),
    createdAt: new Date().toISOString(),
  };
  session.messages.push(message);
  session.messageCount = session.messages.length;
  session.lastMessageAt = message.createdAt;
  return message;
}

/** One chat exchange: the customer's message + Speedy's reply (or an
 *  error marker). The customer message of an errored exchange is
 *  flagged — the client shows the "connection snag" fallback for it,
 *  which is exactly the unanswered mining's second signal. */
export async function captureChatExchange({
  sessionId,
  source,
  userId,
  userMessage,
  assistantReply,
  error = false,
} = {}) {
  const { session, created } = getOrCreateChatSession({ sessionId, source, userId });
  await ensureSessionPersisted(session, created);
  if (userMessage) {
    const userRow = appendMessage(session, 'user', userMessage, error);
    await persistQuietly(persistChatMessage(session.id, userRow));
  }
  if (error) {
    session.hasUnanswered = true;
  } else if (assistantReply != null) {
    const flagged = isUnansweredReply(assistantReply);
    const replyRow = appendMessage(session, 'assistant', assistantReply, flagged);
    if (flagged) session.hasUnanswered = true;
    await persistQuietly(persistChatMessage(session.id, replyRow));
  }
  await persistQuietly(persistChatSession(session));
  return session;
}

/** A photo diagnosis happened in this session. Records the marker +
 *  the customer's note text and Speedy's reply — never the image. */
export async function captureChatDiagnosis({ sessionId, source, userId, note, reply } = {}) {
  const { session, created } = getOrCreateChatSession({ sessionId, source, userId });
  await ensureSessionPersisted(session, created);
  session.hadDiagnosis = true;
  const noteText = String(note || '').trim();
  const marker = noteText ? `[Photo diagnosis] ${noteText}` : '[Photo diagnosis]';
  const markerRow = appendMessage(session, 'user', marker, false);
  await persistQuietly(persistChatMessage(session.id, markerRow));
  if (reply) {
    const flagged = isUnansweredReply(reply);
    const replyRow = appendMessage(session, 'assistant', reply, flagged);
    if (flagged) session.hasUnanswered = true;
    await persistQuietly(persistChatMessage(session.id, replyRow));
  }
  await persistQuietly(persistChatSession(session));
  return session;
}

/** Link a booking created inside (or alongside) a chat session. A
 *  session that doesn't exist (plain form booking) is a no-op. */
export async function captureBookingConversion({ sessionId, referenceCode } = {}) {
  const id = normalizeChatSessionId(sessionId);
  if (!id || !referenceCode) return null;
  const session = store.chatSessions.get(id);
  if (!session) return null;
  session.convertedBookingReference = referenceCode;
  await persistQuietly(persistChatSession(session));
  return session;
}

/* ------------------------------------------------------------------ */
/* Topic mining — reuses the Marketing OS taxonomy (14 brands / 11     */
/* services / 7 symptoms) with customer-word aliases, so insights      */
/* speak the same language as the landing-page program. A session      */
/* counts once per topic no matter how often it is mentioned.          */
/* ------------------------------------------------------------------ */

const SERVICE_ALIASES = {
  Refrigerator: ['refrigerator', 'fridge'],
  Washer: ['washer', 'washing machine'],
  Dryer: ['dryer', 'clothes dryer'],
  'Oven/Range': ['oven', 'range', 'stove'],
  Dishwasher: ['dishwasher'],
  'Freezer/Ice Maker': ['freezer', 'ice maker', 'ice machine', 'icemaker'],
  Microwave: ['microwave'],
  'Garbage Disposal': ['garbage disposal', 'disposal'],
  Installation: ['installation', 'installing', 'install a', 'install an', 'install the', 'install my', 'install new'],
  'Commercial Appliance Repair': ['commercial'],
  Cooktop: ['cooktop', 'cook top'],
};

const SYMPTOM_ALIASES = {
  'Not cooling': ['not cooling', 'not cold', 'stopped cooling', 'warm inside'],
  'Not draining': ['not draining', "won't drain", 'wont drain', 'standing water'],
  'Not heating': ['not heating', 'no heat', 'not getting hot'],
  Leaking: ['leaking', 'leak', 'dripping', 'puddle'],
  'Error codes': ['error code', 'error codes', 'code on the display', 'flashing code'],
  'Unusual noises': ['noise', 'noises', 'noisy', 'buzzing', 'grinding', 'clicking', 'humming', 'rattling'],
  'No ice': ['no ice', 'not making ice'],
};

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function termHits(text, term) {
  return new RegExp(`\\b${escapeRegExp(term)}\\b`, 'i').test(text);
}

function mineGroup(text, names, aliases) {
  const found = [];
  for (const name of names) {
    const terms = [name.toLowerCase(), ...(aliases[name] || [])];
    if (terms.some((term) => termHits(text, term))) found.push(name);
  }
  return found;
}

/** Topics mentioned in one text (customer words): services (which are
 *  the appliances), brands, and symptoms from the shared taxonomy. */
export function mineTopics(text) {
  const value = String(text || '');
  return {
    services: mineGroup(value, MARKETING_SERVICES.map((s) => s.name), SERVICE_ALIASES),
    brands: mineGroup(value, MARKETING_BRANDS.map((b) => b.name), {}),
    symptoms: mineGroup(value, MARKETING_SYMPTOMS.map((s) => s.name), SYMPTOM_ALIASES),
  };
}
