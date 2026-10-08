import * as THREE from 'three';
import { expect, it, vi } from 'vitest';
import { THREESceneSync, fromTHREEScene } from '../../src/util/fromTHREE';

function skin(geometry = new THREE.BoxGeometry(1,2,1)) {
  const count = geometry.attributes.position.count;
  geometry.setAttribute('skinIndex',new THREE.Uint16BufferAttribute(new Uint16Array(count*4),4));
  const weights = new Float32Array(count*4); for (let i=0;i<count;i++) weights[i*4]=1;
  geometry.setAttribute('skinWeight',new THREE.Float32BufferAttribute(weights,4));
  const bone = new THREE.Bone(); const mesh = new THREE.SkinnedMesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>(geometry,new THREE.MeshStandardMaterial());
  mesh.add(bone); mesh.bind(new THREE.Skeleton([bone])); return {mesh,bone,geometry};
}
function compare(mesh: THREE.Mesh, sync: THREESceneSync) {
  const p = new THREE.Vector3();
  for (const converted of sync.scene.meshes) for (let i=0;i<mesh.geometry.attributes.position.count;i++) {
    mesh.getVertexPosition(i,p);
    for (let c=0;c<3;c++) expect(Math.abs(converted.geometry.position.array[i*3+c]-p.getComponent(c))).toBeLessThan(2e-6);
  }
}
it.each([false,true])('matches Three vertex positions for morph+skinning (relative=%s) and retains storage', relative => {
  const {mesh,bone,geometry}=skin();
  const target=geometry.attributes.position.clone();
  for(let i=0;i<target.count;i++) target.setXYZ(i,relative?.3:target.getX(i)+.3,relative?.1:target.getY(i)+.1,relative?-.2:target.getZ(i)-.2);
  geometry.morphAttributes.position=[target];geometry.morphTargetsRelative=relative;mesh.updateMorphTargets();mesh.morphTargetInfluences![0]=.7;
  const source=new THREE.Scene();source.add(mesh);const sync=new THREESceneSync(source);
  const g=sync.scene.meshes[0].geometry,array=g.position.array;
  bone.rotation.z=.8;bone.position.set(.2,.1,.3);expect(sync.update().content).toBe(true);compare(mesh,sync);
  expect(sync.scene.meshes[0].geometry).toBe(g);expect(g.position.array).toBe(array);expect(g.dynamic).toBe(true);
  const mark=vi.spyOn(g,'markUpdated');expect(sync.update().content).toBe(false);expect(mark).not.toHaveBeenCalled();
  (geometry.attributes.position as THREE.BufferAttribute).setX(0,.8);(geometry.attributes.position as THREE.BufferAttribute).needsUpdate=true;
  expect(sync.update().content).toBe(true);expect(sync.scene.meshes[0].geometry).toBe(g);compare(mesh,sync);
  target.setY(0,.4);target.needsUpdate=true;sync.update();compare(mesh,sync);
});
it('rotates normals and tangents by the skin matrix and normalizes them', () => {
  const {mesh,bone,geometry}=skin();
  const n=new Float32Array(geometry.attributes.position.count*3),t=new Float32Array(geometry.attributes.position.count*4);
  for(let i=0;i<geometry.attributes.position.count;i++){n.set([2,0,0],i*3);t.set([0,3,0,1],i*4)}
  geometry.setAttribute('normal',new THREE.Float32BufferAttribute(n,3));geometry.setAttribute('tangent',new THREE.Float32BufferAttribute(t,4));
  const source=new THREE.Scene();source.add(mesh);const sync=new THREESceneSync(source);bone.rotation.z=Math.PI/2;sync.update();
  const g=sync.scene.meshes[0].geometry;expect(g.normal.array[0]).toBeCloseTo(0);expect(g.normal.array[1]).toBeCloseTo(1);
  expect(g.tangent!.array[0]).toBeCloseTo(-1);expect(g.tangent!.array[1]).toBeCloseTo(0);
});
it('owns deformation geometry per mesh and calculates once for every material group', () => {
  const a=skin(),b=skin(a.geometry);a.mesh.material=[new THREE.MeshStandardMaterial(),new THREE.MeshStandardMaterial()];
  a.geometry.clearGroups();a.geometry.addGroup(0,18,0);a.geometry.addGroup(18,18,1);
  const source=new THREE.Scene();source.add(a.mesh,b.mesh);const sync=new THREESceneSync(source);
  const [first,second,third]=sync.scene.meshes;
  expect(first.geometry).not.toBe(second.geometry);expect(first.geometry).not.toBe(third.geometry);
  a.bone.rotation.x=.4;b.bone.rotation.x=-.3;sync.update();
  expect(first.geometry.position.array).toEqual(second.geometry.position.array);
  expect(first.geometry.position.array).not.toEqual(third.geometry.position.array);
  const once=fromTHREEScene(source);expect(once.meshes[0].geometry.dynamic).toBe(true);
});
it('applies morph normals without requiring a skeleton', () => {
  const geometry=new THREE.BoxGeometry();const target=geometry.attributes.normal.clone();
  for(let i=0;i<target.count;i++)target.setXYZ(i,0,1,0);
  geometry.morphAttributes.normal=[target];const mesh=new THREE.Mesh(geometry,new THREE.MeshStandardMaterial());mesh.morphTargetInfluences![0]=.5;
  const source=new THREE.Scene();source.add(mesh);const sync=new THREESceneSync(source);
  const g=sync.scene.meshes[0].geometry;
  expect(g.normal.array[0]).toBeCloseTo(.5);expect(g.normal.array[1]).toBeCloseTo(.5);
  const version=g.version;sync.update();expect(g.version).toBe(version);
});

it('matches mixed bone weights, nonidentity binding matrices and bind edits', () => {
  const geometry = new THREE.BoxGeometry();
  const count = geometry.attributes.position.count;
  const indices = new Uint16Array(count*4), weights = new Float32Array(count*4);
  for(let i=0;i<count;i++){indices.set([0,1,0,0],i*4);weights.set([.3,.7,0,0],i*4)}
  geometry.setAttribute('skinIndex',new THREE.Uint16BufferAttribute(indices,4));
  geometry.setAttribute('skinWeight',new THREE.Float32BufferAttribute(weights,4));
  const first = new THREE.Bone(),second = new THREE.Bone();first.add(second);second.position.y = .5;
  const mesh = new THREE.SkinnedMesh(geometry,new THREE.MeshStandardMaterial());mesh.add(first);
  mesh.bindMode = 'detached';mesh.bind(new THREE.Skeleton([first,second]),new THREE.Matrix4().makeTranslation(.1,.2,.3));
  const source = new THREE.Scene();source.add(mesh);const sync = new THREESceneSync(source);
  second.rotation.z = .7;first.rotation.x = -.3;sync.update();compare(mesh,sync);
  const version = sync.scene.meshes[0].geometry.version;
  mesh.bindMatrix.makeTranslation(.3,.2,.1);mesh.bindMatrixInverse.copy(mesh.bindMatrix).invert();
  sync.update();compare(mesh,sync);expect(sync.scene.meshes[0].geometry.version).toBe(version+1);
});
