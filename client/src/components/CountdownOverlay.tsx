import { useEffect, useState } from "react";
import { useSocketStore } from "../store/useSocketStore";

export default function CountdownOverlay({ canCancel, roomId }: { canCancel: boolean; roomId: string }) {
  const endsAt = useSocketStore((s) => s.countdownEndsAt);
  const socket = useSocketStore((s) => s.socket);
  const [remaining, setRemaining] = useState(0);

  useEffect(() => {
    if (!endsAt) return;
    const tick = () => setRemaining(Math.max(0, Math.ceil((endsAt - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 100);
    return () => clearInterval(id);
  }, [endsAt]);

  if (!endsAt || remaining <= 0) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-[9550] grid place-items-center bg-black/55 backdrop-blur-[2px] animate-fade-in" role="status" aria-live="assertive">
      <div className="flex flex-col items-center">
        <p className="mb-2 text-sm font-semibold uppercase tracking-[0.3em] text-indigo-200">Starting in</p>
        <span key={remaining} className="font-display text-[9rem] font-extrabold leading-none text-white drop-shadow-[0_0_40px_rgba(129,140,248,0.7)] animate-scale-in">
          {remaining}
        </span>
        {canCancel && (
          <button
            onClick={() => socket?.emit("cancel_countdown", { roomId })}
            className="pointer-events-auto btn-secondary mt-6 px-4 py-2 text-xs"
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
