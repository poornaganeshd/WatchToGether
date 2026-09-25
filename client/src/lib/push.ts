import api from './api';

export const isPushSupported = () =>
  typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

const urlBase64ToUint8Array = (base64: string) => {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

const getRegistration = () => navigator.serviceWorker.register('/sw.js');

export type PushStatus = 'unsupported' | 'unavailable' | 'denied' | 'enabled' | 'disabled';

/** Whether push works here and whether this browser is subscribed. */
export const getPushStatus = async (): Promise<PushStatus> => {
  if (!isPushSupported()) return 'unsupported';
  const config = await api.get('/push/config').then((r) => r.data).catch(() => null);
  if (!config?.enabled) return 'unavailable';
  if (Notification.permission === 'denied') return 'denied';
  const registration = await navigator.serviceWorker.getRegistration('/sw.js');
  const subscription = await registration?.pushManager.getSubscription();
  return subscription ? 'enabled' : 'disabled';
};

export const enablePush = async () => {
  const config = (await api.get('/push/config')).data;
  if (!config.enabled || !config.publicKey) throw new Error("Push notifications aren't set up on this server");
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications are blocked for this site');
  const registration = await getRegistration();
  await navigator.serviceWorker.ready;
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(config.publicKey) }));
  await api.post('/push/subscribe', subscription.toJSON());
};

export const disablePush = async () => {
  if (!isPushSupported()) return;
  const registration = await navigator.serviceWorker.getRegistration('/sw.js');
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;
  await api.delete('/push/subscribe', { data: { endpoint: subscription.endpoint } }).catch(() => undefined);
  await subscription.unsubscribe();
};
