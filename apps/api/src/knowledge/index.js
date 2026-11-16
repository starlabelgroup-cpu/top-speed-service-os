import { buildSitePack } from './site.js';
import { GLOSSARY_PACK } from './glossary.js';
import { INDUSTRY_PACK } from './industry.js';

/**
 * Speedy's learning system — the retrieval layer over the three
 * knowledge packs (site / glossary / industry), plus the
 * always-answer fallback composer.
 *
 * Two design rules from the owner (2026-11-15):
 *  1. Speedy knows the whole platform and the trade: every customer
 *     question is first matched against grounded knowledge — live
 *     site facts, the platform glossary, and industry guides.
 *  2. Speedy ALWAYS has an answer. When the AI provider is down or
 *     unconfigured, composeFallbackAnswer() still answers — from the
 *     best knowledge match, from a safety entry when the message is a
 *     safety report, or with a general helpful answer that names the
 *     paths that resolve the question. The chat route's old 502
 *     "connection snag" is unreachable for provider failures.
 */

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'do', 'does', 'did', 'you', 'your', 'yours',
  'i', 'me', 'my', 'we', 'our', 'it', 'its', 'to', 'of', 'for', 'in', 'on',
  'at', 'and', 'or', 'if', 'so', 'can', 'could', 'would', 'should', 'what',
  'whats', 'when', 'where', 'why', 'how', 'much', 'many', 'about', 'with',
  'without', 'have', 'has', 'had', 'get', 'got', 'please', 'tell', 'me',
  'there', 'this', 'that', 'am', 'was', 'were', 'be', 'been', 'will',
]);

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(value) {
  const base = normalize(value)
    .split(' ')
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token));
  // Light plural folding so "discounts" finds "discount" and "vents"
  // finds "vent" — matching only, never display.
  const folded = [];
  for (const token of base) {
    folded.push(token);
    if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) {
      folded.push(token.slice(0, -1));
    }
  }
  return [...new Set(folded)];
}

/** All entries, packs rebuilt per call: the site pack is generated
 *  from live platform sources, so this is also the freshness rule. */
export function allKnowledgeEntries() {
  return [
    ...buildSitePack().map((entry) => ({ ...entry, pack: 'site' })),
    ...GLOSSARY_PACK.map((entry) => ({ ...entry, pack: 'glossary' })),
    ...INDUSTRY_PACK.map((entry) => ({ ...entry, pack: 'industry' })),
  ];
}

export function knowledgeStats() {
  const entries = allKnowledgeEntries();
  const packs = { site: 0, glossary: 0, industry: 0 };
  for (const entry of entries) packs[entry.pack] = (packs[entry.pack] || 0) + 1;
  return { total: entries.length, packs };
}

function scoreEntry(queryNorm, queryTokens, entry) {
  let score = 0;
  // Keyword phrase hits are the strongest signal — a curated phrase
  // appearing in the question means this entry was written for it.
  for (const keyword of entry.keywords || []) {
    const phrase = normalize(keyword);
    if (!phrase) continue;
    if (phrase.includes(' ') && queryNorm.includes(phrase)) {
      score += 8 + phrase.split(' ').length * 2;
    } else if (!phrase.includes(' ') && queryTokens.has(phrase)) {
      score += 4;
    }
  }
  // Topic words carry intent (e.g. "diagnostic", "warranty").
  const topicTokens = new Set(tokens(entry.topic));
  for (const token of queryTokens) {
    if (topicTokens.has(token)) score += 3;
  }
  // Keyword token overlap: the question's words against the entry's
  // keyword vocabulary.
  const keywordTokens = new Set();
  for (const keyword of entry.keywords || []) {
    for (const token of tokens(keyword)) keywordTokens.add(token);
  }
  for (const token of queryTokens) {
    if (keywordTokens.has(token)) score += 2;
  }
  // Weak answer-body signal, capped — symptom words inside a guide's
  // text support a match without letting long answers win by bulk.
  const answerTokens = new Set(tokens(entry.answer));
  let bodyHits = 0;
  for (const token of queryTokens) {
    if (answerTokens.has(token)) bodyHits += 1;
  }
  score += Math.min(bodyHits * 0.5, 3);
  return score;
}

/**
 * Ranked retrieval over a GIVEN entry list — the shared scorer behind
 * searchKnowledge, exported so scoped retrieval (the Academy coaches'
 * department/category entry sets in knowledge/specialists.js) ranks
 * with exactly the same rules as the customer knowledge base.
 * Returns [{ entry, score }] best first.
 */
export function searchEntries(query, entries, limit = 4) {
  const queryNorm = normalize(query);
  if (!queryNorm) return [];
  const queryTokens = new Set(tokens(query));
  const scored = [];
  for (const entry of entries || []) {
    const score = scoreEntry(queryNorm, queryTokens, entry);
    if (score > 0) scored.push({ entry, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, limit));
}

/**
 * Ranked retrieval over all packs. Returns [{ entry, score }] best
 * first. Safety entries are only returned through matchSafetyEntry()
 * or when they genuinely outscore — they are flagged so callers can
 * give them priority.
 */
export function searchKnowledge(query, limit = 4) {
  return searchEntries(query, allKnowledgeEntries(), limit);
}

/** A match strong enough to answer from directly in fallback mode. */
export const GOOD_MATCH_SCORE = 8;

/** Safety entries get their own matcher: a safety phrase hit wins
 *  over every other consideration, regardless of general scores. */
export function matchSafetyEntry(message) {
  const queryNorm = normalize(message);
  const queryTokens = new Set(tokens(message));
  let best = null;
  for (const entry of allKnowledgeEntries()) {
    if (!entry.safety) continue;
    let score = 0;
    for (const keyword of entry.keywords || []) {
      const phrase = normalize(keyword);
      if (!phrase) continue;
      if (phrase.includes(' ') && queryNorm.includes(phrase)) score += 10 + phrase.split(' ').length * 2;
      else if (!phrase.includes(' ') && queryTokens.has(phrase)) score += 4;
    }
    if (score > 0 && (!best || score > best.score)) best = { entry, score };
  }
  return best;
}

/** Bounded prompt section for the generative path. */
export function formatKnowledgeForPrompt(matches, maxChars = 1800) {
  if (!matches.length) return '';
  const lines = [
    'RETRIEVED KNOWLEDGE for this customer\'s question (from the Top Speed knowledge base — for any Top Speed fact, these entries outrank general knowledge; quote their figures and terms exactly):',
  ];
  let used = lines[0].length;
  for (const { entry } of matches) {
    const text = entry.answer.length > 650 ? `${entry.answer.slice(0, 650)}…` : entry.answer;
    const line = `- [${entry.topic}] ${text}`;
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length;
  }
  return lines.length > 1 ? lines.join('\n') : '';
}

/* ------------------------- always-answer fallback ------------------------ */

const NEXT_STEP =
  '\n\nIf you\'d like to move forward: I can book the $99 diagnostic visit (credited in full toward your repair) — just tell me your city and ZIP — or you can reach the team at (954) 931-7997, Monday–Friday, 8 AM–7 PM.';

const GREETING_PATTERN = /^\s*(hi|hello|hey|good (morning|afternoon|evening)|yo|hiya)\b[^.!?]*[.!?]?\s*$/i;
const THANKS_PATTERN = /\b(thank(s| you)|thanks|thx|appreciate it)\b/i;

/**
 * Compose a complete, grounded answer WITHOUT the AI provider.
 * Order of attempts: smalltalk → safety (verbatim-first) → best
 * knowledge match → general helpful answer. Always returns
 * { reply, kind, entryId } with a non-empty reply.
 */
export function composeFallbackAnswer(message) {
  const text = String(message || '').trim();

  if (GREETING_PATTERN.test(text)) {
    return {
      kind: 'smalltalk',
      entryId: null,
      reply:
        'Hi, I\'m Speedy — Top Speed Appliance\'s assistant. I can answer questions about our services, pricing, and coverage, help with an appliance problem (including a photo read), or book a visit. What can I do for you?',
    };
  }
  if (THANKS_PATTERN.test(text) && text.length < 80) {
    return {
      kind: 'smalltalk',
      entryId: null,
      reply:
        'You\'re welcome. If anything else comes up — a question, a photo of a problem, or booking a visit — I\'m right here. The team is also at (954) 931-7997, Monday–Friday, 8 AM–7 PM.',
    };
  }

  const safety = matchSafetyEntry(text);
  if (safety) {
    // Safety answers go out verbatim-first: no next-step sales line,
    // no trimming. The governance pre-screen normally answers these
    // before the provider is ever called; this is the second net.
    return { kind: 'safety', entryId: safety.entry.id, reply: safety.entry.answer };
  }

  const [top] = searchKnowledge(text, 1);
  if (top && top.score >= GOOD_MATCH_SCORE) {
    let reply = top.entry.answer;
    if (top.entry.link && !reply.includes('http')) reply += `\n\nMore here: ${top.entry.link}`;
    reply += NEXT_STEP;
    return { kind: 'match', entryId: top.entry.id, reply };
  }

  // No grounded match: still an answer — say plainly what isn't
  // confirmed, offer the closest grounded guidance if there is any,
  // and give the paths that resolve the question. Never invent a
  // Top Speed fact to fill the gap.
  let reply =
    'Good question — that specific detail isn\'t one I can confirm from Top Speed\'s published information, and I don\'t want to guess at it. ';
  // Only offer the closest entry when it is genuinely close (just
  // under the good-match bar) — a stray shared word ("sell") must not
  // drag an unrelated entry into the answer.
  if (top && top.score >= GOOD_MATCH_SCORE - 1) {
    reply += `The closest thing I can confirm is this: ${top.entry.answer} `;
  }
  reply +=
    'For a confirmed answer about your appliance, the $99 diagnostic visit (credited in full toward the repair) puts a technician on it — I can book it if you tell me your city and ZIP, or you can send a photo of the problem for a preliminary read. ' +
    'The team can also confirm details directly at (954) 931-7997, Monday–Friday, 8 AM–7 PM.';
  return { kind: 'general', entryId: top?.entry.id || null, reply };
}
