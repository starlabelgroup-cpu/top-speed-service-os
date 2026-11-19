import { GOOD_MATCH_SCORE, searchEntries } from '../knowledge/index.js';
import { PEPPER_ONBOARDING_ANSWER, PEPPER_STAFF_PACK } from '../data/pepperKnowledge.js';
import { SYSTEM_MAP_AREAS } from '../data/systemMap.js';
import { pepperReportsRepo } from '../db/pepperReportsRepo.js';
import {
  PEPPER_AUTHORITY_LIMITS,
  PEPPER_IDENTITY,
  PEPPER_OWNER_DIRECTIVE,
  PEPPER_RULE_ZERO,
  PEPPER_STANDING_DUTIES,
  buildPepperStatus,
} from './pepperConsole.js';
import { speedyStatus } from './speedy.js';

/**
 * Pepper Chat — the staff-facing chat behind the Workstation chat
 * bar (POST /api/v1/pepper/chat, staff-gated per route).
 *
 * Speedy talks to customers; Pepper talks to the team. Same engine
 * discipline as Speedy (services/speedy.js): the OpenAI Responses
 * API when configured, a grounded knowledge fallback when it is
 * not — the fallback is honestly labeled in `answeredBy`, never
 * dressed up as the AI. Three deterministic paths run BEFORE the
 * model, because they must never depend on it:
 *
 *  1. PROBLEM ESCALATION — a message that reports a problem or
 *     issue files a REAL PepperReport (NEEDS_OWNER) under the
 *     signed-in staff member's name, per the owner's 2026-11-18
 *     directive ("if so forwarded to me Ramone Williams"). The
 *     reply confirms with the real report id. If the filing fails,
 *     the reply says so — a filing is never faked.
 *  2. LIVE STATUS — a status/health question is answered from the
 *     REAL buildPepperStatus() payload, composed in code from the
 *     same reads the /pepper board shows. The model never invents
 *     a live number.
 *  3. KNOWLEDGE — standing orders (imported from
 *     services/pepperConsole.js, never duplicated), the console
 *     map (imported from data/systemMap.js), the staff work-rules
 *     pack and the new-employee onboarding path.
 *
 * Authority: the 2026-11-10 limits bind Pepper exactly as they
 * bind Speedy — no refunds, no safety certification, no credential
 * overrides, no compliance changes. Pepper also never resets a
 * password, issues an access code, or approves an account: those
 * are the Master's hands only (Rule Zero).
 */

function openAiConfig() {
  // Same key precedence as Speedy (2026-11-17): V2 first.
  const apiKey = process.env.OPENAI_API_KEY_V2 || process.env.OPENAI_API_KEY;
  return {
    configured: Boolean(apiKey),
    apiKey,
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    base: process.env.OPENAI_API_BASE || 'https://api.openai.com',
  };
}

export function pepperChatStatus() {
  const speedy = speedyStatus();
  return { configured: speedy.configured, model: speedy.model, provider: speedy.provider };
}

/* ------------------------- knowledge entries --------------------------- */

function identityEntries() {
  return [
    {
      topic: 'Standing orders — authority limits and Rule Zero',
      keywords: ['standing orders', 'authority limits', 'rule zero', 'what can pepper do', 'what can speedy do', 'refund authority', 'who is in charge'],
      answer:
        `${PEPPER_RULE_ZERO} The authority limits on AI (owner, 2026-11-10): ${PEPPER_AUTHORITY_LIMITS.join(' ')}`,
    },
    {
      topic: "Owner's directive — Pepper's charge and staff authority",
      keywords: ['owner directive', 'your orders', 'pepper in charge', 'responsible for', 'ramone directive', 'staff follow'],
      answer:
        `Ramone Williams' directive of ${PEPPER_OWNER_DIRECTIVE.issuedOn}: Pepper is responsible for ${PEPPER_OWNER_DIRECTIVE.scope.toLowerCase()}. ${PEPPER_OWNER_DIRECTIVE.staffRule} ${PEPPER_OWNER_DIRECTIVE.escalation} The directive sits under Rule Zero and the 2026-11-10 authority limits, which are unchanged.`,
    },
    {
      topic: "Pepper's standing duties",
      keywords: ['standing duties', 'what do you monitor', 'your duties', 'pepper watches'],
      answer: `My standing duties (owner directive, 2026-11-18): ${PEPPER_STANDING_DUTIES.map((d) => d.charAt(0).toLowerCase() + d.slice(1)).join('; ')}.`,
    },
    {
      topic: 'New-employee onboarding — how accounts work here',
      keywords: ['new employee', 'onboarding', 'new hire', 'account sign up', 'how do i get an account', 'first day', 'getting started', 'new staff'],
      answer: PEPPER_ONBOARDING_ANSWER,
    },
  ];
}

function consoleEntries() {
  return SYSTEM_MAP_AREAS.map((area) => ({
    topic: `Console: ${area.name}`,
    keywords: [...(area.keywords || []), area.id, area.name.toLowerCase(), 'where is', 'console'],
    answer:
      `${area.name} — ${area.purpose} Find it at ${area.location} (${area.url}). Access: ${area.access}.` +
      (area.actions?.length ? ` There you can: ${area.actions.join('; ').toLowerCase()}.` : ''),
  }));
}

export function pepperKnowledgeEntries() {
  return [...identityEntries(), ...PEPPER_STAFF_PACK, ...consoleEntries()];
}

export function searchPepperKnowledge(query, limit = 4) {
  return searchEntries(query, pepperKnowledgeEntries(), limit);
}

/* --------------------------- intent routing ---------------------------- */

const PROBLEM_PATTERNS = [
  /^\s*problem\s*:/i,
  /\bthere('s| is) (a|an) (problem|issue|bug|outage)\b/i,
  /\bwe have (a|an) (problem|issue)\b/i,
  /\breport (a |an |this )?(problem|issue|bug)\b/i,
  /\bsomething('s| is) (broken|wrong|down)\b/i,
  /\bis (down|broken|not working)\b/i,
  /\bisn'?t working\b/i,
  /\bnot working\b/i,
  /\bwon'?t (load|open|save|send|submit|sign in|log in)\b/i,
  /\bcan'?t (sign in|log in|access|open|save|send|submit|book)\b/i,
  /\bcustomers? (can'?t|cannot|are unable)\b/i,
  /\bkeeps? (failing|erroring|crashing|timing out)\b/i,
  /\b(site|page|system|app|portal|console) is down\b/i,
];

export function messageReportsProblem(message) {
  const value = String(message || '');
  return PROBLEM_PATTERNS.some((pattern) => pattern.test(value));
}

const STATUS_PATTERNS = [
  /\bhealth check\b/i,
  /\bhow (is|are) (everything|the systems?|things|speedy|payments?|the board)\b/i,
  /\b(is|are) (speedy|payments?|stripe|the site|the platform|everything) (up|down|ok|okay|working|live|healthy)\b/i,
  /\b(system|systems|platform|payment|payments|speedy|stripe|board|outbox|notifications?|insights|ad studio|pepper lists) status\b/i,
  /^\s*(status|systems? status|status check)\s*\??\s*$/i,
];

export function messageAsksStatus(message) {
  const value = String(message || '');
  return STATUS_PATTERNS.some((pattern) => pattern.test(value));
}

/* ------------------------------ status --------------------------------- */

function sectionLine(label, section, describe) {
  if (!section || section.available !== true) return `- ${label}: could not be read from this server right now — open its own console for the live state.`;
  return `- ${label}: ${describe(section)}`;
}

export function composeStatusReply(status) {
  const s = status.sections || {};
  const lines = ['Here is the live board, read just now from the systems themselves:'];
  lines.push(sectionLine('Payments', s.payments, (p) =>
    p.configured
      ? `live — Stripe configured, webhook ${p.webhookConfigured ? 'configured' : 'NOT configured'}, diagnostic $${(p.diagnosticAmountCents / 100).toFixed(0)}`
      : 'Stripe is NOT configured on this server'));
  lines.push(sectionLine('Speedy (customer AI)', s.speedy, (p) =>
    p.configured
      ? `live on ${p.model || 'the configured model'} — knowledge base ${p.knowledge?.total ?? 'unknown'} entries`
      : 'AI provider not configured — Speedy is answering from its knowledge fallback'));
  lines.push(sectionLine('Notification outbox', s.notifications, (n) =>
    `${n.total} messages — ${n.queued} queued, ${n.sent} sent, ${n.failed} failed, ${n.gated} gated`));
  lines.push(sectionLine('Insights connections', s.insights, (i) =>
    (i.connections || []).map((c) => `${c.label}: ${c.status}`).join('; ') || 'no connections listed'));
  lines.push(sectionLine('Ad Studio', s.adStudio, (a) => {
    const providers = a.providers?.available
      ? (a.providers.connections || []).map((c) => `${c.provider} ${c.status}`).join(', ') || 'no provider connections'
      : 'provider states unreadable';
    return `${a.totalCampaigns} campaigns, ${a.pendingApproval} awaiting approval; providers — ${providers}`;
  }));
  lines.push(sectionLine('Pepper Lists channels', s.pepperLists, (p) =>
    `${p.total} channel connections, ${p.pending} pending`));
  lines.push('Anything here that looks wrong: tell me in this chat and I will file it for Ramone.');
  return lines.join('\n');
}

/* --------------------------- problem filing ---------------------------- */

function reportTitle(message) {
  const cleaned = String(message || '').replace(/^\s*problem\s*:\s*/i, '').replace(/\s+/g, ' ').trim();
  const base = cleaned.length > 100 ? `${cleaned.slice(0, 97)}...` : cleaned;
  return `Chat report: ${base || 'Problem reported in Pepper chat'}`;
}

export async function fileProblemReport({ message, user, surface }) {
  const row = await pepperReportsRepo.create({
    title: reportTitle(message),
    body:
      String(message || '').trim() +
      `\n\n— Filed from the Pepper chat bar by ${user?.email || 'a staff member'}` +
      (surface ? ` (console: ${surface})` : '') +
      '. Category NEEDS_OWNER per the owner\'s 2026-11-18 escalation directive.',
    category: 'NEEDS_OWNER',
    createdByUserId: user?.id ?? null,
  });
  return row;
}

/* --------------------------------- AI ---------------------------------- */

function pepperSystemPrompt(matches) {
  const knowledge = matches.length
    ? `\nStaff knowledge matched to this question (answer from these entries for any platform fact):\n${matches
        .map(({ entry }) => `• ${entry.topic}: ${entry.answer}`)
        .join('\n')}`
    : '';
  return [
    `You are Pepper — ${PEPPER_IDENTITY.title} of the Top Speed Service OS, the staff-facing operations agent inside the Workstation. You report to ${PEPPER_IDENTITY.reportsTo} (${PEPPER_IDENTITY.reportsToTitle}), the owner. Speedy is the customer-facing assistant; you never speak as Speedy and you never talk to customers here — this chat is staff-only.`,
    `Your charge (owner directive, ${PEPPER_OWNER_DIRECTIVE.issuedOn}): you are responsible for ${PEPPER_OWNER_DIRECTIVE.scope.toLowerCase()}. ${PEPPER_OWNER_DIRECTIVE.staffRule} ${PEPPER_OWNER_DIRECTIVE.escalation}`,
    `Authority limits that bind you: ${PEPPER_AUTHORITY_LIMITS.join(' ')} You also never reset passwords, issue Speedy Verify codes, approve accounts, or change anyone's access — those are the Master's hands only. ${PEPPER_RULE_ZERO}`,
    'Never invent live data: no counts, statuses, balances, or names of real customers/bookings unless they appear in the knowledge provided with the question. Live system state lives on the Pepper console board (/pepper) — point staff there for the current read. If you do not know a platform fact and it is not in the knowledge provided, say so plainly and give the path: ask here again with more detail, check the console named in the System Navigator (/navigator), or escalate to Ramone.',
    'Style: direct, brief, plain language — a competent duty officer, not a salesman. Short answers unless the question needs steps; then numbered steps.',
    knowledge,
  ].join('\n');
}

async function responsesRequest(body) {
  const config = openAiConfig();
  const response = await fetch(`${config.base}/v1/responses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: config.model, ...body }),
  });
  const parsed = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(parsed?.error?.message || `OpenAI error ${response.status}`);
  }
  return parsed;
}

function extractText(responseBody) {
  if (typeof responseBody?.output_text === 'string' && responseBody.output_text.trim()) {
    return responseBody.output_text.trim();
  }
  const parts = [];
  for (const item of responseBody?.output || []) {
    if (item?.type !== 'message') continue;
    for (const content of item.content || []) {
      if (content?.type === 'output_text' && content.text) parts.push(content.text);
    }
  }
  return parts.join('\n').trim();
}

/* --------------------------------- chat ---------------------------------- */

/** history: prior turns [{ role: 'user'|'assistant', content }], oldest first. */
export async function pepperChat({ message, history = [], user = null, surface = null }) {
  // 1) Problem escalation — deterministic, files a real report.
  if (messageReportsProblem(message)) {
    try {
      const row = await fileProblemReport({ message, user, surface });
      return {
        reply:
          `Filed. Report ${row.id} is now in the Pepper report log as NEEDS_OWNER, under your name` +
          `${user?.email ? ` (${user.email})` : ''}. Under Ramone's standing directive it has been forwarded to Ramone Williams. ` +
          'More detail helps him: what you were doing when it happened, and what it blocks — you can add it in the Pepper console report log (/pepper).',
        answeredBy: 'escalation',
        model: null,
        report: { id: row.id, category: 'NEEDS_OWNER' },
      };
    } catch (error) {
      console.error(JSON.stringify({
        level: 'error',
        message: 'pepper chat problem filing failed',
        error: String(error?.message || error),
      }));
      return {
        reply:
          'I could not file that report just now — the report log did not accept it, and I will not pretend otherwise. ' +
          'Please file it directly in the Pepper console report log (/pepper), and treat this problem as escalated to Ramone Williams under his standing directive.',
        answeredBy: 'escalation-failed',
        model: null,
        report: null,
      };
    }
  }

  // 2) Live status — composed from the real board payload.
  if (messageAsksStatus(message)) {
    const status = await buildPepperStatus();
    return { reply: composeStatusReply(status), answeredBy: 'status-board', model: null, status };
  }

  // 3) Knowledge — AI when configured, grounded fallback when not.
  const matches = searchPepperKnowledge(message, 4);
  const config = openAiConfig();
  if (config.configured) {
    try {
      const input = [
        ...history.slice(-10).map((turn) => ({ role: turn.role, content: String(turn.content) })),
        { role: 'user', content: message },
      ];
      const body = await responsesRequest({
        instructions: pepperSystemPrompt(matches),
        input,
        temperature: 0.3,
        max_output_tokens: 600,
      });
      const reply = extractText(body);
      if (reply) return { reply, answeredBy: 'ai', model: body.model || config.model };
    } catch (error) {
      console.error(JSON.stringify({
        level: 'error',
        message: 'pepper chat provider failed — knowledge fallback engaged',
        error: String(error?.message || error),
      }));
    }
  }

  const best = matches[0];
  if (best && best.score >= GOOD_MATCH_SCORE) {
    return { reply: best.entry.answer, answeredBy: 'knowledge-pack', model: null };
  }
  return {
    reply:
      'I do not have that in my staff knowledge yet, and I will not guess at a platform fact. ' +
      'Here is what I can do from this bar: answer work-rule and console questions (try "Where is the setter exception queue?" or "How do accounts work here?"), ' +
      'read the live systems board ("system status"), and file problems for Ramone ("Report a problem: …"). ' +
      'For anything else, the System Navigator (/navigator) maps every console, and a problem or question that needs the owner goes up to Ramone Williams.',
    answeredBy: 'knowledge-pack',
    model: null,
  };
}
