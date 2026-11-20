import { PLATFORM_COMPANY_ID, store } from '../data/store.js';
import { ACADEMY_TRACKS, CERT_DISPATCH_POLICY, moduleNumberOf, trackOfModule } from '../data/academyTracks.js';
import { completionsForProvider, completionsForUser } from '../db/academyRepo.js';
import { ROLES } from '../config/security.js';

/**
 * Academy certifications — derivation (2026-11-20, recommendations
 * D12).
 *
 * A certification is DERIVED, never stored and never granted by a
 * person or an AI: a trainee is certified in a track when their
 * recorded completions cover every module of that track that exists
 * in the LIVE curriculum (store.mediaContent, training-academy tag).
 * If the curriculum loses a module, the track's requirement shrinks
 * with it; if it gains one, nobody is certified until they complete
 * it. The records are the Academy's own (POST /academy/completions
 * validates the module against the live curriculum before writing),
 * so a certification can never be typed into existence from a
 * profile form.
 *
 * Where certifications surface:
 *  - the trainee's own Academy progress + provider profile
 *    (certificationsForUser / progressForUser);
 *  - the provider TEAM's profile in dispatch (certificationsFor-
 *    ProviderRecord): completions carry the provider record the
 *    trainee worked under, resolved at record time;
 *  - the assignment-suggestion ranking (certificationFactor): one
 *    factor among the existing ones, per CERT_DISPATCH_POLICY.
 */

const PROVIDER_ROLES = [ROLES.PROVIDER_OWNER, ROLES.PROVIDER_TECH, ROLES.TECHNICIAN];

/** Live curriculum modules grouped by track name. */
export function curriculumByTrack() {
  const byTrack = new Map(ACADEMY_TRACKS.map((track) => [track.name, []]));
  for (const record of store.mediaContent || []) {
    if (!Array.isArray(record.tags) || !record.tags.includes('training-academy')) continue;
    const n = moduleNumberOf(record);
    if (!n) continue;
    const track = trackOfModule(n);
    if (!track) continue;
    byTrack.get(track.name).push({ slug: record.slug, moduleNumber: n, title: record.title });
  }
  for (const modules of byTrack.values()) modules.sort((a, b) => a.moduleNumber - b.moduleNumber);
  return byTrack;
}

/**
 * Derive one person's track standing from their completion rows.
 * Returns a per-track row for EVERY track (so profiles can show
 * progress honestly, including zero) plus the earned certifications.
 */
export function deriveCertifications(completions, byTrack = curriculumByTrack()) {
  const doneByTrack = new Map();
  for (const row of completions || []) {
    if (!doneByTrack.has(row.trackName)) doneByTrack.set(row.trackName, new Map());
    doneByTrack.get(row.trackName).set(row.moduleSlug, row);
  }
  const tracks = ACADEMY_TRACKS.map((track) => {
    const modules = byTrack.get(track.name) || [];
    const done = doneByTrack.get(track.name) || new Map();
    const completedModules = modules.filter((m) => done.has(m.slug)).length;
    const certified = modules.length > 0 && completedModules === modules.length;
    let certifiedAt = null;
    if (certified) {
      for (const m of modules) {
        const at = done.get(m.slug)?.completedAt || null;
        if (at && (!certifiedAt || at > certifiedAt)) certifiedAt = at;
      }
    }
    return {
      track: track.name,
      sub: track.sub,
      totalModules: modules.length,
      completedModules,
      certified,
      certifiedAt,
    };
  });
  return {
    tracks,
    certifications: tracks
      .filter((t) => t.certified)
      .map((t) => ({ track: t.track, certifiedAt: t.certifiedAt })),
  };
}

/** The signed-in trainee's own certifications + full track progress. */
export function progressForUser(userId) {
  const completions = completionsForUser(userId);
  const derived = deriveCertifications(completions);
  return {
    completedCount: completions.length,
    ...derived,
    completions: completions.map((row) => ({
      moduleSlug: row.moduleSlug,
      moduleNumber: row.moduleNumber,
      trackName: row.trackName,
      completedAt: row.completedAt,
    })),
  };
}

export function certificationsForUser(userId) {
  return deriveCertifications(completionsForUser(userId)).certifications;
}

/**
 * The provider record a trainee works under — the Tech App's own
 * linkage (routes/provider.js myProvider), mirrored so a completion
 * is stamped with it at record time: the provider whose companyId
 * is the account's company; for platform-company tech accounts, the
 * company-crew record. Oversight/staff accounts resolve to null.
 */
export function providerRecordForTrainee(user) {
  if (!user) return null;
  const own = (store.providers || []).find((p) => p.companyId === user.companyId) || null;
  if (own) return own;
  const roles = user.roles || [];
  if (
    user.companyId === PLATFORM_COMPANY_ID &&
    roles.some((role) => PROVIDER_ROLES.includes(role)) &&
    !roles.some((role) => [ROLES.COMPANY_OWNER, ROLES.COMPANY_ADMIN, ROLES.PLATFORM_ADMIN].includes(role))
  ) {
    return (store.providers || []).find((p) => p.companyCrew) || null;
  }
  return null;
}

/**
 * A provider TEAM's certifications: distinct trainees under that
 * provider record who hold each certification. This is what the
 * dispatch ranking weighs and what the office sees on a candidate —
 * a business is "Technician Track certified" when at least one of
 * its techs actually is, and the count says how many.
 */
export function certificationsForProviderRecord(provider) {
  if (!provider) return [];
  const rows = completionsForProvider(provider.id);
  const byUser = new Map();
  for (const row of rows) {
    if (!byUser.has(row.userId)) byUser.set(row.userId, []);
    byUser.get(row.userId).push(row);
  }
  const byTrack = curriculumByTrack();
  const aggregate = new Map();
  for (const userRows of byUser.values()) {
    for (const cert of deriveCertifications(userRows, byTrack).certifications) {
      const entry = aggregate.get(cert.track) || { track: cert.track, certifiedTechs: 0 };
      entry.certifiedTechs += 1;
      aggregate.set(cert.track, entry);
    }
  }
  return [...aggregate.values()].map((entry) => ({
    ...entry,
    specialtyAppliance: CERT_DISPATCH_POLICY[entry.track]?.specialtyAppliance || null,
  }));
}

/**
 * The dispatch factor: points + setter-readable reasons for one
 * candidate on one booking, per CERT_DISPATCH_POLICY. Applied ONCE
 * per certification the team holds (the count rides in the label) —
 * certifications rank a candidate higher; they never make an
 * ineligible candidate eligible and never dispatch anyone.
 */
export function certificationFactor(provider, booking) {
  const held = certificationsForProviderRecord(provider);
  const reasons = [];
  let points = 0;
  for (const cert of held) {
    const policy = CERT_DISPATCH_POLICY[cert.track];
    if (!policy) continue;
    points += policy.points;
    reasons.push({
      kind: 'pro',
      label: `Academy certified — ${cert.track} (${cert.certifiedTechs} tech${cert.certifiedTechs === 1 ? '' : 's'})`,
    });
    if (policy.specialtyAppliance && booking?.appliance === policy.specialtyAppliance) {
      points += policy.specialtyPoints;
      reasons.push({
        kind: 'pro',
        label: `${cert.track} certification weighs extra for ${policy.specialtyAppliance} work — the sealed-system end of the trade`,
      });
    }
  }
  return { points, reasons, certifications: held };
}
