import * as THREE from 'three';
import { expect, it } from 'vitest';
import Engine from '../../src/Engine';
import InstancedMesh from '../../src/scene/InstancedMesh';
import { getMeshBlasInput } from '../../src/renderer/prepareMeshBVH';
import { fromTHREEScene, THREESync } from '../../src/util/fromTHREE';

function triangle() {
  return new THREE.BufferGeometry().setAttribute('position',new THREE.Float32BufferAttribute([0,0,0,1,0,0,0,1,0],3))
    .setAttribute('uv',new THREE.Float32BufferAttribute([0,0,1,0,0,1],2));
}
function syncScene(scene:THREE.Scene) {
  const sync=new THREESync(new Engine({canvas:{width:1,height:1} as HTMLCanvasElement}),{scene}); sync.update();
  return sync as THREESync & {scene:NonNullable<THREESync['scene']>};
}

it.each([false,true])('reverses BackSide winding and generated normals without editing source storage (indexed=%s)', indexed => {
  const geometry=triangle(); if(indexed) geometry.setIndex([2,0,1]);
  const scene=new THREE.Scene(); scene.add(new THREE.Mesh(geometry,new THREE.MeshStandardMaterial({side:THREE.BackSide})));
  const mesh=fromTHREEScene(scene).meshes[0];
  expect(Array.from(mesh.geometry.indices.array)).toEqual(indexed?[2,1,0]:[0,2,1]);
  for(let i=0;i<3;i++) expect(mesh.geometry.normal.array[i*3+2]).toBe(-1);
  expect(mesh.materials[0].doubleSided).toBe(false);
  expect(geometry.index?Array.from(geometry.index.array):undefined).toEqual(indexed?[2,0,1]:undefined);
});

it.each([1,-1])('reverses authored normals and tangent handedness %s while retaining XYZ and UVs', sign => {
  const geometry=triangle(); geometry.setAttribute('normal',new THREE.Float32BufferAttribute([0,0,1,0,0,1,0,0,1],3));
  geometry.setAttribute('tangent',new THREE.Float32BufferAttribute([1,0,0,sign,1,0,0,sign,1,0,0,sign],4));
  const scene=new THREE.Scene(); scene.add(new THREE.Mesh(geometry,new THREE.MeshPhysicalMaterial({side:THREE.BackSide})));
  const converted=fromTHREEScene(scene).meshes[0].geometry;
  expect(converted.normal.array[2]).toBe(-1);
  expect(Array.from(converted.tangent!.array.slice(0,4))).toEqual([1,0,0,-sign]);
  expect(converted.uv!.array).toEqual(geometry.attributes.uv.array);
  expect(geometry.attributes.normal.getZ(0)).toBe(1); expect(geometry.attributes.tangent.getW(0)).toBe(sign);

});

it('retains separate side variants, shares FrontSide with DoubleSide, and synchronizes side edits', () => {
  const geometry=triangle(), front=new THREE.MeshStandardMaterial(), back=new THREE.MeshStandardMaterial({side:THREE.BackSide});
  const scene=new THREE.Scene(); scene.add(new THREE.Mesh(geometry,front),new THREE.Mesh(geometry,back),
    new THREE.Mesh(geometry,new THREE.MeshStandardMaterial({side:THREE.DoubleSide})),new THREE.Mesh(geometry,back));
  const sync=syncScene(scene), [a,b,c,d]=sync.scene.meshes;
  expect(a.geometry).toBe(c.geometry); expect(b.geometry).toBe(d.geometry); expect(b.geometry).not.toBe(a.geometry);
  expect(c.materials[0].doubleSided).toBe(true);
  back.side=THREE.FrontSide; sync.update(); expect(b.geometry).toBe(a.geometry); expect(d.geometry).toBe(a.geometry);
  front.side=THREE.BackSide; sync.update(); expect(a.geometry.normal.array[2]).toBe(-1);
  expect(b.geometry.normal.array[2]).toBe(1); sync.dispose();
});

it('separates equal-range material groups inside instanced batches', () => {
  const geometry=triangle(); geometry.addGroup(0,3,0); geometry.addGroup(0,3,1);
  const scene=new THREE.Scene(); scene.add(new THREE.InstancedMesh(geometry,[new THREE.MeshBasicMaterial(),new THREE.MeshBasicMaterial({side:THREE.BackSide})],2));
  const [front,back]=fromTHREEScene(scene).meshes as InstancedMesh[];
  expect(front).toBeInstanceOf(InstancedMesh); expect(back.count).toBe(2);
  expect(Array.from(front.geometry.indices.array)).toEqual([0,1,2]); expect(Array.from(back.geometry.indices.array)).toEqual([0,2,1]);
});

it('refreshes morph normals and retained side variants at the current pose', () => {
  const geometry=triangle(); geometry.setAttribute('normal',new THREE.Float32BufferAttribute([0,0,1,0,0,1,0,0,1],3));
  geometry.setAttribute('tangent',new THREE.Float32BufferAttribute([1,0,0,1,1,0,0,1,1,0,0,1],4));
  const position=geometry.attributes.position.clone(); for(let i=0;i<3;i++) position.setX(i,position.getX(i)+1);
  geometry.morphAttributes.position=[position]; geometry.morphAttributes.normal=[new THREE.Float32BufferAttribute([0,1,0,0,1,0,0,1,0],3)];
  const material=new THREE.MeshStandardMaterial({side:THREE.BackSide}), mesh=new THREE.Mesh(geometry,material), scene=new THREE.Scene(); scene.add(mesh);
  mesh.morphTargetInfluences![0]=.5; const sync=syncScene(scene), converted=sync.scene.meshes[0], back=converted.geometry;
  expect(Array.from(back.normal.array.slice(1,3))).toEqual([-.5,-.5]); expect(back.tangent!.array[3]).toBe(-1);
  material.side=THREE.FrontSide; mesh.morphTargetInfluences![0]=.75; sync.update();
  expect(converted.geometry.normal.array[1]).toBe(.75); expect(converted.geometry.tangent!.array[3]).toBe(1);
  material.side=THREE.BackSide; sync.update(); expect(converted.geometry).toBe(back);
  expect(back.position.array[0]).toBe(.75); expect(back.normal.array[1]).toBe(-.75); expect(back.tangent!.array[3]).toBe(-1);
  const version=back.version; sync.update(); expect(back.version).toBe(version); sync.dispose();
});

it('keeps skinned BackSide normals and tangent signs through pose edits', () => {
  const geometry=new THREE.PlaneGeometry(); geometry.computeTangents(); const count=geometry.attributes.position.count;
  geometry.setAttribute('skinIndex',new THREE.Uint16BufferAttribute(new Uint16Array(count*4),4));
  const weights=new Float32Array(count*4); for(let i=0;i<count;i++) weights[i*4]=1;
  geometry.setAttribute('skinWeight',new THREE.Float32BufferAttribute(weights,4));
  const mesh=new THREE.SkinnedMesh(geometry,new THREE.MeshStandardMaterial({side:THREE.BackSide})), bone=new THREE.Bone();
  mesh.add(bone); mesh.bind(new THREE.Skeleton([bone])); const scene=new THREE.Scene(); scene.add(mesh);
  const sync=syncScene(scene), converted=sync.scene.meshes[0].geometry;
  bone.rotation.y=.6; sync.update();
  expect(converted.normal.array[0]).toBeCloseTo(-Math.sin(.6)); expect(converted.normal.array[2]).toBeCloseTo(-Math.cos(.6));
  expect(converted.tangent!.array[0]).toBeCloseTo(Math.cos(.6)); expect(converted.tangent!.array[3]).toBe(-1); sync.dispose();
});

it('regenerates missing normals after morphing reversed triangles', () => {
  const geometry=triangle(), target=geometry.attributes.position.clone(); target.setZ(2,1);
  geometry.morphAttributes.position=[target]; const mesh=new THREE.Mesh(geometry,new THREE.MeshStandardMaterial({side:THREE.BackSide}));
  const scene=new THREE.Scene(); scene.add(mesh); const sync=syncScene(scene), converted=sync.scene.meshes[0].geometry;
  const normal=converted.normal, array=normal.array;
  mesh.morphTargetInfluences![0]=1; sync.update();
  expect(converted.normal.array[1]).toBeCloseTo(Math.SQRT1_2); expect(converted.normal.array[2]).toBeCloseTo(-Math.SQRT1_2);
  expect(converted.normal).toBe(normal); expect(converted.normal.array).toBe(array); sync.dispose();
});

it('keeps the source displacement direction and biased base position for BackSide', () => {
  const map=new THREE.DataTexture(new Float32Array([1,1,1,1]),1,1,THREE.RGBAFormat,THREE.FloatType);
  const geometry=new THREE.PlaneGeometry(), material=new THREE.MeshStandardMaterial({side:THREE.BackSide,displacementMap:map,displacementScale:.4,displacementBias:.2});
  const scene=new THREE.Scene(); scene.add(new THREE.Mesh(geometry,material)); const mesh=fromTHREEScene(scene).meshes[0];
  expect(mesh.materials[0].displacementScale).toBe(-.4); expect(mesh.materials[0].displacementBias).toBe(-.2);
  const prepared=getMeshBlasInput(mesh);
  expect(prepared.geometry.position.array[2]).toBeCloseTo(.2);
  expect(mesh.geometry.normal.array[2]*mesh.materials[0].displacementScale).toBeCloseTo(.4);
  expect(material.displacementScale).toBe(.4); expect(material.displacementBias).toBe(.2);
});
