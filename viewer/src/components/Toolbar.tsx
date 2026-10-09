import { useRef, useState } from 'react';
import {
  Button, Dialog, DialogTrigger, Heading, Menu, MenuItem, MenuTrigger, Modal, ModalOverlay, Popover, Separator
} from 'react-aria-components';
import {
  ChevronDown, Download, FileUp, Folder, Globe, HelpCircle, Link, PanelLeft, PanelRight, Sparkles, Upload, X
} from 'lucide-react';
import { setUi, useViewer } from '../store';
import { getEngine } from '../engine/ViewerEngine';
import { MODEL_PRESETS } from '../engine/presets';
import { toPathedFiles } from '../engine/loadModel';
import { BrandMark } from './BrandMark';

export function Toolbar() {
  const backend = useViewer((s) => s.backend);
  const ui = useViewer((s) => s.ui);
  return (
    <header className="header">
      <div className="brand">
        <BrandMark />
        <div><strong>ClayPT Viewer</strong><small>PATH TRACER</small></div>
        <span className="divider hide-m" />
        <button className="icon-btn icon-btn--bare sm hide-m" aria-label="Toggle scene panel" title="Toggle scene panel ([)"
          aria-pressed={ui.left} onClick={() => setUi({ left: !ui.left })}><PanelLeft size={15} /></button>
      </div>
      <div className="header__center">
        <OpenMenu />
        <ExamplesMenu />
      </div>
      <div className="header__right">
        <BackendMenu name={backend.name} adapter={backend.adapter} />
        <HelpButton />
        <button className="btn btn--primary" aria-label="Export image" onClick={() => setUi({ exportOpen: true })}>
          <Download size={15} /><span className="hide-xs">Export</span>
        </button>
        <button className="icon-btn icon-btn--bare sm hide-m" aria-label="Toggle inspector" title="Toggle inspector (])"
          aria-pressed={ui.right} onClick={() => setUi({ right: !ui.right })}><PanelRight size={15} /></button>
      </div>
    </header>
  );
}

function OpenMenu() {
  const files = useRef<HTMLInputElement>(null);
  const folder = useRef<HTMLInputElement>(null);
  const hdr = useRef<HTMLInputElement>(null);
  const [urlOpen, setUrlOpen] = useState(false);
  const onFiles = (list: FileList | null) => list?.length && void getEngine()?.loadFiles(toPathedFiles(list));
  return (
    <>
      <MenuTrigger>
        <Button className="btn" aria-label="Open"><Upload size={15} /><span className="hide-xs">Open</span><ChevronDown size={13} className="chev" /></Button>
        <Popover className="popover menu" offset={8} style={{ width: 250 }}>
          <Menu className="menu-list" aria-label="Open" onAction={(key) => {
            if (key === 'files') files.current?.click();
            if (key === 'folder') folder.current?.click();
            if (key === 'hdr') hdr.current?.click();
            if (key === 'url') setUrlOpen(true);
          }}>
            <MenuItem id="files" className="menu-item"><FileUp size={15} />Open files…<kbd>⌘O</kbd></MenuItem>
            <MenuItem id="folder" className="menu-item"><Folder size={15} />Open folder…<kbd /></MenuItem>
            <MenuItem id="url" className="menu-item"><Link size={15} />Open from URL…<kbd /></MenuItem>
            <Separator className="menu-sep" />
            <MenuItem id="hdr" className="menu-item"><Globe size={15} />Load environment (.hdr)…<kbd /></MenuItem>
          </Menu>
          <div className="menu-note">Or drop files anywhere on the viewport.</div>
        </Popover>
      </MenuTrigger>
      <input ref={files} id="open-files" type="file" hidden multiple accept=".glb,.gltf,.bin,.png,.jpg,.jpeg,.webp,.ktx2,.hdr" onChange={(e) => { onFiles(e.currentTarget.files); e.currentTarget.value = ''; }} />
      <input ref={folder} type="file" hidden {...{ webkitdirectory: '' }} onChange={(e) => { onFiles(e.currentTarget.files); e.currentTarget.value = ''; }} />
      <input ref={hdr} type="file" hidden accept=".hdr" onChange={(e) => { onFiles(e.currentTarget.files); e.currentTarget.value = ''; }} />
      <UrlDialog open={urlOpen} onOpenChange={setUrlOpen} />
    </>
  );
}

function UrlDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [url, setUrl] = useState('');
  return (
    <ModalOverlay className="scrim" isOpen={open} onOpenChange={onOpenChange} isDismissable>
      <Modal className="dialog">
        <Dialog aria-label="Open from URL">
          {({ close }) => (
            <form onSubmit={(e) => {
              e.preventDefault();
              if (!url.trim()) return;
              void getEngine()?.loadUrl(url.trim());
              close();
            }}>
              <Heading slot="title" className="dialog__title">Open from URL
                <button type="button" className="icon-btn icon-btn--bare sm" aria-label="Close" onClick={close}><X size={14} /></button>
              </Heading>
              <input className="text-input" autoFocus placeholder="https://…/model.glb or environment.hdr" value={url} onChange={(e) => setUrl(e.currentTarget.value)} />
              <p className="hint">The server must allow cross-origin requests. .gltf files load their resources relative to the URL.</p>
              <div className="actions">
                <button type="button" className="btn" onClick={close}>Cancel</button>
                <button type="submit" className="btn btn--primary" disabled={!url.trim()}>Open</button>
              </div>
            </form>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

function ExamplesMenu() {
  const current = useViewer((s) => s.model?.presetId);
  return (
    <DialogTrigger>
      <Button className="btn" aria-label="Examples"><Sparkles size={15} /><span className="hide-xs">Examples</span><ChevronDown size={13} className="chev" /></Button>
      <Popover className="popover examples" offset={8}>
        <Dialog aria-label="Examples">
          {({ close }) => (
            <>
              <h4>Examples <span>Khronos glTF Sample Assets · loaded on demand</span></h4>
              <div className="ex-grid">
                {MODEL_PRESETS.map((preset) => (
                  <button key={preset.id} className="ex" data-on={current === preset.id || undefined}
                    onClick={() => { void getEngine()?.loadPreset(preset.id); close(); }}>
                    <img className="thumb" src={preset.thumbnail} alt="" loading="lazy" />
                    <div>
                      <b>{preset.name}</b>
                      <small><span className="tag">{preset.tag}</span><span>{preset.license}{preset.sizeMB ? ` · ${preset.sizeMB} MB` : ''}</span></small>
                    </div>
                  </button>
                ))}
              </div>
            </>
          )}
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}

function BackendMenu({ name, adapter }: { name: string | null; adapter: string }) {
  const webgl = name === 'WebGL 2';
  return (
    <MenuTrigger>
      <Button className="backend-pill hide-m" aria-label="Rendering backend">
        <i className="dot" data-tone={webgl ? 'warn' : name ? 'ok' : 'idle'} />
        <b>{name ?? 'Starting'}</b>{adapter && <span className="adapter">· {adapter}</span>}
      </Button>
      <Popover className="popover menu" offset={8} placement="bottom end" style={{ width: 260 }}>
        <Menu className="menu-list" aria-label="Backend" onAction={(key) => {
          const url = new URL(location.href);
          if (key === 'webgl') url.searchParams.set('webgl', '');
          else url.searchParams.delete('webgl');
          location.href = url.toString();
        }}>
          <MenuItem id="webgpu" className="menu-item">WebGPU<kbd>{!webgl && name ? 'active' : ''}</kbd></MenuItem>
          <MenuItem id="webgl" className="menu-item">WebGL 2 fallback<kbd>{webgl ? 'active' : ''}</kbd></MenuItem>
        </Menu>
        <div className="menu-note">Switching reloads the page. OIDN, auto exposure and Neutral tone mapping need WebGPU.</div>
      </Popover>
    </MenuTrigger>
  );
}

const SHORTCUTS: [string, string][] = [
  ['Drag / right-drag / scroll', 'Orbit / pan / zoom'],
  ['Click', 'Select object'],
  ['F', 'Fit to model'],
  ['Space', 'Play or pause'],
  ['D', 'Toggle denoiser'],
  ['E', 'Export image'],
  ['1 – 4', 'Inspector tabs'],
  ['[  ]', 'Scene / inspector panels'],
  ['H', 'Hide interface'],
  ['⌘O', 'Open files']
];

function HelpButton() {
  return (
    <DialogTrigger>
      <Button className="icon-btn icon-btn--bare hide-m" aria-label="Keyboard shortcuts"><HelpCircle size={16} /></Button>
      <Popover className="popover" offset={8} placement="bottom end">
        <Dialog aria-label="Keyboard shortcuts" className="shortcuts">
          <h4>Shortcuts</h4>
          <dl>{SHORTCUTS.map(([k, v]) => <div key={k}><dt><kbd>{k}</kbd></dt><dd>{v}</dd></div>)}</dl>
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}
