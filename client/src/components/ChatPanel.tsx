import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, ChevronRight, Clock, Crown, MessageSquare, Mic2, SendHorizonal, Settings, Share2, Shield, Users } from "lucide-react";
import { useSocketStore, type Message } from "../store/useSocketStore";
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
}

const formatTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export default function ChatPanel({
  roomId, currentUser, isHost, hostId, coHostIds, hostAnnouncementActive, onToggleAnnouncement, onSeek, getTimestamp,
  onOpenInvite, onOpenSettings, onClose,
}: ChatPanelProps) {
  const messages = useSocketStore((s) => s.messages);
  const participants = useSocketStore((s) => s.participants);
  const sendMessage = useSocketStore((s) => s.sendMessage);
  const setChatVisible = useSocketStore((s) => s.setChatVisible);
  const [tab, setTab] = useState<"chat" | "people">("chat");
  const [input, setInput] = useState("");
  const [isPinnedToBottom, setIsPinnedToBottom] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setChatVisible(true);
    return () => setChatVisible(false);
  }, [setChatVisible]);

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
  };

  const insertTimestamp = () => {
    const ts = getTimestamp();
    if (!ts) return;
    setInput((prev) => `${prev}${prev && !prev.endsWith(" ") ? " " : ""}[Time: ${ts}] `);
    inputRef.current?.focus();
  };

  const renderContent = (content: string) => {
    const parts = content.split(TIMESTAMP_REGEX);
    if (parts.length === 1) return content;
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
        <span key={i}>{part}</span>
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

  return (
    <aside className="fixed inset-y-0 right-0 z-[9999] flex h-full w-full flex-col border-l border-white/5 bg-ink-900/95 shadow-2xl backdrop-blur-xl animate-slide-in-right md:relative md:z-20 md:w-80 lg:w-96">
      <div className="flex items-center justify-between gap-2 border-b border-white/5 px-3 py-2.5">
        <div className="flex rounded-lg bg-white/[0.04] p-0.5">
          {([
            { id: "chat", label: "Chat", icon: MessageSquare },
            { id: "people", label: `People · ${people.length}`, icon: Users },
          ] as const).map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${tab === id ? "bg-white/10 text-white" : "text-slate-400 hover:text-slate-200"}`}
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
        </div>
      )}

      {tab === "chat" ? (
        <>
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

          <form onSubmit={handleSend} className="flex items-center gap-2 border-t border-white/5 p-3">
            <div className="flex flex-1 items-center rounded-xl border border-white/10 bg-ink-950/80 pr-1 focus-within:border-indigo-400/50 focus-within:ring-2 focus-within:ring-indigo-500/20">
              <input
                ref={inputRef}
                type="text"
                value={input}
                maxLength={1000}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Send a message"
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
      ) : (
        <div className="flex-1 space-y-1 overflow-y-auto p-3">
          {people.map((p) => {
            const isRoomHost = p.userId === hostId;
            const isCo = coHostIds.includes(p.userId);
            return (
              <div key={p.socketId} className="flex items-center gap-3 rounded-xl p-2 hover:bg-white/[0.03]">
                <Avatar name={p.userName} seed={p.userId} size={34} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-100">
                    {p.userName}
                    {p.userId === currentUser.id && <span className="ml-1 text-slate-500">(you)</span>}
                  </p>
                  <p className="text-xs text-slate-500">{isRoomHost ? "Host" : isCo ? "Co-host" : "Viewer"}</p>
                </div>
                {isRoomHost ? (
                  <Crown size={15} className="text-amber-400" aria-label="Host" />
                ) : isCo ? (
                  <Shield size={15} className="text-indigo-300" aria-label="Co-host" />
                ) : null}
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
  msg, prev, isMe, isHostUser, render,
}: {
  msg: Message;
  prev?: Message;
  isMe: boolean;
  isHostUser: boolean;
  render: (content: string) => React.ReactNode;
}) {
  const grouped = !!prev && prev.userId === msg.userId && new Date(msg.createdAt).getTime() - new Date(prev.createdAt).getTime() < GROUP_WINDOW_MS;

  return (
    <div className={`flex gap-2 ${isMe ? "flex-row-reverse" : ""} ${grouped ? "mt-0.5" : "mt-3 first:mt-0"}`}>
      <div className="w-7 shrink-0">{!grouped && !isMe && <Avatar name={msg.userName} seed={msg.userId} size={28} />}</div>
      <div className={`flex max-w-[80%] flex-col ${isMe ? "items-end" : "items-start"}`}>
        {!grouped && (
          <div className={`mb-1 flex items-center gap-1.5 text-[11px] ${isMe ? "flex-row-reverse" : ""}`}>
            <span className="font-semibold text-slate-300">{isMe ? "You" : msg.userName}</span>
            {isHostUser && <Crown size={10} className="text-amber-400" />}
            <span className="text-slate-600">{formatTime(msg.createdAt)}</span>
          </div>
        )}
        <div
          className={`whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm leading-relaxed ${
            isMe ? "rounded-tr-md bg-gradient-to-br from-indigo-500 to-violet-500 text-white" : "rounded-tl-md bg-white/[0.06] text-slate-200"
          }`}
          title={formatTime(msg.createdAt)}
        >
          {render(msg.content)}
        </div>
      </div>
    </div>
  );
}
