import { Link } from "react-router-dom";
import Logo from "../components/ui/Logo";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 px-4 text-center">
      <Logo />
      <p className="font-display text-7xl font-extrabold text-gradient">404</p>
      <p className="max-w-sm text-slate-400">This page wandered off mid-movie. Let's get you back to the lobby.</p>
      <Link to="/" className="btn-primary">Back home</Link>
    </div>
  );
}
