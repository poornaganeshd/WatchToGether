import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import ReactPlayer from "react-player";
import { ArrowLeft, Clapperboard, MessageSquare } from "lucide-react";
import api, { getErrorMessage } from "../lib/api";
import { formatClock, timeAgo } from "../lib/format";
import Logo from "../components/ui/Logo";
import Avatar from "../components/ui/Avatar";
import Spinner from "../components/ui/Spinner";

interface ReplayMessage {
  id: string;
  userId: string;
  userName: string;
  avatarVersion: number | null;
  content: string;
  videoTime: number;
}

const describe = (url: string) => {
  try {
    const u = new URL(url);
    const yt = u.searchParams.get("v") || (u.hostname === "youtu.be" ? u.pathname.slice(1) : null);
    return yt ? `YouTube · ${yt}` : decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() || u.hostname);
  } catch {
    return url;
  }
};

// Unwrap default export for Vite ESM compatibility with react-player v2
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Player: any = (ReactPlayer as any).default || ReactPlayer;

export default function Replay() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const videoUrl = params.get("url");
  const [roomName, setRoomName] = useState("");
  const [replays, setReplays] = useState<{ videoUrl: string; messageCount: number; lastAt: string }[] | null>(null);
  const [messages, setMessages] = useState<ReplayMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const playerRef = useRef<ReactPlayer>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const load = videoUrl
      ? api.get(`/rooms/${id}/replay`, { params: { url: videoUrl } }).then((res) => {
          if (cancelled) return;
          setRoomName(res.data.roomName);
          setMessages(res.data.messages);
        })
      : api.get(`/rooms/${id}/replays`).then((res) => {
          if (cancelled) return;
          setRoomName(res.data.roomName);
          setReplays(res.data.replays);
        });
    load.catch((err) => !cancelled && setError(getErrorMessage(err, "Couldn't load replays")));
    return () => {
      cancelled = true;
    };
  }, [id, videoUrl]);

  const visible = useMemo(
    () => (messages ?? []).filter((m) => showAll || m.videoTime <= currentTime + 0.25),
    [messages, currentTime, showAll]
  );

  // Keep the newest revealed message in view while watching.
  useEffect(() => {
    if (!showAll && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [visible.length, showAll]);

  // Where the chat was busiest, as a strip under the player.
  const heat = useMemo(() => {
    if (!messages?.length || !duration) return [];
    const buckets = new Array(60).fill(0);
    for (const m of messages) buckets[Math.min(59, Math.floor((m.videoTime / duration) * 60))]++;
    const max = Math.max(...buckets);
    return buckets.map((b) => (max ? b / max : 0));
  }, [messages, duration]);

  const seek = (t: number) => playerRef.current?.seekTo(t, "seconds");

  return (
    <div className="min-h-screen">
      <header className="border-b border-white/5 bg-ink-950/70 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6">
          <Logo to="/dashboard" size="sm" />
          <Link to={videoUrl ? `/room/${id}/replay` : "/dashboard"} className="btn-ghost px-3">
            <ArrowLeft size={16} /> {videoUrl ? "All replays" : "Dashboard"}
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
        <p className="text-sm text-slate-400">Chat replay</p>
        <h1 className="mb-6 font-display text-2xl font-bold">{roomName || "…"}</h1>

        {error ? (
          <p className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</p>
        ) : !videoUrl ? (
          replays === null ? (
            <div className="grid h-40 place-items-center text-slate-500"><Spinner /></div>
          ) : replays.length === 0 ? (
            <div className="card flex flex-col items-center p-10 text-center">
              <Clapperboard size={28} className="mb-2 text-slate-500" />
              <p className="font-medium text-slate-200">Nothing to replay yet</p>
              <p className="mt-1 text-sm text-slate-500">Chat sent while a video plays shows up here afterwards.</p>
            </div>
          ) : (
            <div className="card divide-y divide-white/5">
              {replays.map((r) => (
                <button
                  key={r.videoUrl}
                  onClick={() => setParams({ url: r.videoUrl })}
                  className="flex w-full items-center justify-between gap-4 p-4 text-left hover:bg-white/[0.03]"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-white" title={r.videoUrl}>{describe(r.videoUrl)}</span>
                    <span className="text-xs text-slate-500">Last chat {timeAgo(r.lastAt)}</span>
                  </span>
                  <span className="chip shrink-0 border-indigo-400/30 bg-indigo-500/10 text-indigo-200">
                    <MessageSquare size={12} /> {r.messageCount}
                  </span>
                </button>
              ))}
            </div>
          )
        ) : (
          <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
            <div>
              <div className="relative aspect-video overflow-hidden rounded-2xl bg-black ring-1 ring-white/10">
                <Player
                  ref={playerRef}
                  url={videoUrl}
                  width="100%"
                  height="100%"
                  controls
                  progressInterval={250}
                  onProgress={(s: { playedSeconds: number }) => setCurrentTime(s.playedSeconds)}
                  onSeek={(t: number) => setCurrentTime(t)}
                  onDuration={(d: number) => setDuration(d)}
                  style={{ position: "absolute", top: 0, left: 0 }}
                />
              </div>
              {heat.length > 0 && (
                <div className="mt-2">
                  <div className="flex h-6 items-end gap-px" aria-label="Chat activity over the video">
                    {heat.map((h, i) => (
                      <button
                        key={i}
                        onClick={() => seek((i / 60) * duration)}
                        className="flex-1 rounded-sm bg-indigo-400/70 transition-opacity hover:opacity-100"
                        style={{ height: `${Math.max(8, h * 100)}%`, opacity: h ? 0.35 + h * 0.65 : 0.12 }}
                        title={`Jump to ${formatClock((i / 60) * duration)}`}
                        aria-label={`Jump to ${formatClock((i / 60) * duration)}`}
                      />
                    ))}
                  </div>
                  <p className="mt-1 text-[11px] text-slate-500">Chat activity — click to jump</p>
                </div>
              )}
            </div>

            <aside className="card flex h-[32rem] flex-col overflow-hidden lg:h-auto lg:max-h-[36rem]">
              <div className="flex items-center justify-between border-b border-white/5 px-4 py-3">
                <span className="text-sm font-semibold">
                  Chat · {visible.length}/{messages?.length ?? 0}
                </span>
                <label className="flex items-center gap-1.5 text-xs text-slate-400">
                  <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} className="accent-indigo-500" />
                  Show all
                </label>
              </div>
              <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto p-4">
                {messages === null ? (
                  <div className="grid h-full place-items-center text-slate-500"><Spinner /></div>
                ) : visible.length === 0 ? (
                  <p className="pt-10 text-center text-sm text-slate-500">Press play — messages appear when they were sent.</p>
                ) : (
                  visible.map((m) => (
                    <div key={m.id} className={`flex gap-2 animate-fade-up ${m.videoTime > currentTime + 0.25 ? "opacity-40" : ""}`}>
                      <Avatar name={m.userName} seed={m.userId} version={m.avatarVersion} size={26} />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 text-[11px]">
                          <span className="font-semibold text-slate-300">{m.userName}</span>
                          <button onClick={() => seek(m.videoTime)} className="font-mono text-indigo-300 hover:text-indigo-200" title="Jump here">
                            {formatClock(m.videoTime)}
                          </button>
                        </div>
                        <p className="whitespace-pre-wrap break-words text-sm text-slate-200">{m.content}</p>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </aside>
          </div>
        )}
      </main>
    </div>
  );
}
