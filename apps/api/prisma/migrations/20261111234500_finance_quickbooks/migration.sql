-- QuickBooks finance integration layer (built dark): connection state,
-- synced report snapshots, and the invoice mirror. Populated only by the
-- owner-only POST /finance/sync from Pepper's QuickBooks connector.
CREATE TABLE "FinanceConnection" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'quickbooks',
    "status" TEXT NOT NULL DEFAULT 'not_connected',
    "companyName" TEXT,
    "realmHint" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceConnection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FinanceConnection_provider_key" ON "FinanceConnection"("provider");

CREATE TABLE "FinanceSnapshot" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "periodLabel" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'quickbooks-connector',
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinanceSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FinanceSnapshot_kind_periodLabel_key" ON "FinanceSnapshot"("kind", "periodLabel");
CREATE INDEX "FinanceSnapshot_kind_idx" ON "FinanceSnapshot"("kind");

CREATE TABLE "FinanceInvoiceMirror" (
    "id" UUID NOT NULL,
    "qbId" TEXT NOT NULL,
    "number" TEXT,
    "customerName" TEXT,
    "totalCents" INTEGER NOT NULL DEFAULT 0,
    "balanceCents" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT,
    "dueDate" TIMESTAMP(3),
    "qbUrl" TEXT,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinanceInvoiceMirror_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FinanceInvoiceMirror_qbId_key" ON "FinanceInvoiceMirror"("qbId");
CREATE INDEX "FinanceInvoiceMirror_balanceCents_idx" ON "FinanceInvoiceMirror"("balanceCents");
