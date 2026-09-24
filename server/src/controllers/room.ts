import { Response } from "express";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { AuthRequest } from "../middlewares/authMiddleware";
import { getClientUrl, getMailTransport, mailFrom } from "../utils/mailer";
import { RoomManager, flushRoomWrites } from "../managers/RoomManager";
import { hashRoomPassword, verifyRoomPassword } from "../utils/roomPassword";
import { escapeHtml } from "../utils/escapeHtml";
import { findUserByEmail } from "./auth";

const prisma = new PrismaClient();

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Never expose the stored password (hashed or not) to clients.
const publicRoomSelect = {
  id: true,
  displayId: true,
  name: true,
  description: true,
  isPrivate: true,
  maxParticipants: true,
  hostId: true,
  isActive: true,
  createdAt: true,
  scheduledFor: true,
  host: { select: { name: true } },
  _count: { select: { participants: true } },
} as const;

const MAX_SCHEDULE_AHEAD_MS = 365 * 24 * 60 * 60 * 1000;
const scheduleSchema = z
  .string()
  .datetime({ offset: true, message: "Invalid date" })
  .transform((v) => new Date(v))
  .refine((d) => d.getTime() > Date.now() - 60_000, "Pick a time in the future")
  .refine((d) => d.getTime() < Date.now() + MAX_SCHEDULE_AHEAD_MS, "Pick a time within the next year");

const createRoomSchema = z.object({
  name: z.string().trim().min(1, "Room name is required").max(100, "Room name is too long"),
  description: z.string().trim().max(500, "Description is too long").optional(),
  isPrivate: z.boolean().optional(),
  password: z.string().max(100, "Password is too long").optional(),
  scheduledFor: scheduleSchema.optional(),
});

const updateRoomSchema = z.object({
  name: z.string().trim().min(1, "Room name is required").max(100, "Room name is too long").optional(),
  isPrivate: z.boolean().optional(),
  // Omit to keep the current password.
  password: z.string().max(100, "Password is too long").optional(),
  maxParticipants: z.number().int().min(2, "Rooms need room for at least 2 people").max(50, "Rooms are limited to 50 people").optional(),
  scheduledFor: scheduleSchema.nullable().optional(),
});

const inviteSchema = z.object({
  email: z.string().trim().email("Invalid email address"),
});

const joinSchema = z.object({
  roomId: z.string().trim().min(1, "Room ID is required"),
  password: z.string().optional(),
});

const findRoomByAnyId = (rawId: string) => {
  if (UUID_REGEX.test(rawId)) {
    return prisma.room.findUnique({ where: { id: rawId } });
  }
  // Accept the short display ID with or without the "WT-" prefix, in any case.
  const normalized = rawId.toUpperCase().replace(/\s+/g, "");
  const displayId = normalized.startsWith("WT-") ? normalized : `WT-${normalized}`;
  return prisma.room.findUnique({ where: { displayId } });
};


const acceptedFriendIds = async (userId: string) => {
  const links = await prisma.friend.findMany({
    where: { status: "ACCEPTED", OR: [{ userId }, { friendId: userId }] },
    select: { userId: true, friendId: true },
  });
  return links.map((l) => (l.userId === userId ? l.friendId : l.userId));
};

const notifyFriendsOfSchedule = async (req: AuthRequest, roomId: string, roomName: string, hostName: string, when: Date) => {
  try {
    const io = req.app.get("io");
    if (!io) return;
    for (const friendId of await acceptedFriendIds(req.userId!)) {
      io.to(`user_${friendId}`).emit("notification", {
        title: "Watch party scheduled",
        body: `${hostName} scheduled "${roomName}"`,
        roomId,
        scheduledFor: when.toISOString(),
      });
    }
  } catch (err) {
    console.error("Failed to notify friends of schedule:", err);
  }
};

export const createRoom = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const hostId = req.userId;
    if (!hostId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const parsed = createRoomSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0].message });
      return;
    }
    const { name, description, isPrivate, password, scheduledFor } = parsed.data;
    const trimmedPassword = password?.trim() || null;

    if (isPrivate && !trimmedPassword) {
      res.status(400).json({ error: "Private rooms need a password" });
      return;
    }

    let displayId = "";
    for (let attempt = 0; attempt < 20; attempt++) {
      const candidate = `WT-${Math.floor(1000 + Math.random() * 9000)}`;
      const existing = await prisma.room.findUnique({ where: { displayId: candidate } });
      if (!existing) {
        displayId = candidate;
        break;
      }
    }
    if (!displayId) {
      // Four digits are exhausted/colliding; widen the space instead of looping forever.
      displayId = `WT-${Date.now().toString(36).toUpperCase().slice(-6)}`;
    }

    const room = await prisma.room.create({
      data: {
        displayId,
        name,
        description,
        isPrivate: !!isPrivate,
        password: isPrivate && trimmedPassword ? await hashRoomPassword(trimmedPassword) : null,
        hostId,
        scheduledFor: scheduledFor ?? null,
      },
      select: publicRoomSelect,
    });

    if (scheduledFor) {
      await notifyFriendsOfSchedule(req, room.id, room.name, room.host.name, scheduledFor);
    }

    res.status(201).json({ room });
  } catch (error) {
    console.error("Create Room Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const getRooms = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const rooms = await prisma.room.findMany({
      // A room is only "live" while someone is actually in it.
      where: { isPrivate: false, isActive: true, participants: { some: {} } },
      select: publicRoomSelect,
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    res.status(200).json({ rooms });
  } catch (error) {
    console.error("Get Rooms Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const getRoomById = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;
    if (!UUID_REGEX.test(id)) {
      res.status(404).json({ error: "Room not found" });
      return;
    }
    const room = await prisma.room.findUnique({
      where: { id },
      select: {
        ...publicRoomSelect,
        password: true,
        coHosts: { select: { userId: true } },
      },
    });

    if (!room) {
      res.status(404).json({ error: "Room not found" });
      return;
    }

    const { password, ...rest } = room;
    res.status(200).json({ room: { ...rest, hasPassword: !!password } });
  } catch (error) {
    console.error("Get Room Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const deleteRoom = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;
    const userId = req.userId;

    const room = await prisma.room.findUnique({ where: { id } });

    if (!room) {
      res.status(404).json({ error: "Room not found" });
      return;
    }

    if (room.hostId !== userId) {
      res.status(403).json({ error: "Forbidden: Only the host can delete the room" });
      return;
    }

    // Kick everyone out of the live session before the row disappears.
    const roomManager = req.app.get("roomManager") as RoomManager | undefined;
    roomManager?.evictRoom(id);

    await prisma.room.delete({ where: { id } });
    res.status(200).json({ message: "Room deleted successfully" });
  } catch (error) {
    console.error("Delete Room Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const inviteRoom = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const roomId = req.params.id as string;
    const userId = req.userId;

    const parsed = inviteSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0].message });
      return;
    }
    const { email } = parsed.data;

    const [room, user] = await Promise.all([
      prisma.room.findUnique({ where: { id: roomId } }),
      prisma.user.findUnique({ where: { id: userId! } }),
    ]);

    if (!room || !user) {
      res.status(404).json({ error: "Room or User not found" });
      return;
    }

    // Only people who belong to the room can invite others to it; otherwise this endpoint
    // would let anyone make the server email arbitrary addresses.
    const isMember =
      room.hostId === user.id ||
      !!(await prisma.roomCoHost.findUnique({ where: { roomId_userId: { roomId, userId: user.id } } })) ||
      !!(await prisma.roomHistoryEntry.findUnique({ where: { userId_roomId: { userId: user.id, roomId } } }));
    if (!isMember) {
      res.status(403).json({ error: "Join this room before inviting people to it" });
      return;
    }

    const inviteLink = `${getClientUrl()}/room/${roomId}`;
    const transporter = getMailTransport();
    let emailed = false;

    if (transporter) {
      const safeUser = escapeHtml(user.name);
      const safeRoom = escapeHtml(room.name);
      try {
        await transporter.sendMail({
          from: mailFrom(),
          to: email,
          subject: `${user.name} invited you to watch together!`,
          text: `Hello!\n\n${user.name} invited you to join the room "${room.name}"${room.displayId ? ` (${room.displayId})` : ""}.\n\nJoin here: ${inviteLink}\n\nHave fun!`,
          html: `
            <div style="font-family: sans-serif; text-align: center; padding: 40px; background-color: #f4f4f5; border-radius: 8px;">
              <h2 style="color: #18181b;">You're Invited!</h2>
              <p style="color: #52525b;"><b>${safeUser}</b> invited you to join the room <b>"${safeRoom}"</b>.</p>
              <a href="${inviteLink}" style="display: inline-block; background-color: #4f46e5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; margin-top: 20px;">Join Room</a>
            </div>
          `,
        });
        emailed = true;
      } catch (mailErr) {
        console.error("Invite email failed:", mailErr);
      }
    }

    const targetUser = await findUserByEmail(email);
    if (targetUser) {
      const io = req.app.get("io");
      io?.to(`user_${targetUser.id}`).emit("notification", {
        title: "Room Invitation",
        body: `${user.name} invited you to join "${room.name}"!`,
        roomId,
      });
    }

    if (!emailed && !targetUser) {
      res.status(502).json({ error: "Email delivery is not configured and this user has no account" });
      return;
    }

    res.status(200).json({ message: "Invitation sent successfully", emailed, notified: !!targetUser });
  } catch (error) {
    console.error("Invite Room Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const joinRoom = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const parsed = joinSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0].message });
      return;
    }
    const { roomId, password } = parsed.data;

    const room = await findRoomByAnyId(roomId);

    if (!room) {
      res.status(404).json({ error: "Room not found" });
      return;
    }

    const isHost = room.hostId === req.userId;
    const isCoHost = !isHost && req.userId
      ? !!(await prisma.roomCoHost.findUnique({ where: { roomId_userId: { roomId: room.id, userId: req.userId } } }))
      : false;

    if (!isHost && !isCoHost && !(await verifyRoomPassword(room.password, password))) {
      res.status(403).json({ error: password ? "Incorrect password" : "Password required" });
      return;
    }

    res.status(200).json({ message: "Joined successfully", room: { id: room.id, displayId: room.displayId, name: room.name } });
  } catch (error) {
    console.error("Join Room Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const getRoomHistory = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const historyEntries = await prisma.roomHistoryEntry.findMany({
      where: { userId },
      include: { room: { select: publicRoomSelect } },
      orderBy: { visitedAt: "desc" },
      take: 100,
    });

    const rooms = historyEntries.map((entry) => ({ ...entry.room, visitedAt: entry.visitedAt }));
    res.status(200).json({ rooms });
  } catch (error) {
    console.error("Get Room History Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const removeRoomHistory = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId!;
    const roomId = req.params.id as string;
    await prisma.roomHistoryEntry.deleteMany({ where: { userId, roomId } });
    res.status(200).json({ message: "Removed from history" });
  } catch (error) {
    console.error("Remove Room History Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const endRoom = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;
    const userId = req.userId;

    const room = await prisma.room.findUnique({ where: { id } });
    if (!room) {
      res.status(404).json({ error: "Room not found" });
      return;
    }
    if (room.hostId !== userId) {
      res.status(403).json({ error: "Forbidden: Only the host can end the room" });
      return;
    }

    const roomManager = req.app.get("roomManager") as RoomManager | undefined;
    if (roomManager) {
      await roomManager.forceEndRoom(id);
    } else {
      await prisma.room.update({
        where: { id },
        data: { isActive: false },
      });
    }
    res.status(200).json({ message: "Room ended successfully" });
  } catch (error) {
    console.error("End Room Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const updateRoom = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;
    const parsed = updateRoomSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0].message });
      return;
    }

    const room = await prisma.room.findUnique({ where: { id } });
    if (!room) {
      res.status(404).json({ error: "Room not found" });
      return;
    }
    if (room.hostId !== req.userId) {
      res.status(403).json({ error: "Forbidden: Only the host can change room settings" });
      return;
    }

    const { name, isPrivate, password, maxParticipants, scheduledFor } = parsed.data;
    const nextPrivate = isPrivate ?? room.isPrivate;
    const trimmedPassword = password?.trim();

    let nextPassword: string | null | undefined;
    if (!nextPrivate) {
      nextPassword = null;
    } else if (trimmedPassword) {
      nextPassword = await hashRoomPassword(trimmedPassword);
    } else if (!room.password) {
      res.status(400).json({ error: "Private rooms need a password" });
      return;
    }

    const updated = await prisma.room.update({
      where: { id },
      data: {
        ...(name !== undefined ? { name } : {}),
        isPrivate: nextPrivate,
        ...(nextPassword !== undefined ? { password: nextPassword } : {}),
        ...(maxParticipants !== undefined ? { maxParticipants } : {}),
        // A new start time gets a fresh "starting now" reminder.
        ...(scheduledFor !== undefined ? { scheduledFor, reminderSentAt: null } : {}),
      },
      select: publicRoomSelect,
    });

    const roomManager = req.app.get("roomManager") as RoomManager | undefined;
    roomManager?.updateSettings(id, { maxParticipants: updated.maxParticipants });
    if (scheduledFor && scheduledFor.getTime() !== room.scheduledFor?.getTime()) {
      await notifyFriendsOfSchedule(req, id, updated.name, updated.host.name, scheduledFor);
    }
    req.app.get("io")?.to(id).emit("room_updated", {
      name: updated.name,
      isPrivate: updated.isPrivate,
      maxParticipants: updated.maxParticipants,
    });

    res.status(200).json({ room: updated });
  } catch (error) {
    console.error("Update Room Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

// Watch parties scheduled by you or your friends, from a few hours ago onward.
export const getUpcomingRooms = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId!;
    const hostIds = [userId, ...(await acceptedFriendIds(userId))];
    const rooms = await prisma.room.findMany({
      where: {
        hostId: { in: hostIds },
        scheduledFor: { gte: new Date(Date.now() - 3 * 60 * 60 * 1000) },
      },
      select: publicRoomSelect,
      orderBy: { scheduledFor: "asc" },
      take: 50,
    });
    res.status(200).json({ rooms });
  } catch (error) {
    console.error("Get Upcoming Rooms Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

const requireHost = async (req: AuthRequest, res: Response) => {
  const room = await prisma.room.findUnique({ where: { id: req.params.id as string }, select: { id: true, hostId: true } });
  if (!room) {
    res.status(404).json({ error: "Room not found" });
    return null;
  }
  if (room.hostId !== req.userId) {
    res.status(403).json({ error: "Forbidden: Only the host can manage removed participants" });
    return null;
  }
  return room;
};

export const getRoomBans = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const room = await requireHost(req, res);
    if (!room) return;
    // Bans are written in the background; make sure recent ones are visible.
    await flushRoomWrites(room.id);
    const bans = await prisma.roomBan.findMany({
      where: { roomId: room.id },
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: "desc" },
    });
    res.status(200).json({ bans: bans.map((b) => ({ user: b.user, createdAt: b.createdAt })) });
  } catch (error) {
    console.error("Get Room Bans Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const unbanUser = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const room = await requireHost(req, res);
    if (!room) return;
    const roomManager = req.app.get("roomManager") as RoomManager | undefined;
    await flushRoomWrites(room.id);
    if (roomManager) {
      await roomManager.unbanUser(room.id, req.params.userId as string);
    } else {
      await prisma.roomBan.deleteMany({ where: { roomId: room.id, userId: req.params.userId as string } });
    }
    res.status(200).json({ message: "User can rejoin" });
  } catch (error) {
    console.error("Unban Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};
