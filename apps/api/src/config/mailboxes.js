/**
 * Email Manager — the managed mailboxes of Top Speed OS.
 *
 * The Book OS Inbox is the console for every address the platform
 * receives mail on. Two families:
 *
 *   - topspeedserviceos.com — the platform's own domain. The flagship
 *     "super account" is service@topspeedserviceos.com; booking@ is
 *     the second managed address. Mail arrives via the Resend inbound
 *     webhook for this domain, and staff can both reply (from the
 *     address the mail was sent to) and compose new mail from these
 *     addresses.
 *
 *   - updates.topspeedapplianceservice.com — the Resend receiving
 *     domain for the service@topspeedappliance.net forwarding rule:
 *     Gmail forwards a copy of every service@ message to inbox@ here.
 *     Receive-only in the console; replies to that mail go out as
 *     service@topspeedappliance.net (the EMAIL_FROM identity).
 *
 * The receiver is address-agnostic: every inbound message stores its
 * recipient address, and `mailbox` names the managed mailbox it
 * resolved to (null when the recipient is not a managed mailbox —
 * the message still queues, addressed exactly as received).
 */

export const MANAGED_MAILBOXES = [
  {
    address: 'service@topspeedserviceos.com',
    label: 'Service — main inbox',
    domain: 'topspeedserviceos.com',
    kind: 'SUPER',
    canSend: true,
  },
  {
    address: 'booking@topspeedserviceos.com',
    label: 'Bookings',
    domain: 'topspeedserviceos.com',
    kind: 'MANAGED',
    canSend: true,
  },
  {
    address: 'inbox@updates.topspeedapplianceservice.com',
    label: 'Forwarded service@ inbox',
    domain: 'updates.topspeedapplianceservice.com',
    kind: 'FORWARDED',
    forwardsFor: 'service@topspeedappliance.net',
    canSend: false,
  },
];

const BY_ADDRESS = new Map(MANAGED_MAILBOXES.map((m) => [m.address.toLowerCase(), m]));

/** The managed mailbox record for an address, or null. */
export function mailboxForAddress(address) {
  if (!address) return null;
  return BY_ADDRESS.get(String(address).trim().toLowerCase()) || null;
}

/** Addresses staff may compose / send new mail from. */
export function sendableMailboxes() {
  return MANAGED_MAILBOXES.filter((m) => m.canSend);
}

export function isSendableAddress(address) {
  const mailbox = mailboxForAddress(address);
  return Boolean(mailbox?.canSend);
}

/** "Name <a@b>" display identity for a managed sending address. */
export function identityForAddress(address) {
  return `Top Speed Appliance <${String(address).trim().toLowerCase()}>`;
}
