import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import Material, { getMaterialHashKey } from '../../src/scene/OpenPBRMaterial';
import Texture from '../../src/scene/Texture';
import MaterialTable from '../../src/renderer/MaterialTable';
import { MaterialChangeTracker } from '../../src/renderer/materialChanges';
import { fromTHREEScene, THREESync } from '../../src/util/fromTHREE';
import Engine from '../../src/Engine';

const tex = () => new Texture({width: 1, height: 1, data: new Uint8Array([0,128,255,64])});
function convert(source: THREE.MeshPhysicalMaterial) {
  const scene = new THREE.Scene(); scene.add(new THREE.Mesh(new THREE.BoxGeometry(), source));
  return fromTHREEScene(scene).meshes[0].materials[0];
}
describe('thin-film texture parameters', () => {
  it.each(['r', 'g', 'b', 'a'] as const)('packs channel %s and independent endpoints without sorting', channel => {
    const m = new Material({thinFilmMap: tex(), thinFilmThickness: 0, thinFilmThicknessMinimum: .4, thinFilmMapChannel: channel});
    const table = new MaterialTable([m], []), p = table.getBufferArray();
    expect(p[22]).toBe(0); expect(p[102]).toBeCloseTo(.4); expect(p[103]).toBe(['r','g','b','a'].indexOf(channel));
    m.thinFilmThicknessMinimum = .2; table.repackParams([m]);
    expect(table.getBufferArray()[102]).toBeCloseTo(.2);
  });
  it('clamps nonfinite and negative endpoints separately and rejects invalid channels', () => {
    const m = new Material({thinFilmThickness: -1, thinFilmThicknessMinimum: Infinity});
    let p = new MaterialTable([m], []).getBufferArray(); expect(p[22]).toBe(0); expect(p[102]).toBe(0);
    m.thinFilmThickness = NaN; m.thinFilmThicknessMinimum = -1;
    p = new MaterialTable([m], []).getBufferArray(); expect(p[22]).toBe(.5); expect(p[102]).toBe(0);
    expect(() => new Material({thinFilmMapChannel: 'x' as 'r'})).toThrow(/thinFilmMapChannel/);
    m.thinFilmMapChannel = 'x' as 'r'; expect(() => new MaterialTable([m], [])).toThrow(/thinFilmMapChannel/);
    const source = new THREE.MeshPhysicalMaterial(); source.userData.mutracerOpenPBR = {thinFilmMapChannel: 'x'};
    expect(() => convert(source)).toThrow(/thinFilmMapChannel/);
  });
  it('classifies range/channel edits as parameters and extends the hash', () => {
    const m = new Material({thinFilmMap: tex()}), tracker = new MaterialChangeTracker();
    tracker.capture([m]); const hash = getMaterialHashKey(m);
    m.thinFilmThicknessMinimum = .1; m.thinFilmMapChannel = 'g'; m.markUpdated();
    expect(getMaterialHashKey(m)).not.toBe(hash);
    expect(tracker.classify([m])).toEqual({level: 'params', emission: false, emissiveMap: false});
  });
  it.each([[100,400],[400,100],[300,0],[250,250]])('imports nm endpoints %s/%s with the G channel', (min, max) => {
    const source = new THREE.MeshPhysicalMaterial(); source.iridescenceThicknessRange = [min,max];
    source.iridescenceThicknessMap = new THREE.Texture({width: 1,height: 1});
    const m = convert(source); expect(m.thinFilmThickness).toBe(max/1000);
    expect(m.thinFilmThicknessMinimum).toBe(min/1000); expect(m.thinFilmMapChannel).toBe('g');
  });
  it('uses maximum without a map, preserves the native R override, then applies explicit metadata', () => {
    const source = new THREE.MeshPhysicalMaterial(); source.iridescenceThicknessRange = [100,400];
    expect(convert(source)).toMatchObject({thinFilmThickness: .4, thinFilmThicknessMinimum: 0, thinFilmMapChannel: 'r'});
    const native = new THREE.Texture({width: 1,height: 1});
    source.iridescenceThicknessMap = new THREE.Texture({width: 1,height: 1}); source.userData.mutracerThinFilmMap = native;
    expect(convert(source)).toMatchObject({thinFilmThicknessMinimum: 0, thinFilmMapChannel: 'r'});
    source.userData.mutracerOpenPBR = {thinFilmThicknessMinimum: .2, thinFilmMapChannel: 'a', thinFilmMap: native};
    expect(convert(source)).toMatchObject({thinFilmThicknessMinimum: .2, thinFilmMapChannel: 'a'});
  });
  it('THREESync updates range parameters without copying or replacing the thickness texture', () => {
    const source = new THREE.MeshPhysicalMaterial(); source.iridescenceThicknessMap = new THREE.Texture({width: 1,height: 1});
    const scene = new THREE.Scene(); scene.add(new THREE.Mesh(new THREE.BoxGeometry(), source));
    const sync = new THREESync(new Engine({canvas: {width: 1,height: 1} as HTMLCanvasElement}), {scene});
    sync.update(); const m = sync.scene!.meshes[0].materials[0], texture = m.thinFilmMap, version = m.version;
    source.iridescenceThicknessRange = [300,0]; sync.update();
    expect(m).toBe(sync.scene!.meshes[0].materials[0]); expect(m.version).toBeGreaterThan(version);
    expect(m.thinFilmMap).toBe(texture); expect(m.thinFilmThicknessMinimum).toBe(.3); expect(m.thinFilmThickness).toBe(0);
  });
});
