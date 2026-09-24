import { create } from 'zustand';

// Known avatar versions by user id (null = no avatar). Filled from any payload that carries
// them, so every <Avatar> for that user shows the picture without extra requests.
interface AvatarState {
  versions: Record<string, number | null>;
  setVersions: (entries: Record<string, number | null | undefined>) => void;
}

export const useAvatarStore = create<AvatarState>((set, get) => ({
  versions: {},
  setVersions: (entries) => {
    const current = get().versions;
    let changed = false;
    const next = { ...current };
    for (const [userId, version] of Object.entries(entries)) {
      if (version === undefined || current[userId] === version) continue;
      next[userId] = version;
      changed = true;
    }
    if (changed) set({ versions: next });
  },
}));

export const rememberAvatars = (entries: Record<string, number | null | undefined>) =>
  useAvatarStore.getState().setVersions(entries);
