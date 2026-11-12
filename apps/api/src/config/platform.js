import { SERVICE_AREAS, SERVICE_CITIES } from './serviceAreas.js';

/**
 * The ecosystem map: every customer-facing surface, what it is for, and
 * the shared facts all of them must render identically. Surfaces should
 * read GET /api/v1/platform/surfaces instead of hard-coding the phone
 * number, fee, or service areas, so the facts can never drift apart.
 */
export const PLATFORM_CONSTANTS = {
  platformOwner: 'Top Speed Appliance LLC',
  platformName: 'Top Speed Service OS',
  slogan: 'The Faster, The Better.',
  phone: '954-931-7997',
  phoneDisplay: '(954) 931-7997',
  officeAddress: '6810 N State Rd 7, Suite 341, Coconut Creek, FL 33073',
  diagnosticFee: 99,
  diagnosticFeeCurrency: 'USD',
  feeStatus: 'collected_at_booking',
  feeTerms: '$99 diagnostic fee, collected at booking and credited toward the repair.',
  dispatchMode: 'HYBRID',
  dispatchTeam: 'Service Setters',
  serviceCities: SERVICE_CITIES,
  serviceAreas: SERVICE_AREAS,
};

/** Normalize a US phone number to E.164 (+1XXXXXXXXXX); fallback when unusable. */
function toE164(raw, fallback) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return fallback;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
}

/**
 * Voice forwarding (Twilio): calls to the toll-free business number ring
 * through to the owner's phone; unanswered calls land in a voicemail box
 * served by routes/twilioVoice.js. Both numbers are env-overridable so
 * they never drift as scattered literals:
 *   TWILIO_PHONE_NUMBER — the toll-free number on the Twilio account
 *                         (the same number SMS sends from; default below)
 *   VOICE_FORWARD_TO    — where inbound calls ring (default: the
 *                         business line, 954-931-7997)
 */
export function voiceConfig() {
  return {
    tollFreeNumber: toE164(process.env.TWILIO_PHONE_NUMBER, '+18444607038'),
    forwardTo: toE164(process.env.VOICE_FORWARD_TO, '+19549317997'),
    dialTimeoutSeconds: 30,
  };
}

export const INTAKE_SOURCES = [
  'NET_SITE',
  'COM_SITE',
  'CUSTOMER_LANDING',
  'PROVIDER_LANDING',
  'PM_LANDING',
  'GOOGLE_FORM',
  'PHONE',
  'OTHER',
];

export const SURFACES = [
  {
    id: 'NET_SITE',
    name: 'topspeedappliance.net',
    kind: 'DOMAIN',
    role: 'Customer flagship: services, smart booking, AI diagnosis preview, live tech tracking, customer accounts.',
    audience: 'Homeowners and residential customers',
    primaryActions: ['BOOKING'],
  },
  {
    id: 'COM_SITE',
    name: 'topspeedapplianceservice.com',
    kind: 'DOMAIN',
    role: 'Service-request front door plus the provider-network home: fast requests, commercial requests, network recruiting.',
    audience: 'Customers with an urgent request, commercial clients, providers',
    primaryActions: ['BOOKING', 'PROVIDER_APPLICATION', 'PM_LEAD'],
  },
  {
    id: 'CUSTOMER_LANDING',
    name: 'Customer landing page',
    kind: 'LANDING_PAGE',
    role: 'Campaign landing page for topspeedappliance.net traffic: photo diagnosis, live tracking, 60-second booking.',
    audience: 'Homeowners arriving from ads, flyers, and QR codes',
    primaryActions: ['BOOKING'],
  },
  {
    id: 'PROVIDER_LANDING',
    name: 'Provider Network landing page',
    kind: 'LANDING_PAGE',
    role: 'Recruiting page for topspeedapplianceservice.com: join the network, application form.',
    audience: 'Independent technicians and repair businesses',
    primaryActions: ['PROVIDER_APPLICATION'],
  },
  {
    id: 'PM_LANDING',
    name: 'Property Managers landing page',
    kind: 'LANDING_PAGE',
    role: 'B2B page: one portal for every unit, work orders, photo reports, consolidated invoicing.',
    audience: 'Property managers, landlords, HOAs, realtors',
    primaryActions: ['PM_LEAD'],
  },
  {
    id: 'GOOGLE_FORM',
    name: 'Booking intake (Google Form + Sheet + Tasks)',
    kind: 'INTERIM_INTAKE',
    role: 'Interim booking capture while the native booking system is built: form responses land in the Booking Log sheet and a follow-up task list. Reconciles into the API intake at Phase 4.',
    audience: 'Customers booking from the live Ecosystem page',
    primaryActions: ['BOOKING'],
  },
  {
    id: 'PHONE',
    name: 'Phone — (954) 931-7997',
    kind: 'CHANNEL',
    role: 'Staff-entered bookings and applications taken on a call, entered through the same universal intake so nothing lives outside the system.',
    audience: 'Anyone who calls instead of booking online',
    primaryActions: ['BOOKING', 'PROVIDER_APPLICATION', 'PM_LEAD'],
  },
];
