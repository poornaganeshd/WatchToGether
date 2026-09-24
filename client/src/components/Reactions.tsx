import { useState } from "react";
import { Smile } from "lucide-react";
import { useSocketStore } from "../store/useSocketStore";

// Must match ALLOWED_REACTIONS on the server.
const REACTIONS = ["😂", "❤️", "🔥", "👏", "😮", "😢", "🍿", "👍"];

export function ReactionOverlay() {
  const reactions = useSocketStore((s) => s.reactions);

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-20 z-[9500] h-0">
      {reactions.map((r) => {
        // Stable pseudo-random horizontal position per reaction.
        const offset = [...r.key].reduce((acc, ch) => acc + ch.charCodeAt(0), 0) % 60;
        return (
          <div
            key={r.key}
            className="absolute bottom-0 flex flex-col items-center animate-float-up"
            style={{ right: `${6 + offset / 3}%` }}
          >
            <span className="text-4xl drop-shadow-[0_4px_12px_rgba(0,0,0,0.6)]">{r.emoji}</span>
            <span className="mt-0.5 max-w-[8rem] truncate rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-medium text-white">
              {r.userName}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function ReactionPicker({ roomId, className = "" }: { roomId: string; className?: string }) {
  const sendReaction = useSocketStore((s) => s.sendReaction);
  const [open, setOpen] = useState(false);

  return (
    <div className={`relative ${className}`} onMouseLeave={() => setOpen(false)}>
      {open && (
        <div className="absolute bottom-full right-0 mb-2 flex gap-0.5 rounded-full border border-white/10 bg-ink-900/95 p-1 shadow-2xl backdrop-blur-xl animate-scale-in">
          {REACTIONS.map((emoji) => (
            <button
              key={emoji}
              onClick={() => sendReaction(roomId, emoji)}
              className="grid h-9 w-9 place-items-center rounded-full text-xl transition-transform hover:scale-125 hover:bg-white/10"
              aria-label={`React with ${emoji}`}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
      <button
        onClick={() => setOpen((o) => !o)}
        className={`grid h-11 w-11 place-items-center rounded-xl border shadow-lg backdrop-blur transition-colors ${
          open ? "border-indigo-400/50 bg-indigo-500/30 text-white" : "border-white/10 bg-ink-900/80 text-slate-200 hover:bg-indigo-500/30"
        }`}
        title="Send a reaction"
        aria-label="Send a reaction"
        aria-expanded={open}
      >
        <Smile size={20} />
      </button>
    </div>
  );
}
