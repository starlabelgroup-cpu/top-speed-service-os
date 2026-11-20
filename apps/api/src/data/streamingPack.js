/**
 * Flywheel Streaming Pack (2026-11-17) — the 10 Google-style
 * streaming ads Ramone directed Flywheel AI Advertising to create:
 * 5 text + 5 display, one per core theme, aimed at streaming TV
 * providers. The provider names are TARGET LABELS only — no
 * streaming provider ad account is connected to this system, and
 * placing these ads on Roku / Hulu / etc. is a separate activation
 * (provider ad accounts + budget) the owner takes later.
 *
 * The pack loads through the owner-only action in Ad Studio
 * (POST /ad-studio/streaming-pack/load): each ad becomes a house
 * campaign in PENDING_APPROVAL under its fixed source tag
 * (flywheel-streaming-01 … -10), so loading is idempotent and
 * NOTHING in the pack is ever auto-activated — the owner approves
 * each ad like every other campaign.
 *
 * Copy rules (Ramone's, enforced again in the loader test):
 * no reviews / ratings / star claims; the $99 diagnostic is framed
 * residential-only and credited toward repair, and never appears
 * in the commercial / property-manager ad; no dryer-vent prices or
 * vent-cleaning offers; no phone numbers in ad text; no stats or
 * promises beyond what the live site already claims (same-day
 * service windows, 65 tri-county cities, the referral program's
 * approved economics: $25 credit per completed referral, $25 off
 * the referred friend's first repair, tiers up to $50).
 */

export const STREAMING_PROVIDERS = [
  { id: 'ROKU', label: 'Roku' },
  { id: 'YOUTUBE_TV', label: 'YouTube TV' },
  { id: 'HULU', label: 'Hulu' },
  { id: 'PEACOCK', label: 'Peacock' },
  { id: 'PARAMOUNT_PLUS', label: 'Paramount+' },
  { id: 'PLUTO_TV', label: 'Pluto TV' },
  { id: 'SAMSUNG_TV_PLUS', label: 'Samsung TV Plus' },
];

export const STREAMING_FORMATS = ['TEXT', 'DISPLAY'];

// Standard Google display sizes the display creatives are built for.
export const DISPLAY_SIZES = ['300x250', '728x90', '160x600', '320x50', '970x250', '336x280'];

const ALL_PROVIDERS = STREAMING_PROVIDERS.map((p) => p.id);
const TEXT_PROVIDERS = ['ROKU', 'YOUTUBE_TV', 'HULU', 'PEACOCK', 'PLUTO_TV'];

export const STREAMING_PACK = [
  {
    tag: 'flywheel-streaming-01',
    name: 'Streaming — Refrigerator Repair (Text)',
    format: 'TEXT',
    providers: TEXT_PROVIDERS,
    offering: 'Refrigerator repair',
    objective: 'Streaming text ad: refrigerator repair bookings to Speedy Booking.',
    headlines: [
      'Refrigerator Repair Near You',
      'Fridge Not Cooling? We Fix It',
      '$99 Diagnostic, Credited',
      'Top Speed Appliance Repair',
    ],
    descriptions: [
      'Fridge warm or leaking? Book a $99 home diagnostic — credited toward your approved repair.',
      'Same-day service windows across Broward, Palm Beach & Miami-Dade. Book online in minutes.',
    ],
    displayPath: 'Refrigerator-Repair',
    longHeadline: null,
    displaySizes: [],
    ctaText: 'Book Service',
    category: 'APPLIANCE_SERVICE',
    destinationUrl: 'https://topspeedserviceos.com/book',
  },
  {
    tag: 'flywheel-streaming-02',
    name: 'Streaming — Same-Day Appliance Repair (Display)',
    format: 'DISPLAY',
    providers: ALL_PROVIDERS,
    offering: 'Same-day appliance repair',
    objective: 'Streaming display ad: same-day appliance repair bookings to Speedy Booking.',
    headlines: ['Appliance Broken Today?'],
    descriptions: [
      'Book online, pick a same-day window, and a Service Setter confirms your visit by phone.',
    ],
    displayPath: null,
    longHeadline: 'Same-day appliance repair windows across the tri-county area',
    displaySizes: DISPLAY_SIZES,
    ctaText: 'Book Service',
    category: 'APPLIANCE_SERVICE',
    destinationUrl: 'https://topspeedserviceos.com/book',
  },
  {
    tag: 'flywheel-streaming-03',
    name: 'Streaming — Washer & Dryer Repair (Text)',
    format: 'TEXT',
    providers: TEXT_PROVIDERS,
    offering: 'Washer & dryer repair',
    objective: 'Streaming text ad: washer and dryer repair bookings to Speedy Booking.',
    headlines: [
      'Washer & Dryer Repair',
      'Washer Not Spinning?',
      'Dryer Not Heating?',
      '$99 Diagnostic, Credited',
    ],
    descriptions: [
      'Washer leaking or dryer cold? A $99 home diagnostic finds it — credited toward repair.',
      'Laundry piling up? Same-day windows in 65 tri-county cities. Book your repair online.',
    ],
    displayPath: 'Washer-Dryer-Repair',
    longHeadline: null,
    displaySizes: [],
    ctaText: 'Book Service',
    category: 'APPLIANCE_SERVICE',
    destinationUrl: 'https://topspeedserviceos.com/book',
  },
  {
    tag: 'flywheel-streaming-04',
    name: 'Streaming — Oven & Range Repair (Display)',
    format: 'DISPLAY',
    providers: ALL_PROVIDERS,
    offering: 'Oven & range repair',
    objective: 'Streaming display ad: oven and range repair bookings to Speedy Booking.',
    headlines: ['Oven or Range Not Heating?'],
    descriptions: [
      'Burner out or oven off-temp? $99 home diagnostic, credited toward your approved repair.',
    ],
    displayPath: null,
    longHeadline: 'Oven, range and cooktop repair by Top Speed Appliance',
    displaySizes: DISPLAY_SIZES,
    ctaText: 'Book Service',
    category: 'APPLIANCE_SERVICE',
    destinationUrl: 'https://topspeedserviceos.com/book',
  },
  {
    tag: 'flywheel-streaming-05',
    name: 'Streaming — Dishwasher Repair (Text)',
    format: 'TEXT',
    providers: TEXT_PROVIDERS,
    offering: 'Dishwasher repair',
    objective: 'Streaming text ad: dishwasher repair bookings to Speedy Booking.',
    headlines: [
      'Dishwasher Repair Near You',
      'Dishwasher Leaking?',
      'Dishes Still Dirty?',
      '$99 Diagnostic, Credited',
    ],
    descriptions: [
      'Dishwasher leaking or dishes still dirty? A $99 diagnostic — credited toward repair.',
      'Same-day windows across Broward, Palm Beach & Miami-Dade. Book online in minutes.',
    ],
    displayPath: 'Dishwasher-Repair',
    longHeadline: null,
    displaySizes: [],
    ctaText: 'Book Service',
    category: 'APPLIANCE_SERVICE',
    destinationUrl: 'https://topspeedserviceos.com/book',
  },
  {
    tag: 'flywheel-streaming-06',
    name: 'Streaming — Appliance Installation (Display)',
    format: 'DISPLAY',
    providers: ALL_PROVIDERS,
    offering: 'Appliance installation',
    objective: 'Streaming display ad: appliance installation bookings to Speedy Booking.',
    headlines: ['Appliance Installation'],
    descriptions: [
      'Washer, dryer, dishwasher & range installation — flat $150, booked online in minutes.',
    ],
    displayPath: null,
    longHeadline: 'Professional installation for kitchen & laundry appliances',
    displaySizes: DISPLAY_SIZES,
    ctaText: 'Book Service',
    category: 'APPLIANCE_SERVICE',
    destinationUrl: 'https://topspeedserviceos.com/book',
  },
  {
    tag: 'flywheel-streaming-07',
    name: 'Streaming — Property Managers & Commercial (Text)',
    format: 'TEXT',
    providers: TEXT_PROVIDERS,
    offering: 'Commercial & property-manager appliance service',
    objective: 'Streaming text ad: property-manager and commercial service inquiries to the commercial door. No $99 diagnostic — commercial is priced by written quote.',
    headlines: [
      'Property Manager Repairs',
      'Commercial Appliance Service',
      'One Call for Every Unit',
      'Top Speed Appliance',
    ],
    descriptions: [
      'Appliance repair & installation for every property you manage — priced by written quote.',
      'Business sign-in, priority booking and one point of contact for your whole portfolio.',
    ],
    displayPath: 'Property-Managers',
    longHeadline: null,
    displaySizes: [],
    ctaText: 'Learn More',
    category: 'APPLIANCE_SERVICE',
    destinationUrl: 'https://topspeedserviceos.com/commercial',
  },
  {
    tag: 'flywheel-streaming-08',
    name: 'Streaming — Speedy AI Photo Diagnosis (Display)',
    format: 'DISPLAY',
    providers: ALL_PROVIDERS,
    offering: 'Speedy AI photo diagnosis',
    objective: 'Streaming display ad: Speedy AI photo diagnosis trials on the Speedy page.',
    headlines: ['Snap It. Speedy Reads It.'],
    descriptions: [
      'Snap a photo: Speedy AI flags the likely issue before the visit. Tech confirms in person.',
    ],
    displayPath: null,
    longHeadline: 'Send a photo of your appliance — Speedy AI gives you a head start',
    displaySizes: DISPLAY_SIZES,
    ctaText: 'Get My Repair',
    category: 'APPLIANCE_SERVICE',
    destinationUrl: 'https://topspeedserviceos.com/speedy',
  },
  {
    tag: 'flywheel-streaming-09',
    name: 'Streaming — Referral Program (Text)',
    format: 'TEXT',
    providers: TEXT_PROVIDERS,
    offering: 'Referral program — earn repair credit',
    objective: 'Streaming text ad: referral program sign-ups on the Refer & Earn page.',
    headlines: [
      'Refer a Friend, Earn $25',
      'Earn Repair Credit',
      'Give $25 Off a First Repair',
      'Top Speed Refer & Earn',
    ],
    descriptions: [
      'Friends get $25 off their first repair. You earn a $25 credit when their job is done.',
      'Earn up to $50 per referral as your count grows, plus milestone bonuses. Start today.',
    ],
    displayPath: 'Refer-and-Earn',
    longHeadline: null,
    displaySizes: [],
    ctaText: 'Learn More',
    category: 'GENERAL',
    destinationUrl: 'https://topspeedserviceos.com/refer',
  },
  {
    tag: 'flywheel-streaming-10',
    name: 'Streaming — Tri-County Coverage, 104 Cities (Display)',
    format: 'DISPLAY',
    providers: ALL_PROVIDERS,
    offering: 'Tri-county appliance repair coverage',
    objective: 'Streaming display ad: local appliance repair bookings across the 104-city tri-county coverage area.',
    headlines: ['104 Cities. One Fast Team.'],
    descriptions: [
      'Broward, Palm Beach & Miami-Dade: book appliance repair in your city in minutes.',
    ],
    displayPath: null,
    longHeadline: 'Appliance repair across Broward, Palm Beach & Miami-Dade',
    displaySizes: DISPLAY_SIZES,
    ctaText: 'Book Service',
    category: 'APPLIANCE_SERVICE',
    destinationUrl: 'https://topspeedserviceos.com/book',
  },
];
