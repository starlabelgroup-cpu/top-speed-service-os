import { store } from '../data/store.js';
import { DATABASE_ENABLED, db } from './client.js';

/**
 * Message-the-office persistence (2026-11-20, B2) — the per-booking
 * thread store. Hydrated into the store at cold start alongside
 * everything else; writes go to the store first and persist through
 * (fail-soft, the inbox/reviews discipline) so a database hiccup
 * never eats a customer's message to the office.
 */

function iso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function toStoreMessage(row) {
  return {
    id: row.id,
    companyId: row.companyId,
    bookingId: row.bookingId,
    senderKind: row.senderKind,
    senderUserId: row.senderUserId,
    senderName: row.senderName || null,
    body: row.body,
    readAt: iso(row.readAt),
    createdAt: iso(row.createdAt),
  };
}

export async function persistBookingMessage(message) {
  if (!DATABASE_ENABLED || !message?.id) return;
  try {
    const row = {
      id: message.id,
      companyId: message.companyId,
      bookingId: message.bookingId,
      senderKind: message.senderKind,
      senderUserId: message.senderUserId,
      senderName: message.senderName || null,
      body: message.body,
      readAt: message.readAt ? new Date(message.readAt) : null,
      createdAt: new Date(message.createdAt),
    };
    await db().bookingMessage.upsert({ where: { id: row.id }, update: row, create: row });
  } catch (error) {
    console.error('booking message persist failed', error?.message || error);
  }
}

/** Mark every message from the OTHER side of a thread as read. */
export async function persistThreadRead(bookingId, readerKind, atIso) {
  if (!DATABASE_ENABLED || !bookingId) return;
  try {
    await db().bookingMessage.updateMany({
      where: { bookingId, senderKind: { not: readerKind }, readAt: null },
      data: { readAt: new Date(atIso) },
    });
  } catch (error) {
    console.error('booking message read persist failed', error?.message || error);
  }
}

export async function hydrateBookingMessages() {
  if (!DATABASE_ENABLED) return 0;
  const rows = await db().bookingMessage.findMany({ orderBy: { createdAt: 'asc' } });
  store.bookingMessages = rows.map(toStoreMessage);
  return rows.length;
}
