import { PrismaClient } from "@prisma/client";
import { Server } from "socket.io";

const prisma = new PrismaClient();

export interface PlaybackState {
  playing: boolean;
  time: number;
  url: string;
  lastUpdatedAt: number;
  serverTime?: number;
}

export interface QueueItem {
  id: string;
  url: string;
  addedBy: string;
  addedByName: string;
  position?: number;
}

// Queue and bans are written through to the database in the background; the in-memory
// copy stays authoritative for the live session. Writes are chained per room so they land in order.
const writeChains = new Map<string, Promise<unknown>>();
const persist = (roomId: string, label: string, op: () => Promise<unknown>) => {
  const next = (writeChains.get(roomId) ?? Promise.resolve())
    .then(op)
    .catch((err) => console.error(`Failed to persist ${label}:`, err));
  writeChains.set(roomId, next);
  next.finally(() => {
    if (writeChains.get(roomId) === next) writeChains.delete(roomId);
  });
};

export const flushRoomWrites = (roomId: string) => writeChains.get(roomId) ?? Promise.resolve();

const MAX_QUEUE_LENGTH = 50;

export interface Subtitles {
  label: string;
  vtt: string;
}

export type SyncState = "synced" | "drifting" | "buffering" | "error";

interface RoomState {
  roomId: string;
  hostId: string;
  coHosts: Set<string>;
  participants: Map<string, string>; // socketId -> userId
  participantNames: Map<string, string>; // socketId -> display name
  participantStatuses: Map<string, { cam: boolean; mic: boolean }>;
  playback: PlaybackState;
  disconnectedParticipants: Map<string, { userId: string; timeout: NodeJS.Timeout }>;
  queue: QueueItem[];
  bannedUserIds: Set<string>;
  maxParticipants: number;
  startedAt: number;
  subtitles: Subtitles | null;
  skipVotes: Set<string>; // userIds voting to skip the current video
  participantSync: Map<string, { state: SyncState; drift: number }>; // socketId -> report
  participantAvatars: Map<string, number | null>; // socketId -> avatar version
}

export class RoomManager {
  private rooms: Map<string, RoomState> = new Map();
  private pendingRooms: Map<string, Promise<RoomState | null>> = new Map();
  private io: Server;
  public gracePeriodMs: number;

  constructor(io: Server, gracePeriodMs: number = 10000) {
    this.io = io;
    this.gracePeriodMs = gracePeriodMs;
  }

  public async getOrCreateRoom(roomId: string): Promise<RoomState | null> {
    if (this.rooms.has(roomId)) {
      return this.rooms.get(roomId)!;
    }

    if (this.pendingRooms.has(roomId)) {
      return this.pendingRooms.get(roomId)!;
    }

    const loadPromise = (async () => {
      try {
        const dbRoom = await prisma.room.findUnique({
          where: { id: roomId },
          include: {
            coHosts: true,
            bans: { select: { userId: true } },
            queueItems: { orderBy: { position: "asc" }, include: { addedBy: { select: { name: true } } } },
          },
        });

        if (!dbRoom) return null;

        if (this.rooms.has(roomId)) {
          return this.rooms.get(roomId)!;
        }

        const newRoom: RoomState = {
          roomId,
          hostId: dbRoom.hostId,
          coHosts: new Set(dbRoom.coHosts.map((ch) => ch.userId)),
          participants: new Map(),
          participantNames: new Map(),
          participantStatuses: new Map(),
          disconnectedParticipants: new Map(),
          queue: dbRoom.queueItems.map((q) => ({
            id: q.id,
            url: q.url,
            addedBy: q.addedById,
            addedByName: q.addedBy.name,
            position: q.position,
          })),
          bannedUserIds: new Set(dbRoom.bans.map((b) => b.userId)),
          maxParticipants: dbRoom.maxParticipants ?? 10,
          startedAt: Date.now(),
          subtitles: null,
          skipVotes: new Set(),
          participantSync: new Map(),
          participantAvatars: new Map(),
          playback: {
            playing: false,
            time: dbRoom.playbackTime ?? 0,
            url: dbRoom.playbackUrl ?? "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
            lastUpdatedAt: Date.now(),
          },
        };

        this.rooms.set(roomId, newRoom);
        return newRoom;
      } catch (err) {
        console.error("Failed to load room from DB:", err);
        return null;
      } finally {
        this.pendingRooms.delete(roomId);
      }
    })();

    this.pendingRooms.set(roomId, loadPromise);
    return loadPromise;
  }

  public getRoom(roomId: string): RoomState | undefined {
    return this.rooms.get(roomId);
  }

  public getSocketRoomId(socketId: string): string | undefined {
    for (const [roomId, room] of this.rooms.entries()) {
      if (room.participants.has(socketId)) {
        return roomId;
      }
    }
    return undefined;
  }

  public isAuthorized(roomId: string, userId: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room) return false;
    return room.hostId === userId || room.coHosts.has(userId);
  }

  public async handleJoin(roomId: string, socketId: string, userId: string, userName: string, avatarVersion: number | null = null) {
    const room = await this.getOrCreateRoom(roomId);
    if (!room) return false;

    // Check if user was in disconnected state and cancel the pending timeout
    const staleSocketIds: string[] = [];
    for (const [discSocketId, data] of room.disconnectedParticipants.entries()) {
      if (data.userId === userId) {
        clearTimeout(data.timeout);
        room.disconnectedParticipants.delete(discSocketId);
        staleSocketIds.push(discSocketId);
      }
    }

    // Check if user had any dead/stale sockets in the room and clean them up
    // Note: If an existing socket is still actively connected (e.g. another tab), do not evict it.
    for (const [sId, uId] of room.participants.entries()) {
      if (uId === userId && sId !== socketId) {
        const existingSocket = this.io.sockets?.sockets?.get(sId);
        const isStillConnected = existingSocket && existingSocket.connected;
        if (!isStillConnected) {
          room.participants.delete(sId);
          room.participantNames.delete(sId);
          room.participantAvatars.delete(sId);
          room.participantSync.delete(sId);
          room.participantStatuses.delete(sId);
          if (!staleSocketIds.includes(sId)) {
            staleSocketIds.push(sId);
          }
        }
      }
    }

    // If any stale socket IDs were identified, notify room to drop them
    for (const staleId of staleSocketIds) {
      this.io.to(roomId).emit("user_left", { userId, socketId: staleId });
    }

    if (room.participants.size === 0 && room.disconnectedParticipants.size === 0) {
      room.startedAt = Date.now();
    }
    room.participants.set(socketId, userId);
    room.participantNames.set(socketId, userName);
    room.participantAvatars.set(socketId, avatarVersion);

    // Synchronize to PostgreSQL: Ensure Room.isActive is true and participant is recorded
    let joinAttempts = 0;
    while (joinAttempts < 3) {
      try {
        await prisma.$transaction([
          prisma.room.update({
            where: { id: roomId },
            data: { isActive: true },
          }),
          prisma.participant.upsert({
            where: { userId_roomId: { userId, roomId } },
            update: { joinedAt: new Date() },
            create: { userId, roomId },
          }),
          prisma.roomHistoryEntry.upsert({
            where: { userId_roomId: { userId, roomId } },
            update: { visitedAt: new Date() },
            create: { userId, roomId },
          }),
        ]);
        break;
      } catch (err) {
        joinAttempts++;
        console.error(`Error updating room active state, participant, or history in DB (attempt ${joinAttempts}/3):`, err);
        if (joinAttempts < 3) {
          await new Promise((r) => setTimeout(r, 400 * joinAttempts));
        }
      }
    }

    return true;
  }

  public handleDisconnect(socketId: string) {
    for (const [roomId, room] of this.rooms.entries()) {
      if (room.participants.has(socketId)) {
        const userId = room.participants.get(socketId)!;
        room.participants.delete(socketId);
        room.participantNames.delete(socketId);
        room.participantAvatars.delete(socketId);
        room.participantSync.delete(socketId);
        room.participantStatuses.delete(socketId);

        // If the user still has another active socket in the room, do not schedule removal
        const hasOtherActiveSocket = Array.from(room.participants.values()).includes(userId);
        if (hasOtherActiveSocket) {
          return;
        }

        // Schedule permanent removal after reconnection grace period
        const timeout = setTimeout(async () => {
          if (room.disconnectedParticipants.get(socketId)?.timeout === timeout) {
            room.disconnectedParticipants.delete(socketId);
            await this.permanentlyRemoveUser(roomId, userId, socketId);
            await this.checkAndDeactivateIfEmpty(roomId);
          }
        }, this.gracePeriodMs);

        room.disconnectedParticipants.set(socketId, { userId, timeout });
        this.io.to(roomId).emit("user_disconnected_temp", { socketId, userId });
      }
    }
  }

  public async handleLeave(roomId: string, socketId: string, userId: string) {
    const room = this.rooms.get(roomId);
    if (!room) return;

    for (const [discSocketId, data] of room.disconnectedParticipants.entries()) {
      if (data.userId === userId) {
        clearTimeout(data.timeout);
        room.disconnectedParticipants.delete(discSocketId);
      }
    }

    room.participants.delete(socketId);
    room.participantNames.delete(socketId);
    room.participantAvatars.delete(socketId);
    room.participantSync.delete(socketId);
    room.participantStatuses.delete(socketId);
    await this.permanentlyRemoveUser(roomId, userId, socketId);
    await this.checkAndDeactivateIfEmpty(roomId);
  }

  private async permanentlyRemoveUser(roomId: string, userId: string, oldSocketId: string) {
    const room = this.rooms.get(roomId);
    if (!room) return;

    room.participantStatuses.delete(oldSocketId);

    // If the user has reconnected and has an active socket in the room, do not remove them
    const isStillActive = Array.from(room.participants.values()).includes(userId);
    if (isStillActive) {
      return;
    }

    // Notify room
    this.io.to(roomId).emit("user_left", { userId, socketId: oldSocketId });

    let removeAttempts = 0;
    while (removeAttempts < 3) {
      try {
        await prisma.participant.deleteMany({
          where: { userId, roomId },
        });
        break;
      } catch (err) {
        removeAttempts++;
        console.error(`Failed to delete participant from DB (attempt ${removeAttempts}/3):`, err);
        if (removeAttempts < 3) {
          await new Promise((r) => setTimeout(r, 400 * removeAttempts));
        }
      }
    }

    // Host migration if host left and didn't reconnect
    if (room.hostId === userId) {
      await this.migrateHost(roomId);
    }
  }

  public async checkAndDeactivateIfEmpty(roomId: string): Promise<boolean> {
    const room = this.rooms.get(roomId);
    if (!room) return true;

    const hasActive = room.participants.size > 0;
    const hasDisconnected = room.disconnectedParticipants.size > 0;

    if (!hasActive && !hasDisconnected) {
      let attempts = 0;
      while (attempts < 3) {
        try {
          await Promise.all([
            prisma.room.update({
              where: { id: roomId },
              data: {
                isActive: false,
                playbackUrl: room.playback.url,
                playbackTime: this.getCurrentPlaybackTime(room.playback),
              },
            }),
            prisma.participant.deleteMany({
              where: { roomId },
            }),
          ]);
          this.rooms.delete(roomId);
          return true;
        } catch (err) {
          attempts++;
          console.error(`Failed to deactivate empty room in DB (attempt ${attempts}/3):`, err);
          if (attempts < 3) {
            await new Promise((r) => setTimeout(r, 400 * attempts));
          }
        }
      }
      this.rooms.delete(roomId);
      return true;
    }
    return false;
  }

  // Drops the in-memory session and tells everyone in it that the room is over.
  public evictRoom(roomId: string) {
    const room = this.rooms.get(roomId);
    if (room) {
      for (const [, data] of room.disconnectedParticipants.entries()) {
        clearTimeout(data.timeout);
      }
      room.disconnectedParticipants.clear();
      this.rooms.delete(roomId);
    }
    this.io.to(roomId).emit("room_ended", { roomId });
    this.io.in(roomId).socketsLeave(roomId);
  }

  public async forceEndRoom(roomId: string) {
    this.evictRoom(roomId);
    try {
      await prisma.room.update({
        where: { id: roomId },
        data: { isActive: false },
      });
      await prisma.participant.deleteMany({
        where: { roomId },
      });
    } catch (err) {
      console.error("Failed to force end room in DB:", err);
    }
  }

  public async makeCoHost(roomId: string, targetUserId: string) {
    const room = this.rooms.get(roomId);
    if (!room) return false;

    room.coHosts.add(targetUserId);
    try {
      await prisma.roomCoHost.upsert({
        where: { roomId_userId: { roomId, userId: targetUserId } },
        update: {},
        create: { roomId, userId: targetUserId },
      });
      return true;
    } catch (err) {
      console.error("Failed to add co-host to DB", err);
      return false;
    }
  }

  private async migrateHost(roomId: string) {
    const room = this.rooms.get(roomId);
    if (!room) return;

    let newHostId: string | null = null;

    // 1. Try to find an active co-host
    for (const activeSocketId of room.participants.keys()) {
      const uid = room.participants.get(activeSocketId);
      if (uid && room.coHosts.has(uid)) {
        newHostId = uid;
        break;
      }
    }

    // 2. Try to find any active participant
    if (!newHostId && room.participants.size > 0) {
      const firstActiveSocket = Array.from(room.participants.keys())[0];
      newHostId = room.participants.get(firstActiveSocket)!;
    }

    if (newHostId) {
      room.hostId = newHostId;
      room.coHosts.delete(newHostId);
      
      try {
        await prisma.room.update({
          where: { id: roomId },
          data: { hostId: newHostId },
        });
        // Remove from co-hosts in DB if they were one
        await prisma.roomCoHost.deleteMany({
          where: { roomId, userId: newHostId }
        });
      } catch (err) {
        console.error("Failed to update new host in DB", err);
      }

      this.io.to(roomId).emit("new_host", { userId: newHostId });
    }
  }

  // playback.time is the position at lastUpdatedAt; extrapolate while playing.
  public getCurrentPlaybackTime(playback: PlaybackState): number {
    if (!playback.playing) return playback.time;
    return playback.time + Math.max(0, (Date.now() - playback.lastUpdatedAt) / 1000);
  }

  public isBanned(roomId: string, userId: string): boolean {
    return !!this.rooms.get(roomId)?.bannedUserIds.has(userId);
  }

  // Distinct users currently in the room, not counting the one asking to join.
  public isFull(roomId: string, joiningUserId: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room) return false;
    const others = new Set(Array.from(room.participants.values()).filter((uid) => uid !== joiningUserId));
    for (const { userId } of room.disconnectedParticipants.values()) {
      if (userId !== joiningUserId) others.add(userId);
    }
    return others.size >= room.maxParticipants;
  }

  public async kickUser(roomId: string, targetUserId: string) {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    room.bannedUserIds.add(targetUserId);
    room.coHosts.delete(targetUserId);
    persist(roomId, "room ban", () => prisma.roomBan.upsert({
      where: { roomId_userId: { roomId, userId: targetUserId } },
      update: {},
      create: { roomId, userId: targetUserId },
    }));

    const socketIds = Array.from(room.participants.entries())
      .filter(([, uid]) => uid === targetUserId)
      .map(([sid]) => sid);
    for (const [discSocketId, data] of room.disconnectedParticipants.entries()) {
      if (data.userId === targetUserId) {
        clearTimeout(data.timeout);
        room.disconnectedParticipants.delete(discSocketId);
      }
    }
    for (const sid of socketIds) {
      room.participants.delete(sid);
      room.participantNames.delete(sid);
      room.participantAvatars.delete(sid);
      room.participantStatuses.delete(sid);
    }
    for (const sid of socketIds) {
      await this.permanentlyRemoveUser(roomId, targetUserId, sid);
    }
    try {
      await prisma.roomCoHost.deleteMany({ where: { roomId, userId: targetUserId } });
    } catch (err) {
      console.error("Failed to remove kicked co-host from DB", err);
    }
    return socketIds;
  }

  public async unbanUser(roomId: string, userId: string) {
    this.rooms.get(roomId)?.bannedUserIds.delete(userId);
    await prisma.roomBan.deleteMany({ where: { roomId, userId } });
  }

  public updateSettings(roomId: string, update: { maxParticipants?: number }) {
    const room = this.rooms.get(roomId);
    if (room && update.maxParticipants !== undefined) {
      room.maxParticipants = update.maxParticipants;
    }
  }

  public getQueue(roomId: string): QueueItem[] {
    return this.rooms.get(roomId)?.queue ?? [];
  }

  public addToQueue(roomId: string, item: QueueItem): boolean {
    const room = this.rooms.get(roomId);
    if (!room || room.queue.length >= MAX_QUEUE_LENGTH) return false;
    const position = (room.queue[room.queue.length - 1]?.position ?? 0) + 1;
    room.queue.push({ ...item, position });
    persist(roomId, "queue item", () => prisma.roomQueueItem.create({
      data: { id: item.id, roomId, url: item.url, addedById: item.addedBy, position },
    }));
    return true;
  }

  public removeFromQueue(roomId: string, itemId: string): QueueItem | undefined {
    const room = this.rooms.get(roomId);
    if (!room) return undefined;
    const index = room.queue.findIndex((q) => q.id === itemId);
    if (index === -1) return undefined;
    const [removed] = room.queue.splice(index, 1);
    persist(roomId, "queue removal", () => prisma.roomQueueItem.deleteMany({ where: { id: itemId } }));
    return removed;
  }

  public moveInQueue(roomId: string, itemId: string, direction: "up" | "down"): boolean {
    const room = this.rooms.get(roomId);
    if (!room) return false;
    const index = room.queue.findIndex((q) => q.id === itemId);
    const target = direction === "up" ? index - 1 : index + 1;
    if (index === -1 || target < 0 || target >= room.queue.length) return false;
    const a = room.queue[index];
    const b = room.queue[target];
    [a.position, b.position] = [b.position, a.position];
    room.queue[index] = b;
    room.queue[target] = a;
    persist(roomId, "queue order", () => prisma.$transaction([
      prisma.roomQueueItem.updateMany({ where: { id: a.id }, data: { position: a.position ?? 0 } }),
      prisma.roomQueueItem.updateMany({ where: { id: b.id }, data: { position: b.position ?? 0 } }),
    ]));
    return true;
  }

  /** Returns true when the update switched to a different video. */
  public updatePlayback(roomId: string, update: Partial<PlaybackState>): boolean {
    const room = this.rooms.get(roomId);
    if (!room) return false;
    const urlChanged = update.url !== undefined && update.url !== room.playback.url;
    room.playback = { ...room.playback, ...update, lastUpdatedAt: Date.now() };
    if (urlChanged) {
      // Per-video state doesn't carry over to the next video.
      room.subtitles = null;
      room.skipVotes.clear();
      room.participantSync.clear();
    }
    return urlChanged;
  }

  public getUserRoomId(userId: string): string | undefined {
    for (const [roomId, room] of this.rooms.entries()) {
      for (const uid of room.participants.values()) {
        if (uid === userId) return roomId;
      }
    }
    return undefined;
  }

  public distinctUserCount(roomId: string): number {
    const room = this.rooms.get(roomId);
    return room ? new Set(room.participants.values()).size : 0;
  }

  /** Majority of the people currently in the room. */
  public skipVotesNeeded(roomId: string): number {
    return Math.floor(this.distinctUserCount(roomId) / 2) + 1;
  }

  public getSkipState(roomId: string) {
    const room = this.rooms.get(roomId);
    // Drop votes from people who have left.
    const present = new Set(room ? room.participants.values() : []);
    const voters = room ? Array.from(room.skipVotes).filter((uid) => present.has(uid)) : [];
    return { count: voters.length, needed: this.skipVotesNeeded(roomId), voters };
  }

  public toggleSkipVote(roomId: string, userId: string) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    if (room.skipVotes.has(userId)) room.skipVotes.delete(userId);
    else room.skipVotes.add(userId);
  }

  public setSubtitles(roomId: string, subtitles: Subtitles | null) {
    const room = this.rooms.get(roomId);
    if (room) room.subtitles = subtitles;
  }

  public reportSync(roomId: string, socketId: string, report: { state: SyncState; drift: number }) {
    const room = this.rooms.get(roomId);
    if (!room || !room.participants.has(socketId)) return false;
    room.participantSync.set(socketId, report);
    return true;
  }

  public getSyncReports(roomId: string): Record<string, { state: SyncState; drift: number }> {
    const room = this.rooms.get(roomId);
    return room ? Object.fromEntries(room.participantSync.entries()) : {};
  }

  public updateParticipantStatus(roomId: string, socketId: string, cam: boolean, mic: boolean) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.participantStatuses.set(socketId, { cam, mic });
  }

  public getParticipantName(roomId: string, socketId: string): string | undefined {
    return this.rooms.get(roomId)?.participantNames.get(socketId);
  }

  public getParticipants(roomId: string): { socketId: string; userId: string; userName: string; avatarVersion: number | null }[] {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    return Array.from(room.participants.entries()).map(([socketId, userId]) => ({
      socketId,
      userId,
      userName: room.participantNames.get(socketId) ?? "Guest",
      avatarVersion: room.participantAvatars.get(socketId) ?? null,
    }));
  }

  public getParticipantStatuses(roomId: string): Record<string, { cam: boolean; mic: boolean }> {
    const room = this.rooms.get(roomId);
    if (!room) return {};
    return Object.fromEntries(room.participantStatuses.entries());
  }
}
