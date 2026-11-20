import { DATABASE_ENABLED, db } from './client.js';

/**
 * CRM depth D5 (2026-11-20): database write-through for the
 * duplicate-customer merge. The merge service mutates the in-memory
 * store (the API's working state); this applies the same re-pointing
 * to the database in ONE transaction so a cold start hydrates the
 * merged world exactly: every record that named the duplicate now
 * names the survivor, and the duplicate's row carries the
 * mergedIntoId tombstone pointer. No row is deleted.
 */
export async function applyCustomerMergeToDatabase({
  survivorId,
  duplicateId,
  survivorUserId = null,
  duplicateUserId = null,
  adoptUserId = null,
}) {
  if (!DATABASE_ENABLED) return { skipped: true };
  const prisma = db();
  const ops = [
    prisma.serviceRequest.updateMany({ where: { customerId: duplicateId }, data: { customerId: survivorId } }),
    prisma.serviceRequest.updateMany({ where: { referredByCustomerId: duplicateId }, data: { referredByCustomerId: survivorId } }),
    prisma.payment.updateMany({ where: { customerId: duplicateId }, data: { customerId: survivorId } }),
    prisma.invoice.updateMany({ where: { customerId: duplicateId }, data: { customerId: survivorId } }),
    prisma.crmNote.updateMany({ where: { customerId: duplicateId }, data: { customerId: survivorId } }),
    prisma.inboxMessage.updateMany({ where: { customerId: duplicateId }, data: { customerId: survivorId } }),
    prisma.referral.updateMany({ where: { customerId: duplicateId }, data: { customerId: survivorId } }),
    prisma.referralJourney.updateMany({ where: { referrerCustomerId: duplicateId }, data: { referrerCustomerId: survivorId } }),
    prisma.referralCredit.updateMany({ where: { customerId: duplicateId }, data: { customerId: survivorId } }),
  ];
  // Garage appliances hang off the account (userId), not the customer
  // record: on an account-conflict merge the duplicate's garage moves
  // to the survivor's account; on an adoption the survivor record
  // takes the duplicate's account link and the garage follows it.
  if (adoptUserId) {
    ops.push(prisma.customer.update({ where: { id: survivorId }, data: { userId: adoptUserId } }));
  } else if (survivorUserId && duplicateUserId && survivorUserId !== duplicateUserId) {
    ops.push(prisma.customerAppliance.updateMany({ where: { userId: duplicateUserId }, data: { userId: survivorUserId } }));
  }
  ops.push(prisma.customer.update({ where: { id: duplicateId }, data: { mergedIntoId: survivorId } }));
  await prisma.$transaction(ops);
  return { applied: ops.length };
}
