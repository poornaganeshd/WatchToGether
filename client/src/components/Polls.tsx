import { useEffect, useState } from "react";
import { BarChart3, Check, ListPlus, Plus, Trophy, X } from "lucide-react";
import { useSocketStore } from "../store/useSocketStore";
import Modal from "./ui/Modal";

export function PollCard({ roomId, canManage }: { roomId: string; canManage: boolean }) {
  const poll = useSocketStore((s) => s.poll);
  const myVote = useSocketStore((s) => s.myPollVote);
  const socket = useSocketStore((s) => s.socket);
  const [dismissedId, setDismissedId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!poll?.closesAt || poll.closed) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [poll?.closesAt, poll?.closed]);

  if (!poll || dismissedId === poll.id) return null;
  const secondsLeft = poll.closesAt && !poll.closed ? Math.max(0, Math.ceil((poll.closesAt - now) / 1000)) : null;

  return (
    <div className="mx-3 mt-3 rounded-xl border border-indigo-400/25 bg-indigo-500/[0.07] p-3 animate-fade-up">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-indigo-300">
            <BarChart3 size={12} /> {poll.closed ? "Poll results" : "Poll"} · {poll.createdByName}
          </p>
          <p className="mt-0.5 text-sm font-semibold text-white">{poll.question}</p>
        </div>
        {poll.closed && (
          <button onClick={() => setDismissedId(poll.id)} className="rounded p-1 text-slate-400 hover:bg-white/5 hover:text-white" aria-label="Dismiss poll">
            <X size={14} />
          </button>
        )}
      </div>
      <div className="space-y-1.5">
        {poll.options.map((option, i) => {
          const pct = poll.totalVotes ? Math.round((poll.counts[i] / poll.totalVotes) * 100) : 0;
          const isMine = myVote === i;
          const isWinner = poll.closed && poll.winner === i;
          return (
            <button
              key={i}
              disabled={poll.closed}
              onClick={() => socket?.emit("poll_vote", { roomId, pollId: poll.id, option: i })}
              className={`relative w-full overflow-hidden rounded-lg border px-3 py-2 text-left text-xs transition-colors ${
                isMine ? "border-indigo-400/60" : "border-white/10 enabled:hover:border-white/25"
              }`}
              aria-pressed={isMine}
            >
              <span className={`absolute inset-y-0 left-0 ${isWinner ? "bg-emerald-500/25" : "bg-white/[0.07]"} transition-all`} style={{ width: `${pct}%` }} />
              <span className="relative flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5 text-slate-100">
                  {isWinner && <Trophy size={12} className="shrink-0 text-emerald-300" />}
                  {isMine && !isWinner && <Check size={12} className="shrink-0 text-indigo-300" />}
                  <span className="truncate">{option}</span>
                </span>
                <span className="shrink-0 font-mono text-slate-400">{pct}%</span>
              </span>
            </button>
          );
        })}
      </div>
      <div className="mt-2 flex items-center justify-between text-[11px] text-slate-400">
        <span>
          {poll.totalVotes} vote{poll.totalVotes === 1 ? "" : "s"}
          {secondsLeft !== null && ` · closes in ${secondsLeft}s`}
          {poll.queueWinner && (poll.closed ? (poll.winner !== null ? " · winner queued" : "") : " · winner gets queued")}
        </span>
        {canManage && !poll.closed && (
          <button onClick={() => socket?.emit("poll_close", { roomId, pollId: poll.id })} className="font-semibold text-indigo-300 hover:text-indigo-200">
            Close poll
          </button>
        )}
      </div>
    </div>
  );
}

const DURATIONS = [
  { value: 0, label: "Until closed" },
  { value: 60, label: "1 minute" },
  { value: 120, label: "2 minutes" },
  { value: 300, label: "5 minutes" },
] as const;

export function PollComposer({ roomId, isOpen, onClose }: { roomId: string; isOpen: boolean; onClose: () => void }) {
  const socket = useSocketStore((s) => s.socket);
  const queue = useSocketStore((s) => s.queue);
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["", ""]);
  const [queueWinner, setQueueWinner] = useState(false);
  const [duration, setDuration] = useState<number>(60);

  const cleaned = options.map((o) => o.trim()).filter(Boolean);
  const linksOk = !queueWinner || cleaned.every((o) => /^https?:\/\/\S+$/i.test(o));
  const canSubmit = question.trim() && cleaned.length >= 2 && linksOk;

  const useQueue = () => {
    // "What should we watch next?" from what's already suggested.
    setQueueWinner(true);
    setQuestion((q) => q || "What should we watch next?");
    setOptions(queue.slice(0, 6).map((q) => q.url).concat(queue.length < 2 ? [""] : []).slice(0, 6));
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    socket?.emit("poll_create", { roomId, question: question.trim(), options: cleaned, queueWinner, durationSeconds: duration });
    setQuestion("");
    setOptions(["", ""]);
    setQueueWinner(false);
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={<span className="flex items-center gap-2"><BarChart3 size={18} className="text-indigo-300" /> New poll</span>}>
      <form onSubmit={submit} className="space-y-4 p-5">
        <div>
          <label className="label" htmlFor="poll-question">Question</label>
          <input id="poll-question" className="input" maxLength={200} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="What should we watch next?" autoFocus />
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="label mb-0">Options</span>
            {queue.length > 0 && (
              <button type="button" onClick={useQueue} className="flex items-center gap-1 text-xs font-medium text-indigo-300 hover:text-indigo-200">
                <ListPlus size={12} /> Use queued videos
              </button>
            )}
          </div>
          {options.map((option, i) => (
            <div key={i} className="flex gap-2">
              <input
                className="input py-2"
                maxLength={200}
                value={option}
                onChange={(e) => setOptions((list) => list.map((o, j) => (j === i ? e.target.value : o)))}
                placeholder={queueWinner ? "https://…" : `Option ${i + 1}`}
              />
              {options.length > 2 && (
                <button type="button" onClick={() => setOptions((list) => list.filter((_, j) => j !== i))} className="btn-ghost px-2" aria-label="Remove option">
                  <X size={14} />
                </button>
              )}
            </div>
          ))}
          {options.length < 6 && (
            <button type="button" onClick={() => setOptions((list) => [...list, ""])} className="btn-ghost px-2 py-1 text-xs">
              <Plus size={12} /> Add option
            </button>
          )}
        </div>
        <label className="flex cursor-pointer items-start gap-2 text-sm text-slate-300">
          <input type="checkbox" checked={queueWinner} onChange={(e) => setQueueWinner(e.target.checked)} className="mt-0.5 h-4 w-4 accent-indigo-500" />
          <span>
            Options are video links — add the winner to the queue
            {!linksOk && <span className="block text-xs text-red-300">Every option needs to be an http(s) link.</span>}
          </span>
        </label>
        <div>
          <span className="label">Voting closes</span>
          <div className="grid grid-cols-4 gap-1 rounded-xl border border-white/10 bg-ink-900/60 p-1">
            {DURATIONS.map((d) => (
              <button
                key={d.value}
                type="button"
                onClick={() => setDuration(d.value)}
                aria-pressed={duration === d.value}
                className={`rounded-lg py-1.5 text-[11px] font-medium ${duration === d.value ? "bg-white/10 text-white" : "text-slate-400 hover:text-slate-200"}`}
              >
                {d.label}
              </button>
            ))}
          </div>
        </div>
        <button type="submit" disabled={!canSubmit} className="btn-primary w-full">Start poll</button>
      </form>
    </Modal>
  );
}
