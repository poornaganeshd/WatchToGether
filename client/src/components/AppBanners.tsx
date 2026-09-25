import { useEffect, useState } from "react";
import { CloudOff, RefreshCw, Sparkles, X } from "lucide-react";
import { useServerStatus } from "../store/useServerStatus";
import Spinner from "./ui/Spinner";

const VERSION_CHECK_MS = 10 * 60 * 1000;

/** Notices a newer deploy of the web app (version.json differs from this build) and offers a reload. */
function UpdateBanner() {
  const [newVersion, setNewVersion] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (import.meta.env.DEV || __APP_COMMIT__ === "unknown") return;
    let stopped = false;
    const check = async () => {
      try {
        const res = await fetch(`/version.json?t=${Date.now()}`, { cache: "no-store" });
        if (!res.ok) return;
        const { commit } = (await res.json()) as { commit?: string };
        if (!stopped && commit && commit !== "unknown" && commit !== __APP_COMMIT__) setNewVersion(commit);
      } catch {
        /* offline; try again later */
      }
    };
    check();
    const interval = setInterval(check, VERSION_CHECK_MS);
    const onVisible = () => document.visibilityState === "visible" && check();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  if (!newVersion || dismissed) return null;
  return (
    <div role="status" className="flex items-center gap-3 border-b border-indigo-400/20 bg-indigo-600/95 px-4 py-2 text-sm text-white backdrop-blur">
      <Sparkles size={16} className="shrink-0" />
      <span className="min-w-0 flex-1">A new version of WatchTogether is ready.</span>
      <button onClick={() => window.location.reload()} className="flex items-center gap-1.5 rounded-lg bg-white px-3 py-1 text-xs font-semibold text-indigo-700">
        <RefreshCw size={13} /> Reload
      </button>
      <button onClick={() => setDismissed(true)} className="rounded-lg p-1 text-white/80 hover:bg-white/10" aria-label="Later">
        <X size={16} />
      </button>
    </div>
  );
}

/** Explains the wait while a sleeping server (free hosting) starts up. */
function ServerWakeBanner() {
  const status = useServerStatus((s) => s.status);
  const wakingSince = useServerStatus((s) => s.wakingSince);
  const check = useServerStatus((s) => s.check);
  const [now, setNow] = useState(() => Date.now());
  const [showAwake, setShowAwake] = useState(false);
  const [wasWaking, setWasWaking] = useState(false);

  useEffect(() => {
    check();
  }, [check]);

  useEffect(() => {
    if (status !== "waking") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [status]);

  // Briefly confirm when the server comes back after a wait.
  if (status === "waking" && !wasWaking) setWasWaking(true);
  if (status === "ok" && wasWaking) {
    setWasWaking(false);
    setShowAwake(true);
  }
  useEffect(() => {
    if (!showAwake) return;
    const t = setTimeout(() => setShowAwake(false), 3000);
    return () => clearTimeout(t);
  }, [showAwake]);

  if (status === "waking") {
    const seconds = wakingSince ? Math.max(0, Math.round((now - wakingSince) / 1000)) : 0;
    return (
      <div role="status" className="flex items-center gap-3 border-b border-amber-400/20 bg-amber-500/15 px-4 py-2 text-sm text-amber-100 backdrop-blur">
        <Spinner />
        <span className="min-w-0 flex-1">
          <b className="font-semibold">Waking up the server…</b>{" "}
          <span className="text-amber-200/80">It sleeps when nobody's using it and can take up to a minute to start. ({seconds}s)</span>
        </span>
      </div>
    );
  }
  if (status === "unreachable") {
    return (
      <div role="alert" className="flex items-center gap-3 border-b border-red-400/20 bg-red-500/15 px-4 py-2 text-sm text-red-100">
        <CloudOff size={16} className="shrink-0" />
        <span className="min-w-0 flex-1">Can't reach the server. Check your connection, or try again in a moment.</span>
        <button onClick={check} className="rounded-lg bg-white/10 px-3 py-1 text-xs font-semibold hover:bg-white/20">Try again</button>
      </div>
    );
  }
  if (showAwake) {
    return (
      <div role="status" className="border-b border-emerald-400/20 bg-emerald-500/15 px-4 py-2 text-sm text-emerald-100">
        The server is awake. You're good to go.
      </div>
    );
  }
  return null;
}

/** App-wide notices pinned to the top of every page. */
export default function AppBanners() {
  return (
    <div className="fixed inset-x-0 top-0 z-[20000] pt-[env(safe-area-inset-top)]">
      <UpdateBanner />
      <ServerWakeBanner />
    </div>
  );
}
