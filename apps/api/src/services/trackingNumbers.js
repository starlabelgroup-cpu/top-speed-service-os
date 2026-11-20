/**
 * Satellite Website Tracking Number System (2026-11-19).
 *
 * One vocabulary for "which surface did this contact come from", used
 * by the Twilio webhooks (inbound call/text attribution), the booking
 * payloads (CRM / Book OS / provider surfaces) and the ApplianceMan
 * Tracking Numbers registry.
 *
 * Surface keys are the Platform Interconnect registry's canonical keys
 * (services/interconnectRegistry.js) plus two platform-level keys:
 *   'platform' — the shared platform line/mailboxes (the 844 number,
 *                the service@/booking@ mailboxes);
 *   'phone'    — a booking taken by phone through the office, which
 *                has no web surface.
 *
 * Honesty rules: a booking whose via/source signals name no known
 * surface resolves to null (shown as nothing, counted as nothing) —
 * never guessed. A surface with no dedicated number is a PLANNED
 * registry row with a null value, never an invented number.
 */
import {
  listTrackingNumbers,
  findTrackingNumberBySeedKey,
  findActivePhoneByValue,
  createTrackingNumber,
  recordContactEvent,
  contactCountsSince,
} from '../db/trackingNumbersRepo.js';

export const PLATFORM_SURFACE_KEY = 'platform';

/** Display labels per canonical surface key. */
export const SURFACE_LABELS = {
  platform: 'Top Speed platform (shared)',
  'flagship-web': 'Flagship website (topspeedserviceos.com)',
  'topspeed-net': 'topspeedappliance.net',
  appliancepro: 'appliancepro.net (Appliance Pro)',
  'appliance-connect': 'Appliance Connect',
  cleanoutvents: 'cleanoutvents.com',
  'pepper-lists': 'pepperlists.com (Pepper Lists)',
  tsar: 'topspeedappliancerepair.com',
  thar: 'totalhomeappliance.com',
  referral: 'appliancereferral.com',
  'provider-network': 'topspeedapplianceservice.com (Provider Network)',
  'tech-app': 'Tech App',
  'appliance-plus': 'Appliance Plus',
  'gateway-express': 'Gateway Express',
  phone: 'Phone (office)',
};

export function surfaceLabel(surfaceKey) {
  if (!surfaceKey) return null;
  return SURFACE_LABELS[surfaceKey] || surfaceKey;
}

/** NANP normalization to E.164 — same rules as config/platform.js. */
export function normalizePhoneE164(value) {
  if (!value) return null;
  const digits = String(value).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (String(value).trim().startsWith('+') && digits.length >= 11) return `+${digits}`;
  return null;
}

/**
 * Host / via-tag → surface key. Keys are matched as substrings of the
 * lowercased signal so full URLs, bare hosts and the via tags the
 * satellite sites send all resolve. Order matters: the more specific
 * satellite hosts are tested before the flagship's own hosts.
 */
const HOST_SURFACE_RULES = [
  ['topspeedappliancerepair.com', 'tsar'],
  ['totalhomeappliance.com', 'thar'],
  ['topspeedappliance.net', 'topspeed-net'],
  ['appliancepro.net', 'appliancepro'],
  ['appliancepro.app', 'appliancepro'],
  ['appliance-connect', 'appliance-connect'],
  ['applianceconnectpro.com', 'appliance-connect'],
  ['connect-pro', 'appliance-connect'],
  ['cleanoutvents', 'cleanoutvents'],
  ['pepperlists', 'pepper-lists'],
  ['pepper-lists', 'pepper-lists'],
  ['appliancereferral.com', 'referral'],
  ['topspeedapplianceservice.com', 'provider-network'],
  ['provider-network', 'provider-network'],
  ['tech-network', 'provider-network'],
  ['network-site', 'provider-network'],
  ['gateway-express', 'gateway-express'],
  ['gatewayexpress', 'gateway-express'],
  ['appliance-plus', 'appliance-plus'],
  ['applianceplus', 'appliance-plus'],
  ['topspeedrepairs.com', 'flagship-web'],
  ['topspeedserviceos.com', 'flagship-web'],
  ['flagship', 'flagship-web'],
];

export function surfaceKeyFromSignal(signal) {
  if (!signal) return null;
  const text = String(signal).toLowerCase();
  for (const [needle, key] of HOST_SURFACE_RULES) {
    if (text.includes(needle)) return key;
  }
  return null;
}

/** Connection.source values that name a surface directly. */
const CONNECTION_SOURCE_SURFACES = {
  'appliancepro-net': 'appliancepro',
};

/** Booking.source values with a fixed surface meaning. */
const BOOKING_SOURCE_SURFACES = {
  FLAGSHIP_NET: 'topspeed-net',
  SPEEDY_CHAT: 'flagship-web',
  WEB_FORM: 'flagship-web',
  WEBSITE: 'flagship-web',
  COMMERCIAL: 'flagship-web',
  PHONE: 'phone',
};

/**
 * The lead connection behind a booking, when one exists: live
 * bookings carry it on booking.lead; rehydrated bookings resolve it
 * from the persisted BOOKING_CREATED history entry (the same join
 * Book OS leadLinkOf uses). `connections` is store.connections.
 */
export function leadConnectionOf(booking, connections) {
  if (!booking) return null;
  const list = Array.isArray(connections) ? connections : [];
  if (booking.lead?.connectionId) {
    return list.find((c) => c.id === booking.lead.connectionId) || null;
  }
  const created = (booking.history || []).find(
    (h) => (h.type || h.event) === 'BOOKING_CREATED' && (h.connectionId || h.connectionReference),
  );
  if (!created) return null;
  if (created.connectionId) {
    const byId = list.find((c) => c.id === created.connectionId);
    if (byId) return byId;
  }
  if (created.connectionReference) {
    return list.find((c) => c.reference === created.connectionReference) || null;
  }
  return null;
}

/**
 * Resolve a booking's surface: { surfaceKey, surfaceLabel } or nulls.
 * Signal order (strongest first): the booking's own via tag, its
 * first-touch page URL, the lead connection behind it (Pepper Lists
 * connection types, the connection's via, then its source), and
 * finally the booking's source enum. No signal → nulls, no guessing.
 */
export function surfaceOfBooking(booking, connection) {
  const none = { surfaceKey: null, surfaceLabel: null };
  if (!booking) return none;
  const attribution = booking.attribution || {};
  let key =
    surfaceKeyFromSignal(attribution.via) ||
    surfaceKeyFromSignal(attribution.page) ||
    null;
  if (!key && connection) {
    const connType = String(connection.type || booking.lead?.connectionType || '');
    if (connType.startsWith('PEPPER_LISTS')) key = 'pepper-lists';
    if (!key) key = surfaceKeyFromSignal(connection.attribution?.via);
    if (!key && connection.source) {
      key = CONNECTION_SOURCE_SURFACES[connection.source] || surfaceKeyFromSignal(connection.source);
    }
  }
  if (!key && booking.source) key = BOOKING_SOURCE_SURFACES[booking.source] || null;
  if (!key) return none;
  return { surfaceKey: key, surfaceLabel: surfaceLabel(key) };
}

/* ------------------------------------------------------------------ */
/* Registry seed                                                       */
/* ------------------------------------------------------------------ */

/**
 * The seed rows, applied idempotently by seedKey (create-only — a
 * manager's later edits are never overwritten). ACTIVE: the shared
 * platform line and the three managed mailboxes (config/mailboxes.js).
 * PLANNED (value null): the public customer-facing interconnect
 * surfaces that have no dedicated number yet. topspeedrepairs.com is
 * a flagship host in the interconnect registry, so its planned row
 * carries the flagship-web surface key with its own label.
 */
export const TRACKING_NUMBER_SEEDS = [
  {
    seedKey: 'shared-platform-line',
    kind: 'PHONE',
    value: '+18444607038',
    label: 'Platform line — (844) 460-7038',
    surfaceKey: 'platform',
    channels: ['VOICE', 'SMS'],
    status: 'ACTIVE',
    shared: true,
    notes: 'The shared Top Speed number every surface publishes today. Calls dial the office line; texts forward to the office phone.',
  },
  {
    seedKey: 'mailbox-service',
    kind: 'EMAIL',
    value: 'service@topspeedserviceos.com',
    label: 'Service mailbox — service@topspeedserviceos.com',
    surfaceKey: 'platform',
    channels: ['EMAIL'],
    status: 'ACTIVE',
    shared: true,
    notes: 'Super mailbox; service@topspeedappliance.net forwards here. Mail files onto CRM records in the Book OS Email Manager.',
  },
  {
    seedKey: 'mailbox-booking',
    kind: 'EMAIL',
    value: 'booking@topspeedserviceos.com',
    label: 'Booking mailbox — booking@topspeedserviceos.com',
    surfaceKey: 'platform',
    channels: ['EMAIL'],
    status: 'ACTIVE',
    shared: true,
    notes: 'Managed mailbox for booking-related mail.',
  },
  {
    seedKey: 'mailbox-updates-inbox',
    kind: 'EMAIL',
    value: 'inbox@updates.topspeedapplianceservice.com',
    label: 'Forwarded inbox — inbox@updates.topspeedapplianceservice.com',
    surfaceKey: 'platform',
    channels: ['EMAIL'],
    status: 'ACTIVE',
    shared: true,
    notes: 'Receives the forwarded copy of service@topspeedappliance.net mail.',
  },
  { seedKey: 'planned-topspeed-net', kind: 'PHONE', value: null, label: 'topspeedappliance.net — dedicated line', surfaceKey: 'topspeed-net', channels: ['VOICE', 'SMS'], status: 'PLANNED', shared: false, notes: null },
  { seedKey: 'planned-appliancepro', kind: 'PHONE', value: null, label: 'appliancepro.net — dedicated line', surfaceKey: 'appliancepro', channels: ['VOICE', 'SMS'], status: 'PLANNED', shared: false, notes: null },
  { seedKey: 'planned-appliance-connect', kind: 'PHONE', value: null, label: 'Appliance Connect — dedicated line', surfaceKey: 'appliance-connect', channels: ['VOICE', 'SMS'], status: 'PLANNED', shared: false, notes: null },
  { seedKey: 'planned-cleanoutvents', kind: 'PHONE', value: null, label: 'cleanoutvents.com — dedicated line', surfaceKey: 'cleanoutvents', channels: ['VOICE', 'SMS'], status: 'PLANNED', shared: false, notes: null },
  { seedKey: 'planned-pepper-lists', kind: 'PHONE', value: null, label: 'pepperlists.com — dedicated line', surfaceKey: 'pepper-lists', channels: ['VOICE', 'SMS'], status: 'PLANNED', shared: false, notes: null },
  { seedKey: 'planned-tsar', kind: 'PHONE', value: null, label: 'topspeedappliancerepair.com — dedicated line', surfaceKey: 'tsar', channels: ['VOICE', 'SMS'], status: 'PLANNED', shared: false, notes: null },
  { seedKey: 'planned-topspeedrepairs', kind: 'PHONE', value: null, label: 'topspeedrepairs.com — dedicated line', surfaceKey: 'flagship-web', channels: ['VOICE', 'SMS'], status: 'PLANNED', shared: false, notes: 'topspeedrepairs.com is a flagship host (interconnect registry), so this row carries the flagship-web surface.' },
  { seedKey: 'planned-thar', kind: 'PHONE', value: null, label: 'totalhomeappliance.com — dedicated line', surfaceKey: 'thar', channels: ['VOICE', 'SMS'], status: 'PLANNED', shared: false, notes: null },
];

let seedPromise = null;

/** Idempotent, create-only, never throws. Safe to call on every read. */
export function ensureTrackingSeeds() {
  if (!seedPromise) {
    seedPromise = (async () => {
      for (const seed of TRACKING_NUMBER_SEEDS) {
        try {
          const existing = await findTrackingNumberBySeedKey(seed.seedKey);
          if (!existing) await createTrackingNumber({ ...seed });
        } catch {
          /* seeding is best-effort; the registry read still answers */
        }
      }
    })();
  }
  return seedPromise;
}

/* ------------------------------------------------------------------ */
/* Inbound contact logging (Twilio webhooks)                           */
/* ------------------------------------------------------------------ */

/**
 * Record one inbound call/text against the number it reached.
 * Resolution: the dialed number (To) normalized to E.164 → a
 * registered ACTIVE phone row carries its surface and id; anything
 * else (including the shared platform line before/without its row)
 * lands on 'platform' — with the row's id when the row exists, null
 * when the number is unregistered (unattributed, counted as such).
 *
 * ABSOLUTE FAIL-OPEN: this never throws and never rejects. The
 * webhooks call it after their response is computed; a logging
 * failure must leave the TwiML byte-identical.
 */
export async function logInboundContact({ channel, to, from, externalSid } = {}) {
  try {
    const toE164 = normalizePhoneE164(to);
    if (!toE164 || !from) return null;
    const row = await findActivePhoneByValue(toE164);
    return await recordContactEvent({
      channel,
      trackingNumberId: row ? row.id : null,
      surfaceKey: row ? row.surfaceKey : PLATFORM_SURFACE_KEY,
      fromNumber: String(from),
      toNumber: toE164,
      externalSid: externalSid || null,
    });
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Registry read (ApplianceMan)                                        */
/* ------------------------------------------------------------------ */

export const TRACKING_ACTIVITY_WINDOW_DAYS = 28;

/**
 * The registry with its 28-day activity: per row, calls + texts from
 * real ContactEvent rows (PHONE rows only) and bookings attributed
 * to the row's surface in the window (every row — for EMAIL rows the
 * bookings are the SURFACE's bookings, labeled as such by the UI,
 * since mail is not attributable per-address). The 'platform' surface
 * count includes flagship-web bookings: the shared line and mailboxes
 * serve the flagship as well as the platform at large.
 */
export async function buildTrackingRegistry(bookings, connections) {
  await ensureTrackingSeeds();
  const rows = await listTrackingNumbers();
  const since = new Date(Date.now() - TRACKING_ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const { byNumber, unattributed } = await contactCountsSince(since);

  const bookingList = bookings instanceof Map ? [...bookings.values()] : Array.isArray(bookings) ? bookings : [];
  const connectionList = connections instanceof Map ? [...connections.values()] : connections;
  const bookingsBySurface = new Map();
  for (const booking of bookingList) {
    const created = booking.createdAt ? new Date(booking.createdAt).getTime() : 0;
    if (!created || created < since.getTime()) continue;
    const { surfaceKey } = surfaceOfBooking(booking, leadConnectionOf(booking, connectionList));
    if (!surfaceKey) continue;
    bookingsBySurface.set(surfaceKey, (bookingsBySurface.get(surfaceKey) || 0) + 1);
    if (surfaceKey === 'flagship-web') {
      bookingsBySurface.set('platform', (bookingsBySurface.get('platform') || 0) + 1);
    }
  }

  const statusRank = { ACTIVE: 0, PLANNED: 1, RETIRED: 2 };
  const numbers = rows
    .map((row) => {
      const counts = byNumber.get(row.id) || { VOICE: 0, SMS: 0 };
      return {
        ...row,
        surfaceLabel: surfaceLabel(row.surfaceKey),
        calls28d: row.kind === 'PHONE' ? counts.VOICE : null,
        texts28d: row.kind === 'PHONE' ? counts.SMS : null,
        bookings28d: bookingsBySurface.get(row.surfaceKey) || 0,
      };
    })
    .sort((a, b) => (statusRank[a.status] - statusRank[b.status]) || a.label.localeCompare(b.label));

  return {
    windowDays: TRACKING_ACTIVITY_WINDOW_DAYS,
    since: since.toISOString(),
    numbers,
    unattributedContacts28d: { calls: unattributed.VOICE, texts: unattributed.SMS },
  };
}
