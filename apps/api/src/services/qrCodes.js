import qrcode from './qrEncoder.js';

/**
 * QR codes for the field & print tools (Wave 3, 2026-11-20 — Ramone's
 * approved recommendations D11 + D15).
 *
 * One generator for every QR the platform prints or shows:
 *  - the JOB QR on a Tech App job (D11): encodes the Appliance Plug
 *    deep link for the booking reference, so any camera — Plug's own
 *    PLCamera scan mode or the phone's built-in camera — lands on the
 *    job in Plug, where the tech attaches photos to THAT job;
 *  - the Link Center print QRs (D15): booking / account / review /
 *    referral links, resolved from the same catalog the send flow
 *    uses — never a hand-typed URL.
 *
 * Rendering is a dependency-free SVG built from the module matrix of
 * the vendored Arase encoder (MIT, services/qrEncoder.js): one <path>
 * of dark modules over a white field with a 4-module quiet zone, so
 * it prints crisply at any size. Payloads are short ASCII URLs, well
 * inside byte-mode capacity at error-correction level M.
 */

export const PLUG_BASE = 'https://applianceplug.app';
export const WEB_BASE = 'https://topspeedserviceos.com';

/** The Plug deep link a job QR encodes. */
export function jobPlugUrl(referenceCode) {
  const ref = String(referenceCode || '').trim().toUpperCase();
  return `${PLUG_BASE}/?job=${encodeURIComponent(ref)}`;
}

/** The public referral link a Refer QR encodes (the /refer program). */
export function referralUrl(code) {
  return `${WEB_BASE}/refer?c=${encodeURIComponent(String(code || '').trim())}`;
}

/**
 * Pull a booking reference (TS-XXXXXX) out of whatever a scan or a
 * paste produced: the Plug deep link, any URL carrying ?job=, or the
 * bare reference itself. Returns null when the text carries no
 * reference — callers turn that into a clean "not a job code" error,
 * never a guess.
 */
export function parseJobCode(text) {
  const raw = String(text || '');
  if (!raw) return null;
  const fromParam = /[?&]job=([A-Za-z0-9-]+)/.exec(raw);
  const candidate = (fromParam ? fromParam[1] : raw).toUpperCase();
  const match = /TS-[A-Z0-9]{4,12}/.exec(candidate) || /TS-[A-Z0-9]{4,12}/.exec(raw.toUpperCase());
  return match ? match[0] : null;
}

/** Render text as a standalone SVG QR string (white field included). */
export function qrSvg(text, { margin = 4 } = {}) {
  const qr = qrcode(0, 'M');
  qr.addData(String(text), 'Byte');
  qr.make();
  const count = qr.getModuleCount();
  const size = count + margin * 2;
  let d = '';
  for (let r = 0; r < count; r += 1) {
    for (let c = 0; c < count; c += 1) {
      if (qr.isDark(r, c)) d += `M${c + margin} ${r + margin}h1v1h-1z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="QR code"><rect width="${size}" height="${size}" fill="#ffffff"/><path d="${d}" fill="#000000"/></svg>`;
}
