import { Request, Response } from "express";
import { getRedis } from "../infra/redis";

// YouTube Data API v3. search.list costs 100 quota units (≈100 searches/day on the free
// 10,000-unit quota), videos.list costs 1, so results are cached and searches are rate limited.
const API_BASE = () => (process.env.YOUTUBE_API_BASE || "https://www.googleapis.com/youtube/v3").replace(/\/+$/, "");
const SEARCH_TTL_SECONDS = 60 * 60;
const POPULAR_TTL_SECONDS = 2 * 60 * 60;
const PLAYLIST_TTL_SECONDS = 60 * 60;
// Matches the room queue's capacity.
const MAX_PLAYLIST_ITEMS = 50;

export const isYouTubeSearchEnabled = () => !!process.env.YOUTUBE_API_KEY;

export interface YouTubeResult {
  id: string;
  url: string;
  title: string;
  channel: string;
  thumbnail: string | null;
  durationSeconds: number | null;
  isLive: boolean;
  publishedAt: string | null;
}

const memoryCache = new Map<string, { expires: number; value: unknown }>();
// Identical requests arriving together share one API call (each search costs 100 quota units).
const inFlight = new Map<string, Promise<unknown>>();

const readShared = async (key: string): Promise<string | null> => {
  try {
    return (await getRedis()?.get(`yt:${key}`)) ?? null;
  } catch (err) {
    console.warn("YouTube cache read failed, using memory cache:", err);
    return null;
  }
};

const writeShared = async (key: string, value: unknown, ttlSeconds: number) => {
  try {
    await getRedis()?.set(`yt:${key}`, JSON.stringify(value), { EX: ttlSeconds });
  } catch (err) {
    console.warn("YouTube cache write failed:", err);
  }
};

const cached = async <T>(key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T> => {
  const local = memoryCache.get(key);
  if (local && local.expires > Date.now()) return local.value as T;
  const shared = await readShared(key);
  if (shared) return JSON.parse(shared) as T;

  const pending = inFlight.get(key);
  if (pending) return pending as Promise<T>;
  const request = load()
    .then(async (value) => {
      memoryCache.set(key, { expires: Date.now() + ttlSeconds * 1000, value });
      if (memoryCache.size > 500) {
        const now = Date.now();
        for (const [k, v] of memoryCache) if (v.expires <= now) memoryCache.delete(k);
      }
      await writeShared(key, value, ttlSeconds);
      return value;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, request);
  return request;
};

class YouTubeApiError extends Error {
  constructor(public status: number, public reason: string) {
    super(reason);
  }
}

const callApi = async (path: string, params: Record<string, string>) => {
  const url = new URL(`${API_BASE()}/${path}`);
  for (const [k, v] of Object.entries({ ...params, key: process.env.YOUTUBE_API_KEY! })) url.searchParams.set(k, v);
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  const body = (await res.json().catch(() => ({}))) as { error?: { errors?: { reason?: string }[] } } & Record<string, unknown>;
  if (!res.ok) {
    throw new YouTubeApiError(res.status, body.error?.errors?.[0]?.reason || `http_${res.status}`);
  }
  return body;
};

// YouTube returns HTML-escaped titles ("Tom &amp; Jerry").
const decodeEntities = (text: string) =>
  text
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/** ISO 8601 duration (PT1H2M3S) to seconds. */
export const parseIsoDuration = (iso: string | undefined): number | null => {
  const m = iso?.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return null;
  const [, d, h, min, s] = m.map((v) => Number(v) || 0);
  return d * 86400 + h * 3600 + min * 60 + s;
};

interface ApiVideo {
  id: string | { videoId?: string };
  snippet?: {
    title?: string;
    channelTitle?: string;
    publishedAt?: string;
    liveBroadcastContent?: string;
    thumbnails?: Record<string, { url: string }>;
  };
  contentDetails?: { duration?: string };
}

const toResult = (v: ApiVideo, durations: Map<string, number | null>): YouTubeResult | null => {
  const id = typeof v.id === "string" ? v.id : v.id?.videoId;
  if (!id) return null;
  const thumbs = v.snippet?.thumbnails ?? {};
  return {
    id,
    url: `https://www.youtube.com/watch?v=${id}`,
    title: decodeEntities(v.snippet?.title ?? "Untitled"),
    channel: decodeEntities(v.snippet?.channelTitle ?? ""),
    thumbnail: (thumbs.medium ?? thumbs.high ?? thumbs.default)?.url ?? null,
    durationSeconds: durations.get(id) ?? parseIsoDuration(v.contentDetails?.duration),
    isLive: v.snippet?.liveBroadcastContent === "live",
    publishedAt: v.snippet?.publishedAt ?? null,
  };
};

const respondError = (res: Response, err: unknown) => {
  if (err instanceof YouTubeApiError) {
    if (err.reason === "quotaExceeded" || err.reason === "dailyLimitExceeded") {
      res.status(503).json({ error: "YouTube search has hit its daily limit. Paste a link instead, or try again tomorrow." });
      return;
    }
    console.error("YouTube API error:", err.status, err.reason);
    res.status(502).json({ error: "YouTube search isn't working right now" });
    return;
  }
  console.error("YouTube search failed:", err);
  res.status(502).json({ error: "YouTube search isn't working right now" });
};

export const getYouTubeConfig = (_req: Request, res: Response): void => {
  res.status(200).json({ enabled: isYouTubeSearchEnabled() });
};

export const searchYouTube = async (req: Request, res: Response): Promise<void> => {
  if (!isYouTubeSearchEnabled()) {
    res.status(503).json({ error: "YouTube search isn't set up on this server" });
    return;
  }
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const pageToken = typeof req.query.pageToken === "string" ? req.query.pageToken.slice(0, 200) : "";
  if (!q || q.length > 100) {
    res.status(400).json({ error: "Type something to search for (up to 100 characters)" });
    return;
  }
  try {
    const data = await cached(`search:${q.toLowerCase()}:${pageToken}`, SEARCH_TTL_SECONDS, async () => {
      const search = (await callApi("search", {
        part: "snippet",
        type: "video",
        // Only videos that are allowed to play inside other sites.
        videoEmbeddable: "true",
        safeSearch: "moderate",
        maxResults: "12",
        q,
        ...(pageToken ? { pageToken } : {}),
      })) as { items?: ApiVideo[]; nextPageToken?: string };
      const items = search.items ?? [];
      const ids = items.map((i) => (typeof i.id === "string" ? i.id : i.id?.videoId)).filter(Boolean) as string[];
      const durations = new Map<string, number | null>();
      if (ids.length) {
        const details = (await callApi("videos", { part: "contentDetails", id: ids.join(",") })) as { items?: ApiVideo[] };
        for (const d of details.items ?? []) durations.set(String(d.id), parseIsoDuration(d.contentDetails?.duration));
      }
      return {
        results: items.map((i) => toResult(i, durations)).filter(Boolean) as YouTubeResult[],
        nextPageToken: search.nextPageToken ?? null,
      };
    });
    res.status(200).json(data);
  } catch (err) {
    respondError(res, err);
  }
};

export const popularYouTube = async (req: Request, res: Response): Promise<void> => {
  if (!isYouTubeSearchEnabled()) {
    res.status(503).json({ error: "YouTube search isn't set up on this server" });
    return;
  }
  const region = typeof req.query.region === "string" && /^[A-Z]{2}$/.test(req.query.region) ? req.query.region : "US";
  try {
    const data = await cached(`popular:${region}`, POPULAR_TTL_SECONDS, async () => {
      const popular = (await callApi("videos", {
        part: "snippet,contentDetails,status",
        chart: "mostPopular",
        regionCode: region,
        maxResults: "24",
      })) as { items?: (ApiVideo & { status?: { embeddable?: boolean } })[] };
      const items = (popular.items ?? []).filter((v) => v.status?.embeddable !== false);
      return { results: items.map((i) => toResult(i, new Map())).filter(Boolean) as YouTubeResult[], nextPageToken: null };
    });
    res.status(200).json(data);
  } catch (err) {
    respondError(res, err);
  }
};

export const playlistYouTube = async (req: Request, res: Response): Promise<void> => {
  if (!isYouTubeSearchEnabled()) {
    res.status(503).json({ error: "YouTube search isn't set up on this server" });
    return;
  }
  const id = typeof req.query.id === "string" ? req.query.id.trim() : "";
  if (!/^[A-Za-z0-9_-]{2,64}$/.test(id)) {
    res.status(400).json({ error: "That doesn't look like a YouTube playlist link" });
    return;
  }
  try {
    const data = await cached(`playlist:${id}`, PLAYLIST_TTL_SECONDS, async () => {
      // playlists.list and playlistItems.list cost 1 unit each.
      const [meta, items] = (await Promise.all([
        callApi("playlists", { part: "snippet,contentDetails", id }),
        callApi("playlistItems", { part: "snippet,contentDetails", playlistId: id, maxResults: String(MAX_PLAYLIST_ITEMS) }),
      ])) as [
        { items?: { snippet?: { title?: string; channelTitle?: string }; contentDetails?: { itemCount?: number } }[] },
        { items?: (ApiVideo & { contentDetails?: { videoId?: string } })[] },
      ];
      const playlist = meta.items?.[0];
      if (!playlist) return null;
      const videos = (items.items ?? [])
        .map((i) => ({ ...i, id: i.contentDetails?.videoId ?? "" }))
        // Removed and private videos stay in playlists with placeholder titles.
        .filter((i) => i.id && i.snippet?.title !== "Deleted video" && i.snippet?.title !== "Private video");
      return {
        title: decodeEntities(playlist.snippet?.title ?? "Playlist"),
        channel: decodeEntities(playlist.snippet?.channelTitle ?? ""),
        totalCount: playlist.contentDetails?.itemCount ?? videos.length,
        results: videos.map((v) => toResult(v, new Map())).filter(Boolean) as YouTubeResult[],
      };
    });
    if (!data) {
      res.status(404).json({ error: "Playlist not found (it may be private)" });
      return;
    }
    res.status(200).json(data);
  } catch (err) {
    if (err instanceof YouTubeApiError && err.status === 404) {
      res.status(404).json({ error: "Playlist not found (it may be private)" });
      return;
    }
    respondError(res, err);
  }
};
