import { createId, store } from '../data/store.js';
import { DATABASE_ENABLED, db } from '../db/client.js';

/**
 * Legal terms acceptance — the sign-before-access gate.
 *
 * Two current documents must both be accepted, by typed full name, before
 * a public account is created and before an existing account may enter
 * an app. Acceptance rows are versioned: when a document's version is
 * bumped, every account must accept the new version again (the status
 * helpers below report the old rows as not satisfying the current
 * version, so the app gates reappear on their own).
 */
export const LEGAL_DOCUMENTS = [
  {
    document: 'SERVICE_OS',
    key: 'service-os-terms',
    title: 'Top Speed Service OS — Terms & Conditions',
    version: '1.0',
    effectiveDate: '2026-11-12',
    url: '/legal#service-os-terms',
  },
  {
    document: 'APPLIANCE_CONNECT',
    key: 'appliance-connect-terms',
    title: 'Appliance Connect Software — Terms of Use',
    version: '1.0',
    effectiveDate: '2026-11-12',
    url: '/legal#appliance-connect-terms',
  },
];

export const LEGAL_DOCUMENT_KEYS = LEGAL_DOCUMENTS.map((doc) => doc.document);

function iso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

export function currentLegalDocument(document) {
  return LEGAL_DOCUMENTS.find((doc) => doc.document === document) || null;
}

/**
 * Validate a client-supplied acceptance payload. Returns either
 * { ok: true, signatureName, documents: [{document, version}] } with the
 * documents normalized to the current versions, or { ok: false, error }
 * with a plain-language reason the signup forms can show verbatim.
 */
export function validateTermsAcceptance(input) {
  if (!input || typeof input !== 'object') {
    return { ok: false, error: 'Please review and sign the legal documents before creating your account.' };
  }
  const signatureName = String(input.signatureName || '').trim();
  if (signatureName.length < 2 || signatureName.length > 120) {
    return { ok: false, error: 'Type your full name as your signature to accept the legal documents.' };
  }
  const supplied = Array.isArray(input.documents) ? input.documents : [];
  const documents = [];
  for (const doc of LEGAL_DOCUMENTS) {
    const match = supplied.find((entry) => entry && entry.document === doc.document);
    if (!match || match.agreed !== true) {
      return { ok: false, error: `Please check the agreement box for the ${doc.title}.` };
    }
    if (String(match.version || '') !== doc.version) {
      return { ok: false, error: `The ${doc.title} has been updated — please review version ${doc.version} and sign again.` };
    }
    documents.push({ document: doc.document, version: doc.version });
  }
  return { ok: true, signatureName, documents };
}

export async function listTermsAcceptances(userId) {
  if (DATABASE_ENABLED) {
    return db().termsAcceptance.findMany({ where: { userId }, orderBy: { acceptedAt: 'asc' } });
  }
  return (store.termsAcceptances || []).filter((row) => row.userId === userId);
}

/** Terms status for one account: complete only when BOTH current versions are on file. */
export async function termsStatusForUser(userId) {
  const rows = userId ? await listTermsAcceptances(userId) : [];
  const documents = LEGAL_DOCUMENTS.map((doc) => {
    const row = rows.find((entry) => entry.document === doc.document && entry.version === doc.version) || null;
    return {
      document: doc.document,
      key: doc.key,
      title: doc.title,
      version: doc.version,
      effectiveDate: doc.effectiveDate,
      url: doc.url,
      accepted: Boolean(row),
      acceptedAt: row ? iso(row.acceptedAt) : null,
      signatureName: row ? row.signatureName : null,
    };
  });
  return {
    required: true,
    complete: documents.every((doc) => doc.accepted),
    documents,
    missing: documents.filter((doc) => !doc.accepted).map((doc) => doc.document),
  };
}

function acceptanceRows(userId, validated, acceptedAt = new Date()) {
  return validated.documents.map((doc) => ({
    id: createId(),
    userId,
    document: doc.document,
    version: doc.version,
    signatureName: validated.signatureName,
    acceptedAt,
  }));
}

/**
 * Record acceptance for an EXISTING account (POST /auth/accept-terms and
 * the Google-callback follow-up path). Idempotent per current version:
 * documents already on file at the current version are left untouched.
 */
export async function recordTermsAcceptance(userId, validated) {
  const existing = await listTermsAcceptances(userId);
  const missing = validated.documents.filter(
    (doc) => !existing.some((row) => row.document === doc.document && row.version === doc.version),
  );
  if (!missing.length) return termsStatusForUser(userId);
  const rows = acceptanceRows(userId, { ...validated, documents: missing });
  if (DATABASE_ENABLED) {
    await db().termsAcceptance.createMany({
      data: rows.map((row) => ({
        id: row.id, userId: row.userId, document: row.document,
        version: row.version, signatureName: row.signatureName, acceptedAt: row.acceptedAt,
      })),
      skipDuplicates: true,
    });
  } else {
    store.termsAcceptances.push(...rows.map((row) => ({ ...row, acceptedAt: row.acceptedAt.toISOString(), createdAt: row.acceptedAt.toISOString() })));
  }
  return termsStatusForUser(userId);
}

/**
 * Create a user AND their acceptance rows atomically (public signup).
 * In database mode both writes share one transaction, so an account can
 * never exist without its signed acceptance — and a failed acceptance
 * write rolls the account back.
 */
export async function createUserWithTerms(draft, validated) {
  const rows = acceptanceRows(draft.id, validated, new Date(draft.createdAt));
  if (DATABASE_ENABLED) {
    return db().$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          id: draft.id, companyId: draft.companyId, email: draft.email,
          passwordHash: draft.passwordHash, firstName: draft.firstName,
          lastName: draft.lastName, phone: draft.phone, roles: draft.roles,
          active: draft.active,
        },
      });
      await tx.termsAcceptance.createMany({
        data: rows.map((row) => ({
          id: row.id, userId: row.userId, document: row.document,
          version: row.version, signatureName: row.signatureName, acceptedAt: row.acceptedAt,
        })),
      });
      return user;
    });
  }
  store.users.set(draft.id, draft);
  store.termsAcceptances.push(...rows.map((row) => ({ ...row, acceptedAt: row.acceptedAt.toISOString(), createdAt: row.acceptedAt.toISOString() })));
  return draft;
}
