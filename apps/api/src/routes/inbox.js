import { Router } from 'express';
import { z } from 'zod';
import { ROLES, STAFF_ROLES } from '../config/security.js';
import { MANAGED_MAILBOXES, isSendableAddress, sendableMailboxes } from '../config/mailboxes.js';
import { store } from '../data/store.js';
import { updateInboxMessageStatus } from '../db/inboxRepo.js';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import {
  ingestReceivedEmail,
  inboxSendConfigured,
  inboxWebhookConfigured,
  replyIdentityFor,
  sendComposedEmail,
  sendInboxReply,
  verifyResendSignature,
} from '../services/inbox.js';

/**
 * Book OS Inbox / Email Manager.
 *
 * POST /intake/email-received is the Resend inbound webhook: Svix
 * signature-verified (the raw-body parser for this exact path is
 * mounted in server.js before the JSON parser, same as the Stripe
 * webhook), it files every received message — matched to a CRM
 * customer when the sender is known, queued unmatched when not.
 *
 * Everything under /bookos/inbox is staff-only (Service Setters,
 * managers, owner). Replies and composed mail send through Resend
 * only when a staff member submits them — a human always clicks
 * send; nothing here auto-sends.
 */

const router = Router();
const staffOnly = [authenticate, requireCompany, requireRole(...STAFF_ROLES)];

function visibleTo(req, message) {
  return req.user.roles.includes(ROLES.PLATFORM_ADMIN) || message.companyId === req.companyId;
}

function findVisibleMessage(req, id) {
  const message = (store.inboxMessages || []).find((m) => m.id === id);
  return message && visibleTo(req, message) ? message : null;
}

function customerBrief(customerId) {
  if (!customerId) return null;
  const customer = store.customers.get(customerId);
  return customer ? { id: customer.id, name: customer.name, email: customer.email || null } : null;
}

function connectionBrief(connectionId) {
  if (!connectionId) return null;
  const connection = (store.connections || []).find((c) => c.id === connectionId);
  return connection ? { id: connection.id, reference: connection.reference, type: connection.type } : null;
}

function listItem(message) {
  return {
    id: message.id,
    direction: message.direction,
    fromEmail: message.fromEmail,
    fromName: message.fromName,
    toEmail: message.toEmail,
    mailbox: message.mailbox,
    subject: message.subject,
    snippet: message.snippet,
    status: message.status,
    customer: customerBrief(message.customerId),
    connection: connectionBrief(message.connectionId),
    receivedAt: message.receivedAt,
    createdAt: message.createdAt,
  };
}

function detailItem(message) {
  const thread = (store.inboxMessages || [])
    .filter((m) => m.threadRootId === message.id || (message.threadRootId && m.id === message.threadRootId) || (message.threadRootId && m.threadRootId === message.threadRootId))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    .map(listItem);
  return {
    ...listItem(message),
    textBody: message.textBody,
    htmlBody: message.htmlBody,
    messageIdHeader: message.messageIdHeader,
    replyFrom: message.direction === 'INBOUND' ? replyIdentityFor(message) : null,
    thread,
  };
}

/* ---------------- Resend inbound webhook ---------------- */

router.post('/intake/email-received', async (req, res) => {
  if (!inboxWebhookConfigured()) {
    return res.status(503).json({ error: 'inbox_webhook_not_configured' });
  }
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  if (!verifyResendSignature(rawBody, req.headers)) {
    return res.status(401).json({ error: 'invalid_signature' });
  }
  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'invalid_json' });
  }
  if (event?.type !== 'email.received') {
    return res.json({ data: { received: true, ignored: event?.type || null } });
  }
  try {
    const { message, duplicate } = await ingestReceivedEmail(event.data || {});
    return res.json({ data: { received: true, duplicate, id: message.id, matched: Boolean(message.customerId || message.connectionId) } });
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', message: 'inbox webhook ingest failed', error: String(error?.message || error) }));
    return res.status(500).json({ error: 'ingest_failed' });
  }
});

/* ---------------- Email Manager console (staff) ---------------- */

/** Managed mailboxes + which of them staff may send from. */
router.get('/bookos/inbox/mailboxes', ...staffOnly, (req, res) => {
  return res.json({
    data: {
      mailboxes: MANAGED_MAILBOXES,
      sendable: sendableMailboxes().map((m) => m.address),
      sendConfigured: inboxSendConfigured(),
    },
  });
});

router.get('/bookos/inbox', ...staffOnly, (req, res) => {
  const mailbox = String(req.query.mailbox || '').trim().toLowerCase();
  const status = String(req.query.status || '').trim().toUpperCase();
  const unmatchedOnly = req.query.unmatched === '1';
  let items = (store.inboxMessages || []).filter((m) => visibleTo(req, m));
  if (mailbox) items = items.filter((m) => (m.mailbox || m.toEmail) === mailbox);
  if (status) items = items.filter((m) => m.status === status);
  if (unmatchedOnly) items = items.filter((m) => m.direction === 'INBOUND' && !m.customerId && !m.connectionId);
  items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const unread = (store.inboxMessages || []).filter(
    (m) => visibleTo(req, m) && m.direction === 'INBOUND' && m.status === 'UNREAD' && (!mailbox || (m.mailbox || m.toEmail) === mailbox),
  ).length;
  return res.json({ data: { count: items.length, unread, messages: items.slice(0, 100).map(listItem) } });
});

router.get('/bookos/inbox/:id', ...staffOnly, async (req, res) => {
  const message = findVisibleMessage(req, req.params.id);
  if (!message) return res.status(404).json({ error: 'Message not found' });
  if (message.direction === 'INBOUND' && message.status === 'UNREAD') {
    await updateInboxMessageStatus(message, 'READ');
  }
  return res.json({ data: detailItem(message) });
});

const replySchema = z.object({ body: z.string().trim().min(1).max(10000) });

router.post('/bookos/inbox/:id/reply', ...staffOnly, async (req, res) => {
  const message = findVisibleMessage(req, req.params.id);
  if (!message) return res.status(404).json({ error: 'Message not found' });
  if (message.direction !== 'INBOUND') return res.status(400).json({ error: 'Only inbound messages can be replied to' });
  const parsed = replySchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'A reply body is required', details: parsed.error.flatten() });
  try {
    const outbound = await sendInboxReply(message, { body: parsed.data.body, author: req.user.email });
    return res.status(201).json({ data: detailItem(outbound) });
  } catch (error) {
    if (error.code === 'EMAIL_NOT_CONFIGURED') return res.status(503).json({ error: 'email_not_configured' });
    console.error(JSON.stringify({ level: 'error', message: 'inbox reply send failed', error: String(error?.message || error) }));
    return res.status(502).json({ error: 'email_send_failed', message: String(error?.message || error) });
  }
});

const statusSchema = z.object({ status: z.enum(['READ', 'UNREAD', 'ARCHIVED']) });

router.post('/bookos/inbox/:id/status', ...staffOnly, async (req, res) => {
  const message = findVisibleMessage(req, req.params.id);
  if (!message) return res.status(404).json({ error: 'Message not found' });
  const parsed = statusSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid status', details: parsed.error.flatten() });
  await updateInboxMessageStatus(message, parsed.data.status);
  return res.json({ data: listItem(message) });
});

const composeSchema = z.object({
  from: z.string().trim().email(),
  to: z.string().trim().email(),
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(10000),
});

router.post('/bookos/inbox/compose', ...staffOnly, async (req, res) => {
  const parsed = composeSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'Compose needs a from, to, subject and body', details: parsed.error.flatten() });
  if (!isSendableAddress(parsed.data.from)) {
    return res.status(400).json({ error: 'That from address is not a managed sending mailbox', sendable: sendableMailboxes().map((m) => m.address) });
  }
  try {
    const outbound = await sendComposedEmail({
      fromAddress: parsed.data.from,
      to: parsed.data.to,
      subject: parsed.data.subject,
      body: parsed.data.body,
      author: req.user.email,
    });
    return res.status(201).json({ data: detailItem(outbound) });
  } catch (error) {
    if (error.code === 'EMAIL_NOT_CONFIGURED') return res.status(503).json({ error: 'email_not_configured' });
    console.error(JSON.stringify({ level: 'error', message: 'inbox compose send failed', error: String(error?.message || error) }));
    return res.status(502).json({ error: 'email_send_failed', message: String(error?.message || error) });
  }
});

export default router;
