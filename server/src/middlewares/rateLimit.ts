import { Request, Response, NextFunction } from "express";
import { incrementWindow } from "../infra/counterStore";

interface RateLimitOptions {
  /** Stable, unique name: counters are shared across instances by name. */
  name: string;
  windowMs: number;
  max: number;
  /** Derives the bucket key; return null to skip limiting for this request. */
  key: (req: Request) => string | null;
  message?: string;
}

// Fixed-window limiter backed by the shared counter store (Redis when configured, so limits
// hold across API instances; process memory otherwise).
export const rateLimit = ({ name, windowMs, max, key, message }: RateLimitOptions) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const k = key(req);
    if (!k) return next();
    let bucket: { count: number; resetAt: number };
    try {
      bucket = await incrementWindow(`${name}:${k}`, windowMs);
    } catch (err) {
      // Fail open: a counter outage shouldn't take sign-in down with it.
      console.error("Rate limit store failed:", err);
      return next();
    }
    if (bucket.count > max) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - Date.now()) / 1000));
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({ error: message || `Too many attempts. Try again in ${Math.ceil(retryAfter / 60)} minute(s).` });
      return;
    }
    next();
  };
};

export const clientIp = (req: Request) => req.ip || req.socket.remoteAddress || "unknown";

export const emailKey = (req: Request) => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  return email ? `${clientIp(req)}|${email}` : null;
};
