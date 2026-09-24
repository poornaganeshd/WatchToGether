import { Response } from "express";
import crypto from "crypto";
import { AuthRequest } from "../middlewares/authMiddleware";

const STUN_FALLBACK = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }];
const TTL_SECONDS = 12 * 60 * 60;

/**
 * ICE servers for WebRTC. With TURN_SECRET set this issues short-lived credentials using the
 * TURN REST API scheme coturn supports (`use-auth-secret`), so no long-lived TURN password
 * ever reaches the browser. Static TURN_USERNAME/TURN_CREDENTIAL are supported too.
 */
export const getIceServers = (req: AuthRequest, res: Response): void => {
  const urls = (process.env.TURN_URLS || "").split(",").map((u) => u.trim()).filter(Boolean);
  const stunUrls = (process.env.STUN_URLS || "").split(",").map((u) => u.trim()).filter(Boolean);
  const stun = stunUrls.length ? [{ urls: stunUrls }] : STUN_FALLBACK;

  if (!urls.length) {
    res.status(200).json({ iceServers: stun, turn: false });
    return;
  }

  let username: string;
  let credential: string;
  if (process.env.TURN_SECRET) {
    username = `${Math.floor(Date.now() / 1000) + TTL_SECONDS}:${req.userId}`;
    credential = crypto.createHmac("sha1", process.env.TURN_SECRET).update(username).digest("base64");
  } else if (process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    username = process.env.TURN_USERNAME;
    credential = process.env.TURN_CREDENTIAL;
  } else {
    res.status(200).json({ iceServers: stun, turn: false });
    return;
  }

  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ iceServers: [...stun, { urls, username, credential }], turn: true, ttl: TTL_SECONDS });
};
