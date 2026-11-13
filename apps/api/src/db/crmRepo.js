import { DATABASE_ENABLED, db } from './client.js';
import { store } from '../data/store.js';

/**
 * Top Speed CRM persistence: staff notes on customer records.
 * Hydrated into store.crmNotes at startup (add-on module — a missing
 * table mid-deploy degrades to no notes, never blocks the platform)
 * and written through on every create, in the bookingsRepo pattern.
 */

export async function hydrateCrmNotes() {
  if (!DATABASE_ENABLED) return { skipped: true };
  const rows = await db().crmNote.findMany({ orderBy: { createdAt: 'asc' } });
  store.crmNotes = rows.map((row) => ({
    id: row.id,
    companyId: row.companyId,
    customerId: row.customerId,
    author: row.author,
    body: row.body,
    createdAt: row.createdAt?.toISOString?.() ?? row.createdAt,
  }));
  return { notes: rows.length };
}

export async function persistCrmNote(note) {
  if (!DATABASE_ENABLED || !note?.id) return;
  await db().crmNote.upsert({
    where: { id: note.id },
    update: { author: note.author, body: note.body },
    create: {
      id: note.id,
      companyId: note.companyId,
      customerId: note.customerId,
      author: note.author,
      body: note.body,
      createdAt: note.createdAt ? new Date(note.createdAt) : undefined,
    },
  });
}
