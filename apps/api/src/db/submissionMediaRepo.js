import { createId } from '../data/store.js';
import { DATABASE_ENABLED, db } from './client.js';

/**
 * SubmissionMedia — the photo/video bytes a Pepper Lists customer
 * sends to the Service Setters with a scan & send submission
 * (routes/pepperLists.js). Mirrors the connectionsRepo pattern: an
 * in-memory working set for this process plus a write-through to the
 * SubmissionMedia table when the database is enabled, and a database
 * read fallback so staff can still fetch media after a cold start.
 * Media is only ever read back through the staff-gated endpoint —
 * it is never public and never served to other customers.
 */
const memory = new Map(); // connectionId -> [media rows]

export async function saveSubmissionMedia(connectionId, items) {
  const rows = (items || []).map((item) => ({
    id: createId(),
    connectionId,
    kind: item.kind,
    mime: item.mime,
    sizeBytes: item.sizeBytes,
    dataUrl: item.dataUrl,
    createdAt: new Date().toISOString(),
  }));
  if (rows.length) {
    const existing = memory.get(connectionId) || [];
    memory.set(connectionId, [...existing, ...rows]);
  }
  if (DATABASE_ENABLED) {
    for (const row of rows) {
      try {
        await db().submissionMedia.create({
          data: {
            id: row.id,
            connectionId: row.connectionId,
            kind: row.kind,
            mime: row.mime,
            sizeBytes: row.sizeBytes,
            dataUrl: row.dataUrl,
            createdAt: new Date(row.createdAt),
          },
        });
      } catch (error) {
        // The in-memory copy above still serves this process; a media
        // persistence hiccup must not fail the customer's submission.
        console.error('saveSubmissionMedia failed', error?.message || error);
      }
    }
  }
  return rows.map(({ dataUrl, ...rest }) => rest);
}

export async function listSubmissionMedia(connectionId) {
  const inMemory = memory.get(connectionId);
  if (inMemory && inMemory.length) return inMemory;
  if (DATABASE_ENABLED) {
    try {
      const rows = await db().submissionMedia.findMany({
        where: { connectionId },
        orderBy: { createdAt: 'asc' },
      });
      return rows.map((row) => ({
        id: row.id,
        connectionId: row.connectionId,
        kind: row.kind,
        mime: row.mime,
        sizeBytes: row.sizeBytes,
        dataUrl: row.dataUrl,
        createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
      }));
    } catch (error) {
      console.error('listSubmissionMedia failed', error?.message || error);
      return [];
    }
  }
  return [];
}

export async function getSubmissionMediaItem(connectionId, mediaId) {
  const rows = await listSubmissionMedia(connectionId);
  return rows.find((row) => row.id === mediaId) || null;
}

export async function countSubmissionMedia(connectionId) {
  // A count must never pull the media bytes themselves: in-memory rows
  // answer directly, and database mode uses a real COUNT query. The
  // full list read is only the last-resort fallback.
  const inMemory = memory.get(connectionId);
  if (inMemory) return inMemory.length;
  if (DATABASE_ENABLED) {
    try {
      return await db().submissionMedia.count({ where: { connectionId } });
    } catch (error) {
      console.error('countSubmissionMedia failed', error?.message || error);
      return 0;
    }
  }
  return 0;
}
