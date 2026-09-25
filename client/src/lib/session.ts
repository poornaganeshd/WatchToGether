import { disablePush } from './push';
import { useAuthStore } from '../store/useAuthStore';

/** Signs out, first detaching this browser from the account's push notifications. */
export const signOut = async () => {
  try {
    await disablePush();
  } catch {
    /* best effort */
  }
  useAuthStore.getState().logout();
};
