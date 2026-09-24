import { create } from 'zustand';
import { io, Socket } from 'socket.io-client';
import { useAuthStore } from './useAuthStore';
import { toast } from './useToastStore';

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
}

export interface Reaction {
  key: string;
  emoji: string;
  userName: string;
}

export type RoomAccessError = 'password_required' | 'incorrect_password' | null;

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
  currentRoomSession: RoomSession | null;
  connect: () => void;
  disconnect: () => void;
  joinRoom: (roomId: string, userId: string, userName: string, password?: string) => void;
  leaveRoom: (roomId: string, userId: string, userName: string) => void;
  sendMessage: (roomId: string, userId: string, userName: string, content: string) => void;
  sendReaction: (roomId: string, emoji: string) => void;
  addMessage: (message: Message) => void;
  clearMessages: () => void;
  setChatVisible: (visible: boolean) => void;
  clearEndedRoom: () => void;
}

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
      });

      socket.on('connect_error', (err) => {
        console.error("Socket Connect Error:", err);
        set({ connectionStatus: 'reconnecting', reconnectError: err.message || "Failed to connect to server" });
      });

      socket.on('receive_message', (message: Message) => {
        set((state) => ({
          messages: appendMessage(state.messages, message),
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
        set({ participants: Object.fromEntries(list.map((p) => [p.socketId, p])) });
      });

      socket.on('user_joined', ({ socketId, userId, userName }: Participant) => {
        set((state) => ({ participants: { ...state.participants, [socketId]: { socketId, userId, userName } } }));
      });

      socket.on('user_left', ({ socketId }: { socketId: string }) => {
        set((state) => {
          if (!state.participants[socketId]) return state;
          const next = { ...state.participants };
          delete next[socketId];
          return { participants: next };
        });
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
        if (errorMsg.includes("Incorrect password")) {
          set({ roomAccessError: 'incorrect_password' });
        } else if (errorMsg.includes("Password required")) {
          set({ roomAccessError: 'password_required' });
        } else if (
          errorMsg.includes("Unauthorized userId mismatch") ||
          errorMsg.includes("Room not found")
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
    set({ currentRoomSession: session, reconnectError: null, roomAccessError: null, endedRoomId: null });
    const { socket } = get();
    if (socket && socket.connected) {
      socket.emit('join_room', session);
    }
  },

  leaveRoom: (roomId, userId, userName) => {
    set({ currentRoomSession: null, reconnectError: null, roomAccessError: null, participants: {}, reactions: [] });
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

  addMessage: (message) => set((state) => ({ messages: appendMessage(state.messages, message) })),

  clearMessages: () => set({ messages: [], unreadCount: 0 }),

  setChatVisible: (visible) => set(visible ? { isChatVisible: true, unreadCount: 0 } : { isChatVisible: false }),

  clearEndedRoom: () => set({ endedRoomId: null }),
}));

if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__useSocketStore = useSocketStore;
}
