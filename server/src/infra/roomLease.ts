import { getRedis, INSTANCE_ID } from "./redis";

// A live room's state (playback, participants, queue order…) is held in the memory of the
// API instance that runs it. With several instances, a lease in Redis records which one owns
// each room so two instances never run diverging copies of the same room.
const LEASE_MS = 60_000;
const leaseKey = (roomId: string) => `room:owner:${roomId}`;

// Delete only if we still own it, atomically.
const RELEASE_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;
const RENEW_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end`;

/** Claims (or confirms) ownership of a room for this instance. Always true without Redis. */
export const acquireRoomLease = async (roomId: string): Promise<boolean> => {
  const redis = getRedis();
  if (!redis) return true;
  const claimed = await redis.set(leaseKey(roomId), INSTANCE_ID, { NX: true, PX: LEASE_MS });
  if (claimed === "OK") return true;
  const renewed = await redis.eval(RENEW_SCRIPT, { keys: [leaseKey(roomId)], arguments: [INSTANCE_ID, String(LEASE_MS)] });
  return renewed === 1;
};

export const releaseRoomLease = async (roomId: string) => {
  const redis = getRedis();
  if (!redis) return;
  await redis.eval(RELEASE_SCRIPT, { keys: [leaseKey(roomId)], arguments: [INSTANCE_ID] });
};

/** Renews leases for every room this instance runs. */
export const renewRoomLeases = async (roomIds: string[]) => {
  const redis = getRedis();
  if (!redis || roomIds.length === 0) return;
  await Promise.all(
    roomIds.map((id) => redis.eval(RENEW_SCRIPT, { keys: [leaseKey(id)], arguments: [INSTANCE_ID, String(LEASE_MS)] }))
  );
};
