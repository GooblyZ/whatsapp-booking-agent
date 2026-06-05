-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('SENT', 'DELIVERED', 'READ', 'FAILED');

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "metaErrorCode" TEXT,
ADD COLUMN     "metaErrorMessage" TEXT,
ADD COLUMN     "status" "MessageStatus",
ADD COLUMN     "statusUpdatedAt" TIMESTAMP(3);
