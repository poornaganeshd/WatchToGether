import { Link } from "react-router-dom";
import { ArrowRight, MessageSquare, MonitorUp, RefreshCcw, ShieldCheck, Smile, Video } from "lucide-react";
import Logo from "../components/ui/Logo";
import { useAuthStore } from "../store/useAuthStore";

const FEATURES = [
  { icon: RefreshCcw, title: "Frame-perfect sync", body: "Play, pause and seek once — everyone in the room follows instantly." },
  { icon: Video, title: "Face-to-face", body: "Built-in video and voice with smart speaker detection and host announcements." },
  { icon: MonitorUp, title: "Share anything", body: "Stream YouTube, local files or your whole screen to the room." },
  { icon: MessageSquare, title: "Live chat", body: "Chat with history, clickable timestamps and emoji reactions." },
  { icon: ShieldCheck, title: "Private rooms", body: "Lock rooms with a password and share a short code with friends." },
  { icon: Smile, title: "Made for friends", body: "Add friends, invite them in one click and get notified instantly." },
];

export default function Home() {
  const user = useAuthStore((s) => s.user);

  return (
    <div className="relative min-h-screen overflow-hidden">
      <div className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute -top-40 left-1/2 h-[520px] w-[900px] -translate-x-1/2 rounded-full bg-indigo-600/25 blur-[120px]" />
        <div className="absolute top-40 -right-40 h-[380px] w-[380px] rounded-full bg-fuchsia-600/15 blur-[120px]" />
        <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.025)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.025)_1px,transparent_1px)] bg-[size:64px_64px] [mask-image:radial-gradient(ellipse_at_top,black_30%,transparent_70%)]" />
      </div>

      <header className="mx-auto flex max-w-6xl items-center justify-between px-4 py-5 sm:px-6">
        <Logo />
        <nav className="flex items-center gap-2">
          {user ? (
            <Link to="/dashboard" className="btn-primary whitespace-nowrap">
              Dashboard <ArrowRight size={16} />
            </Link>
          ) : (
            <>
              <Link to="/login" className="btn-ghost whitespace-nowrap">Sign in</Link>
              <Link to="/signup" className="btn-primary hidden whitespace-nowrap sm:inline-flex">Get started</Link>
            </>
          )}
        </nav>
      </header>

      <main className="mx-auto max-w-6xl px-4 pb-24 pt-12 sm:px-6 sm:pt-20">
        <section className="mx-auto max-w-3xl text-center animate-fade-up">
          <span className="chip mb-6 border-indigo-400/30 bg-indigo-500/10 text-indigo-200">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px] shadow-emerald-400" />
            Real-time watch parties
          </span>
          <h1 className="font-display text-5xl font-extrabold leading-[1.05] tracking-tight sm:text-7xl">
            Movie night,
            <br />
            <span className="text-gradient">wherever you are.</span>
          </h1>
          <p className="mx-auto mt-6 max-w-xl text-lg text-slate-400">
            WatchTogether keeps every screen in perfect sync, so you can laugh, gasp and chat with friends like you're on the same couch.
          </p>
          <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link to={user ? "/dashboard" : "/signup"} className="btn-primary px-6 py-3 text-base">
              Start a watch party <ArrowRight size={18} />
            </Link>
            <Link to={user ? "/dashboard" : "/login"} state={{ from: "/dashboard" }} className="btn-secondary px-6 py-3 text-base">
              Join with a code
            </Link>
          </div>
        </section>

        <section className="relative mx-auto mt-20 max-w-4xl animate-fade-up [animation-delay:120ms]">
          <div className="card overflow-hidden p-2">
            <div className="relative aspect-video overflow-hidden rounded-xl bg-gradient-to-br from-ink-800 via-ink-900 to-black">
              <div className="absolute inset-0 grid place-items-center">
                <div className="grid h-20 w-20 place-items-center rounded-full bg-white/10 backdrop-blur-md ring-1 ring-white/20">
                  <svg viewBox="0 0 24 24" className="ml-1 h-9 w-9 fill-white"><path d="M8 5.5v13a1 1 0 0 0 1.53.85l10.4-6.5a1 1 0 0 0 0-1.7L9.53 4.65A1 1 0 0 0 8 5.5Z" /></svg>
                </div>
              </div>
              <div className="absolute bottom-4 left-4 right-4 flex items-center gap-3">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
                  <div className="h-full w-2/5 rounded-full bg-gradient-to-r from-indigo-400 to-fuchsia-400" />
                </div>
                <span className="font-mono text-xs text-slate-300">42:17</span>
              </div>
              <div className="absolute right-4 top-4 flex -space-x-2">
                {["from-indigo-500 to-violet-500", "from-fuchsia-500 to-pink-500", "from-cyan-500 to-blue-500", "from-emerald-500 to-teal-500"].map((g) => (
                  <span key={g} className={`h-9 w-9 rounded-full bg-gradient-to-br ${g} ring-2 ring-ink-900`} />
                ))}
              </div>
              <div className="absolute bottom-12 right-8 text-3xl animate-bounce">🍿</div>
            </div>
          </div>
        </section>

        <section className="mt-24 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(({ icon: Icon, title, body }) => (
            <div key={title} className="card p-6 transition-colors hover:bg-white/[0.05]">
              <div className="mb-4 grid h-10 w-10 place-items-center rounded-xl bg-indigo-500/15 text-indigo-300">
                <Icon size={20} />
              </div>
              <h3 className="font-display font-semibold text-white">{title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-slate-400">{body}</p>
            </div>
          ))}
        </section>
      </main>

      <footer className="border-t border-white/5 py-8 text-center text-xs text-slate-500">
        © {new Date().getFullYear()} WatchTogether. Grab the popcorn.
      </footer>
    </div>
  );
}
