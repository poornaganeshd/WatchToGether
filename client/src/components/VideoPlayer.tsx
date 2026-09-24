import { useState, useRef, useEffect, forwardRef, useImperativeHandle } from "react";
import ReactPlayer from "react-player";
import { useSocketStore } from "../store/useSocketStore";
import { useAudioStore } from "../store/useAudioStore";
import { FileVideo, Link2, MonitorPlay, MonitorUp, RefreshCcw, Square } from "lucide-react";

export interface VideoPlayerRef {
  seekTo: (time: number) => void;
  getCurrentTime: () => number;
}

interface VideoPlayerProps {
  roomId: string;
  isFullscreen?: boolean;
  isHost: boolean;
  broadcastMediaStream?: (stream: MediaStream) => void;
  shareScreen?: () => void;
}

const VideoPlayer = forwardRef<VideoPlayerRef, VideoPlayerProps>(({ roomId, isFullscreen = false, isHost, broadcastMediaStream, shareScreen }, ref) => {
  const { socket } = useSocketStore();
  const [url, setUrl] = useState("https://www.youtube.com/watch?v=aqz-KE-bpKQ");
  const [inputUrl, setInputUrl] = useState("");
  const [playing, setPlaying] = useState(false);
  const [volume, setVolume] = useState(0.8);
  const [playbackRate, setPlaybackRate] = useState(1.0);
  
  const playerRef = useRef<ReactPlayer>(null);
  const isHandlingRemote = useRef(false);
  const isHostRef = useRef(isHost);
  isHostRef.current = isHost;
  const isFullscreenRef = useRef(isFullscreen);
  isFullscreenRef.current = isFullscreen;
  const urlRef = useRef(url);
  urlRef.current = url;
  const pendingUrlRef = useRef<string | null>(null);
  const remoteHandlingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const checkIsFullscreen = () => {
    return isFullscreenRef.current || !!(
      typeof document !== 'undefined' && (
        document.fullscreenElement ||
        (document as Document & { webkitFullscreenElement?: Element }).webkitFullscreenElement
      )
    );
  };

  // When native fullscreen exits, apply any deferred URL change and resync with host
  useEffect(() => {
    if (!isFullscreen && pendingUrlRef.current !== null) {
      const nextUrl = pendingUrlRef.current;
      pendingUrlRef.current = null;
      if (nextUrl !== urlRef.current) {
        setUrl(nextUrl);
        setPlaying(true);
        if (!isHostRef.current && socket) {
          socket.emit("request_sync", { roomId });
        }
      }
    }
  }, [isFullscreen, socket, roomId]);

  useEffect(() => {
    const handleNativeFsExit = () => {
      const isFs = !!(
        document.fullscreenElement ||
        (document as Document & { webkitFullscreenElement?: Element }).webkitFullscreenElement
      );
      if (!isFs && pendingUrlRef.current !== null) {
        const nextUrl = pendingUrlRef.current;
        pendingUrlRef.current = null;
        if (nextUrl !== urlRef.current) {
          setUrl(nextUrl);
          setPlaying(true);
          if (!isHostRef.current && socket) {
            socket.emit("request_sync", { roomId });
          }
        }
      }
    };
    document.addEventListener("fullscreenchange", handleNativeFsExit);
    document.addEventListener("webkitfullscreenchange", handleNativeFsExit);
    return () => {
      document.removeEventListener("fullscreenchange", handleNativeFsExit);
      document.removeEventListener("webkitfullscreenchange", handleNativeFsExit);
    };
  }, [socket, roomId]);

  const markHandlingRemote = (duration = 800) => {
    if (remoteHandlingTimerRef.current) {
      clearTimeout(remoteHandlingTimerRef.current);
    }
    isHandlingRemote.current = true;
    remoteHandlingTimerRef.current = setTimeout(() => {
      isHandlingRemote.current = false;
      remoteHandlingTimerRef.current = null;
    }, duration);
  };

  const lastSyncStateRef = useRef<{
    time: number;
    playing: boolean;
    lastUpdatedAt: number;
    localReceiptTime: number;
    serverTime?: number;
  } | null>(null);

  const calculateExpectedTime = (syncState: {
    time: number;
    playing: boolean;
    lastUpdatedAt: number;
    localReceiptTime: number;
    serverTime?: number;
  }) => {
    if (!syncState.playing) {
      return syncState.time;
    }
    const elapsedSinceReceipt = (Date.now() - syncState.localReceiptTime) / 1000;
    const serverDelay = syncState.serverTime && syncState.lastUpdatedAt
      ? Math.max(0, (syncState.serverTime - syncState.lastUpdatedAt) / 1000)
      : 0;
    return syncState.time + serverDelay + elapsedSinceReceipt;
  };

  const applyDriftCorrection = (expectedTime: number, isPlaying: boolean) => {
    if (!playerRef.current) return;
    const myTime = typeof playerRef.current.getCurrentTime === 'function' ? playerRef.current.getCurrentTime() : 0;
    const drift = expectedTime - myTime;

    if (!isPlaying) {
      if (Math.abs(drift) > 0.5) {
        playerRef.current.seekTo(expectedTime, "seconds");
      }
      setPlaybackRate(1.0);
    } else {
      if (Math.abs(drift) > 3.0) {
        // Hard seek for large drift
        playerRef.current.seekTo(expectedTime, "seconds");
        setPlaybackRate(1.0);
      } else if (drift > 1.0) {
        // Behind: gentle speedup
        setPlaybackRate(1.05);
      } else if (drift < -1.0) {
        // Ahead: gentle slowdown
        setPlaybackRate(0.95);
      } else {
        // In-sync deadband
        setPlaybackRate(1.0);
      }
    }
  };

  useImperativeHandle(ref, () => ({
    seekTo: (time: number) => {
      if (playerRef.current && typeof playerRef.current.seekTo === 'function') {
        playerRef.current.seekTo(time, "seconds");
      }
    },
    getCurrentTime: () => {
      if (playerRef.current && typeof playerRef.current.getCurrentTime === 'function') {
        return playerRef.current.getCurrentTime();
      }
      return 0;
    }
  }));

  const { settings, activeSpeakers, hostAnnouncementActive, hostSocketId } = useAudioStore();
  const baseVolumeRef = useRef(0.8);
  const targetVolumeRef = useRef(0.8);

  useEffect(() => {
    if (!settings.isEnabled) {
      targetVolumeRef.current = baseVolumeRef.current;
    } else {
      let isHostSpeaking = false;
      if (hostAnnouncementActive) {
        isHostSpeaking = true;
      } else if (hostSocketId && activeSpeakers.includes(hostSocketId)) {
        isHostSpeaking = true;
      }

      const hasActiveSpeakers = activeSpeakers.length > 0;
      
      let duckAmount = settings.duckingLevel;
      if (settings.audioMode === 'cinema') duckAmount = Math.max(0.2, settings.duckingLevel - 0.3);
      if (settings.audioMode === 'conversation') duckAmount = Math.min(1.0, settings.duckingLevel + 0.3);
      if (isHostSpeaking) duckAmount = 0.9; // Host ducks deeply
      if (settings.audioMode === 'custom') {
         // simple interpretation of custom movie volume acting as max
         baseVolumeRef.current = settings.customMovieVolume;
      } else {
         baseVolumeRef.current = 0.8;
      }

      if (hasActiveSpeakers) {
        targetVolumeRef.current = baseVolumeRef.current * (1 - duckAmount);
      } else {
        targetVolumeRef.current = baseVolumeRef.current;
      }
    }
  }, [settings, activeSpeakers, hostAnnouncementActive, hostSocketId]);

  useEffect(() => {
    const intervalId = setInterval(() => {
      setVolume((prev) => {
        const diff = targetVolumeRef.current - prev;
        if (Math.abs(diff) < 0.01) {
          return targetVolumeRef.current;
        }
        
        let speedMult = 0.1;
        if (diff < 0) {
          // fading down
          if (settings.duckingSpeed === 'slow') speedMult = 0.05;
          if (settings.duckingSpeed === 'fast') speedMult = 0.2;
        } else {
          // fading up
          if (settings.recoverySpeed === 'slow') speedMult = 0.02;
          if (settings.recoverySpeed === 'fast') speedMult = 0.15;
        }

        return prev + diff * speedMult;
      });
    }, 50);

    return () => clearInterval(intervalId);
  }, [settings.duckingSpeed, settings.recoverySpeed]);

  useEffect(() => {
    if (!socket) return;

    const handlePlayVideo = ({ time, serverTime }: { time: number; serverTime?: number }) => {
      if (isHostRef.current) return;
      if (pendingUrlRef.current && pendingUrlRef.current !== urlRef.current) return;
      markHandlingRemote(800);
      lastSyncStateRef.current = {
        time,
        playing: true,
        lastUpdatedAt: serverTime || Date.now(),
        localReceiptTime: Date.now(),
        serverTime,
      };
      setPlaying(true);
      if (playerRef.current) {
        const currentTime = typeof playerRef.current.getCurrentTime === 'function' ? playerRef.current.getCurrentTime() : 0;
        if (Math.abs(currentTime - time) > 1.0) {
          if (typeof playerRef.current.seekTo === 'function') playerRef.current.seekTo(time, "seconds");
        }
      }
      setPlaybackRate(1.0);
    };

    const handlePauseVideo = ({ time, serverTime }: { time: number; serverTime?: number }) => {
      if (isHostRef.current) return;
      if (pendingUrlRef.current && pendingUrlRef.current !== urlRef.current) return;
      markHandlingRemote(800);
      lastSyncStateRef.current = {
        time,
        playing: false,
        lastUpdatedAt: serverTime || Date.now(),
        localReceiptTime: Date.now(),
        serverTime,
      };
      setPlaying(false);
      if (playerRef.current) {
        if (typeof playerRef.current.seekTo === 'function') playerRef.current.seekTo(time, "seconds");
      }
      setPlaybackRate(1.0);
    };

    const handleSeekVideo = ({ time, serverTime }: { time: number; serverTime?: number }) => {
      if (isHostRef.current) return;
      if (pendingUrlRef.current && pendingUrlRef.current !== urlRef.current) return;
      markHandlingRemote(800);
      if (lastSyncStateRef.current) {
        lastSyncStateRef.current.time = time;
        lastSyncStateRef.current.lastUpdatedAt = serverTime || Date.now();
        lastSyncStateRef.current.localReceiptTime = Date.now();
      }
      if (playerRef.current) {
        if (typeof playerRef.current.seekTo === 'function') playerRef.current.seekTo(time, "seconds");
      }
      setPlaybackRate(1.0);
    };

    const handleChangeVideo = ({ url: newUrl }: { url: string }) => {
      if (checkIsFullscreen() && newUrl !== urlRef.current) {
        pendingUrlRef.current = newUrl;
        return;
      }
      pendingUrlRef.current = null;
      setUrl(newUrl);
      setPlaying(true);
      if (playerRef.current) {
        if (typeof playerRef.current.seekTo === 'function') playerRef.current.seekTo(0);
      }
      setPlaybackRate(1.0);
    };

    const handleSyncResponse = (playbackState: { time: number; playing: boolean; url: string; lastUpdatedAt?: number; serverTime?: number } | null) => {
      if (!playbackState) return;
      if (isHostRef.current) return;

      const { time, playing: hostPlaying, url: hostUrl, lastUpdatedAt, serverTime } = playbackState;
      markHandlingRemote(800);

      if (hostUrl && hostUrl !== urlRef.current) {
        if (checkIsFullscreen()) {
          pendingUrlRef.current = hostUrl;
        } else {
          pendingUrlRef.current = null;
          setUrl(hostUrl);
        }
      } else if (hostUrl === urlRef.current) {
        pendingUrlRef.current = null;
      }

      if (!pendingUrlRef.current || pendingUrlRef.current === urlRef.current) {
        setPlaying(hostPlaying);

        const now = Date.now();
        lastSyncStateRef.current = {
          time,
          playing: hostPlaying,
          lastUpdatedAt: lastUpdatedAt || now,
          localReceiptTime: now,
          serverTime: serverTime || now,
        };

        const expectedTime = calculateExpectedTime(lastSyncStateRef.current);
        applyDriftCorrection(expectedTime, hostPlaying);
      }
    };

    socket.on("play_video", handlePlayVideo);
    socket.on("pause_video", handlePauseVideo);
    socket.on("seek_video", handleSeekVideo);
    socket.on("change_video", handleChangeVideo);
    socket.on("sync_response", handleSyncResponse);

    return () => {
      socket.off("play_video", handlePlayVideo);
      socket.off("pause_video", handlePauseVideo);
      socket.off("seek_video", handleSeekVideo);
      socket.off("change_video", handleChangeVideo);
      socket.off("sync_response", handleSyncResponse);
      if (remoteHandlingTimerRef.current) {
        clearTimeout(remoteHandlingTimerRef.current);
      }
    };
  }, [socket, roomId]);

  // Host periodic heartbeat while playing
  useEffect(() => {
    if (!isHost || !playing || !socket) return;

    const intervalId = setInterval(() => {
      if (playerRef.current && typeof playerRef.current.getCurrentTime === 'function') {
        const currentTime = playerRef.current.getCurrentTime();
        socket.emit("sync_time", { roomId, time: currentTime, playing: true });
      }
    }, 3000);

    return () => clearInterval(intervalId);
  }, [isHost, playing, socket, roomId]);

  // Non-host fallback polling if no heartbeat received for > 8s
  useEffect(() => {
    if (isHost || !socket) return;
    const intervalId = setInterval(() => {
      const lastReceived = lastSyncStateRef.current?.localReceiptTime || 0;
      if (Date.now() - lastReceived > 8000) {
        socket.emit("request_sync", { roomId });
      }
    }, 5000);
    return () => clearInterval(intervalId);
  }, [isHost, socket, roomId]);

  const handlePlay = () => {
    if (isHandlingRemote.current) return;
    if (!isHost) {
      setPlaying(false); // Instantly revert if not host
      setTimeout(() => setPlaying(true), 10); // Force re-render just in case
      return;
    }
    setPlaying(true);
    const time = typeof playerRef.current?.getCurrentTime === 'function' ? playerRef.current.getCurrentTime() : 0;
    socket?.emit("play_video", { roomId, time });
  };

  const handlePause = () => {
    if (isHandlingRemote.current) return;
    if (!isHost) {
      setPlaying(true); // Instantly revert if not host
      setTimeout(() => setPlaying(false), 10);
      return;
    }
    setPlaying(false);
    const time = typeof playerRef.current?.getCurrentTime === 'function' ? playerRef.current.getCurrentTime() : 0;
    socket?.emit("pause_video", { roomId, time });
  };

  const handleSeek = (seconds: number) => {
    if (isHandlingRemote.current) return;
    if (!isHostRef.current) return;
    socket?.emit("seek_video", { roomId, time: seconds });
  };

  const handleProgress = (state: { playedSeconds: number }) => {
    if (isHostRef.current) return;
    if (!lastSyncStateRef.current || !lastSyncStateRef.current.playing) return;
    if (isHandlingRemote.current) return;

    const expectedTime = calculateExpectedTime(lastSyncStateRef.current);
    const currentPos = state.playedSeconds;
    const drift = expectedTime - currentPos;

    if (Math.abs(drift) <= 0.5) {
      setPlaybackRate((prev) => (prev !== 1.0 ? 1.0 : prev));
    } else if (Math.abs(drift) > 3.0) {
      markHandlingRemote(800);
      playerRef.current?.seekTo(expectedTime, "seconds");
      setPlaybackRate((prev) => (prev !== 1.0 ? 1.0 : prev));
    } else if (drift > 1.0) {
      setPlaybackRate((prev) => (prev !== 1.05 ? 1.05 : prev));
    } else if (drift < -1.0) {
      setPlaybackRate((prev) => (prev !== 0.95 ? 0.95 : prev));
    }
  };

  const [videoError, setVideoError] = useState(false);

  const changeVideo = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputUrl) {
      let finalUrl = inputUrl.trim();
      if (!/^https?:\/\//i.test(finalUrl)) {
        finalUrl = 'https://' + finalUrl;
      }
      pendingUrlRef.current = null;
      setUrl(finalUrl);
      setPlaying(true);
      setVideoError(false);
      socket?.emit("change_video", { roomId, url: finalUrl });
      socket?.emit("play_video", { roomId, time: 0 });
      setInputUrl("");
    }
  };

  const handleStopMedia = () => {
    pendingUrlRef.current = null;
    setUrl("");
    setPlaying(false);
    socket?.emit("change_video", { roomId, url: "" });
  };

  // Unwrap default export for Vite ESM compatibility with react-player v2
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Player: any = (ReactPlayer as any).default || ReactPlayer;

  const handleLocalFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    const fileUrl = URL.createObjectURL(file);
    pendingUrlRef.current = null;
    setUrl(fileUrl);
    setPlaying(true);
    setVideoError(false);
    
    // We do not broadcast the blob URL because peers cannot access it.
    // Instead, we will capture the stream once it starts playing and broadcast it.
    socket?.emit("play_video", { roomId, time: 0 });
    
    // Attempt to capture stream after a short delay to ensure video element is mounted and playing
    setTimeout(() => {
      if (playerRef.current && broadcastMediaStream) {
        const videoEl = playerRef.current.getInternalPlayer() as HTMLVideoElement;
        if (videoEl && typeof (videoEl as HTMLVideoElement & { captureStream?: () => MediaStream }).captureStream === 'function') {
          const stream = (videoEl as HTMLVideoElement & { captureStream: () => MediaStream }).captureStream();
          broadcastMediaStream(stream);
        } else if (videoEl && typeof (videoEl as HTMLVideoElement & { mozCaptureStream?: () => MediaStream }).mozCaptureStream === 'function') {
          const stream = (videoEl as HTMLVideoElement & { mozCaptureStream: () => MediaStream }).mozCaptureStream();
          broadcastMediaStream(stream);
        }
      }
    }, 1000);
  };

  return (
    <div className={`flex flex-col w-full h-full relative group transition-all duration-300 ${isFullscreen ? '' : 'p-4'}`}>
      <div className={`absolute z-10 flex flex-col items-end rounded-2xl border p-3 shadow-2xl backdrop-blur-xl transition-opacity duration-300 ${isFullscreen ? 'top-20 right-4' : 'top-20 right-6'} ${videoError ? 'opacity-100 bg-red-950/85 border-red-500/40' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100 bg-ink-900/85 border-white/10'}`}>
        {isHost ? (
          <div className="flex w-80 max-w-[calc(100vw-3rem)] flex-col gap-2.5">
            <form
              className="flex items-center gap-2"
              onSubmit={changeVideo}
            >
              <div className="relative flex-1">
                <Link2 size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
                <input
                  type="text"
                  value={inputUrl}
                  onChange={(e) => setInputUrl(e.target.value)}
                  placeholder="Paste a YouTube or video URL"
                  className={`w-full rounded-lg border bg-black/40 py-2 pl-8 pr-2 text-sm text-white placeholder:text-slate-500 transition-colors focus:outline-none focus:ring-2 ${videoError ? 'border-red-500/60 focus:ring-red-500/40' : 'border-white/10 focus:border-indigo-400/60 focus:ring-indigo-500/30'}`}
                />
              </div>
              <button type="submit" className="btn-primary px-3 py-2 text-xs">
                Play
              </button>
            </form>
            <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-white/15 px-3 py-2 text-xs text-slate-300 transition-colors hover:border-indigo-400/50 hover:bg-white/[0.03]">
              <FileVideo size={14} className="text-indigo-300" />
              <span className="flex-1">Play a local video file</span>
              <input type="file" accept="video/*" onChange={handleLocalFile} className="sr-only" />
            </label>
            <div className="flex items-center gap-2 border-t border-white/5 pt-2.5">
              {shareScreen && (
                <button onClick={shareScreen} className="btn-secondary flex-1 px-3 py-2 text-xs">
                  <MonitorUp size={14} /> Share screen
                </button>
              )}
              <button onClick={handleStopMedia} className="btn-danger flex-1 px-3 py-2 text-xs">
                <Square size={12} /> Stop media
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => socket?.emit("request_sync", { roomId })}
            className="btn-primary px-4 py-2 text-sm"
          >
            <RefreshCcw size={15} />
            Sync with host
          </button>
        )}
        {videoError && (
          <div className="mt-2 w-full rounded-lg border border-red-500/30 bg-red-950/80 p-2 text-right text-xs font-medium text-red-300">
            Can't play this URL. Make sure it's a YouTube link or a direct video file.
          </div>
        )}
      </div>

      <div className={`flex-1 overflow-hidden relative bg-black flex items-center justify-center transition-all duration-300 ${isFullscreen ? '' : 'rounded-2xl shadow-2xl ring-1 ring-white/10'}`}>
        {url ? (
          <Player
            key={url}
            ref={playerRef}
            url={url}
            width="100%"
            height="100%"
            playing={playing}
            volume={volume}
            playbackRate={playbackRate}
            onPlay={handlePlay}
            onPause={handlePause}
            onSeek={handleSeek}
            onProgress={handleProgress}
            onError={() => setVideoError(true)}
            controls={true}
            config={{ youtube: { playerVars: { fs: 0 } } }}
            style={{ position: "absolute", top: 0, left: 0 }}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center text-center text-slate-500">
            <div className="mb-4 grid h-20 w-20 place-items-center rounded-3xl bg-white/[0.04] ring-1 ring-white/10">
              <MonitorPlay size={36} className="text-slate-400" />
            </div>
            <p className="font-medium text-slate-300">{isHost ? "Nothing playing yet" : "Waiting for the host to play something"}</p>
            <p className="mt-1 text-sm">{isHost ? "Hover here and paste a video link to get started." : "Grab a snack — it'll start for everyone at once."}</p>
          </div>
        )}
      </div>
    </div>
  );
});

export default VideoPlayer;
