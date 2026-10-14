import {describe, expect, it} from 'vitest';
import Material, {getMaterialHashKey} from '../../src/scene/OpenPBRMaterial';
import Texture from '../../src/scene/Texture';
import MaterialTable from '../../src/renderer/MaterialTable';
import {MaterialChangeTracker} from '../../src/renderer/materialChanges';
import {WGPU_SCENE_FEATURE_BITS} from '../../src/renderer/WGPUSceneFeatures';
import {createPlaneGeometry} from '../../src/util/commonGeometry';
import {GeometryAttribute} from '../../src/main';
import Mesh from '../../src/scene/Mesh';
import {updateMeshInstances} from '../../src/renderer/prepareMeshBVH';
import {updatePreparedGeometries} from '../../src/renderer/geometryUpdates';
import * as THREE from 'three';
import {fromTHREEScene} from '../../src/util/fromTHREE';

describe('anisotropy direction contracts', () => {
  it('packs the reserved fields without growing stride or erasing the atlas index on parameter edits', () => {
    const image = new Texture({width:1,height:1,data:new Uint8Array([255,128,200,255])});
    image.uvChannel=1; const material=new Material({anisotropyMap:image,specularAnisotropyRotation:.7,coatAnisotropyRotation:-.2});
    const table=new MaterialTable([material,new Material()],[]);const packed=table.getBufferArray();
    expect(packed.length).toBe(208);expect(packed[96]).toBe(0);expect(packed[97]).toBeCloseTo(.7);expect(packed[100]).toBeCloseTo(-.2);
    expect(packed[200]).toBe(-1);expect(table.defines.NUM_ANISOTROPY_MAPS).toBe(1);expect(table.bufferData.mapUvChannel).toEqual([1]);
    material.specularAnisotropyRotation=1;table.repackParams([material,new Material()]);expect(table.getBufferArray()[96]).toBe(0);
    expect(WGPU_SCENE_FEATURE_BITS.USE_ANISOTROPY_MAPS).toBe(2**22);
  });
  it('classifies rotations as parameters and direction texture changes as texture updates', () => {
    const m=new Material(),tracker=new MaterialChangeTracker();tracker.capture([m]);const hash=getMaterialHashKey(m);
    m.coatAnisotropyRotation=1;expect(tracker.classify([m]).level).toBe('params');expect(getMaterialHashKey(m)).not.toBe(hash);
    tracker.capture([m]);m.anisotropyMap=new Texture({width:1,height:1,data:new Uint8Array(4)});expect(tracker.classify([m]).level).toBe('textures');
    tracker.capture([m]);m.anisotropyMap.markUpdated();expect(tracker.classify([m]).level).toBe('textures');
    tracker.capture([m]);m.anisotropyMap=undefined;expect(tracker.classify([m]).level).toBe('textures');
  });
  it('preserves supplied tangent handedness through merging and partial geometry updates alongside XYZ inputs', () => {
    const a=createPlaneGeometry(),b=createPlaneGeometry();a.dynamic=true;
    a.tangent=new GeometryAttribute(Float32Array.from({length:a.vertexCount*4},(_,i)=>i%4===0?1:i%4===3?-1:0),4);
    b.tangent=new GeometryAttribute(Float32Array.from({length:b.vertexCount*3},(_,i)=>i%3===0?1:0),3);
    const p=updateMeshInstances([new Mesh(a,new Material()),new Mesh(b,new Material())]);expect(p.geometry.tangent!.itemSize).toBe(4);
    expect(Array.from(p.geometry.tangent!.array.slice(0,4))).toEqual([1,0,0,-1]);expect(p.geometry.tangent!.array[a.vertexCount*4+3]).toBe(2);
    a.tangent.array[3]=1;a.markUpdated();updatePreparedGeometries(p,new Set([a]));expect(p.geometry.tangent!.array[3]).toBe(1);
  });
  it('accepts native metadata direction textures and rotations without mutating the image', () => {
    const tex=new THREE.Texture();tex.channel=1;
    const source=new THREE.MeshPhysicalMaterial();source.userData.mutracerOpenPBR={anisotropyMap:tex,specularAnisotropyRotation:-.4,coatAnisotropyRotation:.9};
    const scene=new THREE.Scene();scene.add(new THREE.Mesh(new THREE.PlaneGeometry(),source));const m=fromTHREEScene(scene).meshes[0].materials[0];
    expect(m.anisotropyMap?.uvChannel).toBe(1);expect(m.specularAnisotropyRotation).toBe(-.4);expect(m.coatAnisotropyRotation).toBe(.9);
  });
});
