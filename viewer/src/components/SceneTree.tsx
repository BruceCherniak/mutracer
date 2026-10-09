import { useMemo, useState, type KeyboardEvent } from 'react';
import { Box, Camera, ChevronDown, Eye, EyeOff, Folder, Lightbulb, Search, X } from 'lucide-react';
import { useViewer, type TreeNode } from '../store';
import { getEngine } from '../engine/ViewerEngine';

const ICONS = { group: Folder, mesh: Box, light: Lightbulb, camera: Camera };

interface Row {
  key: string;
  node: TreeNode;
  depth: number;
  material?: TreeNode['materials'][number];
  hasChildren: boolean;
}

function formatCount(n: number) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
}

function matches(node: TreeNode, query: string): boolean {
  return node.name.toLowerCase().includes(query) ||
    node.materials.some((m) => m.name.toLowerCase().includes(query)) ||
    node.children.some((c) => matches(c, query));
}

export function SceneTree() {
  const tree = useViewer((s) => s.tree);
  const info = useViewer((s) => s.sceneInfo);
  const model = useViewer((s) => s.model);
  const selection = useViewer((s) => s.selection);
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const rows = useMemo(() => {
    const out: Row[] = [];
    const q = query.trim().toLowerCase();
    const walk = (node: TreeNode, depth: number) => {
      if (q && !matches(node, q)) return;
      // Single-material meshes show their material inline; deeper levels start collapsed.
      const showMaterials = node.materials.length > 0;
      const hasChildren = node.children.length > 0 || showMaterials;
      out.push({ key: node.id, node, depth, hasChildren });
      const isCollapsed = collapsed[node.id] ?? (!q && depth >= 2);
      if (isCollapsed) return;
      if (showMaterials) {
        for (const material of node.materials) {
          out.push({ key: `${node.id}:${material.id}`, node, depth: depth + 1, material, hasChildren: false });
        }
      }
      node.children.forEach((child) => walk(child, depth + 1));
    };
    tree.forEach((node) => walk(node, 0));
    return out;
  }, [tree, query, collapsed]);

  const ancestors = useMemo(() => {
    const set = new Set<string>();
    const find = (node: TreeNode, path: string[]): boolean => {
      if (node.id === selection.objectId) {
        path.forEach((id) => set.add(id));
        return true;
      }
      return node.children.some((c) => find(c, [...path, node.id]));
    };
    tree.forEach((n) => find(n, []));
    return set;
  }, [tree, selection.objectId]);

  const toggle = (id: string, depth: number) =>
    setCollapsed((c) => ({ ...c, [id]: !(c[id] ?? depth >= 2) }));

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]')];
    const index = items.indexOf(document.activeElement as HTMLElement);
    items[Math.min(items.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
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
      <div className="tree" role="tree" aria-label="Scene objects" onKeyDown={onKeyDown}>
        {rows.length === 0 && <div className="tree-empty">{query ? 'No matching objects' : 'Nothing loaded yet'}</div>}
        {rows.map((row) => {
          const { node, depth, material } = row;
          if (material) {
            const selected = selection.materialId === material.id && selection.objectId === node.id;
            // The mesh row carries the selection; the active material is marked, not filled.
            return (
              <div
                key={row.key}
                role="treeitem"
                tabIndex={0}
                aria-selected={selected}
                className="tree-row material"
                data-current={selected || undefined}
                data-hidden={!node.visible || undefined}
                style={{ paddingLeft: 2 + depth * 14 }}
                onClick={() => getEngine()?.selectMaterial(material.id, node.id)}
                onKeyDown={(e) => e.key === 'Enter' && getEngine()?.selectMaterial(material.id, node.id)}
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
          const isCollapsed = collapsed[node.id] ?? (!query && depth >= 2);
          return (
            <div
              key={row.key}
              role="treeitem"
              tabIndex={0}
              aria-selected={selected}
              aria-expanded={row.hasChildren ? !isCollapsed : undefined}
              className={`tree-row ${node.kind}`}
              data-selected={selected || undefined}
              data-ancestor={ancestors.has(node.id) || undefined}
              data-hidden={!node.visible || undefined}
              data-collapsed={isCollapsed || undefined}
              style={{ paddingLeft: 2 + depth * 14 }}
              onClick={() => getEngine()?.select(node.id, node.kind === 'mesh' ? undefined : null)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') getEngine()?.select(node.id);
                if ((e.key === 'ArrowRight' && isCollapsed) || (e.key === 'ArrowLeft' && !isCollapsed)) toggle(node.id, depth);
              }}
            >
              <span className="chev">
                {row.hasChildren && (
                  <button aria-label={isCollapsed ? 'Expand' : 'Collapse'} tabIndex={-1} onClick={(e) => { e.stopPropagation(); toggle(node.id, depth); }}>
                    <ChevronDown size={13} />
                  </button>
                )}
              </span>
              <span className="ico"><Icon size={13} /></span>
              <span className="label">{node.name}</span>
              <span className="meta">{node.kind === 'mesh' ? formatCount(node.triangles) : node.kind === 'group' ? node.children.length || '' : node.kind}</span>
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
      <div className="scene-foot">
        <div><b>{info.meshes}</b><span>meshes</span></div>
        <div><b>{formatCount(info.triangles)}</b><span>triangles</span></div>
        <div><b>{info.materials}</b><span>materials</span></div>
      </div>
    </section>
  );
}
