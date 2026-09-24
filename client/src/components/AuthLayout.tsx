import type { ReactNode } from "react";
import Logo from "./ui/Logo";

export default function AuthLayout({ title, subtitle, children, footer }: { title: string; subtitle: string; children: ReactNode; footer: ReactNode }) {
  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center px-4 py-10">
      <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        <div className="absolute -top-32 left-1/2 h-[420px] w-[720px] -translate-x-1/2 rounded-full bg-indigo-600/20 blur-[120px]" />
      </div>
      <div className="mb-8">
        <Logo />
      </div>
      <div className="card w-full max-w-md p-8 animate-fade-up">
        <h1 className="font-display text-2xl font-bold text-white">{title}</h1>
        <p className="mt-1 text-sm text-slate-400">{subtitle}</p>
        <div className="mt-6">{children}</div>
      </div>
      <p className="mt-6 text-sm text-slate-400">{footer}</p>
    </div>
  );
}
