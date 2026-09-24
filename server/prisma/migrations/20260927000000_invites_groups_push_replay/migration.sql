-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "videoTime" DOUBLE PRECISION,
ADD COLUMN     "videoUrl" TEXT;

-- CreateTable
CREATE TABLE "RoomInviteLink" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "maxUses" INTEGER,
    "uses" INTEGER NOT NULL DEFAULT 0,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoomInviteLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoomAccessGrant" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoomAccessGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FriendGroup" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FriendGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FriendGroupMember" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "FriendGroupMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PushSubscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RoomInviteLink_tokenHash_key" ON "RoomInviteLink"("tokenHash");

-- CreateIndex
CREATE INDEX "RoomInviteLink_roomId_idx" ON "RoomInviteLink"("roomId");

-- CreateIndex
CREATE UNIQUE INDEX "RoomAccessGrant_roomId_userId_key" ON "RoomAccessGrant"("roomId", "userId");

-- CreateIndex
CREATE INDEX "FriendGroup_ownerId_idx" ON "FriendGroup"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "FriendGroupMember_groupId_userId_key" ON "FriendGroupMember"("groupId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");

-- CreateIndex
CREATE INDEX "PushSubscription_userId_idx" ON "PushSubscription"("userId");

-- CreateIndex
CREATE INDEX "Message_roomId_videoUrl_idx" ON "Message"("roomId", "videoUrl");

-- AddForeignKey
ALTER TABLE "RoomInviteLink" ADD CONSTRAINT "RoomInviteLink_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomInviteLink" ADD CONSTRAINT "RoomInviteLink_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomAccessGrant" ADD CONSTRAINT "RoomAccessGrant_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomAccessGrant" ADD CONSTRAINT "RoomAccessGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FriendGroup" ADD CONSTRAINT "FriendGroup_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FriendGroupMember" ADD CONSTRAINT "FriendGroupMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "FriendGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FriendGroupMember" ADD CONSTRAINT "FriendGroupMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

