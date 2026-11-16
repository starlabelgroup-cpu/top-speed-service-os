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
