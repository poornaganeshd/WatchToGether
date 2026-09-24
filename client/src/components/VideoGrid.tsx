import { useEffect, useRef, useState } from "react";
import { Mic, MicOff, Video, VideoOff, MonitorUp, Move, Circle, Square, Pin, PinOff, List, LayoutGrid, Maximize, Minimize, Crown, WifiOff, Wifi } from "lucide-react";
import { Rnd } from "react-rnd";

import { useAudioStore } from "../store/useAudioStore";
import { useSocketStore } from "../store/useSocketStore";

interface VideoPlayerProps {
  stream: MediaStream;
  isLocal?: boolean;
  muted?: boolean;
  isActiveSpeaker?: boolean;
  isCircle?: boolean;
  isMicOn?: boolean;
  isPinned?: boolean;
  dataSaver?: boolean;
  isCamOn?: boolean;
  name?: string;
}

function StreamPlayer({
  stream,
  isLocal,
  isActiveSpeaker = false,
  isCircle = false,
  isMicOn = true,
  isPinned = false,
  dataSaver = false,
  isCamOn = true,
  name,
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  const showVideo = isCamOn && (!dataSaver || isLocal);

  return (
    <div
      className={`relative overflow-hidden bg-slate-900 w-full h-full shadow-lg transition-all duration-300 ${
        isCircle ? "rounded-full aspect-square" : "rounded-xl aspect-video"
      } ${isActiveSpeaker ? "ring-4 ring-green-500 shadow-green-500/20" : "border border-slate-800"}`}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={true}
        className={`w-full h-full object-cover ${isLocal ? "scale-x-[-1]" : ""} ${
          !showVideo ? "opacity-0 pointer-events-none absolute inset-0" : ""
        }`}
      />

      {!showVideo && (
        <div className="absolute inset-0 w-full h-full flex flex-col items-center justify-center bg-slate-900/95 text-slate-400 select-none z-10">
          <div
            className={`rounded-full bg-slate-800/90 border border-slate-700 flex items-center justify-center shadow-inner ${
              isCircle ? "w-12 h-12 mb-1" : "w-14 h-14 mb-2"
            }`}
          >
            <VideoOff size={isCircle ? 20 : 24} className="text-slate-500" />
          </div>
          <span className="text-xs text-slate-400 font-medium tracking-wide">
            {dataSaver && !isLocal ? "Data Saver" : (name ? `${name} (Camera Off)` : "Camera Off")}
          </span>
        </div>
      )}

      {isActiveSpeaker && (
        <div
          className={`absolute ${
            isCircle ? "top-4 right-4" : "top-2 right-2"
          } bg-green-500 text-white p-1 rounded-full animate-pulse shadow-lg z-20`}
        >
          <Mic size={14} />
        </div>
      )}
      {!isMicOn && (
        <div
          className={`absolute ${
            isCircle ? "bottom-4 left-4" : "bottom-2 left-2"
          } bg-red-500 text-white p-1 rounded-md shadow-lg z-20`}
        >
          <MicOff size={14} />
        </div>
      )}
      {isPinned && (
        <div
          className={`absolute ${
            isCircle ? "top-4 left-4" : "top-2 left-2"
          } bg-indigo-500 text-white p-1.5 rounded-full shadow-lg z-20`}
        >
          <Pin size={12} className="fill-white" />
        </div>
      )}
      {isLocal && (
        <div
          className={`absolute ${
            isCircle ? "bottom-4 right-4" : "bottom-2 right-2"
          } bg-indigo-600 text-white text-xs px-2 py-1 rounded-md font-medium shadow z-20`}
        >
          You
        </div>
      )}
    </div>
  );
}

interface VideoGridProps {
  localStream: MediaStream | null;
  screenStream?: MediaStream | null;
  peers: { socketId: string, stream: MediaStream }[];
  peerStatuses?: Record<string, { cam: boolean, mic: boolean }>;
  toggleAudio: () => void;
  toggleVideo: () => void;
  shareScreen: () => void;
  toggleFullscreen?: () => void;
  isFullscreen?: boolean;
  floating?: boolean;
  isBottomHovered?: boolean;
  onMouseLeaveBottom?: () => void;
  isHost?: boolean;
  roomId?: string;
  screenShares?: Record<string, MediaStream | string>;
}

export default function VideoGrid({ localStream, screenStream, peers, peerStatuses = {}, screenShares = {}, toggleAudio, toggleVideo, shareScreen, toggleFullscreen, isFullscreen = false, floating = false, isBottomHovered = false, onMouseLeaveBottom, isHost = false, roomId }: VideoGridProps) {
  const videoEnabled = !!(localStream?.getVideoTracks().some((t) => t.enabled && t.readyState === "live"));
  const audioEnabled = !!(localStream?.getAudioTracks().some((t) => t.enabled && t.readyState === "live"));
  const [isCircle, setIsCircle] = useState(() => localStorage.getItem("vg_isCircle") === "true");
  const [viewMode, setViewMode] = useState<'list' | 'grid'>(() => (localStorage.getItem("vg_viewMode") as 'list' | 'grid') || 'grid');
  const [pinnedPeers, setPinnedPeers] = useState<string[]>([]);
  const [maxCameras, setMaxCameras] = useState(() => parseInt(localStorage.getItem("vg_maxCameras") || "2", 10));
  const [dataSaver, setDataSaver] = useState(() => localStorage.getItem("vg_dataSaver") === "true");

  useEffect(() => { localStorage.setItem("vg_isCircle", String(isCircle)); }, [isCircle]);
  useEffect(() => { localStorage.setItem("vg_viewMode", viewMode); }, [viewMode]);
  useEffect(() => { localStorage.setItem("vg_maxCameras", String(maxCameras)); }, [maxCameras]);
  useEffect(() => { localStorage.setItem("vg_dataSaver", String(dataSaver)); }, [dataSaver]);
  
  const { activeSpeakers } = useAudioStore();
  const { socket } = useSocketStore();
  const participants = useSocketStore((s) => s.participants);

  const handleToggleAudio = () => {
    toggleAudio();
  };

  const handleToggleVideo = () => {
    toggleVideo();
  };

  const togglePin = (id: string) => {
    setPinnedPeers(prev => prev.includes(id) ? prev.filter(p => p !== id) : [...prev, id]);
  };

  const makeCoHost = (targetSocketId: string) => {
    if (!roomId || !socket) return;
    // For simplicity, we assume we know the target's userId, but in WebRTC we only have socketId here.
    // We should get the targetUserId by doing a lookup or just emitting the socketId.
    // Let's emit the socketId instead, and server can lookup the userId if needed.
    // Wait, the API requires targetUserId. Let's emit make_cohost with socketId and let the backend find it.
    socket.emit("make_cohost", { roomId, targetSocketId });
  };

  const isSharingScreen = !!screenStream;

  const buttons = (
    <>
      <button onClick={() => setIsCircle(!isCircle)} className="p-2 rounded-lg transition-colors bg-slate-800/80 hover:bg-slate-700 text-white shadow" title="Toggle Camera Shape">
        {isCircle ? <Square size={16} /> : <Circle size={16} />}
      </button>
      <button 
        onClick={shareScreen} 
        className={`p-2 rounded-lg transition-colors shadow ${isSharingScreen ? 'bg-red-500/80 text-white border border-red-400' : 'bg-slate-800/80 hover:bg-slate-700 text-white'}`} 
        title={isSharingScreen ? "Stop Sharing Screen" : "Share Screen"}
      >
        <MonitorUp size={16} />
      </button>
      {toggleFullscreen && (
        <button onClick={toggleFullscreen} className="p-2 rounded-lg transition-colors bg-slate-800/80 hover:bg-slate-700 text-white shadow" title="Toggle Fullscreen">
          {isFullscreen ? <Minimize size={16} /> : <Maximize size={16} />}
        </button>
      )}
      <button onClick={handleToggleAudio} className={`p-2 rounded-lg transition-colors shadow ${audioEnabled ? 'bg-slate-800/80 hover:bg-slate-700 text-white' : 'bg-red-500/80 text-white border border-red-400'}`} title="Toggle Audio">
        {audioEnabled ? <Mic size={16} /> : <MicOff size={16} />}
      </button>
      <button onClick={handleToggleVideo} className={`p-2 rounded-lg transition-colors shadow ${videoEnabled ? 'bg-slate-800/80 hover:bg-slate-700 text-white' : 'bg-red-500/80 text-white border border-red-400'}`} title="Toggle Video">
        {videoEnabled ? <Video size={16} /> : <VideoOff size={16} />}
      </button>
      <button onClick={() => setDataSaver(!dataSaver)} className={`p-2 rounded-lg transition-colors shadow ${dataSaver ? 'bg-indigo-600 text-white' : 'bg-slate-800/80 hover:bg-slate-700 text-slate-300'}`} title={dataSaver ? "Data Saver: ON" : "Data Saver: OFF"}>
        {dataSaver ? <WifiOff size={16} /> : <Wifi size={16} />}
      </button>
    </>
  );

  const controls = floating ? (
    <>
      <div 
        className={`absolute bottom-0 left-0 right-0 h-48 z-[9000] flex justify-center items-end pb-8 transition-opacity duration-300 ${isBottomHovered ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`}
        onMouseLeave={onMouseLeaveBottom}
      >
        <div className="bg-slate-900/90 backdrop-blur-md px-4 py-2 rounded-full border border-slate-700 shadow-2xl flex gap-4">
          {buttons}
        </div>
      </div>
    </>
  ) : (
    <div className="flex flex-col gap-3 mb-4">
      <div className="flex justify-between items-center">
        <div className="flex items-center gap-1 bg-slate-800/50 p-1 rounded-lg">
          <button onClick={() => setViewMode('grid')} className={`p-1.5 rounded-md transition-all ${viewMode === 'grid' ? 'bg-indigo-600 text-white shadow' : 'text-slate-400 hover:text-white hover:bg-slate-700'}`} title="Grid View">
            <LayoutGrid size={16} />
          </button>
          <button onClick={() => setViewMode('list')} className={`p-1.5 rounded-md transition-all ${viewMode === 'list' ? 'bg-indigo-600 text-white shadow' : 'text-slate-400 hover:text-white hover:bg-slate-700'}`} title="List View">
            <List size={16} />
          </button>
        </div>
      </div>
      <div className="flex gap-2 flex-wrap">
        {buttons}
      </div>
    </div>
  );

  const screenShareStreamIds = Object.values(screenShares)
    .map((s) => (typeof s === "string" ? s : s?.id))
    .filter((id): id is string => typeof id === "string" && id.length > 0);

  const allStreams = [
    ...(localStream
      ? [
          {
            id: "local",
            stream: localStream,
            isLocal: true,
            isActive: socket ? activeSpeakers.includes(socket.id || "") : false,
            isCamOn: videoEnabled,
            isMicOn: audioEnabled,
            name: "You",
          },
        ]
      : []),
    // We intentionally do not include screenStream or remote screen shares in floating grid. They will be rendered in Room main view.
    ...peers
      .filter((p) => !screenShareStreamIds.includes(p.stream.id))
      .map((p) => ({
        id: p.socketId,
        stream: p.stream,
        isLocal: false,
        isActive: activeSpeakers.includes(p.socketId),
        isCamOn:
          peerStatuses[p.socketId]?.cam ??
          p.stream.getVideoTracks().some((t) => t.enabled && t.readyState === "live" && !t.muted),
        isMicOn:
          peerStatuses[p.socketId]?.mic ??
          p.stream.getAudioTracks().some((t) => t.enabled && t.readyState === "live"),
        name: participants[p.socketId]?.userName ?? `Participant ${p.socketId.slice(0, 4)}`,
      })),
  ];

  const remoteStreams = allStreams.filter((s) => !s.isLocal);
  const localStreams = allStreams.filter((s) => s.isLocal);

  const visibleRemoteStreams = floating
    ? remoteStreams
        .sort((a, b) => {
          const aPinned = pinnedPeers.includes(a.id);
          const bPinned = pinnedPeers.includes(b.id);
          if (aPinned && !bPinned) return -1;
          if (!aPinned && bPinned) return 1;
          if (a.isCamOn && !b.isCamOn) return -1;
          if (!a.isCamOn && b.isCamOn) return 1;
          if (a.isActive && !b.isActive) return -1;
          if (!a.isActive && b.isActive) return 1;
          return 0;
        })
        .slice(0, maxCameras)
    : remoteStreams;

  const floatingStreams = [...localStreams, ...visibleRemoteStreams];
  
  if (floating) {
    return (
      <div className="absolute inset-0 w-full h-full pointer-events-none z-[1000]">
        {controls}
        {floatingStreams.map((s, index) => (
          <Rnd
            key={`${s.id}-${isCircle ? 'circle' : 'rect'}`}
            default={{
              x: 20 + index * 20,
              y: 20 + index * 20,
              width: isCircle ? 160 : 240,
              height: isCircle ? 160 : 135,
            }}
            minWidth={120}
            minHeight={90}
            bounds="parent"
            lockAspectRatio={isCircle}
            className="pointer-events-auto shadow-2xl group !z-[1001]"
            dragHandleClassName="drag-handle"
          >
            <div className="w-full h-full relative group/camera">
              <div className={`drag-handle absolute inset-0 z-30 opacity-0 group-hover/camera:opacity-100 bg-black/40 flex items-center justify-center cursor-move transition-opacity duration-300 ${isCircle ? 'rounded-full' : 'rounded-xl'}`}>
                <Move className="text-white drop-shadow-lg" size={32} />
              </div>
              <StreamPlayer
                stream={s.stream}
                isLocal={s.isLocal}
                isActiveSpeaker={s.isActive}
                isCircle={isCircle}
                isMicOn={s.isMicOn}
                isPinned={pinnedPeers.includes(s.id)}
                dataSaver={dataSaver}
                isCamOn={s.isCamOn}
                name={s.name}
              />
            </div>
          </Rnd>
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4 h-full">
      {controls}
      <div className="flex-1 overflow-y-auto pr-1 pb-20">
        {viewMode === 'list' ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between mb-2 bg-slate-800/80 p-3 rounded-lg border border-slate-700">
              <label className="text-sm font-medium text-slate-300">Max Remote Cameras on Video:</label>
              <input 
                type="number" 
                value={maxCameras} 
                onChange={e => setMaxCameras(Math.max(1, parseInt(e.target.value) || 1))}
                className="w-16 bg-black/50 border border-slate-600 rounded px-2 py-1 text-white text-center text-sm focus:ring-1 focus:ring-indigo-500 focus:outline-none"
                min="1"
              />
            </div>
            {allStreams.map(s => (
              <div key={s.id} className="flex items-center justify-between p-3 bg-slate-800/30 border border-slate-800 rounded-lg hover:bg-slate-800/80 transition-colors">
                <div className="flex items-center gap-3">
                  <div className={`w-2 h-2 rounded-full shadow-[0_0_8px_rgba(0,0,0,0.5)] ${s.isActive ? 'bg-green-500 animate-pulse shadow-green-500/50' : 'bg-slate-600'}`} />
                  <span className="text-slate-200 font-medium text-sm">{s.isLocal ? (s.id === 'screen' ? 'Your Screen' : 'You') : s.name}</span>
                </div>
                <div className="flex items-center gap-3 text-slate-400">
                  {s.isMicOn ? <Mic size={16} className="text-slate-300" /> : <MicOff size={16} className="text-red-400" />}
                  {s.isCamOn ? <Video size={16} className="text-slate-300" /> : <VideoOff size={16} className="text-red-400" />}
                  {!s.isLocal && isHost && (
                    <button 
                      onClick={() => makeCoHost(s.id)}
                      className="p-1.5 rounded-md transition-colors hover:bg-yellow-500/20 text-yellow-500 hover:text-yellow-400"
                      title="Make Co-Host"
                    >
                      <Crown size={14} />
                    </button>
                  )}
                  {!s.isLocal && (
                    <button 
                      onClick={() => togglePin(s.id)}
                      className={`p-1.5 rounded-md transition-colors ${pinnedPeers.includes(s.id) ? 'bg-indigo-600 text-white shadow' : 'hover:bg-slate-700 text-slate-500 hover:text-white'}`}
                      title="Pin Participant"
                    >
                      {pinnedPeers.includes(s.id) ? <Pin size={14} className="fill-white" /> : <PinOff size={14} />}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-4">
            {allStreams.map(s => (
              <div key={s.id} className={`${isCircle ? 'aspect-square w-2/3 mx-auto relative group/cam' : 'aspect-video w-full relative group/cam'}`}>
                <StreamPlayer
                  stream={s.stream}
                  isLocal={s.isLocal}
                  isActiveSpeaker={s.isActive}
                  isCircle={isCircle}
                  isMicOn={s.isMicOn}
                  isPinned={pinnedPeers.includes(s.id)}
                  dataSaver={dataSaver}
                  isCamOn={s.isCamOn}
                  name={s.name}
                />
                {!s.isLocal && isHost && (
                  <button 
                    onClick={() => makeCoHost(s.id)}
                    className={`absolute top-2 left-2 p-1.5 rounded-full transition-all z-30 bg-slate-900/80 text-yellow-500 opacity-0 group-hover/cam:opacity-100 hover:bg-slate-800 hover:text-yellow-400`}
                    title="Make Co-Host"
                  >
                    <Crown size={14} />
                  </button>
                )}
                {!s.isLocal && (
                  <button 
                    onClick={() => togglePin(s.id)}
                    className={`absolute top-2 right-2 p-1.5 rounded-full transition-all z-30 ${pinnedPeers.includes(s.id) ? 'bg-indigo-600 text-white shadow-lg' : 'bg-slate-900/80 text-white opacity-0 group-hover/cam:opacity-100 hover:bg-slate-800'}`}
                  >
                    {pinnedPeers.includes(s.id) ? <Pin size={14} className="fill-white" /> : <Pin size={14} />}
                  </button>
                )}
              </div>
            ))}
            {allStreams.length === 0 && (
              <div className="text-center text-slate-500 text-sm mt-8">
                No participants.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
