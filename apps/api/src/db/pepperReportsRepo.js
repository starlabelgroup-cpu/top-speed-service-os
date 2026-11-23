import { createId } from '../data/store.js';
import { DATABASE_ENABLED, db } from './client.js';

/**
 * Pepper Reports — repository (2026-11-18).
 *
 * The report log of Pepper's duty post inside the Workstation (the
 * /pepper console). Same dual-mode discipline as the other repos:
 * Prisma when DATABASE_URL is set, an in-memory fallback with
 * identical shapes when it is not.
 *
 * Reports are plain staff-filed records: a title, a body, one of four
 * categories (STATUS / ACTION_TAKEN / NEEDS_OWNER / INCIDENT) and the
 * staff member who filed them. Nothing here invents content — the log
 * holds exactly what staff filed, newest first.
 */

export const PEPPER_REPORT_CATEGORIES = ['STATUS', 'ACTION_TAKEN', 'NEEDS_OWNER', 'INCIDENT'];

const memoryReports = [];

const AUTHOR_SELECT = { email: true, firstName: true, lastName: true, roles: true };

const prismaRepo = {
  async listRecent(limit = 50) {
    return db().pepperReport.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { createdBy: { select: AUTHOR_SELECT } },
    });
  },
  async create({ title, body, category, createdByUserId }) {
    return db().pepperReport.create({
      data: { title, body, category, createdByUserId: createdByUserId ?? null },
      include: { createdBy: { select: AUTHOR_SELECT } },
    });
  },
  // Owner record-keeping delete (2026-11-23): removes the row and
  // answers whether it existed, so the route can 404 honestly.
  async remove(id) {
    const existing = await db().pepperReport.findUnique({ where: { id } });
    if (!existing) return null;
    await db().pepperReport.delete({ where: { id } });
    return existing;
  },
};

const memoryRepo = {
  async listRecent(limit = 50) {
    return [...memoryReports]
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, limit);
  },
  async create({ title, body, category, createdByUserId }) {
    const row = {
      id: createId(),
      title,
      body,
      category,
      createdByUserId: createdByUserId ?? null,
      createdAt: new Date().toISOString(),
      createdBy: null,
    };
    memoryReports.push(row);
    return row;
  },
  async remove(id) {
    const index = memoryReports.findIndex((r) => r.id === id);
    if (index === -1) return null;
    const [row] = memoryReports.splice(index, 1);
    return row;
  },
};

export const pepperReportsRepo = DATABASE_ENABLED ? prismaRepo : memoryRepo;
