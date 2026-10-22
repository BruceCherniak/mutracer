import type { TreeNode } from '../store';

export const TREE_ROW_HEIGHT = 28;

export interface TreeRow {
  key: string;
  node: TreeNode;
  depth: number;
  material?: TreeNode['materials'][number];
  parentKey?: string;
  position: number;
  siblings: number;
  hasChildren: boolean;
  expanded: boolean;
}

export function indexTree(tree: TreeNode[]) {
  const index = new Map<string, { node: TreeNode; parentId?: string; depth: number }>();
  const visit = (nodes: TreeNode[], depth: number, parentId?: string) => {
    for (const node of nodes) {
      index.set(node.id, { node, parentId, depth });
      visit(node.children, depth + 1, node.id);
    }
  };
  visit(tree, 0);
  return index;
}

export function treeAncestors(index: ReturnType<typeof indexTree>, id: string | null) {
  const path: string[] = [];
  let parentId = id ? index.get(id)?.parentId : undefined;
  while (parentId) {
    path.push(parentId);
    parentId = index.get(parentId)?.parentId;
  }
  return path;
}

export function flattenTree(tree: TreeNode[], collapsed: Record<string, boolean>, query: string): TreeRow[] {
  const q = query.trim().toLowerCase();
  const matches = new Set<string>();
  // One traversal for search, even when many ancestors contain the same match.
  const match = (node: TreeNode): boolean => {
    const childrenMatch = node.children.map(match).some(Boolean);
    const found = childrenMatch || node.name.toLowerCase().includes(q) || node.materials.some((m) => m.name.toLowerCase().includes(q));
    if (found) matches.add(node.id);
    return found;
  };
  if (q) tree.forEach(match);
  const rows: TreeRow[] = [];
  const walk = (nodes: TreeNode[], depth: number, parentKey?: string, materialOffset = 0) => {
    const visible = q ? nodes.filter((node) => matches.has(node.id)) : nodes;
    visible.forEach((node, i) => {
      const hasChildren = node.children.length > 0 || node.materials.length > 0;
      // Material rows stay closed until their mesh is explicitly expanded.
      const expanded = hasChildren && !(collapsed[node.id] ?? (!q && (node.materials.length > 0 || depth >= 2)));
      rows.push({ key: node.id, node, depth, parentKey, position: materialOffset + i + 1,
        siblings: materialOffset + visible.length, hasChildren, expanded });
      if (!expanded) return;
      const children = q ? node.children.filter((child) => matches.has(child.id)) : node.children;
      node.materials.forEach((material, j) => rows.push({ key: `${node.id}:${material.id}`, node, material,
        depth: depth + 1, parentKey: node.id, position: j + 1, siblings: node.materials.length + children.length,
        hasChildren: false, expanded: false }));
      walk(children, depth + 1, node.id, node.materials.length);
    });
  };
  walk(tree, 0);
  return rows;
}

/** Clamp after filtering/collapsing so a stale scroll offset never yields a blank list. */
export function treeWindow(count: number, scrollTop: number, height: number, overscan = 6) {
  const top = Math.max(0, Math.min(scrollTop, count * TREE_ROW_HEIGHT - height));
  return {
    top,
    start: Math.max(0, Math.floor(top / TREE_ROW_HEIGHT) - overscan),
    end: Math.min(count, Math.ceil((top + height) / TREE_ROW_HEIGHT) + overscan)
  };
}

export function revealTreeRow(index: number, scrollTop: number, height: number) {
  const top = index * TREE_ROW_HEIGHT;
  return top < scrollTop ? top : Math.max(scrollTop, top + TREE_ROW_HEIGHT - height);
}
