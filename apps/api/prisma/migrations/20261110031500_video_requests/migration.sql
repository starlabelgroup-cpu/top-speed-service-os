-- Speedy Live Video consultation requests (2026-11-09).

-- CreateTable
CREATE TABLE "VideoConsultRequest" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "customerName" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "appliance" TEXT NOT NULL,
    "note" TEXT,
    "bookingReference" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'UNDECIDED',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "roomName" TEXT,
    "arrangedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VideoConsultRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VideoConsultRequest_companyId_status_idx" ON "VideoConsultRequest"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "VideoConsultRequest_roomName_key" ON "VideoConsultRequest"("roomName");

-- AddForeignKey
ALTER TABLE "VideoConsultRequest" ADD CONSTRAINT "VideoConsultRequest_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
