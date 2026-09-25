import { useEffect, useRef, useState } from "react";
import { Check, Clock, History, Link2, ListMusic, ListPlus, Play, Radio, Search, TrendingUp, X } from "lucide-react";
import api, { getErrorMessage } from "../lib/api";
import { formatClock } from "../lib/format";
import { useSocketStore } from "../store/useSocketStore";
import { toast } from "../store/useToastStore";
import Spinner from "./ui/Spinner";

interface Result {
  id: string;
  url: string;
  title: string;
  channel: string;
  thumbnail: string | null;
  durationSeconds: number | null;
  isLive: boolean;
}

let configPromise: Promise<boolean> | null = null;
const loadEnabled = () =>
  (configPromise ??= api
    .get("/youtube/config")
    .then((r) => !!r.data.enabled)
    .catch(() => {
      // Don't remember a network blip: try again next time the panel opens.
      configPromise = null;
      return false;
    }));

// YouTube paging can repeat a video across pages; keep the first copy.
const mergeUnique = (prev: Result[], next: Result[]) => {
  const seen = new Set(prev.map((r) => r.id));
  return [...prev, ...next.filter((r) => !seen.has(r.id) && seen.add(r.id))];
};

// youtube.com/playlist?list=… or a video link that carries a list (…&list=…).
const playlistIdOf = (text: string): string | null => {
  try {
    const url = new URL(normalizeUrl(text));
    if (!/(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be)$/i.test(url.hostname)) return null;
    const list = url.searchParams.get("list");
    return list && /^[A-Za-z0-9_-]{2,64}$/.test(list) ? list : null;
  } catch {
    return null;
  }
};

const RECENT_KEY = "wt_recent_searches";
const MAX_RECENT = 8;
const readRecent = (): string[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((q): q is string => typeof q === "string").slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
};
const writeRecent = (list: string[]) => {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* private mode */
  }
};

interface PlaylistInfo {
  id: string;
  title: string;
  channel: string;
  totalCount: number;
}

const looksLikeUrl = (text: string) => /^(https?:\/\/|www\.|youtu\.be\/|youtube\.com\/|m\.youtube\.com\/)/i.test(text.trim());
const normalizeUrl = (text: string) => (/^https?:\/\//i.test(text.trim()) ? text.trim() : `https://${text.trim()}`);

/** Search YouTube (via our server) or paste any link, then play it or add it to the queue. */
export default function YouTubeSearch({ roomId, canPlay }: { roomId: string; canPlay: boolean }) {
  const socket = useSocketStore((s) => s.socket);
  const queue = useSocketStore((s) => s.queue);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [input, setInput] = useState("");
  const [heading, setHeading] = useState<"popular" | "search" | "playlist">("popular");
  const [playlist, setPlaylist] = useState<PlaylistInfo | null>(null);
  const [queueingAll, setQueueingAll] = useState(false);
  const [recent, setRecent] = useState<string[]>(readRecent);
  const [results, setResults] = useState<Result[]>([]);
  const [nextPage, setNextPage] = useState<string | null>(null);
  const [lastQuery, setLastQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only the newest request may update the list, so a slow "Popular" load can't replace search results.
  const requestSeq = useRef(0);

  const queued = new Set(queue.map((q) => q.url));

  // Confirm only once the server has actually queued it (it can refuse: queue full, too fast).
  const pendingAdds = useRef(new Map<string, string | undefined>());
  useEffect(() => {
    for (const [url, title] of pendingAdds.current) {
      if (!queue.some((q) => q.url === url)) continue;
      pendingAdds.current.delete(url);
      toast.success(title ? `Added “${title.slice(0, 40)}” to the queue` : "Added to the queue");
    }
  }, [queue]);

  useEffect(() => {
    let cancelled = false;
    loadEnabled().then((on) => {
      if (cancelled) return;
      setEnabled(on);
      if (!on) return;
      const seq = ++requestSeq.current;
      const isCurrent = () => !cancelled && seq === requestSeq.current;
      setLoading(true);
      // Region from the browser locale, e.g. en-IN -> IN.
      const region = (navigator.language.split("-")[1] || "US").toUpperCase();
      api
        .get("/youtube/popular", { params: { region } })
        .then((r) => isCurrent() && setResults(r.data.results))
        .catch((err) => isCurrent() && setError(getErrorMessage(err, "Couldn't load popular videos")))
        .finally(() => isCurrent() && setLoading(false));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const runSearch = async (query: string, pageToken?: string) => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      const r = await api.get("/youtube/search", { params: { q: query, ...(pageToken ? { pageToken } : {}) } });
      if (seq !== requestSeq.current) return;
      setResults((prev) => (pageToken ? mergeUnique(prev, r.data.results) : r.data.results));
      setNextPage(r.data.nextPageToken);
      setHeading("search");
      setLastQuery(query);
      if (!pageToken) {
        const next = [query, ...recent.filter((q) => q.toLowerCase() !== query.toLowerCase())].slice(0, MAX_RECENT);
        setRecent(next);
        writeRecent(next);
      }
    } catch (err) {
      if (seq === requestSeq.current) setError(getErrorMessage(err, "Search failed"));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  };

  const loadPlaylist = async (id: string) => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      const r = await api.get("/youtube/playlist", { params: { id } });
      if (seq !== requestSeq.current) return;
      setResults(r.data.results);
      setNextPage(null);
      setPlaylist({ id, title: r.data.title, channel: r.data.channel, totalCount: r.data.totalCount });
      setHeading("playlist");
    } catch (err) {
      if (seq === requestSeq.current) setError(getErrorMessage(err, "Couldn't open that playlist"));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  };

  const queueAll = () => {
    const urls = results.map((r) => r.url).filter((u) => !queued.has(u));
    if (!socket || !urls.length) return;
    setQueueingAll(true);
    socket
      .timeout(5000)
      .emitWithAck("queue_add_many", { roomId, urls })
      .then((res: { added: number; skipped: number }) => {
        if (res.added) toast.success(`Queued ${res.added} video${res.added === 1 ? "" : "s"}${res.skipped ? ` (${res.skipped} didn't fit, the queue holds 50)` : ""}`);
        else toast.error("The queue is full");
      })
      .catch(() => undefined /* refusals arrive as error toasts */)
      .finally(() => setQueueingAll(false));
  };

  const clearRecent = () => {
    setRecent([]);
    writeRecent([]);
  };

  const addToQueue = (url: string, title?: string) => {
    pendingAdds.current.set(url, title);
    socket?.emit("queue_add", { roomId, url });
  };

  const playNow = (url: string) => {
    socket?.emit("play_url", { roomId, url });
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;
    if (looksLikeUrl(text)) {
      const listId = enabled ? playlistIdOf(text) : null;
      if (listId) {
        loadPlaylist(listId);
        setInput("");
        return;
      }
      if (canPlay) playNow(normalizeUrl(text));
      else addToQueue(normalizeUrl(text));
      setInput("");
      return;
    }
    if (enabled) runSearch(text);
  };

  const inputIsUrl = looksLikeUrl(input);
  const inputIsPlaylist = inputIsUrl && !!enabled && !!playlistIdOf(input);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <form onSubmit={submit} className="flex gap-2 border-b border-white/5 p-3">
        <div className="relative flex-1">
          {inputIsUrl ? (
            <Link2 size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-indigo-300" />
          ) : (
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          )}
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={enabled ? "Search YouTube, or paste a video or playlist link" : "Paste a video link"}
            className="input py-2 pl-9"
            enterKeyHint={inputIsUrl ? "go" : "search"}
            maxLength={2000}
            aria-label={enabled ? "Search YouTube or paste a link" : "Paste a video link"}
          />
        </div>
        {inputIsPlaylist ? (
          <button type="submit" className="btn-primary px-3 text-xs" aria-label="Open playlist">
            <ListMusic size={14} /> Open
          </button>
        ) : inputIsUrl ? (
          <>
            {canPlay && (
              <button type="submit" className="btn-primary px-3 text-xs" aria-label="Play link now">
                <Play size={14} /> Play
              </button>
            )}
            <button type="button" onClick={() => { addToQueue(normalizeUrl(input)); setInput(""); }} className="btn-secondary px-3 text-xs" aria-label="Add link to queue">
              <ListPlus size={14} />
            </button>
          </>
        ) : (
          <button type="submit" disabled={!enabled || !input.trim() || loading} className="btn-primary px-3 text-xs">
            Search
          </button>
        )}
      </form>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {enabled === false ? (
          <div className="rounded-xl border border-dashed border-white/10 p-4 text-center text-xs text-slate-400">
            Paste any YouTube or video link above.
            <span className="mt-1 block text-slate-500">Searching YouTube here needs a YouTube API key on the server (see the README).</span>
          </div>
        ) : (
          <>
            {recent.length > 0 && heading !== "playlist" && (
              <div className="mb-3">
                <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  <History size={12} /> Recent searches
                  <button onClick={clearRecent} className="ml-auto normal-case tracking-normal text-slate-500 hover:text-slate-300">Clear</button>
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {recent.map((q) => (
                    <button
                      key={q}
                      onClick={() => { setInput(q); runSearch(q); }}
                      disabled={loading}
                      className="flex max-w-full items-center gap-1 truncate rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-xs text-slate-300 hover:bg-white/10"
                    >
                      <Clock size={11} className="shrink-0 text-slate-500" /> <span className="truncate">{q}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {heading === "playlist" && playlist ? (
              <div className="mb-3 rounded-xl border border-white/10 bg-white/[0.03] p-3">
                <div className="flex items-start gap-2">
                  <ListMusic size={16} className="mt-0.5 shrink-0 text-indigo-300" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-white" title={playlist.title}>{playlist.title}</p>
                    <p className="truncate text-[11px] text-slate-500">
                      {playlist.channel && `${playlist.channel} · `}{results.length} playable video{results.length === 1 ? "" : "s"}
                      {playlist.totalCount > results.length && ` (of ${playlist.totalCount})`}
                    </p>
                  </div>
                  <button onClick={() => { setHeading("popular"); setPlaylist(null); setResults([]); }} className="btn-ghost p-1" aria-label="Close playlist">
                    <X size={14} />
                  </button>
                </div>
                {canPlay ? (
                  <button onClick={queueAll} disabled={queueingAll || results.every((r) => queued.has(r.url))} className="btn-primary mt-2 w-full py-1.5 text-xs">
                    {queueingAll ? <Spinner className="h-3.5 w-3.5" /> : <ListPlus size={14} />} Queue all
                  </button>
                ) : (
                  <p className="mt-2 text-[11px] text-slate-500">Hosts can queue the whole playlist; you can add videos one by one.</p>
                )}
              </div>
            ) : (
              <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                {heading === "popular" ? <><TrendingUp size={12} /> Popular now</> : <><Search size={12} /> Results for “{lastQuery}”</>}
              </p>
            )}
            {error && <p className="mb-2 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</p>}
            <ul className="space-y-2">
              {results.map((r) => {
                const isQueued = queued.has(r.url);
                return (
                  <li key={r.id} className="flex gap-3 rounded-xl p-1.5 hover:bg-white/[0.03]">
                    <div className="relative aspect-video w-32 shrink-0 overflow-hidden rounded-lg bg-ink-800">
                      {r.thumbnail && <img src={r.thumbnail} alt="" className="h-full w-full object-cover" loading="lazy" />}
                      <span className="absolute bottom-1 right-1 rounded bg-black/80 px-1 font-mono text-[10px] text-white">
                        {r.isLive ? <span className="flex items-center gap-0.5 text-red-300"><Radio size={9} /> LIVE</span> : r.durationSeconds !== null ? formatClock(r.durationSeconds) : ""}
                      </span>
                    </div>
                    <div className="flex min-w-0 flex-1 flex-col">
                      <p className="line-clamp-2 text-xs font-medium leading-snug text-slate-100" title={r.title}>{r.title}</p>
                      <p className="mt-0.5 truncate text-[11px] text-slate-500">{r.channel}</p>
                      <div className="mt-auto flex gap-1.5 pt-1">
                        {canPlay && (
                          <button onClick={() => playNow(r.url)} className="btn-primary px-2.5 py-1 text-[11px]" aria-label={`Play ${r.title} now`}>
                            <Play size={12} /> Play
                          </button>
                        )}
                        <button
                          onClick={() => addToQueue(r.url, r.title)}
                          disabled={isQueued}
                          className="btn-secondary px-2.5 py-1 text-[11px]"
                          aria-label={isQueued ? "Already queued" : `Add ${r.title} to queue`}
                        >
                          {isQueued ? <><Check size={12} /> Queued</> : <><ListPlus size={12} /> Queue</>}
                        </button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
            {loading && <div className="grid h-16 place-items-center text-slate-500"><Spinner /></div>}
            {!loading && heading === "search" && nextPage && (
              <button onClick={() => runSearch(lastQuery, nextPage)} className="btn-ghost mt-2 w-full text-xs">Load more</button>
            )}
            {!loading && !error && results.length === 0 && (
              <p className="py-6 text-center text-xs text-slate-500">{heading === "search" ? "No embeddable videos found." : heading === "playlist" ? "This playlist has no playable videos." : "Nothing to show yet."}</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
