import { useState } from "react";
import { Lock } from "lucide-react";
import Modal from "./ui/Modal";
import PasswordInput from "./PasswordInput";

interface PasswordPromptProps {
  isOpen: boolean;
  roomName?: string | null;
  error?: string | null;
  onSubmit: (password: string) => void;
  onCancel: () => void;
}

export default function PasswordPrompt({ isOpen, roomName, error, onSubmit, onCancel }: PasswordPromptProps) {
  const [password, setPassword] = useState("");

  return (
    <Modal isOpen={isOpen} onClose={onCancel} title={<span className="flex items-center gap-2"><Lock size={18} className="text-indigo-300" /> Private room</span>}>
      <form
        className="space-y-4 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (password) onSubmit(password);
        }}
      >
        <p className="text-sm text-slate-400">
          {roomName ? <><span className="font-medium text-slate-200">{roomName}</span> is password protected.</> : "This room is password protected."} Ask the host for the password.
        </p>
        {error && <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300" role="alert">{error}</p>}
        <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Room password" autoFocus />
        <div className="flex gap-2">
          <button type="button" onClick={onCancel} className="btn-secondary flex-1">Leave</button>
          <button type="submit" disabled={!password} className="btn-primary flex-1">Enter room</button>
        </div>
      </form>
    </Modal>
  );
}
