import { PLATFORM_COMPANY_ID, appendEvent, store } from '../data/store.js';
import { DATABASE_ENABLED, db } from '../db/client.js';
import { plDb } from '../db/plClient.js';
import { isMasterAccount } from './speedyVerify.js';

/**
 * Account removal (2026-11-20, Ramone's directive) — the ONE removal
 * path in the Service OS, built for Work Time Account Access.
 *
 * Until today the platform deliberately had NO account delete anywhere
 * (Rule Zero design). Ramone ordered an owner-only removal tool so he
 * can clear test and fake accounts himself. The tool lives behind the
 * Master gate in routes/accessControl.js (COMPANY_OWNER only — every
 * other role is refused by that router before this service runs), and
 * this service carries the hard locks:
 *
 * - An account whose roles include COMPANY_OWNER can NEVER be removed
 *   — not by the UI, not by a direct API call, not by the Master
 *   himself. The check is on the TARGET's roles, server-side.
 * - The caller can never remove the account he is signed in as.
 *
 * Removal is a HARD delete of the user row (the Book OS scorecard
 * counts user rows, so the count drops). Two record classes:
 *
 * - AUTH ARTIFACTS die with the account: device sessions, Speedy
 *   Verify code, Layer 2 login challenges, passkeys + challenges,
 *   sign-in handoffs, email-verification / password-reset /
 *   email-sign-in / email-change tokens, push subscriptions and terms
 *   acceptances are deleted explicitly in the same transaction (the
 *   rest of the account-owned rows — channel links, subscriptions,
 *   stored card, academy completions, seller channel rows — carry
 *   onDelete: Cascade foreign keys and go with the row). Layer 2
 *   enrollment and temporary-password state are columns on the user
 *   row itself, so they die with it too.
 *
 * - BUSINESS RECORDS block removal. The schema keys them by plain
 *   reference columns (no foreign key to the user row), so they are
 *   counted first; if any exist, removal is refused with 409 naming
 *   each kind and count, and NOTHING is deleted. The owner clears
 *   those records through their own surfaces first (bookings in
 *   Book OS, listings in Pepper Lists, and so on), then removes the
 *   account. SetNull references (media content owner, report authors)
 *   and plain-reference history (chat sessions, messages, audit rows)
 *   are records OF the business, not property of the account — they
 *   stay, with the author reference simply going quiet.
 *
 * Every successful removal appends an ACCOUNT_REMOVED platform event
 * naming the actor and the removed account's email + roles. The email
 * rides under `removedEmail` in details on purpose: the event feed's
 * privacy scrubber strips customer-contact keys (email, phone, …)
 * from intake-shaped events so the feed never becomes a copy of
 * customer PII — but this event is an internal audit record written
 * by the Master's own console action, the feed is staff-read only,
 * and the removed account's email is exactly what the audit exists
 * to record (Ramone's design for this tool).
 */

function removalError(status, code, message, extra = {}) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  Object.assign(error, extra);
  return error;
}

async function findUser(id) {
  if (DATABASE_ENABLED) return db().user.findUnique({ where: { id } });
  return store.users.get(id) ?? null;
}

// ---------------------------------------------------------------------------
// Business-record blockers. Each entry counts rows that belong to the
// account through a plain reference column in the schema (no FK), so
// a bare user delete would silently orphan them. `label` is the plain
// name the 409 message and the Work Time banner speak in.
// ---------------------------------------------------------------------------
const BLOCKERS = [
  { key: 'customers', label: 'CRM customer record', count: (prisma, t) => prisma.customer.count({ where: { userId: t.id } }) },
  { key: 'bookings', label: 'booking', count: async (prisma, t) => {
      const customers = await prisma.customer.findMany({ where: { userId: t.id }, select: { id: true } });
      if (!customers.length) return 0;
      return prisma.serviceRequest.count({ where: { customerId: { in: customers.map((c) => c.id) } } });
    } },
  { key: 'providerProfiles', label: 'provider profile', count: (prisma, t) =>
      t.companyId === PLATFORM_COMPANY_ID ? 0 : prisma.provider.count({ where: { companyId: t.companyId } }) },
  { key: 'providerAssignments', label: 'provider assignment', count: async (prisma, t) => {
      if (t.companyId === PLATFORM_COMPANY_ID) return 0;
      const providers = await prisma.provider.findMany({ where: { companyId: t.companyId }, select: { id: true } });
      if (!providers.length) return 0;
      return prisma.dispatchAssignment.count({ where: { providerId: { in: providers.map((p) => p.id) } } });
    } },
  { key: 'appliances', label: 'connected appliance', count: (prisma, t) => prisma.customerAppliance.count({ where: { userId: t.id } }) },
  // Pepper Lists business records live in the Pepper Lists database
  // (pl: true — counted through plDb(), which falls back to the main
  // client until PL_DATABASE_URL is set).
  { key: 'listings', pl: true, label: 'marketplace listing', count: (prisma, t) => prisma.listingProfile.count({ where: { sellerUserId: t.id } }) },
  { key: 'sellerSales', pl: true, label: 'marketplace sale', count: (prisma, t) => prisma.sellerSale.count({ where: { OR: [{ sellerId: t.id }, { buyerId: t.id }] } }) },
  { key: 'sellerReviews', pl: true, label: 'marketplace review', count: (prisma, t) => prisma.sellerReview.count({ where: { OR: [{ sellerId: t.id }, { buyerId: t.id }] } }) },
  { key: 'listingBumps', pl: true, label: 'listing bump', count: (prisma, t) => prisma.listingBump.count({ where: { sellerId: t.id } }) },
  { key: 'crossPosts', pl: true, label: 'marketplace cross-post', count: (prisma, t) => prisma.pepperListsCrossPost.count({ where: { userId: t.id } }) },
  { key: 'syndications', pl: true, label: 'marketplace syndication request', count: (prisma, t) => prisma.pepperListsSyndication.count({ where: { userId: t.id } }) },
  { key: 'messageThreads', pl: true, label: 'marketplace message thread', count: (prisma, t) => prisma.pepperListsThread.count({ where: { OR: [{ sellerUserId: t.id }, { buyerUserId: t.id }] } }) },
  { key: 'payoutAccount', pl: true, label: 'marketplace payout account', count: (prisma, t) => prisma.sellerConnectAccount.count({ where: { userId: t.id } }) },
  { key: 'pmProperties', label: 'property-manager property', count: (prisma, t) => prisma.pmProperty.count({ where: { ownerId: t.id } }) },
  { key: 'pmUnits', label: 'property-manager unit', count: (prisma, t) => prisma.pmUnit.count({ where: { ownerId: t.id } }) },
  { key: 'pmTenantLinks', label: 'property-manager tenant link', count: (prisma, t) => prisma.pmTenantLink.count({ where: { ownerId: t.id } }) },
  { key: 'pmServiceRequests', label: 'property-manager service request', count: (prisma, t) => prisma.pmServiceRequest.count({ where: { ownerId: t.id } }) },
  { key: 'advertiserCreatives', label: 'advertiser creative', count: (prisma, t) => prisma.advertiserCreative.count({ where: { ownerId: t.id } }) },
  { key: 'adCampaigns', label: 'ad campaign', count: (prisma, t) => prisma.adCampaign.count({ where: { createdById: t.id } }) },
  { key: 'giftCards', label: 'gift card purchased', count: (prisma, t) => prisma.giftCard.count({ where: { purchaserUserId: t.id } }) },
];

function describeBlockers(blockers) {
  return BLOCKERS
    .filter((b) => blockers[b.key] > 0)
    .map((b) => `${blockers[b.key]} ${b.label}${blockers[b.key] === 1 ? '' : 's'}`)
    .join(', ');
}

async function countBlockers(target) {
  const blockers = {};
  if (DATABASE_ENABLED) {
    const prisma = db();
    for (const blocker of BLOCKERS) {
      const n = await blocker.count(blocker.pl ? plDb() : prisma, target);
      if (n > 0) blockers[blocker.key] = n;
    }
    return blockers;
  }
  // Skeleton mode: the in-memory store only carries a few of the
  // record families; count what exists there so the shape is the same.
  const customers = [...store.customers.values()].filter((c) => c.userId === target.id);
  if (customers.length) blockers.customers = customers.length;
  if (target.companyId !== PLATFORM_COMPANY_ID) {
    const providers = (store.providers || []).filter((p) => p.companyId === target.companyId);
    if (providers.length) blockers.providerProfiles = providers.length;
  }
  const appliances = store.appliances instanceof Map
    ? [...store.appliances.values()].filter((a) => a.userId === target.id)
    : [];
  if (appliances.length) blockers.appliances = appliances.length;
  return blockers;
}

// Auth-artifact tables deleted explicitly with the account (database
// mode). Everything else the account owns carries onDelete: Cascade
// and is removed by the user-row delete itself.
const ARTIFACT_DELETES = [
  'userSession', 'speedyVerifyCode', 'loginChallenge',
  'passkeyCredential', 'passkeyChallenge', 'authHandoff',
  'sessionHandoff', 'emailVerificationToken', 'passwordResetToken',
  'emailSignInToken', 'emailChangeToken', 'pushSubscription',
  'termsAcceptance',
];

async function deleteAccountRows(target) {
  if (DATABASE_ENABLED) {
    // Pepper Lists account-owned rows (channel connections + their
    // audit trail, the seller subscription, saved listings) live in
    // the Pepper Lists database, where no cross-database cascade can
    // reach them — delete them FIRST, so a failure there aborts the
    // removal before the account itself dies. Business records were
    // already proven absent by the blocker counts above.
    const pl = plDb();
    await pl.sellerChannelConnection.deleteMany({ where: { userId: target.id } });
    await pl.sellerSubscription.deleteMany({ where: { userId: target.id } });
    await pl.savedListing.deleteMany({ where: { userId: target.id } });
    const prisma = db();
    const ops = ARTIFACT_DELETES.map((model) => prisma[model].deleteMany({ where: { userId: target.id } }));
    ops.push(prisma.user.delete({ where: { id: target.id } }));
    await prisma.$transaction(ops);
    return;
  }
  if (store.userSessions instanceof Map) {
    for (const [id, session] of [...store.userSessions]) {
      if (session?.userId === target.id) store.userSessions.delete(id);
    }
  }
  store.users.delete(target.id);
}

/**
 * Remove one account permanently. `actor` is the signed-in Master
 * (req.user); the route's gate has already proven COMPANY_OWNER.
 * Throws { status, code, message, blockers? } in the codebase style.
 */
export async function removeAccount(actor, targetId) {
  const target = await findUser(targetId);
  if (!target) {
    throw removalError(404, 'ACCOUNT_NOT_FOUND', 'Account not found');
  }
  // HARD LOCK 1 (Rule Zero): a COMPANY_OWNER account can never be
  // removed — by anyone, through any path. Checked on the target's
  // own roles, before anything else happens.
  if (isMasterAccount(target)) {
    throw removalError(403, 'MASTER_ACCOUNT_PROTECTED',
      'The Master (COMPANY_OWNER) account can never be removed.');
  }
  // HARD LOCK 2: the caller can never remove the account he is
  // signed in as.
  if (actor?.id && target.id === actor.id) {
    throw removalError(403, 'CANNOT_REMOVE_SELF',
      'You cannot remove the account you are signed in as.');
  }

  const blockers = await countBlockers(target);
  if (Object.keys(blockers).length) {
    throw removalError(409, 'ACCOUNT_HAS_RECORDS',
      `This account still has business records (${describeBlockers(blockers)}). Remove those first, then remove the account.`,
      { blockers });
  }

  await deleteAccountRows(target);

  await appendEvent('ACCOUNT_REMOVED', {
    source: 'WORK_TIME_ACCESS',
    actor: actor?.email || null,
    entityType: 'USER',
    entityId: target.id,
    details: {
      removedEmail: target.email,
      roles: Array.isArray(target.roles) ? target.roles : [],
      removedById: actor?.id || null,
    },
  });

  return { removed: { id: target.id, email: target.email, roles: target.roles } };
}
