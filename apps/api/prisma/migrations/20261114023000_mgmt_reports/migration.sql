-- Management department reports (2026-11-14): additive only — one new
-- table; no existing table is altered.

-- CreateTable
CREATE TABLE "DepartmentReport" (
    "id" UUID NOT NULL,
    "department" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "source" TEXT,
    "reference" TEXT,
    "eventKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "ackById" UUID,
    "ackAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DepartmentReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DepartmentReport_eventKey_key" ON "DepartmentReport"("eventKey");

-- CreateIndex
CREATE INDEX "DepartmentReport_department_status_idx" ON "DepartmentReport"("department", "status");

-- CreateIndex
CREATE INDEX "DepartmentReport_createdAt_idx" ON "DepartmentReport"("createdAt");
