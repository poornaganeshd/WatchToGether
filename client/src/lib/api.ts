import axios, { AxiosError } from 'axios';
import { useAuthStore } from '../store/useAuthStore';

export const API_BASE = import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/api` : 'http://localhost:5000/api';

const api = axios.create({
  baseURL: API_BASE,
});

api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().token;
  if (token && config.headers) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// An expired or revoked token otherwise leaves the app half-logged-in with every call failing.
api.interceptors.response.use(
  (response) => response,
  (error: AxiosError) => {
    const isAuthRoute = error.config?.url?.startsWith('/auth/login') || error.config?.url?.startsWith('/auth/register');
    if (error.response?.status === 401 && !isAuthRoute && useAuthStore.getState().token) {
      useAuthStore.getState().logout();
    }
    return Promise.reject(error);
  }
);

export const getErrorMessage = (error: unknown, fallback: string) => {
  const axiosErr = error as AxiosError<{ error?: string }>;
  if (axiosErr?.isAxiosError && !axiosErr.response) {
    return "Unable to reach the server. Check your connection and try again.";
  }
  return axiosErr?.response?.data?.error || fallback;
};

export default api;
