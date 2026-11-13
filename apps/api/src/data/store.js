import { randomBytes, randomUUID } from 'node:crypto';

export const PLATFORM_COMPANY_ID = '10000000-0000-4000-8000-000000000001';

const providerCompanies = {
  alpha: '20000000-0000-4000-8000-000000000001',
  beta: '20000000-0000-4000-8000-000000000002',
  gamma: '20000000-0000-4000-8000-000000000003',
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
  // Email verification tokens (skeleton-mode fallback; the database
  // mode uses the EmailVerificationToken table). Keyed by token
  // SHA-256 hash, same discipline as authHandoffs.
  emailVerificationTokens: new Map(),
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
  // Speedy chat capture: every customer conversation with Speedy,
  // keyed by session id; messages ride inside the session record
  // (oldest first), mirroring the booking-history pattern. Hydrated
  // from the SpeedyChatSession / SpeedyChatMessage tables.
  chatSessions: new Map(),
  // Appliance Connect garage (per signed-in customer), hydrated from CustomerAppliance.
  appliances: new Map(),
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
  // QuickBooks finance integration (built dark): connection state +
  // synced snapshots + invoice mirror, hydrated from the Finance*
  // tables. financeConnection stays null until the first real sync —
  // null IS the honest not_connected state.
  financeConnection: null,
  financeSnapshots: [],
  financeInvoices: [],
  marketingCities: [],
  marketingBrands: [],
  marketingServices: [],
  marketingSymptoms: [],
  landingPages: [],
  pageVersions: [],
  // Single operational event feed connecting every surface.
  events: [],
  providers: [
    {
      id: '30000000-0000-4000-8000-000000000001',
      companyId: providerCompanies.alpha,
      businessName: 'Broward Rapid Refrigeration',
      type: 'NETWORK_BUSINESS',
      specialties: ['Refrigerator', 'Freezer / Ice Maker'],
      serviceCities: ['Sunrise', 'Plantation', 'Fort Lauderdale', 'Lauderhill', 'Tamarac', 'Davie'],
      rating: 4.9,
      active: true,
    },
    {
      id: '30000000-0000-4000-8000-000000000002',
      companyId: providerCompanies.beta,
      businessName: 'Plantation Home Appliance Pros',
      type: 'NETWORK_BUSINESS',
      specialties: ['Washer', 'Dryer', 'Dishwasher'],
      serviceCities: ['Plantation', 'Sunrise', 'Davie', 'Coral Springs', 'Fort Lauderdale'],
      rating: 4.8,
      active: true,
    },
    {
      id: '30000000-0000-4000-8000-000000000003',
      companyId: providerCompanies.gamma,
      businessName: 'Top Speed Field Team',
      type: 'INDEPENDENT_PROVIDER',
      specialties: ['Refrigerator', 'Washer', 'Dryer', 'Oven / Range', 'Dishwasher', 'Freezer / Ice Maker', 'Microwave', 'Garbage Disposal', 'Installation'],
      serviceCities: ['Lauderhill', 'Plantation', 'Sunrise', 'Tamarac', 'Fort Lauderdale', 'Lauderdale Lakes', 'North Lauderdale', 'Davie', 'Coral Springs', 'Pompano Beach', 'Oakland Park', 'Margate'],
      rating: 4.8,
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

/**
 * Append to the platform-wide operational event feed. Every intake and
 * every booking lifecycle change lands here so all surfaces share one
 * timeline (GET /api/v1/platform/events).
 */
export function appendEvent(type, { source = null, actor = null, entityType = null, entityId = null, referenceCode = null, details = {} } = {}) {
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
  return event;
}
