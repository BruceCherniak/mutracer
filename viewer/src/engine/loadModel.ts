import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
// The bundled typings point at the uninstalled meshoptimizer package.
import * as meshopt from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { fetchWithProgress } from './fetchWithProgress';
import type { PathedFile } from './droppedFiles';

export { isHDRFile, isModelFile, readDroppedItems, toPathedFiles, type PathedFile } from './droppedFiles';

export interface LoadedModel {
  name: string;
  root: THREE.Object3D;
  animations: THREE.AnimationClip[];
  /** Releases blob URLs created for local files. */
  revoke(): void;
}

export type LoadProgress = (stage: 'download' | 'parse', loaded?: number, total?: number) => void;

let draco: DRACOLoader | undefined;
function createLoader(manager?: THREE.LoadingManager) {
  const loader = new GLTFLoader(manager);
  // three's DRACOLoader defaults to its bundled decoder, fetched only for Draco files.
  draco ??= new DRACOLoader();
  loader.setDRACOLoader(draco);
  loader.setMeshoptDecoder((meshopt as unknown as { MeshoptDecoder: Parameters<GLTFLoader['setMeshoptDecoder']>[0] }).MeshoptDecoder);
  return loader;
}

function parse(loader: GLTFLoader, data: ArrayBuffer, path: string) {
  return new Promise<{ scene: THREE.Group; animations: THREE.AnimationClip[] }>((resolve, reject) =>
    loader.parse(data, path, resolve, reject));
}

export async function loadModelFromURL(url: string, onProgress: LoadProgress, signal?: AbortSignal): Promise<LoadedModel> {
  const buffer = await fetchWithProgress(url, (loaded, total) => onProgress('download', loaded, total), signal);
  onProgress('parse');
  const base = new URL('.', new URL(url, location.href)).href;
  const gltf = await parse(createLoader(), buffer, base);
  const name = decodeURIComponent(url.split('?')[0].split('/').pop() || 'model');
  return { name, root: gltf.scene, animations: gltf.animations, revoke() {} };
}

/**
 * Loads a .glb, or a .gltf with its .bin and textures picked or dropped
 * together. Relative resource URIs are resolved against the dropped paths.
 */
export async function loadModelFromFiles(files: PathedFile[], onProgress: LoadProgress): Promise<LoadedModel> {
  const main = files.find((f) => f.path.toLowerCase().endsWith('.glb')) ??
    files.find((f) => f.path.toLowerCase().endsWith('.gltf'));
  if (!main) throw new Error('No .glb or .gltf file found');
  const mainDir = main.path.includes('/') ? main.path.slice(0, main.path.lastIndexOf('/') + 1) : '';
  const blobs = new Map<string, string>();
  const created: string[] = [];
  for (const { file, path } of files) {
    if (file === main.file) continue;
    const url = URL.createObjectURL(file);
    created.push(url);
    const relative = path.startsWith(mainDir) ? path.slice(mainDir.length) : path;
    blobs.set(relative, url);
    if (!blobs.has(file.name)) blobs.set(file.name, url);
  }
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (url.startsWith('data:') || url.startsWith('blob:') || /^https?:/.test(url)) return url;
    const clean = decodeURIComponent(url.replace(/^\.\//, ''));
    return blobs.get(clean) ?? blobs.get(clean.split('/').pop()!) ?? url;
  });
  onProgress('parse');
  const gltf = await parse(createLoader(manager), await main.file.arrayBuffer(), '');
  return {
    name: main.file.name,
    root: gltf.scene,
    animations: gltf.animations,
    revoke: () => created.forEach((url) => URL.revokeObjectURL(url))
  };
}

/** Default scene: one sphere per OpenPBR feature, readable without a download. */
export function createMaterialSpheres(): LoadedModel {
  const root = new THREE.Group();
  root.name = 'Material spheres';
  const geometry = new THREE.SphereGeometry(0.42, 96, 48);
  const add = (name: string, material: THREE.MeshPhysicalMaterial, x: number, z: number) => {
    material.name = name;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.position.set(x, 0.42, z);
    root.add(mesh);
  };
  add('Ceramic', new THREE.MeshPhysicalMaterial({ color: 0xf2ece2, roughness: 0.25, clearcoat: 0.5, clearcoatRoughness: 0.05 }), -1.9, 0);
  add('Brushed gold', new THREE.MeshPhysicalMaterial({ color: 0xffc35a, metalness: 1, roughness: 0.28, anisotropy: 0.6 }), -0.95, 0);
  add('Glass', new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0, transmission: 1, ior: 1.5, thickness: 0.8, attenuationColor: 0x9fd4ff, attenuationDistance: 1.2 }), 0, 0);
  add('Car paint', new THREE.MeshPhysicalMaterial({ color: 0xa3140d, roughness: 0.45, metalness: 0.3, clearcoat: 1, clearcoatRoughness: 0.02 }), 0.95, 0);
  add('Velvet', new THREE.MeshPhysicalMaterial({ color: 0x2a0f45, roughness: 0.9, sheen: 1, sheenColor: 0xc49bff, sheenRoughness: 0.4 }), 1.9, 0);
  const iridescent = new THREE.MeshPhysicalMaterial({ color: 0x15161a, metalness: 0, roughness: 0.15, iridescence: 1, iridescenceIOR: 1.4, iridescenceThicknessRange: [300, 600] });
  add('Soap film', iridescent, -0.475, -1.05);
  const jade = new THREE.MeshPhysicalMaterial({ color: 0x5fae7f, roughness: 0.3 });
  jade.userData.mutracerOpenPBR = { subsurfaceWeight: 1, subsurfaceColor: [0.25, 0.62, 0.38], subsurfaceRadius: 0.25 };
  add('Jade', jade, 0.475, -1.05);
  return { name: 'Material spheres', root, animations: [], revoke() {} };
}
