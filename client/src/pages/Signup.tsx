import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import api, { getErrorMessage } from "../lib/api";
import { useAuthStore } from "../store/useAuthStore";
import AuthLayout from "../components/AuthLayout";
import PasswordInput from "../components/PasswordInput";
import Spinner from "../components/ui/Spinner";
import { EMAIL_REGEX } from "../lib/validation";

const strengthOf = (password: string) => {
  let score = 0;
  if (password.length >= 6) score++;
  if (password.length >= 10) score++;
  if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score++;
  if (/\d/.test(password) || /[^A-Za-z0-9]/.test(password)) score++;
  return score;
};

const STRENGTH_LABELS = ["Too short", "Weak", "Okay", "Good", "Strong"];
const STRENGTH_COLORS = ["bg-red-500", "bg-red-500", "bg-amber-500", "bg-lime-500", "bg-emerald-500"];

export default function Signup() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const setAuth = useAuthStore((state) => state.setAuth);
  const location = useLocation();
  const strength = strengthOf(password);

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!name.trim()) return setError("Name is required");
    if (!email.trim()) return setError("Email is required");
    if (!EMAIL_REGEX.test(email.trim())) return setError("Invalid email format");
    if (!password) return setError("Password is required");
    if (password.length < 6) return setError("Password must be at least 6 characters");

    setIsLoading(true);
    try {
      const res = await api.post("/auth/register", { name: name.trim(), email: email.trim(), password });
      setAuth(res.data.user, res.data.token);
    } catch (err: unknown) {
      setError(getErrorMessage(err, "Unable to create account. Please try again."));
      setIsLoading(false);
    }
  };

  return (
    <AuthLayout
      title="Create your account"
      subtitle="It takes ten seconds. The popcorn takes longer."
      footer={
        <>
          Already have an account?{" "}
          <Link to="/login" state={location.state} className="font-medium text-indigo-300 hover:text-indigo-200">
            Sign in
          </Link>
        </>
      }
    >
      {error && (
        <div className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-sm text-red-300" role="alert">
          {error}
        </div>
      )}
      <form className="space-y-4" onSubmit={handleSignup} noValidate>
        <div>
          <label className="label" htmlFor="name">Display name</label>
          <input id="name" type="text" autoComplete="name" autoFocus maxLength={100} value={name} onChange={(e) => setName(e.target.value)} className="input" placeholder="Jane Doe" />
        </div>
        <div>
          <label className="label" htmlFor="email">Email</label>
          <input id="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} className="input" placeholder="you@example.com" />
        </div>
        <div>
          <label className="label" htmlFor="password">Password</label>
          <PasswordInput id="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 6 characters" />
          {password && (
            <div className="mt-2 flex items-center gap-2">
              <div className="flex flex-1 gap-1">
                {[1, 2, 3, 4].map((i) => (
                  <div key={i} className={`h-1 flex-1 rounded-full ${i <= strength ? STRENGTH_COLORS[strength] : "bg-white/10"}`} />
                ))}
              </div>
              <span className="w-16 text-right text-[11px] text-slate-400">{STRENGTH_LABELS[password.length < 6 ? 0 : strength]}</span>
            </div>
          )}
        </div>
        <button type="submit" disabled={isLoading} className="btn-primary w-full py-3">
          {isLoading ? <><Spinner className="h-4 w-4" /> Creating account…</> : "Create account"}
        </button>
      </form>
    </AuthLayout>
  );
}
