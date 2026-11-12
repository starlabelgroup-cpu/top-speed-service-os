import { DATABASE_ENABLED, db } from './client.js';
import { PLATFORM_COMPANY_ID, store } from '../data/store.js';

/**
 * ApplianceReferral rewards program persistence (Phase 1, 2026-11-12).
 *
 * Same bridge pattern as flywheelRepo / bookingsRepo:
 *  - hydrateReferrals() loads journeys, credits, and program settings
 *    from PostgreSQL into the working store at cold start (called from
 *    bookingsRepo.hydrateStore, in its own try/catch so a missing table
 *    mid-deploy degrades the module, never the platform).
 *  - persist*() write-through upserts run at every mutation point in
 *    services/referrals.js.
 *
 * In-memory shapes mirror the Prisma rows with ISO-string dates, exactly
 * like the other repos. Program settings live in store.referralSettings
 * as a Map keyed by companyId; a missing entry means the defaults in
 * services/referrals.js (program enabled, every amount NULL/unset).
 *
 * Every function is a no-op when DATABASE_URL is not set (skeleton mode).
 */

function iso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function dateOrNull(value) {
  return value ? new Date(value) : null;
}

/* ------------------------------------------------------------------ */
/* Journeys                                                            */
/* ------------------------------------------------------------------ */

function journeyToRow(journey) {
  return {
    id: journey.id,
    companyId: journey.companyId || PLATFORM_COMPANY_ID,
    referralId: journey.referralId,
    code: journey.code,
    referrerCustomerId: journey.referrerCustomerId ?? null,
    refereeName: journey.refereeName ?? null,
    refereePhone: journey.refereePhone ?? null,
    refereeEmail: journey.refereeEmail ?? null,
    bookingId: journey.bookingId ?? null,
    bookingReference: journey.bookingReference ?? null,
    status: journey.status || 'INVITED',
    rewardAmountCents: journey.rewardAmountCents ?? null,
    tierSnapshot: journey.tierSnapshot ?? null,
    staffDecisionBy: journey.staffDecisionBy ?? null,
    staffDecisionAt: dateOrNull(journey.staffDecisionAt),
    staffNote: journey.staffNote ?? null,
  };
}

function journeyFromRow(row) {
  return {
    id: row.id,
    companyId: row.companyId,
    referralId: row.referralId,
    code: row.code,
    referrerCustomerId: row.referrerCustomerId ?? null,
    refereeName: row.refereeName ?? null,
    refereePhone: row.refereePhone ?? null,
    refereeEmail: row.refereeEmail ?? null,
    bookingId: row.bookingId ?? null,
    bookingReference: row.bookingReference ?? null,
    status: row.status,
    rewardAmountCents: row.rewardAmountCents ?? null,
    tierSnapshot: row.tierSnapshot ?? null,
    staffDecisionBy: row.staffDecisionBy ?? null,
    staffDecisionAt: iso(row.staffDecisionAt),
    staffNote: row.staffNote ?? null,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export async function persistReferralJourney(journey) {
  // Keep the store copy's timestamp honest even in skeleton mode.
  journey.updatedAt = new Date().toISOString();
  if (!DATABASE_ENABLED || !journey?.id) return;
  const row = journeyToRow(journey);
  await db().referralJourney.upsert({ where: { id: row.id }, update: row, create: row });
}

/* ------------------------------------------------------------------ */
/* Credits                                                             */
/* ------------------------------------------------------------------ */

function creditToRow(credit) {
  return {
    id: credit.id,
    companyId: credit.companyId || PLATFORM_COMPANY_ID,
    customerId: credit.customerId,
    journeyId: credit.journeyId,
    amountCents: credit.amountCents,
    status: credit.status || 'AVAILABLE',
    issuedBy: credit.issuedBy,
    expiresAt: dateOrNull(credit.expiresAt),
    redeemedBookingId: credit.redeemedBookingId ?? null,
    redeemedReference: credit.redeemedReference ?? null,
    redeemedAt: dateOrNull(credit.redeemedAt),
  };
}

function creditFromRow(row) {
  return {
    id: row.id,
    companyId: row.companyId,
    customerId: row.customerId,
    journeyId: row.journeyId,
    amountCents: row.amountCents,
    status: row.status,
    issuedBy: row.issuedBy,
    expiresAt: iso(row.expiresAt),
    redeemedBookingId: row.redeemedBookingId ?? null,
    redeemedReference: row.redeemedReference ?? null,
    redeemedAt: iso(row.redeemedAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export async function persistReferralCredit(credit) {
  credit.updatedAt = new Date().toISOString();
  if (!DATABASE_ENABLED || !credit?.id) return;
  const row = creditToRow(credit);
  await db().referralCredit.upsert({ where: { id: row.id }, update: row, create: row });
}

/* ------------------------------------------------------------------ */
/* Program settings                                                    */
/* ------------------------------------------------------------------ */

function settingsToRow(settings) {
  return {
    companyId: settings.companyId || PLATFORM_COMPANY_ID,
    enabled: settings.enabled !== false,
    rewardAmountCents: settings.rewardAmountCents ?? null,
    tier2Threshold: settings.tier2Threshold ?? null,
    tier2AmountCents: settings.tier2AmountCents ?? null,
    tier3Threshold: settings.tier3Threshold ?? null,
    tier3AmountCents: settings.tier3AmountCents ?? null,
    milestoneBonuses: settings.milestoneBonuses ?? null,
    monthlyCapPerReferrer: settings.monthlyCapPerReferrer ?? null,
    rewardExpiryDays: settings.rewardExpiryDays ?? null,
    updatedBy: settings.updatedBy ?? null,
  };
}

function settingsFromRow(row) {
  return {
    id: row.id,
    companyId: row.companyId,
    enabled: Boolean(row.enabled),
    rewardAmountCents: row.rewardAmountCents ?? null,
    tier2Threshold: row.tier2Threshold ?? null,
    tier2AmountCents: row.tier2AmountCents ?? null,
    tier3Threshold: row.tier3Threshold ?? null,
    tier3AmountCents: row.tier3AmountCents ?? null,
    milestoneBonuses: Array.isArray(row.milestoneBonuses) ? row.milestoneBonuses : null,
    monthlyCapPerReferrer: row.monthlyCapPerReferrer ?? null,
    rewardExpiryDays: row.rewardExpiryDays ?? null,
    updatedBy: row.updatedBy ?? null,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export async function persistProgramSettings(settings) {
  if (!settings?.companyId) return;
  // The store copy updates first — services read it at call time.
  store.referralSettings.set(settings.companyId, { ...settings });
  if (!DATABASE_ENABLED) return;
  const row = settingsToRow(settings);
  await db().referralProgramSetting.upsert({
    where: { companyId: row.companyId },
    update: row,
    create: row,
  });
}

/* ------------------------------------------------------------------ */
/* Hydration                                                           */
/* ------------------------------------------------------------------ */

export async function hydrateReferrals() {
  if (!DATABASE_ENABLED) return { skipped: true };
  const prisma = db();

  const journeyRows = await prisma.referralJourney.findMany({ orderBy: { createdAt: 'asc' } });
  store.referralJourneys = journeyRows.map(journeyFromRow);

  const creditRows = await prisma.referralCredit.findMany({ orderBy: { createdAt: 'asc' } });
  store.referralCredits = creditRows.map(creditFromRow);

  const settingRows = await prisma.referralProgramSetting.findMany();
  store.referralSettings = new Map();
  for (const row of settingRows) {
    const settings = settingsFromRow(row);
    store.referralSettings.set(settings.companyId, settings);
  }

  return { journeys: journeyRows.length, credits: creditRows.length, settings: settingRows.length };
}
