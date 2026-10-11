import { Camera, Crosshair, Maximize } from 'lucide-react';
import { setSettings, setUi, useViewer } from '../../store';
import { DEFAULT_F_STOP, getEngine } from '../../engine/ViewerEngine';
import { Hint, Scrub, Section, Segmented, Select, Switch } from '../ui/controls';

export function CameraPanel() {
  const s = useViewer((state) => state.settings);
  const cameras = useViewer((state) => state.cameras);
  const orbit = s.cameraIndex < 0;
  const orthographic = orbit && s.projection === 'orthographic';
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
        <Segmented
          label="Projection"
          value={s.projection}
          disabled={!orbit}
          options={[
            { value: 'perspective', label: 'Perspective' },
            { value: 'orthographic', label: 'Orthographic' }
          ]}
          onChange={(v) => setSettings({ projection: v })}
        />
        <Scrub label="Field of view" value={s.fov} min={10} max={100} step={1} unit="°" disabled={!orbit || orthographic} onChange={(v) => setSettings({ fov: v })} />
        <Switch label="Auto-rotate" checked={s.autoRotate} disabled={!orbit} onChange={(v) => setSettings({ autoRotate: v })}>
          <span className="field-label">Auto-rotate</span>
        </Switch>
        <button className="btn btn--wide" disabled={!orbit} onClick={() => getEngine()?.fit()}>
          <Maximize size={15} />Fit to model<kbd>F</kbd>
        </button>
        {!orbit && <Hint>Model cameras are fixed. Switch to Orbit to move the view.</Hint>}
      </Section>

      <Section
        title="Depth of field"
        icon={<Crosshair size={14} />}
        actions={<Switch label="Depth of field" checked={s.fStop > 0} disabled={orthographic} onChange={(on) => setSettings({ fStop: on ? DEFAULT_F_STOP : 0 })} />}
      >
        {orthographic && <Hint>Orthographic views have no depth of field.</Hint>}
        {s.fStop > 0 && !orthographic && <DepthOfField />}
      </Section>
    </>
  );
}

const UNITS = [
  { value: '0.001', label: 'Millimetres' },
  { value: '0.01', label: 'Centimetres' },
  { value: '0.0254', label: 'Inches' },
  { value: '1', label: 'Metres' }
];

const unitName = (metersPerUnit: number) =>
  UNITS.find((unit) => Number(unit.value) === metersPerUnit)?.label ?? `${metersPerUnit} m`;

/** Metres as "35 cm" or "2.40 m". */
const formatMeters = (meters: number) =>
  meters < 1 ? `${(meters * 100).toPrecision(3).replace(/\.?0+$/, '')} cm` : `${meters.toFixed(meters < 10 ? 2 : 1)} m`;

function DepthOfField() {
  const s = useViewer((state) => state.settings);
  const picking = useViewer((state) => state.pickingFocus);
  const lens = useViewer((state) => state.lens);
  const radius = useViewer((state) => state.modelRadius);
  const focusFrame = useViewer((state) => state.ui.focusFrame);
  const metersPerUnit = s.metersPerUnit ?? lens.guessedMetersPerUnit;
  // Focus range follows the model so the slider stays usable at any scale.
  const focusMin = radius * 0.05 * metersPerUnit;
  const focusMax = Math.max(radius * 60, s.focusDistance * 2) * metersPerUnit;
  const aperture = lens.focalLength / s.fStop;
  return (
    <>
      <Scrub label="f-number" value={s.fStop} min={0.7} max={22} step={0.1} log format={(v) => `f/${v}`}
        onChange={(v) => setSettings({ fStop: v })} />
      <Switch label="Autofocus" checked={s.autoFocus} onChange={(v) => setSettings({ autoFocus: v })}>
        <span className="field-label">Area autofocus</span>
      </Switch>
      <Switch label="Show focus frame" checked={focusFrame} disabled={!s.autoFocus} onChange={(v) => setUi({ focusFrame: v })}>
        <span className="field-label">Show focus frame</span>
      </Switch>
      <div className={s.autoFocus ? undefined : 'row-with-button'}>
        <Scrub label="Focus" value={s.focusDistance * metersPerUnit} min={focusMin} max={focusMax} step={0.0001} log format={formatMeters}
          title={s.autoFocus ? 'Dragging turns autofocus off' : undefined}
          onChange={(v) => setSettings({ focusDistance: v / metersPerUnit, autoFocus: false })} />
        {!s.autoFocus && <button className="btn" data-active={picking || undefined} onClick={() => useViewer.setState({ pickingFocus: !picking })}>
          <Crosshair size={14} />Pick
        </button>}
      </div>
      <Select
        label="Scene unit"
        prefix="Unit"
        value={s.metersPerUnit === null ? 'auto' : String(s.metersPerUnit)}
        options={[{ value: 'auto', label: `Auto · ${unitName(lens.guessedMetersPerUnit)}` }, ...UNITS]}
        onChange={(v) => setSettings({ metersPerUnit: v === 'auto' ? null : Number(v) })}
      />
      <Hint>
        {picking
          ? 'Click the model to focus on that point.'
          : <>{lens.focalLength.toFixed(0)} mm lens, {aperture.toFixed(1)} mm aperture.{s.autoFocus && focusFrame ? ' Hover over the frame, then drag its center to move the focus area.' : ''}</>}
      </Hint>
    </>
  );
}
