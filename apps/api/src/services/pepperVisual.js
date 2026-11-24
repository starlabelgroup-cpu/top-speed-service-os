import { findClaimViolations } from './claimCheck.js';
import { PEPPER_VISUAL_SIZES } from './pepperVisualUrl.js';

/**
 * Pepper Visuals — the composer (2026-11-23).
 *
 * Renders the designed Pepper graphic for an in-house Flywheel
 * ad as a self-contained SVG, in the Posts by Pepper visual
 * family: deep-navy card, red accent, the Pepper badge and
 * sign-off, the platform slogan. Built for the surfaces the
 * in-house ads actually run on (the Ads OS stream, the Campaign
 * Engine registry, the Facebook OS approval queue) in three
 * sizes — landscape (stream/banner), square (social), story
 * (vertical) — all composed from the same template.
 *
 * Honesty discipline, enforced here rather than trusted:
 *  - every string that lands in the graphic passes the existing
 *    claim gate (services/claimCheck.js — the factory rules plus
 *    the console's dollar-off rule). A violating ad gets NO
 *    visual: compose returns null, the route 404s, and callers
 *    simply omit the graphic. The record's own claim-gate
 *    behavior is unchanged.
 *  - text is the ad's own (headline, subject, first copy line) —
 *    nothing is invented, no reviews, no ratings, no numbers the
 *    ad itself does not carry.
 *  - designed SVG only, no emoji anywhere in the graphic (post
 *    COPY may carry emoji; the visual strips it).
 *  - the SVG is served as an <img>, so it uses system font
 *    stacks only — no external assets, fully deterministic:
 *    the same record always renders the same graphic.
 */

const FONT = "Arial, Helvetica, sans-serif";

const LAYOUTS = {
  landscape: {
    pad: 64, badge: 78, brandSize: 30, brandSubSize: 14,
    kickerSize: 19, headlineSize: 58, headlineChars: 30, headlineLines: 3, headlineLeading: 70,
    subSize: 27, subChars: 60, subLines: 2, subLeading: 40, pillSize: 23, pillHeight: 54,
    // CTA (offer) rhythm: tighter than the post rhythm so the
    // pill always lands above the sign-off bar — see the layout
    // note in composePepperVisual.
    headlineLeadingCta: 62, subGapCta: 50, subLeadingCta: 38, pillGapCta: 22,
  },
  square: {
    pad: 72, badge: 88, brandSize: 33, brandSubSize: 15,
    kickerSize: 20, headlineSize: 64, headlineChars: 24, headlineLines: 3, headlineLeading: 78,
    subSize: 29, subChars: 54, subLines: 3, subLeading: 44, pillSize: 24, pillHeight: 58,
    headlineLeadingCta: 70, subGapCta: 54, subLeadingCta: 42, pillGapCta: 28,
  },
  story: {
    pad: 84, badge: 96, brandSize: 36, brandSubSize: 16,
    kickerSize: 22, headlineSize: 72, headlineChars: 22, headlineLines: 4, headlineLeading: 88,
    subSize: 32, subChars: 48, subLines: 3, subLeading: 48, pillSize: 26, pillHeight: 62,
    headlineLeadingCta: 80, subGapCta: 58, subLeadingCta: 46, pillGapCta: 30,
  },
};

export function sanitizeVisualText(text) {
  return String(text ?? '')
    // No emoji or pictographs in the graphic — ever.
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu, '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function xmlEscape(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function wrapVisualText(text, maxChars, maxLines) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = word;
      if (lines.length === maxLines) break;
    }
  }
  if (current && lines.length < maxLines) lines.push(current);
  if (lines.length === maxLines) {
    // Overflow: mark the last line with an ellipsis rather than
    // spilling the layout — the full text lives in the ad itself.
    const joined = lines.join(' ');
    if (joined.length < String(text).replace(/\s+/g, ' ').trim().length) {
      let last = lines[maxLines - 1];
      if (last.length > maxChars - 1) last = last.slice(0, maxChars - 1).trimEnd();
      lines[maxLines - 1] = `${last}…`;
    }
  }
  return lines;
}

/** The descriptive line under a headline: the copy's first
 *  sentence-like line, URLs stripped (a graphic is not a link),
 *  length-capped. For stream posts the first line is the ALL-CAPS
 *  hook, so callers pass the line index that reads as prose. */
export function visualLineFromCopy(copy, { skipFirstLine = false } = {}) {
  const lines = String(copy || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const picked = (skipFirstLine && lines.length > 1 ? lines[1] : lines[0]) || '';
  const stripped = picked
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\b\S+\.(?:com|net|app)\/\S*/g, '');
  const clean = sanitizeVisualText(stripped);
  if (clean.length <= 150) return clean;
  const cut = clean.slice(0, 147);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > 80 ? lastSpace : 147).trimEnd()}…`;
}

/** The CTA pill label for a campaign, from where the ad lands —
 *  only labels the platform itself stands behind. */
export function ctaLabelForLanding(landingBase) {
  let host = '';
  try { host = new URL(landingBase).hostname.replace(/^www\./, ''); } catch { /* default below */ }
  if (host === 'topspeedappliances.com') return 'Shop used appliances';
  if (host === 'pepperlists.com') return 'Browse Pepper Lists';
  if (host === 'cleanoutvents.com') return 'Visit Cleanout Vents';
  if (host === 'appliancepro.net') return 'Commercial accounts';
  if (host === 'topspeedapplianceservice.com') return 'Join the network';
  return 'Book a repair';
}

function badgeGroup(x, y, size) {
  const r = Math.round(size * 0.24);
  const fontSize = Math.round(size * 0.62);
  return `<g>
    <rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${r}" fill="#E8322E"/>
    <text x="${x + size / 2}" y="${y + size / 2 + fontSize * 0.36}" font-family="${FONT}" font-size="${fontSize}" font-weight="800" fill="#FFFFFF" text-anchor="middle">P</text>
    <path d="M ${x + size * 0.58} ${y + size * 0.86} L ${x + size * 0.94} ${y + size * 0.86} L ${x + size * 0.8} ${y + size} L ${x + size * 0.44} ${y + size} Z" fill="#FFFFFF" opacity="0.85"/>
  </g>`;
}

/**
 * Compose the graphic. Returns the SVG string, or null when any
 * rendered string fails the claim gate (the ad gets no visual).
 */
export function composePepperVisual({ kicker, headline, subline, ctaLabel, size = 'landscape', divisionKey } = {}) {
  const layoutName = PEPPER_VISUAL_SIZES[size] ? size : 'landscape';
  const L = LAYOUTS[layoutName];
  const { width, height } = PEPPER_VISUAL_SIZES[layoutName];

  const cleanKicker = sanitizeVisualText(kicker || 'TOP SPEED');
  const cleanHeadline = sanitizeVisualText(headline || '');
  const cleanSubline = sanitizeVisualText(subline || '');
  const cleanCta = sanitizeVisualText(ctaLabel || '');
  if (!cleanHeadline) return null;

  // The gate runs on the RAW strings as well as the cleaned ones:
  // sanitizing strips glyphs (★, emoji), and a stripped string
  // must never launder a claim the raw ad makes ("5★ RATED" is a
  // rating claim with or without its star). Either side failing
  // means no visual.
  const violations = findClaimViolations(
    [
      kicker, headline, subline, ctaLabel,
      cleanKicker, cleanHeadline, cleanSubline, cleanCta,
    ].filter(Boolean),
    { divisionKey },
  );
  if (violations.length) return null;

  const headlineLines = wrapVisualText(cleanHeadline, L.headlineChars, L.headlineLines);
  const subLines = cleanSubline ? wrapVisualText(cleanSubline, L.subChars, L.subLines) : [];

  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${xmlEscape(cleanHeadline)}">`);
  parts.push(`<defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0B214E"/>
      <stop offset="1" stop-color="#040B21"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.85" cy="0.08" r="0.75">
      <stop offset="0" stop-color="#2E6BFF" stop-opacity="0.28"/>
      <stop offset="1" stop-color="#2E6BFF" stop-opacity="0"/>
    </radialGradient>
  </defs>`);
  parts.push(`<rect width="${width}" height="${height}" fill="url(#bg)"/>`);
  parts.push(`<rect width="${width}" height="${height}" fill="url(#glow)"/>`);
  // Giant watermark P, clipped by the canvas — design depth in the
  // Posts by Pepper family without a second asset.
  parts.push(`<text x="${width - L.pad * 0.4}" y="${height - 110}" font-family="${FONT}" font-size="${Math.round(height * 0.52)}" font-weight="800" fill="none" stroke="#FFFFFF" stroke-opacity="0.06" text-anchor="end">P</text>`);
  // Red rule under the header.
  parts.push(`<rect x="${L.pad}" y="${L.pad + L.badge + 26}" width="72" height="6" rx="3" fill="#E8322E"/>`);

  // Header: Pepper badge + wordmark.
  parts.push(badgeGroup(L.pad, L.pad, L.badge));
  parts.push(`<text x="${L.pad + L.badge + 24}" y="${L.pad + L.brandSize + 6}" font-family="${FONT}" font-size="${L.brandSize}" font-weight="800" letter-spacing="4" fill="#FFFFFF">PEPPER</text>`);
  parts.push(`<text x="${L.pad + L.badge + 25}" y="${L.pad + L.brandSize + 6 + L.brandSubSize + 12}" font-family="${FONT}" font-size="${L.brandSubSize}" font-weight="700" letter-spacing="3" fill="#8FB0E8">TOP SPEED SERVICE OS</text>`);

  // Layout discipline (fixed 2026-11-23): the sign-off bar owns
  // the bottom of the card. Its geometry is computed FIRST, the
  // body (kicker / headline / subline / CTA pill) is composed
  // into its own group, and if the body's bottom would enter the
  // footer's zone the whole body shifts up — bounded so it can
  // never reach the header rule. The first offer build placed
  // the pill purely in flow after a 2-line headline + 2-line
  // subline, which put it ON the footer text in landscape; CTA
  // visuals therefore use a tighter rhythm (the *Cta layout
  // values) that fits the pill above the footer by construction,
  // and the shift below is the guarantee for every other case.
  const footerY = height - L.pad;
  const footerRuleY = footerY - 40;
  const hasCta = Boolean(cleanCta);
  const body = [];

  let y = L.pad + L.badge + 26 + 6 + L.kickerSize + (hasCta ? 16 : 34);
  const kickerY = y;
  body.push(`<text x="${L.pad}" y="${y}" font-family="${FONT}" font-size="${L.kickerSize}" font-weight="800" letter-spacing="3" fill="#FF8A7A">${xmlEscape(cleanKicker.toUpperCase())}</text>`);

  y += L.headlineSize + (hasCta ? 14 : 22);
  const headlineLeading = hasCta ? L.headlineLeadingCta : L.headlineLeading;
  let lastBaseline = y;
  for (const line of headlineLines) {
    body.push(`<text x="${L.pad}" y="${y}" font-family="${FONT}" font-size="${L.headlineSize}" font-weight="800" fill="#FFFFFF">${xmlEscape(line)}</text>`);
    lastBaseline = y;
    y += headlineLeading;
  }

  if (subLines.length) {
    if (hasCta) y = lastBaseline + L.subGapCta;
    else y += 2;
    const subLeading = hasCta ? L.subLeadingCta : L.subLeading;
    for (const line of subLines) {
      body.push(`<text x="${L.pad}" y="${y}" font-family="${FONT}" font-size="${L.subSize}" fill="#C9D9F6">${xmlEscape(line)}</text>`);
      lastBaseline = y;
      y += subLeading;
    }
  }

  let contentBottom;
  if (hasCta) {
    const pillWidth = Math.round(cleanCta.length * L.pillSize * 0.6) + 52;
    const pillY = lastBaseline + L.pillGapCta + (subLines.length ? 0 : 8);
    body.push(`<g>
      <rect x="${L.pad}" y="${pillY}" width="${pillWidth}" height="${L.pillHeight}" rx="${Math.round(L.pillHeight / 2)}" fill="#E8322E"/>
      <text x="${L.pad + pillWidth / 2}" y="${pillY + L.pillHeight / 2 + L.pillSize * 0.36}" font-family="${FONT}" font-size="${L.pillSize}" font-weight="800" fill="#FFFFFF" text-anchor="middle">${xmlEscape(cleanCta)}</text>
    </g>`);
    contentBottom = pillY + L.pillHeight;
  } else {
    const lastSize = subLines.length ? L.subSize : L.headlineSize;
    contentBottom = lastBaseline + Math.ceil(lastSize * 0.3);
  }

  // Footer clearance: a CTA pill keeps a 16px gap above the
  // footer rule; body text keeps 8px. The shift is capped by the
  // headroom above the kicker, so the body can never collide
  // with the header rule either.
  const clearanceLimit = footerRuleY - (hasCta ? 16 : 8);
  let shift = 0;
  if (contentBottom > clearanceLimit) {
    const headerRuleBottom = L.pad + L.badge + 26 + 6;
    const maxShift = Math.max(0, kickerY - L.kickerSize - (headerRuleBottom + 10));
    shift = Math.min(contentBottom - clearanceLimit, maxShift);
  }
  if (shift > 0) parts.push(`<g transform="translate(0 ${-shift})">`, ...body, '</g>');
  else parts.push(...body);

  // Sign-off bar: Pepper's mark + the slogan, on every graphic.
  parts.push(`<rect x="${L.pad}" y="${footerRuleY}" width="${width - L.pad * 2}" height="1.5" fill="#FFFFFF" opacity="0.16"/>`);
  parts.push(`<text x="${L.pad}" y="${footerY}" font-family="${FONT}" font-size="${L.brandSubSize + 3}" font-weight="700" letter-spacing="2" fill="#8FB0E8">PEPPER · TOPSPEEDSERVICEOS.COM</text>`);
  parts.push(`<text x="${width - L.pad}" y="${footerY}" font-family="${FONT}" font-size="${L.brandSubSize + 5}" font-weight="800" font-style="italic" fill="#FFFFFF" text-anchor="end">The Faster, The Better.</text>`);

  parts.push('</svg>');
  return parts.join('\n');
}
