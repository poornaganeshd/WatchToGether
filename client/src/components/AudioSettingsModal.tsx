import { useAudioStore } from '../store/useAudioStore';
import type { DuckingSpeed, AudioMode } from '../store/useAudioStore';
import { Volume2, Settings2 } from 'lucide-react';
import Modal from './ui/Modal';

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

export default function AudioSettingsModal({ isOpen, onClose }: Props) {
  const { settings, updateSettings } = useAudioStore();

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <Settings2 size={18} className="text-indigo-300" />
          Audio settings
        </span>
      }
    >
        <div className="p-6 space-y-6 max-h-[80vh] overflow-y-auto">
          {/* Latency compensation */}
          <div className="space-y-3 rounded-xl border border-white/10 bg-white/[0.02] p-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-semibold text-slate-200">Audio delay compensation</h3>
                <p className="text-sm text-slate-400">Using Bluetooth headphones? Shift the video so what you hear matches everyone else.</p>
              </div>
              <span className="shrink-0 font-mono text-sm text-indigo-300">
                {settings.syncOffsetMs > 0 ? "+" : ""}{settings.syncOffsetMs} ms
              </span>
            </div>
            <input
              type="range"
              min={-500}
              max={1000}
              step={25}
              value={settings.syncOffsetMs}
              onChange={(e) => updateSettings({ syncOffsetMs: Number(e.target.value) })}
              className="w-full accent-indigo-500"
              aria-label="Audio delay compensation in milliseconds"
            />
            <div className="flex justify-between text-xs text-slate-500">
              <span>Play later</span>
              <button type="button" onClick={() => updateSettings({ syncOffsetMs: 0 })} className="text-indigo-300 hover:text-indigo-200">
                Reset
              </button>
              <span>Play earlier</span>
            </div>
          </div>

          {/* Global Toggle */}
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-semibold text-slate-200">Smart Volume Lowering</h3>
              <p className="text-sm text-slate-400">Automatically lower movie volume when people speak</p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input type="checkbox" className="sr-only peer" checked={settings.isEnabled} onChange={(e) => updateSettings({ isEnabled: e.target.checked })} />
              <div className="w-11 h-6 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600"></div>
            </label>
          </div>

          {settings.isEnabled && (
            <>
              {/* Audio Modes */}
              <div className="space-y-3">
                <h3 className="font-semibold text-slate-200">Audio Profile</h3>
                <div className="grid grid-cols-2 gap-2">
                  {(['cinema', 'balanced', 'conversation', 'custom'] as AudioMode[]).map((mode) => (
                    <button
                      key={mode}
                      onClick={() => updateSettings({ audioMode: mode })}
                      className={`p-2 rounded-lg border text-sm capitalize font-medium transition-all ${settings.audioMode === mode ? 'bg-indigo-600/20 border-indigo-500 text-indigo-300' : 'bg-white/[0.03] border-white/10 text-slate-400 hover:bg-white/[0.07]'}`}
                    >
                      {mode}
                    </button>
                  ))}
                </div>
              </div>

              {/* Ducking Level */}
              <div className="space-y-3">
                <div className="flex justify-between">
                  <h3 className="font-semibold text-slate-200">Volume Reduction Amount</h3>
                  <span className="text-indigo-400 font-mono text-sm">{Math.round(settings.duckingLevel * 100)}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={settings.duckingLevel}
                  onChange={(e) => updateSettings({ duckingLevel: parseFloat(e.target.value) })}
                  className="w-full h-2 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                  disabled={settings.audioMode !== 'custom'}
                />
                <div className="flex justify-between text-xs text-slate-500">
                  <span>Subtle</span>
                  <span>Strong</span>
                </div>
              </div>

              {/* Speeds */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <h3 className="text-sm font-semibold text-slate-200">Lowering Speed</h3>
                  <select 
                    value={settings.duckingSpeed} 
                    onChange={(e) => updateSettings({ duckingSpeed: e.target.value as DuckingSpeed })}
                    disabled={settings.audioMode !== 'custom'}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2 text-sm text-slate-300 focus:border-indigo-500 focus:outline-none"
                  >
                    <option value="slow">Slow</option>
                    <option value="normal">Normal</option>
                    <option value="fast">Fast</option>
                  </select>
                </div>
                <div className="space-y-2">
                  <h3 className="text-sm font-semibold text-slate-200">Recovery Speed</h3>
                  <select 
                    value={settings.recoverySpeed} 
                    onChange={(e) => updateSettings({ recoverySpeed: e.target.value as DuckingSpeed })}
                    disabled={settings.audioMode !== 'custom'}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2 text-sm text-slate-300 focus:border-indigo-500 focus:outline-none"
                  >
                    <option value="slow">Slow</option>
                    <option value="normal">Normal</option>
                    <option value="fast">Fast</option>
                  </select>
                </div>
              </div>

              {/* Custom Base Volumes */}
              {settings.audioMode === 'custom' && (
                <div className="p-4 bg-slate-950 border border-slate-800 rounded-xl space-y-4">
                  <div className="space-y-2">
                    <div className="flex justify-between">
                      <h4 className="text-sm font-medium text-slate-300 flex items-center gap-2"><Volume2 size={14}/> Movie Base Volume</h4>
                      <span className="text-xs text-slate-500">{Math.round(settings.customMovieVolume * 100)}%</span>
                    </div>
                    <input type="range" min="0" max="1" step="0.05" value={settings.customMovieVolume} onChange={(e) => updateSettings({ customMovieVolume: parseFloat(e.target.value) })} className="w-full h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-indigo-500" />
                  </div>
                </div>
              )}
            </>
          )}
        </div>
    </Modal>
  );
}
