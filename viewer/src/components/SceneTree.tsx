import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Box, Camera, ChevronDown, Eye, EyeOff, Folder, Lightbulb, Search, Video, X } from 'lucide-react';
import { useViewer } from '../store';
import { flattenTree, indexTree, revealTreeRow, treeAncestors, treeWindow, TREE_ROW_HEIGHT } from './sceneTreeRows';
import { getEngine } from '../engine/ViewerEngine';

const ICONS = { group: Folder, mesh: Box, light: Lightbulb, camera: Camera };

function formatCount(n: number) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
}

export function SceneTree() {
  const tree = useViewer((s) => s.tree);
  const info = useViewer((s) => s.sceneInfo);
  const model = useViewer((s) => s.model);
  const selection = useViewer((s) => s.selection);
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const treeRef = useRef<HTMLDivElement>(null);
  const pendingReveal = useRef(false);
  const [activeKey, setActiveKey] = useState<string>();
  const [viewport, setViewport] = useState({ top: 0, height: 0 });
  const treeId = useId();
  const index = useMemo(() => indexTree(tree), [tree]);
  const ancestors = useMemo(() => new Set(treeAncestors(index, selection.objectId)), [index, selection.objectId]);
  const rows = useMemo(() => flattenTree(tree, collapsed, query), [tree, query, collapsed]);
  const window = treeWindow(rows.length, viewport.top, viewport.height);
  const activeRow = rows.find((row) => row.key === activeKey) ?? rows[0];
  const rowId = (key: string) => `${treeId}-${encodeURIComponent(key)}`;

  useLayoutEffect(() => {
    const element = treeRef.current!;
    const measure = () => setViewport({ top: element.scrollTop, height: element.clientHeight });
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, []);

  // Viewport picks may refer to descendants of collapsed or filtered branches.
  // Only react to a new selection, so manually collapsing/scrolling remains possible.
  useLayoutEffect(() => {
    if (!selection.objectId || !index.has(selection.objectId)) return;
    const path = treeAncestors(index, selection.objectId);
    setCollapsed((current) => {
      const closed = path.filter((id) => current[id] !== false);
      return closed.length ? { ...current, ...Object.fromEntries(closed.map((id) => [id, false])) } : current;
    });
    setQuery('');
    setActiveKey((key) => key === `${selection.objectId}:${selection.materialId}` ? key : selection.objectId!);
    pendingReveal.current = true;
  }, [selection, index]);

  useLayoutEffect(() => {
    const element = treeRef.current!;
    let top = treeWindow(rows.length, element.scrollTop, element.clientHeight).top;
    if (pendingReveal.current && !query && element.clientHeight > 0) {
      const selected = rows.findIndex((row) => row.key === selection.objectId);
      if (selected >= 0) {
        top = revealTreeRow(selected, top, element.clientHeight);
        pendingReveal.current = false;
      }
    }
    element.scrollTop = top;
    setViewport((current) => current.top === top ? current : { ...current, top });
  }, [rows, selection, query, viewport.height]);

  const toggle = (row: typeof rows[number]) =>
    setCollapsed((current) => ({ ...current, [row.node.id]: row.expanded }));

  const focusRow = (i: number) => {
    const row = rows[i];
    if (!row) return;
    setActiveKey(row.key);
    const element = treeRef.current!;
    element.scrollTop = revealTreeRow(i, element.scrollTop, element.clientHeight);
    setViewport((current) => ({ ...current, top: element.scrollTop }));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || !activeRow) return;
    const i = rows.indexOf(activeRow);
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'ArrowLeft', 'ArrowRight', 'Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'ArrowDown') focusRow(Math.min(rows.length - 1, i + 1));
    if (event.key === 'ArrowUp') focusRow(Math.max(0, i - 1));
    if (event.key === 'Home') focusRow(0);
    if (event.key === 'End') focusRow(rows.length - 1);
    if (event.key === 'ArrowRight') {
      if (activeRow.hasChildren && !activeRow.expanded) toggle(activeRow);
      else if (activeRow.expanded) focusRow(i + 1);
    }
    if (event.key === 'ArrowLeft') {
      if (activeRow.expanded) toggle(activeRow);
      else focusRow(rows.findIndex((row) => row.key === activeRow.parentKey));
    }
    if (event.key === 'Enter' || event.key === ' ') {
      if (activeRow.material) getEngine()?.selectMaterial(activeRow.material.id, activeRow.node.id);
      else getEngine()?.select(activeRow.node.id, activeRow.node.kind === 'mesh' ? undefined : null);
    }
  };

  const activate = (key: string) => {
    setActiveKey(key);
    treeRef.current?.focus({ preventScroll: true });
  };

  return (
    <section className="panel scene-panel" aria-label="Scene">
      <div className="panel-head">
        <h2>Scene</h2>
        {model && <span className="count" title={model.name}>{model.name}</span>}
      </div>
      <label className="search">
        <Search size={13} />
        <input placeholder="Search objects" value={query} onChange={(e) => setQuery(e.currentTarget.value)} />
        {query ? <button className="icon-btn icon-btn--bare xs" aria-label="Clear search" onClick={() => setQuery('')}><X size={12} /></button> : <kbd>/</kbd>}
      </label>
      <div ref={treeRef} className="tree" role="tree" aria-label="Scene objects" tabIndex={0}
        aria-activedescendant={activeRow && rows.indexOf(activeRow) >= window.start && rows.indexOf(activeRow) < window.end ? rowId(activeRow.key) : undefined}
        onKeyDown={onKeyDown} onScroll={(e) => setViewport({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}>
        {rows.length === 0 && <div className="tree-empty">{query ? 'No matching objects' : 'Nothing loaded yet'}</div>}
        <div className="tree-space" role="presentation" style={{ height: rows.length * TREE_ROW_HEIGHT }}>
          {rows.slice(window.start, window.end).map((row, offset) => {
            const { node, depth, material } = row;
            if (material) {
              const selected = selection.materialId === material.id && selection.objectId === node.id;
              // The mesh row carries the selection; the active material is marked, not filled.
              return (
                <div
                  key={row.key}
                  role="treeitem"
                  id={rowId(row.key)}
                  aria-level={depth + 1} aria-posinset={row.position} aria-setsize={row.siblings}
                  data-focused={row.key === activeRow?.key || undefined}
                  aria-selected={selected}
                  className="tree-row material"
                  data-current={selected || undefined}
                  data-hidden={!node.visible || undefined}
                  style={{ paddingLeft: 2 + depth * 14, top: (window.start + offset) * TREE_ROW_HEIGHT }}
                  onClick={() => { activate(row.key); getEngine()?.selectMaterial(material.id, node.id); }}
                >
                  <span className="chev" />
                  <span className="ico"><i className="swatch" style={{ background: material.color }} /></span>
                  <span className="label">{material.name}</span>
                  <span className="meta">material</span>
                  <span className="eye" />
                </div>
              );
            }
            const Icon = ICONS[node.kind];
            const selected = selection.objectId === node.id;
            const isCollapsed = !row.expanded;
            return (
              <div
                key={row.key}
                role="treeitem"
                id={rowId(row.key)}
                aria-level={depth + 1} aria-posinset={row.position} aria-setsize={row.siblings}
                data-focused={row.key === activeRow?.key || undefined}
                aria-selected={selected}
                aria-expanded={row.hasChildren ? !isCollapsed : undefined}
                className={`tree-row ${node.kind}`}
                data-selected={selected || undefined}
                data-ancestor={ancestors.has(node.id) || undefined}
                data-hidden={!node.visible || undefined}
                data-collapsed={isCollapsed || undefined}
                style={{ paddingLeft: 2 + depth * 14, top: (window.start + offset) * TREE_ROW_HEIGHT }}
                onClick={() => { activate(row.key); getEngine()?.select(node.id, node.kind === 'mesh' ? undefined : null); }}
              >
                <span className="chev">
                  {row.hasChildren && (
                    <button aria-label={isCollapsed ? 'Expand' : 'Collapse'} tabIndex={-1} onClick={(e) => { e.stopPropagation(); activate(row.key); toggle(row); }}>
                      <ChevronDown size={13} />
                    </button>
                  )}
                </span>
                <span className="ico"><Icon size={13} /></span>
                <span className="label">{node.name}</span>
                <span className="meta">{node.kind === 'mesh' ? formatCount(node.triangles) : node.kind === 'group' ? node.children.length || '' : node.kind}</span>
                {node.kind === 'camera' && <button
                  className="tree-camera-action"
                  aria-label={`Apply camera ${node.name}`}
                  title={`Apply camera ${node.name}`}
                  onClick={(e) => { e.stopPropagation(); getEngine()?.applyModelCamera(node.id); }}
                  onKeyDown={(e) => e.stopPropagation()}
                ><Video size={13} /></button>}
                <button
                  className="eye"
                  aria-label={node.visible ? `Hide ${node.name}` : `Show ${node.name}`}
                  tabIndex={-1}
                  onClick={(e) => { e.stopPropagation(); getEngine()?.setVisible(node.id, !node.visible); }}
                >
                  {node.visible ? <Eye size={13} /> : <EyeOff size={13} />}
                </button>
              </div>
            );
          })}
        </div>
      </div>
      <div className="scene-foot">
        <div><b>{info.meshes}</b><span>meshes</span></div>
        <div><b>{formatCount(info.triangles)}</b><span>triangles</span></div>
        <div><b>{info.materials}</b><span>materials</span></div>
      </div>
    </section>
  );
}
