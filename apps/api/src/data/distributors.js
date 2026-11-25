/**
 * Parts distributor connections — Marcone Supply, Encompass Supply
 * Chain, Parts Town (2026-11-25).
 *
 * Single fact source for the national distributors the owner connects
 * to Appliance Plus Parts Supply / Parts Supply OS and to Appliance
 * Plug parts ordering in Field Pro. Facts here are owner-supplied or
 * verified from the distributor's own public materials on 2026-11-25;
 * nothing is invented:
 *
 * - Marcone Supply: the owner confirmed 2026-11-25 that he holds a
 *   Marcone account. Marcone publishes no self-serve API — dealer
 *   integrations (portal ordering, EDI, software integrations) are
 *   arranged on the account. Until Marcone grants an electronic
 *   integration, orders route through Service OS Parts Orders and are
 *   placed on the account by Parts Supply staff.
 * - Encompass Supply Chain: wholesale accounts open by business
 *   application (terms or credit-card), with the account holder's
 *   Florida sales tax certificate emailed to salestax@encompass.com.
 *   Custom integration is arranged through the account manager once
 *   the account exists. No account yet (2026-11-25).
 * - Parts Town: a real API exists, but API keys are issued by Parts
 *   Town only to approved integration partners, and its catalog is
 *   primarily commercial foodservice. Account created by the owner
 *   on 2026-11-25; its number has not been supplied yet.
 *
 * Appliance Parts Depot: added 2026-11-25 as a Parts Supply OS
 * supplier at the owner's direction (he confirmed it is a supplier
 * to set up, alongside the three national distributors). Name-only
 * record — no contact details supplied yet, so they stay null.
 *
 * Account numbers are NEVER stored in code. They reach the API only
 * through environment variables (MARCONE_ACCOUNT_NUMBER,
 * ENCOMPASS_ACCOUNT_NUMBER, PARTSTOWN_ACCOUNT_NUMBER); this module
 * reports only whether one is on file, never its value.
 *
 * integrationState stays NOT_CONNECTED until a distributor's own
 * system answers a live lookup/order call from this backend — an
 * account on file is not a connection, and no price or stock figure
 * is ever shown from anywhere but a live distributor response.
 */

export const MARCONE_SUPPLIER_ID = '40000000-0000-4000-8000-000000000002';
export const ENCOMPASS_SUPPLIER_ID = '40000000-0000-4000-8000-000000000003';
export const PARTS_TOWN_SUPPLIER_ID = '40000000-0000-4000-8000-000000000004';
export const APPLIANCE_PARTS_DEPOT_ID = '40000000-0000-4000-8000-000000000005';

/**
 * Supplier directory rows for the three distributors, ensured at boot
 * create-only by id alongside the partner vendors (db/partsRepo).
 * Contact details stay null until the owner supplies them.
 */
export const DISTRIBUTOR_SUPPLIERS = [
  {
    id: MARCONE_SUPPLIER_ID,
    name: 'Marcone Supply',
    contact: null,
    phone: null,
    email: null,
    terms: null,
    vendorType: 'STANDARD',
    active: true,
  },
  {
    id: ENCOMPASS_SUPPLIER_ID,
    name: 'Encompass Supply Chain',
    contact: null,
    phone: null,
    email: null,
    terms: null,
    vendorType: 'STANDARD',
    active: true,
  },
  {
    id: PARTS_TOWN_SUPPLIER_ID,
    name: 'Parts Town',
    contact: null,
    phone: null,
    email: null,
    terms: null,
    vendorType: 'STANDARD',
    active: true,
  },
  {
    id: APPLIANCE_PARTS_DEPOT_ID,
    name: 'Appliance Parts Depot',
    contact: null,
    phone: null,
    email: null,
    terms: null,
    vendorType: 'STANDARD',
    active: true,
  },
];

const DISTRIBUTORS = [
  {
    key: 'marcone',
    supplierId: MARCONE_SUPPLIER_ID,
    name: 'Marcone Supply',
    accountEnv: 'MARCONE_ACCOUNT_NUMBER',
    // Owner confirmed 2026-11-25 that the account exists; its number
    // has not been supplied yet.
    accountState: 'OWNER_CONFIRMED',
    accountLabel: 'Account on file with Marcone (owner-confirmed); account number not yet supplied',
    integrationMode: 'ACCOUNT',
    integrationLabel:
      'No public API — portal/EDI/software integration is arranged on the dealer account',
    nextStep: 'Supply the Marcone account number, then request electronic integration on the account',
  },
  {
    key: 'encompass',
    supplierId: ENCOMPASS_SUPPLIER_ID,
    name: 'Encompass Supply Chain',
    accountEnv: 'ENCOMPASS_ACCOUNT_NUMBER',
    accountState: 'APPLICATION_NEEDED',
    accountLabel: 'No account yet — wholesale account opens by business application',
    integrationMode: 'ACCOUNT',
    integrationLabel: 'Custom integration is arranged through the Encompass account manager',
    nextStep:
      'Submit the Encompass business application and email the Florida sales tax certificate to salestax@encompass.com',
  },
  {
    key: 'parts_town',
    supplierId: PARTS_TOWN_SUPPLIER_ID,
    name: 'Parts Town',
    accountEnv: 'PARTSTOWN_ACCOUNT_NUMBER',
    accountState: 'OWNER_CONFIRMED',
    accountLabel: 'Account created (owner-confirmed 2026-11-25); account number not yet supplied',
    integrationMode: 'API',
    integrationLabel: 'API keys are issued by Parts Town only to approved integration partners',
    nextStep: 'Supply the Parts Town account number, then apply for partner API access (keys are issued to approved partners)',
  },
];

/**
 * Honest per-distributor connection state for the Parts Supply console
 * (staff) and the Field Pro distributor card (provider). Values only —
 * never account numbers, never prices, never stock.
 */
export function distributorStatus() {
  return DISTRIBUTORS.map((d) => ({
    key: d.key,
    supplierId: d.supplierId,
    name: d.name,
    accountState: d.accountState,
    accountLabel: d.accountLabel,
    accountNumberOnFile: Boolean(process.env[d.accountEnv]),
    integrationState: 'NOT_CONNECTED',
    integrationMode: d.integrationMode,
    integrationLabel: d.integrationLabel,
    orderingRoute: 'Service OS Parts Orders',
    nextStep: d.nextStep,
  }));
}
