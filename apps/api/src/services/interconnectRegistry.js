import { platformEventsRepo } from '../db/platformEventsRepo.js';

/**
 * Platform Interconnect registry (2026-11-19) — the wiring map of the
 * whole Top Speed ecosystem, behind the /interconnect console in the
 * Workstation.
 *
 * Ramone's direction: "Write a super advanced software that
 * interconnect every platforms" — built as a layer ON the one Service
 * OS backend every surface already shares, not as a second system.
 * This registry is the honest inventory of that wiring:
 *
 *   identity — whether the surface can RECEIVE a signed-in handoff
 *     (its /auth-handoff/ receiver is deployed), verified by actually
 *     fetching the receiver path on the real domain; the date of the
 *     last verification rides along. States: live / pending-promotion
 *     (shipped, awaiting the owner's Vercel Promote) / not-built /
 *     not-applicable (no accounts there by design).
 *   api — how the surface reaches the one backend: same-deployment,
 *     direct-cors (its origin is on the API allowlist), a same-origin
 *     rewrite proxy, or none. Verified with incomplete-body contract
 *     probes (a 400 means the contract is alive; no test records are
 *     ever created).
 *   eventSources — the platform event feed's source tags this
 *     surface's activity lands under; the console joins the surface's
 *     most recent REAL event from the durable feed (or says plainly
 *     that none has been recorded yet).
 *   services — which shared services the surface actually uses
 *     (Speedy, first-touch attribution, payments, the notification
 *     outbox). Conservative by rule: a service is only marked when it
 *     was verified in code or by probe — never decoratively.
 *
 * Static facts here are re-verified at every interconnect build; the
 * event data is read live from the feed on every console load.
 */

export const INTERCONNECT_VERIFIED_ON = '2026-11-19';

export const INTERCONNECT_SURFACES = [
  {
    id: 'flagship-web',
    name: 'Flagship — Top Speed Service OS',
    hosts: ['topspeedserviceos.com', 'www.topspeedserviceos.com', 'topspeedrepairs.com'],
    home: 'https://topspeedserviceos.com',
    kind: 'The platform itself: Workstation consoles, customer app, booking, Speedy.',
    identity: {
      state: 'live',
      receiverPath: '/auth-handoff/',
      verifiedOn: INTERCONNECT_VERIFIED_ON,
      note: 'Receiver serves on the flagship host (fetched 200 with the redeem contract present).',
    },
    api: { mode: 'same-deployment', verifiedOn: INTERCONNECT_VERIFIED_ON, note: 'The web project and the API are this platform — every console calls the one backend.' },
    eventSources: ['WEB_FORM', 'SPEEDY_CHAT'],
    services: { speedy: true, attribution: true, payments: true, outbox: true },
  },
  {
    id: 'tech-app',
    name: 'Tech App — Field Pro + Appliance Plug',
    hosts: ['topspeedserviceos.com/tech'],
    home: 'https://topspeedserviceos.com/tech',
    kind: 'The main work-order app for technicians and subcontractors, with the Plug camera tool.',
    identity: {
      state: 'live',
      receiverPath: '/auth-handoff/',
      verifiedOn: INTERCONNECT_VERIFIED_ON,
      note: 'Same origin as the flagship — the flagship receiver and session vault cover it.',
    },
    api: { mode: 'same-deployment', verifiedOn: INTERCONNECT_VERIFIED_ON, note: 'Provider board, job workspace and Plug reads all run on the one backend.' },
    eventSources: ['TECH_APP'],
    services: { speedy: true, attribution: false, payments: true, outbox: true },
  },
  {
    id: 'topspeed-net',
    name: 'topspeedappliance.net — customer site',
    hosts: ['topspeedappliance.net', 'www.topspeedappliance.net'],
    home: 'https://topspeedappliance.net',
    kind: 'Customer website and landing pages (React app, orbit-haven branch).',
    identity: {
      state: 'pending-promotion',
      receiverPath: '/auth-handoff/',
      verifiedOn: INTERCONNECT_VERIFIED_ON,
      note: 'Receiver + session vault shipped to the orbit-haven branch (blob-verified in the repo and present in the site build output); production serves them after the owner\u2019s Promote step (the standing .net rule).',
    },
    api: { mode: 'direct-cors', verifiedOn: INTERCONNECT_VERIFIED_ON, note: 'Bookings post straight to the API (origin allowlisted — incomplete-body probe answered 400 with the allow-origin header). Bookings carry source FLAGSHIP_NET and the [via: \u2026] tag.' },
    eventSources: ['FLAGSHIP_NET'],
    services: { speedy: true, attribution: true, payments: true, outbox: true },
  },
  {
    id: 'appliancepro',
    name: 'appliancepro.net — Appliance Pro (commercial)',
    hosts: ['appliancepro.net', 'www.appliancepro.net'],
    home: 'https://www.appliancepro.net',
    kind: 'Commercial portal: business sign-in, work-order and account requests.',
    identity: {
      state: 'live',
      receiverPath: '/auth-handoff/',
      verifiedOn: INTERCONNECT_VERIFIED_ON,
      note: 'Receiver + session vault deployed on the portal (fetched 200 after the interconnect build). The portal reads the same tsos_token the vault mirrors, so a carried session opens the business gate exactly like a local sign-in.',
    },
    api: { mode: 'direct-cors', verifiedOn: INTERCONNECT_VERIFIED_ON, note: 'Lead and account forms post to POST /connections on the one backend (probe answered 400); utm_source/medium/campaign ride along when present. Portal sessions call the API with the shared token.' },
    eventSources: ['appliancepro-net'],
    services: { speedy: true, attribution: true, payments: false, outbox: true },
  },
  {
    id: 'cleanoutvents',
    name: 'cleanoutvents.com — Cleanout Vents (partner)',
    hosts: ['cleanoutvents.com', 'www.cleanoutvents.com'],
    home: 'https://www.cleanoutvents.com',
    kind: 'Registered vendor partner site for the three vent services.',
    identity: {
      state: 'live',
      receiverPath: '/auth-handoff/',
      verifiedOn: INTERCONNECT_VERIFIED_ON,
      note: 'Receiver + session vault deployed (fetched 200 after the interconnect build); the site\u2019s account door now carries a signed-in holder to the flagship app without a second sign-in.',
    },
    api: { mode: 'none', verifiedOn: INTERCONNECT_VERIFIED_ON, note: 'No direct API calls by design — the domain is not a CORS origin (verified by probe). Vent bookings run through the Service OS partner page, which is the shared intake.' },
    eventSources: [],
    services: { speedy: false, attribution: false, payments: false, outbox: false },
  },
  {
    id: 'appliance-connect',
    name: 'Appliance Connect — homeowners & property managers',
    hosts: ['applianceconnectpro.com', 'www.applianceconnectpro.com', 'appliance-connect.vercel.app'],
    home: 'https://applianceconnectpro.com',
    kind: 'Connect Pro web portal + mobile web app (sign-in only on mobile).',
    identity: {
      state: 'live',
      receiverPath: '/auth-handoff/',
      verifiedOn: INTERCONNECT_VERIFIED_ON,
      note: 'Receiver serves on the Connect Pro host (fetched 200); the app keeps its own vault (ac_sessions_v1) on the same redeem contract.',
    },
    api: { mode: 'direct-cors', verifiedOn: INTERCONNECT_VERIFIED_ON, note: 'Portal and mobile call the one backend directly (origins allowlisted).' },
    eventSources: [],
    services: { speedy: false, attribution: false, payments: false, outbox: false },
  },
  {
    id: 'pepper-lists',
    name: 'Pepper Lists — Sell · Post · Book',
    hosts: ['pepperlists.com', 'www.pepperlists.com'],
    home: 'https://pepperlists.com',
    kind: 'Consumer app: marketplace selling, posting, reviews, and booking.',
    identity: {
      state: 'live',
      receiverPath: '/auth-handoff/',
      verifiedOn: INTERCONNECT_VERIFIED_ON,
      note: 'Served from the flagship deployment — receiver fetched 200 on the Pepper Lists host.',
    },
    api: { mode: 'same-deployment', verifiedOn: INTERCONNECT_VERIFIED_ON, note: 'The Pepper Lists site is part of the flagship web deployment and calls the one backend.' },
    eventSources: ['pepper-lists', 'pepper-lists-ads'],
    services: { speedy: true, attribution: true, payments: true, outbox: true },
  },
  {
    id: 'tsar',
    name: 'topspeedappliancerepair.com — brand landing site',
    hosts: ['topspeedappliancerepair.com', 'www.topspeedappliancerepair.com'],
    home: 'https://topspeedappliancerepair.com',
    kind: 'Brand landing page with the live booking form.',
    identity: {
      state: 'not-built',
      receiverPath: null,
      verifiedOn: INTERCONNECT_VERIFIED_ON,
      note: 'A door site, not a signed-in travel target — the host is not in the handoff allowlist, and its Book / Tell Speedy doors land on the flagship.',
    },
    api: { mode: 'same-origin-proxy', verifiedOn: INTERCONNECT_VERIFIED_ON, note: 'Its /api/v1/* paths rewrite to the production API (incomplete-body probe through the proxy answered 400). Bookings carry via=topspeedappliancerepair.com into the shared intake.' },
    eventSources: [],
    services: { speedy: true, attribution: true, payments: true, outbox: true },
  },
  {
    id: 'thar',
    name: 'totalhomeappliance.com — Total Home Appliance Repair',
    hosts: ['totalhomeappliance.com', 'www.totalhomeappliance.com'],
    home: 'https://www.totalhomeappliance.com',
    kind: 'Partner-brand site with the live booking form.',
    identity: {
      state: 'not-built',
      receiverPath: null,
      verifiedOn: INTERCONNECT_VERIFIED_ON,
      note: 'Not a signed-in travel target (host not in the handoff allowlist); its account doors land on the flagship surfaces.',
    },
    api: { mode: 'direct-cors', verifiedOn: INTERCONNECT_VERIFIED_ON, note: 'The live bundle posts bookings straight to the API (origin allowlisted — probe answered 400 with the allow-origin header), with the via tag attached.' },
    eventSources: [],
    services: { speedy: true, attribution: true, payments: true, outbox: true },
  },
  {
    id: 'referral',
    name: 'appliancereferral.com — Refer & Earn',
    hosts: ['appliancereferral.com', 'www.appliancereferral.com'],
    home: 'https://appliancereferral.com',
    kind: 'Public referral front door (the program itself runs on the flagship).',
    identity: {
      state: 'live',
      receiverPath: '/auth-handoff/',
      verifiedOn: INTERCONNECT_VERIFIED_ON,
      note: 'The receiver file serves on this host via the flagship deployment (fetched 200). The host is not an allowlisted travel target, so doors never wrap to it — the referral app is a flagship surface.',
    },
    api: { mode: 'same-deployment', verifiedOn: INTERCONNECT_VERIFIED_ON, note: 'An alias of the flagship web deployment.' },
    eventSources: ['REFERRAL'],
    services: { speedy: false, attribution: true, payments: false, outbox: true },
  },
  {
    id: 'provider-network',
    name: 'topspeedapplianceservice.com — provider network',
    hosts: ['topspeedapplianceservice.com', 'www.topspeedapplianceservice.com'],
    home: 'https://topspeedapplianceservice.com',
    kind: 'Provider-network door into the flagship provider surfaces.',
    identity: {
      state: 'not-built',
      receiverPath: null,
      verifiedOn: INTERCONNECT_VERIFIED_ON,
      note: 'A door site — it routes providers into the flagship, where the receiver and vault live.',
    },
    api: { mode: 'same-deployment', verifiedOn: INTERCONNECT_VERIFIED_ON, note: 'Redirects into the flagship deployment.' },
    eventSources: [],
    services: { speedy: false, attribution: false, payments: false, outbox: false },
  },
  {
    id: 'appliance-plus',
    name: 'Appliance Plus — Parts Supply platform',
    hosts: ['applianceplus.vercel.app'],
    home: 'https://applianceplus.vercel.app',
    kind: 'Parts Supply OS partner storefront (Appliance Plus Parts Supply).',
    identity: {
      state: 'not-applicable',
      receiverPath: null,
      verifiedOn: INTERCONNECT_VERIFIED_ON,
      note: 'Demo storefront — it has no accounts by design. The partner record itself lives in the Service OS.',
    },
    api: { mode: 'none', verifiedOn: INTERCONNECT_VERIFIED_ON, note: 'Demo catalog only; no live intake. Supplier and partner data is held in the Service OS.' },
    eventSources: [],
    services: { speedy: false, attribution: false, payments: false, outbox: false },
  },
  {
    id: 'gateway-express',
    name: 'Gateway Express — Lynk AI OS',
    hosts: [],
    home: null,
    kind: 'Separate local platform (storage / moving ecosystem) with its own AI layer.',
    identity: {
      state: 'not-applicable',
      receiverPath: null,
      verifiedOn: INTERCONNECT_VERIFIED_ON,
      note: 'Local-only by the owner\u2019s rule — it is not deployed, so there is no host to receive a handoff.',
    },
    api: { mode: 'none', verifiedOn: INTERCONNECT_VERIFIED_ON, note: 'Runs locally with its own database and keys; interconnects by design documents, not by live traffic.' },
    eventSources: [],
    services: { speedy: false, attribution: false, payments: false, outbox: false },
  },
];

const API_MODE_LABELS = {
  'same-deployment': 'Same deployment',
  'direct-cors': 'Direct API (CORS)',
  'same-origin-proxy': 'Same-origin proxy',
  none: 'No direct API path',
};

const IDENTITY_LABELS = {
  live: 'Receiver live',
  'pending-promotion': 'Shipped — promotion pending',
  'not-built': 'No receiver',
  'not-applicable': 'Not applicable',
};

/**
 * The registry payload for the console: the static wiring facts above
 * joined with the LIVE event feed (per-surface last event + feed
 * totals). The feed section degrades independently — if the feed
 * cannot be read, the surfaces still render with eventsAvailable:
 * false instead of invented activity.
 */
export async function buildInterconnectRegistry() {
  let feed = { available: true, totalEvents: null, last24h: null };
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [totalEvents, last24h] = await Promise.all([
      platformEventsRepo.countAll(),
      platformEventsRepo.countSince(since),
    ]);
    feed = { available: true, totalEvents, last24h };
  } catch (error) {
    feed = { available: false, reason: 'The event feed could not be read right now.', totalEvents: null, last24h: null };
    console.error(JSON.stringify({ level: 'error', message: 'interconnect feed read failed', error: String(error?.message || error) }));
  }

  const surfaces = [];
  for (const surface of INTERCONNECT_SURFACES) {
    let lastEvent = null;
    let eventsAvailable = feed.available;
    if (eventsAvailable && surface.eventSources.length) {
      try {
        lastEvent = await platformEventsRepo.lastForSources(surface.eventSources);
      } catch {
        eventsAvailable = false;
      }
    }
    surfaces.push({
      id: surface.id,
      name: surface.name,
      hosts: surface.hosts,
      home: surface.home,
      kind: surface.kind,
      identity: { ...surface.identity, label: IDENTITY_LABELS[surface.identity.state] || surface.identity.state },
      api: { ...surface.api, label: API_MODE_LABELS[surface.api.mode] || surface.api.mode },
      eventSources: surface.eventSources,
      services: surface.services,
      eventsAvailable,
      lastEvent: lastEvent
        ? { type: lastEvent.type, at: lastEvent.at, source: lastEvent.source, referenceCode: lastEvent.referenceCode }
        : null,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    verifiedOn: INTERCONNECT_VERIFIED_ON,
    feed,
    surfaces,
  };
}
