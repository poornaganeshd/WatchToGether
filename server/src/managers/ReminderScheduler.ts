import { PrismaClient } from "@prisma/client";
import { Server } from "socket.io";

const prisma = new PrismaClient();

// Parties whose start time passed longer ago than this are skipped (e.g. after downtime),
// so nobody gets a "starting now" for something that started hours ago.
const MAX_LATENESS_MS = 30 * 60 * 1000;

/** Sends "starting now" notifications for scheduled rooms that are due. Returns rooms notified. */
export const runReminderSweep = async (io: Server): Promise<string[]> => {
  const now = new Date();
  const due = await prisma.room.findMany({
    where: {
      reminderSentAt: null,
      scheduledFor: { lte: now, gte: new Date(now.getTime() - MAX_LATENESS_MS) },
    },
    select: { id: true, name: true, hostId: true, host: { select: { name: true } } },
    take: 100,
  });

  const notified: string[] = [];
  for (const room of due) {
    // Claim the room first so overlapping sweeps never double-send.
    const { count } = await prisma.room.updateMany({
      where: { id: room.id, reminderSentAt: null },
      data: { reminderSentAt: now },
    });
    if (count === 0) continue;

    const links = await prisma.friend.findMany({
      where: { status: "ACCEPTED", OR: [{ userId: room.hostId }, { friendId: room.hostId }] },
      select: { userId: true, friendId: true },
    });
    const friendIds = links.map((l) => (l.userId === room.hostId ? l.friendId : l.userId));

    io.to(`user_${room.hostId}`).emit("notification", {
      title: "Your watch party is starting",
      body: `"${room.name}" is scheduled to start now. Your friends have been reminded.`,
      roomId: room.id,
    });
    for (const friendId of friendIds) {
      io.to(`user_${friendId}`).emit("notification", {
        title: "Watch party starting",
        body: `${room.host.name}'s "${room.name}" is starting now`,
        roomId: room.id,
      });
    }
    notified.push(room.id);
  }
  return notified;
};

export const startReminderScheduler = (io: Server, intervalMs = 30_000) => {
  const tick = () => {
    runReminderSweep(io).catch((err) => console.error("Reminder sweep failed:", err));
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
};
