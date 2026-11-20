import { PLATFORM_COMPANY_ID, store } from '../data/store.js';
import { loadDispatchSettings } from '../db/dispatchOpsRepo.js';
import { APPOINTMENT_WINDOWS, isValidDateString } from './bookos.js';
import { capacityCeiling } from './dispatchOps.js';

/**
 * Live arrival-window availability (2026-11-20, recommendation A1).
 *
 * One read behind every customer window picker — the booking form,
 * the homepage wizard, the /app Book step, and Speedy's post-summary
 * window offer all ask the same question: for this service day, which
 * of the five two-hour windows are still open?
 *
 * A window is CLOSED for exactly two honest reasons:
 * - PAST — the day is over, or (today) the window's end time has
 *   passed on the business clock (America/New_York — the same clock
 *   Book OS appointment setting refuses past dates against).
 * - FULL — the office's own capacity settings say the day is sized
 *   for fewer jobs than are already appointed into that window.
 *
 * Capacity semantics (read before changing): the DispatchSetting row
 * behind GET/PUT /bookos/capacity-settings is a PLANNING estimate —
 * technicians × working hours × 60 × (1 − buffer) ÷ minutes per job
 * (services/dispatchOps.capacityCeiling) — and the office's capacity
 * view says so: "It informs the office; it never blocks a booking."
 * This read honors that: it never refuses a booking anywhere (the
 * create paths do not consult it); it only tells the picker which
 * windows to present as full. The day ceiling is spread evenly over
 * the five windows (ceil, so a small crew still leaves every window
 * offerable until appointments actually fill it).
 *
 * When the office has never saved capacity settings there is no
 * estimate to present — capacityConfigured is false and every window
 * shows OPEN (the PAST rule still applies). The display activates
 * when the office sets capacity in Book OS. The same is true when no
 * active technician is on the roster: a zero ceiling cannot size a
 * window, so nothing is presented as full.
 *
 * "Booked" counts mirror the setter capacity model: bookings of the
 * platform company holding a SET appointment on that date/window,
 * excluding cancelled and completed jobs.
 *
 * Results are cached per date for 30 seconds (the googleSeo.js
 * in-memory idiom) — a picker does not need second precision, and
 * the staff actions that move the numbers (appointment set /
 * reschedule, capacity-settings save) clear the cache immediately.
 */

const CACHE_TTL_MS = 30_000;
const cache = new Map();

export function clearAvailabilityCache() {
  cache.clear();
}

const nyDateTime = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** Business-clock "now": today's date (YYYY-MM-DD) + minutes since midnight, New York. */
export function newYorkNow(now = new Date()) {
  const parts = {};
  for (const part of nyDateTime.formatToParts(now)) parts[part.type] = part.value;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function windowEndMinutes(window) {
  const [h, m] = window.end.split(':').map(Number);
  return h * 60 + m;
}

function bookedCountsForDate(date) {
  const counts = new Map(APPOINTMENT_WINDOWS.map(({ id }) => [id, 0]));
  for (const booking of store.bookings.values()) {
    if (booking.companyId !== PLATFORM_COMPANY_ID) continue;
    if (booking.status === 'CANCELLED' || booking.status === 'COMPLETED') continue;
    const appointment = booking.appointment;
    if (appointment?.status === 'SET' && appointment.date === date && counts.has(appointment.window)) {
      counts.set(appointment.window, counts.get(appointment.window) + 1);
    }
  }
  return counts;
}

async function computeWindowAvailability(date, now) {
  const settings = await loadDispatchSettings(PLATFORM_COMPANY_ID);
  // A saved DispatchSetting row is the only signal that the office has
  // set capacity: getDispatchSettings merges blueprint defaults under
  // any saved row, so "unset" can only be read off the raw store map
  // (loadDispatchSettings populates it from the database row, and
  // saveDispatchSettings populates it on save).
  const settingsSaved = store.dispatchSettings.has(PLATFORM_COMPANY_ID);
  const technicians = (store.providers || []).filter((provider) => provider.active).length;
  const ceilingJobs = capacityCeiling({ technicians, settings });
  const perWindowCapacity = ceilingJobs > 0
    ? Math.max(1, Math.ceil(ceilingJobs / APPOINTMENT_WINDOWS.length))
    : 0;
  const capacityConfigured = settingsSaved && perWindowCapacity > 0;

  const booked = bookedCountsForDate(date);
  const windows = APPOINTMENT_WINDOWS.map((window) => {
    let status = 'OPEN';
    let reason = null;
    if (date < now.date || (date === now.date && windowEndMinutes(window) <= now.minutes)) {
      status = 'CLOSED';
      reason = 'PAST';
    } else if (capacityConfigured && booked.get(window.id) >= perWindowCapacity) {
      status = 'CLOSED';
      reason = 'FULL';
    }
    return {
      id: window.id,
      label: window.label,
      start: window.start,
      end: window.end,
      status,
      reason,
    };
  });
  return { date, capacityConfigured, windows };
}

/**
 * Availability for one service day. Throws on a malformed date so the
 * route can answer 400; callers pass user input through
 * isValidDateString first where a friendlier error is wanted.
 */
export async function getWindowAvailability(date, now = newYorkNow()) {
  if (!isValidDateString(date)) throw new Error(`Invalid date: ${date}`);
  const hit = cache.get(date);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const value = await computeWindowAvailability(date, now);
  cache.set(date, { at: Date.now(), value });
  return value;
}
