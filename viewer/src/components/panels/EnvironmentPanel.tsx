import { Button, FileTrigger } from 'react-aria-components';
import { Globe, Image, Square, Upload } from 'lucide-react';
import { setSettings, useViewer } from '../../store';
import { ENVIRONMENT_PRESETS, ENV_RESOLUTIONS } from '../../engine/presets';
import { getEngine } from '../../engine/ViewerEngine';
import { toPathedFiles } from '../../engine/loadModel';
import { ColorField, Field, Hint, Scrub, Section, Segmented, Switch } from '../ui/controls';

const formatMB = (bytes: number) => (bytes / 1048576).toFixed(1);

const SKY_SWATCH = 'linear-gradient(180deg,#3c6fc4 0%,#b9c9dc 48%,#5a524b 52%,#2b2725 100%)';

export function EnvironmentPanel() {
  const s = useViewer((state) => state.settings);
  const envLoading = useViewer((state) => state.envLoading);
  const loadingFraction = envLoading?.total ? envLoading.loaded / envLoading.total : 0;
  const current = ENVIRONMENT_PRESETS.find((p) => p.id === s.envId);
  const thumb = current?.thumbnail ? `url(${current.thumbnail}) center/cover` : SKY_SWATCH;
  return (
    <>
      <Section
        title="Environment"
        icon={<Globe size={14} />}
        value={envLoading ? `Loading ${Math.round(loadingFraction * 100)}%` : current?.name ?? 'Custom HDR'}
      >
        <div className="env-grid" role="radiogroup" aria-label="Environment map">
          {ENVIRONMENT_PRESETS.map((preset) => (
            <button
              key={preset.id}
              className="env"
              role="radio"
              aria-checked={s.envId === preset.id}
              data-on={s.envId === preset.id || undefined}
              style={{ background: preset.thumbnail ? `#222 url(${preset.thumbnail}) center/cover` : SKY_SWATCH }}
              onClick={() => setSettings({ envId: preset.id })}
            >
              <span>{preset.name}</span>
              {envLoading?.id === preset.id && <i className="env__bar" style={{ width: `${Math.max(4, loadingFraction * 100)}%` }} />}
            </button>
          ))}
          <FileTrigger acceptedFileTypes={['.hdr']} onSelect={(files) => files && getEngine()?.loadFiles(toPathedFiles(files))}>
            <Button className="env env--upload" data-on={s.envId === 'custom' || undefined}>
              <div><Upload size={16} />{s.envId === 'custom' ? 'Custom .hdr' : 'Upload .hdr'}</div>
            </Button>
          </FileTrigger>
        </div>
        {envLoading && (
          <div className="env-loading" role="progressbar" aria-label={`Loading ${envLoading.name}`}
            aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(loadingFraction * 100)}>
            <div>
              <span>Downloading {envLoading.name}</span>
              <span className="mono">
                {formatMB(envLoading.loaded)}{envLoading.total ? ` / ${formatMB(envLoading.total)}` : ''} MB
              </span>
            </div>
            <div className="progress"><i style={{ width: `${Math.max(2, loadingFraction * 100)}%` }} /></div>
          </div>
        )}
        <Field label="Resolution">
          <Segmented
            label="HDRI resolution"
            value={s.envResolution}
            disabled={!current?.polyHaven}
            options={ENV_RESOLUTIONS.map((r) => ({ value: r.value, label: <span title={r.size}>{r.label}</span> }))}
            onChange={(v) => setSettings({ envResolution: v })}
          />
        </Field>
        <Hint>HDRIs by <a href="https://polyhaven.com/hdris" target="_blank" rel="noreferrer">Poly Haven</a> (CC0), loaded on demand.</Hint>
        <Scrub label="Intensity" value={s.envIntensity} min={0} max={4} step={0.01} onChange={(v) => setSettings({ envIntensity: v })} />
        <Scrub label="Rotation" value={s.envRotation} min={0} max={360} step={1} unit="°" onChange={(v) => setSettings({ envRotation: v })} />
      </Section>

      <Section title="Background" icon={<Image size={14} />}>
        <div className="bg-cards" role="radiogroup" aria-label="Background">
          {([
            ['environment', 'HDRI', { background: thumb }],
            ['grounded', 'Grounded', { background: thumb }],
            ['color', 'Color', { background: s.backgroundColor }],
            ['transparent', 'Transparent', undefined]
          ] as const).map(([id, label, style]) => (
            <button
              key={id}
              className="bg-card"
              role="radio"
              aria-checked={s.background === id}
              data-on={s.background === id || undefined}
              onClick={() => setSettings({ background: id })}
            >
              <i className={id === 'transparent' ? 'checker' : undefined} style={style} />{label}
            </button>
          ))}
        </div>
        {s.background === 'color' && (
          <ColorField label="Color" value={s.backgroundColor} onChange={(hex) => setSettings({ backgroundColor: hex })} />
        )}
        {s.background === 'grounded' && (
          <>
            <Scrub label="Height" value={s.groundedHeight} min={0.1} max={5} step={0.05}
              title="Height of the HDRI camera above the ground, in model radii" onChange={(v) => setSettings({ groundedHeight: v })} />
            <Scrub label="Radius" value={s.groundedRadius} min={2} max={100} step={1}
              title="Radius of the projected dome, in model radii" onChange={(v) => setSettings({ groundedRadius: v })} />
            <Hint>Projects the HDRI onto the ground so the model stands in the scene. Match the height to how high the HDRI was shot.</Hint>
          </>
        )}
        {s.background === 'transparent' && <Hint>The environment still lights the scene. Exported PNGs keep the alpha channel.</Hint>}
      </Section>

      <Section
        title="Ground shadow"
        icon={<Square size={14} />}
        actions={<Switch label="Ground shadow" checked={s.groundShadow} onChange={(v) => setSettings({ groundShadow: v })} />}
      >
        {s.groundShadow && (
          <>
            <Scrub label="Opacity" value={s.groundOpacity} min={0} max={1} onChange={(v) => setSettings({ groundOpacity: v })} />
            <Hint>A shadow-catcher plane under the model. Pair it with a transparent background for product shots.</Hint>
          </>
        )}
      </Section>
    </>
  );
}
