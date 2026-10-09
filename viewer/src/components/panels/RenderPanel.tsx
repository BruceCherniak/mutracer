import { useEffect, useState } from 'react';
import { Aperture, Bug, Palette, Sparkles, Sun } from 'lucide-react';
import type { RendererDiagnostics } from 'claypt';
import { setSettings, useViewer, type Settings } from '../../store';
import { getEngine } from '../../engine/ViewerEngine';
import { Field, Hint, Scrub, Section, Segmented, Select, Switch } from '../ui/controls';

const WEBGPU_ONLY = 'Requires WebGPU';

export function RenderPanel() {
  const s = useViewer((state) => state.settings);
  const backend = useViewer((state) => state.backend.name);
  const webgl = backend === 'WebGL 2';
  const [open, setOpen] = useState({ effects: false, debug: false });
  const update = (patch: Partial<Settings>) => setSettings(patch);

  return (
    <>
      <Section title="Quality" icon={<Aperture size={14} />}>
        <Scrub label="Max samples" value={s.maxSamples} min={4} max={16384} log onChange={(v) => update({ maxSamples: v })} />
        <Scrub label="Bounces" value={s.bounces} min={1} max={16} step={1} onChange={(v) => update({ bounces: v })} />
        <Field label="Resolution">
          <Segmented
            label="Resolution"
            value={String(s.resolutionScale)}
            options={[{ value: '0.25', label: '25%' }, { value: '0.5', label: '50%' }, { value: '0.75', label: '75%' }, { value: '1', label: '100%' }]}
            onChange={(v) => update({ resolutionScale: Number(v) })}
          />
        </Field>
        <Field label="Sampling">
          <Select
            label="Sampling pattern"
            value={s.samplingPattern}
            options={[
              { value: 'sobol', label: 'Sobol', hint: 'Default' },
              { value: 'zsobol', label: 'Z-Sobol', hint: 'Low spp, no denoiser' },
              { value: 'random', label: 'Random' }
            ]}
            onChange={(v) => update({ samplingPattern: v })}
          />
        </Field>
        <Scrub label="Clamping" value={s.clamping} min={0} max={100} step={1} format={(v) => (v === 0 ? 'Off' : String(v))} onChange={(v) => update({ clamping: v })} />
      </Section>

      <Section
        title="Denoiser"
        icon={<Sparkles size={14} />}
        value={webgl ? 'WebGPU only' : undefined}
        actions={<Switch label="Denoiser" checked={s.denoise && !webgl} disabled={webgl} onChange={(v) => update({ denoise: v })} />}
      >
        {webgl ? (
          <Hint warn>Intel Open Image Denoise needs WebGPU. This browser is using WebGL 2.</Hint>
        ) : s.denoise ? (
          <Segmented
            label="Denoiser model"
            value={s.denoiseModel}
            options={[{ value: 'standard', label: 'Standard' }, { value: 'small', label: 'Small' }, { value: 'cleanAuxLarge', label: 'Clean aux' }]}
            onChange={(v) => update({ denoiseModel: v })}
          />
        ) : null}
      </Section>

      <Section title="Color" icon={<Palette size={14} />}>
        <Select
          label="Tone mapping"
          prefix="Tone mapping"
          value={s.toneMapping}
          options={[
            { value: 'agx', label: 'AgX' },
            { value: 'neutral', label: 'Neutral', disabled: webgl, hint: webgl ? WEBGPU_ONLY : 'Tony McMapface' },
            { value: 'aces', label: 'ACES' },
            { value: 'cineon', label: 'Cineon' },
            { value: 'reinhard', label: 'Reinhard' },
            { value: 'linear', label: 'Linear' }
          ]}
          onChange={(v) => update({ toneMapping: v })}
        />
        <Scrub label="Exposure" value={s.exposure} min={0} max={4} onChange={(v) => update({ exposure: v })} />
        <div className="grid2">
          <Scrub label="Contrast" value={s.contrast} min={0.5} max={1.5} onChange={(v) => update({ contrast: v })} />
          <Scrub label="Saturation" value={s.saturation} min={0} max={2} onChange={(v) => update({ saturation: v })} />
          <Scrub label="Temp" title="Temperature" value={s.temperature} min={-1} max={1} onChange={(v) => update({ temperature: v })} />
          <Scrub label="Tint" value={s.tint} min={-1} max={1} onChange={(v) => update({ tint: v })} />
        </div>
        <Switch label="Auto exposure" checked={s.autoExposure && !webgl} disabled={webgl} onChange={(v) => update({ autoExposure: v })}>
          <span className="field-label">Auto exposure{webgl && <small> · {WEBGPU_ONLY}</small>}</span>
        </Switch>
      </Section>

      <Section
        title="Effects"
        icon={<Sun size={14} />}
        value={s.bloomIntensity > 0 ? 'bloom' : s.vignette > 0 ? 'vignette' : 'off'}
        open={open.effects}
        onOpenChange={(v) => setOpen((o) => ({ ...o, effects: v }))}
      >
        <Scrub label="Bloom" value={s.bloomIntensity} min={0} max={1} onChange={(v) => update({ bloomIntensity: v })} />
        {s.bloomIntensity > 0 && (
          <div className="grid2">
            <Scrub label="Threshold" value={s.bloomThreshold} min={0} max={4} onChange={(v) => update({ bloomThreshold: v })} />
            <Scrub label="Radius" value={s.bloomRadius} min={0} max={1} onChange={(v) => update({ bloomRadius: v })} />
          </div>
        )}
        <Scrub label="Vignette" value={s.vignette} min={0} max={1} onChange={(v) => update({ vignette: v })} />
      </Section>

      <Section title="Debug" icon={<Bug size={14} />} open={open.debug} onOpenChange={(v) => setOpen((o) => ({ ...o, debug: v }))}>
        <Field label="Output">
          <Select
            label="Output"
            value={s.output}
            options={[
              { value: 'final', label: 'Final' }, { value: 'albedo', label: 'Albedo' },
              { value: 'normal', label: 'Normal' }, { value: 'shadow', label: 'Shadow' }
            ]}
            onChange={(v) => update({ output: v })}
          />
        </Field>
        <Switch label="Interactive preview" checked={s.interactivePreview} onChange={(v) => update({ interactivePreview: v })}>
          <span className="field-label">Interactive preview</span>
        </Switch>
        {s.interactivePreview && (
          <Scrub label="Max preview scale" title="Preview resolution adapts to render time, up to this scale" value={s.previewResolutionScale} min={0.25} max={1} onChange={(v) => update({ previewResolutionScale: v })} />
        )}
        {s.denoise && s.denoiseWhileConverging && <Hint>Denoise while converging always previews while interacting, using the small network at a resolution it can keep up with.</Hint>}
        {open.debug && <Diagnostics />}
      </Section>
    </>
  );
}

function Diagnostics() {
  const [diagnostics, setDiagnostics] = useState<RendererDiagnostics | undefined>();
  useEffect(() => {
    const read = () => setDiagnostics(getEngine()?.renderer.getDiagnostics());
    read();
    const timer = setInterval(read, 1000);
    return () => clearInterval(timer);
  }, []);
  if (!diagnostics) return null;
  const shader = diagnostics.shaderCompilation;
  const rows: [string, string][] = [
    ['Backend', `${diagnostics.backend === 'webgpu' ? 'WebGPU' : 'WebGL 2'} · ${diagnostics.adapterName || 'unknown'}`],
    ['Drawing buffer', `${diagnostics.width} × ${diagnostics.height}`],
    ['Shader compile', shader ? `${Math.round(shader.totalTimeMs ?? 0)} ms · ${shader.sourceLines ?? '?'} lines` : '–'],
    ['Trace time', diagnostics.gpuTraceTiming ? `${diagnostics.gpuTraceTiming.estimatedFullFrameTimeMs?.toFixed(1)} ms / frame` : '–'],
    ['Texture atlas', diagnostics.textureAtlas ? `${diagnostics.textureAtlas.textureCount} textures · ${(diagnostics.textureAtlas.estimatedBytes / 2 ** 20).toFixed(1)} MiB` : '–'],
    ['Emissive triangles', String(diagnostics.lightSampling?.emissiveTriangles ?? 0)]
  ];
  return (
    <dl className="diagnostics">
      {rows.map(([k, v]) => (<div key={k}><dt>{k}</dt><dd className="mono">{v}</dd></div>))}
    </dl>
  );
}
