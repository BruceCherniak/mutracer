import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { setSettings, setUi, useViewer } from './store';
import { getEngine } from './engine/ViewerEngine';
import { redo, undo } from './history';
import { Toolbar } from './components/Toolbar';
import { SceneTree } from './components/SceneTree';
import { Viewport } from './components/Viewport';
import { Inspector, InspectorRail, TABS } from './components/Inspector';
import { ExportDialog } from './components/ExportDialog';
import { CodeDialog } from './components/CodeDialog';

const MOBILE_QUERY = '(max-width: 768px)';

function useMobile() {
  const [mobile, setMobile] = useState(() => matchMedia(MOBILE_QUERY).matches);
  useEffect(() => {
    const query = matchMedia(MOBILE_QUERY);
    const onChange = () => setMobile(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return mobile;
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Key events dispatched on the document have no element target.
      const target = event.target instanceof Element ? event.target : document.body;
      if (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        document.getElementById('open-files')?.click();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && !event.altKey && (event.key.toLowerCase() === 'z' || event.key.toLowerCase() === 'y')) {
        event.preventDefault();
        if (event.key.toLowerCase() === 'y' || event.shiftKey) redo();
        else undo();
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const state = useViewer.getState();
      const key = event.key.toLowerCase();
      if (key === 'f') getEngine()?.fit();
      else if (key === ' ') {
        if (target.closest('button, [role="slider"], [role="treeitem"]')) return;
        event.preventDefault();
        if (state.animation) getEngine()?.setAnimation({ playing: !state.animation.playing });
        else useViewer.setState({ paused: !state.paused });
      } else if (key === 'd') setSettings({ denoise: !state.settings.denoise });
      else if (key === 'e') setUi({ exportOpen: true });
      else if (key === 'h') setUi({ hidden: !state.ui.hidden });
      else if (key === '[') setUi({ left: !state.ui.left });
      else if (key === ']') setUi({ right: !state.ui.right });
      else if (key === '/') {
        event.preventDefault();
        (document.querySelector('.search input') as HTMLInputElement | null)?.focus();
      } else if (key === 'escape') {
        useViewer.setState({ pickingFocus: false });
        getEngine()?.select(null);
      } else if (/^[1-4]$/.test(key)) setUi({ tab: TABS[Number(key) - 1].id, right: true });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

export function App() {
  const ui = useViewer((s) => s.ui);
  const mobile = useMobile();
  useShortcuts();
  const left = ui.left && !ui.hidden && !mobile;
  const right = ui.right && !ui.hidden && !mobile;
  return (
    <div className="app" data-hidden={ui.hidden || undefined}>
      {!ui.hidden && <Toolbar />}
      <main className="workspace" data-left={left || undefined} data-right={right || undefined} data-mobile={mobile || undefined}>
        {left && <SceneTree />}
        <Viewport />
        {right && <Inspector mobile={false} />}
        {!mobile && !ui.hidden && <InspectorRail />}
        {mobile && !ui.hidden && <Inspector mobile />}
      </main>
      <ExportDialog />
      <CodeDialog />
      <Toast />
    </div>
  );
}

function Toast() {
  const toast = useViewer((s) => s.toast);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => useViewer.setState({ toast: null }), toast.tone === 'error' ? 7000 : 3500);
    return () => clearTimeout(timer);
  }, [toast]);
  if (!toast) return null;
  return (
    <div className="toast" role={toast.tone === 'error' ? 'alert' : 'status'} data-tone={toast.tone} key={toast.id}>
      <span>{toast.message}</span>
      <button className="icon-btn icon-btn--bare xs" aria-label="Dismiss" onClick={() => useViewer.setState({ toast: null })}><X size={12} /></button>
    </div>
  );
}
