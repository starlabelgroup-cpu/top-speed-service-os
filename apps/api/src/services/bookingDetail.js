/**
 * Booking detail serialization for workstation "More info" views
 * (2026-11-23): the full booking record plus its tracking sources —
 * where the booking came from, exactly as recorded. HONESTY RULE:
 * every field is read from the booking record itself; a field the
 * record does not carry serializes as null and the consoles render it
 * as "Not recorded". Nothing is inferred, defaulted, or invented here.
 *
 * Used by GET /management/reports/:id/detail (report → its booking) and
 * GET /tracking/console/:reference/detail (dispatch card → its job).
 */
export function bookingDetailOf(booking) {
  if (!booking) return null;
  const c = booking.customer || {};
  const orNull = (v) => (v === undefined || v === '' ? null : v);
  return {
    id: booking.id,
    referenceCode: orNull(booking.referenceCode),
    status: orNull(booking.status),
    source: orNull(booking.source),
    createdAt: orNull(booking.createdAt),
    updatedAt: orNull(booking.updatedAt),
    completedAt: orNull(booking.completedAt),
    completedBy: orNull(booking.completedBy),
    customer: {
      name: orNull(c.name),
      phone: orNull(c.phone || booking.phone),
      email: orNull(c.email || booking.email),
      address: orNull(c.address),
    },
    appliance: orNull(booking.appliance),
    issue: orNull(booking.issue),
    city: orNull(booking.city),
    zip: orNull(booking.zip),
    area: orNull(booking.area),
    areaStatus: orNull(booking.areaStatus),
    serviceAddress: orNull(booking.serviceAddress),
    preferredWindow: orNull(booking.preferredWindow),
    preferredDate: orNull(booking.preferredDate),
    priorityTier: orNull(booking.priorityTier),
    diagnosticFee: booking.diagnosticFee ?? null,
    feeStatus: orNull(booking.feeStatus),
    dispatch: booking.dispatch || null,
    appointment: booking.appointment || null,
    // Tracking sources: the attribution the booking record carries —
    // landing page, Speedy tag, UTM set, ad click ids, referral link.
    tracking: {
      source: orNull(booking.source),
      sourcePage: orNull(booking.sourcePage),
      viaTag: orNull(booking.viaTag),
      utmSource: orNull(booking.utmSource),
      utmMedium: orNull(booking.utmMedium),
      utmCampaign: orNull(booking.utmCampaign),
      utmTerm: orNull(booking.utmTerm),
      utmContent: orNull(booking.utmContent),
      gclid: orNull(booking.gclid),
      fbclid: orNull(booking.fbclid),
      msclkid: orNull(booking.msclkid),
      referralCode: orNull(booking.referralCode),
      referredByCustomerId: orNull(booking.referredByCustomerId),
    },
    history: Array.isArray(booking.history) ? booking.history : [],
  };
}

/** Resolve the booking a management report refers to, when it carries one. */
export function bookingForReport(store, report) {
  if (!report) return null;
  const detail = report.detail || {};
  if (detail.bookingId && store.bookings.has(detail.bookingId)) return store.bookings.get(detail.bookingId);
  const reference = detail.referenceCode || report.reference || detail.reference || null;
  if (reference) {
    for (const booking of store.bookings.values()) {
      if (booking.referenceCode === reference) return booking;
    }
  }
  return null;
}
