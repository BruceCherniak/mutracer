import { useEffect, useRef, useState } from 'react';
import { Dialog, Heading, Modal, ModalOverlay } from 'react-aria-components';
import { Download, X } from 'lucide-react';
import { setSettings, setUi, useViewer } from '../store';
import { getEngine } from '../engine/ViewerEngine';
import { Field, Scrub, Segmented, Switch } from './ui/controls';

type SizePreset = 'viewport' | '1080p' | '4k' | 'square';

export function ExportDialog() {
  const open = useViewer((s) => s.ui.exportOpen);
  const progress = useViewer((s) => s.export);
  const stats = useViewer((s) => s.stats);
  const maxSamples = useViewer((s) => s.settings.maxSamples);
  const denoise = useViewer((s) => s.settings.denoise);
  const webgpu = useViewer((s) => s.backend.name === 'WebGPU');
  const background = useViewer((s) => s.settings.background);
  const [size, setSize] = useState<SizePreset>('viewport');
  const [samples, setSamples] = useState(maxSamples);
  const [transparent, setTransparent] = useState(background === 'transparent');
  const preview = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!open) return;
    setSamples(maxSamples);
    setTransparent(background === 'transparent');
    // Snapshot the current frame for the preview.
    const id = requestAnimationFrame(() => {
      const engine = getEngine();
      const target = preview.current;
      if (!engine || !target) return;
      const source = engine.renderer.canvas;
      target.width = 480;
      target.height = Math.round((480 * source.height) / Math.max(1, source.width));
      engine.renderer.prepareForExport();
      target.getContext('2d')?.drawImage(source, 0, 0, target.width, target.height);
    });
    return () => cancelAnimationFrame(id);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const dims = size === '1080p' ? [1920, 1080] : size === '4k' ? [3840, 2160] : size === 'square' ? [2048, 2048] : [stats.width, stats.height];
  const estimate = stats.msPerSample > 0 ? (stats.msPerSample * samples * (dims[0] * dims[1])) / Math.max(1, stats.width * stats.height) / 1000 : 0;
  const busy = progress !== null;
  const close = () => {
    if (busy) getEngine()?.cancelExport();
    setUi({ exportOpen: false });
  };

  return (
    <ModalOverlay className="scrim" isOpen={open} onOpenChange={(v) => !v && close()} isDismissable={!busy}>
      <Modal className="dialog">
        <Dialog aria-label="Export image">
          <Heading slot="title" className="dialog__title">Export image
            <button className="icon-btn icon-btn--bare sm" aria-label="Close" onClick={close}><X size={14} /></button>
          </Heading>
          <div className="preview" data-checker={transparent || undefined}><canvas ref={preview} /></div>
          <Field label="Size">
            <Segmented label="Image size" value={size} disabled={busy} onChange={setSize} options={[
              { value: 'viewport', label: 'Viewport' }, { value: '1080p', label: '1080p' },
              { value: '4k', label: '4K' }, { value: 'square', label: 'Square' }
            ]} />
          </Field>
          <Scrub label="Samples" value={samples} min={16} max={16384} log disabled={busy} onChange={setSamples} />
          <Switch label="Denoise" checked={denoise && webgpu} disabled={!webgpu || busy} onChange={(v) => setSettings({ denoise: v })}>
            <span className="field-label">Denoise with OIDN{!webgpu && <small> · Requires WebGPU</small>}</span>
          </Switch>
          <Switch label="Transparent background" checked={transparent} disabled={busy} onChange={setTransparent}>
            <span className="field-label">Transparent background</span>
          </Switch>
          {busy && (
            <div className="export-progress">
              <div className="progress"><i style={{ width: `${(progress.samples / Math.max(1, progress.target)) * 100}%` }} /></div>
              <span className="mono">{progress.stage === 'denoising' ? 'Denoising…' : `${progress.samples} / ${progress.target} spp`}</span>
            </div>
          )}
          <div className="actions">
            <span className="est mono">{dims[0]} × {dims[1]}{estimate > 0 && !busy ? ` · ≈ ${Math.max(1, Math.round(estimate))} s` : ''}</span>
            <button className="btn" onClick={close}>{busy ? 'Cancel render' : 'Cancel'}</button>
            <button className="btn btn--primary" disabled={busy} onClick={async () => {
              await getEngine()?.exportImage({ width: dims[0], height: dims[1], samples, transparent });
              setUi({ exportOpen: false });
            }}>
              <Download size={15} />{busy ? 'Rendering…' : 'Render PNG'}
            </button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
