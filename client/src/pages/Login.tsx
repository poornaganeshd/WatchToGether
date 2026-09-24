import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import api, { getErrorMessage } from "../lib/api";
import { useAuthStore } from "../store/useAuthStore";
import AuthLayout from "../components/AuthLayout";
import PasswordInput from "../components/PasswordInput";
import Spinner from "../components/ui/Spinner";
import { EMAIL_REGEX } from "../lib/validation";


export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const setAuth = useAuthStore((state) => state.setAuth);
  const location = useLocation();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!email.trim()) return setError("Email is required");
    if (!EMAIL_REGEX.test(email.trim())) return setError("Invalid email format");
    if (!password) return setError("Password is required");

    setIsLoading(true);
    try {
      const res = await api.post("/auth/login", { email: email.trim(), password });
      // The GuestOnly route guard redirects to the original destination once auth is set.
      setAuth(res.data.user, res.data.token);
    } catch (err: unknown) {
      setError(getErrorMessage(err, "Unable to sign in. Please try again."));
      setIsLoading(false);
    }
  };

  return (
    <AuthLayout
      title="Welcome back"
      subtitle="Sign in to jump back into your watch parties."
      footer={
        <>
          New here?{" "}
          <Link to="/signup" state={location.state} className="font-medium text-indigo-300 hover:text-indigo-200">
            Create an account
          </Link>
        </>
      }
    >
      {error && (
        <div className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-sm text-red-300" role="alert">
          {error}
        </div>
      )}
      <form className="space-y-4" onSubmit={handleLogin} noValidate>
        <div>
          <label className="label" htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="input"
            placeholder="you@example.com"
          />
        </div>
        <div>
          <div className="flex items-center justify-between">
            <label className="label" htmlFor="password">Password</label>
            <Link to="/forgot-password" className="mb-1.5 text-xs font-medium text-indigo-300 hover:text-indigo-200">Forgot password?</Link>
          </div>
          <PasswordInput
            id="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
          />
        </div>
        <button type="submit" disabled={isLoading} className="btn-primary w-full py-3">
          {isLoading ? <><Spinner className="h-4 w-4" /> Signing in…</> : "Sign in"}
        </button>
      </form>
    </AuthLayout>
  );
}
