import { useEffect, type ReactNode } from "react";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import Home from "./pages/Home";
import Login from "./pages/Login";
import Signup from "./pages/Signup";
import Dashboard from "./pages/Dashboard";
import Room from "./pages/Room";
import NotFound from "./pages/NotFound";
import ForgotPassword from "./pages/ForgotPassword";
import ResetPassword from "./pages/ResetPassword";
import Settings from "./pages/Settings";
import InviteAccept from "./pages/InviteAccept";
import Replay from "./pages/Replay";
import { rememberAvatars } from "./store/useAvatarStore";
import Toaster from "./components/ui/Toaster";
import AppBanners from "./components/AppBanners";
import { useAuthStore } from "./store/useAuthStore";
import { useSocketStore } from "./store/useSocketStore";
import api from "./lib/api";

function RequireAuth({ children }: { children: ReactNode }) {
  const user = useAuthStore((s) => s.user);
  const location = useLocation();
  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <>{children}</>;
}

function GuestOnly({ children }: { children: ReactNode }) {
  const user = useAuthStore((s) => s.user);
  const location = useLocation();
  if (user) {
    const from = (location.state as { from?: string } | null)?.from;
    return <Navigate to={from || "/dashboard"} replace />;
  }
  return <>{children}</>;
}

function SessionSync() {
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);

  useEffect(() => {
    if (user) rememberAvatars({ [user.id]: user.avatarVersion ?? null });
  }, [user]);

  // Validate the stored token once and pick up profile changes.
  useEffect(() => {
    if (!token) return;
    api
      .get("/auth/me")
      .then((res) => useAuthStore.getState().setUser(res.data.user))
      .catch(() => {
        /* 401s are handled by the api interceptor */
      });
  }, [token]);

  // Stay connected on every signed-in page so friends see accurate presence;
  // drop the realtime connection when the user signs out.
  useEffect(() => {
    if (token) {
      useSocketStore.getState().connect();
    } else {
      useSocketStore.getState().disconnect();
    }
  }, [token]);

  return null;
}

function App() {
  return (
    <BrowserRouter>
      <SessionSync />
      <div className="min-h-screen bg-ink-950 font-sans text-slate-50">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/login" element={<GuestOnly><Login /></GuestOnly>} />
          <Route path="/signup" element={<GuestOnly><Signup /></GuestOnly>} />
          <Route path="/forgot-password" element={<GuestOnly><ForgotPassword /></GuestOnly>} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/settings" element={<RequireAuth><Settings /></RequireAuth>} />
          <Route path="/dashboard" element={<RequireAuth><Dashboard /></RequireAuth>} />
          <Route path="/room/:id" element={<RequireAuth><Room /></RequireAuth>} />
          <Route path="/room/:id/replay" element={<RequireAuth><Replay /></RequireAuth>} />
          <Route path="/invite/:token" element={<RequireAuth><InviteAccept /></RequireAuth>} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </div>
      <AppBanners />
      <Toaster />
    </BrowserRouter>
  );
}

export default App;
