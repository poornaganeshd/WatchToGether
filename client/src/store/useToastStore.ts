import { create } from 'zustand';

export type ToastVariant = 'success' | 'error' | 'info';

export interface Toast {
  id: number;
  message: string;
  variant: ToastVariant;
  action?: { label: string; onClick: () => void };
}

interface ToastState {
  toasts: Toast[];
  push: (toast: Omit<Toast, 'id'>, durationMs?: number) => number;
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  push: (toast, durationMs = 4000) => {
    const id = nextId++;
    set({ toasts: [...get().toasts.slice(-4), { ...toast, id }] });
    if (durationMs > 0) {
      setTimeout(() => get().dismiss(id), durationMs);
    }
    return id;
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

export const toast = {
  success: (message: string) => useToastStore.getState().push({ message, variant: 'success' }),
  error: (message: string) => useToastStore.getState().push({ message, variant: 'error' }, 5000),
  info: (message: string, action?: Toast['action']) =>
    useToastStore.getState().push({ message, variant: 'info', action }, action ? 8000 : 4000),
};
