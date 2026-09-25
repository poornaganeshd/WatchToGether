import { Maximize, Mic, MicOff, MonitorUp, PhoneOff, SlidersHorizontal, UserPlus, Video, VideoOff } from "lucide-react";
import { ReactionPicker } from "./Reactions";
import { isScreenShareSupported } from "../hooks/useWebRTC";

interface MobileControlBarProps {
  roomId: string;
  localStream: MediaStream | null;
  isHost: boolean;
  isSharingScreen: boolean;
  onToggleAudio: () => void;
  onToggleVideo: () => void;
  onShareScreen: () => void;
  onOpenHostControls: () => void;
  onInvite: () => void;
  onLeave: () => void;
  onFullscreen: () => void;
}

const Control = ({
  label,
  onClick,
  active = true,
  danger = false,
  children,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}) => (
  <button
    onClick={onClick}
    aria-label={label}
    title={label}
    className={`flex min-w-0 flex-1 flex-col items-center gap-1 rounded-xl py-1.5 text-[10px] font-medium transition-colors ${
      danger ? "text-red-300 active:bg-red-500/20" : active ? "text-slate-200 active:bg-white/10" : "text-red-300 active:bg-red-500/15"
    }`}
  >
    <span className={`grid h-9 w-9 place-items-center rounded-full ${danger ? "bg-red-600 text-white" : active ? "bg-white/[0.08]" : "bg-red-500/20"}`}>
      {children}
    </span>
    <span className="truncate">{label}</span>
  </button>
);

/** Thumb-reachable room controls for phones. */
export default function MobileControlBar({
  roomId, localStream, isHost, isSharingScreen, onToggleAudio, onToggleVideo, onShareScreen, onOpenHostControls, onInvite, onLeave, onFullscreen,
}: MobileControlBarProps) {
  const micOn = !!localStream?.getAudioTracks().some((t) => t.enabled && t.readyState === "live");
  const camOn = !!localStream?.getVideoTracks().some((t) => t.enabled && t.readyState === "live");

  return (
    <nav
      className="flex shrink-0 items-center gap-1 border-t border-white/5 bg-ink-900/95 px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-1.5 landscape:hidden"
      aria-label="Room controls"
    >
      <Control label={micOn ? "Mute" : "Unmute"} onClick={onToggleAudio} active={micOn}>
        {micOn ? <Mic size={18} /> : <MicOff size={18} />}
      </Control>
      <Control label={camOn ? "Camera" : "Camera off"} onClick={onToggleVideo} active={camOn}>
        {camOn ? <Video size={18} /> : <VideoOff size={18} />}
      </Control>
      <div className="flex min-w-0 flex-1 flex-col items-center gap-1 text-[10px] font-medium text-slate-200">
        <ReactionPicker roomId={roomId} align="center" className="[&>button]:h-9 [&>button]:w-9 [&>button]:rounded-full" />
        <span>React</span>
      </div>
      {isHost ? (
        <Control label="Controls" onClick={onOpenHostControls}>
          <SlidersHorizontal size={18} />
        </Control>
      ) : (
        <Control label="Invite" onClick={onInvite}>
          <UserPlus size={18} />
        </Control>
      )}
      {isScreenShareSupported() ? (
        <Control label={isSharingScreen ? "Stop share" : "Share"} onClick={onShareScreen}>
          <MonitorUp size={18} />
        </Control>
      ) : (
        <Control label="Full screen" onClick={onFullscreen}>
          <Maximize size={18} />
        </Control>
      )}
      <Control label="Leave" onClick={onLeave} danger>
        <PhoneOff size={18} />
      </Control>
    </nav>
  );
}
