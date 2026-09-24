import { create } from 'zustand';

export type DuckingSpeed = 'slow' | 'normal' | 'fast';
export type AudioMode = 'cinema' | 'balanced' | 'conversation' | 'custom';

interface AudioSettings {
  duckingLevel: number; // 0 to 1
  duckingSpeed: DuckingSpeed;
  recoverySpeed: DuckingSpeed;
  isEnabled: boolean;
  audioMode: AudioMode;
  customMovieVolume: number; // 0 to 1
  customVoiceVolume: number; // 0 to 1
  /** Plays the video this many ms earlier to compensate for audio output latency (e.g. Bluetooth). */
  syncOffsetMs: number;
}

interface AudioState {
  settings: AudioSettings;
  activeSpeakers: string[]; // array of socketIds
  hostAnnouncementActive: boolean;
  hostSocketId: string | null;
  /** Per-person voice volume (0–1) by user id; missing means 100%. */
  peerVolumes: Record<string, number>;
  setPeerVolume: (userId: string, volume: number) => void;
  updateSettings: (newSettings: Partial<AudioSettings>) => void;
  addActiveSpeaker: (socketId: string) => void;
  removeActiveSpeaker: (socketId: string) => void;
  setHostAnnouncement: (active: boolean) => void;
  setHostSocketId: (socketId: string | null) => void;
}

const defaultSettings: AudioSettings = {
  duckingLevel: 0.5,
  duckingSpeed: 'normal',
  recoverySpeed: 'normal',
  isEnabled: true,
  audioMode: 'balanced',
  customMovieVolume: 1,
  customVoiceVolume: 1,
  syncOffsetMs: 0,
};

const getSavedSettings = (): AudioSettings => {
  const saved = localStorage.getItem('audioSettings');
  if (saved) {
    try {
      return { ...defaultSettings, ...JSON.parse(saved) };
    } catch {
      return defaultSettings;
    }
  }
  return defaultSettings;
};

export const useAudioStore = create<AudioState>((set) => ({
  settings: getSavedSettings(),
  activeSpeakers: [],
  hostAnnouncementActive: false,
  hostSocketId: null,
  peerVolumes: (() => {
    try {
      return JSON.parse(localStorage.getItem('peerVolumes') || '{}');
    } catch {
      return {};
    }
  })(),

  setPeerVolume: (userId, volume) => set((state) => {
    const clamped = Math.min(1, Math.max(0, volume));
    const peerVolumes = { ...state.peerVolumes };
    if (clamped === 1) delete peerVolumes[userId];
    else peerVolumes[userId] = clamped;
    localStorage.setItem('peerVolumes', JSON.stringify(peerVolumes));
    return { peerVolumes };
  }),

  updateSettings: (newSettings) => set((state) => {
    const updated = { ...state.settings, ...newSettings };
    localStorage.setItem('audioSettings', JSON.stringify(updated));
    return { settings: updated };
  }),

  addActiveSpeaker: (socketId) => set((state) => {
    if (!state.activeSpeakers.includes(socketId)) {
      return { activeSpeakers: [...state.activeSpeakers, socketId] };
    }
    return state;
  }),

  removeActiveSpeaker: (socketId) => set((state) => ({
    activeSpeakers: state.activeSpeakers.filter((id) => id !== socketId),
  })),

  setHostAnnouncement: (active) => set({ hostAnnouncementActive: active }),
  setHostSocketId: (socketId) => set({ hostSocketId: socketId }),
}));
