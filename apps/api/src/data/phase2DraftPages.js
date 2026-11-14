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

// Booking-links CTA body for the 2026-11-13 tri-county problem pages:
// every page carries the Speedy Booking and Speedy AI links, per the
// owner's "booking links on all pages" directive.
const SPEEDY_CTA_BODY = 'Book online with Speedy Booking at topspeedserviceos.com/book — or chat with Speedy AI anytime at topspeedserviceos.com/speedy for questions, photo diagnosis and service requests. Prefer to talk? Call 954-931-7997.';

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

function commercialTermsBlock() {
  return {
    type: 'service-terms',
    heading: 'Commercial terms',
    body: 'Commercial work is priced by custom quote under a service agreement. The residential diagnostic fee does not apply to commercial accounts.',
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
    meta: 'Appliance repair in Coral Springs, FL, from the Top Speed Appliance team. Online booking, Service Setter confirmation, live tracking — $99 diagnostic credited toward your repair.',
    hero: 'Coral Springs is a master-planned city of family neighborhoods, and many of its homes are reaching the age where the original washer, dryer, and refrigerator all start asking for attention at once. Our office is right next door in Coconut Creek, so Coral Springs bookings get the full platform: online booking, a Service Setter confirmation call, and live job tracking.',
    faqLocal: {
      q: 'Where is Top Speed Appliance based?',
      a: 'Our office is at 6810 N State Rd 7, Suite 341, Coconut Creek, FL 33073 — right next door to Coral Springs, which is one of our twelve covered Broward service cities. Technicians are dispatched from the office to your home.',
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
  // ─── Tri-county problem pages (owner-directed expansion, 2026-11-13) ───
  {
    serviceSlug: 'refrigerator-repair',
    symptomSlug: 'leaking',
    appliance: 'Refrigerator',
    phrase: 'Leaking',
    geo: 'South Florida',
    causes: 'Water pooling under or inside a refrigerator usually comes from a clogged defrost drain, a cracked drain pan, a leaking water inlet valve, or a split line feeding the ice maker or dispenser. Where the water shows up — front, back, or inside the crisper — points to the source.',
    checks: 'Your technician clears and tests the defrost drain, inspects the drain pan and inlet valve, pressure-checks the water lines, and confirms the leak is gone with a full fill-and-dispense cycle before quoting any part.',
    note: 'Mop up standing water and place a towel at the base — if the leak is near the water line connection, closing the small shut-off valve behind the fridge or under the sink stops it until your appointment.',
    faq: {
      q: 'Is a leaking fridge an emergency?',
      a: 'Rarely, but water damages floors quietly and a line leak can split further. Shut the water off, keep food cold with the doors closed, and book the diagnostic.',
    },
  },
  {
    serviceSlug: 'refrigerator-repair',
    symptomSlug: 'unusual-noises',
    appliance: 'Refrigerator',
    phrase: 'Making Unusual Noises',
    geo: 'South Florida',
    causes: 'Buzzing, rattling, clicking, or grinding from a refrigerator usually traces to a worn evaporator or condenser fan, a compressor working against dirty coils, a failing start relay clicking on and off, or simple vibration where the cabinet touches a wall or cabinet panel.',
    checks: 'Your technician isolates the sound by compartment and cycle, tests both fan motors, the start relay and compressor draw, and cleans and inspects the coils — so a fan noise is never billed as a compressor failure.',
    note: null,
    faq: {
      q: 'The noise stops when I open the door — what does that mean?',
      a: 'That pattern almost always points to the evaporator fan inside the freezer, which switches off with the door. It is a useful detail to mention when you book.',
    },
  },
  {
    serviceSlug: 'refrigerator-repair',
    symptomSlug: 'error-codes',
    appliance: 'Refrigerator',
    phrase: 'Showing Error Codes',
    geo: 'South Florida',
    causes: 'Error codes on a refrigerator display are the control board reporting a sensor, fan, defrost, or communication fault. The same code can mean different things on different brands, and a code alone rarely names the failed part — it names the system to test.',
    checks: 'Your technician reads the code against your exact model, then tests the flagged system — thermistors, fans, defrost components, and board voltages — and confirms the real failure before quoting the repair.',
    note: 'Write the code down or photograph the display before unplugging anything — a power cycle can clear the code your technician needs to see.',
    faq: {
      q: 'I unplugged it and the code went away. Is it fixed?',
      a: 'Usually not — the fault that triggered the code is still there and the code will return. If it does, note how long it took to come back; that timing helps the diagnosis.',
    },
  },
  {
    serviceSlug: 'washer-repair',
    symptomSlug: 'leaking',
    appliance: 'Washer',
    phrase: 'Leaking',
    geo: 'South Florida',
    causes: 'A washer leak usually comes from a worn door gasket on front-loaders, a split inlet or drain hose, a failing drain pump, or — on top-loaders — a tub seal that has reached the end of its life. When the water appears in the cycle tells the story: fill, wash, drain, or spin.',
    checks: 'Your technician runs a controlled cycle and watches each stage, inspects the gasket, hoses, pump, and tub seal under pressure, and finds the source before any parts are quoted.',
    note: 'Close both water supply valves behind the washer if water is spreading, and do not run another load — a hose that is weeping today can split outright tomorrow.',
    faq: {
      q: 'It only leaks on big loads — can it wait?',
      a: 'Intermittent leaks still soak flooring and subfloor a little at a time. Catching a gasket or hose early is one of the cheapest washer repairs there is.',
    },
  },
  {
    serviceSlug: 'washer-repair',
    symptomSlug: 'unusual-noises',
    appliance: 'Washer',
    phrase: 'Making Unusual Noises',
    geo: 'South Florida',
    causes: 'Banging usually means an unbalanced load or worn suspension; grinding or roaring in the spin points to tub bearings; squealing can be a belt or motor coupling on older models. A noise that has been getting louder over weeks is a wear part asking for attention, not a quirk.',
    checks: 'Your technician runs the machine empty and loaded, isolates the noise by cycle stage, and inspects the suspension, bearings, belt or drive system, and pump for the debris that often hides there.',
    note: null,
    faq: {
      q: 'It bangs only with heavy loads like towels — is that normal?',
      a: 'An occasional thump on an uneven load is normal; repeated banging on ordinary loads is not. Mention whether it happens on every load when you book.',
    },
  },
  {
    serviceSlug: 'washer-repair',
    symptomSlug: 'error-codes',
    appliance: 'Washer',
    phrase: 'Showing Error Codes',
    geo: 'South Florida',
    causes: 'Washer error codes most often flag drain problems, water-fill timeouts, door-lock faults, or motor and control communication errors. The code narrows the search — it does not finish it, because several different failures can set the same code.',
    checks: 'Your technician decodes the fault for your exact model, then tests the flagged system end to end — pump and hoses for drain codes, valves and pressure switches for fill codes, lock assemblies for door codes — before quoting.',
    note: 'Photograph the code before you unplug the machine or clear it — some washers only store the fault until the next power cycle.',
    faq: {
      q: 'The code cleared and the washer runs again. Should I still book?',
      a: 'If it happened once after a power flicker, watch it. If the same code returns, the underlying fault is real and intermittent faults are far easier to catch early.',
    },
  },
  {
    serviceSlug: 'dryer-repair',
    symptomSlug: 'unusual-noises',
    appliance: 'Dryer',
    phrase: 'Making Unusual Noises',
    geo: 'South Florida',
    causes: 'Thumping usually means worn drum support rollers; squealing points to the idler pulley or belt; scraping can be a worn drum glide or something caught in the blower. Dryer noises are almost always a support part wearing out, and they get worse, not better.',
    checks: 'Your technician opens the cabinet, inspects the rollers, idler, belt, and glides, checks the blower for trapped objects, and quotes only the worn parts the inspection actually finds.',
    note: null,
    faq: {
      q: 'Is it safe to keep drying while it squeals?',
      a: 'A squealing idler or belt can let go mid-cycle and leave the drum stalled against a hot element area. It is better to book than to push it.',
    },
  },
  {
    serviceSlug: 'dryer-repair',
    symptomSlug: 'error-codes',
    appliance: 'Dryer',
    phrase: 'Showing Error Codes',
    geo: 'South Florida',
    causes: 'Dryer error codes commonly report airflow restrictions, thermistor faults, door-switch problems, or heating-system errors. An airflow code is the machine protecting itself — lint buildup or a crushed vent run is the usual trigger, and clearing the code without clearing the cause invites a repeat.',
    checks: 'Your technician reads the code for your model, tests the flagged sensors and switches, and inspects the full vent run for restriction — because a thermal fault with a blocked vent is a vent problem first.',
    note: 'If the code mentions airflow or heat, check that the outside vent flap opens when the dryer runs and that the lint trap is clean — and tell your technician what you found.',
    faq: {
      q: 'Can a code tell me the exact part to replace?',
      a: 'It tells your technician where to test, not what to replace. Two different failed parts can set the same code, which is why the on-site diagnostic tests before it quotes.',
    },
  },
  {
    serviceSlug: 'oven-range-repair',
    symptomSlug: 'not-heating',
    appliance: 'Oven & Range',
    phrase: 'Not Heating',
    geo: 'South Florida',
    causes: 'An oven that will not heat usually has a failed bake element or igniter, a weak gas igniter that glows but never opens the valve, a faulty temperature sensor, or a control board relay that has stopped sending power. A range where the burners work but the oven does not has already narrowed the search considerably.',
    checks: 'Your technician tests the element or igniter and its amp draw, the temperature sensor, and the control outputs, and verifies gas flow on gas models — then quotes the repair that matches the failure found.',
    note: 'On a gas oven, if you smell gas strongly or the igniter glows for minutes with no flame, switch the oven off and ventilate the kitchen before your appointment.',
    faq: {
      q: 'The broiler works but bake does not — same repair?',
      a: 'Usually not: bake and broil use separate elements or ignition paths, so one can fail while the other works. The diagnostic tests each path independently.',
    },
  },
  {
    serviceSlug: 'oven-range-repair',
    symptomSlug: 'error-codes',
    appliance: 'Oven & Range',
    phrase: 'Showing Error Codes',
    geo: 'South Florida',
    causes: 'Oven error codes most often report temperature-sensor faults, control-board problems, or a runaway-temperature safety trip. An F-code after a self-clean cycle is a classic pattern — the heat of the cycle stresses the sensor and the door lock first.',
    checks: 'Your technician decodes the fault for your model, measures the temperature sensor against its specification, tests the door lock and control board, and confirms the failure before quoting.',
    note: 'Note whether the code appeared during normal cooking, after self-clean, or after a power outage — the timing is a real diagnostic clue.',
    faq: {
      q: 'The oven locked itself and shows a code — what now?',
      a: 'Let it cool completely; some locks release when the temperature drops. Do not force the door — a forced lock usually turns one repair into two.',
    },
  },
  {
    serviceSlug: 'dishwasher-repair',
    symptomSlug: 'not-draining',
    appliance: 'Dishwasher',
    phrase: 'Not Draining',
    geo: 'South Florida',
    causes: 'Standing water in the bottom of a dishwasher usually means a clogged filter or sump, a blocked or kinked drain hose, a failed drain pump, or — after a new garbage disposal install — a knockout plug that was never removed. Most causes are simple; the trick is testing them in the right order.',
    checks: 'Your technician inspects the filter and sump, tests the drain pump, checks the hose and air gap for blockages, and verifies a full drain cycle before quoting anything.',
    note: 'Scoop out what water you can and leave the door ajar — standing water turns stale fast, and there is no need to run another cycle until it drains properly.',
    faq: {
      q: 'It drains some times and not others — what does that suggest?',
      a: 'Intermittent draining often means debris shifting in the sump or a pump that fails only when hot. Worth booking while the pattern is still easy to reproduce.',
    },
  },
  {
    serviceSlug: 'dishwasher-repair',
    symptomSlug: 'error-codes',
    appliance: 'Dishwasher',
    phrase: 'Showing Error Codes',
    geo: 'South Florida',
    causes: 'Dishwasher error codes typically flag fill problems, drain faults, leaks detected by the flood sensor, or heater errors. A leak code can set even when you see no water — the sensor sits in the base pan where leaks collect first.',
    checks: 'Your technician reads the code for your model, inspects the base pan and flood sensor, tests the fill valve, drain pump, and heater, and confirms the cause before quoting.',
    note: 'Write the code down before resetting the breaker — and if the code is a leak fault, check under the unit for moisture before running it again.',
    faq: {
      q: 'Can I just reset it and keep washing?',
      a: 'A single reset after a power flicker is reasonable. A code that returns is the machine reporting a real fault, and leak codes especially should not be cleared and ignored.',
    },
  },
  {
    serviceSlug: 'dishwasher-repair',
    symptomSlug: 'unusual-noises',
    appliance: 'Dishwasher',
    phrase: 'Making Unusual Noises',
    geo: 'South Florida',
    causes: 'Grinding usually means hard debris — glass, a bone fragment, a lost screw — in the pump or chopper area; humming without action points to a straining wash motor; rattling is often a spray arm hitting a tall item. The stage of the cycle where the noise happens is the best clue.',
    checks: 'Your technician runs the cycle stage by stage, inspects the sump and spray arms, checks the wash and drain motors, and removes whatever does not belong before it damages the pump.',
    note: null,
    faq: {
      q: 'The noise started right after a glass broke in the wash — related?',
      a: 'Very likely: glass shards migrate to the pump area and grind there. Mention it when you book — it tells your technician exactly where to look first.',
    },
  },
  {
    serviceSlug: 'freezer-ice-maker-repair',
    symptomSlug: 'not-cooling',
    appliance: 'Freezer',
    phrase: 'Not Cooling',
    geo: 'South Florida',
    causes: 'A freezer that runs warm is usually fighting frost-choked evaporator coils from a failed defrost system, a dead evaporator fan, dirty condenser coils, or a door gasket letting humid South Florida air pour in. Frost pattern on the back wall is the classic tell.',
    checks: 'Your technician measures actual compartment temperature, inspects the frost pattern, tests the defrost heater, thermostat and timer or board, the fan motor, and the gasket seal — then quotes the failure that is actually there.',
    note: 'Move the most valuable frozen food to a cooler with ice or a neighbor freezer — food that has fully thawed and sat warm should not be refrozen.',
    faq: {
      q: 'The fridge side is fine but the freezer is warm — why?',
      a: 'The freezer does the cooling for both sides in most designs, so a partial failure often shows in the freezer first as soft ice cream and slow freezing.',
    },
  },
  {
    serviceSlug: 'freezer-ice-maker-repair',
    symptomSlug: 'leaking',
    appliance: 'Freezer & Ice Maker',
    phrase: 'Leaking',
    geo: 'South Florida',
    causes: 'Water from a freezer or ice maker usually traces to a frozen or clogged defrost drain that spills meltwater onto the floor of the compartment, a split ice maker fill line, or a leaking inlet valve. Ice sheets building on the freezer floor are the signature of the drain problem.',
    checks: 'Your technician clears and flush-tests the defrost drain, inspects the fill line and inlet valve under pressure, and confirms the compartment stays dry through a defrost cycle.',
    note: 'Chip out loose floor ice if you can do it gently — never with a knife or screwdriver, which can puncture a line and turn a small job into a big one.',
    faq: {
      q: 'Why does the puddle come and go?',
      a: 'Defrost cycles happen on a timer, so a drain leak often appears in a rhythm — a puddle every day or so, matching the cycle, rather than a constant drip.',
    },
  },
  {
    serviceSlug: 'microwave-repair',
    symptomSlug: 'not-heating',
    appliance: 'Microwave',
    phrase: 'Not Heating',
    geo: 'South Florida',
    causes: 'A microwave that runs, lights up, and turns the plate but does not heat has a failure in the high-voltage system — most often the magnetron, a diode, or a capacitor — or a door interlock switch that is not confirming the door is sealed. The lights-and-turntable behavior is what separates this from a dead unit.',
    checks: 'Your technician tests the door interlock switches first, then safely discharges and tests the high-voltage components. Microwave capacitors hold a charge even unplugged, which is exactly why this one is a professional job, never a DIY one.',
    note: 'Do not open a microwave cabinet yourself — the high-voltage capacitor can hold a dangerous charge long after the plug is pulled.',
    faq: {
      q: 'Is a non-heating microwave worth repairing?',
      a: 'Often, yes, for built-in and over-the-range models where replacement means cabinet and vent work too. Your technician quotes the repair first, and you decide with the number in hand.',
    },
  },
  {
    serviceSlug: 'microwave-repair',
    symptomSlug: 'error-codes',
    appliance: 'Microwave',
    phrase: 'Showing Error Codes',
    geo: 'South Florida',
    causes: 'Microwave error codes commonly involve the keypad or control board, door sensing, or a humidity/steam sensor fault on sensor-cook models. A code that appears the moment a cook cycle starts usually points at the door switches or the sensor circuit.',
    checks: 'Your technician decodes the fault for your model, tests the door interlocks, keypad, and control board, and confirms the failing component before quoting.',
    note: 'Note the code and what the microwave was doing when it appeared — sensor codes during high-steam cooking tell a different story than codes at idle.',
    faq: {
      q: 'It beeps and flashes a code after every power outage — normal?',
      a: 'A clock-reset prompt after an outage is normal; a fault code that blocks cooking is not. If the code stops the cycle, book the diagnostic.',
    },
  },
  {
    serviceSlug: 'microwave-repair',
    symptomSlug: 'unusual-noises',
    appliance: 'Microwave',
    phrase: 'Making Unusual Noises',
    geo: 'South Florida',
    causes: 'Buzzing or humming louder than usual can come from a failing magnetron or a worn turntable motor; arcing sounds and sparks point to a damaged waveguide cover or metal where it does not belong; a rattling fan suggests the cooling fan is obstructed or worn.',
    checks: 'Your technician inspects the cavity and waveguide cover, tests the turntable and fan motors, and checks the high-voltage system if the sound is electrical — and confirms the unit is safe to run before it goes back into service.',
    note: 'Sparking or arcing is a stop-now symptom: switch the unit off and leave it off until it has been checked.',
    faq: {
      q: 'It pops and sparks when I heat certain foods — is that the microwave?',
      a: 'Some foods spark naturally, but repeated arcing in the same spot usually means the waveguide cover is burned or the cavity paint is damaged. That needs a look.',
    },
  },
  {
    serviceSlug: 'garbage-disposal-repair',
    symptomSlug: 'unusual-noises',
    appliance: 'Garbage Disposal',
    phrase: 'Making Unusual Noises',
    geo: 'South Florida',
    causes: 'Grinding or rattling from a disposal usually means something hard — a bottle cap, a bone, a dropped utensil — is loose in the chamber; a humming disposal that does not spin is jammed or has a failed motor; a unit that has grown steadily louder may have worn bearings.',
    checks: 'Your technician inspects the chamber with the power off, clears obstructions, tests the flywheel and motor, and checks the splash guard and flanges — and quotes a replacement honestly if the motor itself has failed.',
    note: 'Never reach into a disposal with your hand, even switched off. If it hums but does not spin, switch it off quickly — a stalled motor overheats.',
    faq: {
      q: 'The disposal hums but nothing moves — can I fix it myself?',
      a: 'A jam can sometimes be freed with the hex wrench on the base, but a unit that still hums afterward has a motor problem. If in doubt, book it — the check is quick.',
    },
  },
  {
    serviceSlug: 'garbage-disposal-repair',
    symptomSlug: 'leaking',
    appliance: 'Garbage Disposal',
    phrase: 'Leaking',
    geo: 'South Florida',
    causes: 'A disposal leak comes from one of three places: the sink flange seal at the top, a hose or dishwasher connection on the side, or the body of the unit itself — and that third one means the internal seals have failed and the unit is at end of life. Where the drip starts tells you which repair conversation you are having.',
    checks: 'Your technician dries the unit, runs water stage by stage, and pinpoints whether the leak is flange, connection, or body — a flange reseal is a repair; a body leak is a replacement quote, given honestly.',
    note: 'Put a bowl under the drip and avoid running the disposal until you know the source — water in the cabinet base does quiet damage.',
    faq: {
      q: 'How do I know if it is worth repairing or replacing?',
      a: 'Seal and connection leaks are repairs. A leak through the body of the unit is not repairable — your technician will show you the source so the recommendation makes sense.',
    },
  },
  {
    serviceSlug: 'garbage-disposal-repair',
    symptomSlug: 'not-draining',
    appliance: 'Garbage Disposal',
    phrase: 'Not Draining',
    geo: 'South Florida',
    causes: 'A sink that will not drain through the disposal is rarely the disposal itself — the unit does not pump water; it is usually a clog in the trap or drain line beyond it, sometimes packed with the grease and fibrous food that disposals are often fed. A disposal that runs but the sink stays full is pointing past itself.',
    checks: 'Your technician confirms the disposal chamber is clear, inspects the trap and drain run, and clears the blockage — and checks that the dishwasher drain connection is not part of the problem.',
    note: 'Do not pour chemical drain cleaner into a disposal — it can splash back during any later work and damages seals. A plunger on the sink side is the safer stopgap.',
    faq: {
      q: 'The dishwasher also drains poorly — same problem?',
      a: 'Often, yes: the dishwasher usually drains through the disposal or the same trap, so one clog slows both down. Mention both symptoms when you book.',
    },
  },
  // Commercial problem pages — custom-quote terms, no residential diagnostic.
  {
    serviceSlug: 'commercial-refrigeration-repair',
    symptomSlug: 'not-cooling',
    appliance: 'Commercial Refrigeration',
    phrase: 'Not Cooling',
    kind: 'commercial',
    geo: 'South Florida',
    causes: 'A walk-in, reach-in, or prep cooler running warm threatens inventory and health-code compliance at the same time. The usual causes are refrigerant loss, a failed evaporator or condenser fan, frost-choked coils from a defrost fault, or a compressor working against a dirty condenser in a hot kitchen.',
    checks: 'Your technician logs box temperatures, checks refrigerant pressures, tests fan motors and the defrost system, inspects door gaskets, and gives you a written quote before repair work begins — with critical equipment prioritized in dispatch.',
    note: 'Log your current box temperatures and move the most perishable inventory to your coldest unit — temperature records matter for your own food-safety documentation.',
    faq: {
      q: 'Can you prioritize a cooler that is holding food?',
      a: 'Yes — tell us what is in the unit when you book. Critical equipment on a service agreement gets priority dispatch, and every commercial booking is confirmed by a Service Setter.',
    },
  },
  {
    serviceSlug: 'commercial-refrigeration-repair',
    symptomSlug: 'leaking',
    appliance: 'Commercial Refrigeration',
    phrase: 'Leaking',
    kind: 'commercial',
    geo: 'South Florida',
    causes: 'Water under a commercial cooler usually means a clogged or frozen condensate drain, a cracked drain pan, or condensation overwhelming the drain in a humid kitchen. In a walk-in, persistent water can also signal door gasket failure letting moist air flood in.',
    checks: 'Your technician clears and flush-tests the condensate drain, inspects the pan and drain line heater where fitted, checks door gaskets and door alignment, and confirms dry operation through a defrost cycle.',
    note: 'Keep the area mopped and marked until your appointment — standing water in a kitchen is a slip hazard for your team as much as an equipment problem.',
    faq: {
      q: 'There is ice building up by the evaporator too — related?',
      a: 'Very often: a frozen drain and evaporator icing feed each other. Mention both symptoms when you book so the visit covers the full defrost picture.',
    },
  },
  {
    serviceSlug: 'commercial-cooking-equipment-repair',
    symptomSlug: 'not-heating',
    appliance: 'Commercial Cooking Equipment',
    phrase: 'Not Heating',
    kind: 'commercial',
    geo: 'South Florida',
    causes: 'A range, oven, or fryer that will not heat in the middle of service usually comes down to a failed igniter or pilot system, a faulty thermostat or high-limit switch, a burned element on electric units, or a gas valve problem. On busy lines, heat-loss complaints can also be calibration drift rather than outright failure.',
    checks: 'Your technician tests ignition and gas flow or element continuity, verifies thermostat calibration against a reference thermometer, and checks safety limits — then quotes the repair in writing before work begins.',
    note: 'If you smell gas strongly or ignition keeps failing, take the unit out of service and ventilate — a line unit that will not light properly should not be coaxed through a shift.',
    faq: {
      q: 'Can the repair happen around service hours?',
      a: 'Bookings are confirmed by a Service Setter who will work with your operating hours where the schedule allows. Note your service windows when you book.',
    },
  },
  {
    serviceSlug: 'commercial-cooking-equipment-repair',
    symptomSlug: 'error-codes',
    appliance: 'Commercial Cooking Equipment',
    phrase: 'Showing Error Codes',
    kind: 'commercial',
    geo: 'South Florida',
    causes: 'Modern commercial cooking equipment reports faults for temperature probes, ignition failures, fan and airflow problems, and control communication errors. The code identifies the system; on commercial controls, a probe reading out of range is one of the most common root causes.',
    checks: 'Your technician decodes the fault against your make and model, tests the probe and the flagged components, and confirms the failure before quoting — so a sensor fault is not billed as a control board.',
    note: 'Photograph the display before resetting the unit — commercial controls often clear the stored fault on reset, and that code speeds the visit considerably.',
    faq: {
      q: 'The unit still cooks with the code showing — can it wait?',
      a: 'A code that involves ignition, temperature limits, or fans should not wait; those are safety-adjacent systems. Book it and note whether the unit is still in service.',
    },
  },
  {
    serviceSlug: 'commercial-dishwashing-repair',
    symptomSlug: 'not-draining',
    appliance: 'Commercial Dishwasher',
    phrase: 'Not Draining',
    kind: 'commercial',
    geo: 'South Florida',
    causes: 'A commercial dishmachine holding water usually has a clogged scrap screen or drain valve issue, a failed drain pump, or debris at the standpipe. In high-volume kitchens, drain problems compound fast — a slow drain during a rush backs the whole warewashing station up.',
    checks: 'Your technician inspects screens, scrap traps, and the drain valve or pump, verifies a complete drain cycle under load, and checks the fill and drain timing the controller expects.',
    note: 'Clear the scrap screens now if your model allows it — if the machine drains after a screen cleaning, tell us; if it does not, the pump and valve are next.',
    faq: {
      q: 'Dishes come out dirty when the drain acts up — connected?',
      a: 'Yes, often: a machine that cannot fully drain refills with diluted dirty water. Fixing the drain usually fixes the wash quality complaint with it.',
    },
  },
  {
    serviceSlug: 'commercial-dishwashing-repair',
    symptomSlug: 'leaking',
    appliance: 'Commercial Dishwasher',
    phrase: 'Leaking',
    kind: 'commercial',
    geo: 'South Florida',
    causes: 'Leaks on commercial dishmachines come from door and tank gaskets, pump seals, loose hose connections worked slack by vibration, or a sticking fill valve overfilling the tank. Water near the base during the wash stage versus the fill stage points to different sources.',
    checks: 'Your technician runs the machine through its stages and watches each one, inspects gaskets, pump housing, clamps, and the fill valve, and finds the source before quoting parts.',
    note: 'Note when the leak happens — filling, washing, or draining — and keep the floor marked and mopped; in a dishpit, that detail shortens the visit.',
    faq: {
      q: 'Is a small drip worth a service call?',
      a: 'On a commercial machine, yes: pump seals and gaskets rarely reseal themselves, and a drip today is the leak that floods a shift later.',
    },
  },
  {
    serviceSlug: 'commercial-laundry-repair',
    symptomSlug: 'not-draining',
    appliance: 'Commercial Laundry Equipment',
    phrase: 'Not Draining',
    kind: 'commercial',
    geo: 'South Florida',
    causes: 'A commercial washer that will not drain usually has a failed drain pump or drain valve, a lint-and-debris clog that home machines never see at this scale, or a control fault stopping the cycle mid-program. In a laundromat or hotel laundry, one dead machine quickly becomes a queue.',
    checks: 'Your technician tests the pump or drain valve, inspects the drain path and coin or card trigger systems where fitted, and verifies a full commercial cycle completes and drains.',
    note: 'Tell us how many machines you run and whether this one is card, coin, or OPL when you book — it helps the technician arrive with the right parts picture.',
    faq: {
      q: 'Can you service multiple machines in one visit?',
      a: 'Yes — list every machine and symptom when you book, and the visit is planned around the full list under your service agreement.',
    },
  },
  {
    serviceSlug: 'commercial-laundry-repair',
    symptomSlug: 'not-heating',
    appliance: 'Commercial Dryer',
    phrase: 'Not Heating',
    kind: 'commercial',
    geo: 'South Florida',
    causes: 'A commercial dryer tumbling without heat usually has a failed igniter or heating element, a tripped high-limit or thermal fuse, or — very commonly in commercial settings — a lint-restricted vent run that overheats the machine until a safety cuts the heat. Repeat fuse failures are the machine reporting the vent, not the fuse.',
    checks: 'Your technician tests the ignition or element circuit and all thermal safeties, inspects the full vent run for restriction, and verifies heating under a real load cycle before the machine goes back into service.',
    note: 'Check the lint screens and the outside vent termination now — a blocked termination is the fastest cause to rule in or out, and your note helps the visit.',
    faq: {
      q: 'The fuse was replaced last month and it blew again — why?',
      a: 'Thermal fuses blow on temperature, so a repeat failure means the heat is not leaving — usually vent restriction or airflow. The visit tests the airflow, not just the fuse.',
    },
  },
  {
    serviceSlug: 'commercial-trash-beverage-equipment-repair',
    symptomSlug: 'not-cooling',
    appliance: 'Beverage Equipment',
    phrase: 'Not Cooling',
    kind: 'commercial',
    geo: 'South Florida',
    causes: 'Beverage coolers and refrigerated dispensers that run warm are usually fighting a dirty condenser in a greasy or dusty environment, a failed fan, low refrigerant, or a thermostat or control fault. Product temperature is what matters — a cabinet can feel cool while drinks sit above target.',
    checks: 'Your technician measures actual product-zone temperatures, cleans and inspects the condenser, tests fans and controls, and checks refrigerant pressures before quoting the repair in writing.',
    note: 'Note the temperature your team measured and what product is affected — carbonated systems and dairy-based drinks have different tolerances, and it shapes the priority.',
    faq: {
      q: 'Can this be combined with other equipment in one visit?',
      a: 'Yes — commercial visits are planned around your full equipment list. Add every unit and symptom when you book.',
    },
  },
  {
    serviceSlug: 'commercial-trash-beverage-equipment-repair',
    symptomSlug: 'leaking',
    appliance: 'Trash & Beverage Equipment',
    phrase: 'Leaking',
    kind: 'commercial',
    geo: 'South Florida',
    causes: 'Leaks around beverage systems and compactors come from condensate drains, split beverage or water lines, worn pump seals, or hydraulic seepage on compactor equipment. A water leak and a hydraulic leak look different and mean very different repairs, so identifying the fluid is the first step.',
    checks: 'Your technician identifies the leaking fluid and its source, inspects lines, drains, seals, and hydraulic fittings under operating pressure where safe, and quotes the repair in writing before work begins.',
    note: 'If the fluid is oily, keep the compactor out of service and contain the spill — hydraulic leaks under pressure are a safety issue, not just a mess.',
    faq: {
      q: 'How do I tell a water leak from a hydraulic one?',
      a: 'Water is thin and clear and tracks to a drain or line; hydraulic fluid is oily, amber, and leaves a rainbow sheen. Your description when you book routes the right preparation.',
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
  blocks.push(page.kind === 'commercial' ? commercialTermsBlock() : diagnosticTermsBlock());
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
    page.ctaHeading || (page.kind === 'commercial' ? 'Book commercial service' : 'Book the diagnosis'),
    page.ctaBody || (page.geo ? SPEEDY_CTA_BODY : 'One visit, one confirmed diagnosis, one quote you approve before repair. Serving all twelve Broward service cities.'),
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
      title: `${page.appliance} ${page.phrase} — Diagnosis & Repair in ${page.geo || 'Broward County'} | Top Speed Appliance`,
      metaDescription: page.kind === 'commercial'
        ? `${page.appliance} ${page.phrase.toLowerCase()}? What it usually means, what our technician checks, and how to book commercial service in ${page.geo || 'Broward County'} — custom quote under a service agreement.`
        : `${page.appliance.toLowerCase()} ${page.phrase.toLowerCase()}? What it usually means, what our technician checks, and how to book an on-site diagnosis in ${page.geo || 'Broward County'} — $99 diagnostic credited toward your repair.`,
      sections: symptomSections(page),
    });
  }

  return pages;
}
