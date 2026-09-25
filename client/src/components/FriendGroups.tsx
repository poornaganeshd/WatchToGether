import { useCallback, useEffect, useState } from "react";
import { Pencil, Plus, Trash2, UsersRound } from "lucide-react";
import api, { getErrorMessage } from "../lib/api";
import { toast } from "../store/useToastStore";
import Modal from "./ui/Modal";
import Avatar from "./ui/Avatar";
import Spinner from "./ui/Spinner";

interface Group {
  id: string;
  name: string;
  members: { id: string; name: string; avatarVersion: number | null }[];
}

interface FriendOption {
  id: string;
  name: string;
  avatarVersion?: number | null;
}

export default function FriendGroups({ friends }: { friends: FriendOption[] }) {
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [editing, setEditing] = useState<Group | "new" | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get("/friends/groups");
      setGroups(res.data.groups);
    } catch {
      setGroups([]);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const remove = async (group: Group) => {
    if (!confirm(`Delete the group "${group.name}"? Your friends stay friends.`)) return;
    try {
      await api.delete(`/friends/groups/${group.id}`);
      setGroups((list) => list?.filter((g) => g.id !== group.id) ?? null);
    } catch (error) {
      toast.error(getErrorMessage(error, "Couldn't delete the group"));
    }
  };

  return (
    <div className="card h-fit p-5">
      <div className="mb-1 flex items-center justify-between">
        <h3 className="flex items-center gap-2 font-display font-semibold"><UsersRound size={16} className="text-indigo-300" /> Groups</h3>
        <button onClick={() => setEditing("new")} disabled={friends.length === 0} className="btn-ghost px-2 py-1 text-xs" title={friends.length ? "New group" : "Add friends first"}>
          <Plus size={14} /> New
        </button>
      </div>
      <p className="mb-3 text-xs text-slate-400">Invite a whole crew to a room in one click.</p>
      {groups === null ? (
        <div className="grid h-16 place-items-center text-slate-500"><Spinner /></div>
      ) : groups.length === 0 ? (
        <p className="rounded-xl border border-dashed border-white/10 py-4 text-center text-xs text-slate-500">No groups yet</p>
      ) : (
        <div className="space-y-2">
          {groups.map((g) => (
            <div key={g.id} className="flex items-center justify-between gap-2 rounded-xl border border-white/5 bg-ink-900/50 p-2.5">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-white">{g.name}</p>
                <div className="mt-1 flex -space-x-1.5">
                  {g.members.slice(0, 6).map((m) => (
                    <Avatar key={m.id} name={m.name} seed={m.id} version={m.avatarVersion} size={20} />
                  ))}
                  {g.members.length > 6 && <span className="pl-2.5 text-[11px] text-slate-500">+{g.members.length - 6}</span>}
                  {g.members.length === 0 && <span className="text-[11px] text-slate-500">No members</span>}
                </div>
              </div>
              <div className="flex shrink-0">
                <button onClick={() => setEditing(g)} className="btn-ghost p-1.5" aria-label={`Edit ${g.name}`}><Pencil size={13} /></button>
                <button onClick={() => remove(g)} className="btn-ghost p-1.5 hover:text-red-300" aria-label={`Delete ${g.name}`}><Trash2 size={13} /></button>
              </div>
            </div>
          ))}
        </div>
      )}
      {editing && (
        <GroupEditor
          group={editing === "new" ? null : editing}
          friends={friends}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setGroups((list) => {
              const rest = (list ?? []).filter((g) => g.id !== saved.id);
              return editing === "new" ? [...rest, saved] : (list ?? []).map((g) => (g.id === saved.id ? saved : g));
            });
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function GroupEditor({ group, friends, onClose, onSaved }: { group: Group | null; friends: FriendOption[]; onClose: () => void; onSaved: (g: Group) => void }) {
  const [name, setName] = useState(group?.name ?? "");
  const [selected, setSelected] = useState<Set<string>>(new Set(group?.members.map((m) => m.id)));
  const [saving, setSaving] = useState(false);

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try {
      const body = { name: name.trim(), memberIds: Array.from(selected) };
      const res = group ? await api.patch(`/friends/groups/${group.id}`, body) : await api.post("/friends/groups", body);
      onSaved(res.data.group);
    } catch (error) {
      toast.error(getErrorMessage(error, "Couldn't save the group"));
      setSaving(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title={group ? "Edit group" : "New group"}>
      <form onSubmit={save} className="space-y-4 p-5">
        <div>
          <label className="label" htmlFor="group-name">Name</label>
          <input id="group-name" className="input" value={name} maxLength={50} onChange={(e) => setName(e.target.value)} placeholder="Movie crew" autoFocus />
        </div>
        <div>
          <span className="label">Members · {selected.size}</span>
          <div className="max-h-64 space-y-1 overflow-y-auto pr-1">
            {friends.map((f) => (
              <label key={f.id} className="flex cursor-pointer items-center gap-3 rounded-lg p-2 hover:bg-white/[0.03]">
                <input type="checkbox" checked={selected.has(f.id)} onChange={() => toggle(f.id)} className="h-4 w-4 accent-indigo-500" />
                <Avatar name={f.name} seed={f.id} version={f.avatarVersion} size={26} />
                <span className="text-sm text-slate-200">{f.name}</span>
              </label>
            ))}
          </div>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className="btn-secondary flex-1">Cancel</button>
          <button type="submit" disabled={saving || !name.trim()} className="btn-primary flex-1">
            {saving && <Spinner className="h-4 w-4" />} Save
          </button>
        </div>
      </form>
    </Modal>
  );
}
