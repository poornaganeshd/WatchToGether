import { useState } from "react";
import { Link } from "react-router-dom";
import { MailCheck } from "lucide-react";
import api, { getErrorMessage } from "../lib/api";
import AuthLayout from "../components/AuthLayout";
import Spinner from "../components/ui/Spinner";
import { EMAIL_REGEX } from "../lib/validation";

export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!EMAIL_REGEX.test(email.trim())) return setError("Enter a valid email address");
    setIsLoading(true);
    try {
      await api.post("/auth/forgot-password", { email: email.trim() });
      setSent(true);
    } catch (err) {
      setError(getErrorMessage(err, "Couldn't send the reset link. Please try again."));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <AuthLayout
      title="Forgot your password?"
      subtitle="We'll email you a link to choose a new one."
      footer={<Link to="/login" className="font-medium text-indigo-300 hover:text-indigo-200">Back to sign in</Link>}
    >
      {sent ? (
        <div className="flex flex-col items-center gap-3 py-4 text-center animate-fade-up">
          <div className="grid h-14 w-14 place-items-center rounded-2xl bg-emerald-500/15 text-emerald-300">
            <MailCheck size={26} />
          </div>
          <p className="text-sm text-slate-300">
            If <span className="font-medium text-white">{email.trim()}</span> has an account, a reset link is on its way. It expires in an hour.
          </p>
          <p className="text-xs text-slate-500">Don't see it? Check your spam folder.</p>
        </div>
      ) : (
        <form className="space-y-4" onSubmit={handleSubmit} noValidate>
          {error && (
            <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-sm text-red-300" role="alert">{error}</div>
          )}
          <div>
            <label className="label" htmlFor="email">Email</label>
            <input id="email" type="email" autoComplete="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} className="input" placeholder="you@example.com" />
          </div>
          <button type="submit" disabled={isLoading} className="btn-primary w-full py-3">
            {isLoading ? <><Spinner className="h-4 w-4" /> Sending…</> : "Send reset link"}
          </button>
        </form>
      )}
    </AuthLayout>
  );
}
