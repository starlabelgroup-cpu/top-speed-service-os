import { Router } from 'express';
import { store } from '../data/store.js';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { STAFF_ROLES } from '../config/security.js';
import { mineTopics } from '../services/chatCapture.js';

/**
 * Speedy Chat Insights — staff-only analysis over the captured
 * conversations (services/chatCapture.js). Sessions, transcripts and
 * aggregates live ONLY behind staff auth: transcripts are never on a
 * public endpoint. The point is product intelligence for humans —
 * what customers ask, which surfaces they ask it on, what converts
 * to a booking, and exactly which questions Speedy could not answer
 * (the knowledge-boundary mining) so the team can close the gaps.
 */
const router = Router();
const staffOnly = [authenticate, requireCompany, requireRole(...STAFF_ROLES)];

const DAY_MS = 24 * 60 * 60 * 1000;

function companySessions(req) {
  return [...store.chatSessions.values()].filter((s) => s.companyId === req.companyId);
}

function parseRange(req, defaultDays = 30) {
  const now = Date.now();
  const fromRaw = req.query.from ? new Date(req.query.from).getTime() : NaN;
  const toRaw = req.query.to ? new Date(req.query.to).getTime() : NaN;
  return {
    from: Number.isFinite(fromRaw) ? fromRaw : now - defaultDays * DAY_MS,
    to: Number.isFinite(toRaw) ? toRaw : now,
  };
}

function within(iso, from, to) {
  const t = new Date(iso).getTime();
  return t >= from && t <= to;
}

function sessionSummary(session) {
  const firstUser = (session.messages || []).find((m) => m.role === 'user');
  return {
    id: session.id,
    source: session.source,
    userId: session.userId,
    startedAt: session.startedAt,
    lastMessageAt: session.lastMessageAt,
    messageCount: session.messageCount,
    hadDiagnosis: session.hadDiagnosis,
    convertedBookingReference: session.convertedBookingReference,
    hasUnanswered: session.hasUnanswered,
    preview: firstUser ? firstUser.content.slice(0, 160) : '',
  };
}

router.get('/chats/sessions', ...staffOnly, (req, res) => {
  const { from, to } = parseRange(req, 90);
  const surface = typeof req.query.surface === 'string' ? req.query.surface : '';
  const converted = typeof req.query.converted === 'string' ? req.query.converted : '';
  const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(req.query.pageSize, 10) || 25));

  let sessions = companySessions(req).filter((s) => within(s.startedAt, from, to));
  if (surface) sessions = sessions.filter((s) => s.source === surface);
  if (converted === 'true') sessions = sessions.filter((s) => s.convertedBookingReference);
  if (converted === 'false') sessions = sessions.filter((s) => !s.convertedBookingReference);
  if (q) {
    sessions = sessions.filter((s) =>
      (s.messages || []).some((m) => m.content.toLowerCase().includes(q)),
    );
  }
  sessions.sort((a, b) => new Date(b.lastMessageAt) - new Date(a.lastMessageAt));

  const total = sessions.length;
  const items = sessions.slice((page - 1) * pageSize, page * pageSize).map(sessionSummary);
  return res.json({
    data: { items, total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) },
  });
});

router.get('/chats/sessions/:id', ...staffOnly, (req, res) => {
  const session = store.chatSessions.get(req.params.id);
  if (!session || session.companyId !== req.companyId) {
    return res.status(404).json({ error: 'Chat session not found' });
  }
  return res.json({
    data: {
      ...sessionSummary(session),
      messages: (session.messages || []).map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        flagged: m.flagged,
        createdAt: m.createdAt,
      })),
    },
  });
});

router.get('/chats/insights', ...staffOnly, (req, res) => {
  const { from, to } = parseRange(req, 30);
  const sessions = companySessions(req).filter((s) => within(s.startedAt, from, to));

  const totalMessages = sessions.reduce((sum, s) => sum + (s.messages || []).length, 0);
  const convertedSessions = sessions.filter((s) => s.convertedBookingReference);
  const diagnosisSessions = sessions.filter((s) => s.hadDiagnosis);
  const unansweredSessions = sessions.filter((s) => s.hasUnanswered);

  const bySurface = {};
  for (const s of sessions) bySurface[s.source] = (bySurface[s.source] || 0) + 1;

  const byDay = {};
  for (const s of sessions) {
    const day = new Date(s.startedAt).toISOString().slice(0, 10);
    byDay[day] = (byDay[day] || 0) + 1;
  }

  // Top topics: a session counts once per topic, mined from the
  // customer's own words with the shared marketing taxonomy.
  const topicCounts = { services: {}, brands: {}, symptoms: {} };
  for (const s of sessions) {
    const acc = { services: new Set(), brands: new Set(), symptoms: new Set() };
    for (const m of s.messages || []) {
      if (m.role !== 'user') continue;
      const topics = mineTopics(m.content);
      topics.services.forEach((t) => acc.services.add(t));
      topics.brands.forEach((t) => acc.brands.add(t));
      topics.symptoms.forEach((t) => acc.symptoms.add(t));
    }
    for (const group of Object.keys(topicCounts)) {
      for (const name of acc[group]) topicCounts[group][name] = (topicCounts[group][name] || 0) + 1;
    }
  }
  const topList = (counts) =>
    Object.entries(counts)
      .map(([name, sessionCount]) => ({ name, sessions: sessionCount }))
      .sort((a, b) => b.sessions - a.sessions)
      .slice(0, 10);

  // Unanswered mining: for every flagged row, surface the customer's
  // question — the user message right before a flagged assistant
  // reply, or the flagged user message itself when the exchange
  // errored. Newest first, capped for the console.
  const samples = [];
  let flaggedExchanges = 0;
  const recentFirst = [...sessions].sort(
    (a, b) => new Date(b.lastMessageAt) - new Date(a.lastMessageAt),
  );
  for (const s of recentFirst) {
    const messages = s.messages || [];
    for (let i = 0; i < messages.length; i += 1) {
      const m = messages[i];
      if (!m.flagged) continue;
      flaggedExchanges += 1;
      if (samples.length >= 25) continue;
      let question = null;
      if (m.role === 'user') {
        question = m.content;
      } else {
        for (let j = i - 1; j >= 0; j -= 1) {
          if (messages[j].role === 'user') {
            question = messages[j].content;
            break;
          }
        }
      }
      if (question) {
        samples.push({
          sessionId: s.id,
          surface: s.source,
          question: question.slice(0, 300),
          at: m.createdAt,
        });
      }
    }
  }

  return res.json({
    data: {
      range: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
      totals: {
        sessions: sessions.length,
        messages: totalMessages,
        convertedSessions: convertedSessions.length,
        conversionRate:
          sessions.length > 0
            ? Math.round((convertedSessions.length / sessions.length) * 1000) / 10
            : 0,
        diagnosisSessions: diagnosisSessions.length,
        unansweredSessions: unansweredSessions.length,
      },
      bySurface: Object.entries(bySurface)
        .map(([source, count]) => ({ source, sessions: count }))
        .sort((a, b) => b.sessions - a.sessions),
      byDay: Object.entries(byDay)
        .map(([date, count]) => ({ date, sessions: count }))
        .sort((a, b) => a.date.localeCompare(b.date)),
      topics: {
        services: topList(topicCounts.services),
        brands: topList(topicCounts.brands),
        symptoms: topList(topicCounts.symptoms),
      },
      unanswered: {
        sessions: unansweredSessions.length,
        exchanges: flaggedExchanges,
        samples,
      },
    },
  });
});

export default router;
