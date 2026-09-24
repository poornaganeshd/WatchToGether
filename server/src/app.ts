import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";
import authRoutes from "./routes/auth";
import roomRoutes from "./routes/room";
import friendRoutes from "./routes/friend";
import { setupSocketHandlers } from "./socket";
import { getAvatar } from "./controllers/auth";
import { getIceServers } from "./controllers/rtc";
import { authenticate } from "./middlewares/authMiddleware";
import { RoomManager } from "./managers/RoomManager";

export const createApp = (options: { gracePeriodMs?: number } = {}) => {
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
  app.get("/api/users/:id/avatar", getAvatar);
  app.get("/api/rtc/ice-servers", authenticate, getIceServers);

  app.get("/", (req, res) => {
    res.send("CineSync API");
  });

  const roomManager: RoomManager = setupSocketHandlers(io, options.gracePeriodMs);
  app.set("roomManager", roomManager);

  return { app, httpServer, io, roomManager };
};
