-- Intake shield (2026-11-19): durable per-IP rate-limit windows for
-- the public intake endpoints (see the IntakeRateWindow model and
-- services/intakeShield.js). Additive only — one brand-new table;
-- no existing table, column, or index changes meaning.
-- (Generated with prisma migrate diff; an unrelated pre-existing
-- schema/migration drift item the diff proposed — dropping the
-- CustomerAppliance_userId_idx index — was deliberately excluded:
-- it is not part of this change.)

-- CreateTable
CREATE TABLE "IntakeRateWindow" (
    "id" UUID NOT NULL,
    "family" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntakeRateWindow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IntakeRateWindow_windowStart_idx" ON "IntakeRateWindow"("windowStart");

-- CreateIndex
CREATE UNIQUE INDEX "IntakeRateWindow_family_ip_windowStart_key" ON "IntakeRateWindow"("family", "ip", "windowStart");
