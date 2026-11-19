import { DATABASE_ENABLED, db } from './client.js';
import { store } from '../data/store.js';

/**
 * Tech App dispatch package persistence (2026-11-19): Property,
 * WarrantyClaim and Invoice — the records behind the full-package
 * Tech App rebuild. Same discipline as the rest of the platform: the
 * in-memory store is the working set, these functions are the
 * write-through bridge to PostgreSQL, and every function is a no-op
 * when DATABASE_URL is not set (skeleton mode). Hydration is an
 * add-on module: bookingsRepo calls it inside a try/catch so a missing
 * table mid-deploy degrades this module, never the platform.
 */

function num(value) {
  if (value === null || value === undefined) return value;
  return typeof value === 'number' ? value : Number(value);
}

function iso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function propertyFromRow(row) {
  return {
    id: row.id,
    companyId: row.companyId,
    customerId: row.customerId,
    label: row.label ?? null,
    address: row.address,
    city: row.city,
    zip: row.zip,
    unit: row.unit ?? null,
    accessNotes: row.accessNotes ?? null,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function warrantyFromRow(row) {
  return {
    id: row.id,
    companyId: row.companyId,
    serviceRequestId: row.serviceRequestId,
    customerId: row.customerId ?? null,
    applianceType: row.applianceType ?? null,
    brand: row.brand ?? null,
    model: row.model ?? null,
    serial: row.serial ?? null,
    provider: row.provider,
    coverage: row.coverage ?? null,
    policyNumber: row.policyNumber ?? null,
    expiresAt: iso(row.expiresAt),
    claimStatus: row.claimStatus || 'Not Filed',
    createdBy: row.createdBy ?? null,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function warrantyClaimFromRow(row) {
  return {
    id: row.id,
    companyId: row.companyId,
    serviceRequestId: row.serviceRequestId,
    assignmentId: row.assignmentId ?? null,
    customerId: row.customerId ?? null,
    warrantyId: row.warrantyId ?? null,
    claimNumber: row.claimNumber ?? null,
    warrantyProvider: row.warrantyProvider ?? null,
    authorization: row.authorization ?? null,
    status: row.status || 'OPEN',
    description: row.description,
    notes: row.notes ?? null,
    amountCents: row.amountCents ?? null,
    createdBy: row.createdBy ?? null,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function invoiceFromRow(row) {
  return {
    id: row.id,
    companyId: row.companyId,
    serviceRequestId: row.serviceRequestId,
    customerId: row.customerId,
    status: row.status || 'DRAFT',
    subtotal: num(row.subtotal) ?? 0,
    diagnosticFee: num(row.diagnosticFee) ?? 99,
    diagnosticCredit: num(row.diagnosticCredit) ?? 0,
    total: num(row.total) ?? 0,
    currency: row.currency || 'USD',
    // The estimate this invoice was generated from rides in memory
    // only (the Invoice table has no estimate column); after a cold
    // start it reads back null and the workspace shows the invoice on
    // its own facts.
    estimateId: null,
    createdBy: null,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export async function hydrateTechPackage() {
  if (!DATABASE_ENABLED) return { skipped: true };
  const prisma = db();

  const propertyRows = await prisma.property.findMany();
  store.properties.length = 0;
  for (const row of propertyRows) store.properties.push(propertyFromRow(row));

  const warrantyRows = await prisma.warranty.findMany();
  store.warranties.length = 0;
  for (const row of warrantyRows) store.warranties.push(warrantyFromRow(row));

  const claimRows = await prisma.warrantyClaim.findMany();
  store.warrantyClaims.length = 0;
  for (const row of claimRows) store.warrantyClaims.push(warrantyClaimFromRow(row));

  const invoiceRows = await prisma.invoice.findMany();
  store.invoices.length = 0;
  for (const row of invoiceRows) store.invoices.push(invoiceFromRow(row));

  return { properties: propertyRows.length, warranties: warrantyRows.length, warrantyClaims: claimRows.length, invoices: invoiceRows.length };
}

export async function persistProperty(record) {
  if (!DATABASE_ENABLED) return;
  // The Property table requires a customer; a record without one lives
  // in the working set only — persistence degrades, never fails the op.
  if (!record.customerId) return;
  const prisma = db();
  const data = {
    companyId: record.companyId,
    customerId: record.customerId,
    label: record.label ?? null,
    address: record.address,
    city: record.city,
    zip: record.zip,
    unit: record.unit ?? null,
    accessNotes: record.accessNotes ?? null,
    updatedAt: record.updatedAt ? new Date(record.updatedAt) : new Date(),
  };
  await prisma.property.upsert({
    where: { id: record.id },
    create: { id: record.id, ...data, createdAt: record.createdAt ? new Date(record.createdAt) : new Date() },
    update: data,
  });
}

export async function persistWarranty(record) {
  if (!DATABASE_ENABLED) return;
  const prisma = db();
  const data = {
    companyId: record.companyId,
    serviceRequestId: record.serviceRequestId,
    customerId: record.customerId ?? null,
    applianceType: record.applianceType ?? null,
    brand: record.brand ?? null,
    model: record.model ?? null,
    serial: record.serial ?? null,
    provider: record.provider,
    coverage: record.coverage ?? null,
    policyNumber: record.policyNumber ?? null,
    expiresAt: record.expiresAt ? new Date(record.expiresAt) : null,
    claimStatus: record.claimStatus || 'Not Filed',
    createdBy: record.createdBy ?? null,
    updatedAt: record.updatedAt ? new Date(record.updatedAt) : new Date(),
  };
  await prisma.warranty.upsert({
    where: { id: record.id },
    create: { id: record.id, ...data, createdAt: record.createdAt ? new Date(record.createdAt) : new Date() },
    update: data,
  });
}

export async function persistWarrantyClaim(record) {
  if (!DATABASE_ENABLED) return;
  const prisma = db();
  const data = {
    companyId: record.companyId,
    serviceRequestId: record.serviceRequestId,
    assignmentId: record.assignmentId ?? null,
    customerId: record.customerId ?? null,
    warrantyId: record.warrantyId ?? null,
    claimNumber: record.claimNumber ?? null,
    warrantyProvider: record.warrantyProvider ?? null,
    authorization: record.authorization ?? null,
    status: record.status || 'OPEN',
    description: record.description,
    notes: record.notes ?? null,
    amountCents: record.amountCents ?? null,
    createdBy: record.createdBy ?? null,
    updatedAt: record.updatedAt ? new Date(record.updatedAt) : new Date(),
  };
  await prisma.warrantyClaim.upsert({
    where: { id: record.id },
    create: { id: record.id, ...data, createdAt: record.createdAt ? new Date(record.createdAt) : new Date() },
    update: data,
  });
}

export async function persistInvoice(record) {
  if (!DATABASE_ENABLED) return;
  // The Invoice table requires a customer (FK); a record without one
  // lives in the working set only — persistence degrades, never fails.
  if (!record.customerId) return;
  const prisma = db();
  const data = {
    companyId: record.companyId,
    serviceRequestId: record.serviceRequestId,
    customerId: record.customerId,
    status: record.status || 'DRAFT',
    subtotal: record.subtotal ?? 0,
    diagnosticFee: record.diagnosticFee ?? 99,
    diagnosticCredit: record.diagnosticCredit ?? 0,
    total: record.total ?? 0,
    currency: record.currency || 'USD',
    updatedAt: record.updatedAt ? new Date(record.updatedAt) : new Date(),
  };
  await prisma.invoice.upsert({
    where: { id: record.id },
    create: { id: record.id, ...data, createdAt: record.createdAt ? new Date(record.createdAt) : new Date() },
    update: data,
  });
}
