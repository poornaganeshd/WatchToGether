import { useEffect, useRef, useState } from "react";
import { Check, Link2, ListPlus, Play, Radio, Search, TrendingUp } from "lucide-react";
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

const looksLikeUrl = (text: string) => /^(https?:\/\/|www\.|youtu\.be\/|youtube\.com\/|m\.youtube\.com\/)/i.test(text.trim());
const normalizeUrl = (text: string) => (/^https?:\/\//i.test(text.trim()) ? text.trim() : `https://${text.trim()}`);

/** Search YouTube (via our server) or paste any link, then play it or add it to the queue. */
export default function YouTubeSearch({ roomId, canPlay }: { roomId: string; canPlay: boolean }) {
  const socket = useSocketStore((s) => s.socket);
  const queue = useSocketStore((s) => s.queue);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [input, setInput] = useState("");
  const [heading, setHeading] = useState<"popular" | "search">("popular");
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
    } catch (err) {
      if (seq === requestSeq.current) setError(getErrorMessage(err, "Search failed"));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
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
      if (canPlay) playNow(normalizeUrl(text));
      else addToQueue(normalizeUrl(text));
      setInput("");
      return;
    }
    if (enabled) runSearch(text);
  };

  const inputIsUrl = looksLikeUrl(input);

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
            placeholder={enabled ? "Search YouTube or paste a link" : "Paste a video link"}
            className="input py-2 pl-9"
            enterKeyHint={inputIsUrl ? "go" : "search"}
            maxLength={2000}
            aria-label={enabled ? "Search YouTube or paste a link" : "Paste a video link"}
          />
        </div>
        {inputIsUrl ? (
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
            <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              {heading === "popular" ? <><TrendingUp size={12} /> Popular now</> : <><Search size={12} /> Results for “{lastQuery}”</>}
            </p>
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
              <p className="py-6 text-center text-xs text-slate-500">{heading === "search" ? "No embeddable videos found." : "Nothing to show yet."}</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
