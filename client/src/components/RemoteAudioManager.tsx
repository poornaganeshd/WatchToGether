import React, { useEffect, useRef, useState, useCallback } from "react";
import { VolumeX, Volume2 } from "lucide-react";
import { useSocketStore } from "../store/useSocketStore";
import { useAudioStore } from "../store/useAudioStore";

export interface RemoteAudioSinkProps {
  peerSocketId: string;
  stream: MediaStream;
  onAutoplayBlocked: (socketId: string) => void;
  onPlaybackSuccess: (socketId: string) => void;
  registerAudioElement: (socketId: string, el: HTMLAudioElement) => void;
  unregisterAudioElement: (socketId: string) => void;
}

export function RemoteAudioSink({
  peerSocketId,
  stream,
  onAutoplayBlocked,
  onPlaybackSuccess,
  registerAudioElement,
  unregisterAudioElement,
}: RemoteAudioSinkProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  // Voice volume = the "voice volume" setting (custom audio mode) × this person's own slider.
  const peerUserId = useSocketStore((s) => s.participants[peerSocketId]?.userId);
  const peerVolume = useAudioStore((s) => (peerUserId ? s.peerVolumes[peerUserId] ?? 1 : 1));
  const voiceVolume = useAudioStore((s) => (s.settings.audioMode === "custom" ? s.settings.customVoiceVolume : 1));
  const volume = Math.min(1, Math.max(0, peerVolume * voiceVolume));
  const volumeRef = useRef(volume);

  useEffect(() => {
    volumeRef.current = volume;
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);

  useEffect(() => {
    const audioEl = audioRef.current;
    if (!audioEl || !stream) return;

    registerAudioElement(peerSocketId, audioEl);

    const playAudio = () => {
      if (!audioEl) return;
      if (audioEl.srcObject !== stream) {
        audioEl.srcObject = stream;
      }
      audioEl.muted = false;
      audioEl.volume = volumeRef.current;

      const playPromise = audioEl.play();
      if (playPromise !== undefined) {
        playPromise
          .then(() => {
            onPlaybackSuccess(peerSocketId);
          })
          .catch((err: Error) => {
            if (
              err.name === "NotAllowedError" ||
              err.name === "AbortError" ||
              err.message?.toLowerCase().includes("interact") ||
              err.message?.toLowerCase().includes("gesture")
            ) {
              onAutoplayBlocked(peerSocketId);
            } else {
              console.warn(`[RemoteAudioSink] Playback notice for peer ${peerSocketId}:`, err);
            }
          });
      }
    };

    // Attempt playback immediately
    playAudio();

    // Listen for dynamically added or removed audio tracks on this MediaStream
    const onTrackAdded = (e: MediaStreamTrackEvent) => {
      if (e.track && e.track.kind === "audio") {
        playAudio();
      }
    };

    stream.addEventListener("addtrack", onTrackAdded);

    return () => {
      stream.removeEventListener("addtrack", onTrackAdded);
      unregisterAudioElement(peerSocketId);
      if (audioEl) {
        audioEl.pause();
        audioEl.srcObject = null;
      }
    };
  }, [stream, peerSocketId, registerAudioElement, unregisterAudioElement, onAutoplayBlocked, onPlaybackSuccess]);

  return (
    <audio
      ref={audioRef}
      autoPlay
      playsInline
      data-remote-audio-sink="true"
      data-peer-socket-id={peerSocketId}
      className="hidden"
      aria-hidden="true"
    />
  );
}

export interface RemoteAudioManagerProps {
  peers: { socketId: string; stream: MediaStream }[];
}

export default function RemoteAudioManager({
  peers,
}: RemoteAudioManagerProps) {
  const [autoplayBlockedPeers, setAutoplayBlockedPeers] = useState<Set<string>>(new Set());
  const audioElementsMap = useRef<Map<string, HTMLAudioElement>>(new Map());

  const registerAudioElement = useCallback((socketId: string, el: HTMLAudioElement) => {
    audioElementsMap.current.set(socketId, el);
  }, []);

  const unregisterAudioElement = useCallback((socketId: string) => {
    audioElementsMap.current.delete(socketId);
    setAutoplayBlockedPeers((prev) => {
      if (!prev.has(socketId)) return prev;
      const next = new Set(prev);
      next.delete(socketId);
      return next;
    });
  }, []);

  const handleAutoplayBlocked = useCallback((socketId: string) => {
    setAutoplayBlockedPeers((prev) => {
      const next = new Set(prev);
      next.add(socketId);
      return next;
    });
  }, []);

  const handlePlaybackSuccess = useCallback((socketId: string) => {
    setAutoplayBlockedPeers((prev) => {
      if (!prev.has(socketId)) return prev;
      const next = new Set(prev);
      next.delete(socketId);
      return next;
    });
  }, []);

  // Unlock / retry all audio sinks when user interacts
  const unlockAllAudio = useCallback(() => {
    audioElementsMap.current.forEach((audioEl, socketId) => {
      if (audioEl) {
        // Keep each sink's own volume; just unmute and retry playback.
        audioEl.muted = false;
        audioEl
          .play()
          .then(() => {
            handlePlaybackSuccess(socketId);
          })
          .catch((e) => {
            console.warn(`[RemoteAudioManager] Retry failed for ${socketId}:`, e);
          });
      }
    });
  }, [handlePlaybackSuccess]);

  // Global user interaction listener to automatically unlock audio on first click/tap/keydown
  useEffect(() => {
    if (autoplayBlockedPeers.size === 0) return;

    const handleUserGesture = () => {
      unlockAllAudio();
    };

    window.addEventListener("click", handleUserGesture, { capture: true, once: true });
    window.addEventListener("keydown", handleUserGesture, { capture: true, once: true });
    window.addEventListener("touchstart", handleUserGesture, { capture: true, once: true });

    return () => {
      window.removeEventListener("click", handleUserGesture, { capture: true });
      window.removeEventListener("keydown", handleUserGesture, { capture: true });
      window.removeEventListener("touchstart", handleUserGesture, { capture: true });
    };
  }, [autoplayBlockedPeers.size, unlockAllAudio]);

  // Ensure exactly 1 audio sink per remote participant (consuming only camera/mic streams)
  const uniquePeers = React.useMemo(() => {
    const seenSocketIds = new Set<string>();
    const result: { socketId: string; stream: MediaStream }[] = [];
    for (const p of peers) {
      if (p.stream && p.socketId && !seenSocketIds.has(p.socketId)) {
        seenSocketIds.add(p.socketId);
        result.push(p);
      }
    }
    return result;
  }, [peers]);

  // Expose pipeline state for verification and testing
  useEffect(() => {
    if (typeof window !== "undefined") {
      (window as unknown as Record<string, unknown>).__remoteAudioPipeline = {
        peersCount: uniquePeers.length,
        activeAudioSinks: uniquePeers.map((p) => ({
          socketId: p.socketId,
          streamId: p.stream.id,
          hasAudioTracks: p.stream.getAudioTracks().length > 0,
          audioTracksCount: p.stream.getAudioTracks().length,
          audioTrackEnabled: p.stream.getAudioTracks()[0]?.enabled ?? false,
        })),
        isAutoplayBlocked: autoplayBlockedPeers.size > 0,
        blockedPeers: Array.from(autoplayBlockedPeers),
        unlockAllAudio,
      };
    }
  }, [uniquePeers, autoplayBlockedPeers, unlockAllAudio]);

  const isBlocked = autoplayBlockedPeers.size > 0;

  return (
    <div id="remote-audio-manager" data-testid="remote-audio-manager" aria-live="polite">
      {/* Dedicated <audio> element per remote participant */}
      {uniquePeers.map((peer) => (
        <RemoteAudioSink
          key={peer.socketId}
          peerSocketId={peer.socketId}
          stream={peer.stream}
          onAutoplayBlocked={handleAutoplayBlocked}
          onPlaybackSuccess={handlePlaybackSuccess}
          registerAudioElement={registerAudioElement}
          unregisterAudioElement={unregisterAudioElement}
        />
      ))}

      {/* Unobtrusive, elegant banner shown ONLY when browser blocks audio autoplay */}
      {isBlocked && (
        <div
          id="audio-autoplay-unlock-banner"
          data-testid="audio-autoplay-unlock-banner"
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[10000] bg-slate-900/95 border border-amber-500/50 text-amber-200 px-4 py-2.5 rounded-2xl shadow-2xl backdrop-blur-md flex items-center gap-3 animate-in fade-in slide-in-from-bottom-4 duration-300"
        >
          <div className="p-1.5 rounded-full bg-amber-500/20 text-amber-400">
            <VolumeX size={16} />
          </div>
          <div className="flex flex-col">
            <span className="text-xs font-semibold text-white">Audio Playback Paused</span>
            <span className="text-[11px] text-slate-300">Browser requires permission to play remote audio</span>
          </div>
          <button
            onClick={unlockAllAudio}
            className="ml-2 flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-500 text-white font-medium px-3 py-1.5 rounded-xl text-xs transition-colors shadow-sm cursor-pointer"
          >
            <Volume2 size={13} />
            <span>Enable Audio</span>
          </button>
        </div>
      )}
    </div>
  );
}
