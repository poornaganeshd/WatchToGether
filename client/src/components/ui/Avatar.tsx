import { useState } from "react";
import { API_BASE } from "../../lib/api";
import { useAvatarStore } from "../../store/useAvatarStore";

const GRADIENTS = [
  "from-indigo-500 to-violet-500",
  "from-fuchsia-500 to-pink-500",
  "from-cyan-500 to-blue-500",
  "from-emerald-500 to-teal-500",
  "from-amber-500 to-orange-500",
  "from-rose-500 to-red-500",
];

const hash = (value: string) => {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) | 0;
  return Math.abs(h);
};

const initials = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("") || "?";

interface AvatarProps {
  name: string;
  /** The user's id: picks the fallback colour and locates the uploaded picture. */
  seed?: string;
  size?: number;
  /** Avatar version from the API; falls back to the shared avatar store. */
  version?: number | null;
  /** Show a presence dot. */
  online?: boolean;
}

export default function Avatar({ name, seed, size = 36, version, online }: AvatarProps) {
  const known = useAvatarStore((s) => (seed ? s.versions[seed] : undefined));
  const effectiveVersion = version !== undefined ? version : known;
  const src = seed && typeof effectiveVersion === "number" ? `${API_BASE}/users/${seed}/avatar?v=${effectiveVersion}` : null;
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const gradient = GRADIENTS[hash(seed || name) % GRADIENTS.length];

  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }} aria-hidden="true">
      {src && failedSrc !== src ? (
        <img
          src={src}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          onError={() => setFailedSrc(src)}
          className="h-full w-full rounded-full object-cover ring-2 ring-black/20"
        />
      ) : (
        <span
          className={`grid h-full w-full place-items-center rounded-full bg-gradient-to-br ${gradient} font-semibold text-white ring-2 ring-black/20`}
          style={{ fontSize: Math.max(10, size * 0.38) }}
        >
          {initials(name)}
        </span>
      )}
      {online !== undefined && (
        <span
          className={`absolute bottom-0 right-0 rounded-full ring-2 ring-ink-900 ${online ? "bg-emerald-400" : "bg-slate-600"}`}
          style={{ width: Math.max(8, size * 0.28), height: Math.max(8, size * 0.28) }}
        />
      )}
    </span>
  );
}
