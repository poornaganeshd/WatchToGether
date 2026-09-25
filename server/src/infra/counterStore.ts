import { getRedis } from "./redis";

/**
 * Fixed-window counters shared by rate limiters. Uses Redis when configured so limits hold
 * across API instances, otherwise process memory.
 */
const memory = new Map<string, { count: number; resetAt: number }>();

const sweep = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of memory) if (v.resetAt <= now) memory.delete(k);
}, 60_000);
sweep.unref();

/** Increments the counter for key in a window; returns the new count and when it resets. */
export const incrementWindow = async (key: string, windowMs: number): Promise<{ count: number; resetAt: number }> => {
  const redis = getRedis();
  if (redis) {
    const k = `rl:${key}`;
    // NX: only the first hit in a window sets the expiry (needs Redis 7+).
    const [count, , ttl] = (await redis.multi().incr(k).pExpire(k, windowMs, "NX").pTTL(k).exec()) as unknown as [number, unknown, number];
    return { count, resetAt: Date.now() + Math.max(0, ttl) };
  }
  const now = Date.now();
  let entry = memory.get(key);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + windowMs };
    memory.set(key, entry);
  }
  entry.count++;
  return { ...entry };
};

/** Reads the current count without incrementing. */
export const peekWindow = async (key: string): Promise<number> => {
  const redis = getRedis();
  if (redis) {
    const value = await redis.get(`rl:${key}`);
    return value ? Number(value) : 0;
  }
  const entry = memory.get(key);
  return entry && entry.resetAt > Date.now() ? entry.count : 0;
};

export const resetWindow = async (key: string) => {
  const redis = getRedis();
  if (redis) await redis.del(`rl:${key}`);
  else memory.delete(key);
};
