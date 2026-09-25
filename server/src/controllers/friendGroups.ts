import { Response } from "express";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { AuthRequest } from "../middlewares/authMiddleware";

const prisma = new PrismaClient();

const MAX_GROUPS = 20;

const groupSchema = z.object({
  name: z.string().trim().min(1, "Give the group a name").max(50, "Group names are limited to 50 characters"),
  memberIds: z.array(z.string().uuid()).max(100),
});

const acceptedFriendIds = async (userId: string) => {
  const links = await prisma.friend.findMany({
    where: { status: "ACCEPTED", OR: [{ userId }, { friendId: userId }] },
    select: { userId: true, friendId: true },
  });
  return new Set(links.map((l) => (l.userId === userId ? l.friendId : l.userId)));
};

const groupView = (group: { id: string; name: string; members: { user: { id: string; name: string; avatarUpdatedAt: Date | null } }[] }) => ({
  id: group.id,
  name: group.name,
  members: group.members.map(({ user }) => ({ id: user.id, name: user.name, avatarVersion: user.avatarUpdatedAt?.getTime() ?? null })),
});

const includeMembers = { members: { include: { user: { select: { id: true, name: true, avatarUpdatedAt: true } } } } } as const;

export const listGroups = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId!;
    const [groups, friends] = await Promise.all([
      prisma.friendGroup.findMany({ where: { ownerId: userId }, include: includeMembers, orderBy: { createdAt: "asc" } }),
      acceptedFriendIds(userId),
    ]);
    // Members who have since been unfriended drop out of the view (and of group invites).
    res.status(200).json({
      groups: groups.map((g) => groupView({ ...g, members: g.members.filter((m) => friends.has(m.user.id)) })),
    });
  } catch (error) {
    console.error("List Groups Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const createGroup = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId!;
    const parsed = groupSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0].message });
      return;
    }
    if ((await prisma.friendGroup.count({ where: { ownerId: userId } })) >= MAX_GROUPS) {
      res.status(400).json({ error: `You can have up to ${MAX_GROUPS} groups` });
      return;
    }
    const friends = await acceptedFriendIds(userId);
    const memberIds = Array.from(new Set(parsed.data.memberIds)).filter((id) => friends.has(id));
    const group = await prisma.friendGroup.create({
      data: { ownerId: userId, name: parsed.data.name, members: { create: memberIds.map((id) => ({ userId: id })) } },
      include: includeMembers,
    });
    res.status(201).json({ group: groupView(group) });
  } catch (error) {
    console.error("Create Group Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const updateGroup = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId!;
    const groupId = req.params.id as string;
    const existing = await prisma.friendGroup.findUnique({ where: { id: groupId } });
    if (!existing || existing.ownerId !== userId) {
      res.status(404).json({ error: "Group not found" });
      return;
    }
    const parsed = groupSchema.partial().safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0].message });
      return;
    }
    const ops = [];
    if (parsed.data.name !== undefined) {
      ops.push(prisma.friendGroup.update({ where: { id: groupId }, data: { name: parsed.data.name } }));
    }
    if (parsed.data.memberIds !== undefined) {
      const friends = await acceptedFriendIds(userId);
      const memberIds = Array.from(new Set(parsed.data.memberIds)).filter((id) => friends.has(id));
      ops.push(prisma.friendGroupMember.deleteMany({ where: { groupId } }));
      ops.push(prisma.friendGroupMember.createMany({ data: memberIds.map((id) => ({ groupId, userId: id })) }));
    }
    await prisma.$transaction(ops);
    const group = await prisma.friendGroup.findUnique({ where: { id: groupId }, include: includeMembers });
    res.status(200).json({ group: groupView(group!) });
  } catch (error) {
    console.error("Update Group Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const deleteGroup = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await prisma.friendGroup.deleteMany({ where: { id: req.params.id as string, ownerId: req.userId! } });
    res.status(200).json({ message: "Group deleted" });
  } catch (error) {
    console.error("Delete Group Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

/** Current accepted friends in one of the user's groups. */
export const getGroupMemberIds = async (ownerId: string, groupId: string): Promise<string[] | null> => {
  const group = await prisma.friendGroup.findUnique({ where: { id: groupId }, include: { members: true } });
  if (!group || group.ownerId !== ownerId) return null;
  const friends = await acceptedFriendIds(ownerId);
  return group.members.map((m) => m.userId).filter((id) => friends.has(id));
};
