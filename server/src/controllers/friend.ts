import { Response } from "express";
import { PrismaClient } from "@prisma/client";
import { notifyUser } from "../infra/notify";
import { AuthRequest } from "../middlewares/authMiddleware";
import { findUserByEmail } from "./auth";
import { presence } from "../managers/PresenceManager";

const prisma = new PrismaClient();

export const getFriends = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId!;
    const friends = await prisma.friend.findMany({
      where: {
        OR: [
          { userId },
          { friendId: userId }
        ]
      },
      include: {
        user: { select: { id: true, name: true, email: true, avatarUpdatedAt: true } },
        friendUser: { select: { id: true, name: true, email: true, avatarUpdatedAt: true } }
      }
    });
    
    const liveRoomIds = new Map<string, string>(); // friend userId -> roomId

    // Presence is only shared between accepted friends.
    const formattedFriends = await Promise.all(friends.map(async (f) => {
      const isSender = f.userId === userId;
      const { avatarUpdatedAt, ...otherUser } = isSender ? f.friendUser : f.user;
      const accepted = f.status === "ACCEPTED";
      const [online, roomId] = accepted
        ? await Promise.all([presence.isOnline(otherUser.id), presence.getRoom(otherUser.id)])
        : [false, null];
      if (roomId) liveRoomIds.set(otherUser.id, roomId);
      return {
        id: f.id,
        status: f.status, // PENDING, ACCEPTED
        isSender,
        user: { ...otherUser, avatarVersion: avatarUpdatedAt ? avatarUpdatedAt.getTime() : null },
        online,
        room: null as null | { id: string; name: string; displayId: string | null; isPrivate: boolean },
      };
    }));

    if (liveRoomIds.size > 0) {
      const rooms = await prisma.room.findMany({
        where: { id: { in: Array.from(new Set(liveRoomIds.values())) } },
        select: { id: true, name: true, displayId: true, isPrivate: true },
      });
      const byId = new Map(rooms.map((r) => [r.id, r]));
      for (const f of formattedFriends) {
        const roomId = liveRoomIds.get(f.user.id);
        f.room = roomId ? byId.get(roomId) ?? null : null;
      }
    }

    res.status(200).json({ friends: formattedFriends });
  } catch (error) {
    console.error("Get Friends Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const sendFriendRequest = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { email } = req.body;
    const userId = req.userId!;

    if (!email || typeof email !== "string") {
      res.status(400).json({ error: "Email is required" });
      return;
    }

    const targetUser = await findUserByEmail(email);
    if (!targetUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    if (targetUser.id === userId) {
      res.status(400).json({ error: "Cannot add yourself" });
      return;
    }

    const existing = await prisma.friend.findFirst({
      where: {
        OR: [
          { userId, friendId: targetUser.id },
          { userId: targetUser.id, friendId: userId }
        ]
      }
    });

    if (existing) {
      // They already asked us: treat sending a request back as accepting theirs.
      if (existing.status === "PENDING" && existing.friendId === userId) {
        await prisma.friend.update({ where: { id: existing.id }, data: { status: "ACCEPTED" } });
        const accepter = await prisma.user.findUnique({ where: { id: userId } });
        const io = req.app.get("io");
        if (io && accepter) {
          void notifyUser(io, targetUser.id, {
            title: "Friend Request Accepted",
            body: `${accepter.name} accepted your friend request!`
          });
        }
        res.status(200).json({ message: "Friend request accepted", friend: { ...existing, status: "ACCEPTED" } });
        return;
      }
      res.status(400).json({ error: existing.status === "ACCEPTED" ? "You are already friends" : "Friend request already exists" });
      return;
    }

    const friend = await prisma.friend.create({
      data: {
        userId,
        friendId: targetUser.id,
        status: "PENDING"
      }
    });

    const senderUser = await prisma.user.findUnique({ where: { id: userId } });
    const io = req.app.get("io");
    if (io && senderUser) {
      void notifyUser(io, targetUser.id, {
        title: "New Friend Request",
        body: `${senderUser.name} sent you a friend request!`
      });
    }

    res.status(201).json({ message: "Friend request sent", friend });
  } catch (error) {
    console.error("Send Request Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const acceptFriendRequest = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;
    const userId = req.userId!;

    const friend = await prisma.friend.findUnique({ where: { id } });
    if (!friend || friend.friendId !== userId) {
      res.status(404).json({ error: "Request not found" });
      return;
    }
    if (friend.status === "ACCEPTED") {
      res.status(200).json({ message: "Friend request accepted" });
      return;
    }

    await prisma.friend.update({
      where: { id },
      data: { status: "ACCEPTED" }
    });

    const accepterUser = await prisma.user.findUnique({ where: { id: userId } });
    const io = req.app.get("io");
    if (io && accepterUser) {
      void notifyUser(io, friend.userId, {
        title: "Friend Request Accepted",
        body: `${accepterUser.name} accepted your friend request!`
      });
    }

    res.status(200).json({ message: "Friend request accepted" });
  } catch (error) {
    console.error("Accept Request Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const removeFriend = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;
    const userId = req.userId!;

    const friend = await prisma.friend.findUnique({ where: { id } });
    // Either side can decline, cancel, or unfriend.
    if (!friend || (friend.userId !== userId && friend.friendId !== userId)) {
      res.status(404).json({ error: "Friend not found" });
      return;
    }

    await prisma.friend.delete({ where: { id } });
    res.status(200).json({ message: "Friend removed" });
  } catch (error) {
    console.error("Remove Friend Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};
