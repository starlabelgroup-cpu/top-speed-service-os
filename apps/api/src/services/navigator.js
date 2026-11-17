import {
  GOOD_MATCH_SCORE,
  searchEntries,
} from '../knowledge/index.js';
import {
  SYSTEM_MAP_AREAS,
  SYSTEM_HOWTOS,
  navigatorEntries,
} from '../data/systemMap.js';

/**
 * System Navigator (2026-11-17) — the back-office AI guide for staff.
 *
 * Answers the two questions every team member asks — "Where is X?"
 * (the exact console/page + a deep link) and "How do I do Y?" (steps
 * that match the LIVE system) — from ONE curated source: the system
 * map in data/systemMap.js. The Academy course "System Navigator:
 * Know Your Platform" (modules 30–38) is generated from the same
 * file, so the guide and the course can never drift apart.
 *
 * READ-ONLY BY CONSTRUCTION — the same explain-only law as the
 * Academy coaches: this service holds no tools, calls no operational
 * endpoint, and mutates nothing. It explains and deep-links; people
 * execute. Its knowledge source contains no customer data and no
 * credentials, so an answer can never leak either.
 *
 * Always-answer contract (mirrors /speedy/chat and the coaches): when
 * the AI provider is configured, a grounded generative answer is
 * attempted first; ANY provider failure — including today's $0-credit
 * state — falls to retrieval over the system map, and the response
 * says which layer answered in answeredBy ('ai' |
 * 'knowledge-fallback'). The curated map is the launch state, not a
 * degraded one: where/how answers are exact from day one.
 */

const ENTRIES = navigatorEntries();
const AREA_COUNT = SYSTEM_MAP_AREAS.length;
const HOWTO_COUNT = SYSTEM_HOWTOS.length;

/* ------------------------- operational asks ------------------------- */
/* Imperative asks ("approve the campaign", "issue him a code") get a
 * redirect + the matching procedure — never an action. Process
 * questions ("how do I approve…?") are NOT operational asks. */
const PROCESS_QUESTION = /^\s*(how|what|where|who|when|why)\b/i;
const OPERATIONAL_ASK = new RegExp(
  '^\\s*(please\\s+)?(assign|dispatch|approve|reject|issue|revoke|create|delete|remove|send|refund|pause|resume|submit|publish|unpublish|book|cancel|reschedule|reset|hide)\\b' +
  '|\\b(can|could|will|would)\\s+you\\s+(assign|dispatch|approve|reject|issue|revoke|create|delete|remove|send|refund|pause|resume|submit|publish|book|cancel|reschedule|reset|hide)\\b' +
  '|\\bgo ahead and\\b',
  'i',
);

const GREETING_PATTERN = /^\s*(hi|hello|hey|good (morning|afternoon|evening)|yo|hiya)\b[^.!?]*[.!?]?\\s*$/i;
const THANKS_PATTERN = /\b(thank(s| you)|thanks|thx|appreciate it)\b/i;

function linksFor(entries) {
  const seen = new Set();
  const links = [];
  for (const entry of entries) {
    if (!entry?.link || seen.has(entry.link)) continue;
    seen.add(entry.link);
    links.push({ name: entry.linkName || entry.topic, url: entry.link });
  }
  return links.slice(0, 3);
}

/* --------------------------- fallback composer --------------------------- */

function composeNavigatorFallback(message) {
  const text = String(message || '').trim();

  if (GREETING_PATTERN.test(text)) {
    return {
      kind: 'smalltalk',
      entryId: null,
      links: [{ name: 'System Navigator directory', url: '/navigator' }],
      reply:
        `Hi — I'm the System Navigator, your back-office guide to the Top Speed Service OS. Ask me where anything lives ("Where is the Email Manager?") or how anything is done ("How do I issue a Speedy Verify code?"). I know ${AREA_COUNT} areas and ${HOWTO_COUNT} procedures, and every answer comes with the link.`,
    };
  }
  if (THANKS_PATTERN.test(text) && text.length < 80) {
    return {
      kind: 'smalltalk',
      entryId: null,
      links: [],
      reply: 'You\'re welcome. The full system directory is on this page whenever you need it — and the Academy course "System Navigator: Know Your Platform" (modules 30–38) teaches the whole map.',
    };
  }

  const matches = searchEntries(text, ENTRIES, 4);
  const [top, second] = matches;

  // Operational ask: decline the action, teach the procedure.
  if (OPERATIONAL_ASK.test(text) && !PROCESS_QUESTION.test(text)) {
    const howto = matches.find((m) => m.entry.kind === 'howto' && m.score >= GOOD_MATCH_SCORE);
    if (howto) {
      return {
        kind: 'redirect',
        entryId: howto.entry.id,
        links: linksFor([howto.entry]),
        reply:
          'I don\'t run operations — the Navigator explains and links; people execute in the consoles. Here is exactly how that one is done:\n\n' +
          howto.entry.answer,
      };
    }
    const area = matches.find((m) => m.entry.kind === 'area' && m.score >= GOOD_MATCH_SCORE);
    return {
      kind: 'redirect',
      entryId: area?.entry.id || null,
      links: linksFor(area ? [area.entry] : []),
      reply:
        'I don\'t run operations — the Navigator explains and links; people execute in the consoles.' +
        (area
          ? ` That work happens here:\n\n${area.entry.answer}`
          : ' Tell me the task in "how do I …?" form and I\'ll give you the console and the steps.'),
    };
  }

  if (top && top.score >= GOOD_MATCH_SCORE) {
    // Intent ordering: a "where" question leads with the AREA (the
    // location), a "how" question leads with the PROCEDURE (the
    // steps) — whichever scored on top — and the complementary entry
    // for the same area follows when it also matched.
    const isWhere = /\bwhere\b/i.test(text);
    const isHow = /^\s*how\b/i.test(text);
    const areaMatch = matches.find((m) => m.entry.kind === 'area' && m.score >= GOOD_MATCH_SCORE);
    const howtoMatch = matches.find((m) => m.entry.kind === 'howto' && m.score >= GOOD_MATCH_SCORE);
    let lead = top.entry;
    let follow = null;
    if (isWhere && areaMatch) {
      lead = areaMatch.entry;
      if (howtoMatch && howtoMatch.entry.areaId === lead.areaId) follow = howtoMatch.entry;
    } else if (isHow && howtoMatch) {
      lead = howtoMatch.entry;
      if (areaMatch && areaMatch.entry.areaId === lead.areaId) follow = areaMatch.entry;
    } else if (
      second &&
      second.score >= GOOD_MATCH_SCORE - 1 &&
      second.entry.kind !== top.entry.kind &&
      second.entry.areaId === top.entry.areaId
    ) {
      follow = second.entry;
    }
    let reply = lead.answer;
    const picked = [lead];
    if (follow) {
      reply += `\n\n${follow.kind === 'howto' ? 'How it is done:\n' : ''}${follow.answer}`;
      picked.push(follow);
    }
    return { kind: 'match', entryId: lead.id, links: linksFor(picked), reply };
  }

  // No grounded match: say so plainly, offer the closest area when it
  // is genuinely near, and point at the directory + the course. Never
  // invent a location or a step.
  let reply =
    'That specific thing isn\'t in the system map I can confirm, and I won\'t guess at a location or a step. ';
  const near = top && top.score >= GOOD_MATCH_SCORE - 1 ? top : null;
  if (near) reply += `The closest area I can confirm is this:\n\n${near.entry.answer}\n\n`;
  reply +=
    `Everything I know is browsable in the directory on this page (${AREA_COUNT} areas, ${HOWTO_COUNT} procedures), and the Academy course "System Navigator: Know Your Platform" (modules 30–38) teaches the whole map. Try asking with the console or task name — "Where is the Email Manager?" or "How do I publish a page?"`;
  return { kind: 'general', entryId: near?.entry.id || null, links: linksFor(near ? [near.entry] : []), reply };
}

/* --------------------------- generative path --------------------------- */

function openAiConfig() {
  // Key precedence (Ramone, 2026-11-17): production runs on the V2 key
  // ("Speedy AI — New Version"); the original key is the fallback.
  const apiKey = process.env.OPENAI_API_KEY_V2 || process.env.OPENAI_API_KEY;
  return {
    configured: Boolean(apiKey),
    apiKey,
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    base: process.env.OPENAI_API_BASE || 'https://api.openai.com',
  };
}

export function navigatorProviderConfigured() {
  return openAiConfig().configured;
}

export function navigatorStatus() {
  return {
    configured: navigatorProviderConfigured(),
    mode: navigatorProviderConfigured() ? 'ai-with-knowledge-fallback' : 'knowledge-fallback',
    areas: AREA_COUNT,
    howtos: HOWTO_COUNT,
    source: 'system-map',
  };
}

async function navigatorResponsesRequest(body) {
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

/** Bounded prompt section from the retrieved map entries — the same
 *  discipline as the customer KB formatter, staff-framed. */
function formatMapForPrompt(matches, maxChars = 2200) {
  if (!matches.length) return '';
  const lines = [
    'RETRIEVED SYSTEM MAP ENTRIES for this staff question (from data/systemMap.js — for any platform location, step, or rule, these entries outrank general knowledge; use their routes and steps exactly):',
  ];
  let used = lines[0].length;
  for (const { entry } of matches) {
    const text = entry.answer.length > 800 ? `${entry.answer.slice(0, 800)}…` : entry.answer;
    const line = `- [${entry.topic}] ${text}`;
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length;
  }
  return lines.length > 1 ? lines.join('\n') : '';
}

function navigatorSystemPrompt(retrievedSection) {
  return [
    'You are the System Navigator, the back-office AI guide of the Top Speed Service OS. You teach Top Speed STAFF (never customers) where everything in the platform lives and how to use it.',
    'READ-ONLY LAW (no exceptions): you explain and deep-link only. You hold no tools and change nothing — no dispatching, approvals, account or code issuance, refunds, sends, or record changes. When a team member asks you to DO an operational thing, decline the action plainly, then give the exact steps and the console where a human does it.',
    'GROUNDING: every fact you state — a location, a route, a step, a role, a rule — comes from the system map entries in this prompt or the retrieved entries below. If a detail is not there, you do not know it: say so plainly and point to the directory on the Navigator page (/navigator) or the Academy course "System Navigator: Know Your Platform" (modules 30–38). Never invent a route, button, step, price, or policy. Never state or ask for any password, access code, or customer detail.',
    'STYLE: short and concrete. Lead with the answer: name the area, give its location/route, then the steps when the question is a "how". Prefer the retrieved entry\'s wording for steps — they match the live system.',
    retrievedSection || '',
  ].join('\n');
}

/* ------------------------------- entry point ------------------------------- */

/**
 * Run one Navigator turn. Returns
 * { reply, answeredBy, kind, links } — answeredBy is 'ai' when the
 * provider answered, 'knowledge-fallback' when the system map did.
 */
export async function navigatorChat({ message, history = [] }) {
  const text = String(message || '').trim();

  // Operational asks are answered deterministically (redirect + the
  // procedure) without spending a provider call — same discipline as
  // the Academy coaches' governance pre-screen.
  if (OPERATIONAL_ASK.test(text) && !PROCESS_QUESTION.test(text)) {
    const fallback = composeNavigatorFallback(text);
    return { ...fallback, answeredBy: 'knowledge-fallback' };
  }

  if (navigatorProviderConfigured()) {
    try {
      const matches = searchEntries(text, ENTRIES, 3);
      const retrieved = formatMapForPrompt(matches);
      const input = [
        ...history.slice(-10).map((turn) => ({ role: turn.role, content: String(turn.content) })),
        { role: 'user', content: text },
      ];
      const body = await navigatorResponsesRequest({
        instructions: navigatorSystemPrompt(retrieved),
        input,
        temperature: 0.3,
        max_output_tokens: 700,
      });
      const reply = extractText(body);
      if (reply) {
        return {
          reply,
          answeredBy: 'ai',
          kind: 'ai',
          links: linksFor(matches.filter((m) => m.score >= GOOD_MATCH_SCORE).map((m) => m.entry)),
        };
      }
    } catch (error) {
      console.error(JSON.stringify({
        level: 'error',
        message: 'system navigator provider failed — knowledge fallback engaged',
        error: String(error?.message || error),
      }));
    }
  }

  const fallback = composeNavigatorFallback(text);
  return { ...fallback, answeredBy: 'knowledge-fallback' };
}
