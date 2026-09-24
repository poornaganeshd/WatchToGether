-- These columns existed in schema.prisma but were never captured in a migration.
-- IF NOT EXISTS keeps this safe for databases that were synced with `prisma db push`.
ALTER TABLE "Room" ADD COLUMN IF NOT EXISTS "displayId" TEXT;
ALTER TABLE "Room" ADD COLUMN IF NOT EXISTS "playbackTime" DOUBLE PRECISION DEFAULT 0;
ALTER TABLE "Room" ADD COLUMN IF NOT EXISTS "playbackUrl" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "Room_displayId_key" ON "Room"("displayId");
