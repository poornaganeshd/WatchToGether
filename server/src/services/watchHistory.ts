import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

/** What a room plays before anyone picks something; not worth remembering. */
export const DEFAULT_PLAYBACK_URL = "https://www.youtube.com/watch?v=aqz-KE-bpKQ";

const MAX_PER_USER = 50;
const MAX_TITLE_CACHE = 1000;

export const youTubeIdOf = (url: string): string | null => {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^(www\.|m\.|music\.)/, "");
    if (host === "youtu.be") return u.pathname.slice(1).split("/")[0] || null;
    if (host === "youtube.com" || host === "youtube-nocookie.com") {
      const v = u.searchParams.get("v");
      if (v) return v;
      const m = u.pathname.match(/^\/(?:embed|shorts|live)\/([A-Za-z0-9_-]{6,})/);
      return m ? m[1] : null;
    }
    return null;
  } catch {
    return null;
  }
};

const titleCache = new Map<string, string | null>();

/** A readable title: YouTube's oEmbed (no API key needed), else the file name or site. */
const lookUpTitle = async (url: string): Promise<string | null> => {
  if (titleCache.has(url)) return titleCache.get(url)!;
  let title: string | null = null;
  if (youTubeIdOf(url)) {
    try {
      const base = (process.env.YOUTUBE_OEMBED_BASE || "https://www.youtube.com").replace(/\/+$/, "");
      const res = await fetch(`${base}/oembed?format=json&url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) title = ((await res.json()) as { title?: string }).title?.slice(0, 300) || null;
    } catch {
      /* offline or blocked: fall back to no title */
    }
  } else {
    try {
      const u = new URL(url);
      const file = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() ?? "");
      title = (file || u.hostname).slice(0, 300);
    } catch {
      title = null;
    }
  }
  if (titleCache.size >= MAX_TITLE_CACHE) titleCache.clear();
  titleCache.set(url, title);
  return title;
};

/** Remembers that these users watched `url` in a room (newest first, capped per user). */
export const recordWatched = async (userIds: string[], url: string, roomId: string) => {
  const unique = [...new Set(userIds)];
  if (!unique.length || !url || url === DEFAULT_PLAYBACK_URL) return;
  try {
    const [title, room] = await Promise.all([
      lookUpTitle(url),
      prisma.room.findUnique({ where: { id: roomId }, select: { name: true } }),
    ]);
    for (const userId of unique) {
      await prisma.watchedVideo.upsert({
        where: { userId_url: { userId, url } },
        create: { userId, url, title, roomId, roomName: room?.name ?? null },
        update: { watchedAt: new Date(), roomId, roomName: room?.name ?? null, ...(title ? { title } : {}) },
      });
      const stale = await prisma.watchedVideo.findMany({
        where: { userId },
        orderBy: { watchedAt: "desc" },
        skip: MAX_PER_USER,
        select: { id: true },
      });
      if (stale.length) await prisma.watchedVideo.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
    }
  } catch (err) {
    console.error("Failed to record watch history:", err);
  }
};

export const listWatched = async (userId: string, limit = 20) => {
  const rows = await prisma.watchedVideo.findMany({
    where: { userId },
    orderBy: { watchedAt: "desc" },
    take: limit,
  });
  return rows.map((r) => {
    const ytId = youTubeIdOf(r.url);
    return {
      id: r.id,
      url: r.url,
      title: r.title,
      thumbnail: ytId ? `https://i.ytimg.com/vi/${ytId}/mqdefault.jpg` : null,
      roomId: r.roomId,
      roomName: r.roomName,
      watchedAt: r.watchedAt,
    };
  });
};
