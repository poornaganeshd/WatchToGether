import { Response } from "express";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { AuthRequest } from "../middlewares/authMiddleware";
import nodemailer from "nodemailer";
import { RoomManager } from "../managers/RoomManager";
import { hashRoomPassword, verifyRoomPassword } from "../utils/roomPassword";
import { escapeHtml } from "../utils/escapeHtml";
import { findUserByEmail } from "./auth";

const prisma = new PrismaClient();

// Read lazily: this module is imported before dotenv runs in index.ts.
const getClientUrl = () =>
  (process.env.CLIENT_URL || "http://localhost:5173").split(",")[0].trim().replace(/\/+$/, "");
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
  host: { select: { name: true } },
  _count: { select: { participants: true } },
} as const;

const createRoomSchema = z.object({
  name: z.string().trim().min(1, "Room name is required").max(100, "Room name is too long"),
  description: z.string().trim().max(500, "Description is too long").optional(),
  isPrivate: z.boolean().optional(),
  password: z.string().max(100, "Password is too long").optional(),
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

const getMailTransport = () => {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;
  const port = Number(SMTP_PORT) || 587;
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
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
    const { name, description, isPrivate, password } = parsed.data;
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
      },
      select: publicRoomSelect,
    });

    res.status(201).json({ room });
  } catch (error) {
    console.error("Create Room Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const getRooms = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const rooms = await prisma.room.findMany({
      where: { isPrivate: false, isActive: true },
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

    const inviteLink = `${getClientUrl()}/room/${roomId}`;
    const transporter = getMailTransport();
    let emailed = false;

    if (transporter) {
      const safeUser = escapeHtml(user.name);
      const safeRoom = escapeHtml(room.name);
      try {
        await transporter.sendMail({
          from: process.env.SMTP_FROM || '"WatchTogether" <noreply@watchtogether.app>',
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
