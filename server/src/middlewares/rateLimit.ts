import { Request, Response, NextFunction } from "express";

interface RateLimitOptions {
  windowMs: number;
  max: number;
  /** Derives the bucket key; return null to skip limiting for this request. */
  key: (req: Request) => string | null;
  message?: string;
}

// Fixed-window, in-memory limiter. Good enough for a single server instance; use a shared
// store (e.g. Redis) if the API is scaled horizontally.
export const rateLimit = ({ windowMs, max, key, message }: RateLimitOptions) => {
  const buckets = new Map<string, { count: number; resetAt: number }>();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  }, Math.min(windowMs, 60_000));
  sweep.unref();

  return (req: Request, res: Response, next: NextFunction): void => {
    const k = key(req);
    if (!k) return next();
    const now = Date.now();
    let bucket = buckets.get(k);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(k, bucket);
    }
    bucket.count++;
    if (bucket.count > max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
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
