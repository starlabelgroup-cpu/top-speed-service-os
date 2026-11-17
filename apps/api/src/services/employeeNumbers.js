import { store } from '../data/store.js';
import { DATABASE_ENABLED, db } from '../db/client.js';
import { ROLES, STAFF_ROLES } from '../config/security.js';
import { isMasterAccount, PROVIDER_ACCOUNT_ROLES } from './speedyVerify.js';

/**
 * Employee numbers (Work Time Account Access, 2026-11-17).
 *
 * Every EMPLOYEE account — Service Setters, Managers, Providers/Techs
 * and other staff — gets a permanent employee number at issuance:
 * 'TS-' + a sequential number starting at TS-1001. Unique, never
 * reused (numbers are only ever minted, never freed: deactivated
 * accounts keep theirs). Customer / business / PM / advertiser
 * accounts never get one, and neither does the Master — COMPANY_OWNER
 * displays "MASTER" instead (Rule Zero: the Master is not an employee
 * in his own numbering system).
 *
 * Assignment is server-side only. The next number is max(existing)+1,
 * written under the column's UNIQUE constraint; a lost race surfaces
 * as a Prisma P2002 and is retried — more than enough for a
 * single-admin console.
 */
export const EMPLOYEE_NUMBER_FIRST = 1001;

export const EMPLOYEE_ROLES = [
  ...STAFF_ROLES.filter((role) => role !== ROLES.COMPANY_OWNER),
  ...PROVIDER_ACCOUNT_ROLES,
];

export function isEmployeeAccount(user) {
  if (!user || isMasterAccount(user)) return false;
  const roles = Array.isArray(user.roles) ? user.roles : [];
  return roles.some((role) => EMPLOYEE_ROLES.includes(role));
}

export function formatEmployeeNumber(sequence) {
  return `TS-${String(sequence).padStart(4, '0')}`;
}

export function parseEmployeeNumber(value) {
  const match = /^TS-(\d+)$/.exec(String(value || '').trim());
  return match ? Number(match[1]) : null;
}

const repo = DATABASE_ENABLED
  ? {
      async allNumbers() {
        const rows = await db().user.findMany({
          where: { employeeNumber: { not: null } },
          select: { employeeNumber: true },
        });
        return rows.map((row) => row.employeeNumber);
      },
      async setNumber(id, employeeNumber) {
        return db().user.update({ where: { id }, data: { employeeNumber } });
      },
    }
  : {
      async allNumbers() {
        return [...store.users.values()].map((user) => user.employeeNumber).filter(Boolean);
      },
      async setNumber(id, employeeNumber) {
        const user = store.users.get(id);
        if (user) {
          user.employeeNumber = employeeNumber;
          user.updatedAt = new Date().toISOString();
          store.users.set(id, user);
        }
        return user;
      },
    };

export async function nextEmployeeNumber() {
  const numbers = await repo.allNumbers();
  let max = EMPLOYEE_NUMBER_FIRST - 1;
  for (const value of numbers) {
    const parsed = parseEmployeeNumber(value);
    if (parsed !== null && parsed > max) max = parsed;
  }
  return formatEmployeeNumber(max + 1);
}

/**
 * Assign the next employee number to an account that should have one.
 * Returns the (possibly updated) user object. Non-employee accounts
 * and accounts that already carry a number are returned untouched.
 */
export async function assignEmployeeNumber(user) {
  if (!user || user.employeeNumber || !isEmployeeAccount(user)) return user;
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = await nextEmployeeNumber();
    try {
      const updated = await repo.setNumber(user.id, candidate);
      return updated || { ...user, employeeNumber: candidate };
    } catch (error) {
      // Unique-constraint race on the number — recompute and retry.
      if (error?.code !== 'P2002') throw error;
      lastError = error;
    }
  }
  throw lastError || new Error('Could not assign an employee number');
}
