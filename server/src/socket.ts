import { Server, Socket } from "socket.io";
import { PrismaClient } from "@prisma/client";
import { verifyAuthToken } from "./middlewares/authMiddleware";
import { RoomManager } from "./managers/RoomManager";
import * as schemas from "./schemas/socketSchemas";
import { verifyRoomPassword } from "./utils/roomPassword";
import { randomUUID } from "crypto";
import { presence } from "./managers/PresenceManager";

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
const syncReportLimiter = createLimiter(20, 10000);
const voteLimiter = createLimiter(10, 10000);

const MAX_SUBTITLE_CHARS = 350_000;

// Counts only failed room-password attempts, so correct passwords are never throttled.
const failedJoins = (() => {
  const WINDOW_MS = 15 * 60 * 1000;
  const MAX_FAILURES = 10;
  const failures = new Map<string, { count: number; resetAt: number }>();
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of failures) if (entry.resetAt <= now) failures.delete(key);
  }, 60_000).unref();
  return {
    isBlocked(key: string) {
      const entry = failures.get(key);
      if (!entry) return false;
      if (entry.resetAt <= Date.now()) {
        failures.delete(key);
        return false;
      }
      return entry.count >= MAX_FAILURES;
    },
    recordFailure(key: string) {
      const now = Date.now();
      const entry = failures.get(key);
      if (!entry || entry.resetAt <= now) failures.set(key, { count: 1, resetAt: now + WINDOW_MS });
      else entry.count++;
    },
    clear(key: string) {
      failures.delete(key);
    },
  };
})();

/** Disconnects every socket belonging to a user (e.g. after their password changed). */
export const disconnectUserSockets = (io: Server | undefined, userId: string, keepSocketId?: string) => {
  if (!io) return;
  for (const s of io.sockets.sockets.values()) {
    if (s.data.userId === userId && s.id !== keepSocketId) s.disconnect(true);
  }
};

/** Tells a user's accepted friends to refresh their presence view. */
const notifyFriendsOfPresence = async (io: Server, userId: string) => {
  try {
    const links = await prisma.friend.findMany({
      where: { status: "ACCEPTED", OR: [{ userId }, { friendId: userId }] },
      select: { userId: true, friendId: true },
    });
    for (const link of links) {
      const friendId = link.userId === userId ? link.friendId : link.userId;
      io.to(`user_${friendId}`).emit("presence_changed", { userId });
    }
  } catch (err) {
    console.error("Failed to notify friends of presence:", err);
  }
};
const reactionLimiter = createLimiter(10, 3000);
const queueLimiter = createLimiter(5, 10000);

export const setupSocketHandlers = (io: Server, gracePeriodOrManager?: number | RoomManager) => {
  const roomManager =
    gracePeriodOrManager instanceof RoomManager
      ? gracePeriodOrManager
      : new RoomManager(io, typeof gracePeriodOrManager === "number" ? gracePeriodOrManager : 10000);

  // Authentication Middleware
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) {
      return next(new Error("Authentication error: No token provided"));
    }
    const userId = await verifyAuthToken(token);
    if (!userId) {
      return next(new Error("Authentication error: Invalid token"));
    }
    socket.data.userId = userId;
    next();
  });

  io.on("connection", (socket: Socket) => {
    const userId = socket.data.userId;
    console.log(`User connected: ${userId} (Socket: ${socket.id})`);
    if (presence.add(userId, socket.id)) {
      notifyFriendsOfPresence(io, userId);
    }

    // Broadcasts per-video state that resets when the video changes.
    const emitVideoScopedState = (roomId: string) => {
      const room = roomManager.getRoom(roomId);
      io.to(roomId).emit("subtitles_updated", room?.subtitles ?? null);
      io.to(roomId).emit("skip_votes", roomManager.getSkipState(roomId));
      io.to(roomId).emit("recently_played", roomManager.getRecentlyPlayed(roomId));
      // A new video makes any pending countdown meaningless.
      if (roomManager.cancelCountdown(roomId)) io.to(roomId).emit("countdown", null);
    };

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
            const attemptKey = `${userId}|${roomId}`;
            if (failedJoins.isBlocked(attemptKey)) {
              socket.emit("error", { message: "Too many password attempts. Try again in a few minutes." });
              return;
            }
            if (!(await verifyRoomPassword(roomAuth.password, password))) {
              failedJoins.recordFailure(attemptKey);
              socket.emit("error", { message: "Incorrect password" });
              return;
            }
            failedJoins.clear(attemptKey);
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
        const dbUser = await prisma.user.findUnique({ where: { id: userId }, select: { name: true, avatarUpdatedAt: true } });
        const avatarVersion = dbUser?.avatarUpdatedAt?.getTime() ?? null;
        const displayName = dbUser?.name || userName;

        // A socket belongs to one room at a time; leave any other room it is still in.
        const previousRoomId = roomManager.getSocketRoomId(socket.id);
        if (previousRoomId && previousRoomId !== roomId) {
          socket.leave(previousRoomId);
          await roomManager.handleLeave(previousRoomId, socket.id, userId);
        }

        const success = await roomManager.handleJoin(roomId, socket.id, userId, displayName, avatarVersion);
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
          socket.emit("subtitles_updated", room.subtitles);
          socket.emit("viewer_sync_all", roomManager.getSyncReports(roomId));
          socket.emit("recently_played", room.recentlyPlayed);
          const countdownEndsAt = roomManager.getCountdownEndsAt(roomId);
          if (countdownEndsAt) socket.emit("countdown", { endsAt: countdownEndsAt, serverTime: Date.now() });
          socket.emit("room_participant_statuses", roomManager.getParticipantStatuses(roomId));
          socket.emit("room_participants", roomManager.getParticipants(roomId));
        }

        // Broadcast to room that a user joined
        socket.to(roomId).emit("user_joined", { userId, userName: displayName, socketId: socket.id, avatarVersion });
        // The skip threshold depends on how many people are here.
        io.to(roomId).emit("skip_votes", roomManager.getSkipState(roomId));
        notifyFriendsOfPresence(io, userId);

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
      if (roomManager.getRoom(payload.roomId)) {
        io.to(payload.roomId).emit("skip_votes", roomManager.getSkipState(payload.roomId));
      }
      notifyFriendsOfPresence(io, userId);
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

      const changed = roomManager.updatePlayback(senderRoomId, { url: payload.url, time: 0 });
      socket.to(senderRoomId).emit("change_video", { url: payload.url });
      if (changed) emitVideoScopedState(senderRoomId);
    });

    // --- COUNTDOWN START ---
    // Pauses everyone at the current position, counts down, then starts playback for all at once.
    socket.on("start_countdown", (data) => {
      const p = schemas.validateSocketPayload(schemas.countdownSchema, data, socket);
      if (!p) return;
      const senderRoomId = roomManager.getSocketRoomId(socket.id);
      if (senderRoomId !== p.roomId || !roomManager.isAuthorized(senderRoomId, userId)) return;
      const room = roomManager.getRoom(senderRoomId);
      if (!room || !room.playback.url) {
        socket.emit("error", { message: "Pick a video before starting a countdown" });
        return;
      }

      const startAt = roomManager.getCurrentPlaybackTime(room.playback);
      const endsAt = roomManager.startCountdown(senderRoomId, p.seconds, () => {
        roomManager.updatePlayback(senderRoomId, { playing: true, time: startAt });
        io.to(senderRoomId).emit("countdown", null);
        io.to(senderRoomId).emit("play_video", { time: startAt, serverTime: Date.now() });
      });
      if (!endsAt) {
        socket.emit("error", { message: "A countdown is already running" });
        return;
      }
      roomManager.updatePlayback(senderRoomId, { playing: false, time: startAt });
      io.to(senderRoomId).emit("pause_video", { time: startAt, serverTime: Date.now() });
      io.to(senderRoomId).emit("countdown", { endsAt, serverTime: Date.now() });
    });

    socket.on("cancel_countdown", (data) => {
      const p = schemas.validateSocketPayload(schemas.roomOnlySchema, data, socket);
      if (!p) return;
      const senderRoomId = roomManager.getSocketRoomId(socket.id);
      if (senderRoomId !== p.roomId || !roomManager.isAuthorized(senderRoomId, userId)) return;
      if (roomManager.cancelCountdown(senderRoomId)) io.to(senderRoomId).emit("countdown", null);
    });

    // --- MODERATION ---
    socket.on("delete_message", async (data) => {
      const p = schemas.validateSocketPayload(schemas.deleteMessageSchema, data, socket);
      if (!p) return;
      const senderRoomId = roomManager.getSocketRoomId(socket.id);
      if (senderRoomId !== p.roomId) return;
      try {
        const message = await prisma.message.findUnique({ where: { id: p.messageId }, select: { roomId: true, userId: true } });
        if (!message || message.roomId !== senderRoomId) return;
        // Authors can delete their own messages; hosts and co-hosts can delete anyone's.
        if (message.userId !== userId && !roomManager.isAuthorized(senderRoomId, userId)) return;
        await prisma.message.delete({ where: { id: p.messageId } });
        io.to(senderRoomId).emit("message_deleted", { id: p.messageId });
      } catch (err) {
        console.error("Failed to delete message:", err);
      }
    });

    socket.on("remove_cohost", async (data) => {
      const p = schemas.validateSocketPayload(schemas.targetUserSchema, data, socket);
      if (!p) return;
      const senderRoomId = roomManager.getSocketRoomId(socket.id);
      if (senderRoomId !== p.roomId) return;
      const room = roomManager.getRoom(senderRoomId);
      if (!room) return;
      // Co-hosts may step down themselves; only the host can demote someone else.
      if (room.hostId !== userId && p.targetUserId !== userId) {
        socket.emit("error", { message: "Only the host can remove a co-host" });
        return;
      }
      if (await roomManager.removeCoHost(senderRoomId, p.targetUserId)) {
        io.to(senderRoomId).emit("cohost_removed", { userId: p.targetUserId });
        io.to(senderRoomId).emit("room_state", { hostId: room.hostId, coHosts: Array.from(room.coHosts), startedAt: room.startedAt });
      }
    });

    // --- VOTE TO SKIP ---
    socket.on("vote_skip", (data) => {
      const p = schemas.validateSocketPayload(schemas.roomOnlySchema, data, socket);
      if (!p) return;
      const senderRoomId = roomManager.getSocketRoomId(socket.id);
      if (senderRoomId !== p.roomId || !voteLimiter.allow(socket.id)) return;
      const next = roomManager.getQueue(senderRoomId)[0];
      if (!next) {
        socket.emit("error", { message: "Nothing is queued to skip to" });
        return;
      }
      roomManager.toggleSkipVote(senderRoomId, userId);
      const state = roomManager.getSkipState(senderRoomId);
      if (state.count >= state.needed) {
        roomManager.removeFromQueue(senderRoomId, next.id);
        io.to(senderRoomId).emit("skip_passed", { count: state.count });
        playUrlForRoom(senderRoomId, next.url);
        io.to(senderRoomId).emit("queue_updated", roomManager.getQueue(senderRoomId));
      } else {
        io.to(senderRoomId).emit("skip_votes", state);
      }
    });

    // --- SUBTITLES ---
    socket.on("subtitles_set", (data) => {
      const p = schemas.validateSocketPayload(schemas.subtitlesSchema, data, socket);
      if (!p) return;
      const senderRoomId = roomManager.getSocketRoomId(socket.id);
      if (senderRoomId !== p.roomId || !roomManager.isAuthorized(senderRoomId, userId)) return;
      if (p.vtt.length > MAX_SUBTITLE_CHARS) {
        socket.emit("error", { message: "Subtitle file is too large" });
        return;
      }
      roomManager.setSubtitles(senderRoomId, { label: p.label, vtt: p.vtt });
      io.to(senderRoomId).emit("subtitles_updated", { label: p.label, vtt: p.vtt });
    });

    socket.on("subtitles_clear", (data) => {
      const p = schemas.validateSocketPayload(schemas.roomOnlySchema, data, socket);
      if (!p) return;
      const senderRoomId = roomManager.getSocketRoomId(socket.id);
      if (senderRoomId !== p.roomId || !roomManager.isAuthorized(senderRoomId, userId)) return;
      roomManager.setSubtitles(senderRoomId, null);
      io.to(senderRoomId).emit("subtitles_updated", null);
    });

    // --- VIEWER SYNC STATUS ---
    socket.on("playback_report", (data) => {
      const p = schemas.validateSocketPayload(schemas.playbackReportSchema, data, socket);
      if (!p) return;
      const senderRoomId = roomManager.getSocketRoomId(socket.id);
      if (senderRoomId !== p.roomId || !syncReportLimiter.allow(socket.id)) return;
      const report = { state: p.state, drift: Math.round(p.drift * 10) / 10 };
      if (roomManager.reportSync(senderRoomId, socket.id, report)) {
        socket.to(senderRoomId).emit("viewer_sync", { socketId: socket.id, ...report });
      }
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

    function playUrlForRoom(roomId: string, url: string) {
      roomManager.updatePlayback(roomId, { url, time: 0, playing: true });
      io.to(roomId).emit("change_video", { url });
      io.to(roomId).emit("play_video", { time: 0, serverTime: Date.now() });
      emitVideoScopedState(roomId);
    }

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
      syncReportLimiter.forget(socket.id);
      voteLimiter.forget(socket.id);
      if (presence.remove(userId, socket.id)) {
        notifyFriendsOfPresence(io, userId);
      }
      reactionLimiter.forget(socket.id);
      queueLimiter.forget(socket.id);
      roomManager.handleDisconnect(socket.id);
    });
  });
  return roomManager;
};
