import { getRedis } from "../infra/redis";

// How long a socket counts as online without a heartbeat (Redis mode). Heartbeats run well
// inside this, so only sockets on a crashed instance ever expire.
const PRESENCE_TTL_MS = 90_000;
const ROOM_TTL_SECONDS = 60;

const presenceKey = (userId: string) => `presence:${userId}`;
const roomKey = (userId: string) => `presence:room:${userId}`;

/**
 * Tracks which users are online and which room they're in. In-memory for a single instance;
 * with Redis, shared by every API instance.
 */
export class PresenceManager {
  private sockets = new Map<string, Set<string>>();
  private localRoomLookup: (userId: string) => string | undefined = () => undefined;

  /** Where to find a user's room when running without Redis. */
  setLocalRoomLookup(lookup: (userId: string) => string | undefined) {
    this.localRoomLookup = lookup;
  }

  /** Records a connected socket. Resolves true when this is the user's first one. */
  async add(userId: string, socketId: string): Promise<boolean> {
    let set = this.sockets.get(userId);
    const wasOfflineLocally = !set || set.size === 0;
    if (!set) {
      set = new Set();
      this.sockets.set(userId, set);
    }
    set.add(socketId);

    const redis = getRedis();
    if (!redis) return wasOfflineLocally;
    const key = presenceKey(userId);
    const now = Date.now();
    const [, , count] = (await redis
      .multi()
      .zRemRangeByScore(key, 0, now)
      .zAdd(key, { score: now + PRESENCE_TTL_MS, value: socketId })
      .zCard(key)
      .exec()) as unknown as [number, number, number];
    return count === 1;
  }

  /** Forgets a socket. Resolves true when the user has no sockets left anywhere. */
  async remove(userId: string, socketId: string): Promise<boolean> {
    const set = this.sockets.get(userId);
    set?.delete(socketId);
    const goneLocally = !!set && set.size === 0;
    if (goneLocally) this.sockets.delete(userId);

    const redis = getRedis();
    if (!redis) return goneLocally;
    const key = presenceKey(userId);
    const [, , count] = (await redis.multi().zRem(key, socketId).zRemRangeByScore(key, 0, Date.now()).zCard(key).exec()) as unknown as [
      number,
      number,
      number,
    ];
    if (count === 0) await redis.del(roomKey(userId));
    return count === 0;
  }

  async isOnline(userId: string): Promise<boolean> {
    const redis = getRedis();
    if (!redis) return (this.sockets.get(userId)?.size ?? 0) > 0;
    return (await redis.zCount(presenceKey(userId), Date.now(), "+inf")) > 0;
  }

  async setRoom(userId: string, roomId: string | null) {
    const redis = getRedis();
    if (!redis) return;
    if (roomId) await redis.set(roomKey(userId), roomId, { EX: ROOM_TTL_SECONDS });
    else await redis.del(roomKey(userId));
  }

  async getRoom(userId: string): Promise<string | null> {
    const redis = getRedis();
    if (!redis) return this.localRoomLookup(userId) ?? null;
    return redis.get(roomKey(userId));
  }

  /** Refreshes this instance's entries in Redis. Call periodically. */
  async heartbeat() {
    const redis = getRedis();
    if (!redis || this.sockets.size === 0) return;
    const expiry = Date.now() + PRESENCE_TTL_MS;
    const multi = redis.multi();
    for (const [userId, socketIds] of this.sockets) {
      for (const socketId of socketIds) multi.zAdd(presenceKey(userId), { score: expiry, value: socketId });
      const roomId = this.localRoomLookup(userId);
      if (roomId) multi.set(roomKey(userId), roomId, { EX: ROOM_TTL_SECONDS });
    }
    await multi.exec();
  }

  /** Test helper: forget all local state. */
  reset() {
    this.sockets.clear();
  }
}

export const presence = new PresenceManager();
