import { randomBytes, randomUUID } from 'node:crypto';
import { persistPlatformEvent } from '../db/platformEventsRepo.js';

export const PLATFORM_COMPANY_ID = '10000000-0000-4000-8000-000000000001';

const providerCompanies = {
  alpha: '20000000-0000-4000-8000-000000000001',
  beta: '20000000-0000-4000-8000-000000000002',
  gamma: '20000000-0000-4000-8000-000000000003',
  // Vendor partner (2026-11-14): Cleanout Vents — see
  // data/networkPartners.js for the canonical seed spec.
  delta: '20000000-0000-4000-8000-000000000004',
};

export const store = {
  // Accounts for the login system (routes/auth.js). Mirrors the Prisma User
  // model: id, companyId, email, passwordHash, names, phone, roles, active.
  // Unique per (companyId, email) — enforced in the auth service.
  users: new Map(),
  customers: new Map(),
  bookings: new Map(),
  dispatchAssignments: new Map(),
  // Track My Tech secure tracking links, keyed by token SHA-256 hash.
  trackingTokens: new Map(),
  // Super Apps sign-in handoffs (skeleton-mode fallback; the database
  // mode uses the AuthHandoff table). Keyed by token SHA-256 hash.
  authHandoffs: new Map(),
  // Multi-account cross-host session handoffs (skeleton-mode fallback;
  // the database mode uses the SessionHandoff table). Keyed by code
  // SHA-256 hash, same discipline as authHandoffs.
  sessionHandoffs: new Map(),
  // Identity & payments trust (2026-11-20, Wave 3 F2/F3/F5):
  // skeleton-mode fallbacks for the PasskeyCredential /
  // PasskeyChallenge / UserSession / StoredCard tables. Passkey maps
  // are keyed by credentialId / challenge; sessions by session id;
  // stored cards by userId.
  passkeyCredentials: new Map(),
  passkeyChallenges: new Map(),
  userSessions: new Map(),
  storedCards: new Map(),
  // Email verification tokens (skeleton-mode fallback; the database
  // mode uses the EmailVerificationToken table). Keyed by token
  // SHA-256 hash, same discipline as authHandoffs.
  emailVerificationTokens: new Map(),
  // Password reset tokens (skeleton-mode fallback; the database mode
  // uses the PasswordResetToken table). Keyed by token SHA-256 hash,
  // same discipline as emailVerificationTokens.
  passwordResetTokens: new Map(),
  // Email sign-in link tokens (skeleton-mode fallback; the database
  // mode uses the EmailSignInToken table). Keyed by token SHA-256
  // hash, same discipline as passwordResetTokens.
  emailSignInTokens: new Map(),
  // Ads OS connect codes (skeleton-mode fallback; the database
  // mode uses the AdsOsConnectCode table). Keyed by code SHA-256
  // hash, same discipline as emailSignInTokens.
  adsOsConnectCodes: new Map(),
  // Username (email) change tokens (skeleton-mode fallback; the
  // database mode uses the EmailChangeToken table). Keyed by token
  // SHA-256 hash, same discipline as passwordResetTokens.
  emailChangeTokens: new Map(),
  // Web Push subscriptions for the customer app (2026-11-20):
  // per-device/browser opt-ins for booking updates, keyed by
  // subscription id; hydrated from the PushSubscription table via
  // db/pushSubscriptionsRepo. A record with revokedAt set is never
  // sent to again.
  pushSubscriptions: new Map(),
  // Estimate approval link tokens (skeleton-mode fallback; the
  // database mode uses the EstimateApprovalToken table). Keyed by
  // token SHA-256 hash, same discipline as emailChangeTokens.
  estimateApprovalTokens: new Map(),
  // Web Push subscriptions for the customer app (2026-11-20):
  // per-device/browser opt-ins for booking updates, keyed by
  // subscription id; hydrated from the PushSubscription table via
  // db/pushSubscriptionsRepo. A record with revokedAt set is never
  // sent to again.
  pushSubscriptions: new Map(),
  // Speedy Verify access codes (skeleton-mode fallback; the database
  // mode uses the SpeedyVerifyCode table). Keyed by userId; the record
  // holds only the scrypt hash of the code, never the plain code.
  speedyVerifyCodes: new Map(),
  // Layer 2 — 2-step sign-in challenges (skeleton-mode fallback; the
  // database mode uses the LoginChallenge table). Keyed by challenge
  // id; the record holds only the scrypt hash of the 6-digit code,
  // never the plain code.
  loginChallenges: new Map(),
  // Legal gate: signed TermsAcceptance rows in skeleton mode (the
  // database mode uses the TermsAcceptance table). Plain array of
  // { id, userId, document, version, signatureName, acceptedAt }.
  termsAcceptances: [],
  // Connection layer: records that arrive through the universal intake
  // (provider applications and property-manager leads are not bookings).
  providerApplications: new Map(),
  pmLeads: new Map(),
  // Flywheel: referral codes issued to customers when a job completes.
  // One active code per customer; redemptions link new bookings back to it.
  referrals: new Map(),
  // ApplianceReferral rewards program (Phase 1): per-friend lifecycle
  // journeys, issued reward credits, and per-company program settings
  // (Map keyed by companyId; a missing entry means the all-null-amount
  // defaults in services/referrals.js). Hydrated from the Referral*
  // tables via db/referralsRepo.
  referralJourneys: [],
  referralCredits: [],
  referralSettings: new Map(),
  // Service Setters capacity settings (2026-11-17): per-company
  // planning inputs for the daily booking ceiling (buffer %, minutes
  // per job, working hours per tech), keyed by companyId. A missing
  // entry means the blueprint defaults in services/dispatchOps.js.
  // Hydrated from the DispatchSetting table via db/dispatchOpsRepo.
  dispatchSettings: new Map(),
  // Speedy Live Video: consultation requests and their rooms.
  videoRequests: new Map(),
  payments: new Map(),
  // Commercial: business accounts, their facilities, the equipment
  // registry at each facility, and commercial work orders. A work order
  // also creates a linked residential-pipeline booking (source
  // COMMERCIAL) so Service Setters work one queue and one board.
  commercialAccounts: new Map(),
  commercialFacilities: new Map(),
  commercialEquipment: new Map(),
  commercialWorkOrders: new Map(),
  // Commercial recurring revenue (2026-11-20, B7/B8): maintenance
  // agreements (scheduled preventive visits that generate commercial
  // work orders on cadence) and structured commercial quotes with
  // approve-by-link. Same in-memory discipline as the rest of the
  // commercial module; quote approval tokens are stored HASH-ONLY
  // (the email-change token idiom) keyed by token hash.
  maintenanceAgreements: new Map(),
  commercialQuotes: new Map(),
  commercialQuoteTokens: new Map(),
  // App distribution: PWA install + download-page attribution events
  // recorded by POST /app/track-download. Feeds the flywheel metrics
  // (appInstalls) so Ramone can see which surface (src=flyer, src=qr-…)
  // produced an install. Store listings are NOT tracked here — the app
  // is not published to Apple/Google yet (see routes/app.js).
  appInstalls: [],
  // Notification outbox: every email/SMS alert and update on the
  // platform, hydrated from the NotificationOutbox table.
  notificationOutbox: [],
  // Notification settings (staff toggles). null = not hydrated yet;
  // services/notifications.js merges over ALL-ON defaults.
  notificationSettings: null,
  // Public web intake records (forms + Speedy-assisted flows), hydrated from the Connection table.
  connections: [],
  // Top Speed CRM staff notes on customer records (CrmNote table),
  // newest appended last; the CRM 360 sorts when it renders.
  crmNotes: [],
  // Book OS Inbox: inbound email received via the Resend webhook plus
  // staff replies sent back out (InboxMessage table), oldest appended
  // first; the inbox queue and the CRM 360 sort when they render.
  inboxMessages: [],
  // Setter–customer message threads (MessageThread / ThreadMessage
  // tables): the two-way conversation behind the Book OS + CRM
  // composer — staff SMS/email, appointment reminders, and customer
  // replies. Oldest appended first; the consoles sort when rendering.
  messageThreads: [],
  threadMessages: [],
  // Speedy chat capture: every customer conversation with Speedy,
  // keyed by session id; messages ride inside the session record
  // (oldest first), mirroring the booking-history pattern. Hydrated
  // from the SpeedyChatSession / SpeedyChatMessage tables.
  chatSessions: new Map(),
  // Message the office (2026-11-20, B2): per-booking human threads
  // between the customer (/app) and staff (Chats console), oldest
  // appended first; hydrated from the BookingMessage table via
  // db/bookingMessagesRepo. This is THE thread store — the Wave 1
  // D1 setter composer converges on these same rows when it lands.
  bookingMessages: [],
  // Appliance Connect garage (per signed-in customer), hydrated from CustomerAppliance.
  appliances: new Map(),
  // Connected-appliance registry (per garage appliance), hydrated
  // from ApplianceConnection. REGISTERED records consent only — no
  // manufacturer link exists until a brand integration lands.
  applianceConnections: new Map(),
  // Advertiser banner creatives, hydrated from the Banner table.
  banners: [],
  // Top Speed Marketing OS (agency, Phase 1): §3 taxonomy + Page Studio
  // landing pages and their version snapshots, hydrated from the
  // Marketing* / LandingPage / PageVersion tables.
  // Parts Supply OS: suppliers, parts inventory, purchase orders and
  // per-job parts usage, hydrated from the Supplier / Part /
  // PurchaseOrder(+Line) / PartUsage tables.
  suppliers: [],
  parts: [],
  purchaseOrders: [],
  partUsages: [],
  // Tech Pro van stock (2026-11-17): per-provider on-van quantities,
  // hydrated from the VanStock table alongside the rest of Parts OS.
  vanStock: [],
  // Tech App dispatch package (2026-11-19): customer service properties
  // (Property table), first-class warranty claims (WarrantyClaim table)
  // and job invoices (the Invoice table — it existed without a creation
  // path; the Tech App's approved-estimate → invoice flow is that path).
  // Hydrated from their tables via db/techPackageRepo.
  properties: [],
  warranties: [],
  warrantyClaims: [],
  invoices: [],
  // QuickBooks finance integration (built dark): connection state +
  // synced snapshots + invoice mirror, hydrated from the Finance*
  // tables. financeConnection stays null until the first real sync —
  // null IS the honest not_connected state.
  financeConnection: null,
  financeSnapshots: [],
  financeInvoices: [],
  // Multi-account Google manager registry (Marketing OS): one record
  // per Gmail account in the structure — email, label, role, lifecycle
  // status (INVITED / ACTIVE / REVOKED) and its structured Google
  // assets — hydrated from the GoogleAccountLink table via
  // db/googleAccountsRepo. A registry only: statuses are updated by a
  // human after Google confirms; nothing auto-flips.
  googleAccountLinks: [],
  // Top Speed Media OS — Phase 1 (2026-11-14): the content library and
  // its asset/rights registry, hydrated from the MediaContent /
  // MediaAsset tables via db/mediaOsRepo. An add-on like the Google
  // account registry: a missing table mid-deploy degrades to an empty
  // library, never blocks hydration.
  mediaContent: [],
  mediaAssets: [],
  // Before/after video factory (2026-11-20, E9): rendered MP4 bytes
  // for factory-generated MediaContent, keyed by contentId. Hydrated
  // lazily from the MediaVideoBlob table via db/videoFactoryRepo (the
  // bytes are only ever read through the factory's byte route, so
  // boot hydration skips them); a missing table degrades to empty.
  mediaVideoBlobs: new Map(),
  // Call recordings + transcripts (2026-11-20, D8 — ships dark):
  // hydrated from the CallRecording table via db/callRecordingsRepo.
  // Rows can only exist when CALL_RECORDING_ENABLED was on for a
  // call; with the flag off this stays empty forever.
  callRecordings: [],
  // Ad Studio (2026-11-14): the in-house advertising system — campaigns
  // built from Media OS creatives, run on the platform's own surfaces,
  // approved by the owner. Hydrated from the AdCampaign table via
  // db/adStudioRepo; degrades to an empty list like the Media OS.
  adCampaigns: [],
  // Advertiser creative uploads (2026-11-20, E3): metadata working
  // set for the AdvertiserCreative table via db/advertiserCreativesRepo
  // (bytes are fetched through the repo, never held in the list rows);
  // degrades to an empty list like the rest.
  advertiserCreatives: [],
  // Management department reports (2026-11-14): every feature request
  // on every platform, routed to its head department for management to
  // read + acknowledge. Hydrated from the DepartmentReport table via
  // db/managementReportsRepo; degrades to an empty list like the rest.
  departmentReports: [],
  marketingCities: [],
  marketingBrands: [],
  marketingServices: [],
  marketingSymptoms: [],
  landingPages: [],
  pageVersions: [],
  // Page Studio A/B tests (2026-11-20, E4): PageExperiment rows via
  // db/marketingOsRepo (loaded inside hydrateMarketingOs); degrades to
  // an empty list like the rest.
  pageExperiments: [],
  // Academy completions (2026-11-20, D12): one record per curriculum
  // module a trainee completed, hydrated from the AcademyCompletion
  // table via db/academyRepo. Certifications are derived from these
  // rows (services/academyCerts.js), never stored separately.
  academyCompletions: [],
  // Single operational event feed connecting every surface.
  events: [],
  providers: [
    {
      // Score reset (Ramone, 2026-11-16): ratings are never seeded.
      // Every provider starts at null ("no rating yet") and earns a
      // rating only from real reviews of real completed jobs — the
      // same honest state Cleanout Vents below has always had.
      id: '30000000-0000-4000-8000-000000000001',
      companyId: providerCompanies.alpha,
      businessName: 'Broward Rapid Refrigeration',
      type: 'NETWORK_BUSINESS',
      specialties: ['Refrigerator', 'Freezer / Ice Maker'],
      serviceCities: ['Sunrise', 'Plantation', 'Fort Lauderdale', 'Lauderhill', 'Tamarac', 'Davie'],
      rating: null,
      active: true,
    },
    {
      id: '30000000-0000-4000-8000-000000000002',
      companyId: providerCompanies.beta,
      businessName: 'Plantation Home Appliance Pros',
      type: 'NETWORK_BUSINESS',
      specialties: ['Washer', 'Dryer', 'Dishwasher'],
      serviceCities: ['Plantation', 'Sunrise', 'Davie', 'Coral Springs', 'Fort Lauderdale'],
      rating: null,
      active: true,
    },
    {
      id: '30000000-0000-4000-8000-000000000003',
      companyId: providerCompanies.gamma,
      businessName: 'Top Speed Field Team',
      // Two tech systems (2026-11-19): Top Speed's own crew — the
      // Company Tech door. Every other provider is Service Network.
      companyCrew: true,
      type: 'INDEPENDENT_PROVIDER',
      specialties: ['Refrigerator', 'Washer', 'Dryer', 'Oven / Range', 'Dishwasher', 'Freezer / Ice Maker', 'Microwave', 'Garbage Disposal', 'Installation'],
      serviceCities: ['Lauderhill', 'Plantation', 'Sunrise', 'Tamarac', 'Fort Lauderdale', 'Lauderdale Lakes', 'North Lauderdale', 'Davie', 'Coral Springs', 'Pompano Beach', 'Oakland Park', 'Margate'],
      rating: null,
      active: true,
    },
    {
      // Cleanout Vents — vendor partner business (dryer vent cleaning),
      // Broward County. No rating exists for it (null, never invented)
      // and no vent-cleaning prices exist anywhere. Its specialties are
      // not appliance services, so the dispatch matcher never proposes
      // it for appliance bookings; vent work routes via Service Setters.
      id: '30000000-0000-4000-8000-000000000004',
      companyId: providerCompanies.delta,
      businessName: 'Cleanout Vents',
      type: 'NETWORK_BUSINESS',
      specialties: ['Dryer Vent Cleaning', 'Full Vent Line Cleanout', 'Lint & Airflow Inspection'],
      serviceCities: ['Lauderhill', 'Plantation', 'Sunrise', 'Tamarac', 'Fort Lauderdale', 'Lauderdale Lakes', 'North Lauderdale', 'Davie', 'Coral Springs', 'Pompano Beach', 'Oakland Park', 'Margate', 'Hollywood', 'Pembroke Pines', 'Miramar', 'Deerfield Beach', 'Coconut Creek', 'Dania Beach', 'Cooper City', 'Weston', 'Parkland', 'Hallandale Beach', 'Wilton Manors', 'Lighthouse Point', 'Lauderdale-by-the-Sea', 'Southwest Ranches', 'West Park', 'Pembroke Park', 'Hillsboro Beach', 'Sea Ranch Lakes', 'Lazy Lake'],
      rating: null,
      active: true,
    },
  ],
};

export function createId() {
  return randomUUID();
}

export function addBookingEvent(booking, type, actor, details = {}) {
  booking.history.push({
    type,
    actor,
    at: new Date().toISOString(),
    ...details,
  });
}

/**
 * Human-facing reference code returned to every surface on intake
 * (e.g. TS-7K2QX9). The customer/applicant can quote it on a call and
 * staff can find the record by it.
 */
export function createReferenceCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(6);
  let suffix = '';
  for (const byte of bytes) suffix += alphabet[byte % alphabet.length];
  return `TS-${suffix}`;
}

/**
 * Referral code handed to a customer when their job is completed
 * (e.g. TS-REF-7K2Q). Customers read it to a neighbor; the neighbor's
 * booking is created through the flywheel redeem endpoint and linked back.
 */
export function createReferralCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(4);
  let suffix = '';
  for (const byte of bytes) suffix += alphabet[byte % alphabet.length];
  return `TS-REF-${suffix}`;
}

function prefixedCode(prefix) {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(4);
  let suffix = '';
  for (const byte of bytes) suffix += alphabet[byte % alphabet.length];
  return `${prefix}-${suffix}`;
}

/** Commercial account reference (e.g. TS-C-7K2Q), quoted on agreements. */
export function createCommercialAccountCode() {
  return prefixedCode('TS-C');
}

/** Equipment asset tag (e.g. TS-EQ-7K2Q), printed on the unit's label. */
export function createAssetTag() {
  return prefixedCode('TS-EQ');
}

/** Commercial work-order reference (e.g. TS-W-7K2Q). */
export function createWorkOrderCode() {
  return prefixedCode('TS-W');
}

/** Maintenance agreement reference (e.g. TS-MA-7K2Q), quoted on generated visits. */
export function createMaintenanceAgreementCode() {
  return prefixedCode('TS-MA');
}

/** Commercial quote reference (e.g. TS-Q-7K2Q), quoted on the approval link. */
export function createCommercialQuoteCode() {
  return prefixedCode('TS-Q');
}

/**
 * Append to the platform-wide operational event feed. Every intake and
 * every booking lifecycle change lands here so all surfaces share one
 * timeline (GET /api/v1/platform/events).
 *
 * Platform Interconnect (2026-11-19): the same event is also written
 * through to the durable PlatformEvent table (db/platformEventsRepo)
 * at this — the feed's single write point — so the timeline survives
 * serverless instance turnover. Callers call appendEvent at the same
 * success points; there is one write per event, never two.
 *
 * Race fix (2026-11-19): appendEvent is async and AWAITS the durable
 * write, so when an appendEvent call completes the event is readable
 * from the durable feed — an immediate GET /platform/events can no
 * longer miss it. The persist stays fail-soft (persistPlatformEvent
 * never rejects), so awaiting it cannot fail the flow that produced
 * the event. The few synchronous helpers that cannot await (the
 * notification queue, referral-code issue, Speedy governance log)
 * still call it un-awaited: their in-memory copies update
 * synchronously and the durable write is initiated immediately,
 * exactly as before.
 */
export async function appendEvent(type, { source = null, actor = null, entityType = null, entityId = null, referenceCode = null, details = {} } = {}) {
  const event = {
    id: createId(),
    type,
    source,
    actor,
    entityType,
    entityId,
    referenceCode,
    at: new Date().toISOString(),
    details,
  };
  store.events.push(event);
  await persistPlatformEvent(event);
  return event;
}
