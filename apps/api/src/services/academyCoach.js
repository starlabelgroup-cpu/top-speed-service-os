import { PLATFORM_CONSTANTS } from '../config/platform.js';
import {
  GOOD_MATCH_SCORE,
  allKnowledgeEntries,
  formatKnowledgeForPrompt,
  matchSafetyEntry,
  searchEntries,
  searchKnowledge,
} from '../knowledge/index.js';
import {
  DEPARTMENTS,
  coachEntries,
  resolveSpecialist,
} from '../knowledge/specialists.js';
import { classifySpeedyMessage, governancePromptBlock } from './speedyPolicy.js';
import { speedyKnowledgeSections } from './speedyKnowledge.js';

/**
 * Academy coaches — the AI Specialists & Strategists (2026-11-16).
 *
 * One specialist per department, scoped strategist guidance per
 * category, and the Ecosystem Guide across all of them. The coaches
 * run on the SAME machinery as Speedy: the same knowledge base
 * (knowledge/ packs + the platform KB sections), the same governance
 * classification, and the same always-answer rule — when the AI
 * provider is down or unconfigured, the coach answers from grounded
 * knowledge retrieval instead of failing, and says so in answeredBy.
 *
 * GOVERNANCE — the hard rule for this surface: coaches EXPLAIN and
 * GUIDE only. By construction they cannot execute anything:
 *   - the generative path is called with NO tools attached;
 *   - the governance pre-screen is answered with TEACHING replies and
 *     performs NO side effects (unlike the customer gate, a staff
 *     member asking "how do refunds work?" must not queue a refund
 *     request — the coach explains the rule and the human process);
 *   - imperative operational requests ("approve this campaign") get a
 *     redirect: the exact steps and the console where a human does it.
 */

const PHONE = PLATFORM_CONSTANTS.phoneDisplay;

/* ------------------------- scoped retrieval ------------------------- */

const KB_BY_ID = new Map(allKnowledgeEntries().map((entry) => [entry.id, entry]));
const ALL_COACH_ENTRIES = coachEntries();
const COACH_BY_DEPT = new Map();
for (const entry of ALL_COACH_ENTRIES) {
  if (!COACH_BY_DEPT.has(entry.deptId)) COACH_BY_DEPT.set(entry.deptId, []);
  COACH_BY_DEPT.get(entry.deptId).push(entry);
}

/** The entry pool a scope retrieves from: its own coach entries first
 *  (department + its categories, or the guide), then the knowledge-base
 *  entries the department maps to. */
function scopedPool(scope) {
  const own = scope.kind === 'guide'
    ? ALL_COACH_ENTRIES
    : (COACH_BY_DEPT.get(scope.dept.id) || []);
  const kb = (scope.kbIds || []).map((id) => KB_BY_ID.get(id)).filter(Boolean);
  return [...own, ...kb];
}

function deptNameForEntry(entry) {
  if (!entry) return null;
  if (entry.deptId === 'guide') return 'the Ecosystem Guide';
  const dept = DEPARTMENTS.find((d) => d.id === entry.deptId);
  return dept ? dept.name : null;
}

/* --------------------- governance: teaching mode --------------------- */

const GOVERNANCE_TEACHING = {
  SAFETY_CRITICAL:
    'Treat that as a live safety situation first, teaching second: stop using the appliance, keep everyone clear, and if there is any gas smell, leave the home and call 911 or the gas utility from outside. Safety-critical conditions are handled by a human professional — that is governance limit #2, and no AI (Speedy or a coach) diagnoses them beyond the safety steps. In the Academy, Modules 3 and 14 teach this line: the human professional takes over, and the team is alerted through the Service Setters\' outbox. If this is a real customer situation right now, escalate it to the team and call ' + PHONE + '.',
  REFUND_REQUEST:
    'Refunds are governance limit #1: a refund is decided by a human (or a configured approval) — never by AI, and a coach cannot issue, approve, or promise one. The human process: the request is recorded for the Service Setters (when a customer asks Speedy, Speedy creates exactly that — a refund REQUEST, decided by a person), the team reviews it against the booking record in Book OS / the CRM, and a team member decides and acts in Finance. If you are asking for a specific customer, take it to the Service Setters with the booking reference; the customer-facing explanation lives in Module 29\'s terms and the warranty facts in the knowledge base.',
  CERTIFY_SAFETY:
    'Certifying repair safety is governance limit #3: NEVER AI — not Speedy, not a coach, not any automation. Only a qualified human technician who inspects the work in person can certify a repair safe. If a job needs that sign-off, it is booked as an inspection/diagnostic visit and the technician owns the call on site (Module 14 teaches the safety line for the field). I can explain the process in more detail, but the certification itself is a human act.',
  OVERRIDE_CREDENTIALS:
    'Overriding technician credentials is governance limit #4: NEVER AI, and never by request. Every provider is verified by the team before receiving work, and credential, license, or verification checks cannot be bypassed, waived, or skipped — by a coach, by Speedy, or by a console shortcut. If a credential situation needs a decision, it belongs to the Master/manager tier through the normal verification path.',
  COMPLIANCE_CHANGE:
    'Changing a compliance status is governance limit #5: authorized humans only. No AI can change one, and there is no coach action for it. The record is reviewed by an authorized team member, who makes and owns the change in the relevant console. If you are preparing a case, I can explain what the status means and what documentation the reviewer will look for.',
};

/**
 * Imperative operational asks ("assign this job to…", "can you approve
 * the campaign?") — the coach redirects instead of acting. Process
 * questions ("how do I approve…?") are NOT operational asks; they fall
 * through to knowledge.
 */
const PROCESS_QUESTION = /^\s*(how|what|where|who|when|why)\b/i;
const OPERATIONAL_ASK = new RegExp(
  '^\\s*(please\\s+)?(assign|dispatch|approve|reject|issue|revoke|create|delete|remove|send|refund|pause|resume|end|submit|publish|unpublish|book|cancel|reschedule|redeem|verify|reset)\\b' +
  '|\\b(can|could|will|would)\\s+you\\s+(assign|dispatch|approve|reject|issue|revoke|create|delete|remove|send|refund|pause|resume|end|submit|publish|book| cancel|reschedule|redeem|verify|reset)\\b' +
  '|\\bgo ahead and\\b',
  'i',
);

function operationalRedirect(scope) {
  const where = scope.dept
    ? scope.dept.consoles.map((c) => `${c.name} (${c.path})`).join(', ')
    : 'the owning department\'s console';
  return (
    `I don't run operations — Academy specialists explain and guide; people execute. ` +
    `That action is done by a person in ${where}. Tell me which step you want walked through — finding the record, checking it, or the exact action — and I'll take you through it in order. ` +
    `If it is one of the governed actions (a refund, a safety certification, a credential or compliance change), it stays with the authorized human no matter who asks.`
  );
}

/* --------------------------- fallback composer --------------------------- */

const GREETING_PATTERN = /^\s*(hi|hello|hey|good (morning|afternoon|evening)|yo|hiya)\b[^.!?]*[.!?]?\s*$/i;
const THANKS_PATTERN = /\b(thank(s| you)|thanks|thx|appreciate it)\b/i;

function composeCoachFallback(message, scope) {
  const text = String(message || '').trim();

  if (GREETING_PATTERN.test(text)) {
    return {
      kind: 'smalltalk',
      reply: `Hi — I'm ${scope.name}, ${scope.title}. ${scope.explains} Ask me anything in that area, or tap one of the starter questions.`,
    };
  }
  if (THANKS_PATTERN.test(text) && text.length < 80) {
    return {
      kind: 'smalltalk',
      reply: 'You\'re welcome. If another question comes up in my area, I\'m right here — and the Academy modules are always on this page when you want the full lesson.',
    };
  }

  const safety = matchSafetyEntry(text);
  if (safety) return { kind: 'safety', reply: safety.entry.answer };

  // The coach's own department/category entries speak first — they are
  // written for staff, in the specialist's voice. The wider knowledge
  // base is the depth behind them, not a replacement for them.
  const own = scope.kind === 'guide'
    ? ALL_COACH_ENTRIES
    : (COACH_BY_DEPT.get(scope.dept.id) || []);
  const [ownTop] = searchEntries(text, own, 1);
  if (ownTop && ownTop.score >= GOOD_MATCH_SCORE) {
    return { kind: 'match', entryId: ownTop.entry.id, reply: ownTop.entry.answer };
  }

  const pool = scopedPool(scope);
  const [top] = searchEntries(text, pool, 1);
  if (top && top.score >= GOOD_MATCH_SCORE) {
    return { kind: 'match', entryId: top.entry.id, reply: top.entry.answer };
  }

  // Strong match in ANOTHER department: answer from it, and route.
  const [cross] = searchEntries(text, ALL_COACH_ENTRIES, 1);
  if (cross && cross.score >= GOOD_MATCH_SCORE && cross.entry.deptId !== (scope.dept?.id || 'guide')) {
    const owner = deptNameForEntry(cross.entry);
    return {
      kind: 'routed',
      entryId: cross.entry.id,
      reply: `That one belongs to ${owner || 'another department'} — its specialist covers it in full. The grounded short version: ${cross.entry.answer}`,
    };
  }
  const [kbTop] = searchKnowledge(text, 1);
  if (kbTop && kbTop.score >= GOOD_MATCH_SCORE) {
    return { kind: 'match', entryId: kbTop.entry.id, reply: kbTop.entry.answer };
  }

  let reply =
    `That specific detail isn't in the Academy material I can confirm, and I won't guess at it. `;
  const near = [ownTop, top, cross]
    .filter((candidate) => candidate && candidate.score >= GOOD_MATCH_SCORE - 1)
    .sort((a, b) => b.score - a.score)[0] || null;
  if (near) reply += `The closest thing I can confirm is this: ${near.entry.answer} `;
  const where = scope.dept
    ? scope.dept.consoles.map((c) => `${c.name} (${c.path})`).join(', ')
    : 'the department consoles';
  reply +=
    `For the confirmed answer, check ${where}, or ask me a question from my area — ${scope.scope} The team can also confirm directly at ${PHONE}.`;
  return { kind: 'general', entryId: near?.entry.id || null, reply };
}

/* --------------------------- generative path --------------------------- */

function coachSystemPrompt(scope, retrievedSection) {
  return [
    `You are ${scope.name}, ${scope.title} — an AI specialist inside the Top Speed Academy, the staff university of the Top Speed Service OS. You teach Top Speed STAFF (never customers) how the platform works and how to run their part of it.`,
    `YOUR DOMAIN: ${scope.scope}`,
    scope.dept
      ? `YOUR CONSOLES (where humans do this work): ${scope.dept.consoles.map((c) => `${c.name} at ${c.path}`).join('; ')}.`
      : 'You cover every department; route specific questions to the department that owns them and name its specialist and console.',
    'EXPLAIN-ONLY LAW (no exceptions): you explain and guide — you never execute operations. You hold no tools and change nothing: no dispatching, no approvals, no refunds, no account, code, campaign, or record changes, no sends. When a team member asks you to DO an operational thing, decline the action plainly, then give the exact steps and the console where a human does it.',
    'GROUNDING: every Top Speed fact you state comes from the knowledge in this prompt or the retrieved entries below. If a detail is not there — a price, a policy term, a timeline, a statistic — you do not know it: say so plainly and point to where it is confirmed (the console, the Academy module, or the team at ' + PHONE + '). Never fill a gap with a plausible-sounding fact. Provider payout terms live in provider agreements: never state or summarize them.',
    'STYLE: short, concrete, in module language. When a topic has an Academy module, name its number and title. Answer the question asked; do not lecture beyond it.',
    ...speedyKnowledgeSections(),
    governancePromptBlock(),
    retrievedSection || '',
  ].join('\n');
}

function openAiConfig() {
  return {
    configured: Boolean(process.env.OPENAI_API_KEY),
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    base: process.env.OPENAI_API_BASE || 'https://api.openai.com',
  };
}

export function coachProviderConfigured() {
  return openAiConfig().configured;
}

async function coachResponsesRequest(body) {
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

/* ------------------------------- entry point ------------------------------- */

/**
 * Run one coach turn. `target` is 'guide', a department id, or
 * '<dept>:<category>'. Returns { reply, answeredBy, scope, governance? }
 * or null for an unknown target. Mirrors the customer chat contract:
 * answeredBy is 'ai' when the provider answered, 'knowledge-fallback'
 * when grounded retrieval did.
 */
export async function academyCoachChat({ target, message, history = [] }) {
  const scope = resolveSpecialist(target);
  if (!scope) return null;

  const text = String(message || '').trim();

  // Governance first — teaching replies, zero side effects.
  const category = classifySpeedyMessage(text);
  if (category && GOVERNANCE_TEACHING[category]) {
    return { reply: GOVERNANCE_TEACHING[category], answeredBy: 'governance', governance: category, scope };
  }
  if (OPERATIONAL_ASK.test(text) && !PROCESS_QUESTION.test(text)) {
    return { reply: operationalRedirect(scope), answeredBy: 'governance', governance: 'EXPLAIN_ONLY', scope };
  }

  if (coachProviderConfigured()) {
    try {
      const matches = searchEntries(text, scopedPool(scope), 3);
      const retrieved = formatKnowledgeForPrompt(matches);
      const input = [
        ...history.slice(-10).map((turn) => ({ role: turn.role, content: String(turn.content) })),
        { role: 'user', content: text },
      ];
      const body = await coachResponsesRequest({
        instructions: coachSystemPrompt(scope, retrieved),
        input,
        temperature: 0.4,
        max_output_tokens: 700,
      });
      const reply = extractText(body);
      if (reply) return { reply, answeredBy: 'ai', model: body.model || openAiConfig().model, scope };
    } catch (error) {
      console.error(JSON.stringify({
        level: 'error',
        message: 'academy coach provider failed — knowledge fallback engaged',
        error: String(error?.message || error),
      }));
    }
  }

  const fallback = composeCoachFallback(text, scope);
  return { reply: fallback.reply, answeredBy: 'knowledge-fallback', kind: fallback.kind, scope };
}
