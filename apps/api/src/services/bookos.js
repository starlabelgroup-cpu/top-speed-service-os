import { store } from '../data/store.js';
import { effectiveArea, effectiveAreaStatus } from '../config/serviceAreas.js';

/**
 * Book OS — Service Setters appointment book.
 *
 * Starter capacity model (deterministic, Phase 1):
 * - The service day is five fixed two-hour windows.
 * - Every service area has CREWS_PER_AREA_WINDOW crew slots in each
 *   window. A slot is consumed by a booking whose appointment is SET on
 *   that date/window and whose city is that area.
 * - Capacity is *derived* from the live booking store — there is no
 *   separate capacity table to drift out of sync. When real scheduling
 *   lands, crew rosters replace the constant; the response shape stays.
 */
export const APPOINTMENT_WINDOWS = [
  { id: '08-10', start: '08:00', end: '10:00', label: '8–10 AM' },
  { id: '10-12', start: '10:00', end: '12:00', label: '10 AM–12 PM' },
  { id: '12-14', start: '12:00', end: '14:00', label: '12–2 PM' },
  { id: '14-16', start: '14:00', end: '16:00', label: '2–4 PM' },
  { id: '16-18', start: '16:00', end: '18:00', label: '4–6 PM' },
];

export const APPOINTMENT_WINDOW_IDS = APPOINTMENT_WINDOWS.map(({ id }) => id);

export const CREWS_PER_AREA_WINDOW = 2;

export function windowById(windowId) {
  return APPOINTMENT_WINDOWS.find(({ id }) => id === windowId) || null;
}

export function isValidDateString(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function todayDateString(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/**
 * Bookings currently holding a SET appointment in one area/window/date.
 * Capacity is counted against the booking's resolved Service Book area
 * (older records derive it from their city). Out-of-area and
 * area-unresolved bookings can never hold a slot.
 */
export function bookedCountForSlot({ date, windowId, city, excludeBookingId = null }) {
  let count = 0;
  for (const booking of store.bookings.values()) {
    if (excludeBookingId && booking.id === excludeBookingId) continue;
    const appointment = booking.appointment;
    if (
      appointment?.status === 'SET' &&
      appointment.date === date &&
      appointment.window === windowId &&
      effectiveAreaStatus(booking) === 'IN_AREA' &&
      effectiveArea(booking) === city &&
      booking.status !== 'COMPLETED'
    ) {
      count += 1;
    }
  }
  return count;
}

export function slotForArea({ date, windowId, city, excludeBookingId = null }) {
  const booked = bookedCountForSlot({ date, windowId, city, excludeBookingId });
  return {
    city,
    capacity: CREWS_PER_AREA_WINDOW,
    booked,
    remaining: Math.max(0, CREWS_PER_AREA_WINDOW - booked),
  };
}
