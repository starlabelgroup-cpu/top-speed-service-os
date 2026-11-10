-- Public web intake records (forms + Speedy-assisted flows).
CREATE TABLE "Connection" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "type" TEXT NOT NULL,
    "source" TEXT,
    "message" TEXT,
    "reference" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Connection_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Connection_reference_key" ON "Connection"("reference");
