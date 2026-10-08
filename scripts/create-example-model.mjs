// Generates examples/assets/chess.glb, the small model used by the Three.js
// example. The geometry is procedural and released under CC0 together with
// this script.
//
// Usage: node scripts/create-example-model.mjs
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

// GLTFExporter reads Blobs through FileReader, which Node does not provide.
globalThis.FileReader ??= class {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((result) => {
      this.result = result;
      this.onloadend?.();
    });
  }
  readAsDataURL(blob) {
    blob.arrayBuffer().then((buffer) => {
      this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString('base64')}`;
      this.onloadend?.();
    });
  }
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Revolves a 2D profile given as [radius, height] pairs. */
function lathe(profile, segments = 64) {
  const geometry = new THREE.LatheGeometry(
    profile.map(([x, y]) => new THREE.Vector2(x, y)),
    segments
  );
  geometry.computeVertexNormals();
  return geometry;
}

const base = [
  [0, 0], [0.42, 0], [0.42, 0.06], [0.38, 0.1], [0.36, 0.16], [0.3, 0.2]
];
const pawn = lathe([
  ...base, [0.18, 0.32], [0.14, 0.52], [0.22, 0.56], [0.12, 0.6],
  [0.2, 0.68], [0.22, 0.78], [0.18, 0.88], [0.1, 0.94], [0, 0.96]
]);
const bishop = lathe([
  ...base, [0.2, 0.34], [0.14, 0.7], [0.24, 0.74], [0.14, 0.8],
  [0.2, 0.9], [0.22, 1.02], [0.16, 1.16], [0.06, 1.26], [0.08, 1.3],
  [0.05, 1.36], [0, 1.37]
]);
const rook = lathe([
  ...base, [0.24, 0.3], [0.22, 0.74], [0.3, 0.8], [0.3, 1.0], [0.22, 1.0],
  [0.22, 0.94], [0, 0.94]
]);

const lacquer = new THREE.MeshPhysicalMaterial({
  name: 'Black lacquer',
  color: 0x111114,
  roughness: 0.35,
  clearcoat: 1,
  clearcoatRoughness: 0.05
});
const ivory = new THREE.MeshPhysicalMaterial({
  name: 'Ivory',
  color: 0xe8dcc4,
  roughness: 0.45,
  sheen: 0.4,
  sheenColor: 0xffffff
});
const brass = new THREE.MeshStandardMaterial({
  name: 'Brass',
  color: 0xd9a94a,
  metalness: 1,
  roughness: 0.25
});

const scene = new THREE.Scene();
const pieces = [
  [pawn, ivory, -1.1, 0.3],
  [bishop, lacquer, -0.35, -0.2],
  [rook, brass, 0.45, 0.25],
  [pawn, lacquer, 1.15, -0.25]
];
for (const [geometry, material, x, z] of pieces) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, 0, z);
  scene.add(mesh);
}

const glb = await new Promise((resolve, reject) =>
  new GLTFExporter().parse(scene, resolve, reject, { binary: true })
);
const output = path.join(root, 'examples', 'assets', 'chess.glb');
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, Buffer.from(glb));
console.log(`Wrote ${path.relative(root, output)} (${glb.byteLength} bytes)`);
