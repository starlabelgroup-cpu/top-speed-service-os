import { createHash, randomBytes } from 'node:crypto';
import { appendEvent, createId, store } from '../data/store.js';
import { DATABASE_ENABLED, db } from '../db/client.js';
import {
  notifyEmailChangeComplete,
  notifyEmailChangeConfirm,
  notifyEmailChangeRequested,
} from './notifications.js';
import { drainEntries } from './senders.js';

/**
 * Username (email) change (2026-11-20, Ramone's approval) — the
 * self-serve flow that was missing platform-wide: until now a
 * username change was office-assisted only, because the email IS
 * the sign-in name and nothing let a holder move it safely.
 *
 * The token discipline mirrors services/passwordReset.js exactly: a
 * random 32-byte token whose SHA-256 hash is all that is stored; the
 * raw token travels only inside the confirmation link emailed to the
 * NEW address (tapping it proves the holder controls that inbox —
 * the same proof POST /auth/verify-email accepts, so a completed
 * change also marks the new address verified). Tokens live 30
 * minutes, are single-use (atomic claim in database mode), and
 * issuing a new one supersedes every still-unused token for the
 * account.
 *
 * The route (routes/emailChange.js) owns the guards that run BEFORE
 * this service is called: current-password verification (the
 * change-password posture), same-email and taken-email checks, the
 * Layer 2 step-up when the account's flag applies, and the intake
 * shield's emailChange rate family. This service owns the token,
 * the swap, and the emails:
 *
 *   request → confirmation link to the NEW address + a security
 *             notice to the OLD address (no token in the notice).
 *   confirm → the target email is re-checked (an address that was
 *             free at request time can be taken meanwhile — that
 *             answers an honest 409 and consumes NOTHING, so the
 *             link stays live if the conflict clears), then the
 *             swap lands, EMAIL_CHANGED is appended to the platform
 *             event feed, and completion notices go to BOTH
 *             addresses.
 *
 * Sessions: access tokens are stateless and /auth/me resolves the
 * account from the database by id, so a session issued before the
 * change keeps working and simply starts reporting the new email —
 * there is no server-side session store to revoke, and none is
 * invented here. Sign-in resolves by email, so after the swap the
 * OLD address no longer signs in and the NEW one does.
 */
export const EMAIL_CHANGE_TTL_MS = 30 * 60 * 1000;
export const EMAIL_CHANGE_INVALID_MESSAGE = 'This confirmation link is invalid or has expired';
export const EMAIL_CHANGE_TAKEN_MESSAGE = 'That email now belongs to another account, so the change could not be completed. The confirmation link was not used up — if the address frees up you can tap it again, or request a change to a different email from your account.';

const CONFIRM_ORIGIN = 'https://pepperlists.com';

function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

function confirmUrl(token) {
  return `${CONFIRM_ORIGIN}/?mode=email-change&token=${encodeURIComponent(token)}`;
}

function fail(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  throw error;
}

// ---------------------------------------------------------------------------
// Repositories: Prisma (database) or the in-memory skeleton — same
// shape as the repos in services/passwordReset.js / emailVerification.js.
// ---------------------------------------------------------------------------
const usersRepo = DATABASE_ENABLED
  ? {
      async findById(id) { return db().user.findUnique({ where: { id } }); },
      async findAllByEmail(email) { return db().user.findMany({ where: { email } }); },
      async applyEmailChange(id, newEmail) {
        return db().user.update({
          where: { id },
          data: { email: newEmail, emailVerifiedAt: new Date() },
        });
      },
    }
  : {
      async findById(id) { return store.users.get(id) ?? null; },
      async findAllByEmail(email) {
        return [...store.users.values()].filter((user) => user.email === email);
      },
      async applyEmailChange(id, newEmail) {
        const user = store.users.get(id);
        if (!user) return null;
        user.email = newEmail;
        user.emailVerifiedAt = new Date().toISOString();
        user.updatedAt = new Date().toISOString();
        store.users.set(id, user);
        return user;
      },
    };

const tokensRepo = DATABASE_ENABLED
  ? {
      async create(record) {
        return db().emailChangeToken.create({
          data: {
            id: record.id, tokenHash: record.tokenHash, userId: record.userId,
            newEmail: record.newEmail, expiresAt: record.expiresAt,
          },
        });
      },
      async findByHash(tokenHash) {
        return db().emailChangeToken.findUnique({ where: { tokenHash } });
      },
      async supersedeOutstanding(userId) {
        await db().emailChangeToken.updateMany({
          where: { userId, usedAt: null },
          data: { usedAt: new Date() },
        });
      },
      async claim(id) {
        const claimed = await db().emailChangeToken.updateMany({
          where: { id, usedAt: null },
          data: { usedAt: new Date() },
        });
        return claimed.count > 0;
      },
    }
  : {
      async create(record) {
        store.emailChangeTokens.set(record.tokenHash, {
          ...record,
          expiresAt: record.expiresAt.toISOString(),
          createdAt: record.createdAt.toISOString(),
          usedAt: null,
        });
        return record;
      },
      async findByHash(tokenHash) {
        return store.emailChangeTokens.get(tokenHash) ?? null;
      },
      async supersedeOutstanding(userId) {
        for (const [key, record] of store.emailChangeTokens.entries()) {
          if (record.userId === userId && !record.usedAt) {
            record.usedAt = new Date().toISOString();
            store.emailChangeTokens.set(key, record);
          }
        }
      },
      async claim(id) {
        for (const [key, record] of store.emailChangeTokens.entries()) {
          if (record.id === id) {
            if (record.usedAt) return false;
            record.usedAt = new Date().toISOString();
            store.emailChangeTokens.set(key, record);
            return true;
          }
        }
        return false;
      },
    };

export { usersRepo as emailChangeUsersRepo };

/**
 * The taken check, shared by the route (before any code is sent or
 * token created) and by the exchange below (re-checked at confirm
 * time). Sign-in resolves accounts by email across companies
 * (routes/auth.js login reads findAllByEmail), so the check is
 * global: ANY other account holding the address blocks the change.
 */
export async function findEmailConflict(newEmail, userId) {
  const holders = await usersRepo.findAllByEmail(newEmail);
  return holders.find((holder) => holder && holder.id !== userId) ?? null;
}

/**
 * Issue a change token for the account and queue the two request
 * emails — the confirmation link to the NEW address and the security
 * notice to the OLD one — then drain that batch awaited, inside the
 * request lifecycle (the password-reset lesson: an opportunistic
 * drain can die with the response on serverless and strand the
 * link). A drain failure is logged and recorded on the entries; it
 * never fails the request.
 */
export async function requestEmailChange(user, { newEmail, source = null }) {
  const token = randomBytes(32).toString('base64url');
  const record = {
    id: createId(),
    tokenHash: hashToken(token),
    userId: user.id,
    newEmail,
    expiresAt: new Date(Date.now() + EMAIL_CHANGE_TTL_MS),
    usedAt: null,
    createdAt: new Date(),
  };
  // One live token per account: supersede any still-unused ones.
  await tokensRepo.supersedeOutstanding(user.id);
  await tokensRepo.create(record);
  const entries = [
    ...notifyEmailChangeConfirm(
      user,
      { tokenId: record.id, newEmail, confirmUrl: confirmUrl(token), expiresAt: record.expiresAt.toISOString() },
      source,
    ),
    ...notifyEmailChangeRequested(user, { tokenId: record.id, newEmail }, source),
  ];
  if (entries.length) {
    await drainEntries(entries).catch((error) => {
      console.error(JSON.stringify({ level: 'error', message: 'email change drain failed', error: String(error?.message || error) }));
    });
  }
  return { expiresAt: record.expiresAt.toISOString(), entries };
}

/**
 * Exchange a raw confirmation token for the completed change. Every
 * token failure — unknown, already used, expired — throws the SAME
 * generic 400 so the endpoint never confirms which case it was. A
 * target address taken since the request throws an honest 409 and
 * consumes nothing. On success: the token is claimed atomically,
 * the email is swapped and marked verified (the tapped link is the
 * ownership proof), other outstanding tokens for the account die,
 * EMAIL_CHANGED lands on the platform event feed, and completion
 * notices are queued to both addresses. Returns the updated user
 * plus both addresses.
 */
export async function consumeEmailChange(rawToken) {
  const tokenHash = hashToken(rawToken || '');
  const record = await tokensRepo.findByHash(tokenHash);
  if (!record) fail(400, 'EMAIL_CHANGE_INVALID', EMAIL_CHANGE_INVALID_MESSAGE);
  if (record.usedAt) fail(400, 'EMAIL_CHANGE_INVALID', EMAIL_CHANGE_INVALID_MESSAGE);
  if (new Date(record.expiresAt).getTime() <= Date.now()) fail(400, 'EMAIL_CHANGE_INVALID', EMAIL_CHANGE_INVALID_MESSAGE);

  const user = await usersRepo.findById(record.userId);
  if (!user) fail(400, 'EMAIL_CHANGE_INVALID', EMAIL_CHANGE_INVALID_MESSAGE);
  const oldEmail = user.email;
  const newEmail = record.newEmail;

  if (oldEmail !== newEmail) {
    const conflict = await findEmailConflict(newEmail, user.id);
    if (conflict) fail(409, 'EMAIL_TAKEN', EMAIL_CHANGE_TAKEN_MESSAGE);
  }

  // Atomic claim: exactly one concurrent exchange can win.
  const claimed = await tokensRepo.claim(record.id);
  if (!claimed) fail(400, 'EMAIL_CHANGE_INVALID', EMAIL_CHANGE_INVALID_MESSAGE);

  const updated = await usersRepo.applyEmailChange(user.id, newEmail);
  // Any other outstanding change links for this account die too.
  await tokensRepo.supersedeOutstanding(user.id);

  await appendEvent('EMAIL_CHANGED', {
    source: 'EMAIL_CHANGE',
    actor: user.id,
    entityType: 'USER',
    entityId: user.id,
    details: { oldEmail, newEmail },
  });

  const entries = notifyEmailChangeComplete(updated, { tokenId: record.id, oldEmail, newEmail }, 'EMAIL_CHANGE');
  if (entries.length) {
    await drainEntries(entries).catch((error) => {
      console.error(JSON.stringify({ level: 'error', message: 'email change completion drain failed', error: String(error?.message || error) }));
    });
  }
  return { user: updated, oldEmail, newEmail };
}
