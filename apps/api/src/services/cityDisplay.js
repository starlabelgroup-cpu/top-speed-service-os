import { PUBLISHED_CITY_NAMES } from '../config/serviceAreas.js';
import { EXPANSION_RING2_CITIES } from '../data/expansionCities.js';

/**
 * Public-display city names (2026-11-23, Step 1 audit fix).
 *
 * A booking's city is stored as free text exactly as it was entered,
 * and public surfaces (the homepage "Just fixed" feed) print it
 * verbatim — so one misspelled record ("lauderrhill") prints its typo
 * to every visitor. This normalizer is a DISPLAY layer only: it never
 * writes back to the record. It renders the stored value in clean
 * title case, and when the value clearly matches a canonical city —
 * exactly, ignoring case/spacing/punctuation, or with a small typo —
 * it renders the canonical spelling instead. A value that matches
 * nothing renders title-cased but otherwise unchanged: real jobs are
 * never hidden or renamed into a city they did not state.
 */

const CANONICAL_CITIES = [
  ...PUBLISHED_CITY_NAMES,
  ...EXPANSION_RING2_CITIES.map((c) => c.name),
];

function keyOf(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactOf(value) {
  return keyOf(value).replace(/\s/g, '');
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

function titleCase(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .split(/([\s-]+)/)
    .map((part) => (part && /[a-z]/.test(part[0]) ? part[0].toUpperCase() + part.slice(1) : part))
    .join('');
}

const CANONICAL_BY_KEY = new Map(CANONICAL_CITIES.map((name) => [keyOf(name), name]));
const CANONICAL_BY_COMPACT = new Map(CANONICAL_CITIES.map((name) => [compactOf(name), name]));
const CANONICAL_COMPACTS = CANONICAL_CITIES.map((name) => ({ name, compact: compactOf(name) }));

export function displayCity(raw) {
  if (raw == null) return raw;
  const wanted = keyOf(raw);
  if (!wanted) return raw;

  const exact = CANONICAL_BY_KEY.get(wanted);
  if (exact) return exact;

  const squashed = CANONICAL_BY_COMPACT.get(compactOf(raw));
  if (squashed) return squashed;

  // Typo tolerance: a unique canonical city within a small edit
  // distance of the stored value (1 edit for short names, 2 for long
  // ones — "lauderrhill" is 1 edit from "Lauderhill"). A tie between
  // two cities is not a clear match and falls through unchanged.
  const compact = compactOf(raw);
  let best = null;
  let bestDistance = Infinity;
  let bestCount = 0;
  for (const { name, compact: candidate } of CANONICAL_COMPACTS) {
    const limit = candidate.length >= 8 ? 2 : candidate.length >= 5 ? 1 : 0;
    if (!limit) continue;
    const distance = levenshtein(compact, candidate);
    if (distance > limit) continue;
    if (distance < bestDistance) {
      best = name;
      bestDistance = distance;
      bestCount = 1;
    } else if (distance === bestDistance) {
      bestCount += 1;
    }
  }
  if (best && bestCount === 1) return best;

  return titleCase(raw);
}
