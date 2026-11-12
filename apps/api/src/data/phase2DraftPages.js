/**
 * Top Speed Marketing OS — Phase 2 draft landing pages (Fusion absorb,
 * 2026-11-12).
 *
 * The first page batch for the Page Studio, built from the pruned
 * Fusion SEO inventory (see ~/workspace/fusion-intake/INTEGRATION-MAP.md):
 *   - CITY pages for the 12 service-covered cities (blueprint §4 scheme:
 *     /service-areas/<city>/)
 *   - SERVICE pages for the two Fusion prefixes that map exactly onto
 *     taxonomy services (commercial-appliance-repair,
 *     appliance-installation) at /services/<service>/
 *   - Symptom pages for the five Fusion symptom URLs that map cleanly
 *     onto a taxonomy service + symptom, nested under their service:
 *     /services/<service>/<symptom>/
 *
 * Deliberately NOT here (Ramone decisions, per the map §5/§6):
 * dryer-vent-cleaning and appliance-delivery (not platform services),
 * oven-overheating (not a taxonomy symptom), all 21 out-of-area cities,
 * and the 3 expansion cities (publish guard refuses them regardless).
 *
 * Pure data, no imports — consumed by prisma/seed.mjs, which creates
 * each page ONLY when its canonicalUrl is not already present, always
 * as IN_REVIEW. Nothing in this module can publish a page, and
 * reseeding never touches an existing page (Studio edits, reviews and
 * status changes survive).
 *
 * Copy rules: no invented reviews, ratings, or statistics; residential
 * repair carries the locked $99 diagnostic terms (collected at booking,
 * credited toward the repair); commercial is custom-quote only; a
 * technician confirms every diagnosis on site.
 */

export const PHASE2_SITE_BASE = 'https://topspeedappliance.net';

const PHONE = '954-931-7997';

function ctaBlock(heading, body) {
  return { type: 'cta', heading, body, phone: PHONE };
}

function diagnosticTermsBlock() {
  return {
    type: 'service-terms',
    heading: 'Straightforward pricing',
    body: 'Residential service starts with a $99 diagnostic, collected at booking and credited toward your repair when you approve it. You approve the repair quote before any repair work begins — no surprises.',
  };
}

function trackingFaq() {
  return {
    q: 'Can I track my technician?',
    a: 'Yes. Every booking gets a secure Track My Tech link with the live stages of your job, and a map pin when your technician is en route and sharing location.',
  };
}

// ─── City pages ─────────────────────────────────────────────────────
// One genuinely local paragraph per city — housing stock and setting
// differ, and so does the copy. No statistics are claimed anywhere.

const CITY_PAGES = [
  {
    slug: 'fort-lauderdale',
    name: 'Fort Lauderdale',
    meta: 'Appliance repair in Fort Lauderdale, FL — coastal condos and waterfront homes included. Book online, get a confirmation call, track your technician live. $99 diagnostic credited toward repair.',
    hero: 'From waterfront homes and high-rise condos to older inland neighborhoods, Fort Lauderdale appliances work hard in coastal humidity and salt air — and they tend to fail at the worst moments. Top Speed Appliance repairs them in place: book in about a minute, get a confirmation call from a Service Setter, and follow your technician with Track My Tech.',
    faqLocal: {
      q: 'Do you repair appliances in Fort Lauderdale condos?',
      a: 'Yes — we service condos, townhomes, and single-family homes across Fort Lauderdale. When you book, tell us about parking, elevators, or gate access and your technician arrives prepared.',
    },
  },
  {
    slug: 'coral-springs',
    name: 'Coral Springs',
    meta: 'Appliance repair in Coral Springs, FL, from the locally based Top Speed Appliance team. Online booking, Service Setter confirmation, live tracking — $99 diagnostic credited toward your repair.',
    hero: 'Coral Springs is a master-planned city of family neighborhoods, and many of its homes are reaching the age where the original washer, dryer, and refrigerator all start asking for attention at once. Top Speed Appliance is based right here — our office is in Coral Springs — so local bookings get the full platform: online booking, a Service Setter confirmation call, and live job tracking.',
    faqLocal: {
      q: 'Are you actually based in Coral Springs?',
      a: 'Yes. Top Speed Appliance LLC operates from Coconut Creek / Coral Springs, and Coral Springs is one of our twelve covered Broward service cities.',
    },
  },
  {
    slug: 'plantation',
    name: 'Plantation',
    meta: 'Appliance repair in Plantation, FL — refrigerators, washers, dryers, ovens and dishwashers diagnosed on site. Book in a minute; $99 diagnostic credited toward your repair.',
    hero: 'Plantation mixes established neighborhoods with newer family subdivisions, and its kitchens and laundry rooms see daily family use. When a refrigerator stops cooling or a washer quits mid-cycle, Top Speed Appliance sends a technician who diagnoses it on site — you approve the repair quote before any work begins.',
    faqLocal: {
      q: 'Which appliances do you repair in Plantation?',
      a: 'Refrigerators, washers, dryers, ovens and ranges, dishwashers, freezers and ice makers, microwaves, garbage disposals, and appliance installations — residential and commercial.',
    },
  },
  {
    slug: 'sunrise',
    name: 'Sunrise',
    meta: 'Appliance repair in Sunrise, FL with confirmed two-hour booking windows and live job tracking. $99 diagnostic collected at booking, credited toward your repair.',
    hero: 'Sunrise homes — from the neighborhoods around Sawgrass Mills to the quieter western streets — run their appliances constantly in the Florida heat. Top Speed Appliance keeps Sunrise households running with booked-online service, a real confirmation call, and a tracked technician, so a broken dryer or a warm fridge is a scheduling problem, not a week-long ordeal.',
    faqLocal: {
      q: 'How fast can I get an appointment in Sunrise?',
      a: 'Booking windows run across the day in two-hour blocks. Book online or with Speedy AI, and a Service Setter confirms the exact window by phone.',
    },
  },
  {
    slug: 'lauderhill',
    name: 'Lauderhill',
    meta: 'Appliance repair in Lauderhill, FL — homes, townhomes and 55+ communities served. Book online or with Speedy AI; $99 diagnostic credited toward your repair.',
    hero: 'Lauderhill\'s mix of single-family homes, townhomes, and 55+ condo communities means a lot of hard-working appliances — and a lot of laundry rooms and kitchens that can\'t wait a week for service. Top Speed Appliance covers Lauderhill with the same promise as everywhere we serve: book fast, get a confirmation call, and track your job live.',
    faqLocal: {
      q: 'Do you service 55+ communities in Lauderhill?',
      a: 'Yes. Let us know the community name and any gate or check-in requirements when you book, and your technician will have them on the job notes.',
    },
  },
  {
    slug: 'lauderdale-lakes',
    name: 'Lauderdale Lakes',
    meta: 'Appliance repair in Lauderdale Lakes, FL — condo communities and single-family homes. On-site diagnosis, a quote you approve first, $99 diagnostic credited toward repair.',
    hero: 'Lauderdale Lakes is dense with condo communities and single-family homes whose appliances were often installed in the same era — when one neighbor\'s dryer goes, yours may be next. Top Speed Appliance serves Lauderdale Lakes with on-site diagnosis, a quote you approve first, and repairs tracked from request to completion.',
    faqLocal: {
      q: 'My condo association needs paperwork — can you help?',
      a: 'Tell us what your association requires when you book (insurance certificate, vehicle info, check-in rules) and we will coordinate it with your appointment.',
    },
  },
  {
    slug: 'north-lauderdale',
    name: 'North Lauderdale',
    meta: 'Appliance repair in North Lauderdale, FL — straightforward terms: $99 diagnostic at booking, credited toward your repair, with a confirmation call and live tracking on every job.',
    hero: 'North Lauderdale\'s family neighborhoods and condo communities keep their washers, dryers, and refrigerators running around the clock. Top Speed Appliance brings North Lauderdale the full service platform — online and Speedy AI booking, Service Setter confirmation, and Track My Tech — at the same straightforward terms as the rest of Broward.',
    faqLocal: {
      q: 'What does a repair visit cost in North Lauderdale?',
      a: 'Residential service starts with a $99 diagnostic, collected at booking and credited toward your repair when you approve the quote. Commercial work is priced by custom quote.',
    },
  },
  {
    slug: 'tamarac',
    name: 'Tamarac',
    meta: 'Appliance repair in Tamarac, FL — patient, confirmed appointments for 55+ communities and family neighborhoods. $99 diagnostic credited toward your repair.',
    hero: 'Tamarac is home to many 55+ communities alongside family neighborhoods, and reliable appliances matter — a leaking dishwasher or a dead refrigerator can\'t sit for days. Top Speed Appliance serves Tamarac with patient, confirmed appointments: you book, a Service Setter calls to confirm, and you can follow every stage of the job.',
    faqLocal: {
      q: 'Can someone else be home for the appointment?',
      a: 'Yes — an adult just needs to be present. Note who will meet the technician when you book, and we will confirm those details on the setter call.',
    },
  },
  {
    slug: 'davie',
    name: 'Davie',
    meta: 'Appliance repair in Davie, FL — high-capacity laundry and commercial-grade kitchens included. Book online, track your technician, $99 diagnostic credited toward repair.',
    hero: 'Davie\'s western, equestrian character means larger homes, bigger lots, and plenty of heavy-duty laundry — muddy riding gear will test any washer. Top Speed Appliance repairs Davie\'s appliances on site, from high-capacity laundry pairs to commercial-grade kitchen equipment, with the same booked-confirmed-tracked process as the rest of our Broward coverage.',
    faqLocal: {
      q: 'Do you repair high-capacity and heavy-duty laundry machines?',
      a: 'Yes — large-capacity residential washers and dryers are part of our standard washer and dryer repair service. Tell us the brand and model when you book if you have them.',
    },
  },
  {
    slug: 'pompano-beach',
    name: 'Pompano Beach',
    meta: 'Appliance repair in Pompano Beach, FL — salt-air wear diagnosed on site, no hauling to a shop. Book online; $99 diagnostic credited toward your repair.',
    hero: 'Pompano Beach homes and condos live with salt air, which is quietly hard on appliance electronics, hinges, and finishes. When corrosion or plain hard use catches up, Top Speed Appliance diagnoses the appliance where it stands — no hauling it to a shop — and you approve the repair quote before work begins.',
    faqLocal: {
      q: 'Does salt air really damage appliances?',
      a: 'It can accelerate corrosion on exposed metal and electronics, especially near the coast. If a control board or sensor fails early, your technician will show you what they found during the diagnosis.',
    },
  },
  {
    slug: 'oakland-park',
    name: 'Oakland Park',
    meta: 'Appliance repair in Oakland Park, FL — older ranges and smart fridges alike, diagnosed on site with a quote you approve first. $99 diagnostic credited toward repair.',
    hero: 'Oakland Park is changing fast — renovated older homes and new builds side by side, with appliances from every era in between. Top Speed Appliance works on all of them: a thirty-year-old range and a brand-new smart refrigerator get the same careful on-site diagnosis and an approved-before-repair quote.',
    faqLocal: {
      q: 'Do you work on older appliances?',
      a: 'Yes. Age alone doesn\'t decide — during the $99 diagnostic your technician checks condition and parts availability and tells you plainly whether repair makes sense.',
    },
  },
  {
    slug: 'margate',
    name: 'Margate',
    meta: 'Appliance repair in Margate, FL — confirmed two-hour windows and live tracking so you always know where your repair stands. $99 diagnostic credited toward repair.',
    hero: 'Margate\'s family neighborhoods and condo communities deserve appliance service that shows up when it says it will. Top Speed Appliance serves Margate with confirmed two-hour booking windows, a technician dispatched through Book OS, and live tracking — so you are never left wondering where your repair stands.',
    faqLocal: {
      q: 'How do booking windows work in Margate?',
      a: 'Choose a two-hour window when you book (mornings through late afternoon). A Service Setter confirms by phone, and Track My Tech shows your job\'s stage as the day progresses.',
    },
  },
];

function citySections(city) {
  return [
    {
      type: 'hero',
      heading: `Appliance Repair in ${city.name}`,
      body: city.hero,
      primaryCta: 'Book Service',
      secondaryCta: 'Call Top Speed',
      tertiaryCta: 'Ask Speedy AI',
    },
    {
      type: 'intro',
      heading: `How booking works in ${city.name}`,
      body: `Book online in about a minute or describe the problem to Speedy AI — including a photo for diagnosis. A Service Setter then confirms your ${city.name} appointment by phone, and your technician is dispatched through Book OS. You approve the repair quote on site before any repair begins.`,
    },
    diagnosticTermsBlock(),
    {
      type: 'faq',
      heading: `${city.name} questions`,
      items: [
        city.faqLocal,
        {
          q: 'How do I book?',
          a: 'Book online, call 954-931-7997, or ask Speedy AI. A Service Setter confirms every appointment by phone.',
        },
        trackingFaq(),
      ],
    },
    ctaBlock(
      `Book your ${city.name} repair`,
      `Top Speed Appliance serves ${city.name} and all twelve Broward service cities. One booking, one confirmation call, one tracked job.`,
    ),
  ];
}

// ─── Service pages (Fusion prefixes that map exactly) ───────────────

function commercialSections() {
  return [
    {
      type: 'hero',
      heading: 'Commercial Appliance Repair in Broward County',
      body: 'A down walk-in, a dead laundry machine, or a failed range line costs a business money by the hour. Appliance Pro Commercial Accounts — under Top Speed Appliance LLC — gives Broward restaurants, hotels, laundromats, healthcare facilities, offices, and property operations one accountable repair network, with work orders dispatched through the same Book OS platform as our residential service.',
      primaryCta: 'Request a Commercial Account',
      secondaryCta: 'Call Top Speed',
      tertiaryCta: 'Ask Speedy AI',
    },
    {
      type: 'intro',
      heading: 'Built for facilities, not one-off calls',
      body: 'Commercial accounts register their equipment — asset tags, serials, warranty and health status — so every request starts with the machine\'s history in front of the technician. Work orders flow into the Book OS setter queue tagged COMMERCIAL, and critical equipment on a top-tier agreement is automatically prioritized.',
    },
    {
      type: 'service-terms',
      heading: 'Commercial terms',
      body: 'Commercial work is priced by custom quote under a service agreement — Essential, Priority, or Total Care. The residential $99 diagnostic does not apply to commercial accounts. Billing is consolidated into one monthly invoice.',
    },
    {
      type: 'faq',
      heading: 'Commercial questions',
      items: [
        {
          q: 'How does my business open an account?',
          a: 'Submit a commercial account request (you will get an APC- reference) or call 954-931-7997. We confirm your facilities, equipment list, and agreement tier before the first work order.',
        },
        {
          q: 'What kinds of businesses do you cover?',
          a: 'Restaurants, hotels, laundromats, healthcare, offices, retail, and facilities operations across our twelve Broward service cities.',
        },
        trackingFaq(),
      ],
    },
    ctaBlock(
      'Put your equipment on one network',
      'Open an Appliance Pro Commercial Account and every location, machine, and work order lives in one place — quoted up front, tracked live, invoiced monthly.',
    ),
  ];
}

function installationSections() {
  return [
    {
      type: 'hero',
      heading: 'Appliance Installation in Broward County',
      body: 'A new appliance only earns its keep once it is installed level, connected correctly, and tested. Top Speed Appliance installs washers, dryers, refrigerators, ranges, dishwashers, and microwaves across Broward County — booked online, confirmed by a Service Setter, and tracked like every other job on the platform.',
      primaryCta: 'Book Installation',
      secondaryCta: 'Call Top Speed',
      tertiaryCta: 'Ask Speedy AI',
    },
    {
      type: 'intro',
      heading: 'Before your installation day',
      body: 'Measure the space and the path to it (doorways, turns, stairs), confirm your connections — water, drain, gas or electric, venting for dryers — and tell us the make and model when you book. If a hookup needs parts or a connection is not where the new unit expects it, your installer will tell you the options and the cost before proceeding.',
    },
    {
      type: 'service-terms',
      heading: 'Straightforward pricing',
      body: 'Booking collects the $99 service fee up front, credited toward the completed work when you approve it. If the installation needs anything beyond the standard hookup, you approve that quote before the extra work begins.',
    },
    {
      type: 'faq',
      heading: 'Installation questions',
      items: [
        {
          q: 'Which appliances do you install?',
          a: 'Washers, dryers, refrigerators, ovens and ranges, dishwashers, freezers and ice makers, microwaves, and garbage disposals — residential and commercial.',
        },
        {
          q: 'Do I need to disconnect the old appliance first?',
          a: 'No — leave everything connected. Your installer handles the swap safely, including shutting off water and power where needed.',
        },
        trackingFaq(),
      ],
    },
    ctaBlock(
      'Book your installation',
      'Pick a two-hour window and we will confirm by phone. Your new appliance, installed and tested, with the job tracked from request to completion.',
    ),
  ];
}

// ─── Symptom pages (Fusion URLs that map cleanly) ───────────────────
// Each: taxonomy service slug + taxonomy symptom slug, the common
// causes in plain language, what the technician checks, and any honest
// safety note. A technician confirms every diagnosis on site — Speedy
// AI can start the triage from a photo, it never certifies a diagnosis.

const SYMPTOM_PAGES = [
  {
    serviceSlug: 'washer-repair',
    symptomSlug: 'not-draining',
    appliance: 'Washer',
    phrase: 'Not Draining',
    causes: 'A washer that finishes the cycle sitting in water is usually dealing with a clogged drain pump filter, a kinked or blocked drain hose, or a drain pump that has given up. On many top-loaders a worn lid switch can also stop the drain-and-spin sequence before it starts.',
    checks: 'Your technician clears and inspects the filter and hose, tests the drain pump motor, and checks the control\'s error codes before quoting the repair — so the fix targets the actual failure, not the most expensive guess.',
    note: null,
    faq: {
      q: 'Can I keep using it if I drain the water by hand?',
      a: 'It is better not to run repeated cycles — standing water gets heavy and can damage the pump and seals. Bail out what you can and book the diagnostic.',
    },
  },
  {
    serviceSlug: 'dryer-repair',
    symptomSlug: 'not-heating',
    appliance: 'Dryer',
    phrase: 'Not Heating',
    causes: 'When a dryer tumbles but never warms up, the usual suspects are a failed heating element, a blown thermal fuse, or — on gas models — a worn igniter. Electric dryers can also lose one leg of their 240V supply, which leaves the drum turning with no heat at all.',
    checks: 'Your technician tests the element or igniter, the thermal fuse and thermostats, and the power supply, and inspects the vent run — a blown thermal fuse is often the dryer protecting itself from a restricted vent, and replacing the fuse without clearing the cause just buys a repeat failure.',
    note: 'Keep the lint trap clean after every load, and if the dryer cabinet feels unusually hot, stop using it until it has been checked.',
    faq: {
      q: 'The dryer heats sometimes and not others — is that different?',
      a: 'Intermittent heat often points to failing gas valve coils or a cycling thermostat going out of range. It is exactly the kind of fault the on-site diagnostic is built to pin down.',
    },
  },
  {
    serviceSlug: 'refrigerator-repair',
    symptomSlug: 'not-cooling',
    appliance: 'Refrigerator',
    phrase: 'Not Cooling',
    causes: 'A refrigerator that is running but not getting cold is commonly fighting dirty condenser coils, a failed evaporator fan, a defrost system that has let frost choke the coils, or a weak compressor start relay. Each one feels identical from the kitchen — warm food — which is why the diagnosis matters.',
    checks: 'Your technician measures actual compartment temperatures, inspects the coils and fans, tests the defrost cycle and start components, and then quotes the repair that matches the failure found.',
    note: 'While you wait, keep the doors closed as much as possible and move highly perishable food to a cooler with ice — perishables should stay at or below 40°F.',
    faq: {
      q: 'The freezer is cold but the fridge side is warm — same problem?',
      a: 'Often, yes: most refrigerators cool the fresh-food side with air from the freezer, so a fan, damper, or frost problem shows up exactly that way. The diagnostic covers both compartments.',
    },
  },
  {
    serviceSlug: 'dishwasher-repair',
    symptomSlug: 'leaking',
    appliance: 'Dishwasher',
    phrase: 'Leaking',
    causes: 'Puddles in front of a dishwasher usually trace back to a worn door gasket, a loose or split drain hose, a sticking water inlet valve, or a pump seal at the end of its life. Where the water appears — front, side, or under the unit — is the first clue.',
    checks: 'Your technician runs a controlled fill-and-drain cycle, inspects the gasket, hoses, valve, and pump housing under pressure, and finds the source before any parts are quoted.',
    note: 'If water is actively spreading, close the shut-off valve under the sink (or the dishwasher\'s supply line) and switch the unit off until your appointment.',
    faq: {
      q: 'It only leaks on some cycles — can it wait?',
      a: 'Small leaks tend to become floor damage before they become big leaks. Catching a gasket or hose early is one of the cheapest repairs there is — book the diagnostic.',
    },
  },
  {
    serviceSlug: 'freezer-ice-maker-repair',
    symptomSlug: 'no-ice',
    appliance: 'Ice Maker',
    phrase: 'Not Making Ice',
    causes: 'An ice maker that stops producing is usually starved of water — a failed inlet valve, a frozen fill line, or a clogged filter — or the ice maker module itself has failed. Freezer temperature matters too: most ice makers will not cycle if the compartment is running warm.',
    checks: 'Your technician verifies water pressure and the inlet valve, checks the fill line for ice blockages, tests the module and the freezer temperature, and replaces your filter if it is due — in that order, so a simple cause is never billed as a major one.',
    note: null,
    faq: {
      q: 'How long should I wait after a fix — or a new filter — for ice?',
      a: 'Give it a full 24 hours. Ice makers cycle slowly, and the first batches after any change are often small or hollow.',
    },
  },
];

function symptomSections(page) {
  const blocks = [
    {
      type: 'hero',
      heading: `${page.appliance} ${page.phrase}`,
      body: `Speedy AI can start the triage right now — describe the problem or send a photo — and a technician confirms the diagnosis on site. ${page.causes}`,
      primaryCta: 'Book a Diagnosis',
      secondaryCta: 'Call Top Speed',
      tertiaryCta: 'Ask Speedy AI',
    },
    {
      type: 'intro',
      heading: 'What our technician checks',
      body: page.checks,
    },
  ];
  if (page.note) {
    blocks.push({ type: 'intro', heading: 'In the meantime', body: page.note });
  }
  blocks.push(diagnosticTermsBlock());
  blocks.push({
    type: 'faq',
    heading: 'Questions',
    items: [
      page.faq,
      {
        q: 'How do I book?',
        a: 'Book online in about a minute, call 954-931-7997, or ask Speedy AI. A Service Setter confirms every appointment by phone.',
      },
      trackingFaq(),
    ],
  });
  blocks.push(ctaBlock(
    'Book the diagnosis',
    'One visit, one confirmed diagnosis, one quote you approve before repair. Serving all twelve Broward service cities.',
  ));
  return blocks;
}

// ─── The batch ──────────────────────────────────────────────────────

/**
 * Page specs for the seed. Taxonomy references are by slug; the seed
 * resolves them to record ids (and skips a spec whose taxonomy record
 * is missing rather than creating a broken page).
 */
export function buildPhase2DraftPages() {
  const pages = [];

  for (const city of CITY_PAGES) {
    const slug = `service-areas/${city.slug}`;
    pages.push({
      type: 'CITY',
      citySlug: city.slug,
      serviceSlug: null,
      slug,
      canonicalUrl: `${PHASE2_SITE_BASE}/${slug}/`,
      title: `Appliance Repair in ${city.name}, FL | Top Speed Appliance`,
      metaDescription: city.meta,
      sections: citySections(city),
    });
  }

  pages.push({
    type: 'SERVICE',
    citySlug: null,
    serviceSlug: 'commercial-appliance-repair',
    slug: 'services/commercial-appliance-repair',
    canonicalUrl: `${PHASE2_SITE_BASE}/services/commercial-appliance-repair/`,
    title: 'Commercial Appliance Repair in Broward County | Top Speed Appliance',
    metaDescription: 'Commercial appliance repair for Broward restaurants, hotels, laundromats and facilities — registered equipment, priority dispatch for critical machines, custom-quote agreements, one monthly invoice.',
    sections: commercialSections(),
  });

  pages.push({
    type: 'SERVICE',
    citySlug: null,
    serviceSlug: 'appliance-installation',
    slug: 'services/appliance-installation',
    canonicalUrl: `${PHASE2_SITE_BASE}/services/appliance-installation/`,
    title: 'Appliance Installation in Broward County | Top Speed Appliance',
    metaDescription: 'Washer, dryer, refrigerator, range, dishwasher and microwave installation across Broward County — booked online, confirmed by phone, installed level and tested, tracked live.',
    sections: installationSections(),
  });

  for (const page of SYMPTOM_PAGES) {
    const slug = `services/${page.serviceSlug}/${page.symptomSlug}`;
    pages.push({
      type: 'SERVICE',
      citySlug: null,
      serviceSlug: page.serviceSlug,
      slug,
      canonicalUrl: `${PHASE2_SITE_BASE}/${slug}/`,
      title: `${page.appliance} ${page.phrase} — Diagnosis & Repair in Broward County | Top Speed Appliance`,
      metaDescription: `${page.appliance.toLowerCase()} ${page.phrase.toLowerCase()}? What it usually means, what our technician checks, and how to book an on-site diagnosis in Broward County — $99 diagnostic credited toward your repair.`,
      sections: symptomSections(page),
    });
  }

  return pages;
}
