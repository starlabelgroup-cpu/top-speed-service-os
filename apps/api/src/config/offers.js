/**
 * Offers catalog — the single source of truth for the 12 programs
 * published on /offers-rewards (2026-11-12).
 *
 * `benefit` strings are the EXACT copy published in the offers table;
 * they are reproduced verbatim on each offer page. Where the published
 * copy is deliberately general, NO dollar amount or term is invented
 * here either — eligibility is confirmed at booking, as the published
 * page itself says. The two programs with real published numbers keep
 * them: New Customer Welcome ($25 off the new customer's first
 * eligible repair — a different $25 from the referral program's
 * referrer service credit) and Refer a Friend (the approved referral
 * economics published on /refer).
 *
 * Each offer preselects the sign-up account type that matches its
 * audience; the stored signupAudience is the readable form, and
 * appPath is where a verified account for that audience lands
 * (portal separation: customers → /app, commercial → Appliance Pro,
 * property managers → Connect Pro).
 */
export const OFFER_SIGNUP_TYPES = {
  homeowner: { audience: 'homeowner', appPath: '/app', label: 'Homeowner / Residential Customer' },
  business: { audience: 'commercial', appPath: '/appliance-pro', label: 'Business / Commercial Customer' },
  pm: { audience: 'property-manager', appPath: '/connect-pro-app', label: 'Property Manager' },
};

const HOW_SIGNUP = 'Create your free account with the sign-up form on this page and sign the account terms.';
const HOW_VERIFY = 'Verify your email — we send one verification link; it takes one click and confirms the address your confirmations go to.';
const HOW_PROFILE = 'Add your service address so we match you to the right area team before you ever need us.';

export const OFFERS = [
  {
    slug: 'new-customer-welcome',
    title: 'New Customer Welcome',
    benefit: '$25 off your first eligible repair — for new registered customers. Minimum service charge and exclusions apply.',
    signupType: 'homeowner',
    whoFor: 'Homeowners registering a Top Speed account for the first time.',
    howItWorks: [
      HOW_SIGNUP,
      HOW_VERIFY,
      'Book your first repair — the $25 welcome discount is applied to that first eligible repair when the team confirms it at booking.',
    ],
    note: 'This is $25 off YOUR first repair as a new customer. It is separate from the referral program, where the person who refers a friend earns service credit when the friend\u2019s job is completed.',
  },
  {
    slug: 'multi-appliance-service-savings',
    title: 'Multi-Appliance Service Savings',
    benefit: 'Special pricing when multiple appliances are serviced during one visit, subject to eligibility.',
    signupType: 'homeowner',
    whoFor: 'Homes with more than one appliance that needs attention on the same visit.',
    howItWorks: [
      HOW_SIGNUP,
      HOW_VERIFY,
      HOW_PROFILE,
      'When you book, tell Speedy or the booking form about every appliance for the visit — the team applies the multi-appliance pricing you qualify for at booking.',
    ],
    note: 'One visit, one trip — pricing is confirmed at booking based on the appliances serviced.',
  },
  {
    slug: 'commercial-equipment-care',
    title: 'Commercial Equipment Care',
    benefit: 'Introductory commercial equipment assessment and a customized maintenance-plan proposal.',
    signupType: 'business',
    whoFor: 'Restaurants, hotels, laundromats, healthcare, offices, retail and facilities running commercial appliances.',
    howItWorks: [
      HOW_SIGNUP,
      HOW_VERIFY,
      'The commercial team schedules your introductory equipment assessment.',
      'You receive a customized maintenance-plan proposal for your equipment — commercial accounts are priced by custom quote.',
    ],
    note: 'Commercial service is custom-quoted per account; the residential diagnostic fee does not apply to commercial accounts.',
  },
  {
    slug: 'appliance-connect-rewards',
    title: 'Appliance Connect Rewards',
    benefit: 'Account-registration incentives, referral credits and member-only offers for Connect members.',
    signupType: 'homeowner',
    whoFor: 'Appliance Connect members — every registered customer account.',
    howItWorks: [
      HOW_SIGNUP,
      HOW_VERIFY,
      HOW_PROFILE,
      'Your Connect membership carries your incentives, referral credits and member-only offers in one account — book, track and manage from the customer app.',
    ],
    note: 'Member offers run under their own terms; the team applies whatever you qualify for at booking.',
  },
  {
    slug: 'first-booking-bonus',
    title: 'First Booking Bonus',
    benefit: 'A promotional incentive for an eligible first service booking.',
    signupType: 'homeowner',
    whoFor: 'New customers placing their first service booking with Top Speed.',
    howItWorks: [
      HOW_SIGNUP,
      HOW_VERIFY,
      'Place your first service booking from your account — the promotional incentive for an eligible first booking is confirmed at booking.',
    ],
    note: 'Eligibility is confirmed at booking; this program has its own terms and does not stack unless the team confirms it.',
  },
  {
    slug: 'refer-a-friend',
    title: 'Refer a Friend',
    benefit: 'Referral credits under the referral program rules — your code is issued automatically when a job completes.',
    signupType: 'homeowner',
    whoFor: 'Any Top Speed customer — your referral code is issued automatically when a job completes.',
    howItWorks: [
      HOW_SIGNUP,
      HOW_VERIFY,
      'Complete a job with Top Speed and your personal referral code is issued automatically.',
      'Share your code. When a friend\u2019s job is completed and paid, you earn service credit: $25 for each of your first referrals, $35 each from your 5th, and $50 each from your 10th — plus a one-time $100 bonus at 10 lifetime referrals and $250 at 25. Credits expire 12 months after the day they are issued.',
    ],
    note: 'Full program rules live on the Refer & Earn page. Credits are service credit toward future Top Speed service — and they are a different $25 from the New Customer Welcome discount your friend gets on their first repair.',
    programLink: { href: '/refer', label: 'See Refer & Earn — the full referral program' },
  },
  {
    slug: 'maintenance-rewards',
    title: 'Maintenance Rewards',
    benefit: 'Benefits for repeat maintenance or qualifying service activity.',
    signupType: 'homeowner',
    whoFor: 'Homeowners who keep their appliances maintained with repeat Top Speed visits.',
    howItWorks: [
      HOW_SIGNUP,
      HOW_VERIFY,
      HOW_PROFILE,
      'Book maintenance or service from your account — qualifying activity is recorded against your account and your rewards are applied by the team.',
    ],
    note: 'Rewards follow your account\u2019s recorded service activity; the team confirms what you qualify for at booking.',
  },
  {
    slug: 'seasonal-checkup',
    title: 'Seasonal Checkup',
    benefit: 'Seasonal maintenance promotions for selected appliance categories.',
    signupType: 'homeowner',
    whoFor: 'Homeowners who want a seasonal once-over for selected appliances before the season changes.',
    howItWorks: [
      HOW_SIGNUP,
      HOW_VERIFY,
      'Watch your account and email for the seasonal checkup promotions on selected appliance categories, and book the checkup from your account while the promotion runs.',
    ],
    note: 'Seasonal promotions run for selected categories and windows; availability is confirmed at booking.',
  },
  {
    slug: 'multi-unit-discount',
    title: 'Multi-Unit Discount',
    benefit: 'Eligible pricing for multiple appliances or units.',
    signupType: 'pm',
    whoFor: 'Property managers with multiple units — and households with several appliances — needing service across them.',
    howItWorks: [
      HOW_SIGNUP,
      HOW_VERIFY,
      HOW_PROFILE,
      'Book service for your appliances or units from your account — eligible multi-unit pricing is confirmed at booking based on the units serviced.',
    ],
    note: 'Pricing follows the appliances or units actually serviced; confirmed at booking.',
  },
  {
    slug: 'property-partner-program',
    title: 'Property Partner Program',
    benefit: 'Portfolio pricing or account benefits for qualifying property partners.',
    signupType: 'pm',
    whoFor: 'Property managers and portfolio owners who place recurring service across their properties.',
    howItWorks: [
      HOW_SIGNUP,
      HOW_VERIFY,
      'Add your service addresses so each property routes to its area team.',
      'The team reviews your portfolio and confirms the partner pricing or account benefits you qualify for.',
    ],
    note: 'Partner benefits are set per portfolio after review — nothing is promised before the team confirms your portfolio.',
  },
  {
    slug: 'business-loyalty',
    title: 'Business Loyalty',
    benefit: 'Commercial account benefits based on an approved loyalty structure.',
    signupType: 'business',
    whoFor: 'Commercial accounts with recurring equipment service needs.',
    howItWorks: [
      HOW_SIGNUP,
      HOW_VERIFY,
      'Run your work orders through your commercial account so your service activity builds your loyalty record.',
      'Loyalty benefits follow the approved structure for your account, confirmed by the commercial team.',
    ],
    note: 'Commercial accounts are priced by custom quote; loyalty benefits are applied under the structure approved for your account.',
  },
  {
    slug: 'priority-membership',
    title: 'Priority Membership',
    benefit: 'Eligible priority scheduling and membership benefits, subject to capacity and terms.',
    signupType: 'homeowner',
    whoFor: 'Households that want priority scheduling when something breaks.',
    howItWorks: [
      HOW_SIGNUP,
      HOW_VERIFY,
      HOW_PROFILE,
      'Book from your member account — eligible bookings get priority scheduling, subject to capacity, and your membership benefits apply under the program terms.',
    ],
    note: 'Priority scheduling is subject to capacity at the time you book; membership terms are confirmed for your account.',
  },
];

export function getOffer(slug) {
  return OFFERS.find((offer) => offer.slug === slug) || null;
}

/** Where a verified account lands, by stored signup audience. */
export function appPathForAudience(audience) {
  for (const type of Object.values(OFFER_SIGNUP_TYPES)) {
    if (type.audience === audience) return type.appPath;
  }
  return '/app';
}

/** Public catalog shape served to the web (GET /offers). */
export function publicOffer(offer) {
  const type = OFFER_SIGNUP_TYPES[offer.signupType];
  return {
    slug: offer.slug,
    title: offer.title,
    benefit: offer.benefit,
    audience: type.audience,
    audienceLabel: type.label,
    appPath: type.appPath,
    whoFor: offer.whoFor,
    howItWorks: offer.howItWorks,
    note: offer.note || null,
    programLink: offer.programLink || null,
    pagePath: `/offers/${offer.slug}`,
  };
}
