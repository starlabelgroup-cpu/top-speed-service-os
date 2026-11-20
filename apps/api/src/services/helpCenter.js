import { allKnowledgeEntries } from '../knowledge/index.js';
import { listHelpArticleStates, getHelpArticleState } from '../db/helpCenterRepo.js';

/**
 * Public Help Center (2026-11-20, Wave 3 E5) — Speedy's grounded
 * knowledge base, published as public help articles.
 *
 * The articles ARE the knowledge entries (site / glossary / industry
 * packs — 126 entries, rebuilt from live platform sources on every
 * read, so an article can never drift from what the platform
 * actually publishes). What this service adds is the HUMAN
 * publishing gate: an article is public only when a staff member
 * has published it (HelpArticleState PUBLISHED). There is no
 * auto-publish path — a brand-new knowledge entry starts as a draft
 * here until a person approves it for the public.
 *
 * Every article the public sees carries the booking paths (the web
 * page renders Book + Call against the platform constants) — no
 * bare SEO pages, per the standing rule: help content wires into
 * the real booking system.
 */

export const HELP_CATEGORIES = {
  site: 'About Top Speed & the Platform',
  glossary: 'Words & Terms',
  industry: 'Appliance Care & Repair Guides',
};

function excerptOf(answer, max = 220) {
  const flat = String(answer || '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function articleFromEntry(entry, state) {
  return {
    id: entry.id,
    topic: entry.topic,
    pack: entry.pack,
    category: HELP_CATEGORIES[entry.pack] || entry.pack,
    keywords: Array.isArray(entry.keywords) ? entry.keywords : [],
    answer: entry.answer,
    link: entry.link || null,
    state: state?.status === 'PUBLISHED' ? 'PUBLISHED' : 'DRAFT',
    publishedAt: state?.status === 'PUBLISHED' ? (state.publishedAt ?? null) : null,
  };
}

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOPWORDS = new Set(['the', 'a', 'an', 'is', 'are', 'do', 'does', 'how', 'what', 'when', 'where', 'why', 'no', 'not', 'my', 'your', 'for', 'to', 'of', 'in', 'on', 'and', 'or', 'it', 'can', 'i']);

/** Light matcher in the spirit of the knowledge index's scorer:
 *  keyword-phrase hits strongest, then topic, then answer text.
 *  Only meaningful tokens score — stopwords and 1–2 letter fragments
 *  never match, so a nonsense query honestly returns nothing. */
function scoreArticle(queryNorm, queryTokens, article) {
  let score = 0;
  for (const keyword of article.keywords) {
    const phrase = normalize(keyword);
    if (!phrase) continue;
    if (phrase.includes(' ') && queryNorm.includes(phrase)) score += 10;
    else if (queryTokens.includes(phrase)) score += 6;
  }
  const topic = normalize(article.topic);
  const answer = normalize(article.answer);
  for (const token of queryTokens) {
    if (token.length < 3 || STOPWORDS.has(token)) continue;
    if (topic.includes(token)) score += 4;
    if (answer.includes(token)) score += 1;
  }
  return score;
}

async function publishedArticles() {
  const states = await listHelpArticleStates();
  const byEntry = new Map(states.map((s) => [s.entryId, s]));
  return allKnowledgeEntries()
    .map((entry) => articleFromEntry(entry, byEntry.get(entry.id)))
    .filter((article) => article.state === 'PUBLISHED');
}

/** Public list — PUBLISHED articles only, optionally searched. */
export async function listPublicHelpArticles({ q } = {}) {
  const all = await publishedArticles();
  const query = String(q || '').trim();
  if (!query) {
    return {
      articles: all.map(({ answer, ...rest }) => ({ ...rest, excerpt: excerptOf(answer) })),
      total: all.length,
      query: null,
    };
  }
  const queryNorm = normalize(query);
  const queryTokens = queryNorm.split(' ').filter((t) => t.length >= 2);
  const scored = all
    .map((article) => ({ article, score: scoreArticle(queryNorm, queryTokens, article) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score);
  return {
    articles: scored.map(({ article }) => {
      const { answer, ...rest } = article;
      return { ...rest, excerpt: excerptOf(answer) };
    }),
    total: scored.length,
    query,
  };
}

/** One public article — null unless it exists AND is published. */
export async function getPublicHelpArticle(id) {
  const entry = allKnowledgeEntries().find((e) => e.id === id);
  if (!entry) return null;
  const state = await getHelpArticleState(id);
  const article = articleFromEntry(entry, state);
  return article.state === 'PUBLISHED' ? article : null;
}

/** Staff list — every knowledge entry with its publishing state. */
export async function listAdminHelpArticles() {
  const states = await listHelpArticleStates();
  const byEntry = new Map(states.map((s) => [s.entryId, s]));
  const articles = allKnowledgeEntries().map((entry) => {
    const article = articleFromEntry(entry, byEntry.get(entry.id));
    const { answer, ...rest } = article;
    return { ...rest, excerpt: excerptOf(answer) };
  });
  return {
    articles,
    counts: {
      total: articles.length,
      published: articles.filter((a) => a.state === 'PUBLISHED').length,
      draft: articles.filter((a) => a.state !== 'PUBLISHED').length,
    },
  };
}

export function helpEntryExists(id) {
  return allKnowledgeEntries().some((e) => e.id === id);
}
