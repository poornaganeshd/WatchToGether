-- CreateTable
CREATE TABLE "WatchedVideo" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT,
    "roomId" TEXT,
    "roomName" TEXT,
    "watchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WatchedVideo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WatchedVideo_userId_url_key" ON "WatchedVideo"("userId", "url");

-- CreateIndex
CREATE INDEX "WatchedVideo_userId_watchedAt_idx" ON "WatchedVideo"("userId", "watchedAt");

-- AddForeignKey
ALTER TABLE "WatchedVideo" ADD CONSTRAINT "WatchedVideo_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
