// Top Speed Media OS — Phase 1 seed content (2026-11-14).
//
// Create-only by slug (prisma/seed.mjs checks existence first, exactly
// like the Phase 2 Marketing OS pages): reseeding NEVER overwrites a
// record, so console edits and status changes are safe.
//
// Sources are real platform records, not inventions:
//   - The 25 Flywheel visual ads: headlines and destination URLs are
//     the approved copy map in ~/workspace/your_files/flywheel-ads/
//     (index.html). Ad 01 is genuinely published on the Top Speed
//     Appliance Repair and Installation Facebook Page, so it seeds as
//     PUBLISHED with the real post URL as its destination. Ads 02–25
//     are exported and staged for the daily rotation but NOT posted,
//     so they seed as DRAFT. The creative JPGs live in the workspace
//     and the Figma file — they have no public URL, so assetUrl stays
//     null rather than inventing one.
//   - The 29 Training Academy modules: rendered MP4s in
//     ~/workspace/your_files/training-academy/. 25 carry hosted links
//     that EXPIRE 2026-11-15/16 and 4 were delivered in chat; there is
//     no permanent public URL yet, so assetUrl stays null and every
//     module seeds as DRAFT with the expiry noted in its description.

const FLYWHEEL_ADS = [
  { n: '01', headline: 'Refrigerator Repair', sub: '$99 diagnostic — credited toward your repair', dest: 'https://facebook.com/61596590488055/posts/pfbid0Y9fCyrCj3hcHVwkk99Z1Lr4S3BS3FNkunSNUEFubV2grTBU7CtxuGj2ARfeUx7iZl/', status: 'PUBLISHED', publishedAt: '2026-11-14T03:05:00.000Z' },
  { n: '02', headline: 'Real Diagnosis. Real Meters.', sub: 'Photo diagnosis with Speedy AI', dest: 'https://topspeedserviceos.com/speedy', status: 'DRAFT' },
  { n: '03', headline: 'Oven & Range Repair', sub: 'Flat $210 labor — parts quoted up front', dest: 'https://topspeedserviceos.com/offers-rewards', status: 'DRAFT' },
  { n: '04', headline: 'Dishwasher Repair & Install', sub: 'Book in minutes', dest: 'https://topspeedserviceos.com/book', status: 'DRAFT' },
  { n: '05', headline: 'Washer Repair', sub: '$25 off your first repair — new customers', dest: 'https://topspeedserviceos.com/offers-rewards', status: 'DRAFT' },
  { n: '06', headline: 'Oven Repair', sub: 'Flat $210 labor', dest: 'https://topspeedserviceos.com/book', status: 'DRAFT' },
  { n: '07', headline: 'Appliance Installation', sub: '$150 flat installation', dest: 'https://topspeedserviceos.com/book', status: 'DRAFT' },
  { n: '08', headline: 'Freezer & Ice Maker Repair', sub: 'Book in minutes', dest: 'https://topspeedserviceos.com/book', status: 'DRAFT' },
  { n: '09', headline: 'Microwave Repair', sub: 'Ask Speedy first', dest: 'https://topspeedserviceos.com/speedy', status: 'DRAFT' },
  { n: '10', headline: 'Stove Not Heating?', sub: 'We diagnose it right', dest: 'https://topspeedserviceos.com/book', status: 'DRAFT' },
  { n: '11', headline: 'Documented. Every Visit.', sub: 'Track your tech live', dest: 'https://topspeedserviceos.com/track', status: 'DRAFT' },
  { n: '12', headline: 'Built-In Oven Installation', sub: '$150 flat installation', dest: 'https://topspeedserviceos.com/book', status: 'DRAFT' },
  { n: '13', headline: 'Happy Customers Earn', sub: 'Refer a friend — earn $25 credit', dest: 'https://topspeedserviceos.com/refer', status: 'DRAFT' },
  { n: '14', headline: 'Washer & Dryer Hookups', sub: 'Installed right, first time', dest: 'https://topspeedserviceos.com/book', status: 'DRAFT' },
  { n: '15', headline: "We Test. We Don't Guess.", sub: 'Photo diagnosis with Speedy AI', dest: 'https://topspeedserviceos.com/speedy', status: 'DRAFT' },
  { n: '16', headline: 'Oven & Range Repair', sub: 'Flat $210 labor', dest: 'https://topspeedserviceos.com/offers-rewards', status: 'DRAFT' },
  { n: '17', headline: 'Dishwasher Leaking?', sub: 'Book a diagnosis', dest: 'https://topspeedserviceos.com/book', status: 'DRAFT' },
  { n: '18', headline: 'Range Repair Pros', sub: 'Create your free account', dest: 'https://topspeedserviceos.com/signup', status: 'DRAFT' },
  { n: '19', headline: 'Front-Load Washer Repair', sub: 'Flat $210 labor', dest: 'https://topspeedserviceos.com/offers-rewards', status: 'DRAFT' },
  { n: '20', headline: 'Oven Door & Heating', sub: 'Fixed right', dest: 'https://topspeedserviceos.com/book', status: 'DRAFT' },
  { n: '21', headline: 'Freezer Repair, Done Right', sub: 'Book in minutes', dest: 'https://topspeedserviceos.com/book', status: 'DRAFT' },
  { n: '22', headline: 'Fridge Not Cooling?', sub: 'Ask Speedy — photo diagnosis', dest: 'https://topspeedserviceos.com/speedy', status: 'DRAFT' },
  { n: '23', headline: 'Dishwasher Repair', sub: 'Flat $210 labor', dest: 'https://topspeedserviceos.com/book', status: 'DRAFT' },
  { n: '24', headline: 'Deep-Dive Diagnostics', sub: '$99 diagnostic, credited toward repair', dest: 'https://topspeedserviceos.com/book', status: 'DRAFT' },
  { n: '25', headline: 'Property Managers & Commercial', sub: 'Priority accounts on Appliance Connect Pro', dest: 'https://topspeedserviceos.com/connect-pro-site', status: 'DRAFT' },
];

const TRAINING_MODULES = [
  [1, 'Welcome to Top Speed'], [2, 'Job Journey & Track My Tech'], [3, 'Working With Speedy AI'],
  [4, 'Owner Command Center'], [5, 'Money: Finance OS & QuickBooks'], [6, 'Your Google Empire'],
  [7, 'People, Roles & Legal Terms'], [8, 'Marketing OS Studio'], [9, 'Local OS, Listings & Reviews'],
  [10, 'Chat Insights'], [11, 'Notifications & Alerts'], [12, 'Tech App: Offers & Accepting Jobs'],
  [13, 'In the Field: Status & GPS'], [14, 'Photo Diagnosis & AI Notes'], [15, 'Parts, Completion & The Review Ask'],
  [16, 'Service Book Pro: The Setter Queue'], [17, 'Taking Bookings'], [18, 'Areas, Windows & The Waitlist'],
  [19, 'CRM 360 & Speedy Drafts'], [20, 'The Dispatch Board'], [21, 'Live Tracking & Exceptions'],
  [22, 'Escalations & Out-of-Area'], [23, 'Advertiser Console & Media OS'], [24, 'Google Ads'],
  [25, 'Facebook Ads & Lead Ads'], [26, 'Attribution & Offline Conversions'], [27, 'The Four Front Doors, In Depth'],
  [28, 'Offers & The Referral Program'], [29, 'Pricing, Terms & The $99 Diagnostic'],
];

function slugify(text) {
  return String(text).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export const MEDIA_CONTENT_SEEDS = [
  ...FLYWHEEL_ADS.map((ad) => ({
    slug: `flywheel-ad-${ad.n}-${slugify(ad.headline)}`,
    type: 'SOCIAL_POST',
    division: 'SOCIAL',
    title: ad.headline,
    description: `Flywheel visual ad ${ad.n} of 25. ${ad.sub}. Creative exported at 3240×3240 from the Flywheel Visual Ads Figma page; the JPG lives in the workspace gallery (your_files/flywheel-ads) and has no public URL yet.`,
    assetUrl: null,
    thumbnailUrl: null,
    durationSec: null,
    transcript: null,
    destinationUrl: ad.dest,
    status: ad.status,
    publishAt: null,
    publishedAt: ad.publishedAt || null,
    tags: ['flywheel', 'visual-ad'],
  })),
  ...TRAINING_MODULES.map(([num, title]) => ({
    slug: `training-module-${String(num).padStart(2, '0')}-${slugify(title)}`,
    type: 'VIDEO',
    division: 'VIDEOS',
    title: `Module ${num}: ${title}`,
    description: 'Top Speed Training Academy module (MP4 rendered and verified 2026-11-13). Hosted copies of modules 1–25 expire 2026-11-15/16 and modules 26–29 were delivered in chat; a permanent home on the Service OS is pending, so no public asset URL is recorded yet.',
    assetUrl: null,
    thumbnailUrl: null,
    durationSec: null,
    transcript: null,
    destinationUrl: null,
    status: 'DRAFT',
    publishAt: null,
    publishedAt: null,
    tags: ['training-academy'],
  })),
];
