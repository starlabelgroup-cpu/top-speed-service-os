/**
 * Pepper Chat — the staff knowledge pack (2026-11-18).
 *
 * The grounded facts Pepper answers from in the Workstation chat
 * bar: the standing work rules of the Top Speed Service OS, the
 * pricing and program terms exactly as published, and the
 * new-employee onboarding path. Entries are { topic, keywords,
 * answer } — the same shape as Speedy's knowledge packs, ranked by
 * the shared scorer (knowledge/index.js searchEntries).
 *
 * The standing orders themselves (authority limits, Rule Zero, the
 * owner's directive, the standing duties) and the console map are
 * NOT duplicated here: services/pepperChat.js builds those entries
 * live from services/pepperConsole.js and data/systemMap.js, so
 * this pack can never drift from the charter or the map.
 *
 * Honesty rule: every fact here is a published platform fact or a
 * standing owner rule. No live counts, no invented policies.
 */

export const PEPPER_STAFF_PACK = [
  {
    topic: 'Form-first booking rule',
    keywords: ['form first', 'booking form', 'web form', 'classic booking', 'speedy booking order', 'which booking path'],
    answer:
      'The classic web form is the PRIMARY booking path on every surface — it leads, and Speedy AI booking sits below it as the option for high-tech customers. Speedy chat itself stays everywhere for questions and photo diagnosis. Never hide, remove, or gate the form behind chat.',
  },
  {
    topic: 'Speedy summary-confirm gate',
    keywords: ['summary gate', 'summary confirm', 'before sending to the office', 'service setters send', 'confirm tap', 'speedy sends booking'],
    answer:
      'Speedy must SUMMARIZE the details it collected and get the customer\'s confirmation BEFORE anything is sent to the Service Setters office — no send without the confirm tap. In fallback mode (AI provider down) no summary card can appear and no chat booking can be sent at all.',
  },
  {
    topic: 'Pricing — diagnostic, labor, installation',
    keywords: ['diagnostic fee', 'how much is the diagnostic', 'labor price', 'installation price', 'pricing', 'prices', 'what do we charge', 'fee terms'],
    answer:
      'Published pricing: the residential diagnostic is $99, collected at booking and credited toward an approved repair — it is still due if the customer declines the repair. Repair labor is $210 flat and installation is $150 flat; parts and materials are extra, at an approved written quote. No work is done without an approved written quote, and payment is due on completion unless agreed in writing. Commercial work is priced by custom quote — the $99 diagnostic never applies commercially.',
  },
  {
    topic: 'Business hours',
    keywords: ['hours', 'when are we open', 'open hours', 'google says 24 hours', 'business hours'],
    answer:
      'Office and service hours are Monday–Friday, 8am–7pm on every surface. The one deliberate exception: the Google Business Profile stays "Open 24 hours" — that split is intentional (owner, 2026-11-14). Do not "fix" either side to match the other.',
  },
  {
    topic: 'Cleanout Vents — partner routing, never a vent price',
    keywords: ['cleanout vents', 'dryer vent', 'vent cleaning', 'vent price', 'lint', 'dryer airflow'],
    answer:
      'Cleanout Vents is a registered vendor partner in the Top Speed network for dryer-vent work. Route dryer-vent questions to Cleanout Vents at 844-460-7038. There is NO vent price on Top Speed surfaces — never quote one — and vent cleaning is never offered as a bookable Top Speed appliance service.',
  },
  {
    topic: 'Referral program terms',
    keywords: ['referral', 'refer and earn', 'referral credit', 'referral tiers', 'milestone', 'welcome offer'],
    answer:
      'ApplianceReferral terms (live 2026-11-12): the referrer earns a $25 credit per completed referral; Tier 2 (5–9 referrals) pays $35; Tier 3 (10+) pays $50. Milestone bonuses: $100 at 10 referrals and $250 at 25. Credits expire after 12 months. Separately, the referred friend gets $25 off their first repair as a welcome offer — that is a different thing from the referrer\'s credit. Referral link shape: topspeedserviceos.com/refer?c=<CODE>; the public home is appliancereferral.com.',
  },
  {
    topic: 'Portal separation — who signs in where',
    keywords: ['portal separation', 'appliance pro commercial', 'connect pro who', 'business login', 'which portal', 'provider app', 'tech app who'],
    answer:
      'The portals stay strictly separated. Appliance Pro is COMMERCIAL only — a business account must pass a business login; a plain customer session never unlocks it. Appliance Connect Pro is for homeowners and property managers only. Providers and technicians work only in the Tech App (Speedy Pro). New Connect Pro accounts are created on the WEB PORTAL first; the app is sign-in-only for existing accounts. Staff (managers and Service Setters) are the exception: they can reach all platform access points.',
  },
  {
    topic: 'Coverage — cities and the booking matcher',
    keywords: ['coverage', 'service areas', 'how many cities', 'which cities', 'area review', 'new city booking', 'landing pages count'],
    answer:
      'Top Speed publishes 131 landing pages across 65 tri-county cities (Broward, Palm Beach, Miami-Dade) — say "65 cities", never "131 cities". The booking matcher auto-matches only the original 12 Broward cities: Lauderhill, Plantation, Sunrise, Tamarac, Fort Lauderdale, Lauderdale Lakes, North Lauderdale, Davie, Coral Springs, Pompano Beach, Oakland Park, Margate. A booking from any other covered city lands in the Service Setters AREA_REVIEW queue for a human decision.',
  },
  {
    topic: 'Lead flow — no auto-dispatch',
    keywords: ['lead flow', 'who assigns jobs', 'auto dispatch', 'setter queue', 'how leads work', 'pepper lists sale lead'],
    answer:
      'Every lead — apps and portals, residential and commercial — flows into the Service Setters queue; the setters assign the work and it reaches the technician in the Tech App. There is NO auto-dispatch: assignment suggestions advise, humans decide. One exception to know: a Pepper Lists SALE is not a lead — it records as a PEPPER_LISTS_SELL connection and must never enter the dispatch queue.',
  },
  {
    topic: 'Speedy Verify access codes',
    keywords: ['speedy verify', 'access code', 'verify code', 'unverified account', 'account waiting approval', '8-digit code'],
    answer:
      'Speedy Verify is the Master\'s access-code layer, on top of the password. Codes are 8 digits, issued only by Ramone (Master) — staff and business/PM accounts created new start UNVERIFIED: sign-in is denied and the account waits in his ApplianceMan panel until he issues a code. Codes are shown once, stored hashed, and revocable; 5 wrong codes lock the code step for 15 minutes. The Master can never be locked out. If someone is stuck unverified, it goes to Ramone — nobody else can issue or reset a code.',
  },
  {
    topic: 'Layer 2 — the 6-digit sign-in code',
    keywords: ['layer 2', 'two step', '2-step', 'six digit code', 'email code', 'sign-in code', 'second step'],
    answer:
      'Layer 2 is the per-sign-in second step: after the password (and Speedy Verify where required), the system sends a 6-digit code — by email (via Resend) or by text (via Twilio) — that completes the sign-in. New accounts have Layer 2 on from day one; older accounts were grandfathered unless enrolled. Ramone upgraded the Twilio account on 2026-11-18, so text codes send for real; if a text send ever fails, the failure is reported honestly and the email code is offered instead — a send is never faked. The Master is exempt by construction (Rule Zero).',
  },
  {
    topic: 'Sign-in trouble — first checks',
    keywords: ['cannot sign in', 'cant log in', 'login problem', 'networkerror', 'forgot password', 'reset password', 'locked out'],
    answer:
      'First checks for sign-in trouble: (1) A "NetworkError" means the request never reached the server — the password was never checked; retry on a stable connection. (2) Forgotten password: use the "Forgot password" link on the sign-in page — the reset link is single-use and good for 30 minutes (topspeedserviceos.com/reset-password). (3) If the account is new and unverified, it needs its Speedy Verify code from Ramone before sign-in can complete. (4) Layer 2 codes arrive by email — check spam, then ask for a resend. Anything beyond that goes to Ramone; Pepper cannot reset credentials or override an account.',
  },
  {
    topic: 'Multiple accounts — the session vault',
    keywords: ['multiple accounts', 'two accounts', 'switch account', 'session vault', 'add account', 'signed in everywhere'],
    answer:
      'Account holders can be signed into several accounts at once on one browser and travel between platforms still signed in: the session vault keeps each account\'s session separate (switching never merges powers), and /add-account adds another sign-in without losing the first. Sessions enter the vault only when a real sign-in completes.',
  },
  {
    topic: 'Who is who — Speedy, Pepper, Service Setters',
    keywords: ['who is speedy', 'who is pepper', 'speedy vs pepper', 'service setters who', 'assistant manager', 'systems manager'],
    answer:
      'Two different assistants, two different audiences. Speedy is the customer-facing AI — the "Assistant Manager" brain customers talk to for questions, photo diagnosis and booking help. Pepper (me) is the operations side: Pepper Agent — System Operations Manager, the staff-facing agent who watches the systems and reports to Ramone Williams. Service Setters are the human dispatch team who work the booking queues and assign technicians.',
  },
  {
    topic: 'Reporting a problem — escalation to the owner',
    keywords: ['report a problem', 'something is broken', 'escalate', 'tell ramone', 'file a report', 'issue'],
    answer:
      'Problems come to me first and go up, not sideways: tell me here in the Pepper chat bar (or file it in the Pepper console report log) and anything that is a problem or issue is forwarded to Ramone Williams — that is his standing directive of 2026-11-18. When you report a problem in this chat, I file a real NEEDS_OWNER report under your name and confirm it here with the report id.',
  },
];

/**
 * New-employee onboarding — the account path, in order. Staff
 * accounts are issued personally by the Master through Work Time
 * Access; there is deliberately NO public staff self-signup (the
 * public register refuses staff roles).
 */
export const PEPPER_ONBOARDING_STEPS = [
  'Your account is issued personally by Ramone Williams (the Master) through the Work Time Access console — there is no public sign-up for staff accounts, by rule.',
  'You get your sign-in from Ramone directly: your work email and the password he sets for you. Employee accounts also receive an employee number (TS-1001, TS-1002, …).',
  'First sign-in can have two extra steps, both normal: a Speedy Verify access code (8 digits, issued by Ramone — new staff accounts start unverified until he issues it) and the Layer 2 step, a 6-digit code sent to your email.',
  'Once you are in, start with the Training Academy intro modules — they walk the platform, the consoles and the work rules at your post.',
  'Questions about the platform or your work: ask me here in the Pepper chat bar. A problem or issue: tell me here too — it is forwarded to Ramone Williams under his standing directive.',
];

export const PEPPER_ONBOARDING_ANSWER =
  'Welcome to Top Speed. ' +
  PEPPER_ONBOARDING_STEPS.map((step, i) => `${i + 1}. ${step}`).join(' ');
