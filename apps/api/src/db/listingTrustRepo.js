import { createId } from '../data/store.js';
import { DATABASE_ENABLED, db } from './client.js';

/**
 * Pepper Lists Trust & Growth persistence (2026-11-20) — listing
 * profiles, listing comments, listing reports, completed sales,
 * seller reviews and the bump ledger. Mirrors the reviewsRepo
 * pattern: an in-memory working set for this process plus
 * write-through to the trust tables when the database is enabled,
 * with database reads merged in so everything survives a cold start.
 * A persistence hiccup never fails the customer's action — the
 * in-memory copy still serves this process.
 *
 * Listings are Connection records (type PEPPER_LISTS_SELL); every
 * listingId here is a Connection id, stored as a plain reference —
 * the same discipline the Review tables use for bookingId.
 */
const profiles = new Map(); // connectionId -> profile row
const comments = new Map(); // commentId -> comment row
const reports = new Map(); // reportId -> report row
const sales = new Map(); // saleId -> sale row
const sellerReviews = new Map(); // reviewId -> seller review row
const bumps = []; // bump rows
const savedListings = []; // saved-listing rows (private per user)

const iso = (value) => (value instanceof Date ? value.toISOString() : String(value));

function profileFromDb(row) {
  return {
    id: row.id,
    connectionId: row.connectionId,
    sellerUserId: row.sellerUserId || null,
    status: row.status || 'ACTIVE',
    featured: Boolean(row.featured),
    bumpedAt: row.bumpedAt ? iso(row.bumpedAt) : null,
    viewCount: row.viewCount ?? 0,
    soldAt: row.soldAt ? iso(row.soldAt) : null,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function commentFromDb(row) {
  return {
    id: row.id,
    listingId: row.listingId,
    authorId: row.authorId,
    authorKind: row.authorKind,
    body: row.body,
    hidden: Boolean(row.hidden),
    removed: Boolean(row.removed),
    createdAt: iso(row.createdAt),
  };
}

function reportFromDb(row) {
  return {
    id: row.id,
    listingId: row.listingId,
    reporterId: row.reporterId,
    reason: row.reason,
    details: row.details || null,
    status: row.status || 'NEW',
    createdAt: iso(row.createdAt),
  };
}

function saleFromDb(row) {
  return {
    id: row.id,
    listingId: row.listingId,
    sellerId: row.sellerId,
    buyerId: row.buyerId || null,
    buyerEmail: row.buyerEmail || null,
    completedAt: iso(row.completedAt),
    createdAt: iso(row.createdAt),
  };
}

function sellerReviewFromDb(row) {
  return {
    id: row.id,
    saleId: row.saleId,
    sellerId: row.sellerId,
    buyerId: row.buyerId,
    rating: row.rating,
    title: row.title,
    body: row.body,
    status: row.status || 'PUBLISHED',
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function bumpFromDb(row) {
  return { id: row.id, listingId: row.listingId, sellerId: row.sellerId, createdAt: iso(row.createdAt) };
}

function savedFromDb(row) {
  return { id: row.id, userId: row.userId, listingId: row.listingId, createdAt: iso(row.createdAt) };
}

async function persist(label, fn) {
  if (!DATABASE_ENABLED) return;
  try {
    await fn();
  } catch (error) {
    console.error(`${label} persist failed`, error?.message || error);
  }
}

/* ------------------------------ profiles ------------------------------ */

export async function getListingProfile(connectionId) {
  const inMemory = profiles.get(connectionId);
  if (inMemory) return inMemory;
  if (DATABASE_ENABLED) {
    try {
      const row = await db().listingProfile.findUnique({ where: { connectionId } });
      if (row) {
        const mapped = profileFromDb(row);
        profiles.set(connectionId, mapped);
        return mapped;
      }
    } catch (error) {
      console.error('getListingProfile failed', error?.message || error);
    }
  }
  return null;
}

export async function upsertListingProfile(connectionId, patch) {
  const now = new Date().toISOString();
  let row = await getListingProfile(connectionId);
  if (!row) {
    row = {
      id: createId(),
      connectionId,
      sellerUserId: patch.sellerUserId ?? null,
      status: patch.status || 'ACTIVE',
      featured: Boolean(patch.featured),
      bumpedAt: patch.bumpedAt ?? null,
      viewCount: patch.viewCount ?? 0,
      soldAt: patch.soldAt ?? null,
      createdAt: now,
      updatedAt: now,
    };
    profiles.set(connectionId, row);
    await persist('createListingProfile', () => db().listingProfile.create({
      data: {
        id: row.id, connectionId: row.connectionId, sellerUserId: row.sellerUserId,
        status: row.status, featured: row.featured,
        bumpedAt: row.bumpedAt ? new Date(row.bumpedAt) : null,
        viewCount: row.viewCount,
        soldAt: row.soldAt ? new Date(row.soldAt) : null,
        createdAt: new Date(row.createdAt), updatedAt: new Date(row.updatedAt),
      },
    }));
    return row;
  }
  Object.assign(row, patch, { updatedAt: now });
  profiles.set(connectionId, row);
  await persist('updateListingProfile', () => db().listingProfile.update({
    where: { connectionId },
    data: {
      sellerUserId: row.sellerUserId, status: row.status, featured: row.featured,
      bumpedAt: row.bumpedAt ? new Date(row.bumpedAt) : null,
      viewCount: row.viewCount,
      soldAt: row.soldAt ? new Date(row.soldAt) : null,
      updatedAt: new Date(row.updatedAt),
    },
  }));
  return row;
}

export async function incrementListingViews(connectionId) {
  const row = await upsertListingProfile(connectionId, {});
  row.viewCount = (row.viewCount || 0) + 1;
  row.updatedAt = new Date().toISOString();
  profiles.set(connectionId, row);
  await persist('incrementListingViews', () => db().listingProfile.update({
    where: { connectionId },
    data: { viewCount: { increment: 1 }, updatedAt: new Date(row.updatedAt) },
  }));
  return row;
}

/** All profiles, memory merged with DB — used by the public feed's sort. */
export async function listListingProfiles() {
  const byConn = new Map(profiles);
  if (DATABASE_ENABLED) {
    try {
      const rows = await db().listingProfile.findMany({});
      for (const row of rows) {
        if (!byConn.has(row.connectionId)) byConn.set(row.connectionId, profileFromDb(row));
      }
    } catch (error) {
      console.error('listListingProfiles failed', error?.message || error);
    }
  }
  return [...byConn.values()];
}

/* ------------------------------ comments ------------------------------ */

export async function createListingComment(input) {
  const row = {
    id: createId(),
    listingId: input.listingId,
    authorId: input.authorId,
    authorKind: input.authorKind || 'USER',
    body: input.body,
    hidden: false,
    removed: false,
    createdAt: new Date().toISOString(),
  };
  comments.set(row.id, row);
  await persist('createListingComment', () => db().listingComment.create({
    data: {
      id: row.id, listingId: row.listingId, authorId: row.authorId,
      authorKind: row.authorKind, body: row.body,
      hidden: false, removed: false, createdAt: new Date(row.createdAt),
    },
  }));
  return row;
}

export async function getListingComment(id) {
  const inMemory = comments.get(id);
  if (inMemory) return inMemory;
  if (DATABASE_ENABLED) {
    try {
      const row = await db().listingComment.findUnique({ where: { id } });
      if (row) {
        const mapped = commentFromDb(row);
        comments.set(id, mapped);
        return mapped;
      }
    } catch (error) {
      console.error('getListingComment failed', error?.message || error);
    }
  }
  return null;
}

export async function updateListingComment(id, patch) {
  const row = await getListingComment(id);
  if (!row) return null;
  Object.assign(row, patch);
  comments.set(id, row);
  await persist('updateListingComment', () => db().listingComment.update({
    where: { id },
    data: { hidden: row.hidden, removed: row.removed },
  }));
  return row;
}

/** All comments on one listing, oldest first, memory merged with DB. */
export async function listListingComments(listingId) {
  const byId = new Map();
  for (const row of comments.values()) if (row.listingId === listingId) byId.set(row.id, row);
  if (DATABASE_ENABLED) {
    try {
      const rows = await db().listingComment.findMany({ where: { listingId }, orderBy: { createdAt: 'asc' } });
      for (const row of rows) if (!byId.has(row.id)) byId.set(row.id, commentFromDb(row));
    } catch (error) {
      console.error('listListingComments failed', error?.message || error);
    }
  }
  return [...byId.values()].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

/** Visible-comment counts per listing (hidden/removed never count). */
export async function countVisibleComments(listingIds) {
  const counts = new Map(listingIds.map((id) => [id, 0]));
  const seen = new Set();
  const tally = (row) => {
    if (seen.has(row.id)) return;
    seen.add(row.id);
    if (counts.has(row.listingId) && !row.hidden && !row.removed) {
      counts.set(row.listingId, counts.get(row.listingId) + 1);
    }
  };
  for (const row of comments.values()) tally(row);
  if (DATABASE_ENABLED && listingIds.length) {
    try {
      const rows = await db().listingComment.findMany({ where: { listingId: { in: listingIds } } });
      for (const row of rows) tally(commentFromDb(row));
    } catch (error) {
      console.error('countVisibleComments failed', error?.message || error);
    }
  }
  return counts;
}

/* ------------------------------ reports ------------------------------- */

export async function createListingReport(input) {
  const row = {
    id: createId(),
    listingId: input.listingId,
    reporterId: input.reporterId,
    reason: input.reason,
    details: input.details || null,
    status: 'NEW',
    createdAt: new Date().toISOString(),
  };
  reports.set(row.id, row);
  await persist('createListingReport', () => db().listingReport.create({
    data: {
      id: row.id, listingId: row.listingId, reporterId: row.reporterId,
      reason: row.reason, details: row.details, status: row.status,
      createdAt: new Date(row.createdAt),
    },
  }));
  return row;
}

export async function listListingReports({ status = null } = {}) {
  const byId = new Map(reports);
  if (DATABASE_ENABLED) {
    try {
      const rows = await db().listingReport.findMany({ orderBy: { createdAt: 'desc' } });
      for (const row of rows) if (!byId.has(row.id)) byId.set(row.id, reportFromDb(row));
    } catch (error) {
      console.error('listListingReports failed', error?.message || error);
    }
  }
  return [...byId.values()]
    .filter((row) => (status ? row.status === status : true))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export async function updateListingReport(id, patch) {
  let row = reports.get(id) || null;
  if (!row && DATABASE_ENABLED) {
    try {
      const dbRow = await db().listingReport.findUnique({ where: { id } });
      if (dbRow) { row = reportFromDb(dbRow); reports.set(id, row); }
    } catch (error) {
      console.error('getListingReport failed', error?.message || error);
    }
  }
  if (!row) return null;
  Object.assign(row, patch);
  reports.set(id, row);
  await persist('updateListingReport', () => db().listingReport.update({
    where: { id },
    data: { status: row.status },
  }));
  return row;
}

/* -------------------------------- sales ------------------------------- */

export async function createSellerSale(input) {
  const now = new Date().toISOString();
  const row = {
    id: createId(),
    listingId: input.listingId,
    sellerId: input.sellerId,
    buyerId: input.buyerId || null,
    buyerEmail: input.buyerEmail || null,
    completedAt: now,
    createdAt: now,
  };
  sales.set(row.id, row);
  await persist('createSellerSale', () => db().sellerSale.create({
    data: {
      id: row.id, listingId: row.listingId, sellerId: row.sellerId,
      buyerId: row.buyerId, buyerEmail: row.buyerEmail,
      completedAt: new Date(row.completedAt), createdAt: new Date(row.createdAt),
    },
  }));
  return row;
}

async function allSales() {
  const byId = new Map(sales);
  if (DATABASE_ENABLED) {
    try {
      const rows = await db().sellerSale.findMany({ orderBy: { completedAt: 'desc' } });
      for (const row of rows) if (!byId.has(row.id)) byId.set(row.id, saleFromDb(row));
    } catch (error) {
      console.error('listSellerSales failed', error?.message || error);
    }
  }
  return [...byId.values()];
}

export async function getSaleByListing(listingId) {
  return (await allSales()).find((s) => s.listingId === listingId) || null;
}

export async function listSalesBySeller(sellerId) {
  return (await allSales()).filter((s) => s.sellerId === sellerId);
}

export async function listSalesByBuyer(buyerId) {
  return (await allSales()).filter((s) => s.buyerId && s.buyerId === buyerId);
}

/* ---------------------------- seller reviews --------------------------- */

export async function createSellerReview(input) {
  const now = new Date().toISOString();
  const row = {
    id: createId(),
    saleId: input.saleId,
    sellerId: input.sellerId,
    buyerId: input.buyerId,
    rating: input.rating,
    title: input.title,
    body: input.body,
    status: input.status || 'PUBLISHED',
    createdAt: now,
    updatedAt: now,
  };
  sellerReviews.set(row.id, row);
  await persist('createSellerReview', () => db().sellerReview.create({
    data: {
      id: row.id, saleId: row.saleId, sellerId: row.sellerId, buyerId: row.buyerId,
      rating: row.rating, title: row.title, body: row.body, status: row.status,
      createdAt: new Date(row.createdAt), updatedAt: new Date(row.updatedAt),
    },
  }));
  return row;
}

async function allSellerReviews() {
  const byId = new Map(sellerReviews);
  if (DATABASE_ENABLED) {
    try {
      const rows = await db().sellerReview.findMany({ orderBy: { createdAt: 'desc' } });
      for (const row of rows) if (!byId.has(row.id)) byId.set(row.id, sellerReviewFromDb(row));
    } catch (error) {
      console.error('listSellerReviews failed', error?.message || error);
    }
  }
  return [...byId.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export async function listSellerReviews({ sellerId = null, status = null } = {}) {
  return (await allSellerReviews())
    .filter((row) => (sellerId ? row.sellerId === sellerId : true))
    .filter((row) => (status ? row.status === status : true));
}

export async function getSellerReviewBySale(saleId) {
  return (await allSellerReviews()).find((r) => r.saleId === saleId) || null;
}

export async function getSellerReview(id) {
  return (await allSellerReviews()).find((r) => r.id === id) || null;
}

export async function updateSellerReview(id, patch) {
  const row = await getSellerReview(id);
  if (!row) return null;
  Object.assign(row, patch, { updatedAt: new Date().toISOString() });
  sellerReviews.set(id, row);
  await persist('updateSellerReview', () => db().sellerReview.update({
    where: { id },
    data: { status: row.status, updatedAt: new Date(row.updatedAt) },
  }));
  return row;
}

/* -------------------------------- bumps -------------------------------- */

export async function createListingBump(input) {
  const row = {
    id: createId(),
    listingId: input.listingId,
    sellerId: input.sellerId,
    createdAt: new Date().toISOString(),
  };
  bumps.push(row);
  await persist('createListingBump', () => db().listingBump.create({
    data: { id: row.id, listingId: row.listingId, sellerId: row.sellerId, createdAt: new Date(row.createdAt) },
  }));
  return row;
}

export async function countBumpsSince(sellerId, sinceIso) {
  const seen = new Set();
  let count = 0;
  const tally = (row) => {
    if (seen.has(row.id)) return;
    seen.add(row.id);
    if (row.sellerId === sellerId && String(row.createdAt) >= String(sinceIso)) count += 1;
  };
  for (const row of bumps) tally(row);
  if (DATABASE_ENABLED) {
    try {
      const rows = await db().listingBump.findMany({ where: { sellerId, createdAt: { gte: new Date(sinceIso) } } });
      for (const row of rows) tally(bumpFromDb(row));
    } catch (error) {
      console.error('countBumpsSince failed', error?.message || error);
    }
  }
  return count;
}

/* ---------------------------- saved listings --------------------------- */

/**
 * Saved listings (2026-11-21) — the customer's private save list.
 * Same discipline as the bump ledger: in-memory working set plus
 * write-through persistence, reads merged so a cold start still
 * serves the real list. A save is idempotent per (userId, listingId)
 * — saving twice is one row, and the @@unique index backs that up
 * in the database.
 */
export async function listSavedListings(userId) {
  const seen = new Set();
  const rows = [];
  const take = (row) => {
    if (!row || row.userId !== userId || seen.has(row.id)) return;
    seen.add(row.id);
    rows.push(row);
  };
  for (const row of savedListings) take(row);
  if (DATABASE_ENABLED) {
    try {
      const dbRows = await db().savedListing.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
      for (const row of dbRows) take(savedFromDb(row));
    } catch (error) {
      console.error('listSavedListings failed', error?.message || error);
    }
  }
  return rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export async function saveListing(input) {
  const existing = (await listSavedListings(input.userId)).find((row) => row.listingId === input.listingId);
  if (existing) return existing;
  const row = {
    id: createId(),
    userId: input.userId,
    listingId: input.listingId,
    createdAt: new Date().toISOString(),
  };
  savedListings.push(row);
  await persist('saveListing', () => db().savedListing.create({
    data: { id: row.id, userId: row.userId, listingId: row.listingId, createdAt: new Date(row.createdAt) },
  }));
  return row;
}

export async function unsaveListing(userId, listingId) {
  let removed = false;
  for (let i = savedListings.length - 1; i >= 0; i -= 1) {
    if (savedListings[i].userId === userId && savedListings[i].listingId === listingId) {
      savedListings.splice(i, 1);
      removed = true;
    }
  }
  if (DATABASE_ENABLED) {
    try {
      const result = await db().savedListing.deleteMany({ where: { userId, listingId } });
      if (result.count > 0) removed = true;
    } catch (error) {
      console.error('unsaveListing failed', error?.message || error);
    }
  }
  return removed;
}
