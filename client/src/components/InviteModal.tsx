import { useState, useEffect } from "react";
import { Copy, Check, Link2, Mail, Send, Trash2, UserPlus, UsersRound } from "lucide-react";
import api, { getErrorMessage } from "../lib/api";
import { copyToClipboard } from "../lib/format";
import { toast } from "../store/useToastStore";
import Modal from "./ui/Modal";
import Avatar from "./ui/Avatar";
import Spinner from "./ui/Spinner";

interface Friend {
  id: string;
  status: string;
  user: {
    id: string;
    name: string;
    email: string;
  };
}

interface InviteModalProps {
  isOpen: boolean;
  onClose: () => void;
  roomId: string;
  roomCode?: string | null;
  /** Host or co-host: may create invite links. */
  canManage?: boolean;
}

interface InviteLink {
  id: string;
  expiresAt: string;
  maxUses: number | null;
  uses: number;
  url?: string;
}

interface FriendGroup {
  id: string;
  name: string;
  members: { id: string; name: string }[];
}

const EXPIRY_OPTIONS = [
  { hours: 1, label: "1 hour" },
  { hours: 24, label: "1 day" },
  { hours: 168, label: "7 days" },
  { hours: 720, label: "30 days" },
];
const USE_OPTIONS: (number | null)[] = [1, 5, 25, null];

export default function InviteModal({ isOpen, onClose, roomId, roomCode, canManage = false }: InviteModalProps) {
  const [links, setLinks] = useState<InviteLink[]>([]);
  const [newLinkUrls, setNewLinkUrls] = useState<Record<string, string>>({});
  const [expiryHours, setExpiryHours] = useState(24);
  const [maxUses, setMaxUses] = useState<number | null>(5);
  const [creatingLink, setCreatingLink] = useState(false);
  const [groups, setGroups] = useState<FriendGroup[]>([]);
  const [groupState, setGroupState] = useState<Record<string, "sending" | "sent">>({});
  const [friends, setFriends] = useState<Friend[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [copied, setCopied] = useState<"link" | "code" | null>(null);
  const [inviteState, setInviteState] = useState<Record<string, "sending" | "sent">>({});
  const [email, setEmail] = useState("");

  const roomLink = `${window.location.origin}/room/${roomId}`;

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsLoading(true);
    setInviteState({});
    api
      .get("/friends/groups")
      .then((res) => {
        if (!cancelled) setGroups(res.data.groups.filter((g: FriendGroup) => g.members.length > 0));
      })
      .catch(() => undefined);
    if (canManage) {
      api
        .get(`/rooms/${roomId}/invite-links`)
        .then((res) => {
          if (!cancelled) setLinks(res.data.links);
        })
        .catch(() => undefined);
    }
    api
      .get("/friends")
      .then((res) => {
        if (!cancelled) setFriends(res.data.friends.filter((f: Friend) => f.status === "ACCEPTED"));
      })
      .catch((error) => console.error("Failed to fetch friends:", error))
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, canManage, roomId]);

  const createLink = async () => {
    setCreatingLink(true);
    try {
      const res = await api.post(`/rooms/${roomId}/invite-links`, { expiresInHours: expiryHours, maxUses });
      const link: InviteLink = res.data.link;
      setLinks((list) => [link, ...list]);
      // The full URL is only returned once; keep it so it can still be copied this session.
      setNewLinkUrls((urls) => ({ ...urls, [link.id]: link.url! }));
      if (link.url && (await copyToClipboard(link.url))) toast.success("Invite link copied");
    } catch (error) {
      toast.error(getErrorMessage(error, "Couldn't create an invite link"));
    } finally {
      setCreatingLink(false);
    }
  };

  const revokeLink = async (linkId: string) => {
    try {
      await api.delete(`/rooms/${roomId}/invite-links/${linkId}`);
      setLinks((list) => list.filter((l) => l.id !== linkId));
    } catch (error) {
      toast.error(getErrorMessage(error, "Couldn't revoke the link"));
    }
  };

  const inviteGroup = async (group: FriendGroup) => {
    setGroupState((s) => ({ ...s, [group.id]: "sending" }));
    try {
      const res = await api.post(`/rooms/${roomId}/invite-group`, { groupId: group.id });
      setGroupState((s) => ({ ...s, [group.id]: "sent" }));
      toast.success(res.data.message);
    } catch (error) {
      setGroupState((s) => {
        const next = { ...s };
        delete next[group.id];
        return next;
      });
      toast.error(getErrorMessage(error, "Couldn't invite the group"));
    }
  };

  const handleCopy = async (kind: "link" | "code", text: string) => {
    if (await copyToClipboard(text)) {
      setCopied(kind);
      setTimeout(() => setCopied(null), 1800);
    } else {
      toast.error("Couldn't access the clipboard");
    }
  };

  const sendInvite = async (targetEmail: string, key: string) => {
    setInviteState((prev) => ({ ...prev, [key]: "sending" }));
    try {
      await api.post(`/rooms/${roomId}/invite`, { email: targetEmail });
      setInviteState((prev) => ({ ...prev, [key]: "sent" }));
      return true;
    } catch (error) {
      setInviteState((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      toast.error(getErrorMessage(error, "Failed to send invitation"));
      return false;
    }
  };

  const handleEmailInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    const target = email.trim();
    if (!target) return;
    if (await sendInvite(target, `email:${target}`)) {
      toast.success(`Invitation sent to ${target}`);
      setEmail("");
    }
  };

  const shareNative = async () => {
    try {
      await navigator.share({ title: "Join my watch party", text: roomCode ? `Room code: ${roomCode}` : undefined, url: roomLink });
    } catch {
      /* user cancelled */
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Invite people">
      <div className="space-y-6 p-5">
        <div className="grid gap-3 sm:grid-cols-[auto_1fr]">
          {roomCode && (
            <button
              onClick={() => handleCopy("code", roomCode)}
              className="group flex flex-col items-start rounded-xl border border-indigo-400/20 bg-indigo-500/10 px-4 py-3 text-left transition-colors hover:bg-indigo-500/15"
            >
              <span className="text-[10px] font-semibold uppercase tracking-wider text-indigo-300">Room code</span>
              <span className="mt-0.5 flex items-center gap-2 font-mono text-lg font-bold text-white">
                {roomCode}
                {copied === "code" ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} className="text-indigo-300 opacity-60 group-hover:opacity-100" />}
              </span>
            </button>
          )}
          <div className="min-w-0">
            <span className="label">Invite link</span>
            <div className="flex overflow-hidden rounded-xl border border-white/10 bg-ink-950">
              <input type="text" readOnly value={roomLink} className="min-w-0 flex-1 bg-transparent px-3 py-2 text-xs text-slate-400 outline-none" onFocus={(e) => e.target.select()} />
              <button onClick={() => handleCopy("link", roomLink)} className="flex items-center gap-1.5 bg-white/5 px-3 text-xs font-semibold text-white transition-colors hover:bg-white/10">
                {copied === "link" ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
                {copied === "link" ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
        </div>

        {"share" in navigator && (
          <button onClick={shareNative} className="btn-secondary w-full sm:hidden">
            <Send size={16} /> Share via…
          </button>
        )}

        {canManage && (
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
            <span className="label">Invite link (no password needed)</span>
            <div className="flex flex-wrap items-center gap-2">
              <select value={expiryHours} onChange={(e) => setExpiryHours(Number(e.target.value))} className="input w-auto py-1.5 text-xs" aria-label="Link expiry">
                {EXPIRY_OPTIONS.map((o) => (
                  <option key={o.hours} value={o.hours} className="bg-ink-900">Expires in {o.label}</option>
                ))}
              </select>
              <select
                value={maxUses === null ? "unlimited" : String(maxUses)}
                onChange={(e) => setMaxUses(e.target.value === "unlimited" ? null : Number(e.target.value))}
                className="input w-auto py-1.5 text-xs"
                aria-label="Maximum uses"
              >
                {USE_OPTIONS.map((u) => (
                  <option key={String(u)} value={u === null ? "unlimited" : String(u)} className="bg-ink-900">
                    {u === null ? "Unlimited uses" : `${u} use${u === 1 ? "" : "s"}`}
                  </option>
                ))}
              </select>
              <button onClick={createLink} disabled={creatingLink} className="btn-primary px-3 py-1.5 text-xs">
                {creatingLink ? <Spinner className="h-3.5 w-3.5" /> : <Link2 size={14} />} Create link
              </button>
            </div>
            {links.length > 0 && (
              <div className="mt-3 space-y-1.5">
                {links.map((link) => (
                  <div key={link.id} className="flex items-center justify-between gap-2 rounded-lg bg-ink-950/60 px-2.5 py-1.5 text-xs">
                    <span className="min-w-0 truncate text-slate-400">
                      {link.maxUses === null ? `${link.uses} used` : `${link.uses}/${link.maxUses} used`} · expires{" "}
                      {new Date(link.expiresAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                    </span>
                    <span className="flex shrink-0 items-center gap-1">
                      {newLinkUrls[link.id] && (
                        <button onClick={() => handleCopy("link", newLinkUrls[link.id])} className="btn-ghost p-1" title="Copy link" aria-label="Copy invite link">
                          <Copy size={13} />
                        </button>
                      )}
                      <button onClick={() => revokeLink(link.id)} className="btn-ghost p-1 hover:text-red-300" title="Revoke link" aria-label="Revoke invite link">
                        <Trash2 size={13} />
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {groups.length > 0 && (
          <div>
            <span className="label">Groups</span>
            <div className="flex flex-wrap gap-2">
              {groups.map((group) => (
                <button
                  key={group.id}
                  onClick={() => inviteGroup(group)}
                  disabled={!!groupState[group.id]}
                  className={`${groupState[group.id] === "sent" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" : ""} btn-secondary px-3 py-1.5 text-xs`}
                  title={group.members.map((m) => m.name).join(", ")}
                >
                  {groupState[group.id] === "sent" ? <Check size={13} /> : groupState[group.id] === "sending" ? <Spinner className="h-3.5 w-3.5" /> : <UsersRound size={13} />}
                  {group.name} · {group.members.length}
                </button>
              ))}
            </div>
          </div>
        )}

        <div>
          <span className="label">Friends</span>
          {isLoading ? (
            <div className="grid h-20 place-items-center text-slate-500"><Spinner /></div>
          ) : friends.length === 0 ? (
            <p className="rounded-xl border border-dashed border-white/10 py-5 text-center text-sm text-slate-500">
              No friends yet — add some from your dashboard.
            </p>
          ) : (
            <div className="max-h-56 space-y-1.5 overflow-y-auto pr-1">
              {friends.map((friend) => {
                const state = inviteState[friend.id];
                return (
                  <div key={friend.id} className="flex items-center justify-between gap-3 rounded-xl p-2 hover:bg-white/[0.03]">
                    <div className="flex min-w-0 items-center gap-3">
                      <Avatar name={friend.user.name} seed={friend.user.id} size={32} />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-slate-100">{friend.user.name}</p>
                        <p className="truncate text-xs text-slate-500">{friend.user.email}</p>
                      </div>
                    </div>
                    {state === "sent" ? (
                      <span className="chip border-emerald-500/30 bg-emerald-500/10 text-emerald-300"><Check size={12} /> Invited</span>
                    ) : (
                      <button
                        onClick={() => sendInvite(friend.user.email, friend.id)}
                        disabled={state === "sending"}
                        className="btn-secondary px-3 py-1.5 text-xs"
                      >
                        {state === "sending" ? <Spinner className="h-3.5 w-3.5" /> : <UserPlus size={14} />} Invite
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <form onSubmit={handleEmailInvite}>
          <span className="label">Invite by email</span>
          <div className="flex gap-2">
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="someone@example.com" className="input" />
            <button type="submit" disabled={!email.trim() || inviteState[`email:${email.trim()}`] === "sending"} className="btn-primary shrink-0 px-3" aria-label="Send email invite">
              <Mail size={16} />
            </button>
          </div>
        </form>
      </div>
    </Modal>
  );
}
