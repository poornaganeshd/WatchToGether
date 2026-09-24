import api from './api';

const PUBLIC_STUN: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

// An explicit VITE_ICE_SERVERS (JSON array) wins over what the API hands out.
const fromEnv = (): RTCIceServer[] | null => {
  const raw = import.meta.env.VITE_ICE_SERVERS;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
  } catch {
    console.warn('VITE_ICE_SERVERS is not valid JSON; ignoring it');
    return null;
  }
};

let current: RTCIceServer[] = fromEnv() ?? PUBLIC_STUN;
let expiresAt = 0;
let inflight: Promise<RTCIceServer[]> | null = null;

/** ICE servers to use for new peer connections right now. */
export const getIceServers = () => current;

/**
 * Fetches TURN credentials from the API (short-lived when the server uses TURN_SECRET).
 * Safe to call repeatedly; failures keep the STUN fallback so calls still work on open networks.
 */
export const loadIceServers = async (): Promise<RTCIceServer[]> => {
  if (fromEnv()) return current;
  if (Date.now() < expiresAt) return current;
  if (inflight) return inflight;
  inflight = api
    .get('/rtc/ice-servers')
    .then((res) => {
      const servers = res.data?.iceServers as RTCIceServer[] | undefined;
      if (Array.isArray(servers) && servers.length > 0) current = servers;
      // Refresh an hour before the credentials expire (or every 6h without TURN).
      const ttl = (res.data?.ttl as number | undefined) ?? 6 * 60 * 60;
      expiresAt = Date.now() + Math.max(60, ttl - 3600) * 1000;
      return current;
    })
    .catch((err) => {
      console.warn('Could not load ICE servers, using public STUN:', err);
      expiresAt = Date.now() + 60_000;
      return current;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
};
