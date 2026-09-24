import { Server, Socket } from "socket.io";
import { PrismaClient } from "@prisma/client";
import jwt from "jsonwebtoken";
import { RoomManager } from "./managers/RoomManager";
import * as schemas from "./schemas/socketSchemas";
import { verifyRoomPassword } from "./utils/roomPassword";
import { randomUUID } from "crypto";

const prisma = new PrismaClient();

const CHAT_HISTORY_LIMIT = 50;

// Sliding-window limiter keyed by socket id.
const createLimiter = (max: number, windowMs: number) => {
  const hits = new Map<string, number[]>();
  return {
    allow(key: string) {
      const now = Date.now();
      const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
      if (recent.length >= max) {
        hits.set(key, recent);
        return false;
      }
      recent.push(now);
      hits.set(key, recent);
      return true;
    },
    forget(key: string) {
      hits.delete(key);
    },
  };
};

const chatLimiter = createLimiter(8, 5000);
const reactionLimiter = createLimiter(10, 3000);
const queueLimiter = createLimiter(5, 10000);

export const setupSocketHandlers = (io: Server, gracePeriodOrManager?: number | RoomManager) => {
  const roomManager =
    gracePeriodOrManager instanceof RoomManager
      ? gracePeriodOrManager
      : new RoomManager(io, typeof gracePeriodOrManager === "number" ? gracePeriodOrManager : 10000);

  // Authentication Middleware
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) {
      return next(new Error("Authentication error: No token provided"));
    }
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET as string) as { userId: string };
      socket.data.userId = decoded.userId;
      next();
    } catch (err) {
      next(new Error("Authentication error: Invalid token"));
    }
  });

  io.on("connection", (socket: Socket) => {
    const userId = socket.data.userId;
    console.log(`User connected: ${userId} (Socket: ${socket.id})`);

    socket.on("join_global_room", (data) => {
      const payload = schemas.validateSocketPayload(schemas.joinGlobalRoomSchema, data, socket);
      if (!payload) return;
      // Only allow subscribing to your own notification channel.
      if (payload.userId !== userId) {
        socket.emit("error", { message: "Unauthorized userId mismatch" });
        return;
      }
      socket.join(`user_${userId}`);
    });

    socket.on("join_room", async (data) => {
      try {
        const payload = schemas.validateSocketPayload(schemas.joinRoomSchema, data, socket);
        if (!payload) return;

        const { roomId, userName, password } = payload;

        // Ensure the user joins the room with their authenticated userId, not whatever they pass
        if (payload.userId !== userId) {
          socket.emit("error", { message: "Unauthorized userId mismatch" });
          return;
        }

        // Authoritative check
        const roomAuth = await prisma.room.findUnique({
          where: { id: roomId },
          select: { isPrivate: true, password: true, hostId: true }
        });

        if (!roomAuth) {
          socket.emit("error", { message: "Room not found" });
          return;
        }

        if (roomAuth.isPrivate && roomAuth.password && roomAuth.hostId !== userId) {
          // Co-hosts bypass the password, everyone else must supply it.
          const cohost = await prisma.roomCoHost.findUnique({
            where: { roomId_userId: { roomId, userId } }
          });

          if (!cohost) {
            if (!password) {
              socket.emit("error", { message: "Password required for private room" });
              return;
            }
            if (!(await verifyRoomPassword(roomAuth.password, password))) {
              socket.emit("error", { message: "Incorrect password" });
              return;
            }
          }
        }

        // Make sure the in-memory session exists so bans and capacity can be checked.
        await roomManager.getOrCreateRoom(roomId);
        if (roomManager.isBanned(roomId, userId)) {
          socket.emit("error", { message: "You were removed from this room by the host" });
          return;
        }
        if (roomAuth.hostId !== userId && roomManager.isFull(roomId, userId)) {
          socket.emit("error", { message: "Room is full" });
          return;
        }

        // Prefer the account name over whatever the client sent.
        const dbUser = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
        const displayName = dbUser?.name || userName;

        const success = await roomManager.handleJoin(roomId, socket.id, userId, displayName);
        if (!success) {
          socket.emit("error", { message: "Room not found" });
          return;
        }

        socket.join(roomId);
        console.log(`User ${displayName} (${userId}) joined room ${roomId} on socket ${socket.id}`);

        const room = roomManager.getRoom(roomId);

        // Send the current authoritative state to the joining user
        if (room) {
          socket.emit("sync_response", { ...room.playback, serverTime: Date.now() });
          socket.emit("room_state", { hostId: room.hostId, coHosts: Array.from(room.coHosts), startedAt: room.startedAt });
          socket.emit("queue_updated", room.queue);
          socket.emit("room_participant_statuses", roomManager.getParticipantStatuses(roomId));
          socket.emit("room_participants", roomManager.getParticipants(roomId));
        }

        // Broadcast to room that a user joined
        socket.to(roomId).emit("user_joined", { userId, userName: displayName, socketId: socket.id });

        try {
          const recent = await prisma.message.findMany({
            where: { roomId },
            orderBy: { createdAt: "desc" },
            take: CHAT_HISTORY_LIMIT,
            include: { user: { select: { name: true } } },
          });
          socket.emit(
            "chat_history",
            recent.reverse().map((m) => ({
              id: m.id,
              roomId: m.roomId,
              userId: m.userId,
              userName: m.user.name,
              content: m.content,
              createdAt: m.createdAt.toISOString(),
            }))
          );
        } catch (historyErr) {
          console.error("Failed to load chat history:", historyErr);
        }
      } catch (err) {
        console.error("Error in join_room:", err);
        socket.emit("error", { message: "Internal server error joining room" });
      }
    });

    socket.on("send_message", async (data) => {
      const payload = schemas.validateSocketPayload(schemas.sendMessageSchema, data, socket);
      if (!payload) return;

      const { roomId } = payload;
      const content = payload.content.trim();
      if (payload.userId !== userId || !content) return; // Ignore spoofed or blank

      const senderRoomId = roomManager.getSocketRoomId(socket.id);
      if (senderRoomId !== roomId) return;

      if (!chatLimiter.allow(socket.id)) {
        socket.emit("chat_rate_limited", { message: "You're sending messages too quickly" });
        return;
      }

      const userName = roomManager.getParticipantName(roomId, socket.id) || payload.userName;
      let id = `${Date.now()}-${socket.id}`;
      let createdAt = new Date().toISOString();

      try {
        const saved = await prisma.message.create({
          data: { content, userId, roomId }
        });
        id = saved.id;
        createdAt = saved.createdAt.toISOString();
      } catch (err) {
        console.error("Error saving message:", err);
      }

      // React renders this as text, so no HTML escaping is needed here.
      io.to(roomId).emit("receive_message", { id, roomId, userId, userName, content, createdAt });
    });

    socket.on("send_reaction", (data) => {
      const p = schemas.validateSocketPayload(schemas.reactionSchema, data, socket);
      if (!p) return;
      const senderRoomId = roomManager.getSocketRoomId(socket.id);
      if (senderRoomId !== p.roomId) return;
      if (!reactionLimiter.allow(socket.id)) return;
      io.to(senderRoomId).emit("reaction", {
        socketId: socket.id,
        userId,
        userName: roomManager.getParticipantName(senderRoomId, socket.id) || "Someone",
        emoji: p.emoji,
      });
    });

    socket.on("leave_room", async (data, callback?: () => void) => {
      const payload = schemas.validateSocketPayload(schemas.joinRoomSchema, data, socket);
      if (!payload) return;
      if (payload.userId !== userId) return;

      socket.leave(payload.roomId);
      await roomManager.handleLeave(payload.roomId, socket.id, userId);
      if (typeof callback === "function") {
        callback();
      }
    });

    // --- HOST/CO-HOST PRIVILEGED EVENTS ---

    socket.on("play_video", (data) => {
      const payload = schemas.validateSocketPayload(schemas.roomTimeSchema, data, socket);
      if (!payload) return;
      const senderRoomId = roomManager.getSocketRoomId(socket.id);
      if (senderRoomId !== payload.roomId) return;
      if (!roomManager.isAuthorized(senderRoomId, userId)) return;

      roomManager.updatePlayback(senderRoomId, { playing: true, time: payload.time });
      socket.to(senderRoomId).emit("play_video", { time: payload.time, serverTime: Date.now() });
    });

    socket.on("pause_video", (data) => {
      const payload = schemas.validateSocketPayload(schemas.roomTimeSchema, data, socket);
      if (!payload) return;
      const senderRoomId = roomManager.getSocketRoomId(socket.id);
      if (senderRoomId !== payload.roomId) return;
      if (!roomManager.isAuthorized(senderRoomId, userId)) return;

      roomManager.updatePlayback(senderRoomId, { playing: false, time: payload.time });
      socket.to(senderRoomId).emit("pause_video", { time: payload.time, serverTime: Date.now() });
    });

    socket.on("seek_video", (data) => {
      const payload = schemas.validateSocketPayload(schemas.roomTimeSchema, data, socket);
      if (!payload) return;
      const senderRoomId = roomManager.getSocketRoomId(socket.id);
      if (senderRoomId !== payload.roomId) return;
      if (!roomManager.isAuthorized(senderRoomId, userId)) return;

      roomManager.updatePlayback(senderRoomId, { time: payload.time });
      socket.to(senderRoomId).emit("seek_video", { time: payload.time, serverTime: Date.now() });
    });

    socket.on("sync_time", (data) => {
      const payload = schemas.validateSocketPayload(schemas.syncTimeSchema, data, socket);
      if (!payload) return;
      const senderRoomId = roomManager.getSocketRoomId(socket.id);
      if (senderRoomId !== payload.roomId) return;
      if (!roomManager.isAuthorized(senderRoomId, userId)) return;

      roomManager.updatePlayback(senderRoomId, {
        time: payload.time,
        ...(payload.playing !== undefined ? { playing: payload.playing } : {}),
      });
      const room = roomManager.getRoom(senderRoomId);
      if (room) {
        socket.to(senderRoomId).emit("sync_response", { ...room.playback, serverTime: Date.now() });
      }
    });

    socket.on("change_video", (data) => {
      const payload = schemas.validateSocketPayload(schemas.changeVideoSchema, data, socket);
      if (!payload) return;
      const senderRoomId = roomManager.getSocketRoomId(socket.id);
      if (senderRoomId !== payload.roomId) return;
      if (!roomManager.isAuthorized(senderRoomId, userId)) return;

      roomManager.updatePlayback(senderRoomId, { url: payload.url, time: 0 });
      socket.to(senderRoomId).emit("change_video", { url: payload.url });
    });

    socket.on("request_sync", (data) => {
      const payload = schemas.validateSocketPayload(schemas.roomOnlySchema, data, socket);
      if (!payload) return;
      const senderRoomId = roomManager.getSocketRoomId(socket.id);
      if (senderRoomId !== payload.roomId) return;
      
      const room = roomManager.getRoom(senderRoomId);
      if (room) {
        socket.emit("sync_response", { ...room.playback, serverTime: Date.now() });
      }
    });

    socket.on("make_cohost", async (data) => {
      const payload = schemas.validateSocketPayload(schemas.makeCohostSchema, data, socket);
      if (!payload) return;
      const senderRoomId = roomManager.getSocketRoomId(socket.id);
      if (senderRoomId !== payload.roomId) return;
      
      const room = roomManager.getRoom(senderRoomId);
      if (!room) return;
      
      // ONLY the HOST can make someone a co-host
      if (room.hostId !== userId) {
        socket.emit("error", { message: "Only the host can assign co-hosts" });
        return;
      }
      
      // The target must actually be in this room; otherwise anyone could be promoted.
      const targetUserId = room.participants.get(payload.targetSocketId);
      if (!targetUserId || targetUserId === room.hostId) return;

      const success = await roomManager.makeCoHost(senderRoomId, targetUserId);
      if (success) {
        io.to(senderRoomId).emit("new_cohost", { userId: targetUserId });
      }
    });

    socket.on("kick_participant", async (data) => {
      const payload = schemas.validateSocketPayload(schemas.targetSocketSchema, data, socket);
      if (!payload) return;
      const senderRoomId = roomManager.getSocketRoomId(socket.id);
      if (senderRoomId !== payload.roomId) return;
      const room = roomManager.getRoom(senderRoomId);
      if (!room || !roomManager.isAuthorized(senderRoomId, userId)) return;

      const targetUserId = room.participants.get(payload.targetSocketId);
      if (!targetUserId || targetUserId === userId || targetUserId === room.hostId) return;
      // Co-hosts can remove viewers, but only the host can remove another co-host.
      if (room.coHosts.has(targetUserId) && room.hostId !== userId) {
        socket.emit("error", { message: "Only the host can remove a co-host" });
        return;
      }

      const targetName = room.participantNames.get(payload.targetSocketId) || "A participant";
      const socketIds = await roomManager.kickUser(senderRoomId, targetUserId);
      for (const sid of socketIds) {
        const target = io.sockets.sockets.get(sid);
        target?.emit("kicked", { roomId: senderRoomId });
        target?.leave(senderRoomId);
      }
      io.to(senderRoomId).emit("participant_kicked", { userId: targetUserId, userName: targetName });
      io.to(senderRoomId).emit("room_state", { hostId: room.hostId, coHosts: Array.from(room.coHosts), startedAt: room.startedAt });
    });

    socket.on("typing", (data) => {
      const p = schemas.validateSocketPayload(schemas.typingSchema, data, socket);
      if (!p) return;
      const senderRoomId = roomManager.getSocketRoomId(socket.id);
      if (senderRoomId !== p.roomId) return;
      socket.to(senderRoomId).emit("user_typing", {
        socketId: socket.id,
        userId,
        userName: roomManager.getParticipantName(senderRoomId, socket.id) || "Someone",
        isTyping: p.isTyping,
      });
    });

    // --- WATCH QUEUE ---
    // Anyone can suggest a video; hosts and co-hosts (or whoever added an item) manage it.

    const broadcastQueue = (roomId: string) => {
      io.to(roomId).emit("queue_updated", roomManager.getQueue(roomId));
    };

    const playUrlForRoom = (roomId: string, url: string) => {
      roomManager.updatePlayback(roomId, { url, time: 0, playing: true });
      io.to(roomId).emit("change_video", { url });
      io.to(roomId).emit("play_video", { time: 0, serverTime: Date.now() });
    };

    socket.on("queue_add", (data) => {
      const p = schemas.validateSocketPayload(schemas.queueAddSchema, data, socket);
      if (!p) return;
      const senderRoomId = roomManager.getSocketRoomId(socket.id);
      if (senderRoomId !== p.roomId) return;
      if (!queueLimiter.allow(socket.id)) {
        socket.emit("error", { message: "You're adding videos too quickly" });
        return;
      }
      const added = roomManager.addToQueue(senderRoomId, {
        id: randomUUID(),
        url: p.url,
        addedBy: userId,
        addedByName: roomManager.getParticipantName(senderRoomId, socket.id) || "Someone",
      });
      if (!added) {
        socket.emit("error", { message: "The queue is full" });
        return;
      }
      broadcastQueue(senderRoomId);
    });

    socket.on("queue_remove", (data) => {
      const p = schemas.validateSocketPayload(schemas.queueItemSchema, data, socket);
      if (!p) return;
      const senderRoomId = roomManager.getSocketRoomId(socket.id);
      if (senderRoomId !== p.roomId) return;
      const item = roomManager.getQueue(senderRoomId).find((q) => q.id === p.itemId);
      if (!item) return;
      if (item.addedBy !== userId && !roomManager.isAuthorized(senderRoomId, userId)) return;
      roomManager.removeFromQueue(senderRoomId, p.itemId);
      broadcastQueue(senderRoomId);
    });

    socket.on("queue_move", (data) => {
      const p = schemas.validateSocketPayload(schemas.queueMoveSchema, data, socket);
      if (!p) return;
      const senderRoomId = roomManager.getSocketRoomId(socket.id);
      if (senderRoomId !== p.roomId || !roomManager.isAuthorized(senderRoomId, userId)) return;
      if (roomManager.moveInQueue(senderRoomId, p.itemId, p.direction)) {
        broadcastQueue(senderRoomId);
      }
    });

    socket.on("queue_play", (data) => {
      const p = schemas.validateSocketPayload(schemas.queueItemSchema, data, socket);
      if (!p) return;
      const senderRoomId = roomManager.getSocketRoomId(socket.id);
      if (senderRoomId !== p.roomId || !roomManager.isAuthorized(senderRoomId, userId)) return;
      const item = roomManager.removeFromQueue(senderRoomId, p.itemId);
      if (!item) return;
      playUrlForRoom(senderRoomId, item.url);
      broadcastQueue(senderRoomId);
    });

    // Sent by the host's player when a video finishes.
    socket.on("queue_next", (data) => {
      const p = schemas.validateSocketPayload(schemas.roomOnlySchema, data, socket);
      if (!p) return;
      const senderRoomId = roomManager.getSocketRoomId(socket.id);
      if (senderRoomId !== p.roomId || !roomManager.isAuthorized(senderRoomId, userId)) return;
      const next = roomManager.getQueue(senderRoomId)[0];
      if (!next) return;
      roomManager.removeFromQueue(senderRoomId, next.id);
      playUrlForRoom(senderRoomId, next.url);
      broadcastQueue(senderRoomId);
    });

    // --- WEBRTC SIGNALING ---
    
    socket.on("webrtc_offer", (data) => {
      const p = schemas.validateSocketPayload(schemas.webrtcOfferAnswerSchema, data, socket);
      if (!p) return;
      const senderRoomId = roomManager.getSocketRoomId(socket.id);
      const targetRoomId = roomManager.getSocketRoomId(p.to);
      if (!senderRoomId || senderRoomId !== targetRoomId) {
        socket.emit("error", { message: "Unauthorized cross-room signaling" });
        return;
      }
      socket.to(p.to).emit("webrtc_offer", { offer: p.offer, from: socket.id });
    });

    socket.on("webrtc_answer", (data) => {
      const p = schemas.validateSocketPayload(schemas.webrtcOfferAnswerSchema, data, socket);
      if (!p) return;
      const senderRoomId = roomManager.getSocketRoomId(socket.id);
      const targetRoomId = roomManager.getSocketRoomId(p.to);
      if (!senderRoomId || senderRoomId !== targetRoomId) return;
      socket.to(p.to).emit("webrtc_answer", { answer: p.answer, from: socket.id });
    });

    socket.on("webrtc_ice_candidate", (data) => {
      const p = schemas.validateSocketPayload(schemas.webrtcCandidateSchema, data, socket);
      if (!p) return;
      const senderRoomId = roomManager.getSocketRoomId(socket.id);
      const targetRoomId = roomManager.getSocketRoomId(p.to);
      if (!senderRoomId || senderRoomId !== targetRoomId) return;
      socket.to(p.to).emit("webrtc_ice_candidate", { candidate: p.candidate, from: socket.id });
    });

    // --- AUDIO PRIORITIZATION & SCREEN SHARE ---

    socket.on("started_speaking", (data) => {
      const p = schemas.validateSocketPayload(schemas.roomOnlySchema, data, socket);
      if (!p) return;
      const senderRoomId = roomManager.getSocketRoomId(socket.id);
      if (senderRoomId !== p.roomId) return;
      socket.to(senderRoomId).emit("user_speaking", { socketId: socket.id });
    });

    socket.on("stopped_speaking", (data) => {
      const p = schemas.validateSocketPayload(schemas.roomOnlySchema, data, socket);
      if (!p) return;
      const senderRoomId = roomManager.getSocketRoomId(socket.id);
      if (senderRoomId !== p.roomId) return;
      socket.to(senderRoomId).emit("user_stopped_speaking", { socketId: socket.id });
    });

    socket.on("host_announcement_start", (data) => {
      const p = schemas.validateSocketPayload(schemas.roomOnlySchema, data, socket);
      if (!p) return;
      const senderRoomId = roomManager.getSocketRoomId(socket.id);
      if (senderRoomId !== p.roomId) return;
      if (roomManager.isAuthorized(senderRoomId, userId)) {
        socket.to(senderRoomId).emit("host_announcement_start", { socketId: socket.id });
      }
    });

    socket.on("host_announcement_stop", (data) => {
      const p = schemas.validateSocketPayload(schemas.roomOnlySchema, data, socket);
      if (!p) return;
      const senderRoomId = roomManager.getSocketRoomId(socket.id);
      if (senderRoomId !== p.roomId) return;
      if (roomManager.isAuthorized(senderRoomId, userId)) {
        socket.to(senderRoomId).emit("host_announcement_stop", { socketId: socket.id });
      }
    });

    socket.on("participant_status", (data) => {
      const p = schemas.validateSocketPayload(schemas.participantStatusSchema, data, socket);
      if (!p) return;
      const senderRoomId = roomManager.getSocketRoomId(socket.id);
      if (senderRoomId !== p.roomId) return;
      roomManager.updateParticipantStatus(senderRoomId, socket.id, p.cam, p.mic);
      socket.to(senderRoomId).emit("participant_status", { socketId: socket.id, cam: p.cam, mic: p.mic });
    });

    socket.on("screen_share_start", (data) => {
      const p = schemas.validateSocketPayload(schemas.screenShareStartSchema, data, socket);
      if (!p) return;
      const senderRoomId = roomManager.getSocketRoomId(socket.id);
      if (!senderRoomId || senderRoomId !== p.roomId) {
        socket.emit("error", { message: "Unauthorized screen share" });
        return;
      }
      socket.to(senderRoomId).emit("screen_share_start", { socketId: socket.id, streamId: p.streamId });
    });

    socket.on("screen_share_stop", (data) => {
      const p = schemas.validateSocketPayload(schemas.roomOnlySchema, data, socket);
      if (!p) return;
      const senderRoomId = roomManager.getSocketRoomId(socket.id);
      if (senderRoomId !== p.roomId) return;
      socket.to(senderRoomId).emit("screen_share_stop", { socketId: socket.id });
    });

    socket.on("disconnect", () => {
      console.log("User disconnected:", socket.id);
      chatLimiter.forget(socket.id);
      reactionLimiter.forget(socket.id);
      queueLimiter.forget(socket.id);
      roomManager.handleDisconnect(socket.id);
    });
  });
  return roomManager;
};
