import { useState } from "react";
import { Globe2, Lock } from "lucide-react";
import Modal from "./ui/Modal";
import PasswordInput from "./PasswordInput";
import Spinner from "./ui/Spinner";
import api, { getErrorMessage } from "../lib/api";
import { toast } from "../store/useToastStore";

interface RoomSettings {
  name: string;
  isPrivate: boolean;
  maxParticipants: number;
}

interface RoomSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  roomId: string;
  initial: RoomSettings;
  onSaved: (settings: RoomSettings) => void;
}

export default function RoomSettingsModal({ isOpen, onClose, roomId, initial, onSaved }: RoomSettingsModalProps) {
  const [name, setName] = useState(initial.name);
  const [isPrivate, setIsPrivate] = useState(initial.isPrivate);
  const [password, setPassword] = useState("");
  const [maxParticipants, setMaxParticipants] = useState(initial.maxParticipants);
  const [isSaving, setIsSaving] = useState(false);

  const needsPassword = isPrivate && !initial.isPrivate && !password.trim();

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setIsSaving(true);
    try {
      const res = await api.patch(`/rooms/${roomId}`, {
        name: name.trim(),
        isPrivate,
        maxParticipants,
        ...(isPrivate && password.trim() ? { password } : {}),
      });
      onSaved({ name: res.data.room.name, isPrivate: res.data.room.isPrivate, maxParticipants: res.data.room.maxParticipants });
      toast.success("Room settings saved");
      onClose();
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to save settings"));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Room settings">
      <form onSubmit={handleSave} className="space-y-5 p-5">
        <div>
          <label className="label" htmlFor="room-name">Name</label>
          <input id="room-name" className="input" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} required />
        </div>

        <div>
          <span className="label">Visibility</span>
          <div className="grid grid-cols-2 gap-2 rounded-xl border border-white/10 bg-ink-900/60 p-1">
            {[
              { value: true, label: "Private", icon: Lock },
              { value: false, label: "Public", icon: Globe2 },
            ].map(({ value, label, icon: Icon }) => (
              <button
                key={label}
                type="button"
                onClick={() => setIsPrivate(value)}
                aria-pressed={isPrivate === value}
                className={`flex items-center justify-center gap-2 rounded-lg py-2 text-sm font-medium transition-colors ${isPrivate === value ? "bg-white/10 text-white" : "text-slate-400 hover:text-slate-200"}`}
              >
                <Icon size={14} /> {label}
              </button>
            ))}
          </div>
        </div>

        {isPrivate && (
          <div>
            <label className="label">{initial.isPrivate ? "New password (optional)" : "Password"}</label>
            <PasswordInput
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={initial.isPrivate ? "Leave blank to keep the current one" : "Room password"}
              maxLength={100}
              autoComplete="new-password"
            />
          </div>
        )}

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <label className="label mb-0" htmlFor="room-capacity">Max participants</label>
            <span className="font-mono text-sm text-indigo-300">{maxParticipants}</span>
          </div>
          <input
            id="room-capacity"
            type="range"
            min={2}
            max={50}
            value={maxParticipants}
            onChange={(e) => setMaxParticipants(Number(e.target.value))}
            className="w-full accent-indigo-500"
          />
        </div>

        <div className="flex gap-2">
          <button type="button" onClick={onClose} className="btn-secondary flex-1">Cancel</button>
          <button type="submit" disabled={isSaving || !name.trim() || needsPassword} className="btn-primary flex-1">
            {isSaving && <Spinner className="h-4 w-4" />} Save
          </button>
        </div>
      </form>
    </Modal>
  );
}
