import { Router } from 'express';
import { z } from 'zod';
import { PLATFORM_CONSTANTS } from '../config/platform.js';
import { ROLES } from '../config/security.js';
import { appendEvent, createId, PLATFORM_COMPANY_ID, store } from '../data/store.js';
import { persistVideoRequest } from '../db/videoRepo.js';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { queueNotification } from '../services/notifications.js';

/**
 * Speedy Live Video — the live-video consultation engine (Module 1).
 *
 * A customer asks to show the problem live; the request lands in the
 * Service Setters' queue. A setter arranges it in one of the three modes
 * from the module spec — IMMEDIATE (a qualified technician is free),
 * SCHEDULED (booked for later), or MANAGER_ASSISTED (a manager joins) —
 * which creates the video room. Both sides join the same room from the
 * website's /video page; the room itself runs on the video provider
 * (Jitsi), the platform owns the request, the record, and the routing.
 *
 * Requests persist to the database (db/videoRepo) like everything else
 * on the platform.
 */
const router = Router();

const staffOnly = [authenticate, requireCompany, requireRole(ROLES.DISPATCHER, ROLES.PLATFORM_ADMIN)];

export const VIDEO_MODES = ['IMMEDIATE', 'SCHEDULED', 'MANAGER_ASSISTED'];
export const VIDEO_JOIN_BASE = 'https://topspeedserviceos.com/video/';

const requestSchema = z.object({
  customerName: z.string().trim().min(2).max(120),
  phone: z.string().trim().min(7).max(40),
  appliance: z.string().trim().min(2).max(80),
  note: z.string().trim().max(500).optional(),
  bookingReference: z.string().trim().max(40).optional(),
});

function publicRequest(request) {
  return {
    id: request.id,
    customerName: request.customerName,
    phone: request.phone,
    appliance: request.appliance,
    note: request.note || null,
    bookingReference: request.bookingReference || null,
    mode: request.mode,
    status: request.status,
    roomName: request.roomName || null,
    joinUrl: request.roomName ? VIDEO_JOIN_BASE + '?room=' + request.roomName : null,
    arrangedBy: request.arrangedBy || null,
    createdAt: request.createdAt,
  };
}

/** Customer: ask for a live video consultation. Public, like Ask Speedy. */
router.post('/video/requests', async (req, res) => {
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid video request', details: parsed.error.flatten() });
  }
  const data = parsed.data;
  const request = {
    id: createId(),
    companyId: PLATFORM_COMPANY_ID,
    customerName: data.customerName,
    phone: data.phone,
    appliance: data.appliance,
    note: data.note,
    bookingReference: data.bookingReference,
    mode: 'UNDECIDED',
    status: 'PENDING',
    roomName: undefined,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  store.videoRequests.set(request.id, request);
  await persistVideoRequest(request);
  appendEvent('VIDEO_REQUEST_CREATED', {
    source: 'SPEEDY_LIVE_VIDEO',
    actor: 'customer:website',
    entityType: 'VIDEO_REQUEST',
    entityId: request.id,
    details: { appliance: request.appliance, bookingReference: request.bookingReference || null },
  });
  queueNotification({
    channel: 'internal',
    template: 'VIDEO_REQUEST',
    to: 'service-setters',
    source: 'SPEEDY_LIVE_VIDEO',
    payload: {
      videoRequestId: request.id,
      customerName: request.customerName,
      phone: request.phone,
      appliance: request.appliance,
      message: `New Speedy Live Video request: ${request.customerName} wants to show their ${request.appliance} live. Arrange it in the Book OS video panel.`,
    },
  });
  return res.status(201).json({
    data: {
      id: request.id,
      status: request.status,
      message: `Request received — the ${PLATFORM_CONSTANTS.dispatchTeam} team will set up your video consultation and send your join link. For anything urgent, call ${PLATFORM_CONSTANTS.phoneDisplay}.`,
    },
  });
});

/** Service Setters: the video request queue. */
router.get('/video/requests', ...staffOnly, (req, res) => {
  const requests = [...store.videoRequests.values()].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  return res.json({ data: requests.map(publicRequest) });
});

const arrangeSchema = z.object({
  mode: z.enum(['IMMEDIATE', 'SCHEDULED', 'MANAGER_ASSISTED']),
});

/** Service Setters: arrange a request — creates the room. */
router.post('/video/requests/:id/arrange', ...staffOnly, async (req, res) => {
  const request = store.videoRequests.get(req.params.id);
  if (!request) return res.status(404).json({ error: 'Video request not found' });
  const parsed = arrangeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid arrange request', details: parsed.error.flatten() });
  }
  if (!request.roomName) {
    request.roomName = 'topspeed-' + createId().replace(/-/g, '').slice(0, 16);
  }
  request.mode = parsed.data.mode;
  request.status = 'ROOM_READY';
  request.arrangedBy = req.user?.email || 'service-setters';
  request.updatedAt = new Date().toISOString();
  await persistVideoRequest(request);
  appendEvent('VIDEO_REQUEST_ARRANGED', {
    source: 'BOOK_OS',
    actor: request.arrangedBy,
    entityType: 'VIDEO_REQUEST',
    entityId: request.id,
    details: { mode: request.mode, roomName: request.roomName },
  });
  const joinUrl = VIDEO_JOIN_BASE + '?room=' + request.roomName;
  queueNotification({
    channel: 'sms',
    template: 'VIDEO_REQUEST',
    to: request.phone,
    source: 'SPEEDY_LIVE_VIDEO',
    payload: {
      videoRequestId: request.id,
      joinUrl,
      mode: request.mode,
      message:
        `Top Speed Appliance: your video consultation for the ${request.appliance} is set up (${request.mode.replace(/_/g, ' ').toLowerCase()}). ` +
        `Join here when it's time: ${joinUrl} — no app to install, just tap the link.`,
    },
  });
  return res.json({ data: publicRequest(request) });
});

/** Service Setters: mark a consultation done. */
router.post('/video/requests/:id/complete', ...staffOnly, async (req, res) => {
  const request = store.videoRequests.get(req.params.id);
  if (!request) return res.status(404).json({ error: 'Video request not found' });
  request.status = 'DONE';
  request.updatedAt = new Date().toISOString();
  await persistVideoRequest(request);
  return res.json({ data: publicRequest(request) });
});

/**
 * Public room lookup for the /video join page: first name + appliance
 * only — enough to confirm you're in the right room, nothing private.
 */
router.get('/video/room/:roomName', (req, res) => {
  const request = [...store.videoRequests.values()].find((r) => r.roomName === req.params.roomName);
  if (!request) return res.status(404).json({ error: 'Video room not found' });
  return res.json({
    data: {
      roomName: request.roomName,
      appliance: request.appliance,
      customerFirstName: (request.customerName || '').split(' ')[0] || 'Guest',
      mode: request.mode,
      status: request.status,
      provider: 'jitsi',
      providerRoomUrl: 'https://meet.jit.si/' + request.roomName,
    },
  });
});

export default router;
