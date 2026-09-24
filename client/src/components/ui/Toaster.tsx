import { CheckCircle2, AlertCircle, Info, X } from "lucide-react";
import { useToastStore } from "../../store/useToastStore";

const ICONS = {
  success: <CheckCircle2 size={18} className="text-emerald-400 shrink-0" />,
  error: <AlertCircle size={18} className="text-red-400 shrink-0" />,
  info: <Info size={18} className="text-indigo-300 shrink-0" />,
};

export default function Toaster() {
  const { toasts, dismiss } = useToastStore();

  return (
    <div
      className="pointer-events-none fixed bottom-4 left-1/2 z-[100000] flex w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 flex-col gap-2 sm:left-auto sm:right-4 sm:translate-x-0"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.variant === "error" ? "alert" : "status"}
          className="pointer-events-auto flex items-start gap-3 rounded-xl border border-white/10 bg-ink-850/95 px-4 py-3 text-sm text-slate-200 shadow-card backdrop-blur-xl animate-fade-up"
        >
          {ICONS[t.variant]}
          <div className="flex-1 leading-snug">
            {t.message}
            {t.action && (
              <button
                onClick={() => {
                  t.action?.onClick();
                  dismiss(t.id);
                }}
                className="mt-1.5 block font-semibold text-indigo-300 hover:text-indigo-200"
              >
                {t.action.label}
              </button>
            )}
          </div>
          <button onClick={() => dismiss(t.id)} className="text-slate-500 hover:text-slate-200" aria-label="Dismiss">
            <X size={16} />
          </button>
        </div>
      ))}
    </div>
  );
}
