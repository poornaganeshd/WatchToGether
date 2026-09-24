/** Tracks which users have at least one connected socket. */
export class PresenceManager {
  private sockets = new Map<string, Set<string>>();

  /** Returns true when this is the user's first connected socket. */
  add(userId: string, socketId: string): boolean {
    let set = this.sockets.get(userId);
    const wasOffline = !set || set.size === 0;
    if (!set) {
      set = new Set();
      this.sockets.set(userId, set);
    }
    set.add(socketId);
    return wasOffline;
  }

  /** Returns true when the user has no sockets left. */
  remove(userId: string, socketId: string): boolean {
    const set = this.sockets.get(userId);
    if (!set) return false;
    set.delete(socketId);
    if (set.size === 0) {
      this.sockets.delete(userId);
      return true;
    }
    return false;
  }

  isOnline(userId: string): boolean {
    return (this.sockets.get(userId)?.size ?? 0) > 0;
  }
}

export const presence = new PresenceManager();
