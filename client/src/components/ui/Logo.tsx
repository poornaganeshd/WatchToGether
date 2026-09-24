import { Link } from "react-router-dom";

export default function Logo({ to = "/", size = "md" }: { to?: string; size?: "sm" | "md" | "lg" }) {
  const box = size === "lg" ? "h-11 w-11" : size === "sm" ? "h-8 w-8" : "h-9 w-9";
  const text = size === "lg" ? "text-2xl" : size === "sm" ? "text-base" : "text-lg";
  return (
    <Link to={to} className="inline-flex items-center gap-2.5 font-display font-bold tracking-tight">
      <span className={`${box} relative grid place-items-center rounded-xl bg-gradient-to-br from-indigo-500 via-violet-500 to-fuchsia-500 shadow-glow`}>
        <svg viewBox="0 0 24 24" className="h-1/2 w-1/2 fill-white" aria-hidden="true">
          <path d="M8 5.5v13a1 1 0 0 0 1.53.85l10.4-6.5a1 1 0 0 0 0-1.7L9.53 4.65A1 1 0 0 0 8 5.5Z" />
        </svg>
      </span>
      <span className={text}>
        Watch<span className="text-gradient">Together</span>
      </span>
    </Link>
  );
}
