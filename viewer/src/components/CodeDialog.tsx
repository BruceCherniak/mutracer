import { useMemo, useState, type ReactNode } from 'react';
import { Dialog, Heading, Modal, ModalOverlay } from 'react-aria-components';
import { Bot, Check, Code2, Copy, X } from 'lucide-react';
import { setUi, showToast, useViewer } from '../store';
import { getEngine } from '../engine/ViewerEngine';
import { Scrub } from './ui/controls';

// Enough JavaScript for the generated code: comments, strings, numbers,
// keywords, capitalized names (classes, namespaces) and calls.
const TOKEN = /(\/\/[^\n]*)|('(?:[^'\\\n]|\\.)*')|(\b\d+(?:\.\d+)?(?:e-?\d+)?\b|\b0x[\da-f]+\b)|\b(import|from|const|let|new|for|of|class|extends|await|return|get|if|else|true|false|null|this)\b|\b([A-Z]\w*)\b|\b(\w+)(?=\()/g;
const KINDS = ['comment', 'string', 'number', 'keyword', 'type', 'call'] as const;

function highlight(code: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of code.matchAll(TOKEN)) {
    if (match.index > last) out.push(code.slice(last, match.index));
    const kind = KINDS[match.slice(1).findIndex((group) => group !== undefined)];
    out.push(<span key={match.index} className={`tok-${kind}`}>{match[0]}</span>);
    last = match.index + match[0].length;
  }
  out.push(code.slice(last));
  return out;
}

const FONT_SIZE_KEY = 'mutracer-viewer:code-font-size';

function readFontSize() {
  try {
    const value = Number(localStorage.getItem(FONT_SIZE_KEY));
    return value >= 9 && value <= 20 ? value : 11.5;
  } catch {
    return 11.5;
  }
}

/** Minimal MuTracer program that reproduces the current view. */
export function CodeDialog() {
  const open = useViewer((s) => s.ui.codeOpen);
  const [copied, setCopied] = useState<'code' | 'agent' | null>(null);
  const [fontSize, setFontSize] = useState(readFontSize);
  const changeFontSize = (value: number) => {
    setFontSize(value);
    try {
      localStorage.setItem(FONT_SIZE_KEY, String(value));
    } catch {
      // Storage can be unavailable (private mode); the size is optional.
    }
  };
  // Snapshot on open; the scene cannot change behind the modal.
  const code = useMemo(() => (open ? getEngine()?.code() ?? '' : ''), [open]);
  const tokens = useMemo(() => highlight(code), [code]);
  const close = () => {
    setCopied(null);
    setUi({ codeOpen: false });
  };
  const copy = async (kind: 'code' | 'agent') => {
    try {
      await navigator.clipboard.writeText(kind === 'agent' ? getEngine()?.agentMarkdown() ?? code : code);
      setCopied(kind);
    } catch (error) {
      showToast(`Could not copy: ${(error as Error).message}`, 'error');
    }
  };

  const lineCount = code.split('\n').length - 1;
  const placeholders = /Placeholders to replace: (.*)\./.exec(code)?.[1];

  return (
    <ModalOverlay className="scrim" isOpen={open} onOpenChange={(v) => !v && close()} isDismissable>
      <Modal className="dialog dialog--code">
        <Dialog aria-label="Code">
          <header className="code-head">
            <span className="code-head__icon"><Code2 size={16} /></span>
            <Heading slot="title" className="dialog__title">Code</Heading>
            <button className="icon-btn icon-btn--bare sm" aria-label="Close" onClick={close}><X size={14} /></button>
          </header>
          <div className="code-notes">
            <p className="hint">Material edits and object visibility are not included.</p>
            {placeholders && <p className="hint hint--warn">Replace {placeholders}.</p>}
          </div>
          <div className="code-panel">
            <div className="code-panel__bar">
              <span className="code-panel__file"><i />scene.js</span>
              <div className="code-font-size">
                <Scrub label="Size" value={fontSize} min={9} max={20} step={0.5} unit="px" onChange={changeFontSize} />
              </div>
            </div>
            <div className="code-view" style={{ fontSize }}>
              <div className="code-gutter" aria-hidden="true">
                {Array.from({ length: lineCount }, (_, i) => i + 1).join('\n')}
              </div>
              <pre className="code-block" tabIndex={0} aria-label="Generated code"><code>{tokens}</code></pre>
            </div>
          </div>
          <div className="actions">
            <button className="btn" onClick={() => copy('agent')}
              title="Copy as Markdown with the model, viewer link and changed settings, for a coding agent">
              {copied === 'agent' ? <Check size={15} /> : <Bot size={15} />}{copied === 'agent' ? 'Copied' : 'Copy for agent'}
            </button>
            <button className="btn btn--primary" onClick={() => copy('code')}>
              {copied === 'code' ? <Check size={15} /> : <Copy size={15} />}{copied === 'code' ? 'Copied' : 'Copy'}
            </button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
