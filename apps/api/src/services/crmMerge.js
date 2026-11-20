import { store, appendEvent, createId } from '../data/store.js';
import { findUserById } from './handoff.js';
import { persistCustomer } from '../db/bookingsRepo.js';
import { persistCrmNote } from '../db/crmRepo.js';
import { applyCustomerMergeToDatabase } from '../db/crmMergeRepo.js';

/**
 * CRM depth D5 (2026-11-20, Ramone approved): duplicate-customer
 * merge — the guided staff tool behind POST /crm/customers/merge.
 *
 * The survivor keeps its identity (name / phone / email). Every
 * record that named the duplicate is re-pointed at the survivor:
 * bookings (and bookings that arrived through the duplicate's
 * referrals), payments, invoices, CRM notes, inbox thread messages,
 * referral codes, referral journeys, referral credits, and the
 * garage (which hangs off the linked account — see below). The
 * duplicate's row is NOT deleted: it becomes a tombstone carrying
 * mergedIntoId + its original identifiers, so the old phone / email /
 * name still find the survivor in search (alias lookup) and the
 * merge itself stays auditable forever.
 *
 * Guards (enforced in the route from this module's reads):
 *  - The Master/owner's records are NEVER merged, in either
 *    direction: if either record is linked to a COMPANY_OWNER
 *    account, the merge refuses outright (Rule Zero).
 *  - Two records linked to DIFFERENT signed-in accounts are not
 *    merged silently: the preview flags the conflict and the merge
 *    requires the staff member's explicit confirmAccountConflict.
 *    With the override, the duplicate's garage appliances re-point
 *    to the survivor's account and the duplicate's account link
 *    stays on the tombstone as an alias (accounts themselves are
 *    never merged or deleted).
 *  - If only the duplicate has an account, the survivor ADOPTS the
 *    link (survivor.userId = duplicate.userId) so the customer's
 *    sign-in, garage, and reviews keep working against the survivor.
 *
 * The merge is logged twice: a CUSTOMER_MERGED platform event with
 * the full moved counts, and a CRM note on the survivor written in
 * plain language for the next human who opens the record.
 */

const isOwnerUser = (user) => Boolean(user) && (user.roles || []).includes('COMPANY_OWNER');

export async function resolveMergeGuards(survivor, duplicate) {
  const [survivorUser, duplicateUser] = await Promise.all([
    survivor.userId ? findUserById(survivor.userId).catch(() => null) : null,
    duplicate.userId ? findUserById(duplicate.userId).catch(() => null) : null,
  ]);
  const bothAccounts = Boolean(survivor.userId && duplicate.userId && survivor.userId !== duplicate.userId);
  return {
    ownerInvolved: isOwnerUser(survivorUser) || isOwnerUser(duplicateUser),
    survivorHasAccount: Boolean(survivor.userId),
    duplicateHasAccount: Boolean(duplicate.userId),
    bothAccounts,
    accountConflict: bothAccounts,
  };
}

/** Exactly what a merge of duplicate → survivor would move, counted
 * from the live records. Pure read — the preview and the execute run
 * the same plan, so what staff confirm is what happens. */
export function mergePlan(survivor, duplicate) {
  const dup = duplicate.id;
  const garageMoves =
    duplicate.userId && (!survivor.userId || survivor.userId !== duplicate.userId)
      ? [...store.appliances.values()].filter((a) => a.userId === duplicate.userId).length
      : 0;
  return {
    bookings: [...store.bookings.values()].filter((b) => b.customerId === dup).length,
    referredBookings: [...store.bookings.values()].filter((b) => b.referredByCustomerId === dup).length,
    payments: [...store.payments.values()].filter((p) => p.customerId === dup).length,
    invoices: (store.invoices || []).filter((i) => i.customerId === dup).length,
    notes: (store.crmNotes || []).filter((n) => n.customerId === dup).length,
    inboxMessages: (store.inboxMessages || []).filter((m) => m.customerId === dup).length,
    referralCodes: [...store.referrals.values()].filter((r) => r.customerId === dup).length,
    referralJourneys: (store.referralJourneys || []).filter((j) => j.referrerCustomerId === dup).length,
    referralCredits: (store.referralCredits || []).filter((c) => c.customerId === dup).length,
    garageAppliances: garageMoves,
  };
}

export async function executeMerge({ survivor, duplicate, actor, confirmAccountConflict = false }) {
  const moved = mergePlan(survivor, duplicate);
  const adoptUserId = !survivor.userId && duplicate.userId ? duplicate.userId : null;

  for (const booking of store.bookings.values()) {
    if (booking.customerId === duplicate.id) {
      booking.customerId = survivor.id;
      booking.customer = survivor;
    }
    if (booking.referredByCustomerId === duplicate.id) booking.referredByCustomerId = survivor.id;
  }
  for (const payment of store.payments.values()) {
    if (payment.customerId === duplicate.id) payment.customerId = survivor.id;
  }
  for (const invoice of store.invoices || []) {
    if (invoice.customerId === duplicate.id) invoice.customerId = survivor.id;
  }
  for (const note of store.crmNotes || []) {
    if (note.customerId === duplicate.id) note.customerId = survivor.id;
  }
  for (const message of store.inboxMessages || []) {
    if (message.customerId === duplicate.id) message.customerId = survivor.id;
  }
  for (const referral of store.referrals.values()) {
    if (referral.customerId === duplicate.id) referral.customerId = survivor.id;
  }
  for (const journey of store.referralJourneys || []) {
    if (journey.referrerCustomerId === duplicate.id) journey.referrerCustomerId = survivor.id;
  }
  for (const credit of store.referralCredits || []) {
    if (credit.customerId === duplicate.id) credit.customerId = survivor.id;
  }
  if (adoptUserId) {
    survivor.userId = adoptUserId;
  } else if (survivor.userId && duplicate.userId && survivor.userId !== duplicate.userId) {
    for (const appliance of store.appliances.values()) {
      if (appliance.userId === duplicate.userId) appliance.userId = survivor.userId;
    }
  }
  duplicate.mergedIntoId = survivor.id;

  await applyCustomerMergeToDatabase({
    survivorId: survivor.id,
    duplicateId: duplicate.id,
    survivorUserId: survivor.userId || null,
    duplicateUserId: duplicate.userId || null,
    adoptUserId,
  });
  await persistCustomer(survivor);
  await persistCustomer(duplicate);

  const movedText = [
    `${moved.bookings} booking${moved.bookings === 1 ? '' : 's'}`,
    moved.referredBookings ? `${moved.referredBookings} referred booking${moved.referredBookings === 1 ? '' : 's'}` : null,
    `${moved.payments} payment record${moved.payments === 1 ? '' : 's'}`,
    `${moved.invoices} invoice${moved.invoices === 1 ? '' : 's'}`,
    `${moved.notes} note${moved.notes === 1 ? '' : 's'}`,
    `${moved.inboxMessages} inbox message${moved.inboxMessages === 1 ? '' : 's'}`,
    `${moved.referralCodes} referral code${moved.referralCodes === 1 ? '' : 's'}`,
    `${moved.referralJourneys} referral journey${moved.referralJourneys === 1 ? '' : 's'}`,
    `${moved.referralCredits} referral credit${moved.referralCredits === 1 ? '' : 's'}`,
    `${moved.garageAppliances} garage appliance${moved.garageAppliances === 1 ? '' : 's'}`,
  ]
    .filter(Boolean)
    .join(', ');
  const note = {
    id: createId(),
    companyId: survivor.companyId,
    customerId: survivor.id,
    author: actor,
    body:
      `Duplicate record merged into this one by ${actor}: ${duplicate.name} (${duplicate.phone || 'no phone'}${duplicate.email ? `, ${duplicate.email}` : ''}). ` +
      `Moved: ${movedText}. The duplicate's phone/email stay on file as aliases — searching them finds this record.`,
    createdAt: new Date().toISOString(),
  };
  store.crmNotes.push(note);
  await persistCrmNote(note);

  await appendEvent('CUSTOMER_MERGED', {
    actor,
    entityType: 'CUSTOMER',
    entityId: survivor.id,
    details: {
      duplicateId: duplicate.id,
      duplicateName: duplicate.name,
      duplicatePhone: duplicate.phone || null,
      duplicateEmail: duplicate.email || null,
      duplicateUserId: duplicate.userId || null,
      moved,
      accountConflictOverride: Boolean(confirmAccountConflict),
      adoptedAccountLink: Boolean(adoptUserId),
    },
  });

  return { moved, note };
}
