import { PLATFORM_CONSTANTS } from '../config/platform.js';
import { OFFERS } from '../config/offers.js';
import { SERVICE_CITIES } from '../config/serviceAreas.js';
import {
  MARKETING_BRANDS,
  MARKETING_CITIES,
  MARKETING_SERVICES,
} from '../data/marketingTaxonomy.js';
import { NETWORK_PARTNER_PROVIDERS } from '../data/networkPartners.js';
import { STAGE8_LABELS } from '../services/tracking.js';
import { store } from '../data/store.js';

/**
 * SITE pack — Speedy's knowledge of Top Speed itself, GENERATED at
 * runtime from the same live sources the rest of the platform reads
 * (platform constants, the offers catalog, the Marketing OS store,
 * the network-partner registry, the tracking service). Because it is
 * rebuilt from those sources on every call, it can never drift from
 * what the platform actually publishes: change an offer, a city, or a
 * service in the platform and Speedy's answers change with it.
 *
 * Entry shape (shared by all packs): { id, topic, keywords, answer,
 * link? } — answers are customer-safe and state only locked facts.
 */

const P = PLATFORM_CONSTANTS;
const PHONE = P.phoneDisplay;
const SITE = 'https://topspeedserviceos.com';

// Tri-county anchor cities with published Top Speed landing pages
// (beyond the taxonomy seed list), used only as extra search keywords
// for the coverage entry — the coverage ANSWER is built from the live
// city data, and any address outside the 12 core booking cities is
// confirmed by a Service Setter, never promised by the entry.
const TRI_COUNTY_ANCHORS = [
  'Miami', 'Miami Beach', 'Hialeah', 'Coral Gables', 'Doral', 'Aventura',
  'Boca Raton', 'Delray Beach', 'Boynton Beach', 'Lake Worth',
  'West Palm Beach', 'Palm Beach Gardens', 'Jupiter', 'Wellington',
];

function liveCities() {
  const fromStore = Array.isArray(store.marketingCities) ? store.marketingCities : [];
  return fromStore.length ? fromStore : MARKETING_CITIES;
}

function liveServices() {
  const fromStore = Array.isArray(store.marketingServices) ? store.marketingServices : [];
  return fromStore.length ? fromStore : MARKETING_SERVICES;
}

export function buildSitePack() {
  const cities = liveCities();
  const services = liveServices();
  const cityNames = [...new Set([...cities.map((c) => c.name), ...TRI_COUNTY_ANCHORS])];
  const serviceNames = services.map((s) => s.name);
  const ventPartner = NETWORK_PARTNER_PROVIDERS[0];
  const stageList = STAGE8_LABELS.map((label, i) => `${i + 1}. ${label}`).join(' → ');

  const entries = [
    {
      id: 'site-business-basics',
      topic: 'About Top Speed Appliance — contact, office, hours',
      keywords: [
        'top speed appliance', 'about you', 'your company', 'who are you', 'phone number',
        'contact', 'email', 'address', 'where are you located', 'office', 'hours',
        'when are you open', 'slogan', 'the faster the better',
      ],
      answer:
        `${P.platformName} is run by ${P.platformOwner} ("Top Speed Appliance Network"), an appliance repair and installation company based in Coconut Creek, Florida — slogan: "${P.slogan}" ` +
        `You can reach the team at ${PHONE} or service@topspeedappliance.net, Monday–Friday, 8 AM–7 PM. ` +
        `The office is at ${P.officeAddress}; technicians are dispatched from there, and repairs happen at your home or business, not at the office.`,
      link: `${SITE}/about`,
    },
    {
      id: 'site-pricing-diagnostic',
      topic: 'The $99 diagnostic — what it costs and how it works',
      keywords: [
        'diagnostic', 'how much is the diagnostic', 'diagnostic fee', 'diagnostic cost',
        'service call', 'service call fee', '$99', '99 diagnostic', 'how much to come out',
        'cost to come out', 'trip charge',
      ],
      answer:
        `Every residential repair starts with a $99 diagnostic visit. The $99 is collected at booking and credited in full toward your approved repair — if you decide not to go ahead with the repair, the $99 is still due for the visit. ` +
        `On the visit the technician inspects and tests your appliance, names the actual cause, and gives you the exact repair estimate in writing; no repair work starts until you approve it.`,
      link: `${SITE}/book`,
    },
    {
      id: 'site-pricing-labor',
      topic: 'Repair labor and installation pricing',
      keywords: [
        'repair labor', 'labor cost', 'labor price', 'installation cost', 'how much to install',
        'installation fee', 'flat rate', 'how much does repair cost', 'repair price', 'parts cost',
      ],
      answer:
        `Top Speed's published labor pricing is flat: repair labor is $210 flat and installation is $150 flat. Parts and materials are extra and are priced on your written quote after the diagnostic. ` +
        `The exact total for a repair is only ever set by the technician's quote after the $99 diagnostic (credited toward the repair) — nobody quotes a repair total sight unseen.`,
      link: `${SITE}/book`,
    },
    {
      id: 'site-commercial-pricing',
      topic: 'Commercial pricing — custom quotes',
      keywords: [
        'commercial price', 'commercial pricing', 'commercial quote', 'business pricing',
        'business cost', 'facility pricing', 'restaurant pricing', 'commercial cost',
      ],
      answer:
        `Commercial service is priced by custom quote for each facility — the residential $99 diagnostic model never applies to commercial accounts. ` +
        `A commercial account request gets its own reference, an equipment assessment, and a written proposal sized to your equipment and locations. Commercial customers work through Appliance Pro.`,
      link: `${SITE}/appliance-pro`,
    },
    {
      id: 'site-terms',
      topic: 'Quotes, approval, and payment terms',
      keywords: [
        'written quote', 'approve the quote', 'approval', 'payment due', 'when do i pay',
        'pay on completion', 'terms', 'estimate approval', 'do i pay upfront',
      ],
      answer:
        `The standing terms are simple: no work is ever done without an approved written quote, and payment is due on completion unless something else is agreed in writing beforehand. ` +
        `Travel inside South Florida is included; any extra travel is disclosed and approved before it is charged.`,
      link: `${SITE}/legal`,
    },
    {
      id: 'site-warranty',
      topic: 'The 90-day parts & labor warranty',
      keywords: ['warranty', 'guarantee', '90 day', 'warranty cover', 'warranty cover what', 'is it guaranteed'],
      answer:
        `Repairs carry a 90-day parts & labor warranty: it covers the parts we install plus the labor for the specific repair on your invoice, for 90 days from the service date. ` +
        `If the same failure comes back inside the warranty, we return and repair it at no additional labor charge. It does not cover misuse, power surges, water or pest damage, improper installation, normal wear, or work done by others. The full terms are printed on your invoice.`,
    },
    {
      id: 'site-coverage',
      topic: 'Service areas — where Top Speed works',
      keywords: [
        'service area', 'service areas', 'areas', 'serve', 'do you serve', 'do you service',
        'cover', 'coverage', 'come to', 'near me', 'cities', 'which cities', 'locations',
        ...cityNames,
        ...cityNames.map((name) => `do you serve ${name.toLowerCase()}`),
      ],
      answer:
        `Top Speed books and dispatches across ${cities.length} published service cities in Broward, Palm Beach, and Miami-Dade counties. ` +
        `Bookings are confirmed automatically for the 12 core Broward cities — ${SERVICE_CITIES.join(', ')} — and for other tri-county cities a Service Setter confirms coverage for your exact address when your booking is reviewed, so you always get a straight answer before anything is charged. ` +
        `If an address is outside the service area, the request is saved on the expansion list and the team reaches out if coverage opens there — it is never promised service it can't get.`,
      link: `${SITE}/service-areas-directory`,
    },
    {
      id: 'site-services-overview',
      topic: 'Services Top Speed offers',
      keywords: [
        'services', 'what services', 'what do you repair', 'what do you fix', 'repairs',
        'what appliances', 'service list', ...serviceNames,
      ],
      answer:
        `Top Speed services: ${serviceNames.join(', ')}. The bookable residential services are the nine core ones — Refrigerator, Washer, Dryer, Oven/Range, Dishwasher, Freezer/Ice Maker, Microwave, Garbage Disposal, and Installation — plus commercial appliance repair for businesses. ` +
        `Every job starts with the $99 diagnostic (residential) or a custom commercial quote. One thing Top Speed does not book itself: dryer vent cleaning — that is handled by the network partner Cleanout Vents (ask me about vent cleaning and I'll point you right).`,
      link: `${SITE}/service-areas-directory`,
    },
    {
      id: 'site-cleanout-vents',
      topic: 'Dryer vent cleaning — Cleanout Vents, network partner',
      keywords: [
        'dryer vent', 'vent cleaning', 'clean dryer vent', 'cleanout vents', 'lint',
        'airflow inspection', 'vent line', 'dryer vent cleaning', 'clean vents',
      ],
      answer:
        `Dryer vent work is handled by ${ventPartner.businessName}, a vendor partner in the Top Speed Appliance Service Network. They do exactly three services: ${ventPartner.specialties.join(', ')} — serving Broward County. ` +
        `To arrange it, call ${PHONE}: the Service Setters coordinate Cleanout Vents work from the same dispatch floor as every network job. Vent cleaning has no published price — pricing is confirmed by the team when you call, and the $99 diagnostic does not apply to it. ` +
        `(If your dryer itself has a problem — no heat, long dry times — the dryer is Top Speed diagnostic work; the vent cleaning is the partner's.)`,
      link: `${SITE}/cleanout-vents-site`,
    },
    {
      id: 'site-booking-how',
      topic: 'How booking works — windows, references, confirmation',
      keywords: [
        'how to book', 'book a repair', 'booking', 'appointment', 'schedule', 'schedule a repair',
        'booking windows', 'appointment windows', 'reference', 'booking reference', 'how does booking work',
      ],
      answer:
        `You can book by chatting with Speedy here, through the Smart Booking form, in the apps, or by calling ${PHONE}. Appointment windows are two-hour blocks: 8–10 AM, 10–12, 12–2, 2–4, and 4–6. ` +
        `Every booking gets a reference like TS-XXXXXX (keep it — with your phone number it unlocks job tracking), and a human Service Setter reviews and confirms every booking before a technician is dispatched; the $99 residential diagnostic is collected at booking and credited toward your repair.`,
      link: `${SITE}/book`,
    },
    {
      id: 'site-tracking-stages',
      topic: 'Track My Tech — the 8 job stages',
      keywords: [
        'tracking', 'track my tech', 'track', 'where is my job', 'job status', 'stages',
        'how does tracking work', 'technician location', 'eta', 'live tracking',
      ],
      answer:
        `Every booked job moves through 8 stages: ${stageList}. You follow yours at ${SITE}/track — signed in, or as a guest with your booking reference and the phone number on the booking. ` +
        `The technician's live location appears only while they are en route, and any ETA shown is the technician's own estimate — it is never generated. Stages advance from real job events, so what you see is what actually happened.`,
      link: `${SITE}/track`,
    },
    {
      id: 'site-brands',
      topic: 'Brands serviced',
      keywords: [
        'brands', 'brand', 'do you service', 'do you repair', 'manufacturer',
        ...MARKETING_BRANDS.map((b) => b.name.toLowerCase()),
      ],
      answer:
        `Technicians service the major brands, including: ${MARKETING_BRANDS.map((b) => b.name).join(', ')}. ` +
        `Top Speed is an independent repair service: we repair these brands, but we are not the manufacturer and never claim factory authorization for a brand.`,
    },

    /* ---- Full-ecosystem catalog (Ramone, 2026-11-17): one entry per
       public customer option — every platform door, app, website, and
       key page — so Speedy can navigate a customer anywhere in the
       ecosystem and answer "where do I…" from grounded knowledge.
       Published facts only; commercial entries never carry the $99
       residential diagnostic; vent entries never carry a price. */
    {
      id: 'site-book-form',
      topic: 'Book a repair — the Smart Booking form',
      keywords: [
        'booking form', 'book a repair form', 'smart booking', 'book online',
        'book a repair online', 'schedule a repair online', 'booking page',
      ],
      answer:
        `The classic way to book is the Smart Booking form: pick the appliance, describe what's happening, choose a two-hour window, and send it. ` +
        `The $99 residential diagnostic is collected at booking and credited in full toward your approved repair, and a human Service Setter reviews and confirms every booking before a technician is dispatched.`,
      link: `${SITE}/book`,
    },
    {
      id: 'site-book-with-speedy',
      topic: 'Book through Speedy chat',
      keywords: [
        'book with speedy', 'book in chat', 'chat booking', 'book through speedy',
        'speedy booking', 'book by chatting',
      ],
      answer:
        `You can also book right here in chat with Speedy: tell me the appliance, what's happening, and your city, and I'll collect the details. ` +
        `Before anything is sent to the Service Setters office, I show you a summary of the booking and you confirm it — nothing is ever sent without your confirmation. The classic web form stays the primary booking path; chat booking is the high-tech option alongside it.`,
      link: `${SITE}/speedy`,
    },
    {
      id: 'site-photo-diagnosis',
      topic: 'Photo diagnosis — send Speedy a photo of the problem',
      keywords: [
        'photo diagnosis', 'send a photo', 'photo of the problem', 'diagnose from a photo',
        'picture of my appliance', 'speedy photo', 'photo read', 'model plate photo',
      ],
      answer:
        `Send Speedy a photo of the problem — or of the appliance's model plate — and Speedy gives you a plain-language read of what it usually means and what happens next. ` +
        `A photo read is preliminary: the technician confirms the actual cause in person during the diagnostic visit, and only that confirmed diagnosis sets your repair quote.`,
      link: `${SITE}/speedy`,
    },
    {
      id: 'site-service-refrigerator',
      topic: 'Refrigerator repair — book Top Speed',
      keywords: ['refrigerator repair', 'fridge repair', 'book refrigerator repair', 'refrigerator repair service', 'fix my fridge'],
      answer:
        `Refrigerator repair is one of Top Speed's nine core services. It starts with the $99 diagnostic (credited in full toward your approved repair): the technician finds the actual cause and gives you a written estimate before any repair work starts. Book on the form, in the app, or at ${PHONE}.`,
      link: `${SITE}/home-appliance-services`,
    },
    {
      id: 'site-service-washer',
      topic: 'Washer repair — book Top Speed',
      keywords: ['washer repair', 'washing machine repair', 'book washer repair', 'washer repair service', 'fix my washing machine'],
      answer:
        `Washer repair is one of Top Speed's nine core services. It starts with the $99 diagnostic (credited in full toward your approved repair): the technician finds the actual cause and gives you a written estimate before any repair work starts. Book on the form, in the app, or at ${PHONE}.`,
      link: `${SITE}/home-appliance-services`,
    },
    {
      id: 'site-service-dryer',
      topic: 'Dryer repair — book Top Speed',
      keywords: ['dryer repair', 'tumble dryer repair', 'clothes dryer repair', 'book dryer repair', 'dryer repair service', 'fix my dryer'],
      answer:
        `Dryer repair is one of Top Speed's nine core services. It starts with the $99 diagnostic (credited in full toward your approved repair): the technician finds the actual cause and gives you a written estimate before any repair work starts. Book on the form, in the app, or at ${PHONE}. (A dryer that runs but dries slowly can also point at the vent path — vent cleaning itself is Cleanout Vents' work; ask me and I'll point you right.)`,
      link: `${SITE}/home-appliance-services`,
    },
    {
      id: 'site-service-oven-range',
      topic: 'Oven & range repair — book Top Speed',
      keywords: ['oven repair', 'range repair', 'stove repair', 'book oven repair', 'oven repair service', 'fix my stove'],
      answer:
        `Oven and range repair is one of Top Speed's nine core services. It starts with the $99 diagnostic (credited in full toward your approved repair): the technician finds the actual cause and gives you a written estimate before any repair work starts. Book on the form, in the app, or at ${PHONE}.`,
      link: `${SITE}/home-appliance-services`,
    },
    {
      id: 'site-service-dishwasher',
      topic: 'Dishwasher repair — book Top Speed',
      keywords: ['dishwasher repair', 'book dishwasher repair', 'dishwasher repair service', 'fix my dishwasher'],
      answer:
        `Dishwasher repair is one of Top Speed's nine core services. It starts with the $99 diagnostic (credited in full toward your approved repair): the technician finds the actual cause and gives you a written estimate before any repair work starts. Book on the form, in the app, or at ${PHONE}.`,
      link: `${SITE}/home-appliance-services`,
    },
    {
      id: 'site-service-freezer-ice-maker',
      topic: 'Freezer & ice maker repair — book Top Speed',
      keywords: ['freezer repair', 'ice maker repair', 'book freezer repair', 'freezer repair service', 'fix my ice maker'],
      answer:
        `Freezer and ice maker repair is one of Top Speed's nine core services. It starts with the $99 diagnostic (credited in full toward your approved repair): the technician finds the actual cause and gives you a written estimate before any repair work starts. Book on the form, in the app, or at ${PHONE}.`,
      link: `${SITE}/home-appliance-services`,
    },
    {
      id: 'site-service-microwave',
      topic: 'Microwave repair — book Top Speed',
      keywords: ['microwave repair', 'book microwave repair', 'microwave repair service', 'fix my microwave'],
      answer:
        `Microwave repair is one of Top Speed's nine core services. It starts with the $99 diagnostic (credited in full toward your approved repair): the technician finds the actual cause and gives you a written estimate before any repair work starts. Microwave internals hold a dangerous charge even unplugged — never open the cabinet yourself; that is technician-only work. Book on the form, in the app, or at ${PHONE}.`,
      link: `${SITE}/home-appliance-services`,
    },
    {
      id: 'site-service-garbage-disposal',
      topic: 'Garbage disposal repair — book Top Speed',
      keywords: ['garbage disposal repair', 'disposal repair', 'book disposal repair', 'garbage disposal service', 'fix my disposal'],
      answer:
        `Garbage disposal repair is one of Top Speed's nine core services. It starts with the $99 diagnostic (credited in full toward your approved repair): the technician finds the actual cause and gives you a written estimate before any repair work starts. Book on the form, in the app, or at ${PHONE}.`,
      link: `${SITE}/home-appliance-services`,
    },
    {
      id: 'site-service-installation',
      topic: 'Appliance installation — book Top Speed',
      keywords: ['appliance installation', 'installation service', 'install my appliance', 'new appliance install', 'book installation'],
      answer:
        `Installation is one of Top Speed's nine core services, at $150 flat labor: leveling, correct water, electrical, and gas connections, and leak and function checks before the job is called done. Parts and materials are extra and quoted in writing. Book on the form, in the app, or at ${PHONE}.`,
      link: `${SITE}/home-appliance-services`,
    },
    {
      id: 'site-landing-pages',
      topic: 'Landing pages — 131 pages across 65 cities',
      keywords: [
        'landing pages', '131 landing pages', '65 cities', 'city pages',
        'how many cities do you serve', 'local service pages',
      ],
      answer:
        `Top Speed publishes 131 service landing pages covering 65 cities across Broward, Palm Beach, and Miami-Dade counties — a page for the services offered in each city. ` +
        `The Service Areas directory lists every city and links to its pages, so you can start from your own city and book from there.`,
      link: `${SITE}/service-areas-directory`,
    },
    {
      id: 'site-hub',
      topic: 'Top Speed Service OS — the hub at topspeedserviceos.com',
      keywords: ['service os', 'topspeedserviceos.com', 'the hub', 'main website', 'the platform', 'top speed service os'],
      answer:
        `topspeedserviceos.com is the hub of Top Speed Service OS: booking, Track My Tech, your account and garage, the apps, offers, referrals, and every platform door run on this one system. ` +
        `One account and one record — a job booked through any Top Speed door is the same job here.`,
      link: `${SITE}/`,
    },
    {
      id: 'site-dotnet',
      topic: 'topspeedappliance.net — the customer flagship website',
      keywords: ['topspeedappliance.net', 'top speed appliance website', 'flagship site', 'residential repair website'],
      answer:
        `topspeedappliance.net is Top Speed's customer flagship website: residential repair pages for every service and city, booking, pricing, and tracking. ` +
        `It runs on the same Service OS as everything else, so a booking made there is the same record you track in the app.`,
      link: 'https://topspeedappliance.net',
    },
    {
      id: 'site-brand-landing',
      topic: 'topspeedappliancerepair.com — Top Speed Appliance Repair brand site',
      keywords: ['topspeedappliancerepair.com', 'top speed appliance repair website', 'brand site', 'brand landing page'],
      answer:
        `topspeedappliancerepair.com is Top Speed's brand landing page for appliance repair in Broward County: the real booking form is right on the page, with a door to Speedy and the office line at ${PHONE}. ` +
        `It runs on the same Service OS as everything else, so a booking made there is the same record you track in the app.`,
      link: 'https://topspeedappliancerepair.com',
    },
    {
      id: 'site-flagship-alias',
      topic: 'topspeedrepairs.com — the flagship site at a second address',
      keywords: ['topspeedrepairs.com', 'top speed repairs', 'top speed repairs website', 'flagship alias'],
      answer:
        `topspeedrepairs.com answers with the same flagship Top Speed website as topspeedserviceos.com: booking, Track My Tech, your account, and Speedy. ` +
        `Whichever of the two addresses you use, it is one system and one record.`,
      link: 'https://topspeedrepairs.com',
    },
    {
      id: 'site-typo-redirect',
      topic: 'topspeedreapair.com — a common misspelling that redirects',
      keywords: ['topspeedreapair.com', 'top speed reapair', 'misspelled website', 'wrong spelling', 'typo in the web address'],
      answer:
        `If you typed topspeedreapair.com — "reapair" with two letters swapped — you are in the right place: that address redirects straight to topspeedrepairs.com, the flagship Top Speed site. ` +
        `Nothing is lost: booking, tracking, your account, and Speedy are all there.`,
      link: 'https://topspeedrepairs.com',
    },
    {
      id: 'site-network-join',
      topic: 'Join the provider network — topspeedapplianceservice.com',
      keywords: [
        'join the network', 'become a provider', 'provider network', 'topspeedapplianceservice.com',
        'work for top speed', 'sign up as a technician', 'join as a provider',
      ],
      answer:
        `Technicians and service businesses join the Top Speed Appliance Service Network at topspeedapplianceservice.com. ` +
        `Providers are verified by the team before they receive work, and every job is dispatched by the human Service Setters — providers work in the Tech App (Speedy Pro) once they are on the network.`,
      link: 'https://topspeedapplianceservice.com',
    },
    {
      id: 'site-connect-pro',
      topic: 'Appliance Connect Pro — homeowners & property managers',
      keywords: [
        'appliance connect pro', 'connect pro', 'applianceconnectpro.com',
        'property manager portal', 'homeowner portal',
      ],
      answer:
        `Appliance Connect Pro is the portal for homeowners and property managers: tenants can submit appliance requests straight into it, managers see every work order's live stage and a photo report after each job, and billing rolls into one consolidated monthly invoice. ` +
        `New accounts are created on the Connect Pro web portal first; the app is sign-in only for existing accounts.`,
      link: 'https://www.applianceconnectpro.com',
    },
    {
      id: 'site-connect-portal',
      topic: 'Appliance Connect — your customer account portal',
      keywords: [
        'appliance connect portal', 'customer portal', 'appliance connect login',
        'my account portal', 'customer account login',
      ],
      answer:
        `Your Appliance Connect customer account — your appliances, service history, bookings, and referral dashboard — lives in the Appliance Connect portal, free. ` +
        `It is the same account you use on every Top Speed door, and the mobile version signs in with it too.`,
      link: 'https://appliance-connect.vercel.app',
    },
    {
      id: 'site-appliance-pro',
      topic: 'Appliance Pro — commercial service accounts',
      keywords: [
        'appliance pro', 'appliancepro.net', 'commercial accounts',
        'commercial service accounts', 'business accounts', 'commercial portal',
        'commercial sign in', 'commercial login', 'commercial customers sign in',
      ],
      answer:
        `Appliance Pro is Top Speed's commercial door: restaurants, hotels, laundromats, healthcare, offices, and other facilities open a commercial account with an equipment registry (a TS-EQ asset tag on every unit), priority dispatch through the Service Setters, a photo report at close, and one consolidated monthly invoice. ` +
        `Commercial pricing is by custom quote for each facility — the residential diagnostic model never applies to commercial accounts.`,
      link: 'https://www.appliancepro.net',
    },
    {
      id: 'site-commercial-services',
      topic: 'Commercial appliance services — what Top Speed covers',
      keywords: [
        'commercial appliance services', 'commercial refrigeration', 'commercial laundry',
        'restaurant equipment repair', 'walk-in cooler repair', 'commercial kitchen repair',
      ],
      answer:
        `Top Speed's commercial services cover commercial refrigeration (walk-ins, reach-ins, ice machines), commercial laundry, cooking lines, and commercial dish and sanitation machines. ` +
        `Every facility is priced by custom quote through Appliance Pro — there is no residential-style diagnostic fee on commercial work. Building HVAC, plumbing mains, and electrical panels stay with the licensed trades for those systems.`,
      link: `${SITE}/commercial-appliance-services`,
    },
    {
      id: 'site-property-managers',
      topic: 'Property managers — appliance service for every unit',
      keywords: [
        'property managers', 'property manager', 'rental units service',
        'tenant appliance requests', 'manage my units', 'landlord appliance service',
      ],
      answer:
        `Property managers run appliance service for every unit from Appliance Connect Pro: tenants submit requests day or night, Service Setters review and approve every booking, and you see each job's live stage with a photo report when it closes. ` +
        `Billing is one consolidated monthly invoice itemized by unit. The Property Managers page explains the whole setup.`,
      link: `${SITE}/property-managers`,
    },
    {
      id: 'site-pepper-lists',
      topic: 'Pepper Lists — Sell, Post, and Book',
      keywords: [
        'pepper lists', 'pepper lists it', 'pepperlists.com', 'pepper lists sell',
        'pepper lists post', 'pepper lists book', 'sell post book',
      ],
      answer:
        `Pepper Lists It is Top Speed's three-purpose platform at pepperlists.com. Pepper Lists Sell: list an item once and sell it on the marketplaces — Facebook Marketplace, Google Shopping, eBay, Etsy, and Walmart. ` +
        `Pepper Lists Post: post to social media and search directories — TikTok, Facebook, YouTube, Instagram, X, and LinkedIn — and the Pepper Lists reviews wall is part of Post. ` +
        `Pepper Lists Book: book appliance service with Speedy AI and Top Speed Service OS, with tracking included. One account covers all three.`,
      link: 'https://www.pepperlists.com',
    },
    {
      id: 'site-pepper-lists-how',
      topic: 'How Pepper Lists works — Sell, Post, Book explained',
      keywords: [
        'how does pepper lists work', 'how pepper lists works', 'pepper lists how it works',
        'pepper lists explained',
      ],
      answer:
        `The Pepper Lists how-it-works page walks through all three purposes: Sell (connect your marketplace channels and list once), Post (connect your social and directory channels and share), and Book (book service — the classic web form first, Speedy AI booking as the high-tech option below it, and Speedy confirms a summary with you before anything reaches the Service Setters). ` +
        `It also explains how Pepper, the Muse AI agent, can manage your channels for you when you grant access.`,
      link: 'https://www.pepperlists.com/how-it-works',
    },
    {
      id: 'site-pepper-lists-channels',
      topic: 'Pepper Lists Channel Connections — Sell & Post channels',
      keywords: [
        'channel connections', 'connect my channels', 'pepper lists channels',
        'sell on ebay', 'sell on etsy', 'sell on walmart', 'sell on google shopping',
        'sell on facebook marketplace', 'post on tiktok', 'post on instagram',
        'post on youtube', 'post on linkedin', 'connect facebook to pepper lists',
        'muse agent access', 'agent access',
      ],
      answer:
        `Channel Connections, inside your Pepper Lists account, is where you link the channels for the Sell and Post purposes. Sell channels: Facebook Marketplace, Google Shopping, eBay, Etsy, and Walmart. Post channels: TikTok, Facebook, YouTube, Instagram, X, LinkedIn, and search directories. ` +
        `Tapping Connect files a connection request and the team completes the link on the platform side — a channel only ever shows Connected when the link is real. On each channel you can also grant Pepper, the Muse AI agent, access to manage it for you: off by default, revocable anytime, and every agent action is logged.`,
      link: 'https://www.pepperlists.com/how-it-works',
    },
    {
      id: 'site-pepper-lists-book',
      topic: 'Pepper Lists Book — book service from Pepper Lists',
      keywords: [
        'pepper lists book', 'book a repair on pepper lists', 'pepper lists booking',
        'book service on pepper lists',
      ],
      answer:
        `Pepper Lists Book is the booking purpose inside Pepper Lists: book appliance service with Speedy AI and Top Speed Service OS from the same account you sell and post with. ` +
        `The classic web form leads — it is the primary booking path — and Speedy AI booking sits below it as the high-tech option. When you book with Speedy, Speedy summarizes your details and you confirm before anything is sent to the Service Setters, and your job's tracking lives in the same account.`,
      link: 'https://www.pepperlists.com',
    },
    {
      id: 'site-pepper-lists-reviews',
      topic: 'Pepper Lists reviews — the public wall (part of Post)',
      keywords: [
        'reviews', 'review wall', 'leave a review', 'read reviews',
        'customer reviews', 'pepper lists reviews', 'verified repair review',
      ],
      answer:
        `The reviews wall is part of Pepper Lists Post: after a completed repair, the customer reviews the job in Pepper Lists — a star rating, a title and story, repair photos or video, and a short post-service survey — and Speedy replies to every review personally. ` +
        `A review tied to a finished job posts as a Verified Repair review, and published reviews appear on the public wall.`,
      link: 'https://www.pepperlists.com',
    },
    {
      id: 'site-referral',
      topic: 'Refer & Earn — the referral program (appliancereferral.com)',
      keywords: [
        'referral program', 'refer a friend', 'refer and earn', 'appliancereferral.com',
        'referral code', 'referral link', 'earn service credit', 'invite a friend',
      ],
      answer:
        `Refer & Earn is Top Speed's referral program — its own door is appliancereferral.com. When your job completes, you automatically get a personal referral code and link. A friend who books through it gets $25 off their first eligible repair (the New Customer Welcome). ` +
        `When the friend's job is completed and paid, you earn service credit: $25 per completed referral for the first four, $35 each from the 5th through the 9th, $50 each from the 10th on, plus one-time milestone bonuses of $100 at 10 and $250 at 25 lifetime completed referrals. A Service Setter approves each credit before it is issued, and credits expire 12 months after issuance.`,
      link: `${SITE}/refer`,
    },
    {
      id: 'site-advertise',
      topic: 'Advertise with Top Speed — Flywheel',
      keywords: [
        'advertise', 'advertising', 'advertise with you', 'flywheel',
        'run ads', 'advertiser', 'advertise my business',
      ],
      answer:
        `Businesses advertise across the Top Speed platforms through Flywheel: open an advertiser account, build a campaign, and — once the owner approves it — it runs as mini banners across the customer app, booking pages, and partner sites. ` +
        `The Advertise page explains the reach and how approval works.`,
      link: `${SITE}/advertise`,
    },
    {
      id: 'site-parts-supply',
      topic: 'Appliance Plus Parts Supply — the parts partner platform',
      keywords: [
        'parts supply', 'appliance plus', 'buy parts', 'parts catalog',
        'appliance parts', 'appliance plus parts supply',
      ],
      answer:
        `Appliance Plus Parts Supply is the parts partner platform in the Top Speed network — a parts catalog and ordering door for the trade, powered by PLUS AI. Its public catalog is labeled as a demonstration catalog; live parts ordering runs through the team. ` +
        `Parts used on a Top Speed job are recorded against that job from the parts warehouse.`,
      link: 'https://applianceplus.vercel.app',
    },
    {
      id: 'site-cococane',
      topic: 'CocoCane — Top Speed\'s coconut juice shop',
      keywords: ['cococane', 'coconut juice', 'coconut water', 'sugarcane sticks', 'buy coconuts', 'coconut drinks'],
      answer:
        `CocoCane is Top Speed's coconut juice shop, on Facebook: fresh coconut drinks at $5 / $15 / $30 by size, whole coconuts at $2–4, coconut meat at $7, and sugarcane sticks at $7.`,
      link: 'https://www.facebook.com/profile.php?id=61593313075645',
    },
    {
      id: 'site-customer-app',
      topic: 'The Top Speed customer app — Appliance Connect',
      keywords: ['customer app', 'the app', 'top speed app', 'mobile app', 'appliance connect app'],
      answer:
        `The Top Speed customer app is Appliance Connect: your appliances and their service history, booking, Track My Tech, offers, and your referral dashboard in one place. ` +
        `It is free and runs on the same account as the website — a job booked anywhere shows up here.`,
      link: `${SITE}/app`,
    },
    {
      id: 'site-connect-mobile',
      topic: 'Appliance Connect mobile — sign-in only',
      keywords: ['appliance connect mobile', 'mobile sign in', 'connect app on my phone', 'mobile account'],
      answer:
        `Appliance Connect mobile is the phone version of your customer account — bookings, tracking, garage, and referrals on the go. ` +
        `It is sign-in only: accounts are created on the web portal first, then the mobile app signs you in with the same account.`,
      link: 'https://appliance-connect.vercel.app/mobile',
    },
    {
      id: 'site-appliance-plug',
      topic: 'Appliance Plug — the techs\' plate-to-parts tool (clients only)',
      keywords: ['appliance plug', 'applianceplug.app', 'plate scan app', 'find parts by plate'],
      answer:
        `Appliance Plug is a tool for Top Speed technicians and clients: snap a photo of an appliance's model plate and it finds the matching parts. ` +
        `It is a client tool — there is no public app-store listing for it.`,
      link: 'https://www.applianceplug.app',
    },
    {
      id: 'site-speedy-pro',
      topic: 'Speedy Pro — the Tech App for providers & technicians',
      keywords: ['speedy pro', 'tech app', 'technician app', 'provider app'],
      answer:
        `Speedy Pro is the Tech App where Top Speed network providers and technicians receive job offers, run their work orders, record job photos and diagnoses, and share live status with customers. ` +
        `New technicians join through the provider network door at topspeedapplianceservice.com; the Speedy Pro page explains how the app works.`,
      link: `${SITE}/speedy-pro`,
    },
    {
      id: 'site-garage',
      topic: 'My Garage — your appliances and their history',
      keywords: ['my garage', 'garage', 'my appliances', 'appliance registry', 'service history'],
      answer:
        `My Garage is the appliance registry inside your account: every appliance you add, its model details, and its full service history in one place. ` +
        `From the garage you can book a repair for any appliance on the list, or track a job already in progress.`,
      link: `${SITE}/garage`,
    },
    {
      id: 'site-connected-appliances',
      topic: 'Connected appliances — register your smart appliances',
      keywords: ['connected appliance', 'connected appliances', 'smart appliance', 'smart appliances', 'home connect', 'smartthings', 'thinq', 'smarthq', 'wifi appliance', 'smart fridge', 'smart washer', 'connect my appliance'],
      answer:
        `If your appliance is a smart model, you can register it as a connected appliance in your account today: open My Appliances in the app, pick the appliance, choose its manufacturer network (Home Connect for Bosch, Siemens and Thermador, Samsung SmartThings, LG ThinQ, or GE SmartHQ), and confirm your consent. ` +
        `Registration records the connection on your Top Speed account right away. The live manufacturer link itself opens brand by brand, as each manufacturer approves Top Speed — once a brand is live, your appliance can share fault and status events with us so we can help service it faster. We never claim a brand is linked before it really is. ` +
        `Need service now? Booking a repair stays the path — a registered appliance simply means Speedy and your Service Setters already know your home.`,
      link: `${SITE}/app`,
    },
    {
      id: 'site-account',
      topic: 'Your account — dashboard & sign-in',
      keywords: ['my account', 'account dashboard', 'customer dashboard', 'sign in', 'log in', 'my bookings'],
      answer:
        `Your customer dashboard shows your bookings, your appliances, your offers, and your account details. ` +
        `One account works on every Top Speed door — sign in once and your record follows you, and if you hold more than one account, the account switcher moves between them without signing anyone out.`,
      link: `${SITE}/account`,
    },
    {
      id: 'site-download',
      topic: 'Get the apps — the download page',
      keywords: ['download', 'get the app', 'install the app', 'app download', 'download page'],
      answer:
        `The download page gathers the Top Speed apps: the customer app, Pepper Lists, Appliance Connect, and the pro doors — each one explained before you install anything, so you know exactly what each app is for.`,
      link: `${SITE}/download`,
    },
    {
      id: 'site-explore',
      topic: 'Explore — search, price preview, recommendations, compare',
      keywords: ['explore', 'price preview', 'compare services', 'search services', 'recommendations', 'cost estimate tool'],
      answer:
        `Explore is Top Speed's set of planning tools: search the services, get a price preview, see recommendations for your situation, and compare options side by side. ` +
        `A price preview is a planning aid only — it is never a quote. Your actual repair price is set by the technician's written quote after the diagnostic.`,
      link: `${SITE}/explore`,
    },
    {
      id: 'site-about',
      topic: 'About Top Speed — how the ecosystem works',
      keywords: ['about top speed', 'how it works', 'how does top speed work', 'the ecosystem', 'about the company'],
      answer:
        `Top Speed Appliance LLC is an appliance repair and installation company based in Coconut Creek, Florida, and every Top Speed website and app runs on the one Service OS — so a job booked anywhere is the same job everywhere, watched over by the human Service Setters. ` +
        `The About page maps the whole ecosystem: the customer doors, the provider network, and how a job flows from booking to completed repair.`,
      link: `${SITE}/about`,
    },
    {
      id: 'site-cleanout-vents-web',
      topic: 'Cleanout Vents\' own website — cleanoutvents.com',
      keywords: ['cleanoutvents.com', 'cleanout vents website', 'vent cleaning website'],
      answer:
        `Cleanout Vents has its own website at cleanoutvents.com: its three vent services, its Broward County service area, and its own booking door. ` +
        `On the Top Speed side, the Service Setters also coordinate Cleanout Vents work at ${PHONE} — vent pricing is confirmed by the team when you call; there is no published vent price.`,
      link: 'https://www.cleanoutvents.com',
    },
  ];

  // Generic offer questions land on this overview — NOT on a random
  // single program. It names only the programs with published
  // figures and points at the full catalog for the rest.
  entries.push({
    id: 'site-offers-overview',
    topic: 'Offers & programs — the catalog',
    keywords: [
      'offer', 'offers', 'do you offer', 'discount', 'deal', 'promotion', 'special',
      'programs', 'rewards programs', 'coupons', 'savings', 'gift card', 'gift cards',
    ],
    answer:
      `Top Speed runs ${OFFERS.length} customer programs. The two with published figures: New Customer Welcome — $25 off a first eligible repair for new registered customers — and Refer a Friend, which pays service credit under the published referral terms. ` +
      `The rest — multi-appliance savings, a first-booking bonus, seasonal checkups, maintenance rewards, multi-unit and property-partner pricing, business loyalty, priority membership, and commercial equipment care — run under their own terms, confirmed at booking. ` +
      `The full catalog is at ${SITE}/offers-rewards. Anything that is not in the catalog (gift cards, for example) is not a published program — the team can confirm at ${PHONE}.`,
    link: `${SITE}/offers-rewards`,
  });

  // One entry per published offer, generated from the catalog so the
  // amounts and terms Speedy states are always the published ones.
  // Keywords are the program's own name only — generic offer words
  // belong to the overview above.
  for (const offer of OFFERS) {
    entries.push({
      id: `site-offer-${offer.slug}`,
      topic: `Offer — ${offer.title}`,
      keywords: [
        offer.title.toLowerCase(),
        offer.slug.replace(/-/g, ' '),
      ],
      answer:
        `${offer.title}: ${offer.benefit} It is for ${offer.whoFor.charAt(0).toLowerCase()}${offer.whoFor.slice(1)}` +
        (offer.note ? ` ${offer.note}` : ''),
      link: `${SITE}/offers/${offer.slug}`,
    });
  }

  return entries;
}
