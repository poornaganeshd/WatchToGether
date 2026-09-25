import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, ChevronDown, ChevronRight, ChevronUp, Clock, Crown, History, ListPlus, ListVideo, MessageSquare, Mic2, Play, Plus, SendHorizonal, Settings, Share2, Shield, ShieldOff, SkipForward, Trash2, Users, UserX, X } from "lucide-react";
import { mentionsUser, useSocketStore, type Message, type QueueItem } from "../store/useSocketStore";
import { useAudioStore } from "../store/useAudioStore";
import { PollCard, PollComposer } from "./Polls";
import { BarChart3, MicOff, Timer, Volume2, VolumeX } from "lucide-react";
import { timeAgo } from "../lib/format";
import Avatar from "./ui/Avatar";

const TIMESTAMP_REGEX = /\[Time:\s*(\d{1,2}:\d{2}(?::\d{2})?)\]/g;
const GROUP_WINDOW_MS = 2 * 60 * 1000;

interface ChatPanelProps {
  roomId: string;
  currentUser: { id: string; name: string };
  isHost: boolean;
  hostId: string | null;
  coHostIds: string[];
  hostAnnouncementActive: boolean;
  onToggleAnnouncement: () => void;
  onSeek: (timeStr: string) => void;
  getTimestamp: () => string | null;
  onOpenInvite: () => void;
  onOpenSettings: () => void;
  onClose: () => void;
  onMakeCoHost: (socketId: string) => void;
  onKick: (socketId: string, name: string) => void;
}

const TYPING_IDLE_MS = 3000;
const MENTION_TOKEN = /(@[\p{L}\p{N}_.-]+)/u;
const TRAILING_MENTION = /(^|\s)@([^\s@]*)$/;

const describeUrl = (url: string) => {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    const ytId = parsed.searchParams.get("v") || (host === "youtu.be" ? parsed.pathname.slice(1) : null);
    if (ytId) return { title: `YouTube · ${ytId}`, host, thumb: `https://i.ytimg.com/vi/${ytId}/mqdefault.jpg` };
    const file = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() || host);
    return { title: file, host, thumb: null };
  } catch {
    return { title: url, host: "", thumb: null };
  }
};

const formatTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export default function ChatPanel({
  roomId, currentUser, isHost, hostId, coHostIds, hostAnnouncementActive, onToggleAnnouncement, onSeek, getTimestamp,
  onOpenInvite, onOpenSettings, onClose, onMakeCoHost, onKick,
}: ChatPanelProps) {
  const messages = useSocketStore((s) => s.messages);
  const participants = useSocketStore((s) => s.participants);
  const sendMessage = useSocketStore((s) => s.sendMessage);
  const setChatVisible = useSocketStore((s) => s.setChatVisible);
  const setTyping = useSocketStore((s) => s.setTyping);
  const typingUsers = useSocketStore((s) => s.typingUsers);
  const queue = useSocketStore((s) => s.queue);
  const skipVotes = useSocketStore((s) => s.skipVotes);
  const viewerSync = useSocketStore((s) => s.viewerSync);
  const recentlyPlayed = useSocketStore((s) => s.recentlyPlayed);
  const [mentionIndex, setMentionIndex] = useState(0);
  const poll = useSocketStore((s) => s.poll);
  const chatSettings = useSocketStore((s) => s.chatSettings);
  const peerVolumes = useAudioStore((s) => s.peerVolumes);
  const setPeerVolume = useAudioStore((s) => s.setPeerVolume);
  const [composerOpen, setComposerOpen] = useState(false);
  const [volumeFor, setVolumeFor] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // Timed mutes lapse on their own; tick so the UI notices without a server update.
  useEffect(() => {
    if (!chatSettings.muted.some((m) => m.until !== null)) return;
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, [chatSettings.muted]);
  const muteOf = (uid: string) => chatSettings.muted.find((m) => m.userId === uid && (m.until === null || m.until > now));
  const myMute = muteOf(currentUser.id) ?? null;
  const socket = useSocketStore((s) => s.socket);
  const [tab, setTab] = useState<"chat" | "queue" | "people">("chat");
  const [queueUrl, setQueueUrl] = useState("");
  const isTypingRef = useRef(false);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [input, setInput] = useState("");
  const [isPinnedToBottom, setIsPinnedToBottom] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setChatVisible(true);
    return () => setChatVisible(false);
  }, [setChatVisible]);

  const stopTyping = () => {
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    if (isTypingRef.current) {
      isTypingRef.current = false;
      setTyping(roomId, false);
    }
  };

  // Tell others we stopped typing if the panel closes mid-sentence.
  useEffect(() => () => {
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    if (isTypingRef.current) setTyping(roomId, false);
  }, [roomId, setTyping]);

  const handleInputChange = (value: string) => {
    setInput(value);
    if (!value.trim()) {
      stopTyping();
      return;
    }
    if (!isTypingRef.current) {
      isTypingRef.current = true;
      setTyping(roomId, true);
    }
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(stopTyping, TYPING_IDLE_MS);
  };

  const handleAddToQueue = (e: React.FormEvent) => {
    e.preventDefault();
    let url = queueUrl.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    socket?.emit("queue_add", { roomId, url });
    setQueueUrl("");
  };

  const queueAction = (event: "queue_play" | "queue_remove", item: QueueItem) => socket?.emit(event, { roomId, itemId: item.id });
  const moveItem = (item: QueueItem, direction: "up" | "down") => socket?.emit("queue_move", { roomId, itemId: item.id, direction });

  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el || tab !== "chat") return;
    const lastIsMine = messages[messages.length - 1]?.userId === currentUser.id;
    if (isPinnedToBottom || lastIsMine) {
      el.scrollTop = el.scrollHeight;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, tab]);

  const handleScroll = () => {
    const el = listRef.current;
    if (!el) return;
    setIsPinnedToBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  };

  const scrollToBottom = () => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  };

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    const content = input.trim();
    if (!content) return;
    sendMessage(roomId, currentUser.id, currentUser.name, content.slice(0, 1000));
    setInput("");
    stopTyping();
  };

  const insertTimestamp = () => {
    const ts = getTimestamp();
    if (!ts) return;
    setInput((prev) => `${prev}${prev && !prev.endsWith(" ") ? " " : ""}[Time: ${ts}] `);
    inputRef.current?.focus();
  };

  const renderMentions = (text: string, key: number) => {
    const pieces = text.split(MENTION_TOKEN);
    if (pieces.length === 1) return <span key={key}>{text}</span>;
    return (
      <span key={key}>
        {pieces.map((piece, j) =>
          j % 2 === 1 ? (
            <span
              key={j}
              className={`rounded px-0.5 font-semibold ${mentionsUser(piece, currentUser.name) ? "bg-amber-400/25 text-amber-200" : "text-indigo-200"}`}
            >
              {piece}
            </span>
          ) : (
            piece
          )
        )}
      </span>
    );
  };

  const renderContent = (content: string) => {
    const parts = content.split(TIMESTAMP_REGEX);
    if (parts.length === 1) return renderMentions(content, 0);
    return parts.map((part, i) =>
      i % 2 === 1 ? (
        <button
          key={i}
          onClick={() => onSeek(part)}
          disabled={!isHost}
          className="mx-0.5 inline-flex items-center gap-1 rounded-md bg-black/25 px-1.5 py-0.5 font-mono text-[12px] text-indigo-200 transition-colors enabled:hover:bg-black/40 disabled:cursor-default"
          title={isHost ? "Jump to this moment" : "Only hosts can seek"}
        >
          <Clock size={11} /> {part}
        </button>
      ) : (
        renderMentions(part, i)
      )
    );
  };

  const people = Object.values(participants)
    // One entry per user even if they have several tabs open.
    .filter((p, i, arr) => arr.findIndex((o) => o.userId === p.userId) === i)
    .sort((a, b) => {
      const rank = (uid: string) => (uid === hostId ? 0 : coHostIds.includes(uid) ? 1 : 2);
      return rank(a.userId) - rank(b.userId) || a.userName.localeCompare(b.userName);
    });

  // @-mention autocomplete for the word being typed at the end of the input.
  const mentionMatch = input.match(TRAILING_MENTION);
  const mentionQuery = mentionMatch ? mentionMatch[2].toLowerCase() : null;
  const mentionSuggestions =
    mentionQuery === null
      ? []
      : people
          .filter((p) => p.userId !== currentUser.id && p.userName.toLowerCase().includes(mentionQuery))
          .slice(0, 5);
  const activeMention = Math.min(mentionIndex, Math.max(0, mentionSuggestions.length - 1));

  const insertMention = (name: string) => {
    setInput((prev) => prev.replace(TRAILING_MENTION, (_m, lead) => `${lead}@${name} `));
    setMentionIndex(0);
    inputRef.current?.focus();
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (mentionSuggestions.length === 0) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const delta = e.key === "ArrowDown" ? 1 : -1;
      setMentionIndex((activeMention + delta + mentionSuggestions.length) % mentionSuggestions.length);
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      insertMention(mentionSuggestions[activeMention].userName);
    } else if (e.key === "Escape") {
      setInput((prev) => `${prev} `);
    }
  };

  const canModerate = isHost;

  return (
    <aside className="fixed inset-y-0 right-0 z-[9999] flex h-full w-full flex-col border-l border-white/5 bg-ink-900/95 shadow-2xl backdrop-blur-xl animate-slide-in-right md:relative md:z-20 md:w-80 lg:w-96">
      <div className="flex items-center justify-between gap-2 border-b border-white/5 px-3 py-2.5">
        <div className="flex rounded-lg bg-white/[0.04] p-0.5">
          {([
            { id: "chat", label: "Chat", icon: MessageSquare },
            { id: "queue", label: queue.length ? `Queue · ${queue.length}` : "Queue", icon: ListVideo },
            { id: "people", label: `${people.length}`, icon: Users },
          ] as const).map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-semibold transition-colors ${tab === id ? "bg-white/10 text-white" : "text-slate-400 hover:text-slate-200"}`}
              aria-label={id === "people" ? `People, ${people.length}` : undefined}
            >
              <Icon size={13} /> {label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-0.5">
          <button onClick={onOpenInvite} className="btn-ghost px-2 py-1.5" title="Invite people" aria-label="Invite people">
            <Share2 size={16} />
          </button>
          <button onClick={onOpenSettings} className="btn-ghost px-2 py-1.5" title="Audio settings" aria-label="Audio settings">
            <Settings size={16} />
          </button>
          <button onClick={onClose} className="btn-ghost px-2 py-1.5" title="Close panel" aria-label="Close panel">
            <ChevronRight size={18} />
          </button>
        </div>
      </div>

      {isHost && (
        <div className="border-b border-white/5 px-3 py-2">
          <button
            onClick={onToggleAnnouncement}
            className={`flex w-full items-center justify-center gap-2 rounded-lg border py-1.5 text-xs font-semibold transition-colors ${
              hostAnnouncementActive
                ? "border-red-500/40 bg-red-500/15 text-red-300"
                : "border-white/10 bg-white/[0.03] text-slate-300 hover:bg-white/[0.07]"
            }`}
          >
            <Mic2 size={13} className={hostAnnouncementActive ? "animate-pulse" : ""} />
            {hostAnnouncementActive ? "Stop announcement" : "Host announcement"}
          </button>
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={() => setComposerOpen(true)}
              disabled={!!poll && !poll.closed}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] py-1.5 text-xs font-semibold text-slate-300 transition-colors hover:bg-white/[0.07] disabled:opacity-40"
              title={poll && !poll.closed ? "Close the current poll first" : "Start a poll"}
            >
              <BarChart3 size={13} /> New poll
            </button>
            <label className="flex flex-1 items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1 text-xs text-slate-300">
              <Timer size={13} className={chatSettings.slowModeSeconds ? "text-amber-300" : "text-slate-400"} />
              <select
                value={chatSettings.slowModeSeconds}
                onChange={(e) => socket?.emit("set_slow_mode", { roomId, seconds: Number(e.target.value) })}
                className="min-w-0 flex-1 bg-transparent py-0.5 text-xs font-semibold focus:outline-none"
                aria-label="Slow mode"
              >
                {[0, 5, 10, 30, 60].map((sec) => (
                  <option key={sec} value={sec} className="bg-ink-900">{sec ? `Slow mode ${sec}s` : "Slow mode off"}</option>
                ))}
              </select>
            </label>
          </div>
        </div>
      )}
      <PollComposer roomId={roomId} isOpen={composerOpen} onClose={() => setComposerOpen(false)} />

      {tab === "chat" ? (
        <>
          <PollCard roomId={roomId} canManage={isHost} />
          <div className="relative flex-1 overflow-hidden">
            <div ref={listRef} onScroll={handleScroll} className="h-full overflow-y-auto px-3 py-4">
              {messages.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center text-center text-slate-500">
                  <MessageSquare size={28} className="mb-2 opacity-50" />
                  <p className="text-sm">No messages yet</p>
                  <p className="text-xs">Say hi and get the party started 🎉</p>
                </div>
              ) : (
                messages.map((msg, idx) => (
                  <ChatMessage
                    key={msg.id}
                    msg={msg}
                    prev={messages[idx - 1]}
                    isMe={msg.userId === currentUser.id}
                    isHostUser={msg.userId === hostId}
                    mentionsMe={msg.userId !== currentUser.id && mentionsUser(msg.content, currentUser.name)}
                    onDelete={
                      msg.userId === currentUser.id || canModerate
                        ? () => socket?.emit("delete_message", { roomId, messageId: msg.id })
                        : undefined
                    }
                    render={renderContent}
                  />
                ))
              )}
            </div>
            {!isPinnedToBottom && (
              <button
                onClick={scrollToBottom}
                className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-white/10 bg-ink-800/95 px-3 py-1 text-xs font-medium text-slate-200 shadow-lg animate-fade-up"
              >
                <ArrowDown size={12} /> Latest
              </button>
            )}
          </div>

          {Object.keys(typingUsers).length > 0 && (
            <div className="flex items-center gap-2 px-4 pb-1 text-[11px] text-slate-400 animate-fade-in" aria-live="polite">
              <span className="flex gap-0.5">
                {[0, 150, 300].map((d) => (
                  <span key={d} className="h-1 w-1 animate-bounce rounded-full bg-slate-400" style={{ animationDelay: `${d}ms` }} />
                ))}
              </span>
              {(() => {
                const names = Array.from(new Set(Object.values(typingUsers)));
                if (names.length === 1) return `${names[0]} is typing…`;
                if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
                return "Several people are typing…";
              })()}
            </div>
          )}

          {(myMute || chatSettings.slowModeSeconds > 0) && (
            <div className={`mx-3 mb-1 flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] ${myMute ? "bg-red-500/10 text-red-300" : "bg-amber-400/10 text-amber-200"}`}>
              {myMute ? <MicOff size={12} /> : <Timer size={12} />}
              {myMute
                ? myMute.until
                  ? `You're muted until ${new Date(myMute.until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
                  : "You've been muted by the host"
                : `Slow mode: one message every ${chatSettings.slowModeSeconds}s${isHost ? " (hosts are exempt)" : ""}`}
            </div>
          )}
          <form onSubmit={handleSend} className="relative flex items-center gap-2 border-t border-white/5 p-3">
            {mentionSuggestions.length > 0 && (
              <div className="absolute bottom-full left-3 right-3 mb-1 overflow-hidden rounded-xl border border-white/10 bg-ink-850/95 shadow-2xl backdrop-blur-xl animate-fade-up" role="listbox" aria-label="Mention someone">
                {mentionSuggestions.map((p, i) => (
                  <button
                    key={p.socketId}
                    type="button"
                    role="option"
                    aria-selected={i === activeMention}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      insertMention(p.userName);
                    }}
                    className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm ${i === activeMention ? "bg-white/10 text-white" : "text-slate-300 hover:bg-white/5"}`}
                  >
                    <Avatar name={p.userName} seed={p.userId} size={22} /> {p.userName}
                  </button>
                ))}
              </div>
            )}
            <div className="flex flex-1 items-center rounded-xl border border-white/10 bg-ink-950/80 pr-1 focus-within:border-indigo-400/50 focus-within:ring-2 focus-within:ring-indigo-500/20">
              <input
                ref={inputRef}
                type="text"
                value={input}
                maxLength={1000}
                onChange={(e) => {
                  handleInputChange(e.target.value);
                  setMentionIndex(0);
                }}
                onKeyDown={handleInputKeyDown}
                onBlur={stopTyping}
                disabled={!!myMute}
                placeholder={myMute ? "You're muted" : "Send a message"}
                className="min-w-0 flex-1 bg-transparent px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none"
              />
              <button
                type="button"
                onClick={insertTimestamp}
                className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-white/5 hover:text-white"
                title="Insert current video time"
                aria-label="Insert current video time"
              >
                <Clock size={16} />
              </button>
            </div>
            <button type="submit" disabled={!input.trim()} className="btn-primary h-10 w-10 shrink-0 p-0" aria-label="Send message">
              <SendHorizonal size={16} />
            </button>
          </form>
        </>
      ) : tab === "queue" ? (
        <div className="flex flex-1 flex-col overflow-hidden">
          <form onSubmit={handleAddToQueue} className="flex gap-2 border-b border-white/5 p-3">
            <input
              value={queueUrl}
              onChange={(e) => setQueueUrl(e.target.value)}
              placeholder="Suggest a video link"
              className="input py-2"
              maxLength={2000}
            />
            <button type="submit" disabled={!queueUrl.trim()} className="btn-primary h-10 w-10 shrink-0 p-0" aria-label="Add to queue">
              <Plus size={16} />
            </button>
          </form>
          {queue.length > 0 && (
            <div className="flex items-center justify-between gap-2 border-b border-white/5 px-3 py-2">
              <div className="text-xs text-slate-400">
                <span className="font-semibold text-slate-200">{skipVotes.count}</span> of {skipVotes.needed} votes to skip
                <div className="mt-1 h-1 w-32 overflow-hidden rounded-full bg-white/10">
                  <div className="h-full rounded-full bg-gradient-to-r from-indigo-400 to-fuchsia-400 transition-all" style={{ width: `${Math.min(100, (skipVotes.count / Math.max(1, skipVotes.needed)) * 100)}%` }} />
                </div>
              </div>
              {(() => {
                const voted = skipVotes.voters.includes(currentUser.id);
                return (
                  <button
                    onClick={() => socket?.emit("vote_skip", { roomId })}
                    className={`${voted ? "btn-primary" : "btn-secondary"} px-3 py-1.5 text-xs`}
                    aria-pressed={voted}
                    title={voted ? "Withdraw your vote" : "Vote to skip to the next video"}
                  >
                    <SkipForward size={14} /> {voted ? "Voted" : "Vote skip"}
                  </button>
                );
              })()}
            </div>
          )}
          <div className="flex-1 space-y-2 overflow-y-auto p-3">
            {queue.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center text-center text-slate-500">
                <ListVideo size={28} className="mb-2 opacity-50" />
                <p className="text-sm">The queue is empty</p>
                <p className="max-w-[16rem] text-xs">Add links here. {isHost ? "The next one plays automatically when the current video ends." : "The host decides what plays next."}</p>
              </div>
            ) : (
              queue.map((item, index) => {
                const info = describeUrl(item.url);
                const canRemove = isHost || item.addedBy === currentUser.id;
                return (
                  <div key={item.id} className="group flex items-center gap-3 rounded-xl border border-white/5 bg-white/[0.02] p-2">
                    <div className="relative grid h-12 w-20 shrink-0 place-items-center overflow-hidden rounded-lg bg-ink-800 text-slate-500">
                      {info.thumb ? <img src={info.thumb} alt="" className="h-full w-full object-cover" loading="lazy" /> : <ListVideo size={18} />}
                      <span className="absolute left-1 top-1 rounded bg-black/70 px-1 text-[10px] font-bold text-white">{index + 1}</span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-slate-100" title={item.url}>{info.title}</p>
                      <p className="truncate text-[11px] text-slate-500">{info.host} · {item.addedBy === currentUser.id ? "you" : item.addedByName}</p>
                    </div>
                    <div className="flex shrink-0 items-center">
                      {isHost && (
                        <>
                          <button onClick={() => queueAction("queue_play", item)} className="btn-ghost p-1.5 text-indigo-300" title="Play now" aria-label="Play now">
                            <Play size={14} />
                          </button>
                          <div className="flex flex-col">
                            <button onClick={() => moveItem(item, "up")} disabled={index === 0} className="text-slate-500 hover:text-white disabled:opacity-20" aria-label="Move up"><ChevronUp size={14} /></button>
                            <button onClick={() => moveItem(item, "down")} disabled={index === queue.length - 1} className="text-slate-500 hover:text-white disabled:opacity-20" aria-label="Move down"><ChevronDown size={14} /></button>
                          </div>
                        </>
                      )}
                      {canRemove && (
                        <button onClick={() => queueAction("queue_remove", item)} className="btn-ghost p-1.5 hover:text-red-300" title="Remove" aria-label="Remove from queue">
                          <X size={14} />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })
            )}
            {recentlyPlayed.length > 0 && (
              <div className="pt-4">
                <h4 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  <History size={12} /> Recently played
                </h4>
                <div className="space-y-1">
                  {recentlyPlayed.map((item) => {
                    const info = describeUrl(item.url);
                    const alreadyQueued = queue.some((q) => q.url === item.url);
                    return (
                      <div key={item.url} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-white/[0.03]">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs text-slate-300" title={item.url}>{info.title}</p>
                          <p className="text-[10px] text-slate-600">{timeAgo(new Date(item.playedAt))}</p>
                        </div>
                        <button
                          onClick={() => socket?.emit("queue_add", { roomId, url: item.url })}
                          disabled={alreadyQueued}
                          className="btn-ghost p-1.5 text-slate-400 disabled:opacity-30"
                          title={alreadyQueued ? "Already in the queue" : "Add to queue again"}
                          aria-label="Add to queue again"
                        >
                          <ListPlus size={14} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="flex-1 space-y-1 overflow-y-auto p-3">
          {people.map((p) => {
            const isRoomHost = p.userId === hostId;
            const isCo = coHostIds.includes(p.userId);
            const isMe = p.userId === currentUser.id;
            const mute = muteOf(p.userId);
            const volume = peerVolumes[p.userId] ?? 1;
            const canMute = isHost && !isRoomHost && !isMe && (!isCo || hostId === currentUser.id);
            return (
              <div key={p.socketId} className="rounded-xl hover:bg-white/[0.03]">
              <div className="group flex items-center gap-3 p-2">
                <Avatar name={p.userName} seed={p.userId} size={34} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-100">
                    {p.userName}
                    {p.userId === currentUser.id && <span className="ml-1 text-slate-500">(you)</span>}
                  </p>
                  <p className="flex items-center gap-1.5 text-xs text-slate-500">
                    {isRoomHost ? "Host" : isCo ? "Co-host" : "Viewer"}
                    {mute && <span className="inline-flex items-center gap-0.5 text-red-300">· <MicOff size={10} /> muted</span>}
                    {!isRoomHost && <SyncBadge report={viewerSync[p.socketId]} />}
                  </p>
                </div>
                {isRoomHost ? (
                  <Crown size={15} className="text-amber-400" aria-label="Host" />
                ) : isCo ? (
                  <Shield size={15} className="text-indigo-300" aria-label="Co-host" />
                ) : null}
                {isCo && (hostId === currentUser.id || p.userId === currentUser.id) && (
                  <button
                    onClick={() => socket?.emit("remove_cohost", { roomId, targetUserId: p.userId })}
                    className="btn-ghost p-1.5 opacity-60 transition-opacity hover:text-amber-300 group-hover:opacity-100"
                    title={p.userId === currentUser.id ? "Step down as co-host" : "Remove co-host"}
                    aria-label={p.userId === currentUser.id ? "Step down as co-host" : `Remove ${p.userName} as co-host`}
                  >
                    <ShieldOff size={14} />
                  </button>
                )}
                {!isMe && (
                  <button
                    onClick={() => setVolumeFor((v) => (v === p.socketId ? null : p.socketId))}
                    className={`btn-ghost p-1.5 transition-opacity group-hover:opacity-100 ${volume < 1 ? "text-amber-300 opacity-100" : "opacity-60"}`}
                    title={`Their voice volume: ${Math.round(volume * 100)}%`}
                    aria-label={`Adjust ${p.userName}'s volume`}
                    aria-expanded={volumeFor === p.socketId}
                  >
                    {volume === 0 ? <VolumeX size={14} /> : <Volume2 size={14} />}
                  </button>
                )}
                {canMute && (
                  <select
                    value=""
                    onChange={(e) => {
                      const v = e.target.value;
                      socket?.emit("mute_user", { roomId, targetUserId: p.userId, minutes: v === "forever" ? null : Number(v) });
                    }}
                    className="w-7 cursor-pointer appearance-none rounded-md bg-transparent p-1.5 text-center text-xs text-slate-400 opacity-60 hover:bg-white/5 hover:text-white group-hover:opacity-100"
                    title={mute ? "Unmute or change mute" : "Mute in chat"}
                    aria-label={`Chat mute options for ${p.userName}`}
                  >
                    <option value="" disabled className="bg-ink-900">{mute ? "🔇" : "💬"}</option>
                    {mute && <option value="0" className="bg-ink-900">Unmute</option>}
                    <option value="5" className="bg-ink-900">Mute 5 min</option>
                    <option value="15" className="bg-ink-900">Mute 15 min</option>
                    <option value="60" className="bg-ink-900">Mute 1 hour</option>
                    <option value="forever" className="bg-ink-900">Mute until unmuted</option>
                  </select>
                )}
                {isHost && !isRoomHost && p.userId !== currentUser.id && (
                  <div className="flex items-center opacity-60 transition-opacity group-hover:opacity-100">
                    {hostId === currentUser.id && !isCo && (
                      <button onClick={() => onMakeCoHost(p.socketId)} className="btn-ghost p-1.5 hover:text-amber-300" title="Make co-host" aria-label={`Make ${p.userName} co-host`}>
                        <Crown size={14} />
                      </button>
                    )}
                    {(!isCo || hostId === currentUser.id) && (
                      <button onClick={() => onKick(p.socketId, p.userName)} className="btn-ghost p-1.5 hover:text-red-300" title="Remove from room" aria-label={`Remove ${p.userName}`}>
                        <UserX size={14} />
                      </button>
                    )}
                  </div>
                )}
              </div>
              {volumeFor === p.socketId && (
                <div className="flex items-center gap-3 px-3 pb-2 animate-fade-up">
                  <VolumeX size={13} className="shrink-0 text-slate-500" />
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={Math.round(volume * 100)}
                    onChange={(e) => setPeerVolume(p.userId, Number(e.target.value) / 100)}
                    className="flex-1 accent-indigo-500"
                    aria-label={`${p.userName}'s volume`}
                  />
                  <span className="w-9 text-right font-mono text-[11px] text-slate-400">{Math.round(volume * 100)}%</span>
                </div>
              )}
              </div>
            );
          })}
          {people.length === 0 && <p className="py-8 text-center text-sm text-slate-500">Connecting…</p>}
        </div>
      )}
    </aside>
  );
}

function ChatMessage({
  msg, prev, isMe, isHostUser, mentionsMe, onDelete, render,
}: {
  msg: Message;
  prev?: Message;
  isMe: boolean;
  isHostUser: boolean;
  mentionsMe: boolean;
  onDelete?: () => void;
  render: (content: string) => React.ReactNode;
}) {
  const grouped = !!prev && prev.userId === msg.userId && new Date(msg.createdAt).getTime() - new Date(prev.createdAt).getTime() < GROUP_WINDOW_MS;

  return (
    <div className={`group/msg flex gap-2 ${isMe ? "flex-row-reverse" : ""} ${grouped ? "mt-0.5" : "mt-3 first:mt-0"}`}>
      <div className="w-7 shrink-0">{!grouped && !isMe && <Avatar name={msg.userName} seed={msg.userId} size={28} />}</div>
      <div className={`flex max-w-[80%] flex-col ${isMe ? "items-end" : "items-start"}`}>
        {!grouped && (
          <div className={`mb-1 flex items-center gap-1.5 text-[11px] ${isMe ? "flex-row-reverse" : ""}`}>
            <span className="font-semibold text-slate-300">{isMe ? "You" : msg.userName}</span>
            {isHostUser && <Crown size={10} className="text-amber-400" />}
            <span className="text-slate-600">{formatTime(msg.createdAt)}</span>
          </div>
        )}
        <div className={`flex items-center gap-1 ${isMe ? "flex-row-reverse" : ""}`}>
          <div
            className={`whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm leading-relaxed ${
              isMe
                ? "rounded-tr-md bg-gradient-to-br from-indigo-500 to-violet-500 text-white"
                : mentionsMe
                  ? "rounded-tl-md bg-amber-400/10 text-slate-100 ring-1 ring-amber-400/40"
                  : "rounded-tl-md bg-white/[0.06] text-slate-200"
            }`}
            title={formatTime(msg.createdAt)}
          >
            {render(msg.content)}
          </div>
          {onDelete && (
            <button
              onClick={onDelete}
              className="shrink-0 rounded-md p-1 text-slate-500 opacity-0 transition-opacity hover:bg-white/5 hover:text-red-300 focus:opacity-100 group-hover/msg:opacity-100"
              title="Delete message"
              aria-label="Delete message"
            >
              <Trash2 size={13} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function SyncBadge({ report }: { report?: { state: "synced" | "drifting" | "buffering" | "error"; drift: number } }) {
  if (!report) return null;
  const styles = {
    synced: { dot: "bg-emerald-400", text: "text-emerald-300", label: "In sync" },
    drifting: { dot: "bg-amber-400", text: "text-amber-300", label: `${report.drift > 0 ? "Behind" : "Ahead"} ${Math.abs(report.drift).toFixed(1)}s` },
    buffering: { dot: "bg-amber-400 animate-pulse", text: "text-amber-300", label: "Buffering" },
    error: { dot: "bg-red-400", text: "text-red-300", label: "Can't play" },
  }[report.state];
  return (
    <span className={`inline-flex items-center gap-1 ${styles.text}`}>
      · <span className={`h-1.5 w-1.5 rounded-full ${styles.dot}`} /> {styles.label}
    </span>
  );
}
