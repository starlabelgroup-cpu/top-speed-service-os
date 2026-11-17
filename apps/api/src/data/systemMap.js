// Top Speed Service OS — SYSTEM MAP (2026-11-17).
//
// The single source of truth for WHERE everything lives and HOW the
// back office works. Three consumers read this one file, so they can
// never drift apart:
//   1. The System Navigator (services/navigator.js) — the staff-only
//      AI guide that answers "where is X?" and "how do I do Y?" from
//      the entries built below.
//   2. The Navigator page directory (GET /navigator/map) — the same
//      areas and how-tos, rendered as a browsable staff directory.
//   3. The Training Academy course "System Navigator: Know Your
//      Platform" (modules 30–38) — buildNavigatorLessonRecords()
//      generates the course's Media OS seed records from these same
//      areas and how-tos (seeded create-only by slug through
//      data/mediaOsSeed.js, exactly like modules 1–29).
//
// Rules for editors: locations and steps must match the LIVE system —
// never invent a route, a button, or a step. Access strings name the
// role tiers from config/security.js. No customer data, no credentials,
// nothing that is not already visible to signed-in staff.

export const SYSTEM_MAP_GROUPS = [
  'Command & Consoles',
  'Bookings, Dispatch & Customers',
  'Accounts & Access',
  'Money',
  'Marketing, Media & Ads',
  'Training',
  'Pepper Lists',
  'Parts',
  'Network & Referrals',
  'Customer Surfaces',
  'External Dashboards',
];

export const SYSTEM_MAP_AREAS = [
  /* ------------------------- Command & Consoles ------------------------- */
  {
    id: 'applianceman',
    name: 'ApplianceMan',
    group: 'Command & Consoles',
    location: 'topspeedserviceos.com/applianceman',
    url: '/applianceman',
    purpose: 'The owner\'s command home: the live platform snapshot, links into every console, the Master controls, and the Speedy Verify panel.',
    access: 'Master (COMPANY_OWNER)',
    actions: ['Open every console from the sidebar', 'Issue, reset and revoke Speedy Verify codes (Speedy Verify panel)', 'Master controls and platform links'],
    related: ['turbo-boss', 'oversight', 'speedy-verify', 'navigator'],
    keywords: ['applianceman', 'owner console', 'command center', 'master controls', 'hub', 'main console'],
  },
  {
    id: 'turbo-boss',
    name: 'Turbo Boss',
    group: 'Command & Consoles',
    location: 'topspeedserviceos.com/turbo-boss',
    url: '/turbo-boss',
    purpose: 'The manager\'s command home: the decision queue, department scorecards, team load, the money snapshot, and account creation for managers.',
    access: 'Managers and Master (COMPANY_ADMIN, COMPANY_OWNER)',
    actions: ['Work the decision queue', 'Read department scorecards', 'Check team load and the money snapshot'],
    related: ['oversight', 'applianceman', 'work-time'],
    keywords: ['turbo boss', 'manager dashboard', 'manager command', 'decision queue', 'scorecards', 'team load'],
  },
  {
    id: 'oversight',
    name: 'Management Oversight',
    group: 'Command & Consoles',
    location: 'topspeedserviceos.com/oversight',
    url: '/oversight',
    purpose: 'Every department on one live screen: dispatch, commercial, providers, customers, finance, marketing, referrals, parts, system health, and the platform activity feed.',
    access: 'Managers and Master (COMPANY_ADMIN, COMPANY_OWNER)',
    actions: ['Watch every department live', 'Check system health', 'Follow the platform activity feed'],
    related: ['turbo-boss', 'applianceman'],
    keywords: ['oversight', 'management oversight', 'monitoring', 'all departments', 'system health', 'activity feed'],
  },
  {
    id: 'manager',
    name: 'Remote Manager',
    group: 'Command & Consoles',
    location: 'topspeedserviceos.com/manager',
    url: '/manager',
    purpose: 'The manager portal — the day-to-day management surface for managers away from the main consoles.',
    access: 'Managers and Master (COMPANY_ADMIN, COMPANY_OWNER)',
    actions: ['Run the day remotely', 'Check team and job state'],
    related: ['turbo-boss', 'oversight'],
    keywords: ['remote manager', 'manager portal', 'manager page'],
  },

  /* ------------------- Bookings, Dispatch & Customers ------------------- */
  {
    id: 'book-os',
    name: 'Book OS — Service Book Pro',
    group: 'Bookings, Dispatch & Customers',
    location: 'topspeedserviceos.com/book-os',
    url: '/book-os',
    purpose: 'The Service Setters\' home: the booking queue and dispatch board, the Email Manager, and the Pepper Lists review moderation queue. Every lead lands here first — setters review and assign; nothing auto-dispatches.',
    access: 'All staff (DISPATCHER, COMPANY_ADMIN, COMPANY_OWNER, PLATFORM_ADMIN)',
    actions: ['Work the setter booking queue', 'Review new-city bookings held as AREA_REVIEW', 'Read and reply to customer email (Email Manager panel)', 'Moderate Pepper Lists reviews'],
    related: ['email-manager', 'dispatch-dashboard', 'crm', 'review-moderation'],
    keywords: ['book os', 'service book', 'service book pro', 'setter queue', 'booking queue', 'bookings', 'leads queue', 'dispatch board'],
  },
  {
    id: 'email-manager',
    name: 'Email Manager',
    group: 'Bookings, Dispatch & Customers',
    location: 'Book OS → "Email Manager — Inbox" panel (topspeedserviceos.com/book-os)',
    url: '/book-os',
    purpose: 'Every email to the managed mailboxes in one console: the forwarded service@ inbox (service@topspeedappliance.net forwards a copy of everything here), service@topspeedserviceos.com, and booking@topspeedserviceos.com. Mail from a known customer files onto their CRM record automatically; anything else waits unmatched — nothing is dropped.',
    access: 'All staff',
    actions: ['Filter by mailbox (Forwarded service@ inbox / service@ / booking@)', 'Open a customer thread', 'Reply from the thread — a human always clicks send (Resend sends from the address the mail came to)'],
    related: ['book-os', 'crm'],
    keywords: ['email manager', 'inbox', 'email', 'mail', 'mailboxes', 'forwarded inbox', 'customer email', 'email thread', 'resend inbox'],
  },
  {
    id: 'dispatch-dashboard',
    name: 'Dispatch Dashboard',
    group: 'Bookings, Dispatch & Customers',
    location: 'topspeedserviceos.com/dispatch-dashboard',
    url: '/dispatch-dashboard',
    purpose: 'The live dispatch board: today\'s jobs, matching and assignment state — the working view for setters and dispatchers after the queue.',
    access: 'All staff',
    actions: ['Watch today\'s jobs live', 'Follow matching and assignment state', 'Work the exception queue and recovery queues', 'Check today\'s capacity ceiling', 'Set a job\'s P1–P4 priority from Job Detail'],
    related: ['book-os', 'service-setters', 'setter-exception-queue', 'setter-recovery-queues', 'dispatch-capacity'],
    keywords: ['dispatch dashboard', 'dispatch board', 'dispatch', 'assignments', 'todays jobs', 'live board'],
  },
  {
    id: 'setter-exception-queue',
    name: 'Exception Queue — Service Setters',
    group: 'Bookings, Dispatch & Customers',
    location: 'Dispatch Dashboard → "Exception queue" (topspeedserviceos.com/dispatch-dashboard)',
    url: '/dispatch-dashboard',
    purpose: 'Every open work order that needs office intervention, derived live from job state — never a hand-kept list: missed acceptance (an approved offer unaccepted after 60 minutes), late arrival (the appointment window passed with no arrival recorded), parts delay (awaiting parts over 48 hours), unresolved estimate (no customer authorization 24 hours after the estimate), and complaints (an escalated customer review with no office reply yet). Each row names the accountable owner, the next action, and when it is due.',
    access: 'All staff (DISPATCHER, COMPANY_ADMIN, COMPANY_OWNER, PLATFORM_ADMIN)',
    actions: ['Work exceptions most-overdue first', 'Open the job from any row', 'Reassign or follow up from the job record'],
    related: ['dispatch-dashboard', 'book-os', 'setter-recovery-queues', 'review-moderation'],
    keywords: ['exception queue', 'exceptions', 'missed acceptance', 'late arrival', 'parts delay', 'unresolved estimate', 'complaints queue', 'intervention queue'],
  },
  {
    id: 'setter-recovery-queues',
    name: 'Recovery Queues — Service Setters',
    group: 'Bookings, Dispatch & Customers',
    location: 'Dispatch Dashboard → "Recovery queues" (topspeedserviceos.com/dispatch-dashboard)',
    url: '/dispatch-dashboard',
    purpose: 'The revenue-recovery work lists, each fed from real job state: jobs awaiting parts, estimates still pending a customer decision, jobs flagged as needing a return visit, cancelled bookings (the win-back list), and completed jobs with an unpaid balance (estimate minus recorded receipts). There is deliberately no missed-call queue — the platform keeps no call log to build one from honestly.',
    access: 'All staff (DISPATCHER, COMPANY_ADMIN, COMPANY_OWNER, PLATFORM_ADMIN)',
    actions: ['Work the awaiting-parts and pending-estimate lists', 'Flag or clear a return visit from Job Detail', 'Win back cancelled bookings', 'Chase unpaid balances'],
    related: ['dispatch-dashboard', 'book-os', 'setter-exception-queue'],
    keywords: ['recovery queues', 'awaiting parts', 'pending estimates', 'return visits', 'cancellations', 'win-back', 'unpaid balances', 'revenue recovery'],
  },
  {
    id: 'dispatch-capacity',
    name: 'Dispatch Capacity — Service Setters',
    group: 'Bookings, Dispatch & Customers',
    location: 'Dispatch Dashboard → "Today\'s capacity" (topspeedserviceos.com/dispatch-dashboard)',
    url: '/dispatch-dashboard',
    purpose: 'The day\'s booking ceiling from the Operations Blueprint formula — active technicians × working hours × 60 × (1 − buffer) ÷ minutes per job including travel — with today\'s appointed jobs counted against it and the remaining room shown. The office tunes the inputs (defaults: 25% buffer, 120 minutes per job, 8 working hours). It is a planning estimate only: it informs the office and never blocks a booking.',
    access: 'All staff (DISPATCHER, COMPANY_ADMIN, COMPANY_OWNER, PLATFORM_ADMIN)',
    actions: ['Check today\'s ceiling and remaining room', 'Tune the buffer, minutes-per-job and working-hours inputs'],
    related: ['dispatch-dashboard', 'book-os'],
    keywords: ['capacity', 'booking ceiling', 'capacity planning', 'how many jobs today', 'remaining capacity', 'technician minutes'],
  },
  {
    id: 'service-setters',
    name: 'Service Setters',
    group: 'Bookings, Dispatch & Customers',
    location: 'topspeedserviceos.com/service-setters-dispatch',
    url: '/service-setters-dispatch',
    purpose: 'The Service Setters\' own dispatch surface for working the lead flow — the team every booking passes through before a tech is assigned.',
    access: 'All staff (the Service Setters team works here)',
    actions: ['Work incoming leads', 'Assign jobs onward to providers'],
    related: ['book-os', 'dispatch-dashboard'],
    keywords: ['service setters', 'setters', 'dispatch team', 'setter dispatch'],
  },
  {
    id: 'crm',
    name: 'Top Speed CRM',
    group: 'Bookings, Dispatch & Customers',
    location: 'topspeedserviceos.com/crm',
    url: '/crm',
    purpose: 'Customer 360: every customer\'s record, communications log, and Speedy briefs. Customer email from the Email Manager files onto these records.',
    access: 'All staff',
    actions: ['Open a customer record', 'Read the communications log', 'Read Speedy briefs on the customer'],
    related: ['book-os', 'email-manager'],
    keywords: ['crm', 'customer 360', 'customer record', 'customers', 'customer file', 'communications log'],
  },
  {
    id: 'chats',
    name: 'Chat Insights',
    group: 'Bookings, Dispatch & Customers',
    location: 'topspeedserviceos.com/chats',
    url: '/chats',
    purpose: 'Every Speedy conversation, captured for staff analysis — find unanswered questions and watch chat quality across surfaces.',
    access: 'All staff',
    actions: ['Review captured Speedy chats', 'Find questions Speedy could not answer'],
    related: ['speedy', 'book-os'],
    keywords: ['chat insights', 'speedy chats', 'chat history', 'conversations', 'unanswered questions'],
  },

  /* --------------------------- Accounts & Access --------------------------- */
  {
    id: 'work-time',
    name: 'Work Time Account Access',
    group: 'Accounts & Access',
    location: 'topspeedserviceos.com/work-time-access (entry links in ApplianceMan + Turbo Boss, owner session only)',
    url: '/work-time-access',
    purpose: 'Where the Master issues accounts for every platform and app: create the account for any of the 9 surfaces, choose its password, and see the exact 2-step defaults before issuing. Employee accounts (setters, managers, providers/techs) get a permanent employee number (TS-1001, TS-1002, …) minted automatically; new staff, business, PM and advertiser accounts start unverified and wait for a Speedy Verify code, and Layer 2 is on for every new account. Flywheel AI Advertising lives here too: advertiser accounts and the agency\'s Flywheel Marketing Manager accounts are issued with the same abilities and 2-step defaults as every other surface. The page also carries the Master\'s Access Directory: 21 internal doors + 11 external dashboards.',
    access: 'Master only (COMPANY_OWNER)',
    actions: ['Create an account for any surface (Service Setter, Manager, Provider, Business, Property Manager, Commercial/Appliance Pro, Customer, Advertiser — Flywheel AI Advertising, Flywheel Marketing Manager)', 'Choose and reset account passwords (resetting the Master\'s own also requires the current password)', 'See each account\'s employee number and 2-step status', 'Issue and revoke Speedy Verify codes', 'Toggle Layer 2 per account'],
    related: ['speedy-verify', 'layer2', 'applianceman'],
    keywords: ['work time', 'work time account access', 'account access', 'create account', 'new account', 'issue account', 'employee number', 'employee numbering', 'choose password', 'set password', 'accounts console'],
  },
  {
    id: 'speedy-verify',
    name: 'Speedy Verify — Access Codes',
    group: 'Accounts & Access',
    location: 'ApplianceMan → Speedy Verify panel (topspeedserviceos.com/applianceman#sec-verify)',
    url: '/applianceman#sec-verify',
    purpose: 'The Master\'s access-code system: an 8-digit code per account, entered after the password at sign-in. Codes are stored hashed and shown once, when issued. Revoking a code denies sign-in immediately; 5 wrong tries lock code entry for 15 minutes.',
    access: 'Master only (COMPANY_OWNER)',
    actions: ['Issue a code for an account', 'Reset a code (the old code dies)', 'Revoke a code', 'See which accounts are waiting unverified'],
    related: ['work-time', 'layer2', 'applianceman'],
    keywords: ['speedy verify', 'access code', 'verify code', 'verification code', 'issue code', 'reset code', 'revoke code', '8-digit code', 'unverified accounts'],
  },
  {
    id: 'layer2',
    name: 'Layer 2 — 2-Step Sign-In',
    group: 'Accounts & Access',
    location: 'Automatic step on every sign-in screen',
    url: '/login',
    purpose: 'The second sign-in step: after the password (and Speedy Verify, where the account requires it), a 6-digit code is emailed and entered to finish signing in. Email is the working channel; text codes wait on the Twilio upgrade and fall back to email honestly. The Master is never locked out.',
    access: 'Everyone who signs in; policy managed by the Master',
    actions: ['Enter the 6-digit email code at sign-in', 'New accounts are covered from day one; existing accounts enroll rather than being locked out'],
    related: ['speedy-verify', 'work-time'],
    keywords: ['layer 2', '2-step', 'two step', 'two-step sign-in', 'sign-in code', 'login code', 'email code', '6-digit code'],
  },
  {
    id: 'navigator',
    name: 'System Navigator',
    group: 'Accounts & Access',
    location: 'topspeedserviceos.com/navigator',
    url: '/navigator',
    purpose: 'This guide: the staff-only AI navigator and directory for the whole platform. Ask where anything lives or how anything is done; it answers from the system map and deep-links you there. It explains and links — it never performs actions.',
    access: 'All staff',
    actions: ['Ask "where is …?" and get the exact console plus a link', 'Ask "how do I …?" and get the live steps', 'Browse the full system directory'],
    related: ['academy', 'applianceman'],
    keywords: ['navigator', 'system navigator', 'guide', 'help', 'where is everything', 'system map', 'directory'],
  },

  /* --------------------------------- Money --------------------------------- */
  {
    id: 'finance',
    name: 'Finance OS',
    group: 'Money',
    location: 'topspeedserviceos.com/finance',
    url: '/finance',
    purpose: 'The platform\'s money layer — finances on the Service OS with QuickBooks as the book of record.',
    access: 'Managers and Master (COMPANY_ADMIN, COMPANY_OWNER)',
    actions: ['Review platform finances', 'Check the money snapshot inputs'],
    related: ['payments', 'turbo-boss'],
    keywords: ['finance', 'finance os', 'money', 'quickbooks', 'bookkeeping'],
  },
  {
    id: 'payments',
    name: 'Payments — Stripe Status',
    group: 'Money',
    location: 'Live status: top-speed-service-os.vercel.app/api/v1/payments/status · Money console: Finance OS (/finance)',
    url: 'https://top-speed-service-os.vercel.app/api/v1/payments/status',
    purpose: 'Whether card payments are live: the status check returns configured, webhookConfigured, and the $99 diagnostic amount (diagnosticAmountCents 9900). Payouts and the bank account on file live in the Stripe dashboard, not on the platform.',
    access: 'Staff can read the status; the Stripe dashboard is the Master\'s',
    actions: ['Check payments are configured', 'Confirm the webhook is configured', 'Payouts: Stripe dashboard → Settings → Payouts'],
    related: ['finance'],
    keywords: ['payments', 'stripe', 'payment status', 'payments configured', 'diagnostic payment', 'webhook', 'payouts'],
  },

  /* ------------------------- Marketing, Media & Ads ------------------------- */
  {
    id: 'marketing-os',
    name: 'Marketing OS',
    group: 'Marketing, Media & Ads',
    location: 'topspeedserviceos.com/marketing-os',
    url: '/marketing-os',
    purpose: 'The in-house marketing agency hub, built on one taxonomy: 15 cities, 14 brands, 11 services, 7 symptoms. Pages, the Studio, and SEO all run from here.',
    access: 'Staff (marketing roles, managers, Master)',
    actions: ['Open the agency hub', 'Reach Page Studio and the SEO dashboard'],
    related: ['page-studio', 'seo-dashboard', 'google-accounts'],
    keywords: ['marketing os', 'marketing hub', 'agency', 'marketing agency', 'taxonomy', 'flywheel ai advertising'],
  },
  {
    id: 'page-studio',
    name: 'Page Studio',
    group: 'Marketing, Media & Ads',
    location: 'topspeedserviceos.com/marketing-os/studio',
    url: '/marketing-os/studio',
    purpose: 'Where Marketing OS landing pages are built and published: pick the city, brand, service and symptom from the taxonomy, draft, review, publish, then verify the page live.',
    access: 'Staff',
    actions: ['Draft a landing page from the taxonomy', 'Review and publish', 'Verify the published page'],
    related: ['marketing-os', 'seo-dashboard'],
    keywords: ['page studio', 'studio', 'publish a page', 'publish page', 'landing pages', 'drafts', 'create page'],
  },
  {
    id: 'seo-dashboard',
    name: 'SEO Dashboard',
    group: 'Marketing, Media & Ads',
    location: 'topspeedserviceos.com/marketing-os/seo',
    url: '/marketing-os/seo',
    purpose: 'Real search performance data for the platform\'s pages — the SEO view of the Marketing OS.',
    access: 'Staff',
    actions: ['Read search performance', 'Spot pages gaining or losing ground'],
    related: ['marketing-os', 'page-studio'],
    keywords: ['seo', 'seo dashboard', 'search performance', 'google search', 'rankings'],
  },
  {
    id: 'google-accounts',
    name: 'Google Accounts Registry',
    group: 'Marketing, Media & Ads',
    location: 'topspeedserviceos.com/marketing-os/google-accounts',
    url: '/marketing-os/google-accounts',
    purpose: 'The registry of the platform\'s Google accounts — which account runs what (Ads, Business Profiles, services).',
    access: 'Managers and Master',
    actions: ['Look up a Google account', 'See what each account runs'],
    related: ['marketing-os', 'ext-google'],
    keywords: ['google accounts', 'accounts registry', 'google registry', 'which google account'],
  },
  {
    id: 'ad-studio',
    name: 'Ad Studio',
    group: 'Marketing, Media & Ads',
    location: 'topspeedserviceos.com/ad-studio',
    url: '/ad-studio',
    purpose: 'The in-house ad system: campaigns are built here and move DRAFT → PENDING_APPROVAL → ACTIVE. Approving is owner-only — approving the house campaign ("Refrigerator Repair — Speedy Booking Launch") activates the Flywheel banner on the customer surfaces.',
    access: 'Staff build and submit; approval is Master (owner) only',
    actions: ['Build a campaign', 'Submit for approval', 'Approve a pending campaign (Master only)', 'Pause or end a campaign'],
    related: ['flywheel', 'advertiser-console'],
    keywords: ['ad studio', 'ads', 'approve ads', 'approve ad', 'house campaign', 'house ad', 'campaign approval', 'pending approval', 'flywheel ads', 'flywheel ai advertising'],
  },
  {
    id: 'flywheel',
    name: 'Flywheel AI Advertising',
    group: 'Marketing, Media & Ads',
    location: 'topspeedserviceos.com/flywheel',
    url: '/flywheel',
    purpose: 'The Flywheel AI Advertising system: the mini banner that renders approved ads across the platform\'s surfaces. Nothing renders until a campaign is approved in Ad Studio. The manager consoles (Turbo Boss, ApplianceMan, Oversight) carry the Flywheel doors — Marketing OS, Ad Studio and the Advertiser Console — and Flywheel accounts (advertisers and the agency\'s marketing managers) are issued in Work Time Account Access with the same abilities as every other account.',
    access: 'Staff',
    actions: ['Check what the banner is running', 'Follow campaign state from Ad Studio'],
    related: ['ad-studio', 'advertiser-console'],
    keywords: ['flywheel', 'flywheel ai advertising', 'ai advertising', 'banner', 'banner ads', 'advertising system', 'mini banner'],
  },
  {
    id: 'media-os',
    name: 'Media OS',
    group: 'Marketing, Media & Ads',
    location: 'topspeedserviceos.com/media',
    url: '/media',
    purpose: 'The media library behind publishing and the Academy: content records with statuses (Draft → In review → Approved → Published). The Academy curriculum is the library records tagged "training-academy". Library admin stays admin-gated.',
    access: 'Admin: MARKETING_MANAGER, COMPANY_ADMIN, COMPANY_OWNER, PLATFORM_ADMIN (the Academy read is open to trainees)',
    actions: ['Manage content records and statuses', 'Attach assets', 'Publish library content'],
    related: ['academy', 'page-studio'],
    keywords: ['media os', 'media library', 'content library', 'videos', 'library admin'],
  },
  {
    id: 'publish-center',
    name: 'Publish Center',
    group: 'Marketing, Media & Ads',
    location: 'topspeedserviceos.com/publish-center',
    url: '/publish-center',
    purpose: 'The platform\'s publishing center — where published output is coordinated and the publish feed is reviewed.',
    access: 'Staff',
    actions: ['Review the publish feed', 'Coordinate publishing'],
    related: ['media-os', 'marketing-os'],
    keywords: ['publish center', 'publishing', 'publish feed'],
  },
  {
    id: 'advertiser-console',
    name: 'Advertiser Console',
    group: 'Marketing, Media & Ads',
    location: 'topspeedserviceos.com/advertiser',
    url: '/advertiser',
    purpose: 'The advertiser-facing console where businesses run advertising on the platform — the business side of the Pepper Lists Advertise lane and Flywheel AI Advertising.',
    access: 'Advertiser accounts; staff oversee',
    actions: ['Businesses manage their ads', 'Staff oversee advertiser activity', 'Flywheel advertiser accounts are issued in Work Time Account Access'],
    related: ['ad-studio', 'pepper-lists', 'flywheel'],
    keywords: ['advertiser console', 'advertise', 'advertiser', 'business ads', 'advertise lane', 'flywheel ai advertising'],
  },

  /* -------------------------------- Training -------------------------------- */
  {
    id: 'academy',
    name: 'Training Academy',
    group: 'Training',
    location: 'topspeedserviceos.com/academy',
    url: '/academy',
    purpose: 'The staff university: 29 training modules in 8 role tracks, the System Navigator course (modules 30–38, generated from this same system map), Speedy Class, and an AI Specialist coach for every department. Every staff role and provider trainees enter as learners; Media OS admin stays separate.',
    access: 'All staff + provider trainees (PROVIDER_TECH, PROVIDER_OWNER, TECHNICIAN, MARKETING_MANAGER)',
    actions: ['Study your role track', 'Take the System Navigator course (modules 30–38)', 'Ask Speedy Class or a department Specialist'],
    related: ['navigator', 'media-os'],
    keywords: ['academy', 'training academy', 'training', 'modules', 'courses', 'lessons', 'speedy class', 'specialists', 'coaches', 'system navigator course'],
  },

  /* ------------------------------- Pepper Lists ------------------------------ */
  {
    id: 'pepper-lists',
    name: 'Pepper Lists',
    group: 'Pepper Lists',
    location: 'pepperlists.com (also topspeedserviceos.com/pepper-lists-site)',
    url: 'https://www.pepperlists.com',
    purpose: 'Pepper Lists It by Top Speed OS — exactly two categories. Category 1, Pepper Lists Sell: individuals list from a photo through Speedy chat; businesses use the Advertise lane. Category 2, Pepper Lists Post: the Reviews wall — reviews, repair photos and videos, surveys and comment threads. Booking is not a Pepper Lists category.',
    access: 'Public + signed-in customers; staff moderate via Book OS',
    actions: ['List an item from a photo (Sell)', 'Read and post reviews (Post)', 'Businesses: open the Advertise lane'],
    related: ['review-moderation', 'advertiser-console'],
    keywords: ['pepper lists', 'pepperlists', 'pepper lists it', 'sell category', 'post category', 'listings', 'reviews wall'],
  },
  {
    id: 'review-moderation',
    name: 'Review Moderation Queue',
    group: 'Pepper Lists',
    location: 'Book OS → Pepper Lists reviews panel (topspeedserviceos.com/book-os)',
    url: '/book-os',
    purpose: 'Where the office handles Pepper Lists reviews: positive reviews publish immediately, but flagged or low-rating reviews wait PENDING (and escalated ones flagged) in this queue. Staff publish, hide, or send the office reply ("Top Speed Appliance — Office"). Ratings only ever come from real reviews of real completed jobs.',
    access: 'All staff',
    actions: ['Work the PENDING / escalated queue', 'Publish or hide a review', 'Send the office reply'],
    related: ['pepper-lists', 'book-os'],
    keywords: ['review moderation', 'moderate a review', 'moderate review', 'pending reviews', 'reviews queue', 'hide review', 'publish review', 'office reply', 'escalated review'],
  },

  /* ---------------------------------- Parts ---------------------------------- */
  {
    id: 'parts',
    name: 'Parts Supply OS',
    group: 'Parts',
    location: 'topspeedserviceos.com/parts',
    url: '/parts',
    purpose: 'The platform\'s parts home: supplier partners and the featured vendor storefront — Appliance Plus Parts Supply, with deep links into its store, PLUS AI, and Pro shopping.',
    access: 'Staff; customers browse the storefront',
    actions: ['Open the featured partner storefront', 'Jump to the partner store, PLUS AI, or Pro shopping', 'Check supplier partners'],
    related: ['appliance-plus'],
    keywords: ['parts', 'parts supply', 'parts supply os', 'order a part', 'order parts', 'suppliers', 'supplier partners'],
  },
  {
    id: 'appliance-plus',
    name: 'Appliance Plus Parts Supply (Vendor Partner)',
    group: 'Parts',
    location: 'applianceplus.vercel.app — Store ?tab=store · PLUS AI ?tab=plus-ai · Pro ?tab=pro · Service OS Connect ?tab=connect',
    url: 'https://applianceplus.vercel.app',
    purpose: 'The vendor partner\'s own platform, powered by PLUS AI: fast parts shopping with fitment help. Fitment counts as "verified" only from stored compatibility records — an AI suggestion alone is never verified. Checkout currently records demo orders; live payments wait on the partner\'s own Stripe. This is Appliance Plus Parts Supply the distributor — not Appliance Plus Air, LLC, which is a separate company.',
    access: 'Partner platform, linked from Parts Supply OS',
    actions: ['Shop the Store (?tab=store)', 'Ask PLUS AI about fitment (?tab=plus-ai)', 'Pro shopping for trade accounts (?tab=pro)', 'Service OS Connect links back to /parts, /book, /track (?tab=connect)'],
    related: ['parts'],
    keywords: ['appliance plus', 'appliance plus parts supply', 'plus ai', 'parts store', 'vendor partner', 'fitment', 'order parts fast'],
  },

  /* --------------------------- Network & Referrals --------------------------- */
  {
    id: 'referral',
    name: 'Appliance Referral',
    group: 'Network & Referrals',
    location: 'topspeedserviceos.com/refer (also appliancereferral.com)',
    url: '/refer',
    purpose: 'The referral program home: customers share their personal TS-REF link and earn a $25 credit per completed referral — $35 at 5–9, $50 at 10+, milestones $100 at 10 and $250 at 25, 12-month expiry. The referred friend gets $25 off their first repair.',
    access: 'Public + customers; staff watch referral activity in Oversight',
    actions: ['Customers share their referral link', 'Staff check referral activity in Oversight'],
    related: ['oversight', 'flagship'],
    keywords: ['referral', 'appliance referral', 'refer', 'referral credit', 'ts-ref', 'refer a friend', 'appliancereferral'],
  },
  {
    id: 'network-site',
    name: 'Provider Network Site',
    group: 'Network & Referrals',
    location: 'topspeedapplianceservice.com',
    url: 'https://topspeedapplianceservice.com',
    purpose: 'The provider network\'s public home: network businesses, independent providers, and joining the network.',
    access: 'Public; providers and network businesses',
    actions: ['Network recruiting and information', 'Route providers to Speedy Pro'],
    related: ['speedy-pro', 'provider-join'],
    keywords: ['provider network', 'network site', 'topspeedapplianceservice', 'service network', 'network businesses'],
  },
  {
    id: 'speedy-pro',
    name: 'Speedy Pro — Tech App',
    group: 'Network & Referrals',
    location: 'topspeedserviceos.com/speedy-pro',
    url: '/speedy-pro',
    purpose: 'The provider/tech app: job offers, accepting work, field status, and completion. Providers work only in Speedy Pro — never in the customer or commercial doors.',
    access: 'Providers (PROVIDER_TECH, PROVIDER_OWNER); staff oversee',
    actions: ['Receive and accept job offers', 'Update job status in the field', 'Complete jobs'],
    related: ['network-site', 'dispatch-dashboard'],
    keywords: ['speedy pro', 'tech app', 'provider app', 'technician app', 'field app', 'job offers'],
  },
  {
    id: 'provider-join',
    name: 'Provider Join',
    group: 'Network & Referrals',
    location: 'topspeedserviceos.com/provider-join',
    url: '/provider-join',
    purpose: 'Where new providers and network businesses join the Top Speed network.',
    access: 'Public (join); the team reviews',
    actions: ['Start a provider application', 'Route applicants into the network'],
    related: ['network-site', 'speedy-pro'],
    keywords: ['provider join', 'join the network', 'join network', 'provider signup', 'become a provider'],
  },

  /* ---------------------------- Customer Surfaces ---------------------------- */
  {
    id: 'flagship',
    name: 'Service OS Flagship',
    group: 'Customer Surfaces',
    location: 'topspeedserviceos.com',
    url: 'https://topspeedserviceos.com',
    purpose: 'The flagship platform home — every console, app, and customer surface hangs off this one domain and the shared Service OS backend.',
    access: 'Public',
    actions: ['Start anywhere: booking, tracking, Speedy, the apps'],
    related: ['book', 'customer-app', 'speedy'],
    keywords: ['flagship', 'main site', 'home page', 'topspeedserviceos', 'platform home'],
  },
  {
    id: 'book',
    name: 'Book a Repair — Web Form',
    group: 'Customer Surfaces',
    location: 'topspeedserviceos.com/book',
    url: '/book',
    purpose: 'The classic booking form — the PRIMARY booking path on every surface, because traditional customers prefer it. It is never removed, hidden, or gated behind chat; Speedy AI booking sits below it as the high-tech option. The $99 residential diagnostic is collected at booking and credited toward an approved repair.',
    access: 'Public',
    actions: ['Book a repair with the form', 'Bookings land in the Book OS setter queue'],
    related: ['book-os', 'speedy'],
    keywords: ['book', 'booking form', 'web form', 'book a repair', 'classic booking', 'booking page'],
  },
  {
    id: 'customer-app',
    name: 'Appliance Connect — Customer App',
    group: 'Customer Surfaces',
    location: 'topspeedserviceos.com/app',
    url: '/app',
    purpose: 'The customer app: book, track your tech, talk to Speedy, and manage jobs from one place.',
    access: 'Customers',
    actions: ['Book and track jobs', 'Talk to Speedy', 'Manage account and jobs'],
    related: ['book', 'connect-pro'],
    keywords: ['appliance connect', 'customer app', 'the app', 'connect app'],
  },
  {
    id: 'connect-pro',
    name: 'Appliance Connect Pro',
    group: 'Customer Surfaces',
    location: 'applianceconnectpro.com (portal on topspeedserviceos.com/connect-pro)',
    url: 'https://www.applianceconnectpro.com',
    purpose: 'Homeowners and property managers ONLY, behind a business login — a plain customer session never unlocks it. New accounts are created on the web portal first; the app is sign-in-only for existing accounts.',
    access: 'Homeowners + property managers (business login)',
    actions: ['Portal sign-up (first step for new accounts)', 'Property managers run multi-unit work'],
    related: ['customer-app', 'appliance-pro'],
    keywords: ['connect pro', 'appliance connect pro', 'property managers', 'homeowners', 'business login', 'pm portal'],
  },
  {
    id: 'appliance-pro',
    name: 'Appliance Pro — Commercial Portal',
    group: 'Customer Surfaces',
    location: 'appliancepro.net',
    url: 'https://appliancepro.net',
    purpose: 'COMMERCIAL only: the business portal for companies and facilities — service requests, agreements, and multi-unit work. Commercial work is priced by custom quote; the $99 diagnostic is residential-only and never appears here.',
    access: 'Commercial accounts (business login)',
    actions: ['Submit commercial service requests', 'Manage agreements and units'],
    related: ['connect-pro', 'work-time'],
    keywords: ['appliance pro', 'appliancepro', 'appliancepro.net', 'commercial portal', 'commercial accounts', 'business portal'],
  },
  {
    id: 'net-site',
    name: 'TopSpeedAppliance.net — Customer Website',
    group: 'Customer Surfaces',
    location: 'www.topspeedappliance.net',
    url: 'https://www.topspeedappliance.net',
    purpose: 'The customer website: services, service areas, and the 131 published landing pages across 65 tri-county cities, with booking and portal login. Its bookings flow into the same Service OS setter queue.',
    access: 'Public',
    actions: ['Customer information and booking', '131 landing pages across 65 cities'],
    related: ['flagship', 'book'],
    keywords: ['topspeedappliance.net', '.net', 'dot net', 'customer website', 'landing pages', 'service pages'],
  },
  {
    id: 'cleanout-vents',
    name: 'Cleanout Vents — Partner',
    group: 'Customer Surfaces',
    location: 'topspeedserviceos.com/cleanout-vents-site · cleanoutvents.com',
    url: '/cleanout-vents-site',
    purpose: 'The registered dryer-vent partner. Top Speed never books vent cleaning and never quotes a vent price: route customers to Cleanout Vents at 954-931-7997. Their standalone site\'s Book Online doors land on the Service OS partner page for instant booking through Speedy chat.',
    access: 'Public; partner',
    actions: ['Route vent-cleaning customers to 954-931-7997', 'Partner page books through Speedy chat'],
    related: ['speedy', 'book'],
    keywords: ['cleanout vents', 'cleanoutvents', 'dryer vent', 'vent cleaning', 'vent partner', 'dryer vent cleaning'],
  },
  {
    id: 'explore',
    name: 'The Four Engines — Explore',
    group: 'Customer Surfaces',
    location: 'topspeedserviceos.com/explore',
    url: '/explore',
    purpose: 'Search, Estimate, Recommend and Compare: one search over the services, honest price PREVIEWS (a preview is never a quote — amount stays null until a human quotes), recommendations that route a clogged dryer vent to Cleanout Vents first, and the company comparison table.',
    access: 'Public',
    actions: ['Search services', 'Preview a price', 'Get a recommendation', 'Compare companies'],
    related: ['book', 'cleanout-vents'],
    keywords: ['explore', 'engines', 'four engines', 'search engine', 'estimate engine', 'recommend', 'compare', 'price preview'],
  },
  {
    id: 'speedy',
    name: 'Speedy — Customer AI',
    group: 'Customer Surfaces',
    location: 'topspeedserviceos.com/speedy (and the Speedy widget on every surface)',
    url: '/speedy',
    purpose: 'The customer-facing AI — the platform\'s Assistant Manager: answers questions, reads photos for a preliminary diagnosis, and books through chat ONLY after summarizing the details and getting the customer\'s confirmation (the summary gate — nothing goes to the Service Setters without it). Status and answer mode: /api/v1/speedy/status.',
    access: 'Public',
    actions: ['Answer customer questions', 'Photo diagnosis', 'Chat booking behind the summary gate'],
    related: ['chats', 'book', 'navigator'],
    keywords: ['speedy', 'customer ai', 'speedy ai', 'chat assistant', 'photo diagnosis', 'assistant manager', 'speedy status'],
  },

  /* --------------------------- External Dashboards --------------------------- */
  {
    id: 'ext-vercel',
    name: 'Vercel Dashboard',
    group: 'External Dashboards',
    location: 'vercel.com — team "Top Speed Appliance\'s projects"',
    url: 'https://vercel.com',
    purpose: 'Deploys, domains and project settings for every site (flagship "web", the API project, .net, appliancepro, cleanoutvents, applianceplus). Outside the platform — you sign in there with the team account.',
    access: 'Master (team account)',
    actions: ['Inspect deployments', 'Manage domains', 'Promote .net previews to Production'],
    related: ['ext-github'],
    keywords: ['vercel', 'vercel dashboard', 'deploys', 'hosting', 'deployments'],
  },
  {
    id: 'ext-github',
    name: 'GitHub',
    group: 'External Dashboards',
    location: 'github.com/starlabelgroup-cpu',
    url: 'https://github.com/starlabelgroup-cpu',
    purpose: 'The code repositories for every platform — flagship Service OS, .net, appliancepro, Cleanout Vents, Appliance Plus. Outside the platform; the connector pushes are text-only, so binary files go up through the web upload.',
    access: 'Master (starlabelgroup-cpu)',
    actions: ['Browse repositories', 'Review pushes and history'],
    related: ['ext-vercel'],
    keywords: ['github', 'code', 'repositories', 'repos', 'source code'],
  },
  {
    id: 'ext-stripe',
    name: 'Stripe Dashboard',
    group: 'External Dashboards',
    location: 'dashboard.stripe.com',
    url: 'https://dashboard.stripe.com',
    purpose: 'The live Stripe account (Top Speed Appliance LLC): payments, and Settings → Payouts where the bank account is added — payouts stay disabled until that step is done. Outside the platform.',
    access: 'Master',
    actions: ['Review payments', 'Add the payout bank account (Settings → Payouts)'],
    related: ['payments'],
    keywords: ['stripe dashboard', 'stripe account', 'payout settings', 'bank account'],
  },
  {
    id: 'ext-porkbun',
    name: 'Porkbun',
    group: 'External Dashboards',
    location: 'porkbun.com — account "topspeeddomains"',
    url: 'https://porkbun.com',
    purpose: 'Registrar for topspeedserviceos.com and the newer domains; its DNS also carries the Resend email records. Outside the platform.',
    access: 'Master',
    actions: ['Manage domains', 'Edit DNS'],
    related: ['ext-nsol', 'ext-resend'],
    keywords: ['porkbun', 'domains', 'registrar', 'dns', 'domain names'],
  },
  {
    id: 'ext-nsol',
    name: 'Network Solutions',
    group: 'External Dashboards',
    location: 'networksolutions.com',
    url: 'https://www.networksolutions.com',
    purpose: 'Registrar for appliancereferral.com (the starlabelgroup account) and appliancepro.net (the service@ account). Outside the platform.',
    access: 'Master',
    actions: ['Manage those two domains', 'Renewals and DNS'],
    related: ['ext-porkbun', 'referral', 'appliance-pro'],
    keywords: ['network solutions', 'nsol', 'registrar', 'appliancereferral domain', 'appliancepro domain'],
  },
  {
    id: 'ext-resend',
    name: 'Resend',
    group: 'External Dashboards',
    location: 'resend.com',
    url: 'https://resend.com',
    purpose: 'The email service behind the Email Manager: verified sending domains, the inbound webhook that files mail into Book OS, and delivery logs. Outside the platform.',
    access: 'Master',
    actions: ['Check email delivery', 'Manage domains and webhooks'],
    related: ['email-manager'],
    keywords: ['resend', 'email service', 'email delivery', 'webhooks', 'sending domains'],
  },
  {
    id: 'ext-meta',
    name: 'Meta Business Suite',
    group: 'External Dashboards',
    location: 'business.facebook.com',
    url: 'https://business.facebook.com',
    purpose: 'Facebook Pages (Repair & Installation, Sales & Delivery, Cleanout Vents, CocoCane), Instagram, Meta ads and the Marketplace presence. Outside the platform.',
    access: 'Master',
    actions: ['Manage Pages and ads', 'Marketplace and catalog'],
    related: ['ad-studio', 'pepper-lists'],
    keywords: ['meta', 'meta business', 'facebook business', 'business suite', 'facebook pages', 'instagram'],
  },
  {
    id: 'ext-google',
    name: 'Google — Ads, Business, Workspace',
    group: 'External Dashboards',
    location: 'ads.google.com · business.google.com · admin.google.com',
    url: 'https://ads.google.com',
    purpose: 'The platform\'s Google presence: Ads campaigns (all per-domain campaigns stay paused until the owner funds them), Business Profiles, and Workspace admin for the service@ mailbox. Outside the platform.',
    access: 'Master',
    actions: ['Google Ads', 'Business Profiles', 'Workspace admin'],
    related: ['google-accounts', 'seo-dashboard'],
    keywords: ['google', 'google ads', 'google business', 'business profile', 'workspace', 'workspace admin', 'gmail admin'],
  },
];

/* ------------------------------- HOW-TO procedures -------------------------------
 * Steps match the audited live system. If a console changes, change the
 * steps here — the Navigator and Academy lesson 30–38 update together. */
export const SYSTEM_HOWTOS = [
  {
    id: 'issue-account',
    title: 'Issue a new account in Work Time Account Access',
    areaId: 'work-time',
    keywords: ['issue account', 'create account', 'new employee account', 'new staff account', 'add an employee', 'add employee', 'onboard', 'employee number', 'give someone access', 'new login'],
    steps: [
      'Sign in as the Master and open Work Time Account Access (/work-time-access) — the entry links are in ApplianceMan and Turbo Boss, visible to the owner session only.',
      'Choose "Create account" and pick the surface the person belongs to: Service Setter, Manager, Provider, Business, Property Manager, Commercial (Appliance Pro), Customer, Advertiser (Flywheel AI Advertising), or Flywheel Marketing Manager.',
      'Enter their name and email, and choose the password yourself (10+ characters) — it is stored scrypt-hashed and never shown or logged. The form shows the exact 2-step defaults that will apply before you issue.',
      'Employee accounts (Service Setters, Managers, Providers/Techs) are minted a permanent employee number (TS-1001, TS-1002, …) automatically — it is never reused. Customers, business, PM, advertiser and Flywheel marketing manager accounts do not get employee numbers.',
      'New staff, business, PM and advertiser accounts start UNVERIFIED, office-issued Flywheel Marketing Manager accounts start flagged unverified like providers (their code is issuable from the same console ahead of enforcement), and Layer 2 is on for every new account: issue their Speedy Verify code from the same console and hand it to them once — codes are shown once.',
      'Tell them the sign-in order: password → Speedy Verify code (theirs is required) → Layer 2 email code → in.',
    ],
    note: 'Only the Master can issue accounts here, and no second Master (COMPANY_OWNER) account can be created — the Master tier is single-holder by Rule Zero.',
  },
  {
    id: 'verify-code',
    title: 'Issue or reset a Speedy Verify code',
    areaId: 'speedy-verify',
    keywords: ['issue verify code', 'issue a code', 'reset verify code', 'speedy verify code', 'access code', 'new code', 'employee locked out', 'code not working', 'unverified account'],
    steps: [
      'Sign in as the Master and open ApplianceMan (/applianceman), then the Speedy Verify panel (sidebar → Speedy Verify).',
      'Find the account — new staff and business accounts waiting for a code are listed there as unverified.',
      'Choose Issue code. The 8-digit code is shown ONCE — give it to the account holder right away; it is stored hashed and cannot be viewed again.',
      'To fix a lost or shared code, choose Reset in the same panel: the old code dies and a new one is shown once.',
      'To cut access immediately, choose Revoke — sign-in is denied from that moment.',
      'The holder enters the code at sign-in after their password (before the Layer 2 email code). Five wrong tries lock code entry for 15 minutes.',
    ],
    note: 'Master only. The Master account itself can never be locked out or revoked.',
  },
  {
    id: 'booking-flow',
    title: 'How a booking flows, end to end',
    areaId: 'book-os',
    keywords: ['booking flow', 'how bookings work', 'booking end to end', 'setter queue', 'lead flow', 'dispatch a job', 'assign a job', 'new booking', 'where do bookings go'],
    steps: [
      'The customer books: the classic web form leads on every surface (/book, .net, the portals); Speedy chat is the second path and only sends after summarizing the details and getting the customer\'s tap to confirm.',
      'The booking lands in the Service Setters queue in Book OS (/book-os) as PENDING_DISPATCH. Bookings from the newer cities land as AREA_REVIEW for a setter to confirm — the matcher still auto-matches the original 12 cities.',
      'A Service Setter reviews the request in Book OS — details, area, window — and assigns it. There is no auto-dispatch: every lead goes through a setter.',
      'The job moves on the Dispatch Dashboard (/dispatch-dashboard); the assigned provider works it in Speedy Pro (offers, status, completion).',
      'The customer follows along at /track (Track My Tech) with the booking reference + their phone.',
      'Money on a residential job: $99 diagnostic collected at booking, credited toward an approved repair; repair labor is $210 flat, installation $150 flat, parts at written quote — no work without an approved written quote.',
    ],
    note: 'Dryer-vent cleaning is never booked as a Top Speed service — route it to Cleanout Vents at 954-931-7997.',
  },
  {
    id: 'approve-house-ad',
    title: 'Approve the house ad in Ad Studio',
    areaId: 'ad-studio',
    keywords: ['approve ad', 'approve the ad', 'approve house ad', 'approve campaign', 'house campaign', 'pending approval', 'flywheel banner not showing', 'banner is empty', 'ad approval'],
    steps: [
      'Open Ad Studio (/ad-studio) signed in as the Master — campaign approval is owner-only.',
      'Find the house campaign "Refrigerator Repair — Speedy Booking Launch" in PENDING_APPROVAL.',
      'Review the creative and copy against the rules (no invented reviews or ratings, no $99 outside residential repair, no vent prices, no phone numbers in ad text).',
      'Approve it: the campaign moves to ACTIVE.',
      'The Flywheel mini banner starts rendering on the customer surfaces — before approval the banner renders nothing, which is expected, not a bug.',
    ],
    note: 'Staff can build and submit campaigns (DRAFT → PENDING_APPROVAL); only the owner can approve (PENDING_APPROVAL → ACTIVE).',
  },
  {
    id: 'payment-status',
    title: 'Check whether payments are live (Stripe status)',
    areaId: 'payments',
    keywords: ['payment status', 'are payments live', 'stripe status', 'check payments', 'payments configured', 'diagnostic payment', 'payouts', 'webhook status'],
    steps: [
      'Fastest check: open the live status — GET https://top-speed-service-os.vercel.app/api/v1/payments/status.',
      'Read the three fields: configured (card payments live), webhookConfigured (booking payments confirm automatically), diagnosticAmountCents (9900 = the $99 diagnostic).',
      'For the money picture inside the platform, open Finance OS (/finance).',
      'Payouts are separate: they are managed in the Stripe dashboard (dashboard.stripe.com → Settings → Payouts). If no bank account is on file there, payouts stay disabled even though payments are live — adding the bank account is the owner\'s step in Stripe.',
    ],
    note: 'Payments being live and payouts being enabled are two different states — check both before telling anyone "Stripe is done."',
  },
  {
    id: 'email-thread',
    title: 'Find a customer\'s email thread in the Email Manager',
    areaId: 'email-manager',
    keywords: ['find email', 'customer email', 'email thread', 'email manager', 'search email', 'find a customer email', 'forwarded email', 'where is the email', 'inbox'],
    steps: [
      'Open Book OS (/book-os) and scroll to the "Email Manager — Inbox" panel.',
      'Pick the mailbox filter that matches where the mail was sent: Forwarded service@ inbox (everything sent to service@topspeedappliance.net), service@topspeedserviceos.com, or booking@topspeedserviceos.com.',
      'Open the thread from the inbox list. Mail from a known customer is already filed onto their CRM record — the same thread is visible from the customer\'s page in the CRM (/crm).',
      'Reply from inside the thread when you are ready: a human always clicks send — replies go out through Resend from the address the mail was sent to.',
      'Unmatched mail is never dropped: it waits in the inbox until it is filed.',
    ],
    note: 'Receiving is proven end to end (service@ Gmail forwards a copy of every email into this inbox). If expected mail is missing, check the Resend dashboard for delivery before assuming the console lost it.',
  },
  {
    id: 'publish-marketing-page',
    title: 'Publish a Marketing OS page',
    areaId: 'page-studio',
    keywords: ['publish a page', 'publish page', 'marketing os page', 'create landing page', 'page studio', 'new landing page', 'publish landing page'],
    steps: [
      'Open Page Studio (/marketing-os/studio) from the Marketing OS hub.',
      'Build the page from the taxonomy — city, brand, service, symptom. The taxonomy is fixed (15 cities, 14 brands, 11 services, 7 symptoms); pages are assembled from it, not free-typed.',
      'Save the draft, then review it like a customer: right city, right service, honest claims only (no invented reviews, no $99 outside residential repair, no vent prices).',
      'Publish from the Studio.',
      'Verify the page live in a browser, then watch it in the SEO dashboard (/marketing-os/seo) as search data comes in.',
    ],
    note: 'The published set today is 131 landing pages across 65 tri-county cities — say "131 landing pages" and "65 cities", never "131 cities".',
  },
  {
    id: 'moderate-review',
    title: 'Moderate a Pepper Lists review',
    areaId: 'review-moderation',
    keywords: ['moderate review', 'moderate a review', 'review moderation', 'pending review', 'hide a review', 'publish a review', 'office reply', 'bad review', 'low rating review'],
    steps: [
      'Open Book OS (/book-os) and find the Pepper Lists reviews moderation panel — the staff lane of the Reviews wall.',
      'Work the queue: it defaults to PENDING and escalated reviews (positive reviews publish on their own; flagged or low-rating reviews wait here).',
      'Read the review and any media, then choose: Publish (it joins the public wall), Hide (it leaves the wall), or Reply — the office reply shows to the customer as "Top Speed Appliance — Office".',
      'Speedy\'s automatic reply is already on the thread; the office reply is the human voice on top of it.',
    ],
    note: 'Provider ratings come only from real reviews of real completed jobs — never edit, seed, or invent a rating.',
  },
  {
    id: 'order-part',
    title: 'Order a part through Parts Supply OS',
    areaId: 'parts',
    keywords: ['order a part', 'order parts', 'buy a part', 'parts order', 'plus ai', 'appliance plus', 'fitment', 'find a part', 'part number'],
    steps: [
      'Open Parts Supply OS (/parts) and go to the featured partner section — Appliance Plus Parts Supply.',
      'Choose the door that fits: "Shop the Store" for the catalog, "Ask PLUS AI" for fitment help, or "Pro Shopping" for trade accounts — each opens the partner platform on the right tab.',
      'Check fitment before ordering: a part counts as "verified" fit only when it comes from the partner\'s stored compatibility records. An AI suggestion by itself is a suggestion until it is confirmed against those records.',
      'Place the order in the partner platform. Note: partner checkout currently records demo orders — live payments start when the partner\'s own Stripe is connected, so confirm any real purchase path with the office before relying on it.',
    ],
    note: 'Appliance Plus Parts Supply is the parts distributor partner. Appliance Plus Air, LLC is a different, separate company — never mix them.',
  },
  {
    id: 'speedy-fallback',
    title: 'Speedy is answering from fallback — what it means and the fix',
    areaId: 'speedy',
    keywords: ['speedy fallback', 'knowledge fallback', 'speedy down', 'speedy not working', 'speedy ai down', 'answeredby fallback', 'openai credit', 'speedy live ai', 'why is speedy'],
    steps: [
      'Confirm the state: open GET /api/v1/speedy/status — and any chat answer shows answeredBy: "knowledge-fallback" instead of "ai".',
      'Understand what still works: Speedy keeps answering from its 82-entry knowledge base (site, glossary, industry) — questions get grounded answers. What does NOT work on fallback: live AI chat quality, photo diagnosis, plate reads, and chat bookings (the summary card cannot appear, so no chat booking can be sent — point customers to the web form or 954-931-7997).',
      'Know the current cause before escalating: the API key is fresh and valid, but the OpenAI account balance is $0.00 with no payment method — OpenAI refuses calls at zero credit regardless of the key.',
      'The fix is one owner step, outside the platform: at platform.openai.com → Billing, add a payment method and buy credit.',
      'No deploy or code change is needed: once credit lands, Speedy flips to live AI on its own. Verify with a test chat — answeredBy should read "ai".',
    ],
    note: 'Never tell a customer Speedy is "broken" — on fallback it still answers; and never invent a restoration time.',
  },
];

/* ------------------------- derived Navigator entries ------------------------- */

const AREA_BY_ID = new Map(SYSTEM_MAP_AREAS.map((area) => [area.id, area]));

export function areaAnswer(area) {
  const lines = [
    `${area.name} — ${area.purpose}`,
    `Where: ${area.location} (${area.url})`,
    `Who can use it: ${area.access}.`,
  ];
  if (area.actions?.length) lines.push(`Key actions: ${area.actions.join('; ')}.`);
  return lines.join('\n');
}

export function howtoAnswer(howto) {
  const area = AREA_BY_ID.get(howto.areaId);
  const lines = [`${howto.title}:`];
  howto.steps.forEach((step, i) => lines.push(`${i + 1}. ${step}`));
  if (howto.note) lines.push(howto.note);
  if (area) lines.push(`Where: ${area.location} (${area.url})`);
  return lines.join('\n');
}

/**
 * Knowledge entries in the exact shape the shared retrieval scorer
 * (knowledge/index.js searchEntries) ranks: { id, topic, keywords,
 * answer, link }. Areas answer "where is X?"; how-tos answer
 * "how do I Y?" — one pool, ranked together.
 */
export function navigatorEntries() {
  const areas = SYSTEM_MAP_AREAS.map((area) => ({
    id: `area-${area.id}`,
    kind: 'area',
    areaId: area.id,
    topic: area.name,
    keywords: [area.name, ...(area.keywords || [])],
    answer: areaAnswer(area),
    link: area.url,
    linkName: area.name,
  }));
  const howtos = SYSTEM_HOWTOS.map((howto) => {
    const area = AREA_BY_ID.get(howto.areaId);
    return {
      id: `howto-${howto.id}`,
      kind: 'howto',
      areaId: howto.areaId,
      topic: howto.title,
      keywords: [howto.title, ...(howto.keywords || []), ...(area ? [area.name] : [])],
      answer: howtoAnswer(howto),
      link: area ? area.url : null,
      linkName: area ? area.name : null,
    };
  });
  return [...areas, ...howtos];
}

/** The directory payload for GET /navigator/map — the same source,
 *  grouped for the page. Carries no data beyond what staff already see. */
export function systemMapPayload() {
  return {
    groups: SYSTEM_MAP_GROUPS.map((name) => ({
      name,
      areas: SYSTEM_MAP_AREAS.filter((area) => area.group === name).map((area) => ({
        id: area.id,
        name: area.name,
        location: area.location,
        url: area.url,
        purpose: area.purpose,
        access: area.access,
        actions: area.actions || [],
        related: area.related || [],
      })),
    })).filter((group) => group.areas.length),
    howtos: SYSTEM_HOWTOS.map((howto) => {
      const area = AREA_BY_ID.get(howto.areaId);
      return {
        id: howto.id,
        title: howto.title,
        steps: howto.steps,
        note: howto.note || null,
        areaId: howto.areaId,
        areaName: area ? area.name : null,
        url: area ? area.url : null,
      };
    }),
    counts: { areas: SYSTEM_MAP_AREAS.length, howtos: SYSTEM_HOWTOS.length },
  };
}

/* --------------------- Academy course (modules 30–38) ---------------------
 * "System Navigator: Know Your Platform" — generated from the SAME map
 * and how-tos above. Each lesson becomes one Media OS content record
 * (type ARTICLE, tagged training-academy + system-navigator, status
 * PUBLISHED) seeded create-only by slug via data/mediaOsSeed.js — the
 * Academy's existing content mechanism, same as modules 1–29. */
export const NAVIGATOR_LESSONS = [
  {
    module: 30, part: 'where-things-live', title: 'Where Things Live',
    teaches: 'The platform map: every console, what it is for, who can open it — and the Navigator that answers "where is…?" from this same map.',
    areaIds: ['applianceman', 'turbo-boss', 'oversight', 'manager', 'navigator', 'book-os', 'crm'],
    howtoIds: [],
  },
  {
    module: 31, part: 'bookings-and-dispatch', title: 'Bookings & Dispatch',
    teaches: 'A booking\'s road: web form first, the setter queue, dispatch, the tech in Speedy Pro, and the customer tracking it.',
    areaIds: ['book', 'book-os', 'dispatch-dashboard', 'service-setters', 'speedy-pro'],
    howtoIds: ['booking-flow'],
  },
  {
    module: 32, part: 'accounts-and-work-time-access', title: 'Accounts & Work Time Access',
    teaches: 'Issuing accounts and passwords in Work Time Account Access, employee numbers, Speedy Verify codes, and the Layer 2 step at sign-in.',
    areaIds: ['work-time', 'speedy-verify', 'layer2'],
    howtoIds: ['issue-account', 'verify-code'],
  },
  {
    module: 33, part: 'payments', title: 'Payments',
    teaches: 'Checking Stripe status, the $99 diagnostic, Finance OS, and why payouts are a separate switch in the Stripe dashboard.',
    areaIds: ['payments', 'finance'],
    howtoIds: ['payment-status'],
  },
  {
    module: 34, part: 'marketing-os-and-ad-studio', title: 'Marketing OS & Ad Studio',
    teaches: 'Publishing pages from the taxonomy in Page Studio, reading the SEO dashboard, and approving the house ad so the Flywheel banner lights up.',
    areaIds: ['marketing-os', 'page-studio', 'seo-dashboard', 'ad-studio', 'flywheel', 'media-os'],
    howtoIds: ['publish-marketing-page', 'approve-house-ad'],
  },
  {
    module: 35, part: 'email-manager', title: 'Email Manager',
    teaches: 'The three managed mailboxes in Book OS, finding any customer thread, and how mail files itself onto the CRM record.',
    areaIds: ['email-manager', 'book-os', 'crm'],
    howtoIds: ['email-thread'],
  },
  {
    module: 36, part: 'pepper-lists', title: 'Pepper Lists',
    teaches: 'The two categories — Sell and Post — the Advertise lane, and moderating the Reviews wall from Book OS.',
    areaIds: ['pepper-lists', 'review-moderation', 'advertiser-console'],
    howtoIds: ['moderate-review'],
  },
  {
    module: 37, part: 'parts', title: 'Parts',
    teaches: 'Ordering through Parts Supply OS and the Appliance Plus partner — and what "verified fitment" actually means.',
    areaIds: ['parts', 'appliance-plus'],
    howtoIds: ['order-part'],
  },
  {
    module: 38, part: 'speedy-and-ai-tools', title: 'Speedy & AI Tools',
    teaches: 'How Speedy answers customers, what fallback mode means, the engines on /explore, and the one owner step that turns live AI back on.',
    areaIds: ['speedy', 'explore', 'navigator', 'academy'],
    howtoIds: ['speedy-fallback'],
  },
];

function slugify(text) {
  return String(text).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function lessonTranscript(lesson) {
  const lines = [
    `System Navigator: Know Your Platform — Lesson ${lesson.module - 29} of 9 (Academy Module ${lesson.module}).`,
    lesson.teaches,
    '',
    'THE MAP — WHERE THINGS LIVE:',
  ];
  for (const areaId of lesson.areaIds) {
    const area = AREA_BY_ID.get(areaId);
    if (!area) continue;
    lines.push('', `${area.name} — ${area.location} (${area.url})`, area.purpose, `Access: ${area.access}.`);
    if (area.actions?.length) lines.push(`Key actions: ${area.actions.join('; ')}.`);
  }
  const howtos = lesson.howtoIds
    .map((id) => SYSTEM_HOWTOS.find((h) => h.id === id))
    .filter(Boolean);
  if (howtos.length) {
    lines.push('', 'THE PROCEDURES — HOW IT IS DONE:');
    for (const howto of howtos) {
      lines.push('', howtoAnswer(howto));
    }
  }
  lines.push(
    '',
    'This lesson is generated from the platform system map — the same source the System Navigator (/navigator) answers from — so the lesson and the live guide never drift apart.',
  );
  return lines.join('\n');
}

export function buildNavigatorLessonRecords() {
  return NAVIGATOR_LESSONS.map((lesson) => ({
    slug: `training-module-${lesson.module}-system-navigator-${slugify(lesson.part)}`,
    type: 'ARTICLE',
    division: 'PUBLISHING',
    title: `Module ${lesson.module}: System Navigator — ${lesson.title}`,
    description: `System Navigator: Know Your Platform, lesson ${lesson.module - 29} of 9. ${lesson.teaches}`,
    assetUrl: null,
    thumbnailUrl: null,
    durationSec: null,
    transcript: lessonTranscript(lesson),
    destinationUrl: '/navigator',
    status: 'PUBLISHED',
    publishAt: null,
    publishedAt: '2026-11-17T06:00:00.000Z',
    tags: ['training-academy', 'system-navigator'],
  }));
}
