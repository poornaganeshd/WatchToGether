import { create } from 'zustand';
import { API_BASE } from '../lib/api';

// Free hosting (Render, Railway…) pauses the API when nobody uses it; the first visit then
// waits up to a minute while it starts. Track that so the app can explain the wait.
type Status = 'unknown' | 'ok' | 'waking' | 'unreachable';

interface ServerStatusState {
  status: Status;
  wakingSince: number | null;
  check: () => void;
}

const QUICK_TIMEOUT_MS = 4000;
const WAKE_TIMEOUT_MS = 15000;
const GIVE_UP_MS = 120000;

const ping = async (timeoutMs: number) => {
  try {
    const res = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
    return res.ok;
  } catch {
    return false;
  }
};

let checking = false;

export const useServerStatus = create<ServerStatusState>((set, get) => ({
  status: 'unknown',
  wakingSince: null,
  check: async () => {
    if (checking) return;
    checking = true;
    try {
      if (await ping(QUICK_TIMEOUT_MS)) {
        set({ status: 'ok', wakingSince: null });
        return;
      }
      const since = get().wakingSince ?? Date.now();
      set({ status: 'waking', wakingSince: since });
      while (Date.now() - since < GIVE_UP_MS) {
        if (await ping(WAKE_TIMEOUT_MS)) {
          set({ status: 'ok', wakingSince: null });
          return;
        }
        await new Promise((r) => setTimeout(r, 3000));
      }
      set({ status: 'unreachable' });
    } finally {
      checking = false;
    }
  },
}));
