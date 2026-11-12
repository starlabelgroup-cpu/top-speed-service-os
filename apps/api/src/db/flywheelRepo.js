import { DATABASE_ENABLED, db } from './client.js';
import { createId, PLATFORM_COMPANY_ID, store } from '../data/store.js';

/**
 * Flywheel persistence for the Service OS (database mode).
 *
 * Referral codes and the notification outbox lived only in the in-memory
 * store, so a cold start wiped them — a customer could lose their referral
 * code between issue and redemption, and queued review/referral messages
 * vanished. This repository is the bridge, in the same pattern as
 * bookingsRepo:
 *
 *  - hydrateFlywheel() loads referrals and outbox entries into the store
 *    at cold start (called from bookingsRepo.hydrateStore).
 *  - persist*() write-through upserts run at every mutation point:
 *    referral issue (services/flywheel), redemption (routes/flywheel),
 *    notification queue (services/notifications), delivery outcomes
 *    (services/senders drain).
 *
 * Referrals are keyed by code in the store; redemptions ride in a JSON
 * column exactly as the services produce them. Notification entries carry
 * no tenant today — the pipeline is a platform-level outbox, so rows
 * default to the platform company.
 *
 * Every function is a no-op when DATABASE_URL is not set (skeleton mode).
 */

function referralToRow(referral) {
  return {
    id: referral.id,
    companyId: referral.companyId || PLATFORM_COMPANY_ID,
    code: referral.code,
    customerId: referral.customerId ?? null,
    customerName: referral.customerName ?? null,
    customerPhone: referral.customerPhone ?? null,
    status: referral.status || 'ACTIVE',
    issuedFromBookingId: referral.issuedFromBookingId ?? null,
    issuedFromReferenceCode: referral.issuedFromReferenceCode ?? null,
    redemptions: referral.redemptions ?? [],
    issuedAt: referral.issuedAt ? new Date(referral.issuedAt) : new Date(),
  };
}

function referralFromRow(row) {
  return {
    id: row.id,
    companyId: row.companyId,
    code: row.code,
    customerId: row.customerId ?? null,
    customerName: row.customerName ?? null,
    customerPhone: row.customerPhone ?? null,
    status: row.status,
    issuedFromBookingId: row.issuedFromBookingId ?? null,
    issuedFromReferenceCode: row.issuedFromReferenceCode ?? null,
    issuedAt: row.issuedAt?.toISOString?.() ?? row.issuedAt,
    redemptions: Array.isArray(row.redemptions) ? row.redemptions : [],
  };
}

function notificationToRow(entry) {
  return {
    id: entry.id,
    companyId: entry.companyId || PLATFORM_COMPANY_ID,
    channel: entry.channel,
    template: entry.template,
    to: entry.to,
    payload: entry.payload ?? {},
    status: entry.status || 'QUEUED_SIMULATED',
    eventKey: entry.eventKey ?? null,
    eventType: entry.eventType ?? null,
    reason: entry.reason ?? null,
    attempts: entry.attempts ?? 0,
    providerId: entry.providerId ?? null,
    error: entry.error ?? null,
    sentAt: entry.sentAt ? new Date(entry.sentAt) : null,
  };
}

function notificationFromRow(row) {
  const entry = {
    id: row.id,
    channel: row.channel,
    template: row.template,
    to: row.to,
    payload: row.payload ?? {},
    status: row.status,
    createdAt: row.createdAt?.toISOString?.() ?? row.createdAt,
  };
  if (row.attempts) entry.attempts = row.attempts;
  if (row.providerId) entry.providerId = row.providerId;
  if (row.error) entry.error = row.error;
  if (row.eventKey) entry.eventKey = row.eventKey;
  if (row.eventType) entry.eventType = row.eventType;
  if (row.reason) entry.reason = row.reason;
  if (row.sentAt) entry.sentAt = row.sentAt?.toISOString?.() ?? row.sentAt;
  return entry;
}

export async function persistReferral(referral) {
  if (!DATABASE_ENABLED || !referral?.code) return;
  if (!referral.id) referral.id = createId();
  const row = referralToRow(referral);
  await db().referral.upsert({ where: { id: row.id }, update: row, create: row });
}

export async function persistNotification(entry) {
  if (!DATABASE_ENABLED || !entry?.id) return;
  const row = notificationToRow(entry);
  await db().notificationOutbox.upsert({ where: { id: row.id }, update: row, create: row });
}

export async function hydrateFlywheel() {
  if (!DATABASE_ENABLED) return { skipped: true };
  const prisma = db();

  const referralRows = await prisma.referral.findMany({ orderBy: { issuedAt: 'asc' } });
  store.referrals.clear();
  for (const row of referralRows) {
    const referral = referralFromRow(row);
    store.referrals.set(referral.code, referral);
  }

  const notificationRows = await prisma.notificationOutbox.findMany({ orderBy: { createdAt: 'asc' } });
  store.notificationOutbox.length = 0;
  for (const row of notificationRows) {
    store.notificationOutbox.push(notificationFromRow(row));
  }

  return { referrals: referralRows.length, notifications: notificationRows.length };
}
