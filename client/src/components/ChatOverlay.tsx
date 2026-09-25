import { useEffect, useRef, useState } from "react";
import { useSocketStore, type Message } from "../store/useSocketStore";

const VISIBLE_MS = 7000;
const MAX_VISIBLE = 4;

/** New chat messages floating over the video, for full-screen and phone-landscape viewing. */
export default function ChatOverlay({ className = "" }: { className?: string }) {
  const messages = useSocketStore((s) => s.messages);
  const [visible, setVisible] = useState<(Message & { expiresAt: number })[]>([]);
  const seen = useRef<Set<string> | null>(null);

  useEffect(() => {
    // Whatever is already in the chat when this appears (history on join) isn't "new".
    if (!seen.current) {
      seen.current = new Set(messages.map((m) => m.id));
      return;
    }
    const fresh = messages.filter((m) => !seen.current!.has(m.id));
    if (!fresh.length) return;
    fresh.forEach((m) => seen.current!.add(m.id));
    // History arrives as a batch on (re)join; live messages arrive one at a time.
    if (fresh.length > 2) return;
    const now = Date.now();
    const live = fresh.filter((m) => !(now - Date.parse(m.createdAt) > 30000));
    if (!live.length) return;
    const expiresAt = now + VISIBLE_MS;
    setVisible((prev) => [...prev, ...live.map((m) => ({ ...m, expiresAt }))].slice(-MAX_VISIBLE));
  }, [messages]);

  useEffect(() => {
    if (!visible.length) return;
    const next = Math.min(...visible.map((m) => m.expiresAt));
    const t = setTimeout(() => setVisible((prev) => prev.filter((m) => m.expiresAt > Date.now())), Math.max(0, next - Date.now()) + 50);
    return () => clearTimeout(t);
  }, [visible]);

  if (!visible.length) return null;
  return (
    <div className={`pointer-events-none absolute bottom-14 left-3 z-[8] flex max-w-[60%] flex-col items-start gap-1.5 ${className}`} aria-live="polite">
      {visible.map((m) => (
        <p key={m.id} className="animate-fade-up rounded-xl bg-black/60 px-2.5 py-1.5 text-xs leading-snug text-white shadow-lg backdrop-blur">
          <span className="font-semibold text-indigo-200">{m.userName}</span> <span className="break-words">{m.content.length > 160 ? `${m.content.slice(0, 160)}…` : m.content}</span>
        </p>
      ))}
    </div>
  );
}
