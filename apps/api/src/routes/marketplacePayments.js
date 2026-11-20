import { Router } from 'express';
import { z } from 'zod';
import { addBookingEvent, appendEvent, createId, store } from '../data/store.js';
import { DATABASE_ENABLED, db } from '../db/client.js';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { ROLES, STAFF_ROLES } from '../config/security.js';
import { persistPayment } from '../db/paymentsRepo.js';
import {
  createGiftCard, createOrder, findOrderForListing, getConnectAccountByUserId,
  getGiftCardByHash, getPaymentsSetting, listGiftCardsForPurchaser, listOrdersForUser,
  redeemGiftCard, sumRedeemedForBooking, updateGiftCard, updateOrder, updatePaymentsSetting,
  upsertConnectAccount,
} from '../db/paymentsRailsRepo.js';
import { getListingByReference, LISTING_SITE_BASE } from '../services/pepperListings.js';
import { computeFeeCents, generateGiftCardCode, giftCardLast4, hashGiftCardCode } from '../services/marketplacePayments.js';
import { NOTIFICATION_TEMPLATES, queueNotification } from '../services/notifications.js';
import { emitReport } from '../services/managementReports.js';
import {
  DIAGNOSTIC_AMOUNT_CENTS, createConnectAccount, createConnectAccountLink,
  createConnectCheckout, createGiftCardCheckout, retrieveConnectAccount, stripeConfigured,
} from '../services/stripe.js';

/**
 * New money rails — routes (2026-11-20, Wave 4).
 *
 * C19 — Pepper Lists protected payments (Stripe Connect):
 *   GET  /pepper-lists/protected-payments/status   public feature state
 *   POST /pepper-lists/connect/onboard             seller: start/resume onboarding
 *   GET  /pepper-lists/connect/status              seller: my Connect state (refreshed from Stripe)
 *   POST /pepper-lists/listings/:reference/buy     buyer: Connect checkout for one listing
 *   GET  /pepper-lists/orders/mine                 my purchases + my sales
 *
 * F6 — Gift cards:
 *   GET  /gift-cards/config                        public: denominations on sale
 *   POST /gift-cards/purchase                      buy one (Stripe checkout)
 *   GET  /gift-cards/mine                          cards I bought (last4 + balance, never codes)
 *   POST /gift-cards/balance                       balance for a code
 *   POST /gift-cards/redeem                        apply a card to a booking's diagnostic
 *
 * Owner configuration (Ad Studio-style owner gate):
 *   GET   /admin/payments/settings
 *   PATCH /admin/payments/settings                 Connect flag, Connect fee, denominations
 *
 * The honesty rules, enforced here before any Stripe call:
 *  - Connect ships OFF (PaymentsSetting.connectEnabled, default
 *    false). While off, onboarding and checkout answer an honest
 *    503 protected_payments_coming — activation on the live Stripe
 *    account is Ramone's dashboard step, and the flag is his to
 *    flip from the owner settings once that is done.
 *  - No owner-set fee (connectFeeBps NULL) → checkout refuses with
 *    422 pricing_not_set, the advertiser-plans idiom. No owner-set
 *    denominations → gift card purchase refuses the same way.
 *  - A gift card is worth nothing until Stripe's webhook activates
 *    it; redemption moves real balances only, capped at the card
 *    balance and the booking's real outstanding diagnostic.
 */
const router = Router();

const APP_BASE = process.env.PUBLIC_WEB_BASE || 'https://topspeedserviceos.com';

const ownerOnly = [
  authenticate,
  requireCompany,
  requireRole(ROLES.COMPANY_OWNER, ROLES.PLATFORM_ADMIN),
];

function publicConnectAccount(account) {
  if (!account) return null;
  return {
    status: account.status,
    chargesEnabled: account.chargesEnabled,
    payoutsEnabled: account.payoutsEnabled,
    detailsSubmitted: account.detailsSubmitted,
    stripeAccountId: account.stripeAccountId,
    updatedAt: account.updatedAt,
  };
}

function publicOrder(order, { sellerView = false } = {}) {
  return {
    id: order.id,
    listingReference: order.listingReference,
    amountCents: order.amountCents,
    ...(sellerView ? { feeCents: order.feeCents } : {}),
    currency: order.currency,
    status: order.status,
    paidAt: order.paidAt,
    createdAt: order.createdAt,
  };
}

function publicGiftCard(card) {
  return {
    id: card.id,
    codeLast4: card.codeLast4,
    initialAmountCents: card.initialAmountCents,
    balanceCents: card.balanceCents,
    currency: card.currency,
    status: card.status,
    recipientEmail: card.recipientEmail,
    issuedAt: card.issuedAt,
    createdAt: card.createdAt,
  };
}

async function findUserByEmail(email, companyId) {
  const target = String(email || '').trim().toLowerCase();
  if (!target) return null;
  if (DATABASE_ENABLED) {
    try {
      const row = await db().user.findFirst({ where: { email: target, companyId } });
      if (row) return { id: row.id, email: row.email };
    } catch { /* fall through to the in-memory record */ }
  }
  for (const user of store.users.values()) {
    if (String(user.email || '').toLowerCase() === target && (!companyId || user.companyId === companyId)) {
      return { id: user.id, email: user.email };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Owner configuration
// ---------------------------------------------------------------------------

router.get('/admin/payments/settings', ...ownerOnly, async (req, res, next) => {
  try {
    const setting = await getPaymentsSetting();
    return res.json({ data: { settings: setting } });
  } catch (error) {
    return next(error);
  }
});

const settingsSchema = z.object({
  connectEnabled: z.boolean().optional(),
  connectFeeBps: z.number().int().min(0).max(3000).nullable().optional(),
  giftCardDenominationsCents: z.array(z.number().int().min(100).max(100000)).max(12).optional(),
});

router.patch('/admin/payments/settings', ...ownerOnly, async (req, res, next) => {
  try {
    const parsed = settingsSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid settings', details: parsed.error.flatten() });
    const data = {};
    if (parsed.data.connectEnabled !== undefined) data.connectEnabled = parsed.data.connectEnabled;
    if (parsed.data.connectFeeBps !== undefined) data.connectFeeBps = parsed.data.connectFeeBps;
    if (parsed.data.giftCardDenominationsCents !== undefined) {
      data.giftCardDenominationsCents = [...new Set(parsed.data.giftCardDenominationsCents)].sort((a, b) => a - b);
    }
    if (!Object.keys(data).length) return res.status(400).json({ error: 'Nothing to update' });
    const setting = await updatePaymentsSetting(data, req.user.id);
    await appendEvent('PAYMENTS_SETTINGS_UPDATED', {
      source: 'admin', actor: 'owner', entityType: 'PAYMENTS_SETTING', entityId: 'default',
      details: { ...data },
    });
    emitReport({
      department: 'billing', type: 'PAYMENTS_SETTINGS_UPDATED',
      title: 'Payments settings updated by the owner',
      detail: { ...data, actor: req.user.id }, source: 'admin', reference: null,
      eventKey: `payments-settings:${Date.now()}:report`,
    });
    return res.json({ data: { settings: setting } });
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// C19 — Stripe Connect: seller onboarding + protected checkout
// ---------------------------------------------------------------------------

router.get('/pepper-lists/protected-payments/status', async (req, res, next) => {
  try {
    const setting = await getPaymentsSetting();
    return res.json({
      data: {
        enabled: setting.connectEnabled,
        feeConfigured: setting.connectFeeBps != null,
        // Honest storefront copy state: while the flag is off the
        // surfaces say protected payments are coming — because they
        // are: the machinery is live, activation is the owner's.
        state: setting.connectEnabled ? 'AVAILABLE' : 'COMING',
      },
    });
  } catch (error) {
    return next(error);
  }
});

function connectOff(res, setting) {
  return res.status(503).json({
    error: 'protected_payments_coming',
    message: 'Protected payments are coming to Pepper Lists — the payment machinery is built, and the office is finishing the payout setup. Listings still sell the usual way in the meantime.',
    enabled: setting.connectEnabled,
  });
}

router.post('/pepper-lists/connect/onboard', authenticate, requireCompany, async (req, res, next) => {
  try {
    const setting = await getPaymentsSetting();
    if (!setting.connectEnabled) return connectOff(res, setting);
    if (!stripeConfigured()) {
      return res.status(503).json({ error: 'payments_not_configured', hint: 'Stripe keys are not set on the API yet.' });
    }
    const account = store.users.get(req.user.id) || {};
    const email = account.email || req.user.email;
    let row = await getConnectAccountByUserId(req.user.id);
    if (!row || !row.stripeAccountId) {
      const stripeAccount = await createConnectAccount({ email, userId: req.user.id });
      row = await upsertConnectAccount(req.user.id, {
        companyId: req.companyId,
        stripeAccountId: stripeAccount.id,
        status: 'ONBOARDING',
      });
    }
    const link = await createConnectAccountLink({
      accountId: row.stripeAccountId,
      refreshUrl: `${LISTING_SITE_BASE}/?connect=refresh`,
      returnUrl: `${LISTING_SITE_BASE}/?connect=returned`,
    });
    return res.status(201).json({ data: { url: link.url, account: publicConnectAccount(row) } });
  } catch (error) {
    if (error?.code === 'stripe_error') return res.status(502).json({ error: 'stripe_error', message: error.message });
    return next(error);
  }
});

router.get('/pepper-lists/connect/status', authenticate, requireCompany, async (req, res, next) => {
  try {
    const setting = await getPaymentsSetting();
    let row = await getConnectAccountByUserId(req.user.id);
    // Refresh from Stripe — the row mirrors what Stripe reports,
    // never what we hope. Best effort: a Stripe outage leaves the
    // last known state in place rather than failing the read.
    if (row?.stripeAccountId && stripeConfigured()) {
      try {
        const live = await retrieveConnectAccount(row.stripeAccountId);
        const chargesEnabled = Boolean(live.charges_enabled);
        const status = chargesEnabled
          ? 'ACTIVE'
          : (live.requirements?.disabled_reason ? 'RESTRICTED' : row.status === 'NOT_STARTED' ? 'ONBOARDING' : row.status);
        row = await upsertConnectAccount(req.user.id, {
          companyId: req.companyId,
          chargesEnabled,
          payoutsEnabled: Boolean(live.payouts_enabled),
          detailsSubmitted: Boolean(live.details_submitted),
          status,
        });
      } catch { /* keep the last known state */ }
    }
    return res.json({ data: { enabled: setting.connectEnabled, account: publicConnectAccount(row) } });
  } catch (error) {
    return next(error);
  }
});

router.post('/pepper-lists/listings/:reference/buy', authenticate, requireCompany, async (req, res, next) => {
  try {
    const setting = await getPaymentsSetting();
    if (!setting.connectEnabled) return connectOff(res, setting);
    if (!stripeConfigured()) {
      return res.status(503).json({ error: 'payments_not_configured', hint: 'Stripe keys are not set on the API yet.' });
    }
    if (setting.connectFeeBps == null) {
      return res.status(422).json({
        error: 'pricing_not_set',
        message: 'Protected payments are not priced yet — the office has not set the platform fee, so checkout is unavailable.',
      });
    }
    const found = getListingByReference(req.params.reference);
    if (!found) return res.status(404).json({ error: 'Listing not found' });
    const { connection, listing } = found;

    const seller = await findUserByEmail(connection.email, req.companyId);
    if (!seller) {
      return res.status(422).json({ error: 'seller_not_ready', message: 'This seller has not finished setting up protected payments yet.' });
    }
    if (seller.id === req.user.id) {
      return res.status(400).json({ error: 'You cannot buy your own listing' });
    }
    const sellerAccount = await getConnectAccountByUserId(seller.id);
    if (!sellerAccount?.stripeAccountId || sellerAccount.status !== 'ACTIVE' || !sellerAccount.chargesEnabled) {
      return res.status(422).json({ error: 'seller_not_ready', message: 'This seller has not finished setting up protected payments yet.' });
    }

    const sold = await findOrderForListing(connection.id, ['PAID']);
    if (sold) return res.status(409).json({ error: 'already_sold', message: 'This listing has already been sold.' });

    // Reuse a live pending session for this buyer instead of
    // minting duplicates (the diagnostic checkout idiom).
    const pending = await findOrderForListing(connection.id, ['PENDING']);
    if (pending && pending.buyerUserId === req.user.id && pending.checkoutUrl
      && Date.now() - new Date(pending.createdAt).getTime() < 23 * 60 * 60 * 1000) {
      return res.json({ data: { url: pending.checkoutUrl, orderId: pending.id, reused: true } });
    }

    const buyerAccount = store.users.get(req.user.id) || {};
    const feeCents = computeFeeCents(listing.priceCents, setting.connectFeeBps);
    let order = await createOrder({
      companyId: req.companyId,
      listingConnectionId: connection.id,
      listingReference: listing.reference,
      sellerUserId: seller.id,
      buyerUserId: req.user.id,
      buyerEmail: buyerAccount.email || req.user.email || null,
      amountCents: listing.priceCents,
      feeCents,
      currency: 'usd',
      sellerStripeAccountId: sellerAccount.stripeAccountId,
    });
    const session = await createConnectCheckout({
      order,
      listingTitle: listing.title,
      sellerAccountId: sellerAccount.stripeAccountId,
      successUrl: `${LISTING_SITE_BASE}/listing/${encodeURIComponent(listing.reference)}?payment=success`,
      cancelUrl: `${LISTING_SITE_BASE}/listing/${encodeURIComponent(listing.reference)}?payment=cancelled`,
    });
    order = await updateOrder(order.id, {
      stripeSessionId: session.id,
      stripePaymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : null,
      checkoutUrl: session.url,
    });
    await appendEvent('PEPPER_LISTS_ORDER_CHECKOUT_CREATED', {
      source: 'pepper-lists', entityType: 'PEPPER_LISTS_ORDER', entityId: order.id,
      referenceCode: listing.reference,
      details: { amountCents: order.amountCents, feeCents: order.feeCents, sellerUserId: seller.id },
    });
    return res.status(201).json({ data: { url: session.url, orderId: order.id } });
  } catch (error) {
    if (error?.code === 'stripe_error') return res.status(502).json({ error: 'stripe_error', message: error.message });
    return next(error);
  }
});

router.get('/pepper-lists/orders/mine', authenticate, requireCompany, async (req, res, next) => {
  try {
    const orders = await listOrdersForUser(req.user.id);
    return res.json({
      data: {
        asBuyer: orders.filter((o) => o.buyerUserId === req.user.id).map((o) => publicOrder(o)),
        asSeller: orders.filter((o) => o.sellerUserId === req.user.id).map((o) => publicOrder(o, { sellerView: true })),
      },
    });
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// F6 — Gift cards
// ---------------------------------------------------------------------------

router.get('/gift-cards/config', async (req, res, next) => {
  try {
    const setting = await getPaymentsSetting();
    return res.json({
      data: {
        salesEnabled: setting.giftCardDenominationsCents.length > 0,
        denominationsCents: setting.giftCardDenominationsCents,
        currency: 'usd',
      },
    });
  } catch (error) {
    return next(error);
  }
});

const purchaseSchema = z.object({
  denominationCents: z.number().int().min(100).max(100000),
  recipientEmail: z.string().email().max(200).optional(),
});

router.post('/gift-cards/purchase', authenticate, requireCompany, async (req, res, next) => {
  try {
    const parsed = purchaseSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid gift card purchase', details: parsed.error.flatten() });
    const setting = await getPaymentsSetting();
    if (!setting.giftCardDenominationsCents.includes(parsed.data.denominationCents)) {
      return res.status(422).json({
        error: 'pricing_not_set',
        message: 'Gift cards are not on sale yet — the office has not set the amounts. Please check back soon.',
      });
    }
    if (!stripeConfigured()) {
      return res.status(503).json({ error: 'payments_not_configured', hint: 'Stripe keys are not set on the API yet.' });
    }
    const account = store.users.get(req.user.id) || {};
    const purchaserEmail = account.email || req.user.email || null;
    const code = generateGiftCardCode();
    let card = await createGiftCard({
      companyId: req.companyId,
      codeHash: hashGiftCardCode(code),
      codeLast4: giftCardLast4(code),
      initialAmountCents: parsed.data.denominationCents,
      currency: 'usd',
      purchaserUserId: req.user.id,
      purchaserEmail,
      recipientEmail: parsed.data.recipientEmail || null,
    });
    let session;
    try {
      session = await createGiftCardCheckout({
        card,
        successUrl: `${APP_BASE}/gift-cards?payment=success`,
        cancelUrl: `${APP_BASE}/gift-cards?payment=cancelled`,
      });
    } catch (error) {
      await updateGiftCard(card.id, { status: 'VOID' }).catch(() => {});
      throw error;
    }
    card = await updateGiftCard(card.id, {
      stripeSessionId: session.id,
      stripePaymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : null,
      checkoutUrl: session.url,
    });
    // The code is delivered exactly once, here and by email. The
    // card activates only when Stripe's webhook confirms payment —
    // an unpaid code redeems nothing.
    const deliverTo = card.recipientEmail || purchaserEmail;
    if (deliverTo) {
      queueNotification({
        channel: 'email', template: NOTIFICATION_TEMPLATES.GIFT_CARD_ISSUED, to: deliverTo,
        payload: {
          subject: 'Your Top Speed Appliance gift card',
          message: `Here is your Top Speed Appliance gift card for $${(card.initialAmountCents / 100).toFixed(2)}.\n\nGift card code: ${code}\n\nThe card activates as soon as your payment completes (you will get a second email then). Enter the code when you book or pay and the balance comes off your diagnostic or repair. Keep this email — the code cannot be shown again. — Top Speed Appliance.`,
        },
        source: 'marketplace-payments', eventKey: `giftcard:${card.id}:issued:email`, eventType: 'PAYMENT',
      });
    }
    return res.status(201).json({
      data: { url: session.url, giftCardId: card.id, code, codeLast4: card.codeLast4, amountCents: card.initialAmountCents, status: card.status },
    });
  } catch (error) {
    if (error?.code === 'stripe_error') return res.status(502).json({ error: 'stripe_error', message: error.message });
    return next(error);
  }
});

router.get('/gift-cards/mine', authenticate, requireCompany, async (req, res, next) => {
  try {
    const cards = await listGiftCardsForPurchaser(req.user.id);
    return res.json({ data: { giftCards: cards.map(publicGiftCard) } });
  } catch (error) {
    return next(error);
  }
});

const codeSchema = z.object({ code: z.string().trim().min(8).max(40) });

router.post('/gift-cards/balance', authenticate, requireCompany, async (req, res, next) => {
  try {
    const parsed = codeSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid code' });
    const card = await getGiftCardByHash(hashGiftCardCode(parsed.data.code));
    if (!card || card.companyId !== req.companyId) return res.status(404).json({ error: 'Gift card not found' });
    return res.json({
      data: {
        codeLast4: card.codeLast4, status: card.status,
        initialAmountCents: card.initialAmountCents, balanceCents: card.balanceCents,
      },
    });
  } catch (error) {
    return next(error);
  }
});

const redeemSchema = z.object({
  code: z.string().trim().min(8).max(40),
  bookingId: z.string().min(1).optional(),
  bookingReference: z.string().trim().min(3).max(40).optional(),
  amountCents: z.number().int().min(1).max(100000).optional(),
});

router.post('/gift-cards/redeem', authenticate, requireCompany, async (req, res, next) => {
  try {
    const parsed = redeemSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid redemption', details: parsed.error.flatten() });
    const data = parsed.data;

    let booking = data.bookingId ? store.bookings.get(data.bookingId) : null;
    if (!booking && data.bookingReference) {
      booking = [...store.bookings.values()].find((b) => b.referenceCode === data.bookingReference) || null;
    }
    if (!booking || booking.companyId !== req.companyId) return res.status(404).json({ error: 'Booking not found' });

    // Same ownership gate as the diagnostic checkout: staff, or the
    // customer the booking belongs to.
    const roles = req.user?.roles || [];
    const isStaff = roles.some((role) => STAFF_ROLES.includes(role));
    const isOwningCustomer = roles.includes(ROLES.CUSTOMER)
      && booking.customer?.email && req.user?.email
      && booking.customer.email.toLowerCase() === req.user.email.toLowerCase();
    if (!isStaff && !isOwningCustomer) return res.status(403).json({ error: 'This booking belongs to a different account' });

    const card = await getGiftCardByHash(hashGiftCardCode(data.code));
    if (!card || card.companyId !== req.companyId) return res.status(404).json({ error: 'Gift card not found' });
    if (card.status === 'PENDING') {
      return res.status(409).json({ error: 'gift_card_not_active', message: 'This gift card has not activated yet — it activates when its purchase payment completes.' });
    }
    if (card.status !== 'ACTIVE') {
      return res.status(409).json({ error: 'gift_card_not_active', message: 'This gift card has no balance available.' });
    }

    // The booking's real outstanding diagnostic: the fixed $99,
    // minus Stripe payments already PAID, minus gift card value
    // already redeemed against it. Nothing else is owed here —
    // repairs are quoted and invoiced separately, as always.
    let stripePaidCents = 0;
    for (const payment of store.payments.values()) {
      if (payment.bookingId === booking.id && payment.status === 'PAID') stripePaidCents += payment.amountCents;
    }
    const alreadyRedeemedCents = await sumRedeemedForBooking(booking.id);
    const outstandingCents = DIAGNOSTIC_AMOUNT_CENTS - stripePaidCents - alreadyRedeemedCents;
    if (outstandingCents <= 0) {
      return res.status(409).json({ error: 'already_paid', message: 'This booking\u2019s diagnostic is already fully paid.' });
    }

    const requested = data.amountCents ?? card.balanceCents;
    const appliedCents = Math.min(requested, card.balanceCents, outstandingCents);
    if (appliedCents <= 0) {
      return res.status(409).json({ error: 'nothing_to_apply', message: 'There is nothing to apply this gift card to on this booking.' });
    }

    const result = await redeemGiftCard({
      giftCardId: card.id,
      amountCents: appliedCents,
      bookingId: booking.id,
      createdById: req.user.id,
      note: `Applied to booking ${booking.referenceCode || booking.id} diagnostic`,
    });
    if (!result.ok) {
      return res.status(409).json({ error: 'gift_card_not_active', message: 'This gift card could not be applied — check its balance and try again.' });
    }

    const remainingDueCents = outstandingCents - appliedCents;
    await appendEvent('GIFT_CARD_REDEEMED', {
      source: 'gift-card', entityType: 'GIFT_CARD', entityId: card.id,
      referenceCode: booking.referenceCode || null,
      details: { bookingId: booking.id, amountCents: appliedCents, remainingDueCents },
    });
    let diagnosticPaid = false;
    if (remainingDueCents === 0) {
      // The diagnostic is now fully settled: record the PAID
      // payment row the whole platform reads (the same shape the
      // Stripe webhook writes). Its amount is the gift-card-funded
      // portion of the diagnostic (the whole $99 when gift cards
      // covered it all; less when Stripe covered part earlier).
      const giftFundedCents = alreadyRedeemedCents + appliedCents;
      const payment = {
        id: createId(),
        companyId: booking.companyId,
        bookingId: booking.id,
        customerId: booking.customerId ?? null,
        purpose: 'DIAGNOSTIC',
        amountCents: giftFundedCents,
        currency: 'usd',
        status: 'PAID',
        stripeSessionId: null,
        stripePaymentIntentId: null,
        checkoutUrl: null,
        paidAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      store.payments.set(payment.id, payment);
      await persistPayment(payment).catch((error) => console.error(JSON.stringify({ level: 'error', message: 'gift card payment persist failed', error: String(error?.message || error) })));
      addBookingEvent(booking, 'PAYMENT_RECEIVED', 'Gift card redemption', { amountCents: giftFundedCents, purpose: 'DIAGNOSTIC', via: 'GIFT_CARD', giftCardId: card.id });
      await appendEvent('PAYMENT_RECEIVED', {
        source: 'gift-card', entityType: 'PAYMENT', entityId: payment.id,
        referenceCode: booking.referenceCode || null,
        details: { bookingId: booking.id, amountCents: giftFundedCents, via: 'GIFT_CARD', giftCardId: card.id },
      });
      diagnosticPaid = true;
    } else {
      addBookingEvent(booking, 'GIFT_CARD_APPLIED', 'Gift card redemption', { amountCents: appliedCents, remainingDueCents, giftCardId: card.id });
    }

    return res.json({
      data: {
        appliedCents,
        remainingDueCents,
        diagnosticPaid,
        giftCard: {
          codeLast4: result.card.codeLast4,
          balanceCents: result.card.balanceCents,
          status: result.card.status,
        },
        bookingReference: booking.referenceCode || null,
      },
    });
  } catch (error) {
    return next(error);
  }
});

export default router;
