import { createId } from '../data/store.js';
import { DATABASE_ENABLED, db } from './client.js';

/**
 * Pepper Lists Reviews persistence — mirrors the submissionMediaRepo
 * pattern: an in-memory working set for this process plus write-through
 * to the Review / ReviewMedia / ReviewComment tables when the database
 * is enabled, with database reads merged in so reviews, media and
 * threads survive a cold start. A persistence hiccup never fails the
 * customer's action — the in-memory copy still serves this process
 * (the same tolerance saveSubmissionMedia established).
 *
 * In-memory media rows keep the bytes as a Buffer; database rows store
 * them in the ReviewMedia.data Bytes column.
 */
const reviews = new Map(); // reviewId -> review row
const mediaByReview = new Map(); // reviewId -> [media rows]
const commentsByReview = new Map(); // reviewId -> [comment rows]

const iso = (value) => (value instanceof Date ? value.toISOString() : String(value));

function reviewFromDb(row) {
  return {
    id: row.id,
    companyId: row.companyId,
    customerId: row.customerId,
    bookingId: row.bookingId || null,
    rating: row.rating,
    title: row.title,
    body: row.body,
    status: row.status,
    verifiedRepair: Boolean(row.verifiedRepair),
    escalated: Boolean(row.escalated),
    escalationReason: row.escalationReason || null,
    speedyReply: row.speedyReply || null,
    speedyReplyAt: row.speedyReplyAt ? iso(row.speedyReplyAt) : null,
    speedyReplyMode: row.speedyReplyMode || null,
    survey: row.survey || null,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function mediaFromDb(row) {
  return {
    id: row.id,
    reviewId: row.reviewId,
    kind: row.kind,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    data: Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data || []),
    createdAt: iso(row.createdAt),
  };
}

function commentFromDb(row) {
  return {
    id: row.id,
    reviewId: row.reviewId,
    authorId: row.authorId || null,
    authorKind: row.authorKind,
    body: row.body,
    createdAt: iso(row.createdAt),
  };
}

export async function createReview(input) {
  const now = new Date().toISOString();
  const row = {
    id: createId(),
    companyId: input.companyId,
    customerId: input.customerId,
    bookingId: input.bookingId || null,
    rating: input.rating,
    title: input.title,
    body: input.body,
    status: input.status || 'PENDING',
    verifiedRepair: Boolean(input.verifiedRepair),
    escalated: Boolean(input.escalated),
    escalationReason: input.escalationReason || null,
    speedyReply: null,
    speedyReplyAt: null,
    speedyReplyMode: null,
    survey: input.survey || null,
    createdAt: now,
    updatedAt: now,
  };
  reviews.set(row.id, row);
  if (DATABASE_ENABLED) {
    try {
      await db().review.create({
        data: {
          id: row.id,
          companyId: row.companyId,
          customerId: row.customerId,
          bookingId: row.bookingId,
          rating: row.rating,
          title: row.title,
          body: row.body,
          status: row.status,
          verifiedRepair: row.verifiedRepair,
          escalated: row.escalated,
          escalationReason: row.escalationReason,
          survey: row.survey || undefined,
          createdAt: new Date(row.createdAt),
          updatedAt: new Date(row.updatedAt),
        },
      });
    } catch (error) {
      console.error('createReview persist failed', error?.message || error);
    }
  }
  return row;
}

export async function updateReview(id, patch) {
  const row = reviews.get(id) || (await getReview(id));
  if (!row) return null;
  Object.assign(row, patch, { updatedAt: new Date().toISOString() });
  reviews.set(id, row);
  if (DATABASE_ENABLED) {
    try {
      await db().review.update({
        where: { id },
        data: {
          status: row.status,
          escalated: row.escalated,
          escalationReason: row.escalationReason,
          speedyReply: row.speedyReply,
          speedyReplyAt: row.speedyReplyAt ? new Date(row.speedyReplyAt) : null,
          speedyReplyMode: row.speedyReplyMode,
          updatedAt: new Date(row.updatedAt),
        },
      });
    } catch (error) {
      console.error('updateReview persist failed', error?.message || error);
    }
  }
  return row;
}

export async function getReview(id) {
  const inMemory = reviews.get(id);
  if (inMemory) return inMemory;
  if (DATABASE_ENABLED) {
    try {
      const row = await db().review.findUnique({ where: { id } });
      if (row) {
        const mapped = reviewFromDb(row);
        reviews.set(id, mapped);
        return mapped;
      }
    } catch (error) {
      console.error('getReview failed', error?.message || error);
    }
  }
  return null;
}

/** All reviews matching the filter, newest first, memory merged with DB. */
export async function listReviews({ customerId = null, status = null, escalatedOnly = false } = {}) {
  const byId = new Map(reviews);
  if (DATABASE_ENABLED) {
    try {
      const rows = await db().review.findMany({ orderBy: { createdAt: 'desc' } });
      for (const row of rows) {
        if (!byId.has(row.id)) byId.set(row.id, reviewFromDb(row));
      }
    } catch (error) {
      console.error('listReviews failed', error?.message || error);
    }
  }
  return [...byId.values()]
    .filter((row) => (customerId ? row.customerId === customerId : true))
    .filter((row) => (status ? row.status === status : true))
    .filter((row) => (escalatedOnly ? row.escalated : true))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export async function addReviewMedia(reviewId, items) {
  const rows = (items || []).map((item) => ({
    id: createId(),
    reviewId,
    kind: item.kind,
    mimeType: item.mimeType,
    sizeBytes: item.sizeBytes,
    data: item.data,
    createdAt: new Date().toISOString(),
  }));
  if (rows.length) {
    const existing = mediaByReview.get(reviewId) || [];
    mediaByReview.set(reviewId, [...existing, ...rows]);
  }
  if (DATABASE_ENABLED) {
    for (const row of rows) {
      try {
        await db().reviewMedia.create({
          data: {
            id: row.id,
            reviewId: row.reviewId,
            kind: row.kind,
            mimeType: row.mimeType,
            sizeBytes: row.sizeBytes,
            data: row.data,
            createdAt: new Date(row.createdAt),
          },
        });
      } catch (error) {
        console.error('addReviewMedia persist failed', error?.message || error);
      }
    }
  }
  return rows.map(({ data, ...rest }) => rest);
}

export async function listReviewMedia(reviewId) {
  const inMemory = mediaByReview.get(reviewId);
  if (inMemory && inMemory.length) return inMemory;
  if (DATABASE_ENABLED) {
    try {
      const rows = await db().reviewMedia.findMany({
        where: { reviewId },
        orderBy: { createdAt: 'asc' },
      });
      const mapped = rows.map(mediaFromDb);
      if (mapped.length) mediaByReview.set(reviewId, mapped);
      return mapped;
    } catch (error) {
      console.error('listReviewMedia failed', error?.message || error);
      return [];
    }
  }
  return [];
}

export async function getReviewMediaItem(reviewId, mediaId) {
  const rows = await listReviewMedia(reviewId);
  return rows.find((row) => row.id === mediaId) || null;
}

export async function countReviewMedia(reviewId) {
  const inMemory = mediaByReview.get(reviewId);
  if (inMemory) return inMemory.length;
  if (DATABASE_ENABLED) {
    try {
      return await db().reviewMedia.count({ where: { reviewId } });
    } catch (error) {
      console.error('countReviewMedia failed', error?.message || error);
      return 0;
    }
  }
  return 0;
}

export async function addReviewComment(input) {
  const row = {
    id: createId(),
    reviewId: input.reviewId,
    authorId: input.authorId || null,
    authorKind: input.authorKind,
    body: input.body,
    createdAt: new Date().toISOString(),
  };
  const existing = commentsByReview.get(row.reviewId) || [];
  commentsByReview.set(row.reviewId, [...existing, row]);
  if (DATABASE_ENABLED) {
    try {
      await db().reviewComment.create({
        data: {
          id: row.id,
          reviewId: row.reviewId,
          authorId: row.authorId,
          authorKind: row.authorKind,
          body: row.body,
          createdAt: new Date(row.createdAt),
        },
      });
    } catch (error) {
      console.error('addReviewComment persist failed', error?.message || error);
    }
  }
  return row;
}

export async function listReviewComments(reviewId) {
  const inMemory = commentsByReview.get(reviewId);
  if (inMemory && inMemory.length) return inMemory;
  if (DATABASE_ENABLED) {
    try {
      const rows = await db().reviewComment.findMany({
        where: { reviewId },
        orderBy: { createdAt: 'asc' },
      });
      const mapped = rows.map(commentFromDb);
      if (mapped.length) commentsByReview.set(reviewId, mapped);
      return mapped;
    } catch (error) {
      console.error('listReviewComments failed', error?.message || error);
      return [];
    }
  }
  return [];
}
