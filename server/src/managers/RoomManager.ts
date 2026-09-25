import { PrismaClient } from "@prisma/client";
import { DEFAULT_PLAYBACK_URL, recordWatched } from "../services/watchHistory";
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
  recentlyPlayed: { url: string; playedAt: number }[];
  countdown: { endsAt: number; timer: NodeJS.Timeout } | null;
  poll: Poll | null;
  slowModeSeconds: number;
  mutedUntil: Map<string, number | null>; // userId -> expiry (null = until unmuted)
  lastMessageAt: Map<string, number>; // userId -> time of their last chat message
}

const MAX_RECENTLY_PLAYED = 20;

export interface Poll {
  id: string;
  question: string;
  options: string[];
  votes: Map<string, number>; // userId -> option index
  createdBy: string;
  createdByName: string;
  /** Options are links; the winner is added to the queue when the poll closes. */
  queueWinner: boolean;
  closesAt: number | null;
  closed: boolean;
  timer: NodeJS.Timeout | null;
}

export interface PollView {
  id: string;
  question: string;
  options: string[];
  counts: number[];
  totalVotes: number;
  createdByName: string;
  queueWinner: boolean;
  closesAt: number | null;
  closed: boolean;
  winner: number | null;
}

export interface ChatSettings {
  slowModeSeconds: number;
  muted: { userId: string; until: number | null }[];
}

export class RoomManager {
  private rooms: Map<string, RoomState> = new Map();
  private pendingRooms: Map<string, Promise<RoomState | null>> = new Map();
  private io: Server;
  public gracePeriodMs: number;
  /** Called whenever a room's live session is torn down. */
  public onRoomClosed: (roomId: string) => void = () => {};

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
          recentlyPlayed: [],
          countdown: null,
          poll: null,
          slowModeSeconds: 0,
          mutedUntil: new Map(),
          lastMessageAt: new Map(),
          playback: {
            playing: false,
            time: dbRoom.playbackTime ?? 0,
            url: dbRoom.playbackUrl ?? DEFAULT_PLAYBACK_URL,
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

  public getRoomIds(): string[] {
    return Array.from(this.rooms.keys());
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
      if (room.countdown) {
        clearTimeout(room.countdown.timer);
        room.countdown = null;
      }
      if (room.poll?.timer) clearTimeout(room.poll.timer);
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
      this.onRoomClosed(roomId);
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
      this.onRoomClosed(roomId);
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
      if (room.countdown) clearTimeout(room.countdown.timer);
      if (room.poll?.timer) clearTimeout(room.poll.timer);
      this.rooms.delete(roomId);
      this.onRoomClosed(roomId);
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
      if (room.playback.url) {
        // Everyone in the room now has this in their "Recently watched".
        void recordWatched([...room.participants.values()], room.playback.url, roomId);
        room.recentlyPlayed = [
          { url: room.playback.url, playedAt: Date.now() },
          ...room.recentlyPlayed.filter((r) => r.url !== room.playback.url),
        ].slice(0, MAX_RECENTLY_PLAYED);
      }
    }
    return urlChanged;
  }

  // --- Polls ---

  public viewPoll(roomId: string): PollView | null {
    const poll = this.rooms.get(roomId)?.poll;
    if (!poll) return null;
    const counts = poll.options.map(() => 0);
    for (const idx of poll.votes.values()) counts[idx]++;
    const max = Math.max(...counts);
    return {
      id: poll.id,
      question: poll.question,
      options: poll.options,
      counts,
      totalVotes: poll.votes.size,
      createdByName: poll.createdByName,
      queueWinner: poll.queueWinner,
      closesAt: poll.closesAt,
      closed: poll.closed,
      // Ties go to the earliest option; no votes means no winner.
      winner: poll.closed && max > 0 ? counts.indexOf(max) : null,
    };
  }

  public getPoll(roomId: string) {
    return this.rooms.get(roomId)?.poll ?? null;
  }

  public createPoll(roomId: string, poll: Omit<Poll, "votes" | "closed" | "timer">, onAutoClose: () => void): boolean {
    const room = this.rooms.get(roomId);
    if (!room || (room.poll && !room.poll.closed)) return false;
    if (room.poll?.timer) clearTimeout(room.poll.timer);
    const timer = poll.closesAt ? setTimeout(onAutoClose, poll.closesAt - Date.now()) : null;
    room.poll = { ...poll, votes: new Map(), closed: false, timer };
    return true;
  }

  public votePoll(roomId: string, pollId: string, userId: string, option: number): boolean {
    const poll = this.rooms.get(roomId)?.poll;
    if (!poll || poll.id !== pollId || poll.closed || option < 0 || option >= poll.options.length) return false;
    poll.votes.set(userId, option);
    return true;
  }

  /** Closes the poll and returns the winning option index (or null). */
  public closePoll(roomId: string, pollId: string): { winner: number | null } | null {
    const poll = this.rooms.get(roomId)?.poll;
    if (!poll || poll.id !== pollId || poll.closed) return null;
    poll.closed = true;
    if (poll.timer) clearTimeout(poll.timer);
    poll.timer = null;
    return { winner: this.viewPoll(roomId)!.winner };
  }

  public getUserVote(roomId: string, userId: string): number | null {
    return this.rooms.get(roomId)?.poll?.votes.get(userId) ?? null;
  }

  // --- Chat moderation ---

  public getChatSettings(roomId: string): ChatSettings {
    const room = this.rooms.get(roomId);
    if (!room) return { slowModeSeconds: 0, muted: [] };
    const now = Date.now();
    for (const [uid, until] of room.mutedUntil) if (until !== null && until <= now) room.mutedUntil.delete(uid);
    return {
      slowModeSeconds: room.slowModeSeconds,
      muted: Array.from(room.mutedUntil.entries()).map(([userId, until]) => ({ userId, until })),
    };
  }

  public setSlowMode(roomId: string, seconds: number) {
    const room = this.rooms.get(roomId);
    if (room) room.slowModeSeconds = seconds;
  }

  public setMuted(roomId: string, userId: string, until: number | null | undefined) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    if (until === undefined) room.mutedUntil.delete(userId);
    else room.mutedUntil.set(userId, until);
  }

  /** Why this user can't post right now, or null if they can. Records the post if allowed. */
  public checkCanChat(roomId: string, userId: string): string | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    if (room.mutedUntil.has(userId)) {
      const until = room.mutedUntil.get(userId)!;
      if (until === null || until > Date.now()) {
        return until === null ? "You've been muted by the host" : `You're muted for ${Math.ceil((until - Date.now()) / 60000)} more minute(s)`;
      }
      room.mutedUntil.delete(userId);
    }
    // Hosts and co-hosts aren't slowed down.
    if (room.slowModeSeconds > 0 && !this.isAuthorized(roomId, userId)) {
      const last = room.lastMessageAt.get(userId) ?? 0;
      const wait = Math.ceil((last + room.slowModeSeconds * 1000 - Date.now()) / 1000);
      if (wait > 0) return `Slow mode is on — wait ${wait}s before sending another message`;
    }
    room.lastMessageAt.set(userId, Date.now());
    return null;
  }

  public getRecentlyPlayed(roomId: string) {
    return this.rooms.get(roomId)?.recentlyPlayed ?? [];
  }

  public async removeCoHost(roomId: string, targetUserId: string): Promise<boolean> {
    const room = this.rooms.get(roomId);
    if (!room || !room.coHosts.has(targetUserId)) return false;
    room.coHosts.delete(targetUserId);
    try {
      await prisma.roomCoHost.deleteMany({ where: { roomId, userId: targetUserId } });
    } catch (err) {
      console.error("Failed to remove co-host from DB", err);
    }
    return true;
  }

  /** Starts a countdown that calls onDone when it ends. Returns false if one is already running. */
  public startCountdown(roomId: string, seconds: number, onDone: () => void): number | null {
    const room = this.rooms.get(roomId);
    if (!room || room.countdown) return null;
    const endsAt = Date.now() + seconds * 1000;
    const timer = setTimeout(() => {
      if (this.rooms.get(roomId)?.countdown?.timer === timer) {
        room.countdown = null;
        onDone();
      }
    }, seconds * 1000);
    room.countdown = { endsAt, timer };
    return endsAt;
  }

  public cancelCountdown(roomId: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room?.countdown) return false;
    clearTimeout(room.countdown.timer);
    room.countdown = null;
    return true;
  }

  public getCountdownEndsAt(roomId: string): number | null {
    return this.rooms.get(roomId)?.countdown?.endsAt ?? null;
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
