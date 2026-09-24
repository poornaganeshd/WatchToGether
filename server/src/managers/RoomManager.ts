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

interface RoomState {
  roomId: string;
  hostId: string;
  coHosts: Set<string>;
  participants: Map<string, string>; // socketId -> userId
  participantNames: Map<string, string>; // socketId -> display name
  participantStatuses: Map<string, { cam: boolean; mic: boolean }>;
  playback: PlaybackState;
  disconnectedParticipants: Map<string, { userId: string; timeout: NodeJS.Timeout }>;
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
          include: { coHosts: true },
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

  public async handleJoin(roomId: string, socketId: string, userId: string, userName: string) {
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

    room.participants.set(socketId, userId);
    room.participantNames.set(socketId, userName);

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
                playbackTime: room.playback.time,
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

  public updatePlayback(roomId: string, update: Partial<PlaybackState>) {
    const room = this.rooms.get(roomId);
    if (room) {
      room.playback = { ...room.playback, ...update, lastUpdatedAt: Date.now() };
    }
  }

  public updateParticipantStatus(roomId: string, socketId: string, cam: boolean, mic: boolean) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.participantStatuses.set(socketId, { cam, mic });
  }

  public getParticipantName(roomId: string, socketId: string): string | undefined {
    return this.rooms.get(roomId)?.participantNames.get(socketId);
  }

  public getParticipants(roomId: string): { socketId: string; userId: string; userName: string }[] {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    return Array.from(room.participants.entries()).map(([socketId, userId]) => ({
      socketId,
      userId,
      userName: room.participantNames.get(socketId) ?? "Guest",
    }));
  }

  public getParticipantStatuses(roomId: string): Record<string, { cam: boolean; mic: boolean }> {
    const room = this.rooms.get(roomId);
    if (!room) return {};
    return Object.fromEntries(room.participantStatuses.entries());
  }
}
