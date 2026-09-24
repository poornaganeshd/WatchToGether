import { create } from 'zustand';
import { io, Socket } from 'socket.io-client';
import { useAuthStore } from './useAuthStore';
import { toast } from './useToastStore';
import { rememberAvatars } from './useAvatarStore';

export interface Message {
  id: string;
  userId: string;
  userName: string;
  content: string;
  createdAt: string;
}

export interface RoomSession {
  roomId: string;
  userId: string;
  userName: string;
  password?: string;
}

export interface Participant {
  socketId: string;
  userId: string;
  userName: string;
  avatarVersion?: number | null;
}

export interface Subtitles {
  label: string;
  vtt: string;
}

export interface SkipVotes {
  count: number;
  needed: number;
  voters: string[];
}

export type SyncState = 'synced' | 'drifting' | 'buffering' | 'error';

export interface PollView {
  id: string;
  question: string;
  options: string[];
  counts: number[];
  totalVotes: number;
  createdByName: string;
  queueWinner: boolean;
  closesAt: number | null;
  closed: boolean;
  winner: number | null;
}

export interface ChatSettings {
  slowModeSeconds: number;
  muted: { userId: string; until: number | null }[];
}

export interface RecentlyPlayed {
  url: string;
  playedAt: number;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** True when a message @-mentions the given name (full name or first name). */
export const mentionsUser = (content: string, name: string) => {
  const first = name.trim().split(/\s+/)[0];
  const candidates = Array.from(new Set([name.trim(), first].filter(Boolean)));
  return candidates.some((n) => new RegExp(`(^|[^\\w@])@${escapeRegExp(n)}(?![\\w])`, 'i').test(content));
};

// Short two-tone chime for mentions, generated so no audio asset is needed.
const playMentionChime = () => {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    [880, 1320].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.12);
      gain.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + i * 0.12 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.12 + 0.25);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + i * 0.12);
      osc.stop(ctx.currentTime + i * 0.12 + 0.3);
    });
    setTimeout(() => ctx.close(), 800);
  } catch {
    /* audio unavailable */
  }
};

export interface Reaction {
  key: string;
  emoji: string;
  userName: string;
}

export interface QueueItem {
  id: string;
  url: string;
  addedBy: string;
  addedByName: string;
}

export interface RoomInfoUpdate {
  name: string;
  isPrivate: boolean;
  maxParticipants: number;
}

export type RoomAccessError = 'password_required' | 'incorrect_password' | 'throttled' | null;

const MAX_MESSAGES = 300;

interface SocketState {
  socket: Socket | null;
  messages: Message[];
  participants: Record<string, Participant>;
  reactions: Reaction[];
  unreadCount: number;
  isChatVisible: boolean;
  connectionStatus: 'connected' | 'disconnected' | 'reconnecting';
  reconnectError: string | null;
  roomAccessError: RoomAccessError;
  endedRoomId: string | null;
  exitReason: 'kicked' | 'full' | null;
  queue: QueueItem[];
  typingUsers: Record<string, string>; // socketId -> name
  roomInfo: RoomInfoUpdate | null;
  subtitles: Subtitles | null;
  skipVotes: SkipVotes;
  viewerSync: Record<string, { state: SyncState; drift: number }>;
  recentlyPlayed: RecentlyPlayed[];
  /** Local clock time the countdown ends, or null. */
  countdownEndsAt: number | null;
  unreadMentions: number;
  poll: PollView | null;
  myPollVote: number | null;
  chatSettings: ChatSettings;
  currentRoomSession: RoomSession | null;
  connect: () => void;
  disconnect: () => void;
  joinRoom: (roomId: string, userId: string, userName: string, password?: string) => void;
  leaveRoom: (roomId: string, userId: string, userName: string) => void;
  sendMessage: (roomId: string, userId: string, userName: string, content: string) => void;
  sendReaction: (roomId: string, emoji: string) => void;
  setTyping: (roomId: string, isTyping: boolean) => void;
  addMessage: (message: Message) => void;
  clearMessages: () => void;
  setChatVisible: (visible: boolean) => void;
  clearEndedRoom: () => void;
  clearExitReason: () => void;
}

const typingTimers: Record<string, ReturnType<typeof setTimeout>> = {};

const dropTyping = (typing: Record<string, string>, socketId: string) => {
  if (!(socketId in typing)) return typing;
  const next = { ...typing };
  delete next[socketId];
  return next;
};

const appendMessage = (messages: Message[], message: Message) => {
  if (messages.some((m) => m.id === message.id)) return messages;
  const next = [...messages, message];
  return next.length > MAX_MESSAGES ? next.slice(next.length - MAX_MESSAGES) : next;
};

export const useSocketStore = create<SocketState>((set, get) => ({
  socket: null,
  messages: [],
  participants: {},
  reactions: [],
  unreadCount: 0,
  isChatVisible: false,
  connectionStatus: 'disconnected',
  reconnectError: null,
  roomAccessError: null,
  endedRoomId: null,
  exitReason: null,
  queue: [],
  typingUsers: {},
  roomInfo: null,
  subtitles: null,
  skipVotes: { count: 0, needed: 1, voters: [] },
  viewerSync: {},
  recentlyPlayed: [],
  countdownEndsAt: null,
  unreadMentions: 0,
  poll: null,
  myPollVote: null,
  chatSettings: { slowModeSeconds: 0, muted: [] },
  currentRoomSession: null,

  connect: () => {
    if (!get().socket) {
      const url = import.meta.env.VITE_API_URL || 'http://localhost:5000';

      const socket = io(url, {
        auth: (cb) => {
          cb({ token: useAuthStore.getState().token });
        },
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        timeout: 20000,
      });

      socket.on('connect', () => {
        set({ connectionStatus: 'connected', reconnectError: null });
        const { currentRoomSession } = get();
        // If we were inside an active room session, automatically rejoin
        if (currentRoomSession) {
          socket.emit('join_room', currentRoomSession);
        }
      });

      socket.on('disconnect', (reason) => {
        console.warn("Socket disconnected:", reason);
        set({ connectionStatus: 'reconnecting', participants: {} });
        // The server drops every session after a password change. Socket.IO won't retry a
        // server-initiated disconnect, so reconnect ourselves: this device holds the new
        // token, other devices fail authentication below and are signed out.
        if (reason === 'io server disconnect' && useAuthStore.getState().token) {
          socket.connect();
        }
      });

      socket.on('connect_error', (err) => {
        console.error("Socket Connect Error:", err);
        if (err.message?.startsWith('Authentication error') && useAuthStore.getState().token) {
          // Token expired or revoked (e.g. password changed elsewhere): stop retrying and sign out.
          socket.disconnect();
          set({ socket: null, connectionStatus: 'disconnected', currentRoomSession: null });
          useAuthStore.getState().logout();
          toast.info("Your session ended. Please sign in again.");
          return;
        }
        set({ connectionStatus: 'reconnecting', reconnectError: err.message || "Failed to connect to server" });
      });

      socket.on('receive_message', (message: Message) => {
        const me = useAuthStore.getState().user;
        const isMention = !!me && message.userId !== me.id && mentionsUser(message.content, me.name);
        if (isMention) {
          playMentionChime();
          if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
            new Notification(`${message.userName} mentioned you`, { body: message.content.slice(0, 140), icon: '/favicon.svg' });
          }
        }
        set((state) => ({
          unreadMentions: isMention && !state.isChatVisible ? state.unreadMentions + 1 : state.unreadMentions,
          messages: appendMessage(state.messages, message),
          typingUsers: Object.fromEntries(
            Object.entries(state.typingUsers).filter(([, name]) => name !== message.userName)
          ),
          unreadCount:
            state.isChatVisible || message.userId === useAuthStore.getState().user?.id
              ? state.unreadCount
              : state.unreadCount + 1,
        }));
      });

      // The server replays recent messages on every (re)join, so replace rather than append.
      socket.on('chat_history', (history: Message[]) => {
        set({ messages: history.slice(-MAX_MESSAGES) });
      });

      socket.on('chat_rate_limited', ({ message }: { message: string }) => {
        toast.error(message);
      });

      socket.on('room_participants', (list: Participant[]) => {
        rememberAvatars(Object.fromEntries(list.map((p) => [p.userId, p.avatarVersion])));
        set({ participants: Object.fromEntries(list.map((p) => [p.socketId, p])) });
      });

      socket.on('user_joined', ({ socketId, userId, userName, avatarVersion }: Participant) => {
        rememberAvatars({ [userId]: avatarVersion });
        set((state) => ({ participants: { ...state.participants, [socketId]: { socketId, userId, userName, avatarVersion } } }));
      });

      socket.on('poll_updated', (poll: PollView | null) => {
        set({ poll });
      });

      socket.on('poll_my_vote', (myPollVote: number | null) => {
        set({ myPollVote });
      });

      socket.on('chat_settings', (chatSettings: ChatSettings) => {
        set({ chatSettings });
      });

      socket.on('message_deleted', ({ id }: { id: string }) => {
        set((state) => ({ messages: state.messages.filter((m) => m.id !== id) }));
      });

      socket.on('recently_played', (recentlyPlayed: RecentlyPlayed[]) => {
        set({ recentlyPlayed });
      });

      socket.on('countdown', (data: { endsAt: number; serverTime: number } | null) => {
        // Convert the server's clock to ours so the overlay ends on time despite clock skew.
        set({ countdownEndsAt: data ? Date.now() + (data.endsAt - data.serverTime) : null });
      });

      socket.on('subtitles_updated', (subtitles: Subtitles | null) => {
        set({ subtitles });
      });

      socket.on('skip_votes', (skipVotes: SkipVotes) => {
        set({ skipVotes });
      });

      socket.on('skip_passed', () => {
        toast.info("The room voted to skip — playing the next video.");
      });

      socket.on('viewer_sync', ({ socketId, state, drift }: { socketId: string; state: SyncState; drift: number }) => {
        set((s) => ({ viewerSync: { ...s.viewerSync, [socketId]: { state, drift } } }));
      });

      socket.on('viewer_sync_all', (reports: Record<string, { state: SyncState; drift: number }>) => {
        set({ viewerSync: reports });
      });

      socket.on('user_left', ({ socketId }: { socketId: string }) => {
        set((state) => {
          const typingUsers = dropTyping(state.typingUsers, socketId);
          const viewerSync = { ...state.viewerSync };
          delete viewerSync[socketId];
          if (!state.participants[socketId]) return { typingUsers, viewerSync };
          const next = { ...state.participants };
          delete next[socketId];
          return { participants: next, typingUsers, viewerSync };
        });
      });

      socket.on('user_typing', ({ socketId, userName, isTyping }: { socketId: string; userName: string; isTyping: boolean }) => {
        clearTimeout(typingTimers[socketId]);
        if (isTyping) {
          set((state) => ({ typingUsers: { ...state.typingUsers, [socketId]: userName } }));
          // Clear stale indicators if the "stopped" event never arrives.
          typingTimers[socketId] = setTimeout(() => {
            set((state) => ({ typingUsers: dropTyping(state.typingUsers, socketId) }));
          }, 6000);
        } else {
          set((state) => ({ typingUsers: dropTyping(state.typingUsers, socketId) }));
        }
      });

      socket.on('queue_updated', (queue: QueueItem[]) => {
        set({ queue });
      });

      socket.on('room_updated', (info: RoomInfoUpdate) => {
        set({ roomInfo: info });
      });

      socket.on('kicked', ({ roomId }: { roomId: string }) => {
        if (get().currentRoomSession?.roomId === roomId) {
          set({ exitReason: 'kicked', currentRoomSession: null });
        }
      });

      socket.on('participant_kicked', ({ userName }: { userName: string }) => {
        toast.info(`${userName} was removed from the room`);
      });

      socket.on('reaction', ({ emoji, userName, socketId }: { emoji: string; userName: string; socketId: string }) => {
        const key = `${socketId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        set((state) => ({ reactions: [...state.reactions.slice(-20), { key, emoji, userName }] }));
        setTimeout(() => {
          set((state) => ({ reactions: state.reactions.filter((r) => r.key !== key) }));
        }, 3200);
      });

      socket.on('room_ended', ({ roomId }: { roomId: string }) => {
        if (get().currentRoomSession?.roomId === roomId) {
          set({ endedRoomId: roomId, currentRoomSession: null });
        }
      });

      socket.on('error', (err: unknown) => {
        console.error("Socket Error:", err);
        const errorMsg = typeof err === 'object' && err !== null && 'message' in err
          ? String((err as { message?: string }).message)
          : String(err);
        if (errorMsg.includes("removed from this room")) {
          set({ exitReason: 'kicked', currentRoomSession: null });
        } else if (errorMsg.includes("Room is full")) {
          set({ exitReason: 'full', currentRoomSession: null });
        } else if (
          errorMsg.includes("Only the host") ||
          errorMsg.includes("queue is full") ||
          errorMsg.includes("too quickly") ||
          errorMsg.includes("Nothing is queued") ||
          errorMsg.includes("Subtitle file") ||
          errorMsg.includes("countdown") ||
          errorMsg.includes("poll") ||
          errorMsg.includes("mute a co-host")
        ) {
          toast.error(errorMsg);
        } else if (errorMsg.includes("Too many password attempts")) {
          set({ roomAccessError: 'throttled' });
        } else if (errorMsg.includes("Incorrect password")) {
          set({ roomAccessError: 'incorrect_password' });
        } else if (errorMsg.includes("Password required")) {
          set({ roomAccessError: 'password_required' });
        } else if (
          errorMsg.includes("Unauthorized userId mismatch") ||
          errorMsg.includes("Room not found") ||
          errorMsg.includes("live on another server")
        ) {
          set({ reconnectError: errorMsg });
        }
      });

      set({ socket, connectionStatus: socket.connected ? 'connected' : 'reconnecting' });
    }
  },

  disconnect: () => {
    const { socket } = get();
    if (socket) {
      socket.disconnect();
      set({
        socket: null,
        currentRoomSession: null,
        connectionStatus: 'disconnected',
        reconnectError: null,
        participants: {},
      });
    }
  },

  joinRoom: (roomId, userId, userName, password) => {
    const session: RoomSession = { roomId, userId, userName, password };
    set({ currentRoomSession: session, reconnectError: null, roomAccessError: null, endedRoomId: null, exitReason: null });
    const { socket } = get();
    if (socket && socket.connected) {
      socket.emit('join_room', session);
    }
  },

  leaveRoom: (roomId, userId, userName) => {
    set({ currentRoomSession: null, reconnectError: null, roomAccessError: null, participants: {}, reactions: [], queue: [], typingUsers: {}, roomInfo: null, subtitles: null, skipVotes: { count: 0, needed: 1, voters: [] }, viewerSync: {}, recentlyPlayed: [], countdownEndsAt: null, unreadMentions: 0, poll: null, myPollVote: null, chatSettings: { slowModeSeconds: 0, muted: [] } });
    const { socket } = get();
    if (socket) {
      socket.emit('leave_room', { roomId, userId, userName });
    }
  },

  sendMessage: (roomId, userId, userName, content) => {
    const { socket } = get();
    if (socket) {
      socket.emit('send_message', { roomId, userId, userName, content });
    }
  },

  sendReaction: (roomId, emoji) => {
    get().socket?.emit('send_reaction', { roomId, emoji });
  },

  setTyping: (roomId, isTyping) => {
    get().socket?.emit('typing', { roomId, isTyping });
  },

  addMessage: (message) => set((state) => ({ messages: appendMessage(state.messages, message) })),

  clearMessages: () => set({ messages: [], unreadCount: 0, unreadMentions: 0 }),

  setChatVisible: (visible) => set(visible ? { isChatVisible: true, unreadCount: 0, unreadMentions: 0 } : { isChatVisible: false }),

  clearEndedRoom: () => set({ endedRoomId: null }),

  clearExitReason: () => set({ exitReason: null }),
}));

if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__useSocketStore = useSocketStore;
}
