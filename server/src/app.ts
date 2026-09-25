import express from "express";
import { execSync } from "child_process";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";
import authRoutes from "./routes/auth";
import roomRoutes from "./routes/room";
import friendRoutes from "./routes/friend";
import inviteRoutes from "./routes/invites";
import { setupSocketHandlers } from "./socket";
import { getAvatar } from "./controllers/auth";
import { getIceServers } from "./controllers/rtc";
import { getPushConfig, subscribePush, unsubscribePush } from "./controllers/push";
import { authenticate, AuthRequest } from "./middlewares/authMiddleware";
import { rateLimit } from "./middlewares/rateLimit";
import { getYouTubeConfig, playlistYouTube, popularYouTube, searchYouTube } from "./controllers/youtube";
import { clearWatchHistory, deleteWatchHistoryItem, getWatchHistory } from "./controllers/watchHistory";
import { RoomManager } from "./managers/RoomManager";
import { createAdapter } from "@socket.io/redis-adapter";
import type { RedisClient } from "./infra/redis";

const STARTED_AT = new Date().toISOString();

let serverCommit: string | null = null;
const getServerCommit = () => (serverCommit ??= readServerCommit());

const readServerCommit = () => {
  const fromEnv =
    process.env.GIT_COMMIT || process.env.RENDER_GIT_COMMIT || process.env.RAILWAY_GIT_COMMIT_SHA || process.env.SOURCE_COMMIT || process.env.VERCEL_GIT_COMMIT_SHA;
  if (fromEnv) return fromEnv.slice(0, 7);
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || "unknown";
  } catch {
    return "unknown";
  }
};

export const createApp = (options: { gracePeriodMs?: number; redis?: { pub: RedisClient; sub: RedisClient } | null } = {}) => {
  const app = express();
  const httpServer = createServer(app);
  // Comma-separated list of allowed origins; defaults to allowing any origin.
  const allowedOrigins = process.env.CLIENT_URL
    ? process.env.CLIENT_URL.split(",").map((o) => o.trim().replace(/\/+$/, "")).filter(Boolean)
    : "*";

  const io = new Server(httpServer, {
    cors: {
      origin: allowedOrigins,
      methods: ["GET", "POST"]
    },
    // Room subtitle files are sent over the socket.
    maxHttpBufferSize: 2e6,
  });

  // With Redis, broadcasts (room events, notifications) reach sockets on every instance.
  if (options.redis) {
    io.adapter(createAdapter(options.redis.pub, options.redis.sub));
  }

  // Behind a reverse proxy (Render, Fly, nginx…) set TRUST_PROXY=1 so rate limits see real client IPs.
  if (process.env.TRUST_PROXY) {
    const hops = Number(process.env.TRUST_PROXY);
    app.set("trust proxy", Number.isNaN(hops) ? process.env.TRUST_PROXY : hops);
  }

  app.use(cors({ origin: allowedOrigins }));
  // Avatar uploads are sent as base64 JSON, hence the larger limit.
  app.use(express.json({ limit: "400kb" }));

  app.set("io", io);

  // Routes
  app.use("/api/auth", authRoutes);
  app.use("/api/rooms", roomRoutes);
  app.use("/api/friends", friendRoutes);
  app.use("/api/invites", inviteRoutes);
  app.get("/api/users/:id/avatar", getAvatar);
  app.get("/api/rtc/ice-servers", authenticate, getIceServers);
  app.get("/api/push/config", getPushConfig);
  app.get("/api/youtube/config", getYouTubeConfig);
  // Search spends shared API quota, so limit it per user.
  app.get(
    "/api/youtube/search",
    authenticate,
    rateLimit({ name: "yt-search", windowMs: 60 * 60 * 1000, max: 40, key: (req) => (req as AuthRequest).userId ?? null, message: "You've searched a lot this hour. Paste a link, or try again soon." }),
    searchYouTube
  );
  app.get("/api/youtube/popular", authenticate, popularYouTube);
  app.get("/api/youtube/playlist", authenticate, rateLimit({ name: "yt-playlist", windowMs: 60 * 60 * 1000, max: 60, key: (req) => (req as AuthRequest).userId ?? null }), playlistYouTube);
  app.get("/api/watch-history", authenticate, getWatchHistory);
  app.delete("/api/watch-history", authenticate, clearWatchHistory);
  app.delete("/api/watch-history/:id", authenticate, deleteWatchHistoryItem);
  app.post("/api/push/subscribe", authenticate, subscribePush);
  app.delete("/api/push/subscribe", authenticate, unsubscribePush);

  // Which build is running, to check a deploy actually went out.
  app.get("/api/health", (_req, res) => {
    res.status(200).json({ ok: true, commit: getServerCommit(), startedAt: STARTED_AT });
  });

  app.get("/", (req, res) => {
    res.send("CineSync API");
  });

  const roomManager: RoomManager = setupSocketHandlers(io, options.gracePeriodMs);
  app.set("roomManager", roomManager);

  return { app, httpServer, io, roomManager };
};
