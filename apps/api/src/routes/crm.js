import { Router } from 'express';
import { store } from '../data/store.js';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { STAFF_ROLES } from '../config/security.js';

/**
 * The Service OS CRM — the team's single customer view. Every customer
 * record the platform has ever taken (bookings, Speedy chats, web
 * forms, PM batches) in one searchable place, with their bookings and
 * intake history attached. Staff only.
 */
const router = Router();
const staffOnly = [authenticate, requireCompany, requireRole(...STAFF_ROLES)];

function digits(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-10);
}

function customerSummary(customer) {
  const bookings = [...store.bookings.values()].filter((b) => b.customerId === customer.id);
  const last = bookings.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] || null;
  return {
    id: customer.id,
    name: customer.name,
    phone: customer.phone,
    email: customer.email || null,
    city: customer.city || null,
    zip: customer.zip || null,
    bookingsCount: bookings.length,
    lastBooking: last
      ? { referenceCode: last.referenceCode, appliance: last.appliance, status: last.status, createdAt: last.createdAt }
      : null,
    createdAt: customer.createdAt,
  };
}

router.get('/crm/customers', ...staffOnly, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  let customers = [...store.customers.values()].map(customerSummary);
  if (q) {
    customers = customers.filter(
      (c) =>
        (c.name || '').toLowerCase().includes(q) ||
        (c.phone || '').includes(q) ||
        (c.email || '').toLowerCase().includes(q) ||
        (c.city || '').toLowerCase().includes(q),
    );
  }
  customers.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return res.json({ data: { count: customers.length, customers: customers.slice(0, 200) } });
});

router.get('/crm/customers/:id', ...staffOnly, (req, res) => {
  const customer = store.customers.get(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  const bookings = [...store.bookings.values()]
    .filter((b) => b.customerId === customer.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((b) => ({
      referenceCode: b.referenceCode,
      appliance: b.appliance,
      issue: b.issue,
      city: b.city,
      zip: b.zip,
      status: b.status,
      source: b.source,
      preferredWindow: b.preferredWindow,
      createdAt: b.createdAt,
    }));
  const phone = digits(customer.phone);
  const intake = [...store.connections]
    .filter((c) => digits(c.phone) === phone && phone)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((c) => ({ reference: c.reference, type: c.type, source: c.source, message: c.message, createdAt: c.createdAt }));
  return res.json({ data: { customer: { ...customer }, bookings, intake } });
});

export default router;
