import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import api, { getErrorMessage } from "../lib/api";
import AuthLayout from "../components/AuthLayout";
import PasswordInput from "../components/PasswordInput";
import Spinner from "../components/ui/Spinner";
import { toast } from "../store/useToastStore";
import { useAuthStore } from "../store/useAuthStore";

export default function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (password.length < 6) return setError("Password must be at least 6 characters");
    if (password !== confirm) return setError("Passwords don't match");
    setIsLoading(true);
    try {
      await api.post("/auth/reset-password", { token, password });
      // Any session on this device was signed out by the reset.
      useAuthStore.getState().logout();
      toast.success("Password updated. Sign in with your new password.");
      navigate("/login", { replace: true });
    } catch (err) {
      setError(getErrorMessage(err, "Couldn't reset your password."));
      setIsLoading(false);
    }
  };

  return (
    <AuthLayout
      title="Choose a new password"
      subtitle="Pick something you haven't used here before."
      footer={<Link to="/forgot-password" className="font-medium text-indigo-300 hover:text-indigo-200">Need a new link?</Link>}
    >
      {!token ? (
        <p className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          This reset link is missing its token. Request a new one.
        </p>
      ) : (
        <form className="space-y-4" onSubmit={handleSubmit} noValidate>
          {error && (
            <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-sm text-red-300" role="alert">{error}</div>
          )}
          <div>
            <label className="label" htmlFor="password">New password</label>
            <PasswordInput id="password" autoComplete="new-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 6 characters" />
          </div>
          <div>
            <label className="label" htmlFor="confirm">Confirm password</label>
            <PasswordInput id="confirm" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Type it again" />
          </div>
          <button type="submit" disabled={isLoading} className="btn-primary w-full py-3">
            {isLoading ? <><Spinner className="h-4 w-4" /> Saving…</> : "Reset password"}
          </button>
        </form>
      )}
    </AuthLayout>
  );
}
