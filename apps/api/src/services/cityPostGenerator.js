import { CITY_SPOTLIGHT_PAGES } from '../data/citySpotlightPages.js';

/**
 * City Posts generator (2026-11-23) — one CITY_SPOTLIGHT draft per
 * VERIFIED published landing page (data/citySpotlightPages.js: the
 * 124 pages of the Marketing OS published store that live-probed
 * HTTP 200 on 2026-11-23). Ramone directed 131 city posts; the
 * platform's coverage copy claims 131 pages, but the store of record
 * holds 124 and every one resolves — the generator builds for the
 * verified 124 and never pads to the claim (see the strategy doc).
 *
 * SMART ROTATION, NO DUPLICATE SPAM: city pages rotate the 9
 * canonical services round-robin and the 5 hook angles on an offset
 * stride, so neighbouring posts never share a service+angle pair
 * (the pair repeats only every 45 posts). Service pages speak for
 * their own service; symptom pages lead with their own symptom.
 *
 * FACTS ONLY, LOCKED (Launch Pack): $99 residential diagnostic,
 * collected at booking and credited toward an approved repair;
 * $210 flat repair labor; $150 flat installation labor; parts at
 * written quote; no work without an approved written quote;
 * Mon–Fri 8am–7pm; (844) 460-7038. Commercial pages are custom-quote
 * ONLY (no $99, no $210 — the diagnostic and flat labor are
 * residential). No reviews, ratings, statistics, superlatives, or
 * vent-cleaning prices/offers anywhere. Referral copy names the
 * program without dollar figures (the queue's copy sweep allows
 * only the rate-card numbers). Every post's link is its own page's
 * canonical URL (Rule 1). Copy stays inside the Facebook 1,024-char
 * post limit.
 *
 * VISUAL SPEC (Ramone, 2026-11-23: "visuals, symbols, icons,
 * numbers elements, shield and more"): each post carries a designed
 * graphic spec in its statusNote — a drawn service icon (never an
 * emoji), a rate-card number element, the shield (the written-quote
 * guarantee motif — the shield stands for that guarantee ONLY, no
 * invented warranties or certifications), racing symbols, and a
 * city-name lockup — rotating with the same stride as the copy.
 * The full kit is defined in city-posts-strategy-2026-11-23.md.
 *
 * This module is PURE (no repo, no I/O): the ingest service and the
 * manifest builder run the same code, so what is drilled is what
 * loads.
 */

export const CITY_POSTS_SERIES_KEY = 'city-spotlight';

const PHONE_LINE = 'Call (844) 460-7038 · Mon–Fri 8am–7pm';
const SIGN_OFF = '— Top Speed Posts by Pepper · The Faster, The Better.';
const SURFACE_NOTE = 'Surface: Facebook Page primary; Instagram-ready copy (Instagram is not connected — nothing auto-posts there).';

const FACTS_REPAIR = 'Straightforward pricing: the residential diagnostic is $99, collected at booking and credited in full toward your approved repair. Repair labor is a flat $210, parts are priced in a written quote, and no work starts without your approved written quote.';
const FACTS_INSTALL = 'Straightforward pricing: installation labor is a flat $150, parts and materials are priced in a written quote, and no work starts without your approved written quote.';
const FACTS_COMMERCIAL = 'Commercial pricing is by custom written quote under a service agreement — no work starts without your approved written quote.';

/** The canonical 9 (config/marketingTaxonomy.js order) + copy parts. */
const CANONICAL = {
  'refrigerator-repair': {
    name: 'Refrigerator', noun: 'refrigerator', icon: 'icon-refrigerator',
    symptoms: 'frost taking over the freezer, food not staying cold, or an ice maker that quit',
    seasonal: 'when South Florida heat and humidity climb, a refrigerator runs its longest hours of the year',
  },
  'washer-repair': {
    name: 'Washer', noun: 'washer', icon: 'icon-washer',
    symptoms: 'standing water after the cycle, a drum that will not spin, or a leak underneath',
    seasonal: 'when rainy-season laundry piles up, a washer earns every cycle',
  },
  'dryer-repair': {
    name: 'Dryer', noun: 'dryer', icon: 'icon-dryer',
    symptoms: 'clothes still damp after a full cycle, or a drum that tumbles loud',
    seasonal: 'in South Florida\u2019s humid months, a dryer that needs two cycles is telling you something',
    seasonalStandalone: true,
  },
  'oven-range-repair': {
    name: 'Oven/Range', noun: 'oven or range', icon: 'icon-oven-range',
    symptoms: 'uneven baking, a burner that will not light, or an error code on the display',
    seasonal: 'when holiday cooking season arrives, ranges and ovens carry the whole meal',
  },
  'dishwasher-repair': {
    name: 'Dishwasher', noun: 'dishwasher', icon: 'icon-dishwasher',
    symptoms: 'water left in the tub, a puddle at the door, or dishes coming out dirty',
    seasonal: 'when holiday hosting fills the sink, the dishwasher runs overtime',
  },
  'freezer-ice-maker-repair': {
    name: 'Freezer/Ice Maker', noun: 'freezer or ice maker', icon: 'icon-freezer-ice',
    symptoms: 'no ice, frost climbing the walls, or food going soft',
    seasonal: 'when hurricane-season stock-ups fill the freezer, holding temperature is the whole job',
  },
  'microwave-repair': {
    name: 'Microwave', noun: 'microwave', icon: 'icon-microwave',
    symptoms: 'food coming out cold, or a turntable that stopped turning',
    seasonal: 'when back-to-school season puts quick meals on repeat, the microwave never rests',
  },
  'garbage-disposal-repair': {
    name: 'Garbage Disposal', noun: 'garbage disposal', icon: 'icon-disposal',
    symptoms: 'a hum with no grind, a slow drain at the sink, or a drip underneath',
    seasonal: 'when holiday cooking sends more down the sink than any other month, disposals work hardest',
    seasonalStandalone: true,
  },
  'appliance-installation': {
    name: 'Installation', noun: 'appliance installation', icon: 'icon-installation',
    symptoms: 'a new appliance sitting in its box, or an old hookup that does not match the new unit',
    seasonal: 'when a new appliance lands during a remodel or a move, the install is the step that makes it real',
    seasonalStandalone: true,
  },
};
const CANONICAL_ORDER = Object.keys(CANONICAL);

const SYMPTOM_EXPLAINERS = {
  'not-cooling': 'a cooling problem can trace to airflow, frost build-up or a failing fan — the exact cause takes an on-site check',
  'not-draining': 'standing water usually traces to the drain path or the pump — the exact cause takes an on-site check',
  'not-heating': 'a heating problem usually traces to the element, the igniter or the controls — the exact cause takes an on-site check',
  leaking: 'a leak\u2019s source matters more than its size — seals, hoses and valves are the usual suspects, confirmed on site',
  'error-codes': 'an error code narrows the fault to one system — a technician confirms which part on site',
  'unusual-noises': 'a new noise usually means a moving part is wearing — motors, bearings and fans are the usual suspects, confirmed on site',
  'no-ice': 'no ice usually traces to the water supply, the fill system or temperature — the exact cause takes an on-site check',
};

export const HOOKS = ['SYMPTOM_LED', 'PROCESS_TRUST', 'SEASONAL', 'REFERRAL', 'SPEEDY_PHOTO'];
const SERVICE_PAGE_HOOKS = ['PROCESS_TRUST', 'SEASONAL', 'SPEEDY_PHOTO', 'REFERRAL'];

const SHIELD_PLACEMENTS = ['closing-line', 'graphic-corner', 'lockup-side'];
const SYMBOL_SETS = [
  'speed-stripes + roundel-7',
  'checkered-flag + speed-stripes',
  'checker-hem + roundel-7',
  'speed-stripes + checkered-flag',
];
const REPAIR_NUMBER_BY_HOOK = {
  SYMPTOM_LED: 'num-99-roundel',
  PROCESS_TRUST: 'num-trio-lockup',
  SEASONAL: 'num-99-roundel',
  REFERRAL: 'num-trio-lockup',
  SPEEDY_PHOTO: 'num-210-block',
};

function factsFor(page, svc) {
  if (page.commercial) return FACTS_COMMERCIAL;
  if (page.installation || svc === CANONICAL['appliance-installation']) return FACTS_INSTALL;
  return FACTS_REPAIR;
}

function numberElementFor(page, svc, hook) {
  if (page.commercial) return 'num-none (custom quote — the shield carries the price story)';
  if (page.installation || svc === CANONICAL['appliance-installation']) {
    return hook === 'PROCESS_TRUST' ? 'num-trio-lockup' : 'num-150-block';
  }
  return REPAIR_NUMBER_BY_HOOK[hook];
}

function visualSpec({ icon, numberEl, shield, symbols, lockup, hook }) {
  return `Visual spec: icon ${icon} · number ${numberEl} · shield ${shield} (written-quote guarantee) · symbols ${symbols} · lockup ${lockup}. Angle: ${hook}. ${SURFACE_NOTE}`;
}

function closeBlock(placeLabel, url) {
  return `See how it works on the ${placeLabel} page:\n${url}\n${PHONE_LINE}\n${SIGN_OFF}`;
}

function hookCopy(hook, { place, svc, facts, url }) {
  const n = svc.noun;
  switch (hook) {
    case 'SYMPTOM_LED':
      return `${place} — signs your ${n} needs a technician: ${svc.symptoms}. Problems like these rarely fix themselves, and guessing at parts gets expensive. Our technician checks it on site and tells you exactly what it needs before any work begins.\n\n${facts}\n\n${closeBlock(place, url)}`;
    case 'PROCESS_TRUST':
      return `How appliance work runs in ${place} — the Top Speed way: you book in about a minute, a Service Setter confirms your appointment, and a technician diagnoses your ${n} on site. You approve a written quote first — nothing is repaired on a handshake or a guess.\n\n${facts}\n\n${closeBlock(place, url)}`;
    case 'SEASONAL':
      return svc.seasonalStandalone
        ? `${place} — ${svc.seasonal}. If yours is due for attention, this is the week to handle it, before a small symptom becomes a dead appliance and a bigger bill.\n\n${facts}\n\n${closeBlock(place, url)}`
        : `${place} — ${svc.seasonal}. If your ${n} is showing its age, this is the week to handle it, before a small symptom becomes a dead appliance and a bigger bill.\n\n${facts}\n\n${closeBlock(place, url)}`;
    case 'REFERRAL':
      return `Good neighbors tell each other who to call. ${place} — if Top Speed has taken care of your ${n}, referring a neighbor earns you credit toward your next repair once their job is complete, and they save on their first repair too. Hearing about us from a neighbor right now? Start here:\n\n${facts}\n\n${closeBlock(place, url)}`;
    case 'SPEEDY_PHOTO':
      return `Not sure what is wrong with your ${n}, ${place}? Snap a photo and ask Speedy — the assistant on the ${place} page. Describe the symptom or send the picture, and Speedy helps you figure out the next step and get booked. Prefer a person? The same page reaches our Service Setters.\n\n${facts}\n\n${closeBlock(place, url)}`;
    default:
      throw new Error(`Unknown hook: ${hook}`);
  }
}

function buildCityPost(page, index) {
  const svc = CANONICAL[CANONICAL_ORDER[index % CANONICAL_ORDER.length]];
  const hook = HOOKS[(index + Math.floor(index / CANONICAL_ORDER.length)) % HOOKS.length];
  const facts = factsFor(page, svc);
  const title = svc === CANONICAL['appliance-installation']
    ? `City Spotlight: Appliance Installation in ${page.city}`
    : `City Spotlight: ${svc.name} Repair in ${page.city}`;
  return {
    seriesKey: CITY_POSTS_SERIES_KEY,
    format: 'CITY_SPOTLIGHT',
    title,
    copy: hookCopy(hook, { place: page.city, svc, facts, url: page.url }),
    linkUrl: page.url,
    statusNote: visualSpec({
      icon: svc.icon,
      numberEl: numberElementFor(page, svc, hook),
      shield: SHIELD_PLACEMENTS[index % SHIELD_PLACEMENTS.length],
      symbols: SYMBOL_SETS[index % SYMBOL_SETS.length],
      lockup: `city-name '${page.city.toUpperCase()}' + service line '${svc.name}'`,
      hook,
    }),
    manifest: { city: page.city, service: svc.name, hook, pageSlug: page.slug, url: page.url },
  };
}

function serviceParts(page) {
  if (CANONICAL[page.serviceSlug]) return CANONICAL[page.serviceSlug];
  if (page.installation) {
    // e.g. "Washer Installation": the Installation icon/kit, the
    // appliance noun from the page's own service name.
    const base = page.service.replace(/ Installation$/, '');
    return {
      ...CANONICAL['appliance-installation'],
      name: page.service,
      noun: base.toLowerCase(),
      symptoms: `a new ${base.toLowerCase()} delivered but not hooked up, or an old hookup that does not match the new unit`,
    };
  }
  if (page.commercial) {
    return {
      name: page.service,
      noun: page.service.toLowerCase(),
      icon: 'icon-commercial',
      symptoms: 'a machine down during service hours, or one that runs but no longer holds its standard',
      seasonal: 'when the busy season fills Broward County kitchens, hotels and laundry rooms, a down machine costs more than the repair',
      seasonalStandalone: true,
    };
  }
  return {
    name: page.service, noun: page.service.toLowerCase(), icon: 'icon-installation',
    symptoms: 'a problem that will not wait for a convenient week',
    seasonal: 'when the season turns, appliances work their hardest',
  };
}

function buildServicePost(page, index) {
  const svc = serviceParts(page);
  const facts = factsFor(page, svc);
  if (page.kind === 'SYMPTOM') {
    const explainer = SYMPTOM_EXPLAINERS[page.symptomSlug] || 'the exact cause takes an on-site check';
    const title = `City Spotlight: ${svc.name} — ${page.symptom} (Broward County)`;
    const copy = `${svc.name} ${page.symptom.toLowerCase()} in Broward County? ${explainer[0].toUpperCase()}${explainer.slice(1)}. Guessing at parts gets expensive; a written quote comes first, every time.\n\n${facts}\n\n${closeBlock('Broward County', page.url)}`;
    return {
      seriesKey: CITY_POSTS_SERIES_KEY,
      format: 'CITY_SPOTLIGHT',
      title,
      copy,
      linkUrl: page.url,
      statusNote: visualSpec({
        icon: svc.icon,
        numberEl: numberElementFor(page, svc, 'SYMPTOM_LED'),
        shield: SHIELD_PLACEMENTS[index % SHIELD_PLACEMENTS.length],
        symbols: SYMBOL_SETS[index % SYMBOL_SETS.length],
        lockup: `service-name '${svc.name.toUpperCase()}' + symptom line '${page.symptom}'`,
        hook: 'SYMPTOM_LED',
      }),
      manifest: { city: 'Broward County', service: svc.name, hook: 'SYMPTOM_LED', pageSlug: page.slug, url: page.url },
    };
  }
  const hook = SERVICE_PAGE_HOOKS[index % SERVICE_PAGE_HOOKS.length];
  const title = `City Spotlight: ${svc.name} — Broward County`;
  return {
    seriesKey: CITY_POSTS_SERIES_KEY,
    format: 'CITY_SPOTLIGHT',
    title,
    copy: hookCopy(hook, { place: 'Broward County', svc, facts, url: page.url }),
    linkUrl: page.url,
    statusNote: visualSpec({
      icon: svc.icon,
      numberEl: numberElementFor(page, svc, hook),
      shield: SHIELD_PLACEMENTS[index % SHIELD_PLACEMENTS.length],
      symbols: SYMBOL_SETS[index % SYMBOL_SETS.length],
      lockup: `service-name '${svc.name.toUpperCase()}' + county line 'BROWARD COUNTY'`,
      hook,
    }),
    manifest: { city: 'Broward County', service: svc.name, hook, pageSlug: page.slug, url: page.url },
  };
}

/**
 * The full generated set: one post input per verified page, in the
 * baked list's order (cities, then service pages, then symptom
 * pages). Each item is a createStreamPost input plus a `manifest`
 * block the queue record does not store (city/service/hook/slug).
 */
export function buildCityPosts() {
  const posts = [];
  let cityIndex = 0;
  let serviceIndex = 0;
  for (const page of CITY_SPOTLIGHT_PAGES) {
    if (page.kind === 'CITY') {
      posts.push(buildCityPost(page, cityIndex));
      cityIndex += 1;
    } else {
      posts.push(buildServicePost(page, serviceIndex));
      serviceIndex += 1;
    }
  }
  return posts;
}
