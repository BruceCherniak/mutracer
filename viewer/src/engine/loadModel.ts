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
  /** Original files, including external buffers/textures, for reloads from OPFS. */
  source?: ModelSource;
  /** Releases blob URLs created for local files. */
  revoke(): void;
}

export interface ModelSource {
  files: PathedFile[];
  mainPath: string;
  base: string;
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
  const name = decodeURIComponent(url.split('?')[0].split('/').pop() || 'model');
  const mainPath = new URL(url, location.href).href;
  const files: PathedFile[] = [{ path: mainPath, file: new File([buffer], name) }];
  // glTF/GLB resources can be external even when the main file is binary.
  let jsonBytes = new Uint8Array(buffer);
  if (buffer.byteLength >= 20 && new DataView(buffer).getUint32(0, true) === 0x46546c67) {
    jsonBytes = new Uint8Array(buffer, 20, new DataView(buffer).getUint32(12, true));
  }
  const json = JSON.parse(new TextDecoder().decode(jsonBytes));
  const urls = new Set<string>();
  for (const resource of [...(json.buffers ?? []), ...(json.images ?? [])]) {
    if (typeof resource.uri === 'string' && !resource.uri.startsWith('data:')) urls.add(new URL(resource.uri, base).href);
  }
  await Promise.all([...urls].map(async (address) => {
    const bytes = await fetchWithProgress(address, undefined, signal);
    files.push({ path: address, file: new File([bytes], new URL(address).pathname.split('/').pop() || 'resource') });
  }));
  return loadModelFromSource({ files, mainPath, base }, onProgress);
}

/**
 * Loads a .glb, or a .gltf with its .bin and textures picked or dropped
 * together. Relative resource URIs are resolved against the dropped paths.
 */
export async function loadModelFromFiles(files: PathedFile[], onProgress: LoadProgress): Promise<LoadedModel> {
  const main = files.find((f) => f.path.toLowerCase().endsWith('.glb')) ??
    files.find((f) => f.path.toLowerCase().endsWith('.gltf'));
  if (!main) throw new Error('No .glb or .gltf file found');
  return loadModelFromSource({ files, mainPath: main.path, base: '' }, onProgress);
}

/** Parses the same bytes for downloaded, dropped and restored models. */
export async function loadModelFromSource(source: ModelSource, onProgress: LoadProgress): Promise<LoadedModel> {
  const { files, mainPath, base } = source;
  const main = files.find((file) => file.path === mainPath);
  if (!main) throw new Error('Missing main model file');
  const mainDir = main.path.includes('/') ? main.path.slice(0, main.path.lastIndexOf('/') + 1) : '';
  const blobs = new Map<string, string>();
  const created: string[] = [];
  for (const { file, path } of files) {
    if (file === main.file) continue;
    const url = URL.createObjectURL(file);
    created.push(url);
    const relative = path.startsWith(mainDir) ? path.slice(mainDir.length) : path;
    blobs.set(relative, url);
    blobs.set(path, url);
    if (!blobs.has(file.name)) blobs.set(file.name, url);
  }
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (blobs.has(url)) return blobs.get(url)!;
    if (url.startsWith('data:') || url.startsWith('blob:') || /^https?:/.test(url)) return url;
    const clean = decodeURIComponent(url.replace(/^\.\//, ''));
    return blobs.get(clean) ?? blobs.get(clean.split('/').pop()!) ?? url;
  });
  onProgress('parse');
  let gltf: Awaited<ReturnType<typeof parse>>;
  try {
    gltf = await parse(createLoader(manager), await main.file.arrayBuffer(), base);
  } catch (error) {
    created.forEach((url) => URL.revokeObjectURL(url));
    throw error;
  }
  return {
    name: main.file.name,
    root: gltf.scene,
    animations: gltf.animations,
    source,
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
