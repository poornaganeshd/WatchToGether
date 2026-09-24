import { useEffect, useState, useRef, useCallback } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { useAuthStore } from "../store/useAuthStore";
import { useSocketStore } from "../store/useSocketStore";
import VideoPlayer from "../components/VideoPlayer";
import VideoGrid from "../components/VideoGrid";
import RemoteAudioManager from "../components/RemoteAudioManager";
import { useWebRTC } from "../hooks/useWebRTC";
import { useVoiceActivityDetection } from "../hooks/useVoiceActivityDetection";
import { useAudioStore } from "../store/useAudioStore";
import { Mic2, MessageSquare, Users, ChevronRight, Share2, LogOut, Copy, Check, WifiOff, SlidersHorizontal } from "lucide-react";
import api, { getErrorMessage } from "../lib/api";
import AudioSettingsModal from "../components/AudioSettingsModal";
import InviteModal from "../components/InviteModal";
import RoomSettingsModal from "../components/RoomSettingsModal";
import Modal from "../components/ui/Modal";
import ChatPanel from "../components/ChatPanel";
import PasswordPrompt from "../components/PasswordPrompt";
import { ReactionOverlay, ReactionPicker } from "../components/Reactions";
import { toast } from "../store/useToastStore";
import { copyToClipboard, formatClock } from "../lib/format";
import type { VideoPlayerRef } from "../components/VideoPlayer";

export default function Room() {
  const { id } = useParams();
  const location = useLocation();
  const { user } = useAuthStore();
  const navigate = useNavigate();
  const { socket, connect, joinRoom, leaveRoom, clearMessages, connectionStatus, reconnectError, roomAccessError, endedRoomId, clearEndedRoom, unreadCount, participants, exitReason, clearExitReason, roomInfo } = useSocketStore();
  const { getLocalStream, localStream, localStreamState, screenStreamState, peers, peerStatuses, screenShares, toggleAudio, toggleVideo, shareScreen, broadcastMediaStream } = useWebRTC(id || "");
  const [isInviteModalOpen, setIsInviteModalOpen] = useState(false);
  const [mainScreenSource, setMainScreenSource] = useState<'url' | string>('url');
  const [roomCreatedAt, setRoomCreatedAt] = useState<string | null>(null);
  const [sessionStartedAt, setSessionStartedAt] = useState<number | null>(null);
  const [roomSettings, setRoomSettings] = useState<{ name: string; isPrivate: boolean; maxParticipants: number } | null>(null);
  const [isRoomSettingsOpen, setIsRoomSettingsOpen] = useState(false);
  const [isShortcutsOpen, setIsShortcutsOpen] = useState(false);
  const [roomDisplayId, setRoomDisplayId] = useState<string | null>(null);
  const [roomName, setRoomName] = useState<string | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [hostId, setHostId] = useState<string | null>(null);
  const [coHostIds, setCoHostIds] = useState<string[]>([]);
  const isHost = !!user && (hostId === user.id || coHostIds.includes(user.id));
  const isRoomHost = !!user && hostId === user.id;
  const [isChatOpen, setIsChatOpen] = useState(() => typeof window !== "undefined" && window.innerWidth >= 1280);
  const [passwordPrompt, setPasswordPrompt] = useState<{ open: boolean; error: string | null }>({ open: false, error: null });
  const [codeCopied, setCodeCopied] = useState(false);
  const mediaStartedRef = useRef(false);
  const [hoverZones, setHoverZones] = useState({ top: false, right: false, bottom: false });
  const [isCameraSidebarOpen, setIsCameraSidebarOpen] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [duration, setDuration] = useState("00:00:00");
  const videoContainerRef = useRef<HTMLDivElement>(null);
  const mainContainerRef = useRef<HTMLDivElement>(null);
  const videoPlayerRef = useRef<VideoPlayerRef>(null);

  const getTimestamp = () => {
    if (!videoPlayerRef.current) return null;
    return formatClock(videoPlayerRef.current.getCurrentTime());
  };

  const handleSeekToTime = (timeStr: string) => {
    if (!isHost) return;
    const parts = timeStr.split(':').map(Number);
    const seconds = parts.length === 3 
      ? parts[0] * 3600 + parts[1] * 60 + parts[2] 
      : parts[0] * 60 + parts[1];
    socket?.emit("seek_video", { roomId: id, time: seconds });
    socket?.emit("play_video", { roomId: id, time: seconds });
    videoPlayerRef.current?.seekTo(seconds);
  };

  const toggleFullscreen = () => {
    try {
      const isCurrentlyFullscreen = !!(
        document.fullscreenElement ||
        (document as Document & { webkitFullscreenElement?: Element }).webkitFullscreenElement
      );

      if (!isCurrentlyFullscreen) {
        const target = videoContainerRef.current;
        if (target) {
          if (target.requestFullscreen) {
            target.requestFullscreen().catch((err) => console.error("Fullscreen request error:", err));
          } else if ('webkitRequestFullscreen' in target) {
            (target as HTMLDivElement & { webkitRequestFullscreen: () => Promise<void> }).webkitRequestFullscreen();
          }
        }
      } else {
        if (document.exitFullscreen) {
          document.exitFullscreen().catch((err) => console.error("Fullscreen exit error:", err));
        } else if ('webkitExitFullscreen' in document) {
          (document as Document & { webkitExitFullscreen: () => Promise<void> }).webkitExitFullscreen();
        }
      }
    } catch (err) {
      console.error("Fullscreen error:", err);
    }
  };

  useEffect(() => {
    const handleFullscreenChange = () => {
      const isFs = !!(
        document.fullscreenElement ||
        (document as Document & { webkitFullscreenElement?: Element }).webkitFullscreenElement
      );
      setIsFullscreen(isFs);
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    document.addEventListener("webkitfullscreenchange", handleFullscreenChange);

    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isTyping = target?.nodeName === 'INPUT' || target?.nodeName === 'TEXTAREA' || target?.isContentEditable;
      if (e.key.toLowerCase() === 'f' && !e.metaKey && !e.ctrlKey && !e.altKey && !isTyping) {
        toggleFullscreen();
      }
    };
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
      document.removeEventListener("webkitfullscreenchange", handleFullscreenChange);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);



  const handleMouseLeaveBottom = () => setHoverZones(p => ({ ...p, bottom: false }));
  const handleMouseEnterBottom = () => setHoverZones(p => ({ ...p, bottom: true }));

  // Joining needs the camera/mic first so peers can negotiate immediately.
  const startJoin = useCallback((password?: string) => {
    if (!id || !user) return;
    connect();
    if (mediaStartedRef.current) {
      joinRoom(id, user.id, user.name, password);
      return;
    }
    mediaStartedRef.current = true;
    getLocalStream().then(() => {
      joinRoom(id, user.id, user.name, password);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, user?.id, user?.name, connect, joinRoom]);

  useEffect(() => {
    if (!user || !id) return;
    let cancelled = false;

    api.get(`/rooms/${id}`).then((res) => {
      const room = res.data.room;
      if (cancelled || !room) return;
      setRoomCreatedAt(room.createdAt);
      setRoomDisplayId(room.displayId);
      setRoomName(room.name);
      setRoomSettings({ name: room.name, isPrivate: room.isPrivate, maxParticipants: room.maxParticipants ?? 10 });
      setHostId(room.hostId);
      const coHosts: string[] = (room.coHosts ?? []).map((ch: { userId: string }) => ch.userId);
      setCoHostIds(coHosts);

      const isPrivileged = room.hostId === user.id || coHosts.includes(user.id);
      const passwordFromDashboard = (location.state as { password?: string } | null)?.password;
      if (passwordFromDashboard) {
        // Don't leave the room password sitting in browser history state.
        navigate(location.pathname, { replace: true, state: null });
      }
      if (room.isPrivate && room.hasPassword !== false && !isPrivileged && !passwordFromDashboard) {
        setPasswordPrompt({ open: true, error: null });
        return;
      }
      startJoin(passwordFromDashboard);
    }).catch(err => {
      if (cancelled) return;
      console.error("Failed to fetch room", err);
      toast.error(getErrorMessage(err, "Room not found"));
      navigate("/dashboard");
    });

    return () => {
      cancelled = true;
      if (id && user) {
        leaveRoom(id, user.id, user.name);
      }
      clearMessages();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, user?.id]);

  // The server rejected our password (wrong, or a reconnect lost it): ask again.
  useEffect(() => {
    if (!roomAccessError) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPasswordPrompt({
      open: true,
      error: roomAccessError === 'incorrect_password' ? "That password didn't work. Try again." : null,
    });
  }, [roomAccessError]);

  useEffect(() => {
    if (!endedRoomId || endedRoomId !== id) return;
    clearEndedRoom();
    toast.info("The host ended this room.");
    navigate("/dashboard");
  }, [endedRoomId, id, clearEndedRoom, navigate]);

  useEffect(() => {
    if (!socket || !user) return;

    const handleNewCohost = ({ userId }: { userId: string }) => {
      setCoHostIds((prev) => (prev.includes(userId) ? prev : [...prev, userId]));
      if (userId === user.id) {
        toast.success("You're now a co-host and can control playback.");
      }
    };

    const handleRoomState = ({ hostId: nextHostId, coHosts, startedAt }: { hostId: string, coHosts: string[], startedAt?: number }) => {
      if (startedAt) setSessionStartedAt(startedAt);
      setHostId(nextHostId);
      setCoHostIds(coHosts);
    };

    const handleNewHost = ({ userId }: { userId: string }) => {
      setHostId(userId);
      setCoHostIds((prev) => prev.filter((uid) => uid !== userId));
      if (user.id === userId) {
        toast.success("You're the host now.");
      }
    };

    socket.on("new_cohost", handleNewCohost);
    socket.on("room_state", handleRoomState);
    socket.on("new_host", handleNewHost);
    return () => {
      socket.off("new_cohost", handleNewCohost);
      socket.off("room_state", handleRoomState);
      socket.off("new_host", handleNewHost);
    };
  }, [socket, user]);

  useEffect(() => {
    const startMs = sessionStartedAt ?? (roomCreatedAt ? new Date(roomCreatedAt).getTime() : null);
    if (!startMs) return;
    
    const interval = setInterval(() => {
      const diff = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
      const h = Math.floor(diff / 3600).toString().padStart(2, '0');
      const m = Math.floor((diff % 3600) / 60).toString().padStart(2, '0');
      const s = (diff % 60).toString().padStart(2, '0');
      setDuration(`${h}:${m}:${s}`);
    }, 1000);
    return () => clearInterval(interval);
  }, [roomCreatedAt, sessionStartedAt]);

  // Automatically promote incoming screen-share / captured local video to main movie stage,
  // and cleanly revert to 'url' when the broadcast ends.
  // If native fullscreen is currently active, defer promoting/replacing the main-stage
  // renderer until fullscreen exits to prevent disruptive DOM unmounting that drops fullscreen.
  const prevRemoteStreamIdsRef = useRef<string[]>([]);
  const pendingMainScreenSourceRef = useRef<string | null>(null);

  useEffect(() => {
    const activeRemoteStreams = Object.values(screenShares)
      .map((s) => (typeof s === "string" ? null : s))
      .filter((s): s is MediaStream => !!s && s instanceof MediaStream);

    const activeRemoteStreamIds = activeRemoteStreams.map((s) => s.id);
    const prevStreamIds = prevRemoteStreamIdsRef.current;

    // Detect if a new remote broadcast stream arrived
    const newlyArrivedStream = activeRemoteStreams.find((s) => !prevStreamIds.includes(s.id));

    const isFs = isFullscreen || !!(
      document.fullscreenElement ||
      (document as Document & { webkitFullscreenElement?: Element }).webkitFullscreenElement
    );

    if (newlyArrivedStream) {
      if (isFs) {
        pendingMainScreenSourceRef.current = newlyArrivedStream.id;
      } else {
        setMainScreenSource(newlyArrivedStream.id);
      }
    } else if (mainScreenSource !== 'url') {
      const isLocalActive = screenStreamState && screenStreamState.id === mainScreenSource;
      const isRemoteActive = activeRemoteStreamIds.includes(mainScreenSource);

      if (!isLocalActive && !isRemoteActive) {
        if (isFs) {
          pendingMainScreenSourceRef.current = 'url';
        } else {
          setMainScreenSource('url');
        }
      }
    }

    prevRemoteStreamIdsRef.current = activeRemoteStreamIds;
  }, [screenShares, screenStreamState, mainScreenSource, isFullscreen]);

  // When native fullscreen exits, apply any deferred/pending mainScreenSource promotion
  useEffect(() => {
    if (!isFullscreen && pendingMainScreenSourceRef.current !== null) {
      const pending = pendingMainScreenSourceRef.current;
      pendingMainScreenSourceRef.current = null;

      if (pending === 'url') {
        setMainScreenSource('url');
      } else {
        const isLocalActive = screenStreamState && screenStreamState.id === pending;
        const isRemoteActive = Object.values(screenShares).some(
          (s) => (typeof s === "string" ? s : s?.id) === pending
        );
        if (isLocalActive || isRemoteActive) {
          setMainScreenSource(pending);
        } else {
          setMainScreenSource('url');
        }
      }
    }
  }, [isFullscreen, screenShares, screenStreamState]);

  useVoiceActivityDetection(id, localStreamState);

  const shortcutHandlersRef = useRef({ toggleAudio, toggleVideo });
  useEffect(() => {
    shortcutHandlersRef.current = { toggleAudio, toggleVideo };
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isTyping = target?.nodeName === 'INPUT' || target?.nodeName === 'TEXTAREA' || target?.nodeName === 'SELECT' || target?.isContentEditable;
      if (isTyping || e.metaKey || e.ctrlKey || e.altKey || document.querySelector('[role="dialog"]')) return;
      switch (e.key.toLowerCase()) {
        case 'm':
          shortcutHandlersRef.current.toggleAudio();
          break;
        case 'v':
          shortcutHandlersRef.current.toggleVideo();
          break;
        case 'c':
          setIsChatOpen((open) => !open);
          break;
        case 'i':
          setIsInviteModalOpen(true);
          break;
        case '?':
          setIsShortcutsOpen(true);
          break;
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const addActiveSpeaker = useAudioStore(state => state.addActiveSpeaker);
  const removeActiveSpeaker = useAudioStore(state => state.removeActiveSpeaker);
  const setHostAnnouncement = useAudioStore(state => state.setHostAnnouncement);
  const setHostSocketId = useAudioStore(state => state.setHostSocketId);

  // Smart volume ducks deeper when the host talks; it needs the host's socket id.
  useEffect(() => {
    const hostSocket = Object.values(participants).find((p) => p.userId === hostId)?.socketId ?? null;
    setHostSocketId(hostSocket);
  }, [participants, hostId, setHostSocketId]);

  useEffect(() => () => setHostSocketId(null), [setHostSocketId]);

  useEffect(() => {
    if (!exitReason) return;
    clearExitReason();
    if (exitReason === 'kicked') {
      toast.error("You were removed from this room by the host.");
    } else {
      toast.error("This room is full.");
    }
    navigate("/dashboard");
  }, [exitReason, clearExitReason, navigate]);

  useEffect(() => {
    if (!roomInfo) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRoomName(roomInfo.name);
    setRoomSettings(roomInfo);
  }, [roomInfo]);

  useEffect(() => {
    if (!socket) return;

    const isNativeFullscreen = () => !!(
      document.fullscreenElement ||
      (document as Document & { webkitFullscreenElement?: Element }).webkitFullscreenElement
    );

    const handleUserSpeaking = ({ socketId }: { socketId: string }) => addActiveSpeaker(socketId);
    const handleUserStoppedSpeaking = ({ socketId }: { socketId: string }) => removeActiveSpeaker(socketId);
    const handleAnnouncementStart = () => setHostAnnouncement(true);
    const handleAnnouncementStop = () => setHostAnnouncement(false);

    const handleScreenShareStart = ({ streamId }: { streamId: string }) => {
      if (isNativeFullscreen()) {
        pendingMainScreenSourceRef.current = streamId;
      } else {
        setMainScreenSource(streamId);
      }
    };

    const handleScreenShareStop = () => {
      if (isNativeFullscreen()) {
        pendingMainScreenSourceRef.current = 'url';
      } else {
        setMainScreenSource('url');
      }
    };

    socket.on("user_speaking", handleUserSpeaking);
    socket.on("user_stopped_speaking", handleUserStoppedSpeaking);
    socket.on("host_announcement_start", handleAnnouncementStart);
    socket.on("host_announcement_stop", handleAnnouncementStop);
    socket.on("screen_share_start", handleScreenShareStart);
    socket.on("screen_share_stop", handleScreenShareStop);

    return () => {
      socket.off("user_speaking", handleUserSpeaking);
      socket.off("user_stopped_speaking", handleUserStoppedSpeaking);
      socket.off("host_announcement_start", handleAnnouncementStart);
      socket.off("host_announcement_stop", handleAnnouncementStop);
      socket.off("screen_share_start", handleScreenShareStart);
      socket.off("screen_share_stop", handleScreenShareStop);
    };
  }, [socket, addActiveSpeaker, removeActiveSpeaker, setHostAnnouncement]);

  const handleCopyCode = async () => {
    if (!roomDisplayId) return;
    if (await copyToClipboard(roomDisplayId)) {
      setCodeCopied(true);
      setTimeout(() => setCodeCopied(false), 1500);
    }
  };

  const participantName = (socketId: string) => participants[socketId]?.userName ?? `Participant ${socketId.slice(0, 4)}`;

  const toggleHostAnnouncement = () => {
    if (!socket || !id) return;
    const { hostAnnouncementActive } = useAudioStore.getState();
    const newState = !hostAnnouncementActive;
    
    if (newState) {
      socket.emit("host_announcement_start", { roomId: id });
    } else {
      socket.emit("host_announcement_stop", { roomId: id });
    }
    setHostAnnouncement(newState);
  };

  const { hostAnnouncementActive } = useAudioStore();

  return (
    <div className="flex h-screen bg-black overflow-hidden" ref={mainContainerRef}>
      {/* Dedicated Remote WebRTC Audio Pipeline (decoupled from camera tiles/sidebar) */}
      <RemoteAudioManager peers={peers} />

      {/* Main Video Area */}
      <div className="flex-1 flex flex-col h-full relative z-0 bg-black">
        <div 
          ref={videoContainerRef} 
          className={isFullscreen 
            ? "w-[100vw] h-[100vh] max-w-none max-h-none flex items-center justify-center relative bg-black overflow-hidden" 
            : "flex-1 flex items-center justify-center relative w-full h-full bg-black"
          }
          style={isFullscreen ? { width: '100vw', height: '100vh', maxWidth: 'none', maxHeight: 'none' } : undefined}
        >
          {/* Edge Triggers (Always Active) */}
          <div className="absolute top-0 left-0 right-0 h-4 z-[9999]" onMouseEnter={() => setHoverZones(p => ({ ...p, top: true }))} />
          <div className="absolute top-0 bottom-0 right-0 w-4 z-[9999]" onMouseEnter={() => setHoverZones(p => ({ ...p, right: true }))} />
          <div className="absolute bottom-0 left-0 right-0 h-4 z-[9999]" onMouseEnter={handleMouseEnterBottom} />
          {hostAnnouncementActive && (
            <div className="absolute top-4 left-1/2 -translate-x-1/2 z-[9600] flex items-center gap-2 rounded-full border border-red-400/40 bg-red-600/90 px-5 py-2 text-sm font-semibold text-white shadow-[0_0_30px_rgba(220,38,38,0.5)] backdrop-blur animate-fade-up">
              <span className="relative flex h-2.5 w-2.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white/80" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-white" />
              </span>
              <Mic2 size={16} />
              Host is speaking
            </div>
          )}
          {connectionStatus === 'reconnecting' && !reconnectError && (
            <div className="absolute top-16 left-1/2 -translate-x-1/2 z-[9600] flex items-center gap-2 rounded-full border border-amber-400/30 bg-amber-500/90 px-4 py-1.5 text-xs font-semibold text-black shadow-lg backdrop-blur pointer-events-none">
              <WifiOff size={14} className="animate-pulse" />
              Reconnecting to room…
            </div>
          )}
          {reconnectError && (
            <div className="absolute top-16 left-1/2 -translate-x-1/2 z-[9600] flex items-center gap-2 rounded-full border border-red-400/30 bg-red-600/95 px-4 py-1.5 text-xs font-semibold text-white shadow-lg backdrop-blur pointer-events-auto">
              <WifiOff size={14} />
              <span>Connection error: {reconnectError}</span>
              <button
                onClick={() => window.location.reload()}
                className="ml-1 rounded-full bg-white/20 px-2 py-0.5 font-bold hover:bg-white/30"
              >
                Retry
              </button>
            </div>
          )}

          {/* Top Edge Overlay Area */}
          <div 
            className={`absolute top-0 left-0 right-0 h-32 z-[9000] transition-opacity duration-300 ${hoverZones.top ? 'opacity-100 pointer-events-auto' : 'opacity-0 md:pointer-events-none max-md:opacity-100 max-md:pointer-events-auto max-md:h-16'}`}
            onMouseLeave={() => setHoverZones(p => ({ ...p, top: false }))}
          >
            {/* Main Screen Selection Dropdown */}
            <div className="absolute top-4 left-4 z-50">
              <select 
                value={mainScreenSource}
                onChange={(e) => {
                  pendingMainScreenSourceRef.current = null;
                  setMainScreenSource(e.target.value);
                }}
                className="rounded-xl border border-white/10 bg-ink-900/80 px-3 py-2 text-sm font-medium text-white shadow-lg backdrop-blur-md focus:border-indigo-400/60 focus:outline-none"
                aria-label="Main screen source"
              >
                <option value="url">🎬 Video player</option>
                {screenStreamState && <option value={screenStreamState.id}>🖥️ Your screen</option>}
                {Object.entries(screenShares).map(([socketId, screenShareStream]) => {
                  const sId = typeof screenShareStream === "string" ? screenShareStream : (screenShareStream as MediaStream).id;
                  return (
                    <option key={sId} value={sId}>🖥️ {participantName(socketId)}'s screen</option>
                  );
                })}
              </select>
            </div>

            {/* Room Info & Duration */}
            <div className="absolute top-4 right-4 z-50 flex items-center gap-2 max-md:right-16">
              <div className="hidden items-center gap-2 rounded-xl border border-white/10 bg-ink-900/80 py-1.5 pl-3 pr-1.5 text-sm text-white shadow-lg backdrop-blur-md sm:flex">
                <span className="max-w-[14rem] truncate font-semibold">{roomName || 'Room'}</span>
                {isRoomHost && roomSettings && (
                  <button
                    onClick={() => setIsRoomSettingsOpen(true)}
                    className="rounded-lg p-1 text-slate-400 transition-colors hover:bg-white/10 hover:text-white"
                    title="Room settings"
                    aria-label="Room settings"
                  >
                    <SlidersHorizontal size={14} />
                  </button>
                )}
                {roomDisplayId && (
                  <button
                    onClick={handleCopyCode}
                    className="flex items-center gap-1 rounded-lg bg-white/10 px-2 py-0.5 font-mono text-xs text-slate-200 transition-colors hover:bg-white/20"
                    title="Copy room code"
                  >
                    {roomDisplayId}
                    {codeCopied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
                  </button>
                )}
              </div>
              <div className="flex items-center gap-1.5 rounded-xl border border-white/10 bg-ink-900/80 px-3 py-2 font-mono text-xs text-slate-200 shadow-lg backdrop-blur-md">
                <span className="h-1.5 w-1.5 rounded-full bg-red-500 shadow-[0_0_6px] shadow-red-500" />
                {duration}
              </div>
            </div>
          </div>

          {/* Main Screen Renderer */}
          {mainScreenSource === 'url' ? (
            id ? (
              <div 
                className={isFullscreen ? "w-[100vw] h-[100vh] max-w-none max-h-none flex-1 flex" : "w-full h-full flex-1 flex"}
                style={isFullscreen ? { width: '100vw', height: '100vh', maxWidth: 'none', maxHeight: 'none' } : undefined}
              >
                <VideoPlayer ref={videoPlayerRef} roomId={id} isFullscreen={isFullscreen} isHost={isHost} isRoomHost={isRoomHost} broadcastMediaStream={broadcastMediaStream} shareScreen={shareScreen} />
              </div>
            ) : null
          ) : (
            (() => {
              const streamToRender = [
                ...(screenStreamState ? [screenStreamState] : []),
                ...Object.values(screenShares).map((s) => (typeof s === "string" ? null : s)).filter((s): s is MediaStream => !!s),
              ].find(s => s && s.id === mainScreenSource);

              if (!streamToRender) {
                return id ? (
                  <div 
                    className={isFullscreen ? "w-[100vw] h-[100vh] max-w-none max-h-none flex-1 flex" : "w-full h-full flex-1 flex"}
                    style={isFullscreen ? { width: '100vw', height: '100vh', maxWidth: 'none', maxHeight: 'none' } : undefined}
                  >
                    <VideoPlayer ref={videoPlayerRef} roomId={id} isFullscreen={isFullscreen} isHost={isHost} isRoomHost={isRoomHost} broadcastMediaStream={broadcastMediaStream} shareScreen={shareScreen} />
                  </div>
                ) : null;
              }

              return (
                <div 
                  className={`w-full h-full flex items-center justify-center bg-black ${isFullscreen ? 'w-[100vw] h-[100vh] max-w-none max-h-none' : 'p-4'}`}
                  style={isFullscreen ? { width: '100vw', height: '100vh', maxWidth: 'none', maxHeight: 'none' } : undefined}
                >
                  <video 
                    ref={el => { 
                      if (el && streamToRender && el.srcObject !== streamToRender) {
                        el.srcObject = streamToRender; 
                        el.play().catch(err => console.warn("[Room] Captured stream playback notice:", err));
                      }
                    }}
                    autoPlay 
                    playsInline 
                    className={`w-full h-full object-contain ${isFullscreen ? 'max-w-[100vw] max-h-[100vh] rounded-none border-0' : 'max-w-full max-h-full rounded-xl shadow-2xl border border-slate-800'}`}
                    style={isFullscreen ? { width: '100%', height: '100%', maxWidth: '100vw', maxHeight: '100vh' } : undefined}
                  />
                </div>
              );
            })()
          )}

          {/* Right Edge Overlay Area */}
          <div 
            className={`absolute top-0 right-0 bottom-0 w-32 z-[9000] flex flex-col items-end justify-center pr-4 transition-opacity duration-300 ${hoverZones.right ? 'opacity-100 pointer-events-auto' : 'opacity-0 md:pointer-events-none max-md:opacity-100 max-md:pointer-events-auto max-md:w-16'}`}
            onMouseLeave={() => setHoverZones(p => ({ ...p, right: false }))}
          >
            <div className="flex flex-col items-center gap-2">
              {(!isCameraSidebarOpen || isFullscreen) && (
                <button 
                  onClick={() => {
                    if (isFullscreen) {
                      toggleFullscreen();
                    }
                    setIsCameraSidebarOpen(true);
                  }}
                  className="group grid h-11 w-11 place-items-center rounded-xl border border-white/10 bg-ink-900/80 text-slate-200 shadow-lg backdrop-blur transition-colors hover:bg-indigo-500/30 hover:text-white"
                  title="Open cameras"
                  aria-label="Open cameras"
                >
                  <Users size={20} className="transition-transform group-hover:-translate-x-0.5" />
                </button>
              )}
              {(!isChatOpen || isFullscreen) && (
                <button 
                  onClick={() => {
                    if (isFullscreen) {
                      toggleFullscreen();
                    }
                    setIsChatOpen(true);
                  }}
                  className="group relative grid h-11 w-11 place-items-center rounded-xl border border-white/10 bg-ink-900/80 text-slate-200 shadow-lg backdrop-blur transition-colors hover:bg-indigo-500/30 hover:text-white"
                  title="Open chat"
                  aria-label={unreadCount > 0 ? `Open chat, ${unreadCount} unread` : "Open chat"}
                >
                  <MessageSquare size={20} className="transition-transform group-hover:-translate-x-0.5" />
                  {unreadCount > 0 && (
                    <span className="absolute -right-1.5 -top-1.5 min-w-[20px] rounded-full bg-fuchsia-500 px-1.5 py-0.5 text-center text-[10px] font-bold leading-none text-white shadow-lg animate-scale-in">
                      {unreadCount > 99 ? "99+" : unreadCount}
                    </span>
                  )}
                </button>
              )}
              <button
                onClick={() => setIsInviteModalOpen(true)}
                className="grid h-11 w-11 place-items-center rounded-xl border border-white/10 bg-ink-900/80 text-slate-200 shadow-lg backdrop-blur transition-colors hover:bg-indigo-500/30 hover:text-white"
                title="Invite people"
                aria-label="Invite people"
              >
                <Share2 size={18} />
              </button>
              {id && <ReactionPicker roomId={id} />}

              <button 
                onClick={() => navigate('/dashboard')}
                className="mt-3 grid h-11 w-11 place-items-center rounded-xl border border-red-400/40 bg-red-600/90 text-white shadow-[0_0_20px_rgba(220,38,38,0.35)] transition-colors hover:bg-red-500"
                title="Leave room"
                aria-label="Leave room"
              >
                <LogOut size={18} />
              </button>
            </div>
          </div>

          {/* Floating emoji reactions (inside the fullscreen container so they stay visible) */}
          <ReactionOverlay />
          
          {/* Floating Cameras (rendered here so they overlay the video) */}
          {id && (!isCameraSidebarOpen || isFullscreen) && (
            <VideoGrid 
              localStream={localStreamState || localStream.current} 
              screenStream={screenStreamState} 
              peers={peers}
              peerStatuses={peerStatuses}
              screenShares={screenShares}
              toggleAudio={toggleAudio} 
              toggleVideo={toggleVideo} 
              shareScreen={shareScreen} 
              toggleFullscreen={toggleFullscreen}
              isFullscreen={isFullscreen}
              floating={true}
              isBottomHovered={hoverZones.bottom}
              onMouseLeaveBottom={handleMouseLeaveBottom}
              isHost={isHost}
              roomId={id}
            />
          )}
        </div>
      </div>
      
      {/* Camera Sidebar */}
      {!isFullscreen && isCameraSidebarOpen && (
        <div className="fixed md:relative right-0 w-full md:w-64 h-full bg-ink-900/95 border-l border-white/5 flex flex-col shadow-2xl z-[9999] md:z-10 animate-slide-in-right backdrop-blur-xl">
          <div className="px-3 py-2.5 border-b border-white/5 flex justify-between items-center">
            <span className="font-semibold text-slate-200 text-sm flex items-center gap-2">
              <Users size={16} className="text-indigo-300" /> Cameras
              <span className="rounded-full bg-white/10 px-1.5 text-[10px] font-bold text-slate-300">{peers.length + 1}</span>
            </span>
            <button onClick={() => setIsCameraSidebarOpen(false)} className="btn-ghost px-2 py-1.5" aria-label="Close cameras">
              <ChevronRight size={18} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto overflow-x-hidden relative">
            {id && (
              <VideoGrid 
                localStream={localStreamState || localStream.current} 
                screenStream={screenStreamState} 
                peers={peers}
                peerStatuses={peerStatuses}
                screenShares={screenShares}
                toggleAudio={toggleAudio} 
                toggleVideo={toggleVideo} 
                shareScreen={shareScreen}
                toggleFullscreen={toggleFullscreen}
                isFullscreen={isFullscreen}
                floating={false}
                isHost={isHost}
                roomId={id}
              />
            )}
          </div>
        </div>
      )}

      {/* Live Chat Sidebar */}
      {!isFullscreen && isChatOpen && id && user && (
        <ChatPanel
          roomId={id}
          currentUser={user}
          isHost={isHost}
          hostId={hostId}
          coHostIds={coHostIds}
          hostAnnouncementActive={hostAnnouncementActive}
          onToggleAnnouncement={toggleHostAnnouncement}
          onSeek={handleSeekToTime}
          getTimestamp={getTimestamp}
          onOpenInvite={() => setIsInviteModalOpen(true)}
          onOpenSettings={() => setIsSettingsOpen(true)}
          onClose={() => setIsChatOpen(false)}
          onMakeCoHost={(targetSocketId) => socket?.emit("make_cohost", { roomId: id, targetSocketId })}
          onKick={(targetSocketId, name) => {
            if (confirm(`Remove ${name} from this room? They won't be able to rejoin this session.`)) {
              socket?.emit("kick_participant", { roomId: id, targetSocketId });
            }
          }}
        />
      )}
      <AudioSettingsModal isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} />
      {id && roomSettings && isRoomSettingsOpen && (
        <RoomSettingsModal
          isOpen
          roomId={id}
          initial={roomSettings}
          onClose={() => setIsRoomSettingsOpen(false)}
          onSaved={(next) => {
            setRoomSettings(next);
            setRoomName(next.name);
          }}
        />
      )}
      <Modal isOpen={isShortcutsOpen} onClose={() => setIsShortcutsOpen(false)} title="Keyboard shortcuts">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2.5 p-5 text-sm">
          {[
            ["F", "Toggle fullscreen"],
            ["M", "Mute / unmute microphone"],
            ["V", "Turn camera on / off"],
            ["C", "Open / close chat"],
            ["I", "Invite people"],
            ["?", "Show this help"],
          ].map(([key, label]) => (
            <div key={key} className="contents">
              <dt><kbd className="rounded-md border border-white/15 bg-white/5 px-2 py-0.5 font-mono text-xs text-white">{key}</kbd></dt>
              <dd className="text-slate-300">{label}</dd>
            </div>
          ))}
        </dl>
      </Modal>
      {id && <InviteModal isOpen={isInviteModalOpen} onClose={() => setIsInviteModalOpen(false)} roomId={id} roomCode={roomDisplayId} />}
      <PasswordPrompt
        key={passwordPrompt.error ?? "prompt"}
        isOpen={passwordPrompt.open}
        roomName={roomName}
        error={passwordPrompt.error}
        onCancel={() => navigate("/dashboard")}
        onSubmit={(password) => {
          setPasswordPrompt({ open: false, error: null });
          startJoin(password);
        }}
      />
    </div>
  );
}
