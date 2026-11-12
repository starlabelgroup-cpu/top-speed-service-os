import { Router } from 'express';
import { z } from 'zod';
import { createId, store } from '../data/store.js';
import {
  persistConnection,
  persistInvoice,
  persistSnapshot,
  publicConnectionState,
} from '../db/financeRepo.js';
import { partsSummary } from './parts.js';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { ROLES, STAFF_ROLES } from '../config/security.js';

/**
 * QuickBooks finance integration — BUILT DARK, by design.
 *
 * The deployed API holds no Intuit credentials and cannot call
 * QuickBooks itself. Pepper's QuickBooks connector (running with
 * Ramone's connected account) syncs real company data through the
 * owner-only POST /finance/sync below; the Service OS stores the
 * mirror and every OS surface (Finance page, Book OS, Local OS,
 * Marketing OS, Media OS) reads it with its sync timestamp.
 *
 * Until Ramone connects QuickBooks and a first sync lands, there is
 * no connection row — GET /finance/status reports not_connected and
 * every surface says exactly that. No figure is ever fabricated.
 */
const router = Router();

router.get('/finance/status', (req, res) => {
  return res.json({ data: { quickbooks: publicConnectionState() } });
});

const snapshotSchema = z.object({
  kind: z.enum(['pnl', 'ar_aging', 'ap_aging', 'overview']),
  periodLabel: z.string().trim().min(1).max(120),
  payload: z.record(z.string(), z.unknown()),
});

const invoiceSchema = z.object({
  qbId: z.string().trim().min(1).max(80),
  number: z.string().trim().max(40).optional(),
  customerName: z.string().trim().max(200).optional(),
  totalCents: z.number().int().min(0).max(2000000000),
  balanceCents: z.number().int().min(0).max(2000000000),
  status: z.string().trim().max(40).optional(),
  dueDate: z.string().trim().max(40).optional(),
  qbUrl: z.string().trim().max(500).optional(),
});

const syncSchema = z.object({
  connection: z.object({
    // The connected QuickBooks company may legitimately have no name
    // on its profile yet — a sync must still land truthfully.
    companyName: z.string().trim().max(200).optional(),
    realmHint: z.string().trim().max(80).optional(),
  }),
  snapshots: z.array(snapshotSchema).max(24).optional(),
  invoices: z.array(invoiceSchema).max(2000).optional(),
});

router.post('/finance/sync', authenticate, requireCompany, requireRole(ROLES.COMPANY_OWNER, ROLES.PLATFORM_ADMIN), async (req, res) => {
  const parsed = syncSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid sync payload', details: parsed.error.flatten() });
  }
  const t = new Date().toISOString();
  const existing = store.financeConnection;
  const connection = {
    id: existing?.id || createId(),
    provider: 'quickbooks',
    status: 'connected',
    companyName: parsed.data.connection.companyName || existing?.companyName || null,
    realmHint: parsed.data.connection.realmHint || existing?.realmHint || null,
    lastSyncAt: t,
    updatedBy: req.user?.id || null,
    createdAt: existing?.createdAt || t,
    updatedAt: t,
  };
  store.financeConnection = connection;
  await persistConnection({ ...connection, createdAt: connection.createdAt });

  let snapshotsStored = 0;
  for (const incoming of parsed.data.snapshots || []) {
    const prior = store.financeSnapshots.find((s) => s.kind === incoming.kind && s.periodLabel === incoming.periodLabel);
    const snapshot = {
      id: prior?.id || createId(),
      kind: incoming.kind,
      periodLabel: incoming.periodLabel,
      payload: incoming.payload,
      source: 'quickbooks-connector',
      syncedAt: t,
    };
    if (prior) Object.assign(prior, snapshot);
    else store.financeSnapshots.push(snapshot);
    await persistSnapshot(snapshot);
    snapshotsStored += 1;
  }

  let invoicesStored = 0;
  for (const incoming of parsed.data.invoices || []) {
    const prior = store.financeInvoices.find((inv) => inv.qbId === incoming.qbId);
    const invoice = {
      id: prior?.id || createId(),
      qbId: incoming.qbId,
      number: incoming.number || null,
      customerName: incoming.customerName || null,
      totalCents: incoming.totalCents,
      balanceCents: incoming.balanceCents,
      status: incoming.status || null,
      dueDate: incoming.dueDate || null,
      qbUrl: incoming.qbUrl || null,
      syncedAt: t,
    };
    if (prior) Object.assign(prior, invoice);
    else store.financeInvoices.push(invoice);
    await persistInvoice(invoice);
    invoicesStored += 1;
  }

  return res.json({
    data: {
      status: 'connected',
      companyName: connection.companyName,
      lastSyncAt: t,
      snapshotsStored,
      invoicesStored,
    },
  });
});

function latestSnapshot(kind) {
  const matches = store.financeSnapshots
    .filter((s) => s.kind === kind)
    .sort((a, b) => new Date(b.syncedAt) - new Date(a.syncedAt));
  return matches.length ? matches[0] : null;
}

router.get('/finance/overview', authenticate, requireCompany, requireRole(...STAFF_ROLES), (req, res) => {
  const connection = publicConnectionState();
  const openInvoices = store.financeInvoices.filter((inv) => inv.balanceCents > 0);
  return res.json({
    data: {
      quickbooks: connection,
      syncedAt: connection.lastSyncAt,
      snapshots: {
        pnl: latestSnapshot('pnl'),
        arAging: latestSnapshot('ar_aging'),
        apAging: latestSnapshot('ap_aging'),
        overview: latestSnapshot('overview'),
      },
      invoices: {
        count: store.financeInvoices.length,
        openCount: openInvoices.length,
        outstandingCents: openInvoices.reduce((sum, inv) => sum + inv.balanceCents, 0),
        list: [...store.financeInvoices]
          .sort((a, b) => new Date(a.dueDate || '9999-12-31') - new Date(b.dueDate || '9999-12-31'))
          .slice(0, 100),
      },
      parts: partsSummary(),
    },
  });
});

export default router;
