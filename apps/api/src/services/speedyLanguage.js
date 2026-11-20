/**
 * Speedy language support — Spanish (2026-11-20, recommendation A5).
 *
 * Dependency-free on purpose: the chat service, the governance
 * pre-screen, and the knowledge fallback all import from here, and
 * none of them may pull the others in through this module.
 *
 * Design: deterministic detection, no extra provider call. A chat
 * turn is Spanish when the customer writes Spanish (function words,
 * diacritics, trade vocabulary) or the client explicitly says so
 * (the /es/ pages pass language: 'es'). Once a conversation is in
 * Spanish it stays in Spanish through short continuations ("33313",
 * "el martes") until the customer clearly switches back to English.
 * English behavior is byte-identical to before when nothing Spanish
 * is detected.
 */

// Spanish function words — near-zero presence in ordinary English.
const ES_FUNCTION_WORDS = new Set([
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'de', 'del',
  'en', 'que', 'mi', 'mis', 'es', 'está', 'están', 'no', 'sí', 'por',
  'para', 'con', 'sin', 'su', 'sus', 'al', 'lo', 'le', 'les', 'me',
  'te', 'se', 'y', 'o', 'pero', 'porque', 'cuando', 'cuánto', 'cuesta',
  'cuándo', 'dónde', 'cómo', 'qué', 'quiero', 'necesito', 'tengo',
  'hola', 'gracias', 'buenas', 'buenos', 'buen', 'día', 'días',
  'tarde', 'tardes', 'noche', 'noches', 'favor', 'puede', 'puedo',
  'tiene', 'hace', 'hay', 'muy', 'más', 'también', 'ahora', 'hoy',
]);

// Spanish trade / booking vocabulary — strong single-word signals.
const ES_CONTENT_WORDS = new Set([
  'refrigerador', 'nevera', 'lavadora', 'secadora', 'horno', 'estufa',
  'lavavajillas', 'lavaplatos', 'congelador', 'microondas', 'triturador',
  'electrodoméstico', 'electrodomésticos', 'reparación', 'reparar',
  'arreglar', 'instalación', 'instalar', 'diagnóstico', 'cita',
  'reservar', 'reserva', 'agendar', 'garantía', 'fuga', 'gotea',
  'enfría', 'enfriar', 'ruido', 'precio', 'costo', 'cuesta', 'servicio',
  'técnico', 'visita', 'cocina', 'baño', 'casa', 'departamento',
]);

const EN_FUNCTION_WORDS = new Set([
  'the', 'is', 'are', 'my', 'it', 'does', 'do', 'you', 'your', 'and',
  'to', 'of', 'for', 'in', 'on', 'with', 'can', 'could', 'would',
  'what', 'when', 'where', 'why', 'how', 'much', 'please', 'thanks',
]);

function wordSet(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .replace(/[¿?¡!.,;:()"']/g, ' ')
      .split(/\s+/)
      .filter(Boolean),
  );
}

/**
 * True when a single message reads as Spanish. Conservative: it takes
 * a diacritic plus a function word, two distinct function words, or a
 * trade word plus any other signal — a lone borrowed word in an
 * English sentence does not flip the conversation.
 */
export function detectSpanish(text) {
  const raw = String(text || '');
  if (!raw.trim()) return false;
  const words = wordSet(raw);
  let functionHits = 0;
  let contentHits = 0;
  for (const word of words) {
    if (ES_FUNCTION_WORDS.has(word)) functionHits += 1;
    if (ES_CONTENT_WORDS.has(word)) contentHits += 1;
  }
  const hasDiacritic = /[áéíóúñü]/.test(raw.toLowerCase()) || /[¿¡]/.test(raw);
  if (hasDiacritic && (functionHits >= 1 || contentHits >= 1)) return true;
  if (functionHits >= 2) return true;
  if (contentHits >= 1 && functionHits >= 1) return true;
  return false;
}

/** True when a message clearly reads as English (a switch back). */
function detectEnglish(text) {
  const words = wordSet(text);
  let hits = 0;
  for (const word of words) if (EN_FUNCTION_WORDS.has(word)) hits += 1;
  return hits >= 3 && !detectSpanish(text);
}

/**
 * Resolve the conversation language for one chat turn.
 * `language` is the client's explicit hint ('es' from the Spanish
 * pages) — it wins. Otherwise: this message decides; a short
 * continuation inherits the language of recent customer turns; a
 * clear English message switches back.
 */
export function resolveChatLanguage({ message, history = [], language } = {}) {
  if (language === 'es') return 'es';
  if (language === 'en') return 'en';
  if (detectSpanish(message)) return 'es';
  if (detectEnglish(message)) return 'en';
  const userTurns = (Array.isArray(history) ? history : [])
    .filter((turn) => turn?.role === 'user')
    .slice(-3);
  if (userTurns.some((turn) => detectSpanish(turn.content))) return 'es';
  return 'en';
}

/**
 * Retrieval help ONLY (never displayed): Spanish questions match the
 * English knowledge base poorly, so the search query is augmented
 * with the English trade terms the Spanish words map to. Matching
 * rules in the knowledge layer are unchanged.
 */
const ES_SEARCH_TERMS = [
  [/refrigerador|nevera|frigor[ií]fico/i, 'refrigerator'],
  [/lavadora/i, 'washer'],
  [/secadora/i, 'dryer'],
  [/\bhorno\b|estufa|cocina de/i, 'oven range'],
  [/lavavajillas|lavaplatos/i, 'dishwasher'],
  [/congelador|hielera|hielo/i, 'freezer ice maker'],
  [/microondas/i, 'microwave'],
  [/triturador/i, 'garbage disposal'],
  [/instalaci[oó]n|instalar/i, 'installation'],
  [/diagn[oó]stico/i, 'diagnostic'],
  [/precio|cuesta|cuesta|cu[aá]nto (cuesta|vale|es)|costo/i, 'price cost how much'],
  [/cita|reservar|reserva|agendar/i, 'book booking appointment'],
  [/garant[ií]a/i, 'warranty'],
  [/fuga|gotea|goteando/i, 'leaking leak'],
  [/no enfr[ií]a|no congela/i, 'not cooling'],
  [/ruido|suena/i, 'noise noises'],
  [/reparaci[oó]n|reparar|arreglar/i, 'repair'],
  [/cobertura|atienden|zona|área de servicio|ciudad/i, 'service area cities coverage'],
  [/reembolso|devoluci[oó]n/i, 'refund'],
  [/ventila|conducto|secadora.*vent/i, 'dryer vent cleaning'],
];

export function augmentSpanishQuery(text) {
  const value = String(text || '');
  const additions = [];
  for (const [pattern, english] of ES_SEARCH_TERMS) {
    if (pattern.test(value)) additions.push(english);
  }
  return additions.length ? `${value} ${additions.join(' ')}` : value;
}

/**
 * The instruction block appended to Speedy's system prompt for a
 * Spanish conversation. It changes the ANSWER LANGUAGE only — every
 * rule in the standing prompt (grounded facts, governance, the
 * collect → summarize → confirm booking flow) applies unchanged.
 */
export const SPANISH_SYSTEM_DIRECTIVE = [
  'LANGUAGE — SPANISH (2026-11-20): the customer is writing in Spanish. Reply entirely in Spanish — clear, neutral Latin American Spanish as spoken in South Florida — in the same friendly, plain style. Every rule above still applies exactly: state Top Speed facts only from your knowledge (prices, phone, hours, coverage), never invent a fact, and keep figures, the phone number (844) 460-7038, links, and city names exactly as written.',
  'Booking flow in Spanish: collect the same details step by step (nombre, teléfono, ciudad, código postal, electrodoméstico, y qué problema tiene). When you have them all, summarize them back clearly IN SPANISH and tell the customer the Service Setters team will confirm the appointment — the customer still confirms the summary before anything is sent to the office, exactly as in English. Never promise a specific arrival time.',
  'If the customer switches to English, switch with them. If a problem sounds unsafe (gas, sparks, flooding), put safety first in Spanish: stop using the appliance and stay safe, before anything else.',
].join('\n');
