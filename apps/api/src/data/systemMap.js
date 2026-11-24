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
//
// accessLabel/accessRoles (2026-11-18, customer-lockout audit): on the
// areas for badged staff consoles these mirror CONSOLE_ACCESS in
// apps/web/shared/access-badge.js EXACTLY (single-direction copy from
// the audited route gates); apps/api/test/access-badges.test.mjs fails
// if the two ever drift. Consoles with no system-map area (Notifications,
// Track Console) and the Academy (trainee gate — no label fits) carry
// no fields here.

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
    access: 'Managers and Master (COMPANY_ADMIN, COMPANY_OWNER)',
    accessLabel: 'MANAGER ONLY',
    accessRoles: ['COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'],
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
    accessLabel: 'MANAGER ONLY',
    accessRoles: ['COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'],
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
    accessLabel: 'MANAGER ONLY',
    accessRoles: ['COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'],
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
    accessLabel: 'MANAGER ONLY',
    accessRoles: ['COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'],
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
    accessLabel: 'STAFF ONLY',
    accessRoles: ['DISPATCHER', 'COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'],
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
    accessLabel: 'STAFF ONLY',
    accessRoles: ['DISPATCHER', 'COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'],
    actions: ['Filter by mailbox (Forwarded service@ inbox / service@ / booking@)', 'Open a customer thread', 'Reply from the thread — a human always clicks send (Resend sends from the address the mail came to)'],
    related: ['book-os', 'crm'],
    keywords: ['email manager', 'inbox', 'email', 'mail', 'mailboxes', 'forwarded inbox', 'customer email', 'email thread', 'resend inbox'],
  },
  {
    id: 'link-center',
    name: 'Link Center — Send Links',
    group: 'Bookings, Dispatch & Customers',
    location: 'topspeedserviceos.com/link-center (door in the Book OS notifications strip)',
    url: '/link-center',
    purpose: 'Ramone\'s send-links system (2026-11-18): a staff member picks one of four customer links — booking (the web form, Link Center recorded as the source), payment (the real Stripe checkout for a booking\'s $99 diagnostic, found by its TS reference; never an invented URL), account (sign in / create account), review (the Pepper Lists reviews wall) — picks email or SMS, enters the recipient, and clicks Send. Sends ride the notification outbox, so every send shows its true state: SENT only when the provider accepted, FAILED with the provider error (SMS runs on the Twilio account — upgraded 2026-11-18; the consoles read its live state from Twilio), GATED when a channel is unconfigured. The recent-sends log masks recipients.',
    access: 'All staff',
    accessLabel: 'STAFF ONLY',
    accessRoles: ['DISPATCHER', 'COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'],
    actions: ['Send a booking, payment, account or review link by email or text', 'Enter a booking reference to mint/reuse its diagnostic payment link', 'Read the recent-sends log with true delivery states'],
    related: ['book-os', 'email-manager', 'payments', 'review-moderation'],
    keywords: ['link center', 'send links', 'send a link', 'text a link', 'email a link', 'payment link', 'booking link', 'review link', 'account link', 'sms link', 'send payment link'],
  },
  {
    id: 'dispatch-dashboard',
    name: 'Dispatch Dashboard',
    group: 'Bookings, Dispatch & Customers',
    location: 'topspeedserviceos.com/dispatch-dashboard',
    url: '/dispatch-dashboard',
    purpose: 'The live dispatch board: today\'s jobs, matching and assignment state — the working view for setters and dispatchers after the queue.',
    access: 'All staff',
    accessLabel: 'STAFF ONLY',
    accessRoles: ['DISPATCHER', 'COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'],
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
    accessLabel: 'STAFF ONLY',
    accessRoles: ['DISPATCHER', 'COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'],
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
    accessLabel: 'STAFF ONLY',
    accessRoles: ['DISPATCHER', 'COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'],
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
    accessLabel: 'STAFF ONLY',
    accessRoles: ['DISPATCHER', 'COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'],
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
    accessLabel: 'STAFF ONLY',
    accessRoles: ['DISPATCHER', 'COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'],
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
    purpose: 'Customer 360: every customer\'s record, communications log, and Speedy briefs. Customer email from the Email Manager files onto these records. Connected systems: Service Setters Book OS and the dispatch software work the same booking records; the Tech App (Speedy Pro) and the Field Pro mobile app read their assignments from the same book; Oversight, Manager and Turbo Boss read their boards and aggregates over the same customers and bookings.',
    access: 'All staff',
    accessLabel: 'STAFF ONLY',
    accessRoles: ['DISPATCHER', 'COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'],
    actions: ['Open a customer record', 'Read the communications log', 'Read Speedy briefs on the customer'],
    related: ['book-os', 'dispatch-dashboard', 'email-manager', 'speedy-pro', 'oversight', 'manager', 'turbo-boss'],
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
    accessLabel: 'STAFF ONLY',
    accessRoles: ['DISPATCHER', 'COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'],
    actions: ['Review captured Speedy chats', 'Find questions Speedy could not answer'],
    related: ['speedy', 'book-os'],
    keywords: ['chat insights', 'speedy chats', 'chat history', 'conversations', 'unanswered questions'],
  },
  {
    id: 'notifications',
    name: 'Notifications',
    group: 'Bookings, Dispatch & Customers',
    location: 'topspeedserviceos.com/notifications',
    url: '/notifications',
    purpose: 'The email & SMS outbox: every alert the platform sends, with truthful delivery status — a send reads as sent only when the provider accepted it.',
    access: 'All staff (DISPATCHER, COMPANY_ADMIN, COMPANY_OWNER, PLATFORM_ADMIN)',
    accessLabel: 'STAFF ONLY',
    accessRoles: ['DISPATCHER', 'COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'],
    actions: ['Review the email & SMS outbox', 'Check the delivery status on any send'],
    related: ['book-os', 'link-center'],
    keywords: ['notifications', 'outbox', 'email alerts', 'sms alerts', 'delivery status', 'alerts'],
  },
  {
    id: 'track-console',
    name: 'Track My Tech Console',
    group: 'Bookings, Dispatch & Customers',
    location: 'topspeedserviceos.com/track-console',
    url: '/track-console',
    purpose: 'The staff tracking board: every active job’s stage, technician and ETA — assign techs, advance stages, and keep the customer updated.',
    access: 'All staff (DISPATCHER, COMPANY_ADMIN, COMPANY_OWNER, PLATFORM_ADMIN)',
    accessLabel: 'STAFF ONLY',
    accessRoles: ['DISPATCHER', 'COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'],
    actions: ['Watch every active job’s stage', 'Assign techs and advance stages'],
    related: ['dispatch-dashboard', 'book-os'],
    keywords: ['track console', 'tracking console', 'track my tech staff', 'job stages', 'eta board'],
  },
  {
    id: 'pro-booking',
    name: 'Speedy Pro Booking',
    group: 'Bookings, Dispatch & Customers',
    location: 'topspeedserviceos.com/pro-booking',
    url: '/pro-booking',
    purpose: 'Staff call bookings: the Pro Booking form creates the customer in the CRM and drops the job straight into the Service Setters dispatch queue.',
    access: 'All staff (DISPATCHER, COMPANY_ADMIN, COMPANY_OWNER, PLATFORM_ADMIN)',
    accessLabel: 'STAFF ONLY',
    accessRoles: ['DISPATCHER', 'COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'],
    actions: ['Book a repair from a phone call', 'Create the CRM customer and the dispatch job in one pass'],
    related: ['book-os', 'crm'],
    keywords: ['pro booking', 'speedy pro booking', 'call booking', 'phone booking', 'staff booking form'],
  },
  {
    id: 'cococane-express',
    name: 'CocoCane Express',
    group: 'Bookings, Dispatch & Customers',
    location: 'topspeedserviceos.com/cococane-express',
    url: '/cococane-express',
    purpose: 'The CocoCane staff console: coconut and sugarcane orders, locations and the stock board. Stock starts at zero and is entered by staff — nothing shows available until a real count is entered.',
    access: 'All staff (DISPATCHER, COMPANY_ADMIN, COMPANY_OWNER, PLATFORM_ADMIN)',
    accessLabel: 'STAFF ONLY',
    accessRoles: ['DISPATCHER', 'COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'],
    actions: ['Work CocoCane orders', 'Enter and adjust stock counts', 'Manage locations and products'],
    related: ['book-os'],
    keywords: ['cococane', 'cococane express', 'coconut orders', 'sugarcane', 'stock board'],
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
    accessLabel: 'OWNER ONLY',
    accessRoles: ['COMPANY_OWNER'],
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
    id: 'multi-account-sessions',
    name: 'Multi-Account Sessions & Handoffs',
    group: 'Accounts & Access',
    location: 'Every platform surface — the account switcher chip in the top bar; sign-in travel via /auth-handoff',
    url: '/add-account',
    purpose: 'Ramone\'s rule: an account holder can go anywhere in the platforms while staying signed in — to any account, and any number of accounts at the same time — with no security risks and no conflicts. Each browser keeps a session vault: one entry per signed-in account, entered only when a final sign-in token is issued (after the password plus every Speedy Verify and Layer 2 gate that account requires — never from a challenge token). The switcher in the top bar swaps the active account; signing out removes only that account and promotes the next. Doors to other platform hosts (Navigator directory, Work Time Access Directory) carry a one-time 60-second handoff code, so the holder lands on the far host already signed in as the same account — codes are hashed at rest, single-use, and every failed redemption looks identical. Switching never merges roles or data, and the Master account is never locked out.',
    access: 'Every account holder; per-account gates unchanged',
    actions: ['Switch the active account from the top-bar switcher', 'Add another account without signing the current one out (/add-account)', 'Sign out one account, or all accounts, from the switcher', 'Follow a door to another platform host and land already signed in'],
    related: ['speedy-verify', 'layer2', 'work-time', 'navigator'],
    keywords: ['multi-account', 'multiple accounts', 'account switcher', 'switch account', 'signed in everywhere', 'stay signed in', 'session vault', 'handoff', 'sign-in link', 'add account', 'two accounts'],
  },
  {
    id: 'navigator',
    name: 'System Navigator',
    group: 'Accounts & Access',
    location: 'topspeedserviceos.com/navigator',
    url: '/navigator',
    purpose: 'This guide: the staff-only AI navigator and directory for the whole platform. Ask where anything lives or how anything is done; it answers from the system map and deep-links you there. It explains and links — it never performs actions.',
    access: 'All staff',
    accessLabel: 'STAFF ONLY',
    accessRoles: ['DISPATCHER', 'COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'],
    actions: ['Ask "where is …?" and get the exact console plus a link', 'Ask "how do I …?" and get the live steps', 'Browse the full system directory'],
    related: ['academy', 'applianceman', 'pepper-console'],
    keywords: ['navigator', 'system navigator', 'guide', 'help', 'where is everything', 'system map', 'directory'],
  },
  {
    id: 'pepper-console',
    name: 'Pepper — Systems Manager',
    group: 'Command & Consoles',
    location: 'topspeedserviceos.com/pepper',
    url: '/pepper',
    purpose: 'Pepper\u2019s duty post inside the Workstation: the live systems board (payments, Speedy, the notification outbox, Insights connections, Ad Studio and Pepper Lists channel states, read from the real systems), the list of what needs Ramone, the Pepper report log staff file into, and Pepper\u2019s standing orders — the authority limits and Rule Zero. Pepper reports to Ramone Williams.',
    access: 'All staff',
    accessLabel: 'STAFF ONLY',
    accessRoles: ['DISPATCHER', 'COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'],
    actions: ['Read the systems board', 'Check what needs the owner', 'File and read Pepper reports', 'Review the standing orders (authority limits + Rule Zero)'],
    related: ['navigator', 'applianceman', 'oversight'],
    keywords: ['pepper', 'systems manager', 'system operations manager', 'pepper console', 'duty post', 'systems board', 'pepper reports', 'needs ramone', 'standing orders'],
  },
  {
    id: 'platform-interconnect',
    name: 'Platform Interconnect',
    group: 'Command & Consoles',
    location: 'topspeedserviceos.com/interconnect',
    url: '/interconnect',
    purpose: 'The wiring map of the whole ecosystem on the one Service OS backend: every platform and surface with its real connection state — signed-in travel (which hosts run a live /auth-handoff/ receiver, and when that was last verified by an actual fetch), how each surface reaches the one API (same deployment, direct CORS, same-origin proxy, or none), the shared services it uses (Speedy, attribution, payments, the notification outbox), and its most recent event from the durable cross-platform event feed. States are verified facts, never decorations.',
    access: 'All staff',
    accessLabel: 'STAFF ONLY',
    accessRoles: ['DISPATCHER', 'COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'],
    actions: ['Check which platforms a signed-in holder can travel between', 'See how every surface reaches the one backend', 'Read the latest real activity per surface from the event feed', 'Spot the surfaces still missing a receiver'],
    related: ['navigator', 'pepper-console'],
    keywords: ['interconnect', 'platform interconnect', 'wiring', 'handoff', 'receivers', 'event feed', 'cross-platform', 'surfaces', 'connections'],
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
    accessLabel: 'MANAGER ONLY',
    accessRoles: ['COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'],
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
  {
    id: 'sales-os',
    name: 'Top Speed Sales OS',
    group: 'Money',
    location: 'topspeedserviceos.com/sales-os',
    url: '/sales-os',
    purpose: 'The FIRST Top Speed Sales OS platform — the OS platform for everything sales inside the Service OS. Its first sales vendor is Top Speed Appliances, the used-appliance shop at topspeedappliances.com: staff enter real used units (category, brand, model, condition grade LIKE_NEW/EXCELLENT/GOOD/FAIR, price, stock, photos, warranty) as DRAFTS and activate them; the public storefront catalog serves ACTIVE products only. Customers order on the spot (no account, no office approval); totals are computed server-side from the stored prices (total = subtotal, no invented tax or fees) and checkout runs through the platform Stripe pattern, saving as PENDING_PAYMENT with checkout null when Stripe is not configured. The catalog launches empty — no product, price, or stock is seeded or invented.',
    access: 'Sales staff (Company Owner, Company Admin, Platform Admin, Marketing Manager); the storefront catalog + order placement are public',
    accessLabel: 'STAFF ONLY',
    accessRoles: ['COMPANY_OWNER', 'COMPANY_ADMIN', 'PLATFORM_ADMIN', 'MARKETING_MANAGER'],
    actions: ['Read the sales overview (product + order counts by status, vendor)', 'Create and edit catalog products (all fields, DRAFT → ACTIVE/SOLD/ARCHIVED)', 'Read storefront orders and move them through fulfillment (PAID / FULFILLING / COMPLETED / CANCELLED)', 'Record payment status and the Stripe reference on an order'],
    related: ['payments', 'finance'],
    keywords: ['sales os', 'sales', 'used appliances', 'topspeedappliances', 'storefront', 'catalog', 'shop', 'orders', 'vendor'],
  },

  /* ------------------------- Marketing, Media & Ads ------------------------- */
  {
    id: 'os-updates',
    name: 'OS Systems — Updates',
    group: 'Command & Consoles',
    location: 'topspeedserviceos.com/os-updates',
    url: '/os-updates',
    purpose: 'The OS Systems Updating System (2026-11-23, Ramone\'s directive): the database registry of every OS platform and the tech packs each platform runs — installed versions read from the platforms\' own package files, latest versions refreshed from the npm registry — and the 6-month update cycle that computes drift (CURRENT / MINOR_BEHIND / MAJOR_BEHIND / UNKNOWN) and generates a per-platform update plan as tasks born PENDING or PLANNED. The system prepares, tracks and verifies updates; it never rewrites production code — updates ship through the normal build, push and owner-approval flow and are then marked APPLIED / VERIFIED here. The baseline cycle (2026-11-baseline) is due 2027-05-23; the semiannual scheduler door accepts the CRON_SECRET like the campaign engine.',
    access: 'Master and managers (COMPANY_OWNER, COMPANY_ADMIN, PLATFORM_ADMIN)',
    accessLabel: 'MANAGER ONLY',
    accessRoles: ['COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'],
    actions: ['Read the registry summary (platforms, tech packs, drift counts, open cycle)', 'Refresh latest tech-pack versions from the npm registry', 'Open the next 6-month update cycle and work its task plan', 'Move update tasks through APPLIED and VERIFIED as real updates land'],
    related: ['sales-os', 'applianceman'],
    keywords: ['os updates', 'systems updating', 'tech packs', 'update cycle', 'version drift', 'platform registry', 'semiannual updates'],
  },
  {
    id: 'marketing-os',
    name: 'Marketing OS',
    group: 'Marketing, Media & Ads',
    location: 'topspeedserviceos.com/marketing-os',
    url: '/marketing-os',
    purpose: 'The in-house marketing agency hub, built on one taxonomy: 15 cities, 14 brands, 11 services, 7 symptoms. Pages, the Studio, and SEO all run from here.',
    access: 'Staff (marketing roles, managers, Master)',
    accessLabel: 'STAFF ONLY',
    accessRoles: ['MARKETING_MANAGER', 'AD_SPECIALIST', 'COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'],
    actions: ['Open the agency hub', 'Reach Page Studio and the SEO dashboard'],
    related: ['page-studio', 'seo-dashboard', 'google-accounts'],
    keywords: ['marketing os', 'marketing hub', 'agency', 'marketing agency', 'taxonomy', 'flywheel ai advertising'],
  },
  {
    id: 'local-os',
    name: 'Top Speed Local OS',
    group: 'Marketing, Media & Ads',
    location: 'topspeedserviceos.com/local',
    url: '/local',
    purpose: 'The local face of the one Local OS + Marketing OS platform: local search directories, maps presence, listings and the reviews engine. Marketing OS is the other face of the same platform — the local websites, landing pages and city pages.',
    access: 'Staff (marketing roles, managers, Master)',
    actions: ['Work local listings and directory presence', 'Run the reviews engine'],
    related: ['marketing-os', 'page-studio'],
    keywords: ['local os', 'top speed local os', 'local presence', 'directories', 'maps', 'listings', 'reviews engine'],
  },
  {
    id: 'page-studio',
    name: 'Page Studio',
    group: 'Marketing, Media & Ads',
    location: 'topspeedserviceos.com/marketing-os/studio',
    url: '/marketing-os/studio',
    purpose: 'Where Marketing OS landing pages are built and published: pick the city, brand, service and symptom from the taxonomy, draft, review, publish, then verify the page live.',
    access: 'Staff',
    accessLabel: 'STAFF ONLY',
    accessRoles: ['MARKETING_MANAGER', 'AD_SPECIALIST', 'COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'],
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
    accessLabel: 'STAFF ONLY',
    accessRoles: ['MARKETING_MANAGER', 'AD_SPECIALIST', 'COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'],
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
    accessLabel: 'STAFF ONLY',
    accessRoles: ['MARKETING_MANAGER', 'AD_SPECIALIST', 'COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'],
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
    accessLabel: 'STAFF ONLY',
    accessRoles: ['MARKETING_MANAGER', 'AD_SPECIALIST', 'COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'],
    actions: ['Build a campaign', 'Submit for approval', 'Approve a pending campaign (Master only)', 'Pause or end a campaign', 'Build a streaming campaign', 'Load the Flywheel Streaming Pack (Master only)'],
    related: ['flywheel', 'advertiser-console', 'streaming-ads'],
    keywords: ['ad studio', 'ads', 'approve ads', 'approve ad', 'house campaign', 'house ad', 'campaign approval', 'pending approval', 'flywheel ads', 'flywheel ai advertising'],
  },
  {
    id: 'facebook-os',
    name: 'Top Speed Facebook OS Manager',
    group: 'Marketing, Media & Ads',
    location: 'topspeedserviceos.com/facebook-os',
    url: '/facebook-os',
    purpose: 'The official Top Speed Appliance Facebook Page (Repair & Installation) integrated with the Service OS in both directions: OUT — a database-backed daily stream queue (7 slots a week: the 3 Top Speed Posts by Pepper series posts plus City Spotlight, Quick Tip, Rewards explainer and Review Invite rotations) whose posts Pepper publishes through the owner\'s connected Facebook account behind Ramone\'s per-post approval card; IN — the Page\'s real published activity read back from the recorded-posts registry (POSTED rows carrying their real facebook.com URLs — the server holds no Facebook credential and never fabricates Page activity). Facebook Ads are built in as planning drafts with recorded-only spend plus the Ads Manager deep link: Meta has API writes DISABLED on the ad account, so nothing here can create, enable, or fund an ad. Posted posts syndicate across the fleet (homepage, city pages, customer app, Pepper Lists, satellites) with Rule 1 deep links, and the public feed serves POSTED posts only.',
    access: 'Marketing roles (Marketing Manager, Ad Specialist, Company Admin, Company Owner, Platform Admin); publishing itself is Pepper behind Ramone\'s approval card',
    accessLabel: 'STAFF ONLY',
    accessRoles: ['MARKETING_MANAGER', 'AD_SPECIALIST', 'COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'],
    actions: ['Read the stream queue and today\'s post', 'Create a stream post draft', 'Move a post through its lifecycle (submit, schedule, record Posted with its real URL)', 'Register a Posts by Pepper week (ingest)', 'Read recorded Page activity', 'Create and update Facebook ad drafts (recorded figures only)', 'Record syndication across surfaces'],
    related: ['ad-studio', 'media-os', 'marketing-os', 'flywheel'],
    keywords: ['facebook os', 'facebook manager', 'facebook page', 'posts by pepper', 'stream queue', 'daily posts', 'facebook ads drafts', 'page activity', 'syndication'],
  },
  {
    id: 'streaming-ads',
    name: 'Streaming Ads (Flywheel AI Advertising)',
    group: 'Marketing, Media & Ads',
    location: 'topspeedserviceos.com/ad-studio',
    url: '/ad-studio',
    purpose: 'The Streaming Ads channel inside Ad Studio: Google-style text and display ads aimed at streaming TV providers (Roku, YouTube TV, Hulu, Peacock, Paramount+, Pluto TV, Samsung TV Plus). Campaigns carry the STREAMING placement with format, provider targets, headlines, descriptions and display sizes, and are reviewed as Google-style previews. The Flywheel Streaming Pack is 10 ready-made ads (5 text + 5 display) the Master loads into the approval queue from Ad Studio — loading never activates anything, and approval works exactly like every campaign. Streaming campaigns never enter the owned-surface banner feed. Provider names are target labels only: placing ads on the providers needs their own ad accounts and budget, a separate activation that has NOT happened.',
    access: 'Staff build and submit; the pack loader and all approvals are Master (owner) only',
    accessLabel: 'STAFF ONLY',
    accessRoles: ['MARKETING_MANAGER', 'AD_SPECIALIST', 'COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'],
    actions: ['Review streaming ads as Google-style previews', 'Load the Flywheel Streaming Pack (Master only)', 'Approve a streaming campaign (Master only)'],
    related: ['ad-studio', 'flywheel'],
    keywords: ['streaming ads', 'streaming', 'roku', 'hulu', 'youtube tv', 'peacock', 'paramount', 'pluto tv', 'samsung tv plus', 'ctv', 'ott', 'google style ads', 'text ads', 'display ads', 'streaming pack', 'flywheel streaming pack'],
  },
  {
    id: 'top-speed-ads',
    name: 'Top Speed Ads',
    group: 'Marketing, Media & Ads',
    location: 'topspeedserviceos.com/ad-studio',
    url: '/ad-studio',
    purpose: 'Top Speed Ads is the name of the in-house ads system (the Ad Studio console): Flywheel AI Advertising campaigns built, approved and served on Top Speed\'s own surfaces. It adds first-touch attribution (UTM + Google/Meta/Microsoft click IDs captured on landing pages and attached to bookings), raw serve/click counters on the banner feed (clicks counted through a server redirect), a Flywheel loop view (serves → clicks → attributed bookings → completed jobs → reviews → referrals, every stage counted from the real records with the same campaign-tag attribution join as cost per won job), a "Draft with Speedy" AI copy drafter whose drafts always land in the owner approval queue, a creative picker over the house poster and scenario libraries, and an External platforms readiness board that mirrors the campaigns of record on Google Ads, Meta and Microsoft Ads with their missing steps — a read-only, dated mirror: budgets and launches happen inside each platform, and nothing in Top Speed Ads spends money.',
    access: 'Staff build and submit; approvals are Master (owner) only; the external board is read-only',
    accessLabel: 'STAFF ONLY',
    accessRoles: ['MARKETING_MANAGER', 'AD_SPECIALIST', 'COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'],
    actions: ['Build a campaign with house creative', 'Draft ad copy with Speedy (lands in the approval queue)', 'Read the attribution view', 'Read the Flywheel loop', 'Check external campaign readiness'],
    related: ['ad-studio', 'streaming-ads', 'flywheel', 'advertiser-console', 'adstream-providers'],
    keywords: ['top speed ads', 'attribution', 'gclid', 'fbclid', 'msclkid', 'utm', 'click tracking', 'impressions', 'ctr', 'external platforms', 'readiness board', 'draft with speedy', 'creative picker', 'flywheel loop'],
  },
  {
    id: 'adstream-providers',
    name: 'AdStream Providers (Top Speed Ads)',
    group: 'Marketing, Media & Ads',
    location: 'topspeedserviceos.com/ad-studio',
    url: '/ad-studio',
    purpose: 'The provider layer of Top Speed Ads: the external ad-serving providers the platform can serve through — Kevel (API-first ad infrastructure), AdButler (multi-format serving), Google Ad Manager (publisher display + video), SpringServe by Magnite and FreeWheel (video/CTV). Phase 1 is a connection registry inside Ad Studio (the "Ad serving" view): staff file a connection request per provider with an account reference, the office completes it once the real provider account exists, and NOTHING is connected or serving a live ad until an account and its key land (Phase 2). Kevel, AdButler and Google Ad Manager start with the owner opening the provider account; SpringServe and FreeWheel are enterprise agreements, also the owner\u2019s alone. The house surfaces (flagship, topspeedappliance.net, appliancepro.net, pepperlists.com) are served by the in-house display feed today; the providers would extend that serving layer, never replace the approval rules.',
    access: 'Ad Studio staff (Marketing Manager, Managers, Master); provider account signups and enterprise contracts are Master (owner) only',
    accessLabel: 'STAFF ONLY',
    accessRoles: ['MARKETING_MANAGER', 'AD_SPECIALIST', 'COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'],
    actions: ['File a provider connection request', 'Record a provider account reference', 'Disconnect a provider', 'Read the provider readiness steps on the external board'],
    related: ['ad-studio', 'top-speed-ads', 'streaming-ads'],
    keywords: ['adstream', 'ad serving', 'ad server', 'kevel', 'adbutler', 'google ad manager', 'gam', 'springserve', 'magnite', 'freewheel', 'ctv', 'ott', 'provider connections', 'publisher inventory', 'ad serving providers'],
  },
  {
    id: 'insights',
    name: 'Service OS Insights',
    group: 'Marketing, Media & Ads',
    location: 'topspeedserviceos.com/insights',
    url: '/insights',
    purpose: 'The web traffic & website activity manager: FIRST-PARTY lead and booking activity counted from the Service OS database itself (28 days by day, by source/medium/campaign, landing pages, surface tags, ad click IDs, and the lead → booking → completed funnel — records without captured attribution sit in an honest "(not captured)" bucket, never backfilled), PageSpeed Insights snapshots for the eight portfolio homepages (staff-triggered refresh; failures are stored as failures, never invented scores), the Google connections board (GA4, Search Console, Google Business Profile — real connection state only, no metrics until Google access is configured), and the property roster with each platform\'s measurement status from the 2026-11-17 audit.',
    access: 'Staff (DISPATCHER, COMPANY_ADMIN, COMPANY_OWNER, PLATFORM_ADMIN) + MARKETING_MANAGER + AD_SPECIALIST',
    accessLabel: 'STAFF ONLY',
    accessRoles: ['DISPATCHER', 'COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN', 'MARKETING_MANAGER', 'AD_SPECIALIST'],
    actions: ['Read lead & booking activity', 'Refresh PageSpeed snapshots', 'Check Google connection states and the connect steps', 'Read the property measurement roster'],
    related: ['seo-dashboard', 'top-speed-ads', 'ad-studio', 'google-accounts'],
    keywords: ['insights', 'web traffic', 'website activity', 'analytics', 'ga4', 'search console', 'google business profile', 'pagespeed', 'page speed', 'site speed', 'leads by source', 'attribution', 'funnel'],
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
    related: ['ad-studio', 'advertiser-console', 'streaming-ads'],
    keywords: ['flywheel', 'flywheel ai advertising', 'ai advertising', 'banner', 'banner ads', 'advertising system', 'mini banner'],
  },
  {
    id: 'media-os',
    name: 'Media OS',
    group: 'Marketing, Media & Ads',
    location: 'topspeedserviceos.com/media',
    url: '/media',
    purpose: 'The media library behind publishing and the Academy: content records with statuses (Draft → In review → Approved → Published). The Academy curriculum is the library records tagged "training-academy". Library admin stays admin-gated.',
    access: 'Admin: MARKETING_MANAGER, AD_SPECIALIST, COMPANY_ADMIN, COMPANY_OWNER, PLATFORM_ADMIN (the Academy read is open to trainees)',
    accessLabel: 'STAFF ONLY',
    accessRoles: ['MARKETING_MANAGER', 'AD_SPECIALIST', 'COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'],
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
  {
    id: 'advertiser-plans',
    name: 'Advertiser Plans & Billing (Flywheel)',
    group: 'Marketing, Media & Ads',
    location: 'topspeedserviceos.com/advertiser (Plans & Billing) + topspeedserviceos.com/ad-studio (Advertiser plans)',
    url: '/advertiser',
    purpose: 'The paid-plan layer of Flywheel AI Advertising: Starter / Growth / Pro plan tiers gate advertiser features (campaign caps, the Streaming Ads channel, the AI copy drafter, attribution and loop views, the creative picker) above the grandfathered baseline every existing advertiser keeps. Advertisers subscribe through Stripe Checkout; failed payments run ACTIVE → PAST_DUE → GRACE (owner-set window, default 7 days) → SUSPENDED (read-only). Plan PRICES are owner-configured only: a plan with no price set cannot be checked out, and its Stripe Product/Price is created at the moment the owner sets the price — nothing is ever priced by default.',
    access: 'Advertisers manage their own plan in the Advertiser Console; prices, plan structure, the grace window and office grants are Master (owner) only',
    actions: ['Compare plans and subscribe (advertiser)', 'Upgrade, schedule a downgrade, or cancel at period end (advertiser)', 'Set a plan price — syncs to Stripe (Master only)', 'Edit plan features and campaign caps (Master only)', 'Grant or revoke a plan without payment (Master only, audited)', 'See every advertiser\'s plan status and the past-due list'],
    related: ['ad-studio', 'advertiser-console', 'flywheel', 'streaming-ads'],
    keywords: ['advertiser plans', 'plans', 'billing', 'subscription', 'subscribe', 'plan price', 'starter', 'growth', 'pro plan', 'past due', 'grace period', 'office grant', 'flywheel plans'],
  },
  {
    id: 'ad-specialist',
    name: 'Ad Specialist Accounts',
    group: 'Marketing, Media & Ads',
    location: 'topspeedserviceos.com/ad-specialist (apply) + Work Time Account Access (issue)',
    url: '/ad-specialist',
    purpose: 'The account class for Top Speed\'s own ad specialists — the people who RUN the advertising (Google Search, Display and retargeting ads, Facebook ads, SEO marketing, and the in-house Flywheel system), fully separate from the advertiser marketplace accounts businesses hold. Specialists work in Marketing OS / Top Speed Local OS, Top Speed Ads (Ad Studio), Page Studio, Media OS and Insights — marketing workstations only, and campaign approval stays Master-only. Accounts are issued by the Master in Work Time Account Access, or created PENDING by the public application on this page and activated when the Master issues the account\'s Speedy Verify code; sign-in runs the full pipeline (password or office temporary password → Speedy Verify code → Layer 2).',
    access: 'Public application page; accounts are Master-issued or Master-activated (pending until then)',
    actions: ['Apply for an Ad Specialist account', 'Master: issue an Ad Specialist account in Work Time Account Access', 'Master: activate a pending application by issuing its Speedy Verify code'],
    related: ['marketing-os', 'ad-studio', 'page-studio', 'work-time'],
    keywords: ['ad specialist', 'ad specialists', 'advertising specialist', 'marketing account', 'run ads', 'google ads specialist', 'facebook ads specialist', 'seo specialist', 'apply'],
  },

  /* -------------------------------- Training -------------------------------- */
  {
    id: 'academy',
    name: 'Training Academy',
    group: 'Training',
    location: 'topspeedserviceos.com/academy',
    url: '/academy',
    purpose: 'The staff university: 29 training modules in 8 role tracks, the System Navigator course (modules 30–38, generated from this same system map), Speedy Class, and an AI Specialist coach for every department. Every staff role and provider trainees enter as learners; Media OS admin stays separate.',
    access: 'All staff + provider trainees (PROVIDER_TECH, PROVIDER_OWNER, TECHNICIAN, MARKETING_MANAGER, AD_SPECIALIST)',
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
    purpose: 'Pepper Lists It by Top Speed OS — exactly three purposes (Ramone, 2026-11-17; supersedes the 2026-11-16 two-category rule). Purpose 1, Pepper Lists Sell: individuals list from a photo through Speedy chat or the camera platform; businesses use the Advertise lane. Purpose 2, Pepper Lists Post: social media + search directories through Channel Connections, plus the Reviews wall — reviews, repair photos and videos, surveys and comment threads. Purpose 3, Pepper Lists Book: booking appliance services with Speedy AI and Top Speed Service OS — the classic web form first, Speedy AI booking below it, the summary-confirm gate, Track My Tech and my bookings.',
    access: 'Public + signed-in customers; staff moderate via Book OS',
    actions: ['List an item from a photo (Sell)', 'Connect social + directory channels and post reviews (Post)', 'Book a service / Track My Tech (Book)', 'Businesses: open the Advertise lane'],
    related: ['review-moderation', 'advertiser-console'],
    keywords: ['pepper lists', 'pepperlists', 'pepper lists it', 'sell purpose', 'post purpose', 'book purpose', 'three purposes', 'listings', 'reviews wall', 'search directories'],
  },
  {
    id: 'pepper-lists-channels',
    name: 'Pepper Lists Channel Connections',
    group: 'Pepper Lists',
    location: 'pepperlists.com — signed-in seller account → Channel Connections (explained publicly at pepperlists.com/how-it-works)',
    url: 'https://www.pepperlists.com',
    purpose: 'Where Pepper Lists sellers connect the channels they sell and post on: SELL — Facebook Marketplace, Google Shopping, eBay, Etsy, Walmart; POST — TikTok, Facebook, YouTube, Instagram, X, LinkedIn, plus the search directories (Google Business Profile, Bing Places, and a general search-directories request — added 2026-11-17 with the three-purpose consolidation; the directory listings always belong to the seller, who claims/verifies them with Google/Microsoft directly). Phase 1 (2026-11-17) is the registry + request workflow: a connect files a PENDING request the office completes on the platform side (the Advertiser Console pattern), each channel shows its real prerequisite, and a row reads CONNECTED only after a real completed flow — no third-party tokens are stored. Sellers can also grant the Muse agent (Pepper) per-channel access (default off, revocable, every change in the SellerChannelAudit log). Per-channel sync/posting engines are Phase 2.',
    access: 'Signed-in Pepper Lists sellers (own connections only); office oversight is a read-only staff API view (statuses + labels, no token material)',
    actions: ['Request a channel connection from your account', 'Grant or revoke Muse-agent access per channel', 'Disconnect a channel (clears the grant too)', 'Office: read connection statuses + audit trail in the oversight view'],
    related: ['pepper-lists', 'advertiser-console'],
    keywords: ['channel connections', 'pepper lists channels', 'connect facebook', 'marketplace connection', 'seller channels', 'agent access grant', 'ebay', 'etsy', 'walmart', 'google shopping', 'tiktok', 'google business profile', 'bing places', 'search directories', 'local listings'],
  },
  {
    id: 'review-moderation',
    name: 'Review Moderation Queue',
    group: 'Pepper Lists',
    location: 'Book OS → Pepper Lists reviews panel (topspeedserviceos.com/book-os)',
    url: '/book-os',
    purpose: 'Where the office handles Pepper Lists reviews: positive reviews publish immediately, but flagged or low-rating reviews wait PENDING (and escalated ones flagged) in this queue. Staff publish, hide, or send the office reply ("Top Speed Appliance — Office"). Ratings only ever come from real reviews of real completed jobs.',
    access: 'All staff',
    accessLabel: 'STAFF ONLY',
    accessRoles: ['DISPATCHER', 'COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'],
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
    accessLabel: 'STAFF ONLY',
    accessRoles: ['DISPATCHER', 'COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'],
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
    id: 'tech',
    name: 'Tech App — Company Tech',
    group: 'Network & Referrals',
    location: 'topspeedserviceos.com/tech',
    url: '/tech',
    purpose: 'The Company Tech door of the Tech App: office-issued accounts for Top Speed’s own technicians — their own jobs, stages and field work, feeding the one Service Setters dispatch pipeline.',
    access: 'Company technicians (office-issued accounts); staff oversee',
    actions: ['Work assigned jobs', 'Advance job stages in the field'],
    related: ['speedy-pro', 'dispatch-dashboard', 'track-console'],
    keywords: ['tech app', 'company tech', 'field pro', 'technician door', 'my jobs'],
  },
  {
    id: 'tech-network',
    name: 'Network Tech',
    group: 'Network & Referrals',
    location: 'topspeedserviceos.com/tech-network',
    url: '/tech-network',
    purpose: 'The Network Tech door of the Tech App: independent providers who applied to join work their offered and assigned jobs here — the same one Service Setters dispatch pipeline.',
    access: 'Network providers (PROVIDER_TECH, PROVIDER_OWNER); staff oversee',
    actions: ['Receive and accept job offers', 'Work assigned network jobs'],
    related: ['speedy-pro', 'provider-join', 'dispatch-dashboard'],
    keywords: ['network tech', 'tech network', 'provider door', 'independent providers'],
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
    actions: ['Customer information and booking', '170 landing pages across 104 cities'],
    related: ['flagship', 'book'],
    keywords: ['topspeedappliance.net', '.net', 'dot net', 'customer website', 'landing pages', 'service pages'],
  },
  {
    id: 'cleanout-vents',
    name: 'Cleanout Vents — Partner',
    group: 'Customer Surfaces',
    location: 'topspeedserviceos.com/cleanout-vents-site · cleanoutvents.com',
    url: '/cleanout-vents-site',
    purpose: 'The registered dryer-vent partner. Top Speed never books vent cleaning and never quotes a vent price: route customers to Cleanout Vents at 844-460-7038. Their standalone site\'s Book Online doors land on the Service OS partner page for instant booking through Speedy chat.',
    access: 'Public; partner',
    actions: ['Route vent-cleaning customers to 844-460-7038', 'Partner page books through Speedy chat'],
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
    note: 'Dryer-vent cleaning is never booked as a Top Speed service — route it to Cleanout Vents at 844-460-7038.',
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
    note: 'The published set today is 170 landing pages across 65 tri-county cities — say "170 landing pages" and "104 cities", never "131 cities".',
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
      'Understand what still works: Speedy keeps answering from its 82-entry knowledge base (site, glossary, industry) — questions get grounded answers. What does NOT work on fallback: live AI chat quality, photo diagnosis, plate reads, and chat bookings (the summary card cannot appear, so no chat booking can be sent — point customers to the web form or 844-460-7038).',
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

/* ------------------- Service OS Portal directory -------------------
 * The PUBLIC projection behind GET /navigator/directory, rendered by
 * the Service OS Portal (/portal) as its Platform Directory. The staff
 * map above stays staff-only (it carries purposes, actions and
 * how-tos); this projection ships ONLY the public-safe fields per
 * area — name, group, location, url and an access label — derived
 * from this same file, so the Portal directory can never drift from
 * the system map. The label is the area's own accessLabel where it
 * carries one (the audited CONSOLE_ACCESS mirror); otherwise it is
 * derived from the area's own access string by the conservative rules
 * in directoryAccessLabel() — the same label vocabulary, never a
 * weaker claim than the real gate. */
function directoryAccessLabel(area) {
  if (area.accessLabel) return area.accessLabel;
  const access = String(area.access || '');
  if (/master only/i.test(access) || /^master\b/i.test(access)) return 'OWNER ONLY';
  if (/public application/i.test(access)) return 'PUBLIC APPLICATION';
  if (/^signed-in pepper lists sellers/i.test(access)) return 'SELLER ACCOUNT';
  if (/^all staff \+ provider/i.test(access)) return 'STAFF & PROVIDERS';
  if (/^public/i.test(access)) return 'PUBLIC';
  if (/^customers$/i.test(access.trim())) return 'CUSTOMER ACCOUNT';
  if (/business login/i.test(access)) return 'BUSINESS LOGIN';
  if (/^advertiser/i.test(access)) return 'ADVERTISER ACCOUNT';
  if (/^every account holder/i.test(access) || /^everyone who signs in/i.test(access)) return 'ALL ACCOUNTS';
  if (/^partner/i.test(access)) return 'PARTNER';
  if (/^providers/i.test(access)) return 'PROVIDERS';
  if (/staff/i.test(access)) return 'STAFF ONLY';
  return null;
}

export function portalDirectoryPayload() {
  return {
    areas: SYSTEM_MAP_AREAS.map((area) => ({
      id: area.id,
      name: area.name,
      group: area.group,
      location: area.location,
      url: area.url,
      accessLabel: directoryAccessLabel(area),
    })),
    counts: { areas: SYSTEM_MAP_AREAS.length },
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
