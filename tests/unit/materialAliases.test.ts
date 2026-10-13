import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import Material, { type OpenPBRMaterialParams, materialKeys, materialParamKeys, materialTextureKeys, getMaterialHashKey } from '../../src/scene/OpenPBRMaterial';
import MaterialTable from '../../src/renderer/MaterialTable';
import { MaterialChangeTracker } from '../../src/renderer/materialChanges';
import { fromTHREEScene, THREESync } from '../../src/util/fromTHREE';
import Engine from '../../src/Engine';

// Independent public mapping contract, not derived from the implementation table.
const entries = [
  ['specularRoughnessAnisotropy', 'specularAnisotropy'],
  ['coatRoughnessAnisotropy', 'coatAnisotropy'],
  ['subsurfaceScatterAnisotropy', 'subsurfaceAnisotropy'],
  ['geometryOpacity', 'opacity'],
  ['geometryThinWalled', 'thinWalled']
] as const;
const value = (name: string) => name === 'geometryThinWalled' ? true : .4;
function sourceScene(params: OpenPBRMaterialParams) {
  const source = new THREE.MeshPhysicalMaterial({transmission: .6}); source.userData.mutracerOpenPBR = params;
  const scene = new THREE.Scene(); scene.add(new THREE.Mesh(new THREE.BoxGeometry(), source)); return {scene, source};
}
describe('OpenPBR compatibility aliases', () => {
  it.each(entries)('%s shares constructor, hash, packing and both writes with %s', (alias, old) => {
    const v = value(alias), modern = new Material({[alias]: v}), legacy = new Material({[old]: v});
    expect(modern[alias]).toBe(v); expect(modern[old]).toBe(v);
    expect(getMaterialHashKey(modern)).toBe(getMaterialHashKey(legacy));
    expect(new MaterialTable([modern], []).getBufferArray()).toEqual(new MaterialTable([legacy], []).getBufferArray());
    expect(new Material({[alias]: v, [old]: v})[alias]).toBe(v);
    expect(new Material({[alias]: undefined, [old]: v})[alias]).toBe(v);
    expect(() => new Material({[alias]: v, [old]: alias === 'geometryThinWalled' ? false : .5})).toThrow(new RegExp(alias + '.*' + old));
    expect(() => new Material({[old]: alias === 'geometryThinWalled' ? false : .5, [alias]: v})).toThrow(/Conflicting/);
    Object.assign(modern, {[old]: alias === 'geometryThinWalled' ? false : .7}); expect(modern[alias]).toBe(modern[old]);
    const tracker = new MaterialChangeTracker(); tracker.capture([modern]); const version = modern.version;
    Object.assign(modern, {[alias]: v}); modern.markUpdated(); expect(modern[old]).toBe(v); expect(modern.version).toBe(version+1);
    expect(tracker.classify([modern])).toEqual({level: 'params', emission: false, emissiveMap: false});
  });
  it('keeps aliases out of keys, JSON, snapshots and parameter enumeration', () => {
    const m = new Material();
    for(const [alias,old] of entries) {
      expect(Object.keys(m)).toContain(old); expect(Object.keys(m)).not.toContain(alias);
      expect(JSON.parse(JSON.stringify(m))).not.toHaveProperty(alias);
      expect(materialKeys).not.toContain(alias); expect(materialParamKeys).not.toContain(alias); expect(materialTextureKeys).not.toContain(alias);
    }
    // These indices and stored names are the pre-alias schema contract.
    expect(materialKeys.filter(k => entries.some(([,old]) => old === k))).toEqual(['specularAnisotropy','subsurfaceAnisotropy','coatAnisotropy','opacity','thinWalled']);
    expect(new Material()).toMatchObject({specularRoughnessAnisotropy:0,coatRoughnessAnisotropy:0,subsurfaceScatterAnisotropy:0,geometryOpacity:1,geometryThinWalled:false});
  });
  it.each(entries)('normalizes %s metadata and rejects conflicting %s', (alias,old) => {
    const v=value(alias), a=sourceScene({[alias]:v}), b=sourceScene({[old]:v});
    const modern=fromTHREEScene(a.scene).meshes[0].materials[0],legacy=fromTHREEScene(b.scene).meshes[0].materials[0];
    expect(modern[alias]).toBe(v);expect(getMaterialHashKey(modern)).toBe(getMaterialHashKey(legacy));
    a.source.userData.mutracerOpenPBR = {[alias]: v, [old]: v};
    expect(getMaterialHashKey(fromTHREEScene(a.scene).meshes[0].materials[0])).toBe(getMaterialHashKey(legacy));
    a.source.userData.mutracerOpenPBR={[old]:alias==='geometryThinWalled'?false:.5,[alias]:v};
    expect(()=>fromTHREEScene(a.scene)).toThrow(/Conflicting/);
    const sync=new THREESync(new Engine({canvas:{width:1,height:1} as HTMLCanvasElement}),{scene:b.scene});sync.update();const m=sync.scene!.meshes[0].materials[0];const version=m.version;
    b.source.userData.mutracerOpenPBR={[alias]:alias==='geometryThinWalled'?false:.7};sync.update();
    expect(m).toBe(sync.scene!.meshes[0].materials[0]);expect(m[old]).toBe(alias==='geometryThinWalled'?false:.7);expect(m.version).toBeGreaterThan(version);
  });
});
