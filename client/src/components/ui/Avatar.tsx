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

export default function Avatar({ name, seed, size = 36 }: { name: string; seed?: string; size?: number }) {
  const gradient = GRADIENTS[hash(seed || name) % GRADIENTS.length];
  return (
    <span
      className={`inline-grid shrink-0 place-items-center rounded-full bg-gradient-to-br ${gradient} font-semibold text-white ring-2 ring-black/20`}
      style={{ width: size, height: size, fontSize: Math.max(10, size * 0.38) }}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}
