import { useEffect, useRef, useState } from "react";
import { useSocketStore } from "../store/useSocketStore";
import { useAuthStore } from "../store/useAuthStore";
import { classifyRemoteStream, type StreamStateContext } from "../utils/streamClassification";

interface PeerConnection {
  [socketId: string]: RTCPeerConnection;
}

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

// STUN alone fails behind symmetric NATs and many corporate/mobile networks, so allow
// a TURN server to be configured, e.g.
// VITE_ICE_SERVERS='[{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]'
const ICE_SERVERS: RTCIceServer[] = (() => {
  const raw = import.meta.env.VITE_ICE_SERVERS;
  if (!raw) return DEFAULT_ICE_SERVERS;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : DEFAULT_ICE_SERVERS;
  } catch {
    console.warn("VITE_ICE_SERVERS is not valid JSON; falling back to public STUN servers");
    return DEFAULT_ICE_SERVERS;
  }
})();

// Match senders by their transceiver's media kind. A sender whose track was replaced with null
// could otherwise be an audio *or* video slot.
const findSenderByKind = (pc: RTCPeerConnection, kind: "audio" | "video"): RTCRtpSender | undefined => {
  if (typeof pc.getTransceivers === "function") {
    const transceiver = pc.getTransceivers().find(
      (t) => t.receiver?.track?.kind === kind || (t.sender?.track && t.sender.track.kind === kind)
    );
    if (transceiver) return transceiver.sender;
  }
  return pc.getSenders().find((s) => s.track?.kind === kind);
};

const findVideoSender = (pc: RTCPeerConnection): RTCRtpSender | undefined => {
  if (typeof pc.getTransceivers === "function") {
    const videoTransceiver = pc.getTransceivers().find(
      (t) => t.receiver?.track?.kind === "video" || (t.sender?.track && t.sender.track.kind === "video")
    );
    if (videoTransceiver) return videoTransceiver.sender;
  }
  if (typeof pc.getSenders === "function") {
    const senders = pc.getSenders();
    const senderWithVideoTrack = senders.find((s) => s.track && s.track.kind === "video");
    if (senderWithVideoTrack) return senderWithVideoTrack;
    const senderWithNullTrack = senders.find((s) => s.track === null);
    if (senderWithNullTrack) return senderWithNullTrack;
  }
  return undefined;
};

export function useWebRTC(roomId: string) {
  const { socket } = useSocketStore();
  const { user } = useAuthStore();
  
  const [peers, setPeers] = useState<{ socketId: string, stream: MediaStream }[]>([]);
  const [peerStatuses, setPeerStatuses] = useState<Record<string, { cam: boolean, mic: boolean }>>({});
  const [screenShares, setScreenShares] = useState<Record<string, MediaStream>>({}); // socketId -> screenShareStream
  const [localStreamState, setLocalStreamState] = useState<MediaStream | null>(null);
  const [screenStreamState, setScreenStreamState] = useState<MediaStream | null>(null);
  const localStream = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const peerConnections = useRef<PeerConnection>({});
  const mediaPromise = useRef<Promise<MediaStream | null> | null>(null);
  const pendingCandidates = useRef<Record<string, RTCIceCandidateInit[]>>({});
  const toggleVideoPromiseRef = useRef<Promise<void>>(Promise.resolve());
  const streamStateContext = useRef<StreamStateContext>({
    cameraStreamIds: {},
    screenShareStreamIds: {},
  });

  const getLocalStream = async () => {
    // Cleanly stop any existing local tracks before acquiring fresh media
    if (localStream.current) {
      localStream.current.getTracks().forEach((t) => {
        try {
          t.stop();
          t.enabled = false;
        } catch (e) {
          console.warn("Error stopping old track:", e);
        }
      });
      localStream.current = null;
    }

    let resolveMedia: ((stream: MediaStream | null) => void) | undefined;
    mediaPromise.current = new Promise((res) => {
      resolveMedia = res;
    });

    try {
      const savedVideo = localStorage.getItem('wt_pref_camera') !== 'false';
      const savedAudio = localStorage.getItem('wt_pref_mic') !== 'false';

      let stream: MediaStream;
      if (savedVideo) {
        try {
          stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        } catch (err) {
          console.warn("Initial getUserMedia with video failed, retrying after release delay...", err);
          // Wait 300ms to allow OS/browser to release camera hardware if user just left/rejoined
          await new Promise((r) => setTimeout(r, 300));
          try {
            stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
          } catch (retryErr) {
            console.warn("Retry failed, falling back to audio-only (preserving wt_pref_camera preference):", retryErr);
            try {
              stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            } catch (audioErr) {
              // No microphone (or it was denied) but a camera may still work.
              console.warn("Audio-only failed, trying camera-only:", audioErr);
              stream = await navigator.mediaDevices.getUserMedia({ video: true });
            }
            // IMPORTANT: Never write wt_pref_camera = 'false' here on transient hardware failure
          }
        }
      } else {
        // User explicitly preferred camera off
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }

      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack && !savedAudio) {
        audioTrack.enabled = false;
      }

      localStream.current = stream;
      setLocalStreamState(stream);
      if (resolveMedia) resolveMedia(stream);

      // Broadcast initial status once media is acquired
      const cam = stream.getVideoTracks().some((t) => t.enabled && t.readyState === "live");
      const mic = stream.getAudioTracks().some((t) => t.enabled && t.readyState === "live");
      socket?.emit("participant_status", { roomId, cam, mic });

      return stream;
    } catch (err) {
      // No usable devices or permission denied: join as a receive-only participant with an empty
      // stream, so peer connections are still created and camera/mic can be enabled later.
      console.error("Failed to get any local stream, joining without camera/mic", err);
      const emptyStream = new MediaStream();
      localStream.current = emptyStream;
      setLocalStreamState(emptyStream);
      if (resolveMedia) resolveMedia(emptyStream);
      socket?.emit("participant_status", { roomId, cam: false, mic: false });
      return emptyStream;
    }
  };



  useEffect(() => {
    let isMounted = true;
    if (!socket || !user) return;

    const createPeerConnection = (peerSocketId: string, stream: MediaStream) => {
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

      pc.onicecandidate = (event) => {
        if (!isMounted || pc.signalingState === "closed") return;
        const currentSession = useSocketStore.getState().currentRoomSession;
        if (!currentSession || currentSession.roomId !== roomId) return;

        if (event.candidate && socket && socket.connected) {
          socket.emit("webrtc_ice_candidate", {
            candidate: event.candidate,
            to: peerSocketId,
            from: socket.id,
          });
        }
      };

      pc.onnegotiationneeded = async () => {
        try {
          if (!isMounted || pc.signalingState !== "stable") return;
          const currentSession = useSocketStore.getState().currentRoomSession;
          if (!currentSession || currentSession.roomId !== roomId) return;

          const offer = await pc.createOffer();
          if (!isMounted || pc.signalingState !== "stable") return;
          await pc.setLocalDescription(offer);
          if (!isMounted || (pc.signalingState as string) === "closed") return;
          socket?.emit("webrtc_offer", { offer, to: peerSocketId, from: socket.id });
        } catch (err) {
          console.error("Negotiation error", err);
        }
      };

      pc.ontrack = (event) => {
        if (event.track) {
          event.track.onmute = () => {
            if (event.track.kind === "video") {
              setPeerStatuses((prev) => ({
                ...prev,
                [peerSocketId]: { ...(prev[peerSocketId] || { mic: true }), cam: false },
              }));
            }
          };
          event.track.onunmute = () => {
            if (event.track.kind === "video") {
              setPeerStatuses((prev) => ({
                ...prev,
                [peerSocketId]: { ...(prev[peerSocketId] || { mic: true }), cam: true },
              }));
            }
          };
        }

        const stream = event.streams[0];
        if (!stream) return;

        const kind = classifyRemoteStream(peerSocketId, stream.id, streamStateContext.current);
        if (kind === "screen_share") {
          streamStateContext.current.screenShareStreamIds[peerSocketId] = stream.id;
          setScreenShares((prev) => ({ ...prev, [peerSocketId]: stream }));
          // Ensure screen-share stream never replaces or sits inside peers
          setPeers((prev) => prev.filter((p) => !(p.socketId === peerSocketId && p.stream.id === stream.id)));
        } else {
          // Camera / microphone primary stream
          streamStateContext.current.cameraStreamIds[peerSocketId] = stream.id;
          setPeers((prev) => {
            const exists = prev.some((p) => p.socketId === peerSocketId);
            if (exists) {
              return prev.map((p) => (p.socketId === peerSocketId ? { ...p, stream } : p));
            }
            return [...prev, { socketId: peerSocketId, stream }];
          });
        }
      };

      const hasVideoTrack = stream.getVideoTracks().some((t) => t.readyState === "live");
      stream.getTracks().forEach((track) => {
        pc.addTrack(track, stream);
      });

      // Pre-add video transceiver if no video track exists initially, so future camera ON
      // uses replaceTrack without renegotiation
      if (!hasVideoTrack && typeof pc.addTransceiver === "function") {
        try {
          pc.addTransceiver("video", { direction: "sendrecv", streams: [stream] });
        } catch (e) {
          console.warn("Could not pre-add video transceiver", e);
        }
      }
      // Same for audio, so people without a microphone still receive everyone else's audio
      // and can enable their mic later.
      if (stream.getAudioTracks().length === 0 && typeof pc.addTransceiver === "function") {
        try {
          pc.addTransceiver("audio", { direction: "sendrecv", streams: [stream] });
        } catch (e) {
          console.warn("Could not pre-add audio transceiver", e);
        }
      }

      if (screenStreamRef.current) {
        screenStreamRef.current.getTracks().forEach((track) => {
          pc.addTrack(track, screenStreamRef.current!);
        });
      }

      peerConnections.current[peerSocketId] = pc;
      return pc;
    };

    const waitForMedia = async () => {
      if (localStream.current) return true;
      if (mediaPromise.current) {
        await mediaPromise.current;
        return !!localStream.current;
      }
      return false;
    };

    const handleUserJoined = async ({ socketId }: { socketId: string }) => {
      if (!isMounted) return;
      const ready = await waitForMedia();
      if (!isMounted || !ready) return;
      
      // Clean up any pre-existing connection for this socketId if present
      if (peerConnections.current[socketId]) {
        const oldPc = peerConnections.current[socketId];
        oldPc.onicecandidate = null;
        oldPc.onnegotiationneeded = null;
        oldPc.ontrack = null;
        oldPc.close();
        delete peerConnections.current[socketId];
      }

      createPeerConnection(socketId, localStream.current!);
      // broadcast our current status to the new user
      const cam = (localStream.current?.getVideoTracks() || []).some((t) => t.enabled && t.readyState === "live");
      const mic = (localStream.current?.getAudioTracks() || []).some((t) => t.enabled && t.readyState === "live");
      socket.emit("participant_status", { roomId, cam, mic });
      if (screenStreamRef.current) {
        socket.emit("screen_share_start", { roomId, streamId: screenStreamRef.current.id });
      }
    };
    socket.on("user_joined", handleUserJoined);

    const handleParticipantStatus = ({ socketId, cam, mic }: { socketId: string; cam: boolean; mic: boolean }) => {
      if (!isMounted) return;
      setPeerStatuses((prev) => ({ ...prev, [socketId]: { cam, mic } }));
    };
    socket.on("participant_status", handleParticipantStatus);

    const handleRoomParticipantStatuses = (statuses: Record<string, { cam: boolean; mic: boolean }>) => {
      if (!isMounted) return;
      setPeerStatuses((prev) => ({ ...prev, ...statuses }));
    };
    socket.on("room_participant_statuses", handleRoomParticipantStatuses);

    const handleOffer = async ({ offer, from }: { offer: RTCSessionDescriptionInit; from: string }) => {
      if (!isMounted) return;
      const currentSession = useSocketStore.getState().currentRoomSession;
      if (!currentSession || currentSession.roomId !== roomId) return;
      const ready = await waitForMedia();
      if (!isMounted || !ready) return;
      
      let pc = peerConnections.current[from];
      if (!pc) {
        pc = createPeerConnection(from, localStream.current!);
      }
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        if (!isMounted) return;
        
        // Drain any buffered ICE candidates that arrived before the offer
        const candidates = pendingCandidates.current[from] || [];
        pendingCandidates.current[from] = [];
        for (const c of candidates) {
          await pc.addIceCandidate(new RTCIceCandidate(c)).catch(console.error);
        }

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        if (!isMounted) return;
        socket.emit("webrtc_answer", { answer, to: from, from: socket.id });

        // Broadcast our participant status so the offerer has our latest status
        const cam = (localStream.current?.getVideoTracks() || []).some((t) => t.enabled && t.readyState === "live");
        const mic = (localStream.current?.getAudioTracks() || []).some((t) => t.enabled && t.readyState === "live");
        socket.emit("participant_status", { roomId, cam, mic });
      } catch (err) {
        console.error("Failed to handle offer", err);
      }
    };
    socket.on("webrtc_offer", handleOffer);

    const handleAnswer = async ({ answer, from }: { answer: RTCSessionDescriptionInit; from: string }) => {
      if (!isMounted) return;
      const currentSession = useSocketStore.getState().currentRoomSession;
      if (!currentSession || currentSession.roomId !== roomId) return;
      const ready = await waitForMedia();
      if (!isMounted || !ready) return;
      
      const pc = peerConnections.current[from];
      if (pc) {
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(answer));
        } catch (err) {
          console.error("Failed to set answer", err);
        }
      }
    };
    socket.on("webrtc_answer", handleAnswer);

    const handleIceCandidate = async ({ candidate, from }: { candidate: RTCIceCandidateInit; from: string }) => {
      if (!isMounted) return;
      const currentSession = useSocketStore.getState().currentRoomSession;
      if (!currentSession || currentSession.roomId !== roomId) return;
      const ready = await waitForMedia();
      if (!isMounted || !ready) return;
      
      const pc = peerConnections.current[from];
      if (pc && pc.remoteDescription) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
          console.error("Failed to add ICE candidate", err);
        }
      } else {
        // Buffer ICE candidate if peer connection or remote description isn't ready
        if (!pendingCandidates.current[from]) pendingCandidates.current[from] = [];
        pendingCandidates.current[from].push(candidate);
      }
    };
    socket.on("webrtc_ice_candidate", handleIceCandidate);

    const handleUserLeft = ({ socketId }: { socketId: string }) => {
      if (!isMounted) return;
      if (peerConnections.current[socketId]) {
        const pc = peerConnections.current[socketId];
        pc.onicecandidate = null;
        pc.onnegotiationneeded = null;
        pc.ontrack = null;
        pc.close();
        delete peerConnections.current[socketId];
      }
      delete pendingCandidates.current[socketId];
      delete streamStateContext.current.cameraStreamIds[socketId];
      delete streamStateContext.current.screenShareStreamIds[socketId];
      setPeers((prev) => prev.filter((p) => p.socketId !== socketId));
      setPeerStatuses((prev) => {
        const next = { ...prev };
        delete next[socketId];
        return next;
      });
      setScreenShares((prev) => {
        const next = { ...prev };
        delete next[socketId];
        return next;
      });
    };
    socket.on("user_left", handleUserLeft);

    const handleScreenShareStart = ({ socketId, streamId }: { socketId: string; streamId: string }) => {
      if (!isMounted) return;
      streamStateContext.current.screenShareStreamIds[socketId] = streamId;

      // If this stream was already received on ontrack before this signal, promote it to screenShares and clean from peers
      let streamToPromote: MediaStream | undefined = undefined;
      setPeers((prevPeers) => {
        const misplaced = prevPeers.find((p) => p.socketId === socketId && p.stream.id === streamId);
        if (misplaced) {
          streamToPromote = misplaced.stream;
          return prevPeers.filter((p) => !(p.socketId === socketId && p.stream.id === streamId));
        }
        return prevPeers;
      });

      setScreenShares((prev) => ({
        ...prev,
        [socketId]: streamToPromote || prev[socketId] || streamId,
      }));
    };
    socket.on("screen_share_start", handleScreenShareStart);

    const handleScreenShareStop = ({ socketId }: { socketId: string }) => {
      if (!isMounted) return;
      delete streamStateContext.current.screenShareStreamIds[socketId];
      setScreenShares((prev) => {
        const next = { ...prev };
        delete next[socketId];
        return next;
      });
    };
    socket.on("screen_share_stop", handleScreenShareStop);

    const handleSocketDisconnect = () => {
      if (!isMounted) return;
      console.log("Socket disconnected, cleaning up WebRTC connections for reconnect");
      Object.values(peerConnections.current).forEach(pc => {
        pc.onicecandidate = null;
        pc.onnegotiationneeded = null;
        pc.ontrack = null;
        pc.close();
      });
      peerConnections.current = {};
      pendingCandidates.current = {};
      streamStateContext.current = { cameraStreamIds: {}, screenShareStreamIds: {} };
      setPeers([]);
      setPeerStatuses({});
      setScreenShares({});
    };

    const handleSocketConnect = async () => {
      if (!isMounted) return;
      const currentSession = useSocketStore.getState().currentRoomSession;
      if (!currentSession || currentSession.roomId !== roomId) return;

      console.log("Socket reconnected, restoring camera according to saved preference");
      const savedVideo = localStorage.getItem("wt_pref_camera") !== "false";
      const savedAudio = localStorage.getItem("wt_pref_mic") !== "false";

      const hasLiveVideo = (localStream.current?.getVideoTracks() || []).some(
        (t) => t.enabled && t.readyState === "live"
      );
      const hasLiveAudio = (localStream.current?.getAudioTracks() || []).some(
        (t) => t.readyState === "live"
      );

      if (!localStream.current || !hasLiveAudio || (savedVideo && !hasLiveVideo)) {
        await getLocalStream();
      } else {
        const videoTrack = localStream.current.getVideoTracks()[0];
        if (videoTrack) {
          videoTrack.enabled = savedVideo;
        }
        const audioTrack = localStream.current.getAudioTracks()[0];
        if (audioTrack) {
          audioTrack.enabled = savedAudio;
        }
        const cam = (localStream.current.getVideoTracks() || []).some(
          (t) => t.enabled && t.readyState === "live"
        );
        const mic = (localStream.current.getAudioTracks() || []).some(
          (t) => t.enabled && t.readyState === "live"
        );
        socket.emit("participant_status", { roomId, cam, mic });
      }
    };

    socket.on("disconnect", handleSocketDisconnect);
    socket.on("connect", handleSocketConnect);

    return () => {
      isMounted = false;
      
      // 1. Remove socket listeners
      socket.off("user_joined", handleUserJoined);
      socket.off("webrtc_offer", handleOffer);
      socket.off("webrtc_answer", handleAnswer);
      socket.off("webrtc_ice_candidate", handleIceCandidate);
      socket.off("user_left", handleUserLeft);
      socket.off("participant_status", handleParticipantStatus);
      socket.off("room_participant_statuses", handleRoomParticipantStatuses);
      socket.off("screen_share_start", handleScreenShareStart);
      socket.off("screen_share_stop", handleScreenShareStop);
      socket.off("disconnect", handleSocketDisconnect);
      socket.off("connect", handleSocketConnect);

      // 2. Close all RTCPeerConnections
      Object.values(peerConnections.current).forEach(pc => {
        pc.onicecandidate = null;
        pc.onnegotiationneeded = null;
        pc.ontrack = null;
        pc.close();
      });
      peerConnections.current = {};
      pendingCandidates.current = {};
      mediaPromise.current = null;

      // 3. Stop local media tracks
      if (localStream.current) {
        localStream.current.getTracks().forEach(t => {
          t.stop();
          t.enabled = false;
        });
        localStream.current = null;
      }

      // 4. Stop screen share tracks
      if (screenStreamRef.current) {
        screenStreamRef.current.getTracks().forEach(t => {
          t.stop();
          t.enabled = false;
        });
        screenStreamRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, user, roomId]);

  const toggleVideo = async () => {
    toggleVideoPromiseRef.current = toggleVideoPromiseRef.current.then(async () => {
      if (!localStream.current) return;

      const currentVideoTrack = localStream.current.getVideoTracks().find((t) => t.readyState === "live");
      const mic = localStream.current.getAudioTracks().some((t) => t.enabled && t.readyState === "live");

      if (currentVideoTrack) {
        // --- CAMERA OFF ---
        // 1. Disassociate RTP senders from video track on all peer connections
        await Promise.all(
          Object.values(peerConnections.current).map(async (pc) => {
            const sender = findSenderByKind(pc, "video") ?? findVideoSender(pc);
            if (sender && typeof sender.replaceTrack === "function") {
              await sender.replaceTrack(null).catch((e) => console.warn("replaceTrack(null) error:", e));
            }
          })
        );

        // 2. Stop hardware track & remove from local stream
        currentVideoTrack.stop();
        localStream.current.removeTrack(currentVideoTrack);
        localStorage.setItem("wt_pref_camera", "false");

        // 3. Emit status & update state
        socket?.emit("participant_status", { roomId, cam: false, mic });
        setLocalStreamState(new MediaStream(localStream.current.getTracks()));
      } else {
        // --- CAMERA ON ---
        try {
          const newStream = await navigator.mediaDevices.getUserMedia({ video: true });
          const newVideoTrack = newStream.getVideoTracks()[0];
          if (!newVideoTrack) return;

          localStorage.setItem("wt_pref_camera", "true");
          localStream.current.addTrack(newVideoTrack);

          // Attach new track to all peer connections
          await Promise.all(
            Object.values(peerConnections.current).map(async (pc) => {
              const sender = findSenderByKind(pc, "video") ?? findVideoSender(pc);
              if (sender && typeof sender.replaceTrack === "function") {
                await sender.replaceTrack(newVideoTrack).catch((e) => console.warn("replaceTrack error:", e));
              } else {
                pc.addTrack(newVideoTrack, localStream.current!);
              }
            })
          );

          socket?.emit("participant_status", { roomId, cam: true, mic });
          setLocalStreamState(new MediaStream(localStream.current.getTracks()));
        } catch (err) {
          console.error("Failed to re-enable camera:", err);
          // Only update preference if user explicitly denied permission
          if (err instanceof Error && (err.name === "NotAllowedError" || err.name === "PermissionDeniedError")) {
            localStorage.setItem("wt_pref_camera", "false");
          }
          socket?.emit("participant_status", { roomId, cam: false, mic });
          setLocalStreamState(new MediaStream(localStream.current.getTracks()));
        }
      }
    }).catch((err) => {
      console.error("Error in toggleVideo queue:", err);
    });

    return toggleVideoPromiseRef.current;
  };

  const toggleAudio = async () => {
    if (!localStream.current) return;
    
    const audioTrack = localStream.current.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled;
      localStorage.setItem('wt_pref_mic', String(audioTrack.enabled));
      const cam = localStream.current.getVideoTracks()[0]?.enabled ?? false;
      socket?.emit("participant_status", { roomId, cam, mic: audioTrack.enabled });
    } else {
      try {
        const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const newAudioTrack = audioStream.getAudioTracks()[0];
        localStream.current.addTrack(newAudioTrack);
        localStorage.setItem('wt_pref_mic', 'true');
        
        Object.values(peerConnections.current).forEach((pc) => {
          const sender = findSenderByKind(pc, 'audio');
          if (sender) {
            sender.replaceTrack(newAudioTrack).catch((e) => console.warn("replaceTrack(audio) error:", e));
          } else {
            pc.addTrack(newAudioTrack, localStream.current!);
          }
        });
        
        const cam = localStream.current.getVideoTracks()[0]?.enabled ?? false;
        socket?.emit("participant_status", { roomId, cam, mic: true });
        setLocalStreamState(new MediaStream(localStream.current.getTracks()));
      } catch (e) {
        console.error("Failed to add audio track", e);
      }
    }
  };

  const broadcastMediaStream = (stream: MediaStream) => {
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach(t => t.stop());
    }

    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) return;

    screenStreamRef.current = stream;
    setScreenStreamState(stream);

    // Emit screen_share_start before adding track so peers register streamId ahead of SDP negotiation
    socket?.emit("screen_share_start", { roomId, streamId: stream.id });

    // Add all tracks (video and captured audio) to peer connections
    stream.getTracks().forEach((track) => {
      Object.values(peerConnections.current).forEach((pc) => {
        pc.addTrack(track, stream);
      });
    });

    const cleanupBroadcast = () => {
      stream.getTracks().forEach((track) => {
        Object.values(peerConnections.current).forEach((pc) => {
          const sender = pc.getSenders().find((s) => s.track === track);
          if (sender) {
            pc.removeTrack(sender);
          }
        });
      });
      screenStreamRef.current = null;
      setScreenStreamState(null);
      socket?.emit("screen_share_stop", { roomId });
    };

    videoTrack.onended = cleanupBroadcast;
  };

  const shareScreen = async () => {
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach(t => t.stop());
      return;
    }

    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      broadcastMediaStream(screenStream);
    } catch (err) {
      console.error("Error sharing screen:", err);
    }
  };

  return { getLocalStream, localStream, localStreamState, screenStreamState, peers, peerStatuses, screenShares, toggleAudio, toggleVideo, shareScreen, broadcastMediaStream };
}
