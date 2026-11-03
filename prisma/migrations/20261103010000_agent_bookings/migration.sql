-- CreateEnum
CREATE TYPE "BookingSource" AS ENUM ('APP', 'AGENT');

-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'AGENT';

-- AlterTable
ALTER TABLE "User" ALTER COLUMN "passwordHash" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Reservation" ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "source" "BookingSource" NOT NULL DEFAULT 'APP';

-- CreateIndex
CREATE UNIQUE INDEX "Reservation_idempotencyKey_key" ON "Reservation"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Reservation_source_idx" ON "Reservation"("source");

-- AddForeignKey
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

