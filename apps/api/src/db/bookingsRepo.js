import { DATABASE_ENABLED, db } from './client.js';
import { store } from '../data/store.js';
import { SERVICE_CITIES } from '../config/serviceAreas.js';
import { hydrateCrmNotes } from './crmRepo.js';
import { hydrateChatSessions } from './chatsRepo.js';
import { attributionFromColumns, attributionToColumns } from '../services/attribution.js';
import { hydrateFlywheel } from './flywheelRepo.js';
import { hydrateVideoRequests } from './videoRepo.js';
import { hydratePayments } from './paymentsRepo.js';
import { hydrateConnections } from './connectionsRepo.js';
import { hydrateAppliances } from './appliancesRepo.js';
import { hydrateBanners } from './bannersRepo.js';
import { hydrateTrackingTokens } from './trackingRepo.js';
import { hydrateMarketingOs } from './marketingOsRepo.js';
import { hydrateParts } from './partsRepo.js';
import { hydrateFinance } from './financeRepo.js';
import { hydrateNotificationSettings } from './notificationsRepo.js';
import { hydrateReferrals } from './referralsRepo.js';
import { hydrateGoogleAccounts } from './googleAccountsRepo.js';

/**
 * Bookings persistence for the Service OS (database mode).
 *
 * The API's services work on rich in-memory booking objects (embedded
 * customer, dispatch state, appointment, event history). This repository is
 * the bridge to PostgreSQL:
 *
 *  - hydrateStore() loads providers, customers, bookings, and dispatch
 *    assignments from the database into the working store at startup, in
 *    exactly the shapes the services already use.
 *  - persist*() write-through upserts are called by the mutating routes so
 *    every create / match / approve / complete / appointment change lands
 *    in the database before the response goes out.
 *
 * The relational core (Customer, ServiceRequest status + fee,
 * DispatchAssignment) is stored in real columns and tables; the booking's
 * history, dispatch state, and appointment ride in JSON columns on
 * ServiceRequest (see the booking_working_state migration).
 *
 * Every function is a no-op when DATABASE_URL is not set (skeleton mode).
 */

const FEE_TO_ENUM = {
  collected_at_booking: 'COLLECTED_AT_BOOKING',
  not_collected: 'NOT_COLLECTED',
  refunded: 'REFUNDED',
};
const FEE_FROM_ENUM = Object.fromEntries(Object.entries(FEE_TO_ENUM).map(([k, v]) => [v, k]));

function num(value) {
  if (value === null || value === undefined) return value;
  return typeof value === 'number' ? value : Number(value);
}

function customerToRow(record) {
  return {
    id: record.id,
    companyId: record.companyId,
    userId: record.userId ?? null,
    source: record.source ?? null,
    referredByCode: record.referredByCode ?? null,
    name: record.name,
    phone: record.phone ?? '',
    email: record.email ?? null,
    address: record.address ?? null,
    city: record.city ?? '',
    zip: record.zip ?? '',
  };
}

function customerFromRow(row) {
  return {
    id: row.id,
    companyId: row.companyId,
    userId: row.userId ?? undefined,
    source: row.source ?? undefined,
    referredByCode: row.referredByCode ?? undefined,
    name: row.name,
    phone: row.phone,
    email: row.email ?? undefined,
    address: row.address ?? undefined,
    city: row.city,
    zip: row.zip,
    createdAt: row.createdAt?.toISOString?.() ?? row.createdAt,
  };
}

function bookingToRow(booking) {
  return {
    id: booking.id,
    companyId: booking.companyId,
    customerId: booking.customerId,
    city: booking.city,
    zip: booking.zip,
    appliance: booking.appliance,
    issue: booking.issue,
    preferredWindow: booking.preferredWindow ?? null,
    referenceCode: booking.referenceCode ?? null,
    source: booking.source ?? 'WEBSITE',
    ...attributionToColumns(booking.attribution),
    referralCode: booking.referralCode ?? null,
    referredByCustomerId: booking.referredByCustomerId ?? null,
    area: booking.area ?? null,
    areaStatus: booking.areaStatus ?? 'IN_AREA',
    serviceAddress: booking.serviceAddress ?? null,
    history: booking.history ?? [],
    dispatch: booking.dispatch ?? null,
    appointment: booking.appointment ?? null,
    completedAt: booking.completedAt ? new Date(booking.completedAt) : null,
    completedBy: booking.completedBy ?? null,
    status: booking.status,
    diagnosticFee: booking.diagnosticFee ?? 99,
    diagnosticFeeCreditedTowardRepair: booking.diagnosticFeeCreditedTowardRepair ?? true,
    feeStatus: FEE_TO_ENUM[booking.feeStatus] ?? 'COLLECTED_AT_BOOKING',
  };
}

function bookingFromRow(row, customerRecord) {
  const attribution = attributionFromColumns(row);
  return {
    id: row.id,
    companyId: row.companyId,
    customerId: row.customerId,
    customer: customerRecord,
    referenceCode: row.referenceCode,
    source: row.source,
    ...(attribution ? { attribution } : {}),
    referralCode: row.referralCode ?? null,
    referredByCustomerId: row.referredByCustomerId ?? null,
    // Service Book area model: rows written before the area columns
    // existed carry no area — derive it from the city so every surface
    // (queue, board, capacity) sees one consistent area per booking.
    area: row.area ?? (SERVICE_CITIES.includes(row.city) ? row.city : null),
    areaStatus: row.areaStatus ?? (SERVICE_CITIES.includes(row.city) ? 'IN_AREA' : 'OUT_OF_AREA'),
    serviceAddress: row.serviceAddress ?? null,
    city: row.city,
    zip: row.zip,
    appliance: row.appliance,
    issue: row.issue,
    preferredWindow: row.preferredWindow ?? null,
    diagnosticFee: num(row.diagnosticFee) ?? 99,
    diagnosticFeeCurrency: 'USD',
    diagnosticFeeCreditedTowardRepair: row.diagnosticFeeCreditedTowardRepair,
    feeStatus: FEE_FROM_ENUM[row.feeStatus] ?? 'collected_at_booking',
    status: row.status,
    dispatch: row.dispatch ?? { mode: 'HYBRID', stage: 'AWAITING_MATCH', candidateProviderIds: [], assignmentIds: [] },
    appointment: row.appointment ?? undefined,
    history: Array.isArray(row.history) ? row.history : [],
    completedAt: row.completedAt?.toISOString?.() ?? undefined,
    completedBy: row.completedBy ?? undefined,
    createdAt: row.createdAt?.toISOString?.() ?? row.createdAt,
    updatedAt: row.updatedAt?.toISOString?.() ?? row.updatedAt,
  };
}

function assignmentToRow(assignment) {
  return {
    id: assignment.id,
    companyId: assignment.companyId,
    serviceRequestId: assignment.bookingId,
    providerId: assignment.providerId,
    providerCompanyId: assignment.providerCompanyId ?? null,
    status: assignment.status,
    dispatchMode: assignment.dispatchMode ?? 'HYBRID',
    approvalRequired: assignment.approvalRequired ?? true,
    matchScore: assignment.matchScore ?? null,
    approvedByName: assignment.approvedBy ?? null,
    approvedAt: assignment.approvedAt ? new Date(assignment.approvedAt) : null,
    lastLat: assignment.lastLat ?? null,
    lastLng: assignment.lastLng ?? null,
    lastLocationAt: assignment.lastLocationAt ? new Date(assignment.lastLocationAt) : null,
  };
}

function assignmentFromRow(row) {
  return {
    id: row.id,
    companyId: row.companyId,
    bookingId: row.serviceRequestId,
    providerId: row.providerId,
    providerCompanyId: row.providerCompanyId ?? undefined,
    status: row.status,
    dispatchMode: row.dispatchMode,
    approvalRequired: row.approvalRequired,
    matchScore: row.matchScore ?? undefined,
    createdAt: row.createdAt?.toISOString?.() ?? row.createdAt,
    approvedBy: row.approvedByName ?? null,
    approvedAt: row.approvedAt?.toISOString?.() ?? null,
    lastLat: row.lastLat ?? undefined,
    lastLng: row.lastLng ?? undefined,
    lastLocationAt: row.lastLocationAt?.toISOString?.() ?? null,
  };
}

export async function hydrateStore() {
  if (!DATABASE_ENABLED) return { skipped: true };
  const prisma = db();

  const providerRows = await prisma.provider.findMany();
  store.providers.length = 0;
  for (const row of providerRows) {
    store.providers.push({
      id: row.id,
      companyId: row.companyId,
      businessName: row.businessName,
      type: row.type,
      specialties: row.specialties,
      serviceCities: row.serviceCities,
      rating: num(row.rating),
      active: row.active,
    });
  }

  const customerRows = await prisma.customer.findMany();
  const customersById = new Map();
  for (const row of customerRows) {
    const record = customerFromRow(row);
    customersById.set(record.id, record);
    store.customers.set(record.id, record);
  }

  const bookingRows = await prisma.serviceRequest.findMany();
  for (const row of bookingRows) {
    const booking = bookingFromRow(row, customersById.get(row.customerId));
    store.bookings.set(booking.id, booking);
  }

  const assignmentRows = await prisma.dispatchAssignment.findMany();
  for (const row of assignmentRows) {
    const assignment = assignmentFromRow(row);
    store.dispatchAssignments.set(assignment.id, assignment);
  }

  const flywheel = await hydrateFlywheel();
  const video = await hydrateVideoRequests();
  await hydratePayments();
  await hydrateConnections();
  await hydrateAppliances();
  await hydrateBanners();
  await hydrateTrackingTokens();
  // Marketing OS is an add-on module: if its tables are ever unavailable
  // (e.g. mid-deploy before its migration lands), the rest of the
  // platform must still hydrate and serve. Degrade to an empty module.
  try {
    await hydrateMarketingOs();
  } catch (error) {
    console.error('hydrateMarketingOs failed (module degraded, platform continues)', error?.message || error);
  }
  // Parts Supply OS + QuickBooks finance are add-on modules too: a
  // missing table mid-deploy must degrade the module, never the platform.
  try {
    await hydrateParts();
  } catch (error) {
    console.error('hydrateParts failed (module degraded, platform continues)', error?.message || error);
  }
  try {
    await hydrateFinance();
  } catch (error) {
    console.error('hydrateFinance failed (module degraded, platform continues)', error?.message || error);
  }
  // Notification settings are an add-on too: missing table mid-deploy
  // degrades to the ALL-ON defaults, never blocks hydration.
  try {
    await hydrateNotificationSettings();
  } catch (error) {
    console.error('hydrateNotificationSettings failed (defaults apply, platform continues)', error?.message || error);
  }
  // ApplianceReferral program is an add-on module too: a missing table
  // mid-deploy degrades to empty journeys/credits and default (unset)
  // settings, never blocks hydration.
  let referralProgram = { journeys: 0, credits: 0, settings: 0 };
  try {
    referralProgram = await hydrateReferrals();
  } catch (error) {
    console.error('hydrateReferrals failed (referral program degraded, platform continues)', error?.message || error);
  }
  // Top Speed CRM notes are an add-on too: a missing CrmNote table
  // mid-deploy degrades to an empty notes list, never blocks hydration.
  try {
    await hydrateCrmNotes();
  } catch (error) {
    console.error('hydrateCrmNotes failed (CRM notes degraded, platform continues)', error?.message || error);
  }
  // Speedy chat capture is an add-on too: a missing chat table
  // mid-deploy degrades to no transcripts, never blocks hydration.
  try {
    await hydrateChatSessions();
  } catch (error) {
    console.error('hydrateChatSessions failed (chat insights degraded, platform continues)', error?.message || error);
  }
  // The Google account registry is an add-on too: a missing table
  // mid-deploy degrades to an empty registry, never blocks hydration.
  try {
    await hydrateGoogleAccounts();
  } catch (error) {
    console.error('hydrateGoogleAccounts failed (Google account registry degraded, platform continues)', error?.message || error);
  }

  return { providers: providerRows.length, customers: customerRows.length, bookings: bookingRows.length, assignments: assignmentRows.length, referrals: flywheel.referrals ?? 0, notifications: flywheel.notifications ?? 0, videoRequests: video.videoRequests ?? 0, referralJourneys: referralProgram.journeys ?? 0, referralCredits: referralProgram.credits ?? 0 };
}

export async function persistCustomer(record) {
  if (!DATABASE_ENABLED || !record?.id) return;
  const row = customerToRow(record);
  await db().customer.upsert({ where: { id: row.id }, update: row, create: row });
}

export async function persistBooking(booking) {
  if (!DATABASE_ENABLED || !booking?.id) return;
  const row = bookingToRow(booking);
  await db().serviceRequest.upsert({ where: { id: row.id }, update: row, create: row });
}

export async function persistAssignment(assignment) {
  if (!DATABASE_ENABLED || !assignment?.id) return;
  const row = assignmentToRow(assignment);
  await db().dispatchAssignment.upsert({ where: { id: row.id }, update: row, create: row });
}

export async function persistAssignmentsForBooking(bookingId) {
  if (!DATABASE_ENABLED) return;
  for (const assignment of store.dispatchAssignments.values()) {
    if (assignment.bookingId === bookingId) await persistAssignment(assignment);
  }
}
