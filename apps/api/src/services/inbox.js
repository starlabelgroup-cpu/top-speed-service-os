import { createHmac, timingSafeEqual } from 'node:crypto';
import { appendEvent, createId, PLATFORM_COMPANY_ID, store } from '../data/store.js';
import { persistInboxMessage, updateInboxMessageStatus } from '../db/inboxRepo.js';
import { identityForAddress, isSendableAddress, mailboxForAddress } from '../config/mailboxes.js';
import { recordInboundEmail } from './messageThreads.js';

/**
 * Book OS Inbox / Email Manager — inbound email for Top Speed OS.
 *
 * Flow: service@topspeedappliance.net forwards a copy of every message
 * to inbox@updates.topspeedapplianceservice.com (Resend receiving),
 * and the platform's own topspeedserviceos.com domain receives on its
 * managed mailboxes. Resend POSTs an `email.received` event to
 * /api/v1/intake/email-received; the signature (Svix) is verified
 * against RESEND_WEBHOOK_SECRET before anything is stored. The
 * webhook payload carries metadata only, so the full message is
 * fetched from the Resend receiving API. Every message is filed —
 * matched to a CRM customer by sender email when one exists, queued
 * unmatched when it does not. Mail is never dropped.
 *
 * Replies and composed mail go out through Resend only when a staff
 * member clicks send — nothing in this module sends on its own.
 */

const SIGNATURE_TOLERANCE_SECONDS = 300;

export function inboxWebhookConfigured() {
  return Boolean(process.env.RESEND_WEBHOOK_SECRET);
}

function resendConfig() {
  return {
    configured: Boolean(process.env.RESEND_API_KEY),
    apiKey: process.env.RESEND_API_KEY,
    from: process.env.EMAIL_FROM || 'Top Speed Appliance <service@topspeedappliance.net>',
    base: process.env.RESEND_API_BASE || 'https://api.resend.com',
  };
}

export function inboxSendConfigured() {
  return resendConfig().configured;
}

/**
 * Svix signature verification (Resend signs webhooks with Svix).
 * Signed content is `${svix-id}.${svix-timestamp}.${rawBody}`; the
 * secret is the base64 part after the `whsec_` prefix; the signature
 * header carries space-separated `v1,<base64>` candidates. Hand-rolled
 * with node:crypto in the same style as the Stripe webhook check —
 * no new dependency.
 */
export function verifyResendSignature(rawBody, headers) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  const id = headers['svix-id'];
  const timestamp = headers['svix-timestamp'];
  const signatureHeader = headers['svix-signature'];
  if (!secret || !id || !timestamp || !signatureHeader) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > SIGNATURE_TOLERANCE_SECONDS) return false;
  let key;
  try {
    key = Buffer.from(String(secret).replace(/^whsec_/, ''), 'base64');
  } catch {
    return false;
  }
  if (!key.length) return false;
  const signedContent = `${id}.${timestamp}.${rawBody.toString('utf8')}`;
  const expected = createHmac('sha256', key).update(signedContent).digest();
  for (const candidate of String(signatureHeader).split(' ')) {
    const [version, value] = candidate.split(',');
    if (version !== 'v1' || !value) continue;
    let given;
    try {
      given = Buffer.from(value, 'base64');
    } catch {
      continue;
    }
    if (given.length === expected.length && timingSafeEqual(given, expected)) return true;
  }
  return false;
}

/** Bare lowercase email address out of "Name <a@b>" or a plain address. */
export function extractEmailAddress(value) {
  const raw = String(value || '').trim();
  const match = /<([^>]+)>/.exec(raw);
  return (match ? match[1] : raw).trim().toLowerCase();
}

/** Display name out of "Name <a@b>", or null. */
function extractDisplayName(value) {
  const raw = String(value || '').trim();
  const match = /^"?([^"<]+)"?\s*<[^>]+>$/.exec(raw);
  return match ? match[1].trim() || null : null;
}

function snippetFrom(text, subject) {
  const source = String(text || subject || '').replace(/\s+/g, ' ').trim();
  return source.slice(0, 140) || null;
}

/**
 * Fetch the full received message from the Resend receiving API.
 * Returns null when Resend is not configured or the fetch fails —
 * the caller files whatever the webhook payload itself carried so
 * the message is never lost.
 */
async function fetchReceivedEmail(emailId) {
  const config = resendConfig();
  if (!config.configured || !emailId) return null;
  try {
    const response = await fetch(`${config.base}/emails/receiving/${encodeURIComponent(emailId)}`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
    });
    if (!response.ok) return null;
    const body = await response.json().catch(() => null);
    return body && typeof body === 'object' ? body : null;
  } catch {
    return null;
  }
}

function headerValue(headers, name) {
  if (!headers) return null;
  if (Array.isArray(headers)) {
    const hit = headers.find((h) => String(h?.name || '').toLowerCase() === name);
    return hit ? String(hit.value || '') || null : null;
  }
  if (typeof headers === 'object') {
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === name) return String(value || '') || null;
    }
  }
  return null;
}

/**
 * Match a sender email to the CRM: a Customer record first (the
 * conversation lands on their 360), then a Connection (a known web
 * lead who has no customer record yet). Returns { customerId,
 * connectionId } — both null for a stranger, who still queues.
 */
export function matchSender(fromEmail) {
  const email = extractEmailAddress(fromEmail);
  if (!email) return { customerId: null, connectionId: null };
  const customers = [...store.customers.values()]
    .filter((c) => c.email && c.email.toLowerCase() === email)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  if (customers.length) return { customerId: customers[0].id, connectionId: null };
  const connection = [...store.connections]
    .filter((c) => c.email && c.email.toLowerCase() === email)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
  if (connection) return { customerId: null, connectionId: connection.id };
  return { customerId: null, connectionId: null };
}

/**
 * File one received email. `data` is the webhook event's data object;
 * when it lacks body fields the full message is fetched from Resend.
 * Dedupes on the Resend email id — a webhook retry returns the
 * existing record instead of filing a copy.
 */
export async function ingestReceivedEmail(data) {
  const emailId = data?.email_id || data?.emailId || data?.id || null;
  if (emailId) {
    const existing = (store.inboxMessages || []).find((m) => m.providerEmailId === emailId);
    if (existing) return { message: existing, duplicate: true };
  }

  let full = null;
  if (!data?.text && !data?.html) {
    full = await fetchReceivedEmail(emailId);
  }
  const source = { ...(full || {}), ...(data || {}) };
  // Prefer the fetched body when the payload (which wins above for
  // metadata) carried none.
  const textBody = source.text || full?.text || null;
  const htmlBody = source.html || full?.html || null;

  const fromRaw = source.from || '';
  const fromEmail = extractEmailAddress(fromRaw);
  const toList = Array.isArray(source.to) ? source.to : [source.to].filter(Boolean);
  const toEmail = extractEmailAddress(toList[0] || '');
  const mailbox = mailboxForAddress(toEmail)?.address || null;
  const subject = String(source.subject || '(no subject)');
  const { customerId, connectionId } = matchSender(fromEmail);

  const message = {
    id: createId(),
    companyId: PLATFORM_COMPANY_ID,
    direction: 'INBOUND',
    providerEmailId: emailId,
    fromEmail,
    fromName: extractDisplayName(fromRaw),
    toEmail,
    mailbox,
    subject,
    textBody,
    htmlBody,
    snippet: snippetFrom(textBody, subject),
    customerId,
    connectionId,
    threadRootId: null,
    messageIdHeader: source.message_id || headerValue(source.headers, 'message-id'),
    inReplyToHeader: headerValue(source.headers, 'in-reply-to'),
    status: 'UNREAD',
    author: null,
    receivedAt: source.created_at || new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  store.inboxMessages.push(message);
  await persistInboxMessage(message);
  // Setter–customer threads (2026-11-20, Wave 1 D1): when the sender
  // is a CRM customer who already has an open composer thread,
  // mirror the reply into that thread so the Book OS / CRM
  // conversation reads two-way. ADDITIVE ONLY — the Inbox above
  // stays the system of record for email; a mirror failure changes
  // nothing about the filing.
  if (customerId) {
    try {
      await recordInboundEmail({
        customerId,
        subject,
        body: textBody || '',
        externalId: emailId ? `email:${emailId}` : null,
      });
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', message: 'inbox thread mirror failed', error: String(error?.message || error) }));
    }
  }
  await appendEvent('INBOX_EMAIL_RECEIVED', {
    source: 'resend-webhook',
    actor: 'resend',
    entityType: 'INBOX_MESSAGE',
    entityId: message.id,
    details: { mailbox, matched: Boolean(customerId || connectionId), subject },
  });
  return { message, duplicate: false };
}

/**
 * The From identity for a reply: mail sent to a managed
 * @topspeedserviceos.com mailbox is answered from that same address;
 * everything else (including the forwarded service@ inbox) is
 * answered as service@topspeedappliance.net via EMAIL_FROM.
 */
export function replyIdentityFor(message) {
  if (message?.mailbox && isSendableAddress(message.mailbox)) {
    return identityForAddress(message.mailbox);
  }
  return resendConfig().from;
}

async function sendViaResend({ from, to, subject, text, headers }) {
  const config = resendConfig();
  if (!config.configured) {
    const error = new Error('Email sending is not configured (RESEND_API_KEY missing)');
    error.code = 'EMAIL_NOT_CONFIGURED';
    throw error;
  }
  const response = await fetch(`${config.base}/emails`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to: [to], subject, text, ...(headers ? { headers } : {}) }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body?.message || `Resend error ${response.status}`);
    error.code = 'EMAIL_SEND_FAILED';
    error.httpStatus = response.status;
    throw error;
  }
  return body.id || null;
}

/**
 * Send a staff reply to an inbound message and file the outbound copy
 * on the same thread. Called only from the staff route — a human
 * clicked send. On provider failure nothing is filed as sent.
 */
export async function sendInboxReply(original, { body, author }) {
  const from = replyIdentityFor(original);
  const fromEmail = extractEmailAddress(from);
  const subject = /^re:/i.test(original.subject) ? original.subject : `Re: ${original.subject}`;
  const headers = original.messageIdHeader
    ? { 'In-Reply-To': original.messageIdHeader, References: original.messageIdHeader }
    : undefined;
  const providerId = await sendViaResend({ from, to: original.fromEmail, subject, text: body, headers });

  const outbound = {
    id: createId(),
    companyId: original.companyId,
    direction: 'OUTBOUND',
    providerEmailId: providerId,
    fromEmail,
    fromName: 'Top Speed Appliance',
    toEmail: original.fromEmail,
    mailbox: original.mailbox || null,
    subject,
    textBody: body,
    htmlBody: null,
    snippet: snippetFrom(body, subject),
    customerId: original.customerId || null,
    connectionId: original.connectionId || null,
    threadRootId: original.id,
    messageIdHeader: null,
    inReplyToHeader: original.messageIdHeader || null,
    status: 'SENT',
    author: author || null,
    receivedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  store.inboxMessages.push(outbound);
  await persistInboxMessage(outbound);
  await updateInboxMessageStatus(original, 'REPLIED');
  await appendEvent('INBOX_EMAIL_REPLIED', {
    source: 'book-os-inbox',
    actor: author || 'staff',
    entityType: 'INBOX_MESSAGE',
    entityId: outbound.id,
    details: { inReplyTo: original.id, from: fromEmail },
  });
  return outbound;
}

/**
 * Send a brand-new email from a managed @topspeedserviceos.com
 * mailbox (Email Manager Compose). Called only from the staff route
 * — a human clicked send. The outbound copy is filed in the console.
 */
export async function sendComposedEmail({ fromAddress, to, subject, body, author }) {
  const from = identityForAddress(fromAddress);
  const providerId = await sendViaResend({ from, to, subject, text: body });
  const { customerId, connectionId } = matchSender(to);
  const outbound = {
    id: createId(),
    companyId: PLATFORM_COMPANY_ID,
    direction: 'OUTBOUND',
    providerEmailId: providerId,
    fromEmail: String(fromAddress).trim().toLowerCase(),
    fromName: 'Top Speed Appliance',
    toEmail: extractEmailAddress(to),
    mailbox: String(fromAddress).trim().toLowerCase(),
    subject,
    textBody: body,
    htmlBody: null,
    snippet: snippetFrom(body, subject),
    customerId,
    connectionId,
    threadRootId: null,
    messageIdHeader: null,
    inReplyToHeader: null,
    status: 'SENT',
    author: author || null,
    receivedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  store.inboxMessages.push(outbound);
  await persistInboxMessage(outbound);
  await appendEvent('INBOX_EMAIL_COMPOSED', {
    source: 'book-os-inbox',
    actor: author || 'staff',
    entityType: 'INBOX_MESSAGE',
    entityId: outbound.id,
    details: { from: outbound.fromEmail, to: outbound.toEmail },
  });
  return outbound;
}
