import { useEffect, useRef, useState } from 'react';
import { Check, Crosshair, Focus, Pause, Play, Repeat as Loop, Upload } from 'lucide-react';
import { ViewerEngine, getEngine, setEngine } from '../engine/ViewerEngine';
import { HANDOFF_HASH, readDroppedItems, takeStashedFiles } from '../engine/droppedFiles';
import { hashModelPreset, useViewer } from '../store';
import { StatusBar } from './StatusBar';
import { Select } from './ui/controls';

export function Viewport() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [dragging, setDragging] = useState(false);
  const picking = useViewer((s) => s.pickingFocus);
  const hidden = useViewer((s) => s.ui.hidden);

  useEffect(() => {
    const engine = new ViewerEngine(canvasRef.current!);
    setEngine(engine);
    if (location.hash.slice(1).split('&').includes(HANDOFF_HASH)) {
      // Files dropped on the home page (the hash is rewritten after the first settings change).
      void takeStashedFiles().then((files) => {
        if (getEngine() !== engine) return;
        return files ? engine.loadFiles(files) : engine.loadInitialModel(null);
      });
    } else {
      void engine.loadInitialModel(hashModelPreset());
    }
    // Our own hash writes use replaceState, so this only fires for edits by the user.
    const onHashChange = () => {
      const id = hashModelPreset();
      if (id && id !== useViewer.getState().model?.presetId) void engine.loadPreset(id);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => {
      window.removeEventListener('hashchange', onHashChange);
      setEngine(null);
      engine.dispose();
    };
  }, []);

  return (
    <section
      className="panel viewport"
      data-picking={picking || undefined}
      onDragEnter={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }}
      onDrop={async (e) => {
        e.preventDefault();
        setDragging(false);
        const files = await readDroppedItems(e.dataTransfer.items);
        if (files.length) void getEngine()?.loadFiles(files);
      }}
    >
      <canvas ref={canvasRef} className="viewport__canvas" aria-label="Path traced view. Drag to orbit, right-drag to pan, scroll to zoom, click to select." />
      {!hidden && (
        <>
          <SelectionBox />
          <TopBar />
          <Credit />
          <AnimationBar />
          <StatusBar />
        </>
      )}
      <LoadingCard />
      {dragging && (
        <div className="drop-layer">
          <div><Upload size={28} />Drop to open<small>.glb · .gltf with .bin and textures · folder · .hdr</small></div>
        </div>
      )}
    </section>
  );
}

function TopBar() {
  const picking = useViewer((s) => s.pickingFocus);
  return (
    <div className="float float--top">
      <button className="icon-btn icon-btn--bare" title="Fit to model (F)" aria-label="Fit to model" onClick={() => getEngine()?.fit()}><Focus size={16} /></button>
      <button className="icon-btn icon-btn--bare" title="Pick focus point" aria-label="Pick focus point" data-active={picking || undefined}
        onClick={() => useViewer.setState({ pickingFocus: !picking })}><Crosshair size={16} /></button>
    </div>
  );
}

function SelectionBox() {
  const rect = useViewer((s) => s.selectionRect);
  if (!rect) return null;
  return (
    <div className="selection" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}>
      <i /><i /><i /><i /><span>{rect.label}</span>
    </div>
  );
}

function Credit() {
  const model = useViewer((s) => s.model);
  if (!model?.credit) return null;
  return (
    <div className="credit">
      {model.sourceUrl ? <a href={model.sourceUrl} target="_blank" rel="noreferrer">{model.credit}</a> : model.credit}
    </div>
  );
}

function AnimationBar() {
  const anim = useViewer((s) => s.animation);
  if (!anim) return null;
  const engine = getEngine();
  const progress = anim.duration ? anim.time / anim.duration : 0;
  return (
    <div className="float anim">
      <button className="icon-btn play" aria-label={anim.playing ? 'Pause animation' : 'Play animation'} title="Play / pause (Space)"
        onClick={() => engine?.setAnimation({ playing: !anim.playing })}>
        {anim.playing ? <Pause size={15} /> : <Play size={15} />}
      </button>
      <input
        className="timeline"
        type="range"
        aria-label="Animation time"
        min={0}
        max={anim.duration}
        step={0.001}
        value={anim.time}
        style={{ '--p': `${progress * 100}%` } as React.CSSProperties}
        onChange={(e) => engine?.setAnimation({ time: Number(e.currentTarget.value), playing: false })}
      />
      <span className="time mono">{anim.time.toFixed(2)} / {anim.duration.toFixed(2)} s</span>
      <span className="sep" />
      {anim.clips.length > 1 && (
        <Select label="Animation clip" value={String(anim.clip)} options={anim.clips.map((name, i) => ({ value: String(i), label: name }))}
          onChange={(v) => engine?.selectClip(Number(v))} />
      )}
      <Select label="Playback speed" value={String(anim.speed)}
        options={['0.25', '0.5', '1', '2'].map((v) => ({ value: v, label: `${v}×` }))}
        onChange={(v) => engine?.setAnimation({ speed: Number(v) })} />
      <button className="icon-btn icon-btn--bare" aria-label="Loop" aria-pressed={anim.loop} data-active={anim.loop || undefined}
        title="Loop" onClick={() => engine?.setAnimation({ loop: !anim.loop })}><Loop size={14} /></button>
    </div>
  );
}

const STAGES = [
  ['download', 'Download'],
  ['parse', 'Parse glTF'],
  ['bvh', 'Build BVH'],
  ['shaders', 'Compile shaders']
] as const;

function LoadingCard() {
  const loading = useViewer((s) => s.loading);
  if (!loading) return null;
  const current = STAGES.findIndex(([id]) => id === loading.stage);
  const fraction = loading.stage === 'download' && loading.total ? loading.loaded / loading.total : 0;
  const overall = (current + fraction) / STAGES.length;
  return (
    <div className="center-card" role="status" aria-live="polite">
      <h3>Loading {loading.name}</h3>
      <div className="steps">
        {STAGES.map(([id, label], index) => (
          <div key={id} className="step" data-done={index < current || undefined} data-active={index === current || undefined}>
            <span className="dot">{index < current && <Check size={11} />}</span>
            <b>{label}</b>
            <span className="mono">
              {id === 'download' && loading.loaded > 0 ? `${(loading.loaded / 2 ** 20).toFixed(1)}${loading.total ? ` / ${(loading.total / 2 ** 20).toFixed(1)}` : ''} MB` : ''}
            </span>
          </div>
        ))}
      </div>
      <div className="progress"><i style={{ width: `${Math.max(4, overall * 100)}%` }} /></div>
    </div>
  );
}
