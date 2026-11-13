import { addBookingEvent, createId, store } from '../data/store.js';

function scoreProvider(provider, booking) {
  let score = 0;
  if (provider.specialties.includes(booking.appliance)) score += 60;
  if (provider.serviceCities.includes(booking.city)) score += 30;
  score += Math.round((provider.rating || 0) * 2);
  return score;
}

/**
 * Read-only provider suggestions — the same scoring the hybrid matcher
 * uses, with NO side effects: no assignments are created and the
 * booking is not touched. This is what Speedy's CRM assist shows a
 * Service Setter; turning a suggestion into a dispatch still goes
 * through matchProviders() + a human approval, exactly as before.
 * The area a provider is scored against is the booking's resolved
 * Service Book area (falling back to its city for older records).
 */
export function suggestProviders(booking, { limit = 5 } = {}) {
  const area = booking.area || booking.city;
  return store.providers
    .filter((provider) => provider.active)
    .map((provider) => ({
      providerId: provider.id,
      providerCompanyId: provider.companyId,
      businessName: provider.businessName,
      type: provider.type,
      rating: provider.rating,
      specialties: provider.specialties,
      serviceCities: provider.serviceCities,
      matchScore: scoreProvider(provider, { ...booking, city: area }),
      reasons: [
        provider.specialties.includes(booking.appliance) ? 'Appliance specialty match' : 'General appliance coverage',
        provider.serviceCities.includes(area) ? `Serves the ${area} area` : 'Service-area review required',
      ],
    }))
    .filter((candidate) => candidate.matchScore >= 65)
    .sort((a, b) => b.matchScore - a.matchScore)
    .slice(0, limit);
}

export function matchProviders(booking) {
  const candidates = suggestProviders(booking, { limit: Number.POSITIVE_INFINITY });

  const assignments = candidates.map((candidate) => {
    const assignment = {
      id: createId(),
      companyId: booking.companyId,
      bookingId: booking.id,
      providerId: candidate.providerId,
      providerCompanyId: candidate.providerCompanyId,
      status: 'PROPOSED',
      dispatchMode: 'HYBRID',
      approvalRequired: true,
      matchScore: candidate.matchScore,
      createdAt: new Date().toISOString(),
      approvedBy: null,
      approvedAt: null,
    };
    store.dispatchAssignments.set(assignment.id, assignment);
    return assignment;
  });

  booking.status = 'MATCH_PENDING_APPROVAL';
  booking.dispatch = {
    mode: 'HYBRID',
    stage: 'SERVICE_SETTERS_APPROVAL_REQUIRED',
    candidateProviderIds: candidates.map(({ providerId }) => providerId),
    assignmentIds: assignments.map(({ id }) => id),
  };
  addBookingEvent(booking, 'DISPATCH_MATCHED', 'system:auto-match', {
    candidateCount: candidates.length,
  });

  return { candidates, assignments };
}

export function approveDispatch(booking, providerId, approvedBy) {
  const assignment = [...store.dispatchAssignments.values()].find(
    (item) => item.bookingId === booking.id && item.providerId === providerId && item.status === 'PROPOSED',
  );

  if (!assignment) return null;

  assignment.status = 'APPROVED';
  assignment.approvedBy = approvedBy;
  assignment.approvedAt = new Date().toISOString();

  for (const other of store.dispatchAssignments.values()) {
    if (other.bookingId === booking.id && other.id !== assignment.id && other.status === 'PROPOSED') {
      other.status = 'NOT_SELECTED';
    }
  }

  booking.status = 'CONFIRMED';
  booking.dispatch = {
    ...booking.dispatch,
    stage: 'APPROVED_BY_SERVICE_SETTERS',
    assignmentId: assignment.id,
    providerId,
    approvedBy,
    approvedAt: assignment.approvedAt,
  };
  addBookingEvent(booking, 'DISPATCH_APPROVED', approvedBy, {
    assignmentId: assignment.id,
    providerId,
  });

  return assignment;
}
