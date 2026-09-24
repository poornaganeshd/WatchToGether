import { createClient } from "redis";
import { randomUUID } from "crypto";

export type RedisClient = ReturnType<typeof createClient>;

/** Unique id for this API process; used for presence and room ownership. */
export const INSTANCE_ID = process.env.INSTANCE_ID || randomUUID();

let client: RedisClient | null = null;

/** The shared Redis client, or null when running as a single instance without Redis. */
export const getRedis = () => client;

/**
 * Connects to Redis when REDIS_URL is set. Returns a publisher/subscriber pair for the
 * Socket.IO adapter. Without REDIS_URL everything stays in process memory (single instance).
 */
export const initRedis = async (url = process.env.REDIS_URL) => {
  if (!url) return null;
  const pub = createClient({ url });
  const sub = pub.duplicate();
  pub.on("error", (err) => console.error("Redis error:", err));
  sub.on("error", (err) => console.error("Redis (subscriber) error:", err));
  await Promise.all([pub.connect(), sub.connect()]);
  client = pub;
  console.log(`Connected to Redis; instance ${INSTANCE_ID}`);
  return { pub, sub };
};

export const closeRedis = async (clients: { pub: RedisClient; sub: RedisClient } | null) => {
  if (!clients) return;
  client = null;
  await Promise.allSettled([clients.pub.quit(), clients.sub.quit()]);
};
