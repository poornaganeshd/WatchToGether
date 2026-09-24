import { Response } from "express";
import crypto from "crypto";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { AuthRequest } from "../middlewares/authMiddleware";
import { getClientUrl } from "../utils/mailer";

const prisma = new PrismaClient();

const hashToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

const createSchema = z.object({
  expiresInHours: z.union([z.literal(1), z.literal(24), z.literal(168), z.literal(720)]),
  maxUses: z.number().int().min(1).max(100).nullable().optional(),
});

/** Host or co-host of the room. */
const canManageRoom = async (roomId: string, userId: string) => {
  const room = await prisma.room.findUnique({ where: { id: roomId }, select: { hostId: true } });
  if (!room) return null;
  if (room.hostId === userId) return true;
  return !!(await prisma.roomCoHost.findUnique({ where: { roomId_userId: { roomId, userId } } }));
};

const linkView = (link: { id: string; expiresAt: Date; maxUses: number | null; uses: number; createdAt: Date }) => ({
  id: link.id,
  expiresAt: link.expiresAt,
  maxUses: link.maxUses,
  uses: link.uses,
  createdAt: link.createdAt,
});

export const createInviteLink = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const roomId = req.params.id as string;
    const allowed = await canManageRoom(roomId, req.userId!);
    if (allowed === null) {
      res.status(404).json({ error: "Room not found" });
      return;
    }
    if (!allowed) {
      res.status(403).json({ error: "Only hosts and co-hosts can create invite links" });
      return;
    }
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Choose how long the link lasts" });
      return;
    }
    const token = crypto.randomBytes(24).toString("base64url");
    const link = await prisma.roomInviteLink.create({
      data: {
        roomId,
        tokenHash: hashToken(token),
        createdById: req.userId!,
        expiresAt: new Date(Date.now() + parsed.data.expiresInHours * 3600_000),
        maxUses: parsed.data.maxUses ?? null,
      },
    });
    // The token is only ever shown once; the database keeps just its hash.
    res.status(201).json({ link: { ...linkView(link), url: `${getClientUrl()}/invite/${token}` } });
  } catch (error) {
    console.error("Create Invite Link Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const listInviteLinks = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const roomId = req.params.id as string;
    const allowed = await canManageRoom(roomId, req.userId!);
    if (!allowed) {
      res.status(allowed === null ? 404 : 403).json({ error: allowed === null ? "Room not found" : "Forbidden" });
      return;
    }
    const links = await prisma.roomInviteLink.findMany({
      where: { roomId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
    });
    res.status(200).json({ links: links.filter((l) => l.maxUses === null || l.uses < l.maxUses).map(linkView) });
  } catch (error) {
    console.error("List Invite Links Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const revokeInviteLink = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const roomId = req.params.id as string;
    const allowed = await canManageRoom(roomId, req.userId!);
    if (!allowed) {
      res.status(allowed === null ? 404 : 403).json({ error: allowed === null ? "Room not found" : "Forbidden" });
      return;
    }
    await prisma.roomInviteLink.updateMany({ where: { id: req.params.linkId as string, roomId }, data: { revokedAt: new Date() } });
    res.status(200).json({ message: "Link revoked" });
  } catch (error) {
    console.error("Revoke Invite Link Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

const findUsableLink = async (token: string) => {
  const link = await prisma.roomInviteLink.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { room: { select: { id: true, name: true, displayId: true, isPrivate: true, hostId: true, host: { select: { name: true } } } } },
  });
  if (!link) return { link: null, reason: "This invite link doesn't exist" };
  if (link.revokedAt) return { link, reason: "This invite link was revoked" };
  if (link.expiresAt.getTime() <= Date.now()) return { link, reason: "This invite link has expired" };
  if (link.maxUses !== null && link.uses >= link.maxUses) return { link, reason: "This invite link has been used up" };
  return { link, reason: null };
};

export const getInvite = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { link, reason } = await findUsableLink(req.params.token as string);
    if (!link) {
      res.status(404).json({ error: reason });
      return;
    }
    res.status(200).json({
      valid: !reason,
      reason,
      expiresAt: link.expiresAt,
      room: { id: link.room.id, name: link.room.name, displayId: link.room.displayId, isPrivate: link.room.isPrivate, hostName: link.room.host.name },
    });
  } catch (error) {
    console.error("Get Invite Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const acceptInvite = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId!;
    const { link, reason } = await findUsableLink(req.params.token as string);
    if (!link || reason) {
      res.status(link ? 410 : 404).json({ error: reason });
      return;
    }
    const roomId = link.roomId;

    const existing = await prisma.roomAccessGrant.findUnique({ where: { roomId_userId: { roomId, userId } } });
    if (!existing && link.room.hostId !== userId) {
      // Consume one use atomically so concurrent accepts can't exceed maxUses.
      const consumed = await prisma.roomInviteLink.updateMany({
        where: {
          id: link.id,
          revokedAt: null,
          expiresAt: { gt: new Date() },
          ...(link.maxUses !== null ? { uses: { lt: link.maxUses } } : {}),
        },
        data: { uses: { increment: 1 } },
      });
      if (consumed.count === 0) {
        res.status(410).json({ error: "This invite link has been used up" });
        return;
      }
      await prisma.roomAccessGrant.upsert({
        where: { roomId_userId: { roomId, userId } },
        update: {},
        create: { roomId, userId },
      });
    }
    res.status(200).json({ roomId });
  } catch (error) {
    console.error("Accept Invite Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

/** Host, co-host, or someone who accepted an invite link: may enter without the password. */
export const hasPasswordBypass = async (roomId: string, userId: string, hostId: string) => {
  if (hostId === userId) return true;
  const [cohost, grant] = await Promise.all([
    prisma.roomCoHost.findUnique({ where: { roomId_userId: { roomId, userId } } }),
    prisma.roomAccessGrant.findUnique({ where: { roomId_userId: { roomId, userId } } }),
  ]);
  return !!cohost || !!grant;
};
