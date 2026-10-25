import { useEffect, useState } from 'react';
import { Aperture, Bug, Palette, RotateCcw, Sparkles, Sun } from 'lucide-react';
import type { OIDNModel, EngineDiagnostics } from '@meimu/mutracer';
import { VIEWER_AOVS, DEFAULT_SETTINGS, setSettings, useViewer, type Settings } from '../../store';
import { getEngine } from '../../engine/ViewerEngine';
import { Field, Hint, Scrub, Section, Segmented, Select, Switch } from '../ui/controls';


export function RenderPanel() {
  const s = useViewer((state) => state.settings);
  const backend = useViewer((state) => state.backend.name);
  const bvhBusy = useViewer((state) => state.stats.phase === 'preparing' || state.loading !== null || state.export !== null);
  const webgl = backend === 'WebGL 2';
  const jnlm = webgl || s.denoiseModel === 'jnlm';
  const [open, setOpen] = useState({ effects: false, debug: false, jnlm: false });
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
        <Field label="BVH builder">
          <Segmented
            label="BVH builder"
            value={s.bvhBuilder}
            options={[{ value: 'tinybvh', label: 'tinybvh' }, { value: 'builtin', label: 'builtin' }]}
            disabled={bvhBusy}
            onChange={(v) => update({ bvhBuilder: v })}
          />
        </Field>
        <Scrub label="Clamping" value={s.clamping} min={0} max={100} step={1} format={(v) => (v === 0 ? 'Off' : String(v))} onChange={(v) => update({ clamping: v })} />
      </Section>

      <Section
        title="Denoiser"
        icon={<Sparkles size={14} />}
        actions={<>
          {s.denoise && <button className="icon-btn sm" title="Reset selected denoiser parameters" aria-label={`Reset ${jnlm ? 'JNLM' : 'OIDN'} settings`} onClick={() => update(jnlm ? {
            jnlmStrength: DEFAULT_SETTINGS.jnlmStrength,
            jnlmSearchRadius: DEFAULT_SETTINGS.jnlmSearchRadius,
            jnlmPatchRadius: DEFAULT_SETTINGS.jnlmPatchRadius,
            jnlmAlbedoBandwidth: DEFAULT_SETTINGS.jnlmAlbedoBandwidth,
            jnlmNormalBandwidth: DEFAULT_SETTINGS.jnlmNormalBandwidth,
            jnlmIterations: DEFAULT_SETTINGS.jnlmIterations
          } : { denoiseModel: 'standard', oidnModel: 'standard', oidnMaxTileSize: 0 })}>
            <RotateCcw size={12} />
          </button>}
          <Switch label="Denoiser" checked={s.denoise} onChange={(v) => update({ denoise: v })} />
        </>}
      >
        {s.denoise && <>
          <Segmented
            label="Denoiser type"
            value={jnlm ? 'jnlm' : 'oidn'}
            options={[{ value: 'jnlm', label: 'JNLM' }, { value: 'oidn', label: 'OIDN', disabled: webgl }]}
            onChange={(v) => update({ denoiseModel: v === 'jnlm' ? 'jnlm' : s.oidnModel })}
          />
          {webgl && <Hint>OIDN requires WebGPU.</Hint>}
          {jnlm && <Scrub label="Strength" title="Higher values remove more lighting noise" value={s.jnlmStrength} min={0.1} max={3} step={0.1} onChange={(v) => update({ jnlmStrength: v })} />}
          {jnlm ? <Section
            title="More parameters"
            open={open.jnlm}
            onOpenChange={(v) => setOpen((o) => ({ ...o, jnlm: v }))}
          >
            <Scrub label="Search radius" title="Search a larger neighborhood for similar pixels; higher values cost more" value={s.jnlmSearchRadius} min={1} max={16} step={1} unit="px" onChange={(v) => update({ jnlmSearchRadius: v })} />
            <Scrub label="Patch radius" title="Radius of the color comparison patch; smaller patches preserve small details" value={s.jnlmPatchRadius} min={0} max={3} step={1} unit="px" onChange={(v) => update({ jnlmPatchRadius: v })} />
            <Scrub label="Albedo tolerance" title="Lower values protect texture more; higher values smooth more" value={s.jnlmAlbedoBandwidth} min={0.01} max={1} step={0.01} onChange={(v) => update({ jnlmAlbedoBandwidth: v })} />
            <Scrub label="Normal tolerance" title="Lower values protect geometric detail; higher values smooth across surface changes" value={s.jnlmNormalBandwidth} min={0.005} max={0.5} step={0.005} onChange={(v) => update({ jnlmNormalBandwidth: v })} />
            <Scrub label="Filter passes" title="More passes remove broader noise patches; may soften detail" value={s.jnlmIterations} min={1} max={4} step={1} onChange={(v) => update({ jnlmIterations: v })} />
          </Section> : <>
            <Select<OIDNModel>
              label="OIDN model"
              prefix="Model"
              value={s.oidnModel}
              options={[
                { value: 'standard', label: 'Standard', hint: 'Balanced' },
                { value: 'small', label: 'Small', hint: 'Faster' },
                { value: 'cleanAuxLarge', label: 'Large', hint: 'Prefilters albedo and normals' }
              ]}
              onChange={(v) => update({ denoiseModel: v, oidnModel: v })}
            />
            <Select
              label="OIDN tile size"
              prefix="Max tile"
              value={String(s.oidnMaxTileSize)}
              options={[{ value: '0', label: 'Auto' }, ...[256, 512, 1024, 2048].map((v) => ({ value: String(v), label: `${v} px` }))]}
              onChange={(v) => update({ oidnMaxTileSize: Number(v) })}
            />
          </>}
        </>}
      </Section>

      <Section title="Color" icon={<Palette size={14} />}>
        <Switch label="HDR output" checked={!webgl && s.hdrOutputEnabled} disabled={backend !== 'WebGPU'} onChange={(v) => update({ hdrOutputEnabled: v })}>
          <span className="field-label">HDR output</span>
        </Switch>
        <Hint>{webgl ? 'HDR output requires WebGPU.' : 'Requires an HDR display and a compatible browser; falls back to SDR when unsupported.'}</Hint>
        <Select
          label="Tone mapping"
          prefix="Tone mapping"
          value={s.toneMapping}
          disabled={!webgl && s.hdrOutputEnabled}
          options={[
            { value: 'agx', label: 'AgX' },
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
        <Switch label="AOV channels" checked={s.aovsEnabled} onChange={(v) => update({ aovsEnabled: v, ...(!v && VIEWER_AOVS.includes(s.output as typeof VIEWER_AOVS[number]) ? {output: 'final' as const} : {}) })}>
          <span className="field-label">AOV channels</span>
        </Switch>
        {s.aovsEnabled && <Hint>Adds surface tracing and GPU memory.</Hint>}
        <Field label="Output">
          <Select
            label="Output"
            value={s.output}
            options={[
              { value: 'final', label: 'Final' }, { value: 'albedo', label: 'Albedo' },
              { value: 'normal', label: 'Normal' }, { value: 'shadow', label: 'Shadow' },
              ...(s.aovsEnabled ? VIEWER_AOVS.map(value => ({value, label: ({depth: 'Depth', position: 'Position', roughness: 'Roughness', diffuseAlbedo: 'Diffuse reflectance', specularAlbedo: 'Specular reflectance', id: 'ID', motion: 'Motion'})[value]})) : [])
            ]}
            onChange={(v) => update({ output: v })}
          />
        </Field>
        {s.aovsEnabled && s.output === 'depth' && <Scrub label="Depth range" value={s.aovDepthFar} min={0.01} max={10000} log onChange={(v) => update({aovDepthFar: v})} />}
        {s.aovsEnabled && s.output === 'position' && <Scrub label="Position scale" value={s.aovPositionScale} min={0.001} max={10000} log onChange={(v) => update({aovPositionScale: v})} />}
        {s.aovsEnabled && s.output === 'motion' && <Scrub label="Motion scale" value={s.aovMotionScale} min={0.01} max={1000} log onChange={(v) => update({aovMotionScale: v})} />}
        {s.aovsEnabled && s.output === 'id' && <Field label="ID component"><Select label="ID component" value={s.aovIdComponent} options={(['object', 'instance', 'material', 'primitive'] as const).map(value => ({value, label: value}))} onChange={(v) => update({aovIdComponent: v})} /></Field>}
        <Switch label="Interactive preview" checked={s.previewEnabled} onChange={(v) => update({ previewEnabled: v })}>
          <span className="field-label">Interactive preview</span>
        </Switch>
        {s.previewEnabled && (
          <Scrub label="Max preview scale" title="Preview scale relative to the full viewport, independent of final resolution" value={s.previewMaxResolutionScale} min={0.25} max={1} onChange={(v) => update({ previewMaxResolutionScale: v })} />
        )}
        {s.denoise && s.denoiseWhileConverging && <Hint>Live denoise also runs while interacting{jnlm ? '.' : ', using the small preview model.'}</Hint>}
        {open.debug && <Diagnostics />}
      </Section>
    </>
  );
}

function Diagnostics() {
  const [diagnostics, setDiagnostics] = useState<EngineDiagnostics | undefined>();
  useEffect(() => {
    const read = () => setDiagnostics(getEngine()?.engine.getDiagnostics());
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
