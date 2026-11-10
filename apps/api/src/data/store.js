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
  // Connection layer: records that arrive through the universal intake
  // (provider applications and property-manager leads are not bookings).
  providerApplications: new Map(),
  pmLeads: new Map(),
  // Flywheel: referral codes issued to customers when a job completes.
  // One active code per customer; redemptions link new bookings back to it.
  referrals: new Map(),
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
  // Simulated notification outbox (no real Twilio/Resend sends in Phase 1).
  notificationOutbox: [],
  // Public web intake records (forms + Speedy-assisted flows), hydrated from the Connection table.
  connections: [],
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
