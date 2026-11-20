/**
 * Federal recall lookup (2026-11-20, recommendations B3) — a
 * server-side read of the CPSC SaferProducts public REST feed
 * (saferproducts.gov/RestWebServices/Recall — free, no key, the
 * official federal recall data shape).
 *
 * HONESTY RULES for this service:
 *  - It returns CANDIDATES for a human to judge, never verdicts.
 *    Nothing here writes to a customer record: the only way a recall
 *    reaches a customer's garage is a staff member confirming the
 *    match and setting the curated note via
 *    POST /connect/appliances/:id/recall-note.
 *  - Matching is fuzzy by nature (the feed's own product rows often
 *    carry no model number), so results are filtered to recalls
 *    whose title/products/manufacturers mention the brand when one
 *    is given, and are labeled as candidates in the response.
 *  - When the feed is unreachable the service says so
 *    ({ available: false }) — it never invents or caches stale
 *    results as if they were live.
 */

const FEED_BASE = 'https://www.saferproducts.gov/RestWebServices/Recall';
const CACHE_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
const MAX_RESULTS = 8;

const cache = new Map();

function cacheKey({ brand, model, type }) {
  return [brand, model, type].map((v) => String(v || '').trim().toLowerCase()).join('|');
}

async function fetchFeed(params) {
  const url = `${FEED_BASE}?format=json&${params.toString()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function recallText(row) {
  const parts = [row.Title, row.Description];
  for (const p of row.Products || []) parts.push(p.Name, p.Model, p.Type);
  for (const m of row.Manufacturers || []) parts.push(m.Name);
  return parts.filter(Boolean).join(' ').toLowerCase();
}

function toCandidate(row) {
  return {
    recallId: row.RecallID ?? null,
    recallNumber: row.RecallNumber || null,
    recallDate: row.RecallDate ? String(row.RecallDate).slice(0, 10) : null,
    title: row.Title || null,
    url: row.URL || null,
    description: row.Description ? String(row.Description).slice(0, 600) : null,
    products: (row.Products || []).map((p) => ({
      name: p.Name || null,
      model: p.Model || null,
      type: p.Type || null,
    })),
    manufacturers: (row.Manufacturers || []).map((m) => m.Name).filter(Boolean),
    hazards: (row.Hazards || []).map((h) => h.Name).filter(Boolean),
  };
}

/**
 * Look up candidate recalls for an appliance's brand/model/type.
 * Returns { available, source, candidates } — candidates are raw
 * federal records (trimmed), for STAFF eyes while curating.
 */
export async function lookupRecalls({ brand = null, model = null, type = null } = {}) {
  const key = cacheKey({ brand, model, type });
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const brandQ = String(brand || '').trim();
  const typeQ = String(type || '').trim();
  const modelQ = String(model || '').trim();
  const queries = [];
  // The feed searches titles/product names; run the most specific
  // queries it supports and merge. Brand is the strongest signal.
  if (brandQ) queries.push(new URLSearchParams({ RecallTitle: brandQ }));
  if (brandQ && typeQ) queries.push(new URLSearchParams({ ProductName: `${brandQ} ${typeQ}` }));
  if (!queries.length && typeQ) queries.push(new URLSearchParams({ RecallTitle: typeQ }));
  if (!queries.length && modelQ) queries.push(new URLSearchParams({ ProductName: modelQ }));

  const seen = new Map();
  let feedOk = false;
  for (const params of queries) {
    const rows = await fetchFeed(params);
    if (rows) feedOk = true;
    for (const row of rows || []) {
      if (row?.RecallID != null && !seen.has(row.RecallID)) seen.set(row.RecallID, row);
    }
  }

  if (!feedOk) {
    // Honest unavailability — and NOT cached, so a later retry can
    // succeed as soon as the feed is back.
    return { available: false, source: 'CPSC SaferProducts', candidates: [] };
  }

  let rows = [...seen.values()];
  if (brandQ) {
    const needle = brandQ.toLowerCase();
    rows = rows.filter((row) => recallText(row).includes(needle));
  }
  rows.sort((a, b) => String(b.RecallDate || '').localeCompare(String(a.RecallDate || '')));
  const value = {
    available: true,
    source: 'CPSC SaferProducts',
    candidates: rows.slice(0, MAX_RESULTS).map(toCandidate),
  };
  cache.set(key, { at: Date.now(), value });
  return value;
}
