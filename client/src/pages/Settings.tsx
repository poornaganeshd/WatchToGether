import { useRef, useState } from "react";
import { ArrowLeft, Camera, KeyRound, Trash2, UserRound } from "lucide-react";
import api, { getErrorMessage } from "../lib/api";
import { resizeAvatar } from "../lib/image";
import { useAuthStore } from "../store/useAuthStore";
import { rememberAvatars } from "../store/useAvatarStore";
import { useSocketStore } from "../store/useSocketStore";
import { toast } from "../store/useToastStore";
import Logo from "../components/ui/Logo";
import Avatar from "../components/ui/Avatar";
import Spinner from "../components/ui/Spinner";
import PasswordInput from "../components/PasswordInput";
import { Link } from "react-router-dom";
import { useEffect } from "react";
import { Bell } from "lucide-react";
import { disablePush, enablePush, getPushStatus, type PushStatus } from "../lib/push";

export default function Settings() {
  const { user, setUser, setToken } = useAuthStore();
  const [name, setName] = useState(user?.name ?? "");
  const [savingName, setSavingName] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  if (!user) return null;

  const applyUser = (next: typeof user) => {
    setUser(next);
    rememberAvatars({ [next.id]: next.avatarVersion ?? null });
  };

  const saveName = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || name.trim() === user.name) return;
    setSavingName(true);
    try {
      const res = await api.patch("/auth/me", { name: name.trim() });
      applyUser(res.data.user);
      toast.success("Name updated");
    } catch (err) {
      toast.error(getErrorMessage(err, "Couldn't update your name"));
    } finally {
      setSavingName(false);
    }
  };

  const uploadAvatar = async (file: File) => {
    setAvatarBusy(true);
    try {
      const dataUrl = await resizeAvatar(file);
      const res = await api.put("/auth/me/avatar", { dataUrl });
      applyUser(res.data.user);
      toast.success("Profile picture updated");
    } catch (err) {
      toast.error(err instanceof Error && !("isAxiosError" in err) ? err.message : getErrorMessage(err, "Couldn't upload that picture"));
    } finally {
      setAvatarBusy(false);
    }
  };

  const removeAvatar = async () => {
    setAvatarBusy(true);
    try {
      const res = await api.delete("/auth/me/avatar");
      applyUser(res.data.user);
    } catch (err) {
      toast.error(getErrorMessage(err, "Couldn't remove your picture"));
    } finally {
      setAvatarBusy(false);
    }
  };

  const changePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword.length < 6) return toast.error("New password must be at least 6 characters");
    if (newPassword !== confirmPassword) return toast.error("New passwords don't match");
    setSavingPassword(true);
    try {
      // Tell the server which live connection is ours so it isn't dropped with the others.
      const socketId = useSocketStore.getState().socket?.id;
      const res = await api.post(
        "/auth/me/password",
        { currentPassword, newPassword },
        socketId ? { headers: { "X-Socket-Id": socketId } } : undefined
      );
      setToken(res.data.token);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      toast.success("Password changed. Other devices have been signed out.");
    } catch (err) {
      toast.error(getErrorMessage(err, "Couldn't change your password"));
    } finally {
      setSavingPassword(false);
    }
  };

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b border-white/5 bg-ink-950/70 backdrop-blur-xl">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3 sm:px-6">
          <Logo to="/dashboard" size="sm" />
          <Link to="/dashboard" className="btn-ghost px-3">
            <ArrowLeft size={16} /> Dashboard
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-6 px-4 py-8 sm:px-6">
        <h1 className="font-display text-3xl font-bold">Settings</h1>

        <section className="card p-6">
          <h2 className="mb-5 flex items-center gap-2 font-display font-semibold"><UserRound size={18} className="text-indigo-300" /> Profile</h2>
          <div className="flex flex-col gap-6 sm:flex-row sm:items-start">
            <div className="flex flex-col items-center gap-3">
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="group relative rounded-full"
                aria-label="Change profile picture"
                disabled={avatarBusy}
              >
                <Avatar name={user.name} seed={user.id} version={user.avatarVersion ?? null} size={96} />
                <span className="absolute inset-0 grid place-items-center rounded-full bg-black/50 text-white opacity-0 transition-opacity group-hover:opacity-100">
                  {avatarBusy ? <Spinner /> : <Camera size={22} />}
                </span>
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                className="sr-only"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) uploadAvatar(file);
                }}
              />
              {user.avatarVersion ? (
                <button type="button" onClick={removeAvatar} disabled={avatarBusy} className="btn-ghost px-2 py-1 text-xs hover:text-red-300">
                  <Trash2 size={12} /> Remove
                </button>
              ) : (
                <span className="text-xs text-slate-500">Click to upload</span>
              )}
            </div>

            <form onSubmit={saveName} className="flex-1 space-y-4">
              <div>
                <label className="label" htmlFor="display-name">Display name</label>
                <input id="display-name" className="input" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
                <p className="mt-1.5 text-xs text-slate-500">Shown to friends and in rooms. Takes effect next time you join a room.</p>
              </div>
              <div>
                <span className="label">Email</span>
                <p className="text-sm text-slate-300">{user.email}</p>
              </div>
              <button type="submit" disabled={savingName || !name.trim() || name.trim() === user.name} className="btn-primary">
                {savingName && <Spinner className="h-4 w-4" />} Save profile
              </button>
            </form>
          </div>
        </section>

        <NotificationSettings />

        <section className="card p-6">
          <h2 className="mb-5 flex items-center gap-2 font-display font-semibold"><KeyRound size={18} className="text-indigo-300" /> Password</h2>
          <form onSubmit={changePassword} className="grid gap-4 sm:max-w-sm">
            <div>
              <label className="label" htmlFor="current-password">Current password</label>
              <PasswordInput id="current-password" autoComplete="current-password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} />
            </div>
            <div>
              <label className="label" htmlFor="new-password">New password</label>
              <PasswordInput id="new-password" autoComplete="new-password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
            </div>
            <div>
              <label className="label" htmlFor="confirm-password">Confirm new password</label>
              <PasswordInput id="confirm-password" autoComplete="new-password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
            </div>
            <p className="text-xs text-slate-500">Changing your password signs you out everywhere else.</p>
            <button type="submit" disabled={savingPassword || !currentPassword || !newPassword} className="btn-primary w-fit">
              {savingPassword && <Spinner className="h-4 w-4" />} Change password
            </button>
          </form>
        </section>
      </main>
    </div>
  );
}

function NotificationSettings() {
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getPushStatus().then(setStatus).catch(() => setStatus("unavailable"));
  }, []);

  const toggle = async () => {
    setBusy(true);
    try {
      if (status === "enabled") {
        await disablePush();
        toast.success("Notifications turned off for this browser");
      } else {
        await enablePush();
        toast.success("You'll get notifications even when WatchTogether is closed");
      }
      setStatus(await getPushStatus());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't change notification settings");
    } finally {
      setBusy(false);
    }
  };

  const note: Record<PushStatus, string> = {
    unsupported: "This browser doesn't support push notifications.",
    unavailable: "Push notifications aren't set up on this server.",
    denied: "Notifications are blocked for this site. Allow them in your browser's site settings, then come back.",
    enabled: "On for this browser. Invites, friend requests and party reminders arrive even when the site is closed.",
    disabled: "Get invites, friend requests and party reminders even when the site is closed.",
  };

  return (
    <section className="card p-6">
      <h2 className="mb-3 flex items-center gap-2 font-display font-semibold"><Bell size={18} className="text-indigo-300" /> Notifications</h2>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-slate-400">{status ? note[status] : "Checking…"}</p>
        {(status === "enabled" || status === "disabled") && (
          <button onClick={toggle} disabled={busy} className={`${status === "enabled" ? "btn-secondary" : "btn-primary"} shrink-0`}>
            {busy && <Spinner className="h-4 w-4" />} {status === "enabled" ? "Turn off" : "Turn on"}
          </button>
        )}
      </div>
    </section>
  );
}
