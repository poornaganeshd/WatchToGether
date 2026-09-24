import { useEffect, useMemo, useState } from "react";
import { activeCues, parseVtt } from "../lib/subtitles";

interface SubtitleOverlayProps {
  vtt: string;
  getCurrentTime: () => number;
  isFullscreen?: boolean;
}

// Rendered over the player rather than as a <track>, so it also works for YouTube embeds.
export default function SubtitleOverlay({ vtt, getCurrentTime, isFullscreen }: SubtitleOverlayProps) {
  const cues = useMemo(() => parseVtt(vtt), [vtt]);
  const [lines, setLines] = useState<string[]>([]);

  useEffect(() => {
    const id = setInterval(() => {
      const next = activeCues(cues, getCurrentTime()).map((c) => c.text);
      setLines((prev) => (prev.join("\n") === next.join("\n") ? prev : next));
    }, 200);
    return () => clearInterval(id);
  }, [cues, getCurrentTime]);

  if (lines.length === 0) return null;

  return (
    <div className={`pointer-events-none absolute inset-x-0 z-[5] flex justify-center px-6 ${isFullscreen ? "bottom-20" : "bottom-16"}`}>
      <div className="max-w-3xl space-y-1 text-center">
        {lines.map((line, i) => (
          <p
            key={i}
            className={`inline-block whitespace-pre-line rounded-md bg-black/75 px-3 py-1 font-medium leading-snug text-white shadow-lg ${isFullscreen ? "text-2xl" : "text-base sm:text-lg"}`}
          >
            {line}
          </p>
        ))}
      </div>
    </div>
  );
}
