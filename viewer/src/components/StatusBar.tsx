import { Check, Pause, Play } from 'lucide-react';
import { setSettings, useViewer, type RenderPhase } from '../store';
import { Select } from './ui/controls';

const LABELS: Record<RenderPhase, string> = {
  starting: 'Starting',
  preparing: 'Preparing',
  compiling: 'Compiling',
  rendering: 'Rendering',
  denoising: 'Denoising',
  finished: 'Done',
  paused: 'Paused',
  error: 'Error'
};

const SAMPLE_STEPS = [4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096];
const RESOLUTION_STEPS = [0.25, 0.5, 0.75, 1];

function formatTime(seconds: number) {
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  return `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;
}

/** Circular sample progress. Denoising and loading phases spin. */
function ProgressRing({ progress, phase }: { progress: number; phase: RenderPhase }) {
  const r = 10;
  const c = 2 * Math.PI * r;
  const spinning = phase === 'denoising' || phase === 'preparing' || phase === 'compiling' || phase === 'starting';
  return (
    <span className="ring" data-phase={phase} data-spinning={spinning || undefined}
      role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)} aria-label="Sample progress">
      <svg className="ring__svg" viewBox="0 0 26 26" aria-hidden>
        <circle className="ring__track" cx="13" cy="13" r={r} />
        <circle
          className="ring__arc" cx="13" cy="13" r={r}
          strokeDasharray={c}
          strokeDashoffset={spinning ? c * 0.72 : c * (1 - Math.min(1, progress))}
        />
      </svg>
      {phase === 'rendering' && <span className="ring__pct">{Math.floor(progress * 100)}</span>}
      {phase === 'finished' && <Check size={13} strokeWidth={3.25} />}
      {phase === 'paused' && <Pause size={11} strokeWidth={3} />}
    </span>
  );
}

/**
 * Bottom dock: progress and the render settings people change most.
 * Everything else lives in the Render tab. The status block has a fixed
 * width so the centred dock does not shift while numbers change.
 */
export function StatusBar() {
  const stats = useViewer((s) => s.stats);
  const settings = useViewer((s) => s.settings);
  const paused = useViewer((s) => s.paused);
  const playing = useViewer((s) => s.animation?.playing ?? false);
  const { phase, samples, elapsed, msPerSample, width, height } = stats;
  const { maxSamples, resolutionScale } = settings;
  const progress = Math.min(1, samples / maxSamples);
  const done = phase === 'finished' || phase === 'paused';
  const remaining = phase === 'rendering' && samples > 4 ? ((maxSamples - samples) * msPerSample) / 1000 : 0;
  const time = done ? formatTime(elapsed) : remaining > 0.5 ? `~${formatTime(remaining)}` : '';
  const sampleOptions = [...new Set([...SAMPLE_STEPS, maxSamples])].sort((a, b) => a - b);
  const resolutionOptions = [...new Set([...RESOLUTION_STEPS, resolutionScale])].sort((a, b) => a - b);
  // Render size at 100%, for the pixel hints in the resolution menu.
  const fullWidth = width / resolutionScale;
  const fullHeight = height / resolutionScale;
  const denoise = settings.denoise;

  return (
    <div className="float dock" role="status" data-phase={phase}>
      <ProgressRing progress={progress} phase={phase} />
      <div className="dock__status" title={done && msPerSample ? `${elapsed.toFixed(1)} s · ${msPerSample.toFixed(1)} ms per sample` : undefined}>
        <b>{playing && phase === 'rendering' ? 'Playing' : LABELS[phase]}</b>
        <span className="mono"><span className="dock__spp">{samples}</span> spp{time && <span className="dock__time"> · {time}</span>}</span>
      </div>
      {phase !== 'finished' && <button className="icon-btn icon-btn--bare dock__pause" aria-label={paused ? 'Resume rendering' : 'Pause rendering'}
        title={paused ? 'Resume (Space)' : 'Pause accumulation (Space)'} data-active={paused || undefined}
        onClick={() => useViewer.setState({ paused: !paused })}>
        {paused ? <Play size={14} /> : <Pause size={14} />}
      </button>}
      <span className="sep" />
      <Select
        label="Max samples"
        prefix="Samples"
        value={String(maxSamples)}
        options={sampleOptions.map((v) => ({ value: String(v), label: String(v) }))}
        onChange={(v) => setSettings({ maxSamples: Number(v) })}
      />
      <Select
        label="Render resolution"
        prefix="Res"
        value={String(resolutionScale)}
        options={resolutionOptions.map((v) => ({
          value: String(v),
          label: `${Math.round(v * 100)}%`,
          hint: width ? `${Math.round(fullWidth * v)}×${Math.round(fullHeight * v)}` : undefined
        }))}
        onChange={(v) => setSettings({ resolutionScale: Number(v) })}
      />
      <label
        className="dock__toggle"
        data-selected={denoise || undefined}
        title="Denoise (D)"
      >
        <input
          type="checkbox"
          checked={denoise}
          onChange={(e) => setSettings({ denoise: e.currentTarget.checked })}
        />
        <span className="dock__label">Denoise</span>
      </label>
      {denoise && <label
        className="dock__toggle"
        data-selected={settings.denoiseWhileConverging || undefined}
        title="Denoise while converging: previews and every few samples, not only the final image"
      >
        <input
          type="checkbox"
          aria-label="Live denoise"
          checked={settings.denoiseWhileConverging}
          onChange={(e) => setSettings({ denoiseWhileConverging: e.currentTarget.checked })}
        />
        <span className="dock__label">Live</span>
      </label>}
    </div>
  );
}
