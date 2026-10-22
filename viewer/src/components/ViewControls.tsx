import { Crosshair, Focus, Maximize } from 'lucide-react';
import { setSettings, setUi, useViewer } from '../store';
import { getEngine } from '../engine/ViewerEngine';
import { Select } from './ui/controls';

export function ViewControls() {
  const picking = useViewer((s) => s.pickingFocus);
  const autoFocus = useViewer((s) => s.settings.autoFocus);
  const focusFrame = useViewer((s) => s.ui.focusFrame);
  const depthOfField = useViewer((s) => s.settings.fStop > 0 &&
    !(s.settings.cameraIndex < 0 && s.settings.projection === 'orthographic'));
  if (!depthOfField) return null;
  return (
    <>
      <div className="viewport-tools" role="group" aria-label="Focus controls">
        {!autoFocus && <button className="icon-btn icon-btn--bare" title="Pick focus point" aria-label="Pick focus point" data-active={picking || undefined}
          onClick={() => useViewer.setState({ pickingFocus: !picking })}><Crosshair size={16} /></button>}
        {autoFocus && <button className="icon-btn icon-btn--bare" aria-label="Show focus frame" aria-pressed={focusFrame}
          title={focusFrame ? 'Hide focus frame' : 'Show focus frame'} data-active={focusFrame || undefined}
          onClick={() => setUi({ focusFrame: !focusFrame })}><Focus size={16}>{!focusFrame && <path d="m3 3 18 18" />}</Focus></button>}
      </div>
      <span className="sep" />
    </>
  );
}

/** Authored views stay separate from render and focus controls. */
export function CameraControls() {
  const cameras = useViewer((s) => s.cameras);
  const cameraIndex = useViewer((s) => s.settings.cameraIndex);
  if (!cameras.length) return null;
  return (
    <div className="float camera-controls" role="group" aria-label="Scene cameras">
      <div className="viewport-camera">
        <Select label="Camera" prefix="Camera" value={String(cameraIndex)} placement="top"
          options={[{ value: '-1', label: 'Orbit' }, ...cameras.map((name, i) => ({ value: String(i), label: name }))]}
          onChange={(v) => setSettings({ cameraIndex: Number(v) })} />
      </div>
      <button className="icon-btn icon-btn--bare" title="Fit to model (F)" aria-label="Fit to model"
        onClick={() => getEngine()?.fit()}><Maximize size={16} /></button>
    </div>
  );
}
