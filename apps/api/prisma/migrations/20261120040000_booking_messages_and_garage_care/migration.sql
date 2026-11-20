-- Customer app depth (2026-11-20, recommendations B2 + B3):
-- (1) BookingMessage — the per-booking "Message the office" thread
--     store shared by the customer app and the staff consoles. No
--     foreign keys (bookings live in ServiceRequest; access is
--     enforced in the route, matching the store's duality).
-- (2) Garage care columns on CustomerAppliance — purchase/warranty
--     dates (owner facts) and the staff-curated recall notice.
--     All nullable, additive only.
CREATE TABLE "BookingMessage" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "bookingId" UUID NOT NULL,
    "senderKind" TEXT NOT NULL,
    "senderUserId" UUID NOT NULL,
    "senderName" TEXT,
    "body" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BookingMessage_bookingId_createdAt_idx" ON "BookingMessage"("bookingId", "createdAt");

CREATE INDEX "BookingMessage_companyId_createdAt_idx" ON "BookingMessage"("companyId", "createdAt");

ALTER TABLE "CustomerAppliance" ADD COLUMN "purchaseDate" TIMESTAMP(3);
ALTER TABLE "CustomerAppliance" ADD COLUMN "warrantyExpiresAt" TIMESTAMP(3);
ALTER TABLE "CustomerAppliance" ADD COLUMN "recallNote" TEXT;
ALTER TABLE "CustomerAppliance" ADD COLUMN "recallUrl" TEXT;
ALTER TABLE "CustomerAppliance" ADD COLUMN "recallNoteAt" TIMESTAMP(3);
