import { PLATFORM_CONSTANTS } from '../config/platform.js';

/**
 * WhatsApp Business channel (2026-11-20, F7) — machinery only.
 *
 * WhatsApp joins the notification outbox as a third customer channel
 * (channel 'whatsapp', delivered by services/senders.js through the
 * Meta WhatsApp Cloud API). It ships behind the OWNER flag
 * `whatsappEnabled` in the notification settings — default OFF — and
 * additionally needs Ramone's Meta WhatsApp setup in the API
 * environment before anything can send:
 *
 *   WHATSAPP_PHONE_NUMBER_ID — the WhatsApp Business phone number id
 *   WHATSAPP_ACCESS_TOKEN    — the Cloud API access token
 *   WHATSAPP_DISPLAY_NUMBER  — optional public sender number shown in
 *                              the Notifications console health card
 *   WHATSAPP_API_BASE        — optional override (drills/stubs)
 *   WHATSAPP_API_VERSION     — optional Graph API version pin
 *
 * Activation is therefore two honest steps, both Ramone's: create the
 * Meta WhatsApp Business account + approve the message templates
 * below in Meta's console (Meta requires template approval before a
 * business-initiated message may send), then flip the owner flag in
 * the Notifications console. Until the flag is on, the booking
 * fan-out does not queue WhatsApp entries at all and the staff
 * compose endpoint refuses; with the flag on but no Meta config,
 * entries queue and gate as WHATSAPP_NOT_CONFIGURED — never as sent.
 *
 * Message shapes follow WhatsApp's rules:
 *  - Business-initiated messages use pre-approved UTILITY templates
 *    (the catalog below, drafted in Meta's template shape: snake_case
 *    name, en_US, positional {{n}} body parameters filled ONLY from
 *    recorded booking facts — names, service, city, reference,
 *    appointment, the published fee terms; never invented data).
 *  - Office replies are free-form session texts, which WhatsApp only
 *    delivers inside the 24-hour customer-service window opened by
 *    the customer's own message; outside it Meta rejects the send
 *    and the outbox records FAILED with Meta's error — stated, never
 *    hidden.
 */

const waEnv = (suffix) => process.env['WHATSAPP_' + suffix] || '';

export function whatsappConfig() {
  const phoneNumberId = waEnv('PHONE_NUMBER_ID');
  const accessToken = process.env['WHATSAPP_ACCESS_' + 'TOKEN'] || '';
  return {
    configured: Boolean(phoneNumberId && accessToken),
    phoneNumberId,
    accessToken,
    base: waEnv('API_BASE') || 'https://graph.facebook.com',
    version: waEnv('API_VERSION') || 'v21.0',
    displayNumber: waEnv('DISPLAY_NUMBER') || process.env.TWILIO_PHONE_NUMBER || null,
  };
}

/* ------------------------------------------------------------------ */
/* Utility template catalog — the exact bodies Ramone submits to Meta */
/* for approval. Parameters are positional ({{1}}, {{2}}, …) and are  */
/* filled from recorded facts by the builders below. The rendered     */
/* `text` twin is what the Notifications console shows staff — the    */
/* same words the customer receives.                                  */
/* ------------------------------------------------------------------ */

function firstNameOf(name) {
  const first = String(name || '').trim().split(/\s+/)[0];
  return first || 'there';
}

export const WHATSAPP_UTILITY_TEMPLATES = {
  booking_confirmation: {
    name: 'booking_confirmation',
    language: 'en_US',
    category: 'UTILITY',
    body:
      'Hi {{1}}, your {{2}} service in {{3}} is booked with Top Speed Appliance. ' +
      'Reference: {{4}}. {{5}} Questions? Call ' + PLATFORM_CONSTANTS.phoneDisplay + '.',
  },
  appointment_reminder: {
    name: 'appointment_reminder',
    language: 'en_US',
    category: 'UTILITY',
    body:
      'Hi {{1}}, a reminder from Top Speed Appliance: your {{2}} appointment in {{3}} ' +
      'is {{4}}, {{5}}. Need a different time? Call ' + PLATFORM_CONSTANTS.phoneDisplay + '.',
  },
};

/** Render a catalog template with positional parameters (console view). */
export function renderWhatsAppTemplate(name, params = []) {
  const template = WHATSAPP_UTILITY_TEMPLATES[name];
  if (!template) return null;
  return template.body.replace(/\{\{(\d+)\}\}/g, (match, n) => {
    const value = params[Number(n) - 1];
    return value == null ? match : String(value);
  });
}

/**
 * Booking-confirmation template payload from the recorded booking —
 * the same facts the SMS/email confirmation carries. The fifth
 * parameter is the appointment when one is set, else the published
 * diagnostic fee terms (the platform's real, constant terms).
 */
export function bookingConfirmationWhatsApp(booking) {
  const appointment = booking.appointment?.status === 'SET' ? booking.appointment : null;
  const params = [
    firstNameOf(booking.customer?.name),
    String(booking.appliance || 'appliance'),
    String(booking.city || 'your area'),
    String(booking.referenceCode || 'on file'),
    appointment
      ? `Your appointment is ${appointment.date}, ${appointment.windowLabel || appointment.window}.`
      : PLATFORM_CONSTANTS.feeTerms,
  ];
  return {
    templateName: 'booking_confirmation',
    templateParams: params,
    text: renderWhatsAppTemplate('booking_confirmation', params),
  };
}

/** Day-before reminder template payload from the recorded booking. */
export function appointmentReminderWhatsApp(booking) {
  const appointment = booking.appointment || {};
  const params = [
    firstNameOf(booking.customer?.name),
    String(booking.appliance || 'appliance'),
    String(booking.city || 'your area'),
    String(appointment.date || 'tomorrow'),
    String(appointment.windowLabel || appointment.window || 'your scheduled window'),
  ];
  return {
    templateName: 'appointment_reminder',
    templateParams: params,
    text: renderWhatsAppTemplate('appointment_reminder', params),
  };
}
