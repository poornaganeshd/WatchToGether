import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  CalendarClock, CalendarPlus, Check, Copy, Crown, Settings as SettingsIcon, Globe2, History, KeyRound, Lock, LogIn, LogOut, MonitorPlay, Plus, RefreshCw, Search,
  Trash2, UserMinus, UserPlus, Users, X,
} from "lucide-react";
import api, { getErrorMessage } from "../lib/api";
import { useAuthStore } from "../store/useAuthStore";
import { useSocketStore } from "../store/useSocketStore";
import { toast } from "../store/useToastStore";
import { copyToClipboard, greeting, timeAgo } from "../lib/format";
import Logo from "../components/ui/Logo";
import Avatar from "../components/ui/Avatar";
import Spinner from "../components/ui/Spinner";
import PasswordInput from "../components/PasswordInput";
import { rememberAvatars } from "../store/useAvatarStore";
import { countdown, downloadCalendarEvent, toLocalInputValue } from "../lib/calendar";

interface Friend {
  id: string;
  status: "PENDING" | "ACCEPTED";
  isSender: boolean;
  user: { id: string; name: string; email: string; avatarVersion?: number | null };
  online?: boolean;
  room?: { id: string; name: string; displayId: string | null; isPrivate: boolean } | null;
}

interface RoomSummary {
  id: string;
  displayId: string | null;
  name: string;
  description?: string | null;
  isActive: boolean;
  isPrivate: boolean;
  hostId: string;
  host: { name: string };
  createdAt: string;
  visitedAt?: string;
  maxParticipants?: number;
  scheduledFor?: string | null;
  _count?: { participants: number };
}

type Tab = "live" | "upcoming" | "friends" | "history";

export default function Dashboard() {
  const { user, logout } = useAuthStore();
  const { socket, connect } = useSocketStore();
  const navigate = useNavigate();

  const [activeTab, setActiveTab] = useState<Tab>("live");
  const [friends, setFriends] = useState<Friend[]>([]);
  const [publicRooms, setPublicRooms] = useState<RoomSummary[]>([]);
  const [roomHistory, setRoomHistory] = useState<RoomSummary[]>([]);
  const [loading, setLoading] = useState({ live: true, friends: true, history: true, upcoming: true });

  const [roomName, setRoomName] = useState("");
  const [isPrivate, setIsPrivate] = useState(true);
  const [createPassword, setCreatePassword] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [scheduleLater, setScheduleLater] = useState(false);
  const [scheduleAt, setScheduleAt] = useState(() => toLocalInputValue(new Date(Date.now() + 60 * 60 * 1000)));
  const [upcomingRooms, setUpcomingRooms] = useState<RoomSummary[]>([]);
  const [now, setNow] = useState(() => Date.now());

  const [joinCode, setJoinCode] = useState("");
  const [joinPassword, setJoinPassword] = useState("");
  const [needsJoinPassword, setNeedsJoinPassword] = useState(false);
  const [isJoining, setIsJoining] = useState(false);

  const [friendEmail, setFriendEmail] = useState("");
  const [isSendingRequest, setIsSendingRequest] = useState(false);
  const [historyFilter, setHistoryFilter] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const fetchFriends = useCallback(async () => {
    try {
      const res = await api.get("/friends");
      const list: Friend[] = res.data.friends;
      rememberAvatars(Object.fromEntries(list.map((f) => [f.user.id, f.user.avatarVersion])));
      setFriends(list);
    } catch (error) {
      console.error("Failed to fetch friends:", error);
    } finally {
      setLoading((l) => ({ ...l, friends: false }));
    }
  }, []);

  const fetchHistory = useCallback(async () => {
    try {
      const res = await api.get("/rooms/history");
      setRoomHistory(res.data.rooms);
    } catch (error) {
      console.error("Failed to fetch history:", error);
    } finally {
      setLoading((l) => ({ ...l, history: false }));
    }
  }, []);

  const fetchUpcoming = useCallback(async () => {
    try {
      const res = await api.get("/rooms/upcoming");
      setUpcomingRooms(res.data.rooms);
    } catch (error) {
      console.error("Failed to fetch upcoming rooms:", error);
    } finally {
      setLoading((l) => ({ ...l, upcoming: false }));
    }
  }, []);

  const fetchPublicRooms = useCallback(async () => {
    try {
      const res = await api.get("/rooms");
      setPublicRooms(res.data.rooms);
    } catch (error) {
      console.error("Failed to fetch rooms:", error);
    } finally {
      setLoading((l) => ({ ...l, live: false }));
    }
  }, []);

  useEffect(() => {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().catch(() => undefined);
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchFriends();
    fetchHistory();
    fetchPublicRooms();
    fetchUpcoming();
    connect();
  }, [user, connect, fetchFriends, fetchHistory, fetchPublicRooms, fetchUpcoming]);

  // Countdowns and friend presence stay fresh without a full reload.
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(interval);
  }, []);

  // Keep the live room list fresh while the dashboard is open.
  useEffect(() => {
    if (activeTab !== "live") return;
    const interval = setInterval(fetchPublicRooms, 15000);
    return () => clearInterval(interval);
  }, [activeTab, fetchPublicRooms]);

  useEffect(() => {
    if (!socket || !user) return;

    const joinGlobal = () => socket.emit("join_global_room", { userId: user.id });
    joinGlobal();
    socket.on("connect", joinGlobal);

    let presenceTimer: ReturnType<typeof setTimeout> | null = null;
    const handlePresence = () => {
      // Several friends can change at once; batch into one refetch.
      if (presenceTimer) clearTimeout(presenceTimer);
      presenceTimer = setTimeout(fetchFriends, 400);
    };
    socket.on("presence_changed", handlePresence);

    const handleNotification = (data: { title: string; body: string; roomId?: string; scheduledFor?: string }) => {
      if (data.scheduledFor) {
        fetchUpcoming();
      }
      if (data.title.toLowerCase().includes("friend")) {
        fetchFriends();
      }
      toast.info(
        data.body,
        data.roomId
          ? data.scheduledFor
            ? { label: "See upcoming", onClick: () => setActiveTab("upcoming") }
            : { label: "Join room", onClick: () => navigate(`/room/${data.roomId}`) }
          : undefined
      );
      if ("Notification" in window && Notification.permission === "granted" && document.hidden) {
        const n = new Notification(data.title, { body: data.body, icon: "/favicon.svg" });
        if (data.roomId) {
          n.onclick = () => {
            window.focus();
            navigate(`/room/${data.roomId}`);
          };
        }
      }
    };

    socket.on("notification", handleNotification);
    return () => {
      socket.off("connect", joinGlobal);
      socket.off("notification", handleNotification);
      socket.off("presence_changed", handlePresence);
      if (presenceTimer) clearTimeout(presenceTimer);
    };
  }, [socket, user, navigate, fetchFriends, fetchUpcoming]);

  if (!user) return null;

  const incomingRequests = friends.filter((f) => f.status === "PENDING" && !f.isSender);
  const outgoingRequests = friends.filter((f) => f.status === "PENDING" && f.isSender);
  const acceptedFriends = friends
    .filter((f) => f.status === "ACCEPTED")
    .sort((a, b) => Number(!!b.room) - Number(!!a.room) || Number(!!b.online) - Number(!!a.online) || a.user.name.localeCompare(b.user.name));
  const friendsWatching = acceptedFriends.filter((f) => f.room);
  const filteredHistory = roomHistory.filter((r) => {
    const q = historyFilter.trim().toLowerCase();
    return !q || r.name.toLowerCase().includes(q) || (r.displayId ?? "").toLowerCase().includes(q) || r.host.name.toLowerCase().includes(q);
  });

  const handleCopy = async (key: string, text: string) => {
    if (await copyToClipboard(text)) {
      setCopiedId(key);
      setTimeout(() => setCopiedId((c) => (c === key ? null : c)), 1500);
    } else {
      toast.error("Couldn't access the clipboard");
    }
  };

  const handleCreateRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!roomName.trim()) return;
    if (isPrivate && !createPassword.trim()) {
      toast.error("Private rooms need a password");
      return;
    }
    let scheduledFor: string | undefined;
    if (scheduleLater) {
      const when = new Date(scheduleAt);
      if (Number.isNaN(when.getTime()) || when.getTime() <= Date.now()) {
        toast.error("Pick a start time in the future");
        return;
      }
      scheduledFor = when.toISOString();
    }
    setIsCreating(true);
    try {
      const res = await api.post("/rooms", {
        name: roomName.trim(),
        isPrivate,
        password: isPrivate ? createPassword : undefined,
        scheduledFor,
      });
      if (scheduledFor) {
        toast.success("Watch party scheduled — your friends have been notified.");
        setRoomName("");
        setCreatePassword("");
        setScheduleLater(false);
        setIsCreating(false);
        setActiveTab("upcoming");
        fetchUpcoming();
        return;
      }
      navigate(`/room/${res.data.room.id}`);
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to create room"));
      setIsCreating(false);
    }
  };

  const handleJoinRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    let code = joinCode.trim();
    if (!code) return;
    // Accept a pasted invite link as well as a code.
    const linkMatch = code.match(/\/room\/([0-9a-f-]{36})/i);
    if (linkMatch) code = linkMatch[1];

    setIsJoining(true);
    try {
      const res = await api.post("/rooms/join", { roomId: code, password: joinPassword || undefined });
      navigate(`/room/${res.data.room.id}`, { state: { password: joinPassword || undefined } });
    } catch (error: unknown) {
      const message = getErrorMessage(error, "Failed to join room");
      if (message === "Password required") {
        setNeedsJoinPassword(true);
        toast.info("This room is private. Enter its password to join.");
      } else {
        if (message === "Incorrect password") setNeedsJoinPassword(true);
        toast.error(message);
      }
      setIsJoining(false);
    }
  };

  const handleEndRoom = async (roomId: string) => {
    if (!confirm("End this room for everyone? Participants will be sent back to their dashboards.")) return;
    try {
      await api.post(`/rooms/${roomId}/end`);
      toast.success("Room ended");
      fetchHistory();
      fetchPublicRooms();
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to end room"));
    }
  };

  const handleDeleteRoom = async (roomId: string) => {
    if (!confirm("Delete this room permanently? Its chat history will be lost.")) return;
    try {
      await api.delete(`/rooms/${roomId}`);
      toast.success("Room deleted");
      setRoomHistory((rooms) => rooms.filter((r) => r.id !== roomId));
      fetchPublicRooms();
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to delete room"));
    }
  };

  const handleForgetRoom = async (roomId: string) => {
    try {
      await api.delete(`/rooms/history/${roomId}`);
      setRoomHistory((rooms) => rooms.filter((r) => r.id !== roomId));
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to update history"));
    }
  };

  const handleSendFriendRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!friendEmail.trim()) return;
    setIsSendingRequest(true);
    try {
      const res = await api.post("/friends/request", { email: friendEmail.trim() });
      setFriendEmail("");
      toast.success(res.data.message === "Friend request accepted" ? "You're now friends!" : "Friend request sent");
      fetchFriends();
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to send request"));
    } finally {
      setIsSendingRequest(false);
    }
  };

  const handleAcceptFriendRequest = async (friendId: string) => {
    try {
      await api.post(`/friends/accept/${friendId}`);
      fetchFriends();
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to accept request"));
    }
  };

  const handleRemoveFriend = async (friend: Friend, verb: string) => {
    if (friend.status === "ACCEPTED" && !confirm(`Remove ${friend.user.name} from your friends?`)) return;
    try {
      await api.delete(`/friends/${friend.id}`);
      setFriends((list) => list.filter((f) => f.id !== friend.id));
      toast.success(verb);
    } catch (error) {
      toast.error(getErrorMessage(error, "Something went wrong"));
    }
  };

  const tabs: { id: Tab; label: string; icon: typeof Globe2; badge?: number }[] = [
    { id: "live", label: "Live now", icon: Globe2, badge: publicRooms.length || undefined },
    { id: "friends", label: "Friends", icon: Users, badge: incomingRequests.length || undefined },
    { id: "upcoming", label: "Upcoming", icon: CalendarClock, badge: upcomingRooms.filter((r) => r.scheduledFor && new Date(r.scheduledFor).getTime() > now).length || undefined },
    { id: "history", label: "History", icon: History },
  ];

  return (
    <div className="min-h-screen">
      <div className="pointer-events-none fixed inset-0 -z-10">
        <div className="absolute -top-40 left-1/3 h-[420px] w-[720px] rounded-full bg-indigo-600/15 blur-[120px]" />
      </div>

      <header className="sticky top-0 z-40 border-b border-white/5 bg-ink-950/70 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6">
          <Logo to="/dashboard" size="sm" />
          <div className="flex items-center gap-3">
            <div className="hidden text-right sm:block">
              <p className="text-sm font-medium text-white">{user.name}</p>
              <p className="text-xs text-slate-500">{user.email}</p>
            </div>
            <Link to="/settings" className="rounded-full" title="Profile & settings" aria-label="Profile and settings">
              <Avatar name={user.name} seed={user.id} version={user.avatarVersion ?? null} size={36} />
            </Link>
            <Link to="/settings" className="btn-ghost px-2.5" title="Settings" aria-label="Settings">
              <SettingsIcon size={18} />
            </Link>
            <button onClick={logout} className="btn-ghost px-2.5" title="Sign out" aria-label="Sign out">
              <LogOut size={18} />
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        <section className="mb-8 animate-fade-up">
          <p className="text-sm text-slate-400">{greeting()},</p>
          <h1 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">{user.name.split(" ")[0]} 👋</h1>
        </section>

        <section className="mb-10 grid gap-4 md:grid-cols-2">
          {/* Create */}
          <form onSubmit={handleCreateRoom} className="card relative overflow-hidden p-6 animate-fade-up">
            <div className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-indigo-500/20 blur-3xl" />
            <div className="mb-5 flex items-center gap-3">
              <div className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-500 shadow-glow">
                <Plus size={20} />
              </div>
              <div>
                <h2 className="font-display font-semibold">Start a watch party</h2>
                <p className="text-xs text-slate-400">Create a room and invite your crew.</p>
              </div>
            </div>
            <div className="space-y-3">
              <input
                type="text"
                value={roomName}
                onChange={(e) => setRoomName(e.target.value)}
                placeholder="Room name, e.g. Friday Movie Night"
                maxLength={100}
                className="input"
                required
              />
              <div className="grid grid-cols-2 gap-2 rounded-xl border border-white/10 bg-ink-900/60 p-1">
                {[
                  { value: true, label: "Private", icon: Lock },
                  { value: false, label: "Public", icon: Globe2 },
                ].map(({ value, label, icon: Icon }) => (
                  <button
                    key={label}
                    type="button"
                    onClick={() => setIsPrivate(value)}
                    className={`flex items-center justify-center gap-2 rounded-lg py-2 text-sm font-medium transition-colors ${
                      isPrivate === value ? "bg-white/10 text-white shadow" : "text-slate-400 hover:text-slate-200"
                    }`}
                    aria-pressed={isPrivate === value}
                  >
                    <Icon size={14} /> {label}
                  </button>
                ))}
              </div>
              {isPrivate ? (
                <PasswordInput
                  value={createPassword}
                  onChange={(e) => setCreatePassword(e.target.value)}
                  placeholder="Room password"
                  maxLength={100}
                  autoComplete="new-password"
                />
              ) : (
                <p className="px-1 text-xs text-slate-400">Public rooms appear under “Live now” for everyone.</p>
              )}
              <label className="flex cursor-pointer items-center gap-2 px-1 text-sm text-slate-300">
                <input type="checkbox" checked={scheduleLater} onChange={(e) => setScheduleLater(e.target.checked)} className="h-4 w-4 rounded accent-indigo-500" />
                <CalendarClock size={14} className="text-indigo-300" /> Schedule for later
              </label>
              {scheduleLater && (
                <input
                  type="datetime-local"
                  value={scheduleAt}
                  min={toLocalInputValue(new Date())}
                  onChange={(e) => setScheduleAt(e.target.value)}
                  className="input animate-fade-up [color-scheme:dark]"
                  aria-label="Start time"
                />
              )}
              <button type="submit" disabled={isCreating || !roomName.trim()} className="btn-primary w-full">
                {isCreating ? <Spinner className="h-4 w-4" /> : scheduleLater ? <CalendarClock size={16} /> : <MonitorPlay size={16} />}
                {scheduleLater ? "Schedule watch party" : "Create room"}
              </button>
            </div>
          </form>

          {/* Join */}
          <form onSubmit={handleJoinRoom} className="card p-6 animate-fade-up [animation-delay:60ms]">
            <div className="mb-5 flex items-center gap-3">
              <div className="grid h-10 w-10 place-items-center rounded-xl border border-white/10 bg-white/5">
                <LogIn size={18} />
              </div>
              <div>
                <h2 className="font-display font-semibold">Join with a code</h2>
                <p className="text-xs text-slate-400">Paste a room code like WT-1234 or an invite link.</p>
              </div>
            </div>
            <div className="space-y-3">
              <input
                type="text"
                value={joinCode}
                onChange={(e) => {
                  setJoinCode(e.target.value);
                  setNeedsJoinPassword(false);
                }}
                placeholder="WT-1234"
                className="input font-mono uppercase tracking-wider placeholder:normal-case placeholder:tracking-normal"
                required
              />
              {needsJoinPassword && (
                <div className="animate-fade-up">
                  <PasswordInput
                    value={joinPassword}
                    onChange={(e) => setJoinPassword(e.target.value)}
                    placeholder="Room password"
                    autoFocus
                  />
                </div>
              )}
              <button type="submit" disabled={isJoining || !joinCode.trim()} className="btn-secondary w-full">
                {isJoining ? <Spinner className="h-4 w-4" /> : <KeyRound size={16} />} Join room
              </button>
            </div>
          </form>
        </section>

        <div className="mb-5 flex gap-1 overflow-x-auto rounded-xl border border-white/5 bg-white/[0.02] p-1 sm:w-fit">
          {tabs.map(({ id, label, icon: Icon, badge }) => (
            <button
              key={id}
              onClick={() => {
                setActiveTab(id);
                if (id === "history") fetchHistory();
                if (id === "live") fetchPublicRooms();
                if (id === "friends") fetchFriends();
                if (id === "upcoming") fetchUpcoming();
              }}
              className={`flex items-center gap-2 whitespace-nowrap rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                activeTab === id ? "bg-white/10 text-white" : "text-slate-400 hover:text-slate-200"
              }`}
            >
              <Icon size={16} /> {label}
              {badge ? (
                <span className={`rounded-full px-1.5 text-[10px] font-bold ${id === "friends" ? "bg-fuchsia-500 text-white" : "bg-white/10 text-slate-300"}`}>
                  {badge}
                </span>
              ) : null}
            </button>
          ))}
        </div>

        {activeTab === "live" && (
          <section className="animate-fade-in">
            {friendsWatching.length > 0 && (
              <div className="mb-6">
                <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-fuchsia-300">Friends watching now</h3>
                <div className="flex gap-3 overflow-x-auto pb-1">
                  {friendsWatching.map((f) => (
                    <button
                      key={f.id}
                      onClick={() => navigate(`/room/${f.room!.id}`)}
                      className="card flex min-w-[15rem] items-center gap-3 p-3 text-left transition-colors hover:border-fuchsia-400/30 hover:bg-white/[0.05]"
                    >
                      <Avatar name={f.user.name} seed={f.user.id} version={f.user.avatarVersion} size={40} online />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-white">{f.user.name}</p>
                        <p className="flex items-center gap-1 truncate text-xs text-slate-400">
                          {f.room!.isPrivate && <Lock size={11} />} {f.room!.name}
                        </p>
                      </div>
                      <span className="chip border-fuchsia-400/30 bg-fuchsia-500/10 text-fuchsia-200">Join</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="mb-4 flex items-center justify-between">
              <p className="text-sm text-slate-400">Public rooms that are open right now.</p>
              <button onClick={fetchPublicRooms} className="btn-ghost px-2.5 py-1.5 text-xs">
                <RefreshCw size={14} /> Refresh
              </button>
            </div>
            {loading.live ? (
              <SkeletonGrid />
            ) : publicRooms.length === 0 ? (
              <EmptyState icon={Globe2} title="No public rooms live" body="Start a public room and it will show up here for everyone." />
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {publicRooms.map((room) => (
                  <button
                    key={room.id}
                    onClick={() => navigate(`/room/${room.id}`)}
                    className="card group p-5 text-left transition-all hover:-translate-y-0.5 hover:border-indigo-400/30 hover:bg-white/[0.05]"
                  >
                    <div className="mb-4 flex items-center justify-between">
                      <span className="chip border-emerald-500/30 bg-emerald-500/10 text-emerald-300">
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" /> Live
                      </span>
                      <span className="font-mono text-xs text-slate-500">{room.displayId}</span>
                    </div>
                    <h3 className="truncate font-display text-lg font-semibold text-white">{room.name}</h3>
                    <div className="mt-3 flex items-center justify-between text-xs text-slate-400">
                      <span className="flex items-center gap-2">
                        <Avatar name={room.host.name} seed={room.hostId} size={22} /> {room.host.name}
                      </span>
                      <span className="flex items-center gap-1">
                        <Users size={13} /> {room._count?.participants ?? 0}
                        {room.maxParticipants ? <span className="text-slate-600">/{room.maxParticipants}</span> : null}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </section>
        )}

        {activeTab === "friends" && (
          <section className="grid gap-4 animate-fade-in lg:grid-cols-3">
            <form onSubmit={handleSendFriendRequest} className="card h-fit p-5">
              <h3 className="font-display font-semibold">Add a friend</h3>
              <p className="mb-4 mt-1 text-xs text-slate-400">Send a request using their account email.</p>
              <input
                type="email"
                value={friendEmail}
                onChange={(e) => setFriendEmail(e.target.value)}
                placeholder="friend@example.com"
                className="input mb-3"
              />
              <button type="submit" disabled={isSendingRequest || !friendEmail.trim()} className="btn-primary w-full">
                {isSendingRequest ? <Spinner className="h-4 w-4" /> : <UserPlus size={16} />} Send request
              </button>
            </form>

            <div className="space-y-4 lg:col-span-2">
              {incomingRequests.length > 0 && (
                <div className="card p-5">
                  <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-fuchsia-300">Requests for you</h3>
                  <div className="space-y-2">
                    {incomingRequests.map((friend) => (
                      <FriendRow key={friend.id} friend={friend}>
                        <button onClick={() => handleAcceptFriendRequest(friend.id)} className="btn-primary px-3 py-1.5 text-xs">
                          <Check size={14} /> Accept
                        </button>
                        <button onClick={() => handleRemoveFriend(friend, "Request declined")} className="btn-ghost px-2 py-1.5" title="Decline" aria-label="Decline">
                          <X size={16} />
                        </button>
                      </FriendRow>
                    ))}
                  </div>
                </div>
              )}

              <div className="card p-5">
                <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Friends {acceptedFriends.length > 0 && `· ${acceptedFriends.length}`}
                </h3>
                {loading.friends ? (
                  <div className="grid h-24 place-items-center text-slate-500"><Spinner /></div>
                ) : acceptedFriends.length === 0 && outgoingRequests.length === 0 ? (
                  <EmptyState icon={Users} title="No friends yet" body="Add friends by email to invite them into rooms with one click." compact />
                ) : (
                  <div className="space-y-2">
                    {acceptedFriends.map((friend) => (
                      <FriendRow key={friend.id} friend={friend} showPresence>
                        {friend.room && (
                          <button onClick={() => navigate(`/room/${friend.room!.id}`)} className="btn-primary px-3 py-1.5 text-xs" title={`Join ${friend.room.name}`}>
                            <LogIn size={14} /> Join
                          </button>
                        )}
                        <button onClick={() => handleRemoveFriend(friend, "Friend removed")} className="btn-ghost px-2 py-1.5 text-slate-500 hover:text-red-300" title="Remove friend" aria-label="Remove friend">
                          <UserMinus size={16} />
                        </button>
                      </FriendRow>
                    ))}
                    {outgoingRequests.map((friend) => (
                      <FriendRow key={friend.id} friend={friend}>
                        <span className="chip border-white/10 bg-white/5 text-slate-400">Pending</span>
                        <button onClick={() => handleRemoveFriend(friend, "Request cancelled")} className="btn-ghost px-2 py-1.5" title="Cancel request" aria-label="Cancel request">
                          <X size={16} />
                        </button>
                      </FriendRow>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </section>
        )}

        {activeTab === "upcoming" && (
          <section className="animate-fade-in">
            <p className="mb-4 text-sm text-slate-400">Watch parties scheduled by you and your friends.</p>
            {loading.upcoming ? (
              <SkeletonGrid />
            ) : upcomingRooms.length === 0 ? (
              <EmptyState icon={CalendarClock} title="Nothing scheduled" body="Tick “Schedule for later” when creating a room and your friends will be notified." />
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {upcomingRooms.map((room) => {
                  const start = new Date(room.scheduledFor!);
                  const isHostRoom = room.hostId === user.id;
                  const soon = start.getTime() - now < 15 * 60_000;
                  return (
                    <div key={room.id} className="card flex flex-col p-5">
                      <div className="mb-3 flex items-center justify-between">
                        <span className={`chip ${soon ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" : "border-indigo-400/30 bg-indigo-500/10 text-indigo-200"}`}>
                          <CalendarClock size={12} /> {countdown(start, now)}
                        </span>
                        {room.isPrivate && <Lock size={13} className="text-slate-500" aria-label="Private" />}
                      </div>
                      <h3 className="truncate font-display text-lg font-semibold text-white">{room.name}</h3>
                      <p className="mt-1 text-sm text-slate-300">
                        {start.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                      </p>
                      <p className="mt-2 flex items-center gap-2 text-xs text-slate-400">
                        <Avatar name={room.host.name} seed={room.hostId} size={20} /> {isHostRoom ? "Hosted by you" : room.host.name}
                      </p>
                      <div className="mt-4 flex gap-2">
                        <button onClick={() => navigate(`/room/${room.id}`)} className={`${soon ? "btn-primary" : "btn-secondary"} flex-1 py-2 text-xs`}>
                          {soon ? "Join now" : "Open room"}
                        </button>
                        <button
                          onClick={() =>
                            downloadCalendarEvent({
                              id: room.id,
                              title: `Watch party: ${room.name}`,
                              start,
                              url: `${window.location.origin}/room/${room.id}`,
                              description: `${room.host.name} is hosting on WatchTogether${room.displayId ? ` (code ${room.displayId})` : ""}. Join: ${window.location.origin}/room/${room.id}`,
                            })
                          }
                          className="btn-secondary px-3 py-2 text-xs"
                          title="Add to calendar"
                          aria-label="Add to calendar"
                        >
                          <CalendarPlus size={14} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {activeTab === "history" && (
          <section className="animate-fade-in">
            <div className="relative mb-4 max-w-sm">
              <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500" />
              <input
                value={historyFilter}
                onChange={(e) => setHistoryFilter(e.target.value)}
                placeholder="Search rooms, codes or hosts"
                className="input pl-10"
              />
            </div>
            {loading.history ? (
              <SkeletonGrid />
            ) : filteredHistory.length === 0 ? (
              <EmptyState
                icon={History}
                title={roomHistory.length === 0 ? "No rooms yet" : "No matches"}
                body={roomHistory.length === 0 ? "Rooms you create or join will show up here." : "Try a different search."}
              />
            ) : (
              <div className="card divide-y divide-white/5">
                {filteredHistory.map((room) => {
                  const isHost = room.hostId === user.id;
                  const participants = room._count?.participants ?? 0;
                  const isLive = room.isActive && participants > 0;
                  return (
                    <div key={room.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="truncate font-semibold text-white">{room.name}</h3>
                          {isLive ? (
                            <span className="chip border-emerald-500/30 bg-emerald-500/10 text-emerald-300">
                              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" /> {participants} watching
                            </span>
                          ) : (
                            <span className="chip border-white/10 bg-white/5 text-slate-400">Idle</span>
                          )}
                          {room.isPrivate && <Lock size={13} className="text-slate-500" aria-label="Private" />}
                          {isHost && <Crown size={13} className="text-amber-400" aria-label="You host this room" />}
                        </div>
                        <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400">
                          {room.displayId && (
                            <button
                              onClick={() => handleCopy(room.id, room.displayId!)}
                              className="inline-flex items-center gap-1 font-mono text-slate-300 hover:text-white"
                              title="Copy room code"
                            >
                              {room.displayId} {copiedId === room.id ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
                            </button>
                          )}
                          <span>Host: {isHost ? "You" : room.host.name}</span>
                          <span>Visited {timeAgo(room.visitedAt ?? room.createdAt)}</span>
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <button onClick={() => navigate(`/room/${room.id}`)} className="btn-primary px-4 py-2 text-xs">
                          {isLive ? "Join" : "Open"}
                        </button>
                        {isHost && isLive && (
                          <button onClick={() => handleEndRoom(room.id)} className="btn-danger px-3 py-2 text-xs">
                            End
                          </button>
                        )}
                        {isHost ? (
                          <button onClick={() => handleDeleteRoom(room.id)} className="btn-ghost px-2 py-2 hover:text-red-300" title="Delete room" aria-label="Delete room">
                            <Trash2 size={16} />
                          </button>
                        ) : (
                          <button onClick={() => handleForgetRoom(room.id)} className="btn-ghost px-2 py-2" title="Remove from history" aria-label="Remove from history">
                            <X size={16} />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}

function FriendRow({ friend, children, showPresence = false }: { friend: Friend; children: React.ReactNode; showPresence?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-white/5 bg-ink-900/50 p-3">
      <div className="flex min-w-0 items-center gap-3">
        <Avatar name={friend.user.name} seed={friend.user.id} version={friend.user.avatarVersion} online={showPresence ? !!friend.online : undefined} />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-white">{friend.user.name}</p>
          <p className="truncate text-xs text-slate-500">
            {showPresence && friend.room ? (
              <span className="text-fuchsia-300">Watching {friend.room.name}</span>
            ) : showPresence && friend.online ? (
              <span className="text-emerald-300">Online</span>
            ) : (
              friend.user.email
            )}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">{children}</div>
    </div>
  );
}

function EmptyState({ icon: Icon, title, body, compact = false }: { icon: typeof Globe2; title: string; body: string; compact?: boolean }) {
  return (
    <div className={`flex flex-col items-center justify-center rounded-2xl border border-dashed border-white/10 text-center ${compact ? "py-8" : "py-16"}`}>
      <div className="mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-white/5 text-slate-400">
        <Icon size={22} />
      </div>
      <p className="font-medium text-slate-200">{title}</p>
      <p className="mt-1 max-w-xs text-sm text-slate-500">{body}</p>
    </div>
  );
}

function SkeletonGrid() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-32 animate-pulse rounded-2xl border border-white/5 bg-white/[0.03]" />
      ))}
    </div>
  );
}
