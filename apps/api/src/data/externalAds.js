/**
 * Top Speed Ads — External platforms registry (2026-11-17).
 *
 * The mirror of the Flywheel campaigns that live in OUTSIDE ad
 * platforms (Google Ads, Meta, Microsoft Ads), shown read-only in
 * Ad Studio as the readiness board. This file is the single source
 * for that board: update it by hand when a campaign is built,
 * verified, funded or launched in its platform.
 *
 * HONESTY RULES for this registry:
 * - It is a MIRROR, not a sync. Nothing here calls an external ad
 *   API, and no status in this file is fresher than
 *   EXTERNAL_ADS_VERIFIED_ON. The board says so, with the date.
 * - Every campaign below was created PAUSED or left as an
 *   unpublished DRAFT with $0 spend (verified 2026-11-17). Budgets
 *   are the PROPOSED daily amounts from the build sheets until
 *   Ramone approves each one in the platform.
 * - missingSteps are the concrete blockers between this campaign
 *   and going live; ownerOnly marks the steps only Ramone can do
 *   (funding, terms, launch decisions, account identity calls).
 */

export const EXTERNAL_ADS_VERIFIED_ON = '2026-11-17';

export const EXTERNAL_ADS_BOARD_LABEL =
  'Mirror of campaigns built in each platform — status as last verified 2026-11-17; manage budgets and launch inside the platform. Nothing here spends money.';

const GOOGLE_ACCOUNT = 'Top Speed Ads (648-991-4065)';
const META_ACCOUNT = 'Meta Ads (834084027055828)';
const MICROSOFT_ACCOUNT = "Microsoft Ads — account named 'Appliance Plus Air, LLC' (F120S3K3)";

const googleSteps = [
  { label: 'Funding decision: add the account prepayment in Google Ads before anything can run', ownerOnly: true },
  { label: 'Launch decision: unpause this campaign in Google Ads', ownerOnly: true },
];
const metaSteps = [
  { label: 'Publish decision: this campaign is an unpublished draft — publish it in Ads Manager to go live', ownerOnly: true },
  { label: 'Meta pixel is not installed: campaigns run on the Traffic objective until the pixel is installed and approved', ownerOnly: false },
];

export const EXTERNAL_ADS = [
  // ── Google Ads — 3 campaigns, all PAUSED, $0 spend ──────────────
  {
    id: 'google-commercial-portal',
    platform: 'google',
    platformLabel: 'Google Ads',
    accountLabel: GOOGLE_ACCOUNT,
    name: 'appliancepro.net — Commercial Portal',
    status: 'PAUSED',
    dailyBudgetUsd: 15,
    destinationUrl: 'https://www.appliancepro.net',
    note: 'Search campaign for the commercial portal. Commercial copy carries no $99 diagnostic — custom quote only.',
    missingSteps: [
      ...googleSteps,
      { label: 'Optional: the account-level conversion goal reads "Phone call leads" (account default) — no website-visit conversion action exists yet', ownerOnly: false },
    ],
  },
  {
    id: 'google-refer-earn',
    platform: 'google',
    platformLabel: 'Google Ads',
    accountLabel: GOOGLE_ACCOUNT,
    name: 'appliancereferral.com — Refer & Earn',
    status: 'PAUSED',
    dailyBudgetUsd: 5,
    destinationUrl: 'https://appliancereferral.com',
    note: 'Search campaign for the referral program ($25 credit terms as approved).',
    missingSteps: [...googleSteps],
  },
  {
    id: 'google-youtube-video',
    platform: 'google',
    platformLabel: 'Google Ads',
    accountLabel: GOOGLE_ACCOUNT,
    name: 'Top Speed Appliance — YouTube Video — Broward',
    status: 'PAUSED',
    dailyBudgetUsd: 5,
    destinationUrl: 'https://topspeedserviceos.com/book',
    note: 'Video views campaign using the real 34-second Top Speed video on the channel.',
    missingSteps: [...googleSteps],
  },
  // ── Meta (Facebook + Instagram) — 9 campaigns, all DRAFT ────────
  {
    id: 'meta-m1-refrigerator',
    platform: 'meta',
    platformLabel: 'Meta (Facebook + Instagram)',
    accountLabel: META_ACCOUNT,
    name: 'Refrigerator Repair Bookings',
    status: 'DRAFT',
    dailyBudgetUsd: 10,
    destinationUrl: 'https://topspeedserviceos.com/book',
    note: 'Page: Top Speed Appliance Repair and Installation. Traffic objective.',
    missingSteps: [...metaSteps],
  },
  {
    id: 'meta-m2-appliance-repair',
    platform: 'meta',
    platformLabel: 'Meta (Facebook + Instagram)',
    accountLabel: META_ACCOUNT,
    name: 'Appliance Repair Bookings',
    status: 'DRAFT',
    dailyBudgetUsd: 10,
    destinationUrl: 'https://topspeedserviceos.com/book',
    note: 'Page: Top Speed Appliance Repair and Installation. Traffic objective.',
    missingSteps: [...metaSteps],
  },
  {
    id: 'meta-m3-refer-earn',
    platform: 'meta',
    platformLabel: 'Meta (Facebook + Instagram)',
    accountLabel: META_ACCOUNT,
    name: 'Refer & Earn',
    status: 'DRAFT',
    dailyBudgetUsd: 5,
    destinationUrl: 'https://topspeedserviceos.com/refer',
    note: 'Page: Top Speed Appliance Repair and Installation. Traffic objective.',
    missingSteps: [...metaSteps],
  },
  {
    id: 'meta-m4-net-residential',
    platform: 'meta',
    platformLabel: 'Meta (Facebook + Instagram)',
    accountLabel: META_ACCOUNT,
    name: '.net Residential Repair',
    status: 'DRAFT',
    dailyBudgetUsd: 10,
    destinationUrl: 'https://topspeedappliance.net/',
    note: 'Three ad sets (refrigerator, washer, service areas) landing on matching .net pages.',
    missingSteps: [...metaSteps],
  },
  {
    id: 'meta-m5-commercial',
    platform: 'meta',
    platformLabel: 'Meta (Facebook + Instagram)',
    accountLabel: META_ACCOUNT,
    name: 'appliancepro.net Commercial',
    status: 'DRAFT',
    dailyBudgetUsd: 10,
    destinationUrl: 'https://appliancepro.net/',
    note: 'Commercial copy carries no $99 diagnostic — custom quote only.',
    missingSteps: [...metaSteps],
  },
  {
    id: 'meta-m6-cleanout-vents',
    platform: 'meta',
    platformLabel: 'Meta (Facebook + Instagram)',
    accountLabel: META_ACCOUNT,
    name: 'Cleanout Vents',
    status: 'DRAFT',
    dailyBudgetUsd: 10,
    destinationUrl: 'https://www.cleanoutvents.com/',
    note: 'Runs under the Cleanout Vents Page. No vent prices in copy, ever.',
    missingSteps: [...metaSteps],
  },
  {
    id: 'meta-m7-connect-pro',
    platform: 'meta',
    platformLabel: 'Meta (Facebook + Instagram)',
    accountLabel: META_ACCOUNT,
    name: 'Appliance Connect Pro',
    status: 'DRAFT',
    dailyBudgetUsd: 10,
    destinationUrl: 'https://www.applianceconnectpro.com/',
    note: 'Homeowners & property managers portal.',
    missingSteps: [...metaSteps],
  },
  {
    id: 'meta-m8-pepper-lists',
    platform: 'meta',
    platformLabel: 'Meta (Facebook + Instagram)',
    accountLabel: META_ACCOUNT,
    name: 'Pepper Lists It',
    status: 'DRAFT',
    dailyBudgetUsd: 5,
    destinationUrl: 'https://www.pepperlists.com/',
    note: 'Page: Top Speed Appliances Sales and Delivery.',
    missingSteps: [...metaSteps],
  },
  {
    id: 'meta-m9-cococane',
    platform: 'meta',
    platformLabel: 'Meta (Facebook + Instagram)',
    accountLabel: META_ACCOUNT,
    name: 'CocoCane',
    status: 'DRAFT',
    dailyBudgetUsd: 5,
    destinationUrl: 'https://www.facebook.com/profile.php?id=1295885296935627',
    note: 'Destination is the CocoCane Facebook Page itself; copy carries the locked CocoCane prices.',
    missingSteps: [...metaSteps],
  },
  // ── Microsoft Ads (Bing) — 1 campaign, PAUSED ───────────────────
  {
    id: 'microsoft-net-residential',
    platform: 'microsoft',
    platformLabel: 'Microsoft Ads (Bing)',
    accountLabel: MICROSOFT_ACCOUNT,
    name: 'Flywheel — .net Residential Repair (Bing)',
    status: 'PAUSED',
    dailyBudgetUsd: 20,
    destinationUrl: 'https://topspeedappliance.net',
    note: 'Budget is a placeholder. The campaign was built in the only Microsoft Ads account found under Ramone\'s Microsoft sign-in.',
    missingSteps: [
      { label: 'Account-name decision: the account is named "Appliance Plus Air, LLC" (a separate LLC) — decide whether this campaign stays there or is rebuilt under a Top Speed-named account', ownerOnly: true },
      { label: 'Funding: the account balance is zero / on hold — adding billing is done in Microsoft Ads', ownerOnly: true },
      { label: 'Launch decision: unpause this campaign in Microsoft Ads', ownerOnly: true },
    ],
  },
];
