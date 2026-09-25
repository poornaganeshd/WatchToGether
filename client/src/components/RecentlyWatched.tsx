import { useCallback, useEffect, useState } from "react";
import { Film, History, Play, X } from "lucide-react";
import api, { getErrorMessage } from "../lib/api";
import { timeAgo } from "../lib/format";
import { toast } from "../store/useToastStore";

export interface WatchedVideo {
  id: string;
  url: string;
  title: string | null;
  thumbnail: string | null;
  roomId: string | null;
  roomName: string | null;
  watchedAt: string;
}

const labelOf = (v: WatchedVideo) => {
  if (v.title) return v.title;
  try {
    return new URL(v.url).hostname.replace(/^www\./, "");
  } catch {
    return v.url;
  }
};

/** Dashboard row of videos you've watched in rooms, with one tap to start a new party on one. */
export default function RecentlyWatched({ onWatchAgain }: { onWatchAgain: (video: WatchedVideo, title: string) => void }) {
  const [videos, setVideos] = useState<WatchedVideo[] | null>(null);

  const load = useCallback(() => {
    api
      .get("/watch-history")
      .then((r) => setVideos(r.data.videos))
      .catch(() => setVideos([]));
  }, []);

  useEffect(load, [load]);

  const remove = async (id: string) => {
    setVideos((list) => list?.filter((v) => v.id !== id) ?? null);
    try {
      await api.delete(`/watch-history/${id}`);
    } catch (err) {
      toast.error(getErrorMessage(err, "Couldn't remove that video"));
      load();
    }
  };

  const clearAll = async () => {
    if (!confirm("Clear your recently watched videos?")) return;
    const previous = videos;
    setVideos([]);
    try {
      await api.delete("/watch-history");
    } catch (err) {
      toast.error(getErrorMessage(err, "Couldn't clear your list"));
      setVideos(previous);
    }
  };

  if (!videos?.length) return null;

  return (
    <section className="mb-10 animate-fade-up" aria-labelledby="recently-watched">
      <div className="mb-3 flex items-center justify-between">
        <h2 id="recently-watched" className="flex items-center gap-2 font-display font-semibold">
          <History size={18} className="text-indigo-300" /> Recently watched
        </h2>
        <button onClick={clearAll} className="text-xs text-slate-500 hover:text-slate-300">Clear</button>
      </div>
      <ul className="-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0">
        {videos.map((v) => {
          const title = labelOf(v);
          return (
            <li key={v.id} className="group relative w-52 shrink-0 snap-start">
              <button onClick={() => onWatchAgain(v, title)} className="block w-full text-left" aria-label={`Watch ${title} again`}>
                <div className="relative aspect-video overflow-hidden rounded-xl bg-ink-800 ring-1 ring-white/10">
                  <div className="grid h-full w-full place-items-center text-slate-500"><Film size={28} /></div>
                  {v.thumbnail && (
                    <img
                      src={v.thumbnail}
                      alt=""
                      loading="lazy"
                      // Missing thumbnails fall back to the film icon underneath.
                      onError={(e) => { e.currentTarget.style.display = "none"; }}
                      className="absolute inset-0 h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                    />
                  )}
                  <span className="absolute inset-0 grid place-items-center bg-black/0 opacity-0 transition group-hover:bg-black/40 group-hover:opacity-100">
                    <span className="flex items-center gap-1 rounded-full bg-white px-3 py-1 text-xs font-semibold text-ink-950"><Play size={12} /> Watch again</span>
                  </span>
                </div>
                <p className="mt-2 line-clamp-2 text-xs font-medium leading-snug text-slate-100" title={title}>{title}</p>
                <p className="mt-0.5 truncate text-[11px] text-slate-500">
                  {v.roomName ? `${v.roomName} · ` : ""}{timeAgo(v.watchedAt)}
                </p>
              </button>
              <button
                onClick={() => remove(v.id)}
                className="absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-full bg-black/70 text-white opacity-100 transition sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100"
                aria-label={`Remove ${title} from recently watched`}
              >
                <X size={12} />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
