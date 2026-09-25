import { useState } from "react";
import { Download, Share, SquarePlus, X } from "lucide-react";
import { promptInstall, useInstallMode } from "../lib/install";
import { toast } from "../store/useToastStore";

const DISMISS_KEY = "wt_install_dismissed";

const readDismissed = () => {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
};

const install = async () => {
  if (await promptInstall()) toast.success("Installed. Open WatchTogether from your home screen.");
};

const IosSteps = () => (
  <ol className="mt-2 space-y-1 text-xs text-slate-300">
    <li className="flex items-center gap-1.5">1. Tap <Share size={13} className="text-sky-300" /> <b>Share</b> in Safari's toolbar</li>
    <li className="flex items-center gap-1.5">2. Choose <SquarePlus size={13} className="text-sky-300" /> <b>Add to Home Screen</b></li>
  </ol>
);

/** Dashboard card suggesting the home-screen app (hidden once installed or dismissed). */
export function InstallAppCard() {
  const mode = useInstallMode();
  const [dismissed, setDismissed] = useState(readDismissed);
  if (dismissed || (mode !== "prompt" && mode !== "ios")) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* private mode */
    }
  };

  return (
    <section className="card mb-8 flex items-start gap-4 p-4 animate-fade-up">
      <img src="/icon-192.png" alt="" className="h-12 w-12 shrink-0 rounded-xl" />
      <div className="min-w-0 flex-1">
        <h2 className="font-display text-sm font-semibold">Get the app</h2>
        <p className="text-xs text-slate-400">Add WatchTogether to your home screen. It opens full screen, without the browser bars.</p>
        {mode === "ios" ? (
          <IosSteps />
        ) : (
          <button onClick={install} className="btn-primary mt-3 px-3 py-1.5 text-xs">
            <Download size={14} /> Install app
          </button>
        )}
      </div>
      <button onClick={dismiss} className="btn-ghost p-1.5" aria-label="Don't show again">
        <X size={16} />
      </button>
    </section>
  );
}

/** Settings row: install, how to install on iPhone, or "installed". */
export function InstallAppSetting() {
  const mode = useInstallMode();
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <p className="text-sm font-medium text-white">Home screen app</p>
        <p className="text-xs text-slate-400">
          {mode === "installed"
            ? "You're using the installed app."
            : mode === "unavailable"
              ? "Open this site in Chrome, Edge or Safari (iPhone) to install it."
              : "Opens full screen, without the browser bars."}
        </p>
        {mode === "ios" && <IosSteps />}
      </div>
      {mode === "prompt" && (
        <button onClick={install} className="btn-primary shrink-0 px-3 py-1.5 text-xs">
          <Download size={14} /> Install
        </button>
      )}
    </div>
  );
}
