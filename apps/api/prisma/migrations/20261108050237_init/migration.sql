-- CreateEnum
CREATE TYPE "Role" AS ENUM ('PLATFORM_ADMIN', 'COMPANY_OWNER', 'COMPANY_ADMIN', 'DISPATCHER', 'CUSTOMER', 'PROVIDER_OWNER', 'PROVIDER_TECH', 'TECHNICIAN');

-- CreateEnum
CREATE TYPE "CompanyType" AS ENUM ('PLATFORM_OWNER', 'NETWORK_BUSINESS', 'INDEPENDENT_PROVIDER', 'CUSTOMER_COMPANY');

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('PENDING_DISPATCH', 'MATCH_PENDING_APPROVAL', 'CONFIRMED', 'EN_ROUTE', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "FeeStatus" AS ENUM ('COLLECTED_AT_BOOKING', 'NOT_COLLECTED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "DispatchMode" AS ENUM ('HYBRID', 'MANUAL', 'AUTOMATIC');

-- CreateEnum
CREATE TYPE "AssignmentStatus" AS ENUM ('PROPOSED', 'APPROVED', 'NOT_SELECTED', 'DECLINED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ProviderType" AS ENUM ('NETWORK_BUSINESS', 'INDEPENDENT_PROVIDER', 'INTERNAL_TEAM');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'SENT', 'PAID', 'PARTIALLY_PAID', 'VOID');

-- CreateTable
CREATE TABLE "Company" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "type" "CompanyType" NOT NULL,
    "isPlatformOwner" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "phone" TEXT,
    "roles" "Role"[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "address" TEXT,
    "city" TEXT NOT NULL,
    "zip" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceRequest" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "city" TEXT NOT NULL,
    "zip" TEXT NOT NULL,
    "appliance" TEXT NOT NULL,
    "issue" TEXT NOT NULL,
    "preferredWindow" TEXT,
    "status" "BookingStatus" NOT NULL DEFAULT 'PENDING_DISPATCH',
    "diagnosticFee" DECIMAL(10,2) NOT NULL DEFAULT 99.00,
    "diagnosticFeeCreditedTowardRepair" BOOLEAN NOT NULL DEFAULT true,
    "feeStatus" "FeeStatus" NOT NULL DEFAULT 'COLLECTED_AT_BOOKING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Provider" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "businessName" TEXT NOT NULL,
    "type" "ProviderType" NOT NULL,
    "specialties" TEXT[],
    "serviceCities" TEXT[],
    "rating" DECIMAL(3,2),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Provider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DispatchAssignment" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "serviceRequestId" UUID NOT NULL,
    "providerId" UUID NOT NULL,
    "status" "AssignmentStatus" NOT NULL DEFAULT 'PROPOSED',
    "dispatchMode" "DispatchMode" NOT NULL DEFAULT 'HYBRID',
    "approvalRequired" BOOLEAN NOT NULL DEFAULT true,
    "matchScore" INTEGER,
    "approvedById" UUID,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DispatchAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "serviceRequestId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "subtotal" DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    "diagnosticFee" DECIMAL(10,2) NOT NULL DEFAULT 99.00,
    "diagnosticCredit" DECIMAL(10,2) NOT NULL DEFAULT 99.00,
    "total" DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Company_slug_key" ON "Company"("slug");

-- CreateIndex
CREATE INDEX "Company_type_idx" ON "Company"("type");

-- CreateIndex
CREATE INDEX "User_companyId_idx" ON "User"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "User_companyId_email_key" ON "User"("companyId", "email");

-- CreateIndex
CREATE INDEX "Customer_companyId_idx" ON "Customer"("companyId");

-- CreateIndex
CREATE INDEX "Customer_companyId_phone_idx" ON "Customer"("companyId", "phone");

-- CreateIndex
CREATE INDEX "ServiceRequest_companyId_status_idx" ON "ServiceRequest"("companyId", "status");

-- CreateIndex
CREATE INDEX "ServiceRequest_companyId_zip_idx" ON "ServiceRequest"("companyId", "zip");

-- CreateIndex
CREATE INDEX "Provider_companyId_idx" ON "Provider"("companyId");

-- CreateIndex
CREATE INDEX "Provider_active_idx" ON "Provider"("active");

-- CreateIndex
CREATE INDEX "DispatchAssignment_companyId_status_idx" ON "DispatchAssignment"("companyId", "status");

-- CreateIndex
CREATE INDEX "DispatchAssignment_serviceRequestId_idx" ON "DispatchAssignment"("serviceRequestId");

-- CreateIndex
CREATE INDEX "DispatchAssignment_providerId_idx" ON "DispatchAssignment"("providerId");

-- CreateIndex
CREATE INDEX "Invoice_companyId_status_idx" ON "Invoice"("companyId", "status");

-- CreateIndex
CREATE INDEX "Invoice_serviceRequestId_idx" ON "Invoice"("serviceRequestId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceRequest" ADD CONSTRAINT "ServiceRequest_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceRequest" ADD CONSTRAINT "ServiceRequest_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Provider" ADD CONSTRAINT "Provider_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DispatchAssignment" ADD CONSTRAINT "DispatchAssignment_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DispatchAssignment" ADD CONSTRAINT "DispatchAssignment_serviceRequestId_fkey" FOREIGN KEY ("serviceRequestId") REFERENCES "ServiceRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DispatchAssignment" ADD CONSTRAINT "DispatchAssignment_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_serviceRequestId_fkey" FOREIGN KEY ("serviceRequestId") REFERENCES "ServiceRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Booking working-state changes (squashed from 20261108000607_booking_working_state
-- on 2026-11-09 so a fresh database can be built in order: tables first, then these).

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "source" TEXT,
ADD COLUMN     "userId" UUID;

-- AlterTable
ALTER TABLE "DispatchAssignment" ADD COLUMN     "approvedByName" TEXT,
ADD COLUMN     "providerCompanyId" UUID,
ALTER COLUMN "approvedById" SET DATA TYPE TEXT;

-- AlterTable
ALTER TABLE "ServiceRequest" ADD COLUMN     "appointment" JSONB,
ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "completedBy" TEXT,
ADD COLUMN     "dispatch" JSONB,
ADD COLUMN     "history" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "referenceCode" TEXT,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'WEBSITE';

-- CreateIndex
CREATE UNIQUE INDEX "ServiceRequest_referenceCode_key" ON "ServiceRequest"("referenceCode");
