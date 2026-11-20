/**
 * The PLATFORM's Facebook connection (Pepper Lists Phase A,
 * 2026-11-20) — the Top Speed owner's own Facebook account, which
 * Pepper operates through the connected facebook_cli connector
 * (Marketplace listings, Page posts) behind Ramone's approval.
 *
 * HONEST SCOPE: the API server cannot probe that connector — it
 * lives on Pepper's agent VM, not on Vercel — so the connection
 * state here is a VERIFIED CONFIG ATTESTATION, not a live probe:
 * Pepper checks the connector directly (`facebook-cli me`) and the
 * verified account is recorded below. platformFacebookConnection()
 * validates the record's shape on every call and returns null when
 * the record is missing, malformed, or disabled by env
 * (FACEBOOK_CONNECTOR_DISABLED=1) — and when it returns null,
 * NOTHING in the platform may present Facebook as connected. Env
 * overrides (FACEBOOK_CONNECTOR_ACCOUNT_NAME / _ACCOUNT_ID /
 * _VERIFIED_AT) let the office update the attestation without a
 * code change when the account is re-verified or replaced.
 *
 * This is deliberately scoped to the PLATFORM OWNER's own Pepper
 * Lists account: every other seller's channels stay on the Phase 1
 * request model until seller-level Facebook OAuth exists (Phase B).
 */

// Verified by Pepper on 2026-11-20 via `facebook-cli me`:
// Ramone Williams, fb_user_id 100010379987712 (connected).
const VERIFIED = {
  accountName: 'Ramone Williams',
  accountId: '100010379987712',
  verifiedAt: '2026-11-20',
};

export function platformFacebookConnection() {
  if (process.env.FACEBOOK_CONNECTOR_DISABLED === '1') return null;
  const accountName = (process.env.FACEBOOK_CONNECTOR_ACCOUNT_NAME ?? VERIFIED.accountName).trim();
  const accountId = (process.env.FACEBOOK_CONNECTOR_ACCOUNT_ID ?? VERIFIED.accountId).trim();
  const verifiedAt = (process.env.FACEBOOK_CONNECTOR_VERIFIED_AT ?? VERIFIED.verifiedAt).trim();
  if (!accountName) return null;
  if (!/^\d{5,}$/.test(accountId)) return null;
  if (Number.isNaN(Date.parse(verifiedAt))) return null;
  return {
    connected: true,
    accountName,
    accountId,
    verifiedAt,
    via: 'facebook-cli connector (verified by Pepper)',
  };
}
