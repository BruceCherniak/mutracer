import { describe, expect, it } from 'vitest';
import type { TreeNode } from '../src/store';
import { flattenTree, indexTree, revealTreeRow, treeAncestors, treeWindow, TREE_ROW_HEIGHT } from '../src/components/sceneTreeRows';

const mesh = (id: string): TreeNode => ({ id, name: `Mesh ${id}`, kind: 'mesh', visible: true, triangles: 12,
  children: [], materials: [{ id: `mat-${id}`, name: `Material ${id}`, color: '#fff' }] });
const group = (id: string, children: TreeNode[]): TreeNode => ({ ...mesh(id), kind: 'group', materials: [], children });

describe('virtual scene tree', () => {
  it('keeps materials closed at every depth until a mesh is expanded', () => {
    const tree = [mesh('root'), group('group', [mesh('child')])];
    expect(flattenTree(tree, {}, '').map((r) => r.key)).toEqual(['root', 'group', 'child']);
    expect(flattenTree(tree, { child: false }, '').map((r) => r.key)).toEqual(['root', 'group', 'child', 'child:mat-child']);
  });

  it('reveals the selected descendant without opening its materials or unrelated branches', () => {
    const tree = [group('root', [group('branch', [group('nested', [mesh('selected')])]), group('other', [mesh('unrelated')])])];
    const path = treeAncestors(indexTree(tree), 'selected');
    expect(path).toEqual(['nested', 'branch', 'root']);
    const rows = flattenTree(tree, { other: true, ...Object.fromEntries(path.map((id) => [id, false])) }, '');
    expect(rows.map((r) => r.key)).toEqual(['root', 'branch', 'nested', 'selected', 'other']);
    expect(rows[3]).toMatchObject({ depth: 3, parentKey: 'nested', expanded: false });
    expect(treeAncestors(indexTree(tree), 'missing')).toEqual([]);
  });

  it('finds deeply nested material matches and retains the ancestor path', () => {
    const tree = [group('root', [group('nested', [mesh('needle'), mesh('other')])]), mesh('elsewhere')];
    const rows = flattenTree(tree, {}, '  MATERIAL NEEDLE  ');
    expect(rows.map((r) => r.key)).toEqual(['root', 'nested', 'needle', 'needle:mat-needle']);
    expect(rows[2]).toMatchObject({ position: 1, siblings: 1, depth: 2 });
    expect(flattenTree(tree, {}, 'missing')).toEqual([]);
  });

  it('exposes consistent sibling positions for materials and object children', () => {
    const parent = mesh('parent');
    parent.children = [mesh('child')];
    const rows = flattenTree([parent], { parent: false }, '');
    expect(rows.slice(1).map((r) => [r.position, r.siblings, r.parentKey])).toEqual([[1, 2, 'parent'], [2, 2, 'parent']]);
  });

  it('bounds mounted rows for large scenes at the beginning, middle and end', () => {
    const rows = flattenTree(Array.from({ length: 10000 }, (_, i) => mesh(String(i))), {}, '');
    expect(rows).toHaveLength(10000);
    for (const top of [0, 140000, 1e9]) {
      const range = treeWindow(rows.length, top, 560);
      expect(range.end - range.start).toBeLessThanOrEqual(32);
      expect(range.start).toBeGreaterThanOrEqual(0);
      expect(range.end).toBeLessThanOrEqual(rows.length);
    }
  });

  it('scrolls a newly selected row into view with the smallest necessary movement', () => {
    const top = revealTreeRow(9999, 0, 560);
    const range = treeWindow(10000, top, 560);
    expect(top).toBe(10000 * TREE_ROW_HEIGHT - 560);
    expect(range.end).toBe(10000);
    expect(range.start).toBeLessThan(9999);
    expect(revealTreeRow(9980, top, 560)).toBe(top);
    expect(revealTreeRow(0, top, 560)).toBe(0);
  });

  it('clamps stale scroll offsets after collapsing, filtering and emptying the tree', () => {
    expect(treeWindow(2, 90000, 560)).toEqual({ top: 0, start: 0, end: 2 });
    expect(treeWindow(0, 90000, 560)).toEqual({ top: 0, start: 0, end: 0 });
    expect(treeWindow(10000, 90000, 0).end - treeWindow(10000, 90000, 0).start).toBeLessThanOrEqual(13);
  });
});
