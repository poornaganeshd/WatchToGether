import { useState, useEffect } from "react";
import { Copy, Check, Mail, Send, UserPlus } from "lucide-react";
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
}

export default function InviteModal({ isOpen, onClose, roomId, roomCode }: InviteModalProps) {
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
  }, [isOpen]);

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
