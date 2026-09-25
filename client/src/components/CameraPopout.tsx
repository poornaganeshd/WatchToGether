import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { PictureInPicture2 } from "lucide-react";
import { useSocketStore } from "../store/useSocketStore";
import { useAudioStore } from "../store/useAudioStore";
import { toast } from "../store/useToastStore";

interface DocumentPictureInPicture {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
  window: Window | null;
}

declare global {
  interface Window {
    documentPictureInPicture?: DocumentPictureInPicture;
  }
}

interface Tile {
  id: string;
  name: string;
  stream: MediaStream;
  isLocal: boolean;
}

function PopoutTile({ tile, speaking }: { tile: Tile; speaking: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  const hasVideo = tile.stream.getVideoTracks().some((t) => t.readyState === "live" && t.enabled);
  useEffect(() => {
    const el = ref.current;
    if (el && el.srcObject !== tile.stream) {
      el.srcObject = tile.stream;
      el.play().catch(() => undefined);
    }
  }, [tile.stream]);
  return (
    <div className={`relative aspect-video overflow-hidden rounded-lg bg-ink-800 ${speaking ? "ring-2 ring-emerald-400" : "ring-1 ring-white/10"}`}>
      {/* Audio keeps playing from the main window; these are muted to avoid echo. */}
      <video ref={ref} autoPlay playsInline muted className={`h-full w-full object-cover ${tile.isLocal ? "-scale-x-100" : ""} ${hasVideo ? "" : "hidden"}`} />
      {!hasVideo && <div className="grid h-full place-items-center text-2xl font-semibold text-slate-400">{tile.name.slice(0, 1).toUpperCase()}</div>}
      <span className="absolute bottom-1 left-1 max-w-[90%] truncate rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">{tile.name}</span>
    </div>
  );
}

function PopoutGrid({ tiles }: { tiles: Tile[] }) {
  const activeSpeakers = useAudioStore((s) => s.activeSpeakers);
  return (
    <div className="min-h-screen bg-ink-950 p-2 text-slate-100">
      <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${tiles.length > 4 ? 2 : 1}, minmax(0, 1fr))` }}>
        {tiles.map((t) => (
          <PopoutTile key={t.id} tile={t} speaking={activeSpeakers.includes(t.id)} />
        ))}
      </div>
      {tiles.length === 0 && <p className="p-4 text-center text-sm text-slate-500">No cameras yet</p>}
    </div>
  );
}

/** Copies the app's styles into the picture-in-picture document so Tailwind classes work there. */
const copyStyles = (target: Document) => {
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const style = target.createElement("style");
      style.textContent = Array.from(sheet.cssRules).map((r) => r.cssText).join("\n");
      target.head.appendChild(style);
    } catch {
      // Cross-origin sheets (e.g. Google Fonts) can't be read; link them instead.
      if (sheet.href) {
        const link = target.createElement("link");
        link.rel = "stylesheet";
        link.href = sheet.href;
        target.head.appendChild(link);
      }
    }
  }
};

interface CameraPopoutProps {
  localStream: MediaStream | null;
  peers: { socketId: string; stream: MediaStream }[];
  className?: string;
}

export default function CameraPopout({ localStream, peers, className = "" }: CameraPopoutProps) {
  const participants = useSocketStore((s) => s.participants);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const pipWindowRef = useRef<Window | null>(null);
  const fallbackVideoRef = useRef<HTMLVideoElement>(null);

  const tiles: Tile[] = useMemo(
    () => [
      ...(localStream ? [{ id: "local", name: "You", stream: localStream, isLocal: true }] : []),
      ...peers.map((p) => ({ id: p.socketId, name: participants[p.socketId]?.userName ?? "Guest", stream: p.stream, isLocal: false })),
    ],
    [localStream, peers, participants]
  );

  useEffect(() => () => pipWindowRef.current?.close(), []);

  const open = useCallback(async () => {
    if (pipWindowRef.current) {
      pipWindowRef.current.close();
      return;
    }
    if (window.documentPictureInPicture) {
      try {
        const pip = await window.documentPictureInPicture.requestWindow({ width: 340, height: Math.min(640, 120 + peers.length * 190) });
        copyStyles(pip.document);
        pip.document.title = "Cameras · WatchTogether";
        pip.document.documentElement.style.colorScheme = "dark";
        const root = pip.document.createElement("div");
        pip.document.body.style.margin = "0";
        pip.document.body.appendChild(root);
        pipWindowRef.current = pip;
        setContainer(root);
        pip.addEventListener("pagehide", () => {
          pipWindowRef.current = null;
          setContainer(null);
        });
        return;
      } catch (err) {
        console.warn("Document picture-in-picture failed, falling back:", err);
      }
    }
    // Fallback: classic single-video picture-in-picture of the first camera that's on.
    const tile = tiles.find((t) => !t.isLocal && t.stream.getVideoTracks().length) ?? tiles[0];
    const video = fallbackVideoRef.current;
    if (!tile || !video || !document.pictureInPictureEnabled) {
      toast.error("Picture-in-picture isn't supported in this browser");
      return;
    }
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        return;
      }
      video.srcObject = tile.stream;
      await video.play();
      await video.requestPictureInPicture();
    } catch (err) {
      console.warn("Picture-in-picture failed:", err);
      toast.error("Couldn't open picture-in-picture");
    }
  }, [peers.length, tiles]);

  return (
    <>
      <button
        onClick={open}
        className={className}
        title={container ? "Close pop-out cameras" : "Pop out cameras (keeps showing when you switch tabs)"}
        aria-label="Pop out cameras"
        aria-pressed={!!container}
      >
        <PictureInPicture2 size={18} />
      </button>
      <video ref={fallbackVideoRef} muted playsInline className="pointer-events-none fixed -left-[9999px] top-0 h-px w-px opacity-0" aria-hidden="true" />
      {container && createPortal(<PopoutGrid tiles={tiles} />, container)}
    </>
  );
}
