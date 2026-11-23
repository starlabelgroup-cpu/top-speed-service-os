import { checkClaims } from './campaignFactory.js';

/**
 * Claim-check gate — console wiring (Flywheel Item 6 remainder,
 * 2026-11-23). The Campaign Engine's factory already gates every
 * record it generates (services/campaignFactory.js checkClaims).
 * This module is the thin console-side wrapper so HAND-WRITTEN copy
 * — Ad Studio campaigns, Speedy draft-copy output, Facebook OS
 * queue posts and ad drafts — passes the same gate before it is
 * stored. It reuses the factory's rules verbatim (no second rule
 * set to drift) and adds exactly one console rule of its own:
 *
 *   Dollar-off phrasing: the only approved dollar-off in Top Speed
 *   economics is the referred friend's $25 off their first repair.
 *   Any other "$N off" is an unapproved discount. (Percentage-off
 *   is already rejected by the factory gate.)
 *
 * findClaimViolations accepts plain strings or [field, text] pairs
 * and returns a de-duplicated violation list ({ rule, why, field? })
 * — an empty list means the copy is clean.
 */

const DOLLAR_OFF = /\$(\d[\d,]*)\s?off\b/gi;
const APPROVED_DOLLAR_OFF = '25';

export function findClaimViolations(texts, { divisionKey } = {}) {
  const violations = [];
  const seen = new Set();
  const push = (v, field) => {
    const key = `${v.rule}|${v.why}|${field || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    violations.push(field ? { ...v, field } : v);
  };
  for (const entry of texts || []) {
    const [field, text] = Array.isArray(entry) ? entry : [undefined, entry];
    if (!text || typeof text !== 'string') continue;
    for (const v of checkClaims(text, { divisionKey })) push(v, field);
    for (const match of text.matchAll(DOLLAR_OFF)) {
      if (match[1].replace(/,/g, '') !== APPROVED_DOLLAR_OFF) {
        push({
          rule: 'unapproved-discount',
          why: `$${match[1]} off is not approved economics — the only dollar-off is the referred friend's $25 off their first repair`,
        }, field);
      }
    }
  }
  return violations;
}

/** The gate's 400 in the API's service-error shape (status + code +
 *  violations), for service-layer callers whose routes serialize
 *  error.status / error.code (e.g. Facebook OS handleServiceError). */
export function claimCheckError(violations) {
  const error = new Error(
    `Copy failed the claim check: ${violations.map((v) => `${v.rule} (${v.why})`).join('; ')}`,
  );
  error.status = 400;
  error.code = 'CLAIM_CHECK_FAILED';
  error.violations = violations;
  return error;
}
