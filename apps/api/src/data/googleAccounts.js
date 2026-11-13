/**
 * Multi-account Google manager registry — the REAL seed records.
 *
 * Ramone runs the Top Speed Google presence (Business Profile, Local
 * Services Ads, Google Ads, Search Console) from more than one Gmail
 * account. This module holds the two accounts that genuinely exist
 * today; the registry page (Marketing OS → Google Accounts) is where
 * more are added as they are created and invited.
 *
 * HONESTY RULES for this registry:
 *  - It is a registry, not a live Google connection. Invites are sent
 *    and accepted inside Google's own screens; nothing here can flip a
 *    status by itself. A human updates a status after the Google side
 *    confirms it.
 *  - Seeds are create-only (upsert with an empty update): a redeploy
 *    must never overwrite edits the owner made in the registry.
 *  - No invented accounts, no invented statuses. An account that has
 *    only been invited stays INVITED until it accepts in Google.
 */

export const GOOGLE_ACCOUNT_ROLES = ['PRIMARY_OWNER', 'OWNER', 'MANAGER', 'ADMIN'];
export const GOOGLE_ACCOUNT_STATUSES = ['INVITED', 'ACTIVE', 'REVOKED'];

export const GOOGLE_ACCOUNT_SEEDS = [
  {
    email: 'starlabelgroup@gmail.com',
    label: 'Primary account',
    role: 'PRIMARY_OWNER',
    status: 'ACTIVE',
    assets: {
      gbpProfiles: [
        { name: 'Top Speed Appliance Network', verificationStatus: 'IN_PROGRESS' },
      ],
      adsAccounts: [
        { customerId: '648-991-4065', name: 'Top Speed Ads', status: 'PAUSED_BILLING' },
        { customerId: '263-240-5117', name: 'Top Speed Ads — Manager (MCC)', status: 'ACTIVE' },
      ],
      lsaAccounts: [
        { id: '473-487-5749', status: 'NOT_VERIFIED' },
      ],
      searchConsole: true,
    },
    notes: 'The original Google account: the Business Profile, the Google Ads account and its manager account, the Local Services Ads account, and Search Console were all set up here first.',
  },
  {
    email: 'topspeedrepairs@gmail.com',
    label: 'Top Speed Repairs',
    role: 'OWNER',
    status: 'INVITED',
    assets: {
      gbpProfiles: [
        { name: 'Top Speed Appliance Network', verificationStatus: 'INVITE_SENT' },
      ],
      adsAccounts: [
        { customerId: '648-991-4065', name: 'Top Speed Ads', status: 'ADMIN_INVITE_SENT' },
      ],
      lsaAccounts: [],
      searchConsole: false,
    },
    notes: 'Invitations dispatched 2026-11-13 from Google’s own screens (Business Profile owner invite + Google Ads admin invite). Mark ACTIVE here only after this account accepts in Google — the registry never auto-flips a status.',
  },
];

/**
 * The Google-side steps for bringing one Gmail account into the
 * structure. Returned by GET /marketing-os/google-accounts/checklist so
 * the registry page can guide the owner through the parts that can only
 * happen in Google's UI.
 */
export function googleAccountChecklist(accounts) {
  const steps = [
    {
      key: 'gbp-invite',
      title: 'Business Profile — send the invite',
      detail: 'In Google Business Profile (business.google.com) open the Top Speed Appliance Network profile → Users / Managers → Add user → enter the Gmail address → choose Owner (or Manager) → Send. Google emails the invitation; nothing in the Service OS can send it.',
    },
    {
      key: 'ads-invite',
      title: 'Google Ads — send the invite',
      detail: 'In Google Ads (ads.google.com, account 648-991-4065) → Tools → Access and security → + → enter the Gmail address → Admin → Send invitation. The manager account 263-240-5117 can carry the same address once the advertiser-level invite is accepted.',
    },
    {
      key: 'lsa-access',
      title: 'Local Services Ads — follows the Business Profile',
      detail: 'LSA (473-487-5749) reads from the Business Profile, so there is no separate LSA invite: once the Gmail accepts the Business Profile invite at owner level it can reach the LSA dashboard with the same sign-in.',
    },
    {
      key: 'acceptance',
      title: 'Acceptance — in the invited Gmail’s inbox',
      detail: 'The invited person opens Google’s invitation emails and accepts each one. Until they do, the account stays INVITED here — that is the truthful state, not a pending sync.',
    },
    {
      key: 'mark-active',
      title: 'Mark ACTIVE in this registry',
      detail: 'After the invites are accepted, update the account’s status to ACTIVE on this page. The registry is the record of the structure; Google remains the source of truth for access itself.',
    },
  ];
  const outstanding = (accounts || []).map((account) => {
    const items = [];
    if (account.status === 'INVITED') {
      items.push('Send the Google-side invites (Business Profile + Google Ads) from the primary account.');
      items.push('Wait for the account to accept the invitations in its own Gmail inbox.');
      items.push('Then mark this account ACTIVE here.');
    } else if (account.status === 'ACTIVE') {
      items.push('No outstanding steps — access is recorded as active. Keep the asset list current as profiles or accounts change.');
    } else if (account.status === 'REVOKED') {
      items.push('Access recorded as revoked here. To fully remove it, also remove the user inside Google Business Profile and Google Ads — this registry cannot revoke Google-side access.');
    }
    return { id: account.id, email: account.email, status: account.status, outstanding: items };
  });
  return { steps, accounts: outstanding };
}
