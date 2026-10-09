import { Camera, Crosshair, Focus } from 'lucide-react';
import { setSettings, useViewer } from '../../store';
import { getEngine } from '../../engine/ViewerEngine';
import { Hint, Scrub, Section, Select, Switch } from '../ui/controls';

export function CameraPanel() {
  const s = useViewer((state) => state.settings);
  const cameras = useViewer((state) => state.cameras);
  const picking = useViewer((state) => state.pickingFocus);
  const orbit = s.cameraIndex < 0;
  return (
    <>
      <Section title="View" icon={<Camera size={14} />}>
        {cameras.length > 0 && (
          <Select
            label="Camera"
            prefix="Camera"
            value={String(s.cameraIndex)}
            options={[{ value: '-1', label: 'Orbit' }, ...cameras.map((name, i) => ({ value: String(i), label: name }))]}
            onChange={(v) => setSettings({ cameraIndex: Number(v) })}
          />
        )}
        <Scrub label="Field of view" value={s.fov} min={10} max={100} step={1} unit="°" disabled={!orbit} onChange={(v) => setSettings({ fov: v })} />
        <Switch label="Auto-rotate" checked={s.autoRotate} disabled={!orbit} onChange={(v) => setSettings({ autoRotate: v })}>
          <span className="field-label">Auto-rotate</span>
        </Switch>
        <button className="btn btn--wide" disabled={!orbit} onClick={() => getEngine()?.fit()}>
          <Focus size={15} />Fit to model<kbd>F</kbd>
        </button>
        {!orbit && <Hint>Model cameras are fixed. Switch to Orbit to move the view.</Hint>}
      </Section>

      <Section
        title="Depth of field"
        icon={<Crosshair size={14} />}
        actions={<Switch label="Depth of field" checked={s.aperture > 0} onChange={(on) => setSettings({ aperture: on ? Math.max(0.01, Number((s.focusDistance * 0.01).toFixed(4))) : 0 })} />}
      >
        {s.aperture > 0 && (
          <>
            <Scrub label="Aperture" value={s.aperture} min={0} max={Math.max(0.2, s.focusDistance * 0.05)} step={0.001} onChange={(v) => setSettings({ aperture: v })} />
            <div className="row-with-button">
              <Scrub label="Focus" value={s.focusDistance} min={0.01} max={Math.max(10, s.focusDistance * 3)} step={0.01} unit="m" onChange={(v) => setSettings({ focusDistance: v })} />
              <button className="btn" data-active={picking || undefined} onClick={() => useViewer.setState({ pickingFocus: !picking })}>
                <Crosshair size={14} />Pick
              </button>
            </div>
            <Hint>{picking ? 'Click the model to focus on that point.' : 'Aperture is the lens radius in scene units.'}</Hint>
          </>
        )}
      </Section>
    </>
  );
}
