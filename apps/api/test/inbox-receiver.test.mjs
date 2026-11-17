/**
 * Book OS Inbox / Email Manager — verification harness.
 *
 * Exercises the Resend inbound receiver end to end against a LOCAL
 * test database with Resend pointed at a local mock server:
 *
 *   - webhook with a bad Svix signature is rejected (401), files nothing
 *   - webhook with a valid signature files the message, fetching the
 *     body from the (mock) Resend receiving API
 *   - a sender matching a CRM customer files onto that customer; a
 *     sender matching a web Connection files as a lead; a stranger
 *     queues unmatched — mail is never dropped
 *   - webhook retries dedupe on the Resend email id
 *   - the staff inbox lists + filters by mailbox; opening marks read
 *   - replies send through (mock) Resend: forwarded-inbox mail is
 *     answered as service@topspeedappliance.net, mail to a managed
 *     @topspeedserviceos.com mailbox is answered from that address
 *   - compose sends from a chosen managed mailbox; the receive-only
 *     forwarding address cannot send
 *   - the CRM customer 360 carries the email conversation
 *
 * Usage:
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5434/inbox_e2e \
 *   node test/inbox-receiver.test.mjs
 * Exit code 0 = every check passed.
 */
import { spawn } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/services/passwords.js';
import { PLATFORM_COMPANY_ID } from '../src/data/store.js';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required (point it at a local TEST database).');
  process.exit(2);
}
process.env.DATABASE_URL_UNPOOLED ||= process.env.DATABASE_URL;

const PORT = Number(process.env.TEST_PORT || 4419);
const MOCK_PORT = Number(process.env.MOCK_PORT || 4420);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const PASSWORD = 'test-pass-1234';
const EMAIL_FROM = 'Top Speed Appliance <service@topspeedappliance.net>';

const SECRET_BYTES = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8');
const WEBHOOK_SECRET = `whsec_${SECRET_BYTES.toString('base64')}`;

const IDS = {
  staff: '20000000-0000-4000-8000-0000000000d1',
  customerUser: '20000000-0000-4000-8000-0000000000d2',
  customer: '20000000-0000-4000-8000-0000000000d3',
  connection: '20000000-0000-4000-8000-0000000000d4',
};

const RECEIVING_FIXTURES = {
  em_fwd_1: {
    id: 'em_fwd_1',
    from: 'Known Customer <known-customer@test.local>',
    to: ['inbox@updates.topspeedapplianceservice.com'],
    subject: 'Fridge still not cooling',
    message_id: '<m1@test.local>',
    text: 'Hi, my fridge is still not cooling after the visit. Can someone come back out?',
    html: '<p>Hi, my fridge is still not cooling after the visit.</p>',
    headers: [{ name: 'Message-ID', value: '<m1@test.local>' }],
  },
  em_os_1: {
    id: 'em_os_1',
    from: 'Pat Manager <pm@stranger-test.local>',
    to: ['booking@topspeedserviceos.com'],
    subject: 'Walk-in cooler quote for 12 units',
    message_id: '<m2@test.local>',
    text: 'Hello, we manage 12 units and need a quote for a walk-in cooler repair.',
    html: '<p>Hello, we manage 12 units and need a quote.</p>',
    headers: [{ name: 'Message-ID', value: '<m2@test.local>' }],
  },
  em_lead_1: {
    id: 'em_lead_1',
    from: 'Larry Lead <known-lead@test.local>',
    to: ['service@topspeedserviceos.com'],
    subject: 'Question about my estimate',
    message_id: '<m3@test.local>',
    text: 'Following up on the estimate you sent through the website.',
    html: '<p>Following up on the estimate.</p>',
    headers: [{ name: 'Message-ID', value: '<m3@test.local>' }],
  },
};

const sentEmails = [];
const mockResend = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const receiving = /^\/emails\/receiving\/(.+)$/.exec(req.url || '');
    if (req.method === 'GET' && receiving) {
      const fixture = RECEIVING_FIXTURES[decodeURIComponent(receiving[1])];
      return fixture ? send(200, fixture) : send(404, { message: 'not found' });
    }
    if (req.method === 'POST' && req.url === '/emails') {
      const payload = JSON.parse(raw || '{}');
      sentEmails.push(payload);
      return send(200, { id: `mock-sent-${sentEmails.length}` });
    }
    return send(404, { message: 'unknown mock route' });
  });
});

const prisma = new PrismaClient();
let server = null;
let failures = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

function checkTrue(label, value) {
  check(label, Boolean(value), true);
}

async function api(path, { token, method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
}

async function login(email) {
  const { status, json } = await api('/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  if (status !== 200 || !json?.token) throw new Error(`login failed for ${email}: ${status} ${JSON.stringify(json)}`);
  return json.token;
}

function signPayload(rawBody, { id = randomUUID(), timestamp = Math.floor(Date.now() / 1000), key = SECRET_BYTES } = {}) {
  const signature = createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`).digest('base64');
  return { 'svix-id': id, 'svix-timestamp': String(timestamp), 'svix-signature': `v1,${signature}` };
}

async function postWebhook(event, { badSignature = false } = {}) {
  const rawBody = JSON.stringify(event);
  const headers = signPayload(rawBody, badSignature ? { key: Buffer.from('ffffffffffffffffffffffffffffffff') } : {});
  const res = await fetch(`${BASE}/intake/email-received`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: rawBody,
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
}

function webhookEvent(emailId) {
  const fixture = RECEIVING_FIXTURES[emailId];
  return {
    type: 'email.received',
    created_at: new Date().toISOString(),
    data: {
      email_id: emailId,
      from: fixture.from,
      to: fixture.to,
      subject: fixture.subject,
      message_id: fixture.message_id,
    },
  };
}

async function seed() {
  const passwordHash = await hashPassword(PASSWORD);
  await prisma.company.upsert({
    where: { id: PLATFORM_COMPANY_ID },
    update: {},
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'test-platform-inbox', type: 'PLATFORM_OWNER', isPlatformOwner: true },
  });
  const users = [
    { id: IDS.staff, companyId: PLATFORM_COMPANY_ID, email: 'inbox-staff@test.local', passwordHash, phone: '9545550200', roles: ['DISPATCHER'], active: true },
    { id: IDS.customerUser, companyId: PLATFORM_COMPANY_ID, email: 'known-customer@test.local', passwordHash, phone: '9545550201', roles: ['CUSTOMER'], active: true },
  ];
  for (const u of users) {
    await prisma.user.upsert({ where: { id: u.id }, update: { passwordHash, roles: u.roles }, create: u });
  }
  await prisma.customer.upsert({
    where: { id: IDS.customer },
    update: { email: 'known-customer@test.local' },
    create: {
      id: IDS.customer, companyId: PLATFORM_COMPANY_ID, userId: IDS.customerUser,
      name: 'Known Customer', phone: '9545550201', email: 'known-customer@test.local',
      city: 'Fort Lauderdale', zip: '33311',
    },
  });
  await prisma.connection.upsert({
    where: { id: IDS.connection },
    update: {},
    create: {
      id: IDS.connection, name: 'Larry Lead', phone: '9545550202', email: 'known-lead@test.local',
      type: 'GENERAL_CONTACT', source: 'WEBSITE', message: 'Estimate please', reference: 'TS-LEAD01',
    },
  });
}

async function waitForServer() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('API did not come up');
}

async function main() {
  await new Promise((resolve) => mockResend.listen(MOCK_PORT, '127.0.0.1', resolve));
  await seed();

  server = spawn('node', ['src/server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      ...process.env,
      PORT: String(PORT),
      JWT_SECRET: 'inbox-e2e-test-secret',
      RESEND_API_KEY: 'test-resend-key',
      RESEND_API_BASE: `http://127.0.0.1:${MOCK_PORT}`,
      RESEND_WEBHOOK_SECRET: WEBHOOK_SECRET,
      EMAIL_FROM,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[api] ${d}`));
  await waitForServer();

  /* 1 — bad signature is rejected and files nothing */
  const bad = await postWebhook(webhookEvent('em_fwd_1'), { badSignature: true });
  check('bad signature rejected', bad.status, 401);
  check('nothing filed on bad signature', await prisma.inboxMessage.count(), 0);

  /* 2 — forwarded service@ mail from a known customer files + matches */
  const fwd = await postWebhook(webhookEvent('em_fwd_1'));
  check('forwarded webhook accepted', fwd.status, 200);
  check('forwarded webhook not duplicate', fwd.json?.data?.duplicate, false);
  check('forwarded webhook reports match', fwd.json?.data?.matched, true);
  const fwdRow = await prisma.inboxMessage.findFirst({ where: { providerEmailId: 'em_fwd_1' } });
  checkTrue('forwarded row stored', fwdRow);
  check('forwarded row matched to customer', fwdRow?.customerId, IDS.customer);
  check('forwarded row mailbox', fwdRow?.mailbox, 'inbox@updates.topspeedapplianceservice.com');
  check('forwarded row recipient kept', fwdRow?.toEmail, 'inbox@updates.topspeedapplianceservice.com');
  checkTrue('forwarded body fetched from Resend', (fwdRow?.textBody || '').includes('still not cooling'));
  check('forwarded row starts unread', fwdRow?.status, 'UNREAD');

  /* 3 — webhook retry dedupes */
  const retry = await postWebhook(webhookEvent('em_fwd_1'));
  check('retry accepted', retry.status, 200);
  check('retry flagged duplicate', retry.json?.data?.duplicate, true);
  check('still one forwarded row', await prisma.inboxMessage.count({ where: { providerEmailId: 'em_fwd_1' } }), 1);

  /* 4 — @topspeedserviceos.com mail from a stranger queues unmatched */
  const osMail = await postWebhook(webhookEvent('em_os_1'));
  check('os-domain webhook accepted', osMail.status, 200);
  check('os-domain webhook reports no match', osMail.json?.data?.matched, false);
  const osRow = await prisma.inboxMessage.findFirst({ where: { providerEmailId: 'em_os_1' } });
  checkTrue('os-domain row stored (never dropped)', osRow);
  check('os-domain row unmatched customer', osRow?.customerId, null);
  check('os-domain row mailbox', osRow?.mailbox, 'booking@topspeedserviceos.com');

  /* 5 — sender matching a web Connection files as that lead */
  const lead = await postWebhook(webhookEvent('em_lead_1'));
  check('lead webhook accepted', lead.status, 200);
  const leadRow = await prisma.inboxMessage.findFirst({ where: { providerEmailId: 'em_lead_1' } });
  check('lead row matched to connection', leadRow?.connectionId, IDS.connection);
  check('lead row mailbox', leadRow?.mailbox, 'service@topspeedserviceos.com');

  /* 6 — other event types are acknowledged and ignored */
  const otherRaw = JSON.stringify({ type: 'email.delivered', created_at: new Date().toISOString(), data: { email_id: 'em_other' } });
  const otherRes = await fetch(`${BASE}/intake/email-received`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...signPayload(otherRaw) },
    body: otherRaw,
  });
  check('non-received event acknowledged', otherRes.status, 200);
  check('non-received event files nothing', await prisma.inboxMessage.count({ where: { providerEmailId: 'em_other' } }), 0);

  /* 7 — staff gating + list + mailbox filter */
  const anon = await api('/bookos/inbox');
  check('inbox list refuses signed-out', anon.status, 401);
  const customerToken = await login('known-customer@test.local');
  const asCustomer = await api('/bookos/inbox', { token: customerToken });
  check('inbox list refuses customers', asCustomer.status, 403);
  const staffToken = await login('inbox-staff@test.local');
  const list = await api('/bookos/inbox', { token: staffToken });
  check('inbox list ok for staff', list.status, 200);
  check('inbox lists all three', list.json?.data?.count, 3);
  check('inbox unread count', list.json?.data?.unread, 3);
  const bookingOnly = await api('/bookos/inbox?mailbox=booking@topspeedserviceos.com', { token: staffToken });
  check('mailbox filter narrows to booking@', bookingOnly.json?.data?.count, 1);
  check('mailbox filter item is the os mail', bookingOnly.json?.data?.messages?.[0]?.subject, 'Walk-in cooler quote for 12 units');
  const unmatched = await api('/bookos/inbox?unmatched=1', { token: staffToken });
  check('unmatched filter shows only the stranger', unmatched.json?.data?.count, 1);

  /* 8 — detail shows the body and marks the message read */
  const detail = await api(`/bookos/inbox/${fwdRow.id}`, { token: staffToken });
  check('detail ok', detail.status, 200);
  checkTrue('detail carries full body', (detail.json?.data?.textBody || '').includes('come back out'));
  check('detail reply identity is service@ net', detail.json?.data?.replyFrom, EMAIL_FROM);
  const fwdAfterOpen = await prisma.inboxMessage.findUnique({ where: { id: fwdRow.id } });
  check('opening marked it read', fwdAfterOpen?.status, 'READ');

  /* 9 — reply to forwarded mail sends as service@topspeedappliance.net */
  const sentBefore = sentEmails.length;
  const reply = await api(`/bookos/inbox/${fwdRow.id}/reply`, {
    token: staffToken, method: 'POST', body: { body: 'Sorry about that — we will come back out tomorrow morning.' },
  });
  check('reply accepted', reply.status, 201);
  check('reply hit the Resend mock once', sentEmails.length, sentBefore + 1);
  const replySend = sentEmails[sentEmails.length - 1];
  check('reply sent from service@ net identity', replySend?.from, EMAIL_FROM);
  check('reply addressed to the customer', replySend?.to?.[0], 'known-customer@test.local');
  check('reply subject threads', replySend?.subject, 'Re: Fridge still not cooling');
  check('reply carries In-Reply-To', replySend?.headers?.['In-Reply-To'], '<m1@test.local>');
  const fwdAfterReply = await prisma.inboxMessage.findUnique({ where: { id: fwdRow.id } });
  check('original marked replied', fwdAfterReply?.status, 'REPLIED');
  const outboundRow = await prisma.inboxMessage.findFirst({ where: { threadRootId: fwdRow.id, direction: 'OUTBOUND' } });
  checkTrue('outbound reply filed on the thread', outboundRow);
  check('outbound reply filed on the customer', outboundRow?.customerId, IDS.customer);

  /* 10 — reply to booking@ mail sends from booking@ */
  const osReply = await api(`/bookos/inbox/${osRow.id}/reply`, {
    token: staffToken, method: 'POST', body: { body: 'Thanks — a quote needs a site visit; here is how we schedule it.' },
  });
  check('os reply accepted', osReply.status, 201);
  const osSend = sentEmails[sentEmails.length - 1];
  check('os reply sent from booking@', osSend?.from, 'Top Speed Appliance <booking@topspeedserviceos.com>');

  /* 11 — compose from a managed mailbox; receive-only address refused */
  const compose = await api('/bookos/inbox/compose', {
    token: staffToken, method: 'POST',
    body: { from: 'service@topspeedserviceos.com', to: 'known-customer@test.local', subject: 'Your appointment window', body: 'Confirming your window tomorrow, 8–10 AM.' },
  });
  check('compose accepted', compose.status, 201);
  const composeSend = sentEmails[sentEmails.length - 1];
  check('compose sent from service@ os', composeSend?.from, 'Top Speed Appliance <service@topspeedserviceos.com>');
  const composeRow = await prisma.inboxMessage.findFirst({ where: { direction: 'OUTBOUND', subject: 'Your appointment window' } });
  checkTrue('compose filed in the console', composeRow);
  check('compose filed under its mailbox', composeRow?.mailbox, 'service@topspeedserviceos.com');
  check('compose matched to the customer', composeRow?.customerId, IDS.customer);
  const badCompose = await api('/bookos/inbox/compose', {
    token: staffToken, method: 'POST',
    body: { from: 'inbox@updates.topspeedapplianceservice.com', to: 'known-customer@test.local', subject: 'Nope', body: 'Should not send.' },
  });
  check('compose from receive-only address refused', badCompose.status, 400);

  /* 12 — CRM 360 carries the conversation */
  const crm = await api(`/crm/customers/${IDS.customer}`, { token: staffToken });
  check('crm 360 ok', crm.status, 200);
  const emails = crm.json?.data?.emails || [];
  checkTrue('crm 360 has the inbound mail', emails.some((e) => e.subject === 'Fridge still not cooling' && e.direction === 'INBOUND'));
  checkTrue('crm 360 has the staff reply', emails.some((e) => e.direction === 'OUTBOUND' && (e.subject || '').includes('Fridge')));
  checkTrue('crm 360 has the composed mail', emails.some((e) => e.subject === 'Your appointment window'));

  /* 13 — mailboxes config endpoint */
  const mailboxes = await api('/bookos/inbox/mailboxes', { token: staffToken });
  check('mailboxes endpoint ok', mailboxes.status, 200);
  check('two sendable mailboxes', mailboxes.json?.data?.sendable?.length, 2);
}

main()
  .catch((error) => { failures += 1; console.error('HARNESS ERROR', error); })
  .finally(async () => {
    try {
      await prisma.inboxMessage.deleteMany({});
      await prisma.connection.deleteMany({ where: { id: IDS.connection } });
      await prisma.customer.deleteMany({ where: { id: IDS.customer } });
      await prisma.user.deleteMany({ where: { id: { in: [IDS.staff, IDS.customerUser] } } });
    } catch { /* cleanup best-effort */ }
    if (server) server.kill('SIGTERM');
    mockResend.close();
    await prisma.$disconnect();
    console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
  });
