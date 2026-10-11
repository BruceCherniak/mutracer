import * as THREE from 'three';

/**
 * Focus area in viewport coordinates: `x`, `y` in 0..1 from the top left,
 * `size` is the half height of the square area as a fraction of the
 * viewport height.
 */
export interface FocusArea {
  x: number;
  y: number;
  size: number;
}

export const FOCUS_AREA_SIZE = 0.07;
/** Rays per side of the sampling grid. */
const GRID = 7;

// Reuse the workspace without retaining unloaded models. Positions are filled
// on every measurement so animation and edited geometry never use stale data.
const workspaces = new WeakMap<THREE.BufferGeometry, {
  xs: Float32Array; ys: Float32Array; zs: Float32Array; codes: Uint8Array;
}>();

/**
 * Depth (distance along the view direction) of the subject in the focus
 * area, or `null` when the area shows no geometry. Casts a grid of rays
 * through the area against the visible meshes under `root`.
 *
 * Meshes are culled against the area's frustum per vertex before the remaining
 * triangles are intersected with all rays at once. Animated vertices are
 * evaluated once per measurement, rather than once per triangle and ray.
 */
export function measureAreaDepth(root: THREE.Object3D, camera: THREE.PerspectiveCamera, area: FocusArea, aspect: number): number | null {
  camera.updateMatrixWorld();
  const eye = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
  const forward = camera.getWorldDirection(new THREE.Vector3());
  const cx = area.x * 2 - 1;
  const cy = 1 - area.y * 2;
  const hy = area.size * 2;
  const hx = hy / Math.max(aspect, 1e-6);
  const toWorld = (x: number, y: number) =>
    new THREE.Vector3(x, y, 0.5).unproject(camera).sub(eye).normalize();

  const directions: THREE.Vector3[] = [];
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      directions.push(toWorld(cx + hx * ((i / (GRID - 1)) * 2 - 1), cy + hy * ((j / (GRID - 1)) * 2 - 1)));
    }
  }
  // Inward side planes of the area frustum through the eye.
  const corners = [toWorld(cx - hx, cy - hy), toWorld(cx + hx, cy - hy), toWorld(cx + hx, cy + hy), toWorld(cx - hx, cy + hy)];
  const normals = corners.map((corner, i) => new THREE.Vector3().crossVectors(corner, corners[(i + 1) % 4]).normalize());
  if (normals[0].dot(directions[Math.floor(directions.length / 2)]) < 0) normals.forEach((n) => n.negate());

  const nearest = new Float64Array(directions.length).fill(Infinity);
  const sphere = new THREE.Sphere();
  const inverse = new THREE.Matrix4();
  const instanceMatrix = new THREE.Matrix4();
  const instanceWorld = new THREE.Matrix4();

  const measureMesh = (mesh: THREE.Mesh, matrixWorld: THREE.Matrix4, respectMaterialSide: boolean) => {
    const deformed = (mesh as THREE.SkinnedMesh).isSkinnedMesh || !!mesh.geometry.morphAttributes.position?.length;
    // Rest-pose bounds can exclude the animated subject. Its evaluated
    // vertices are culled below instead.
    if (!deformed) {
      if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
      sphere.copy(mesh.geometry.boundingSphere!).applyMatrix4(matrixWorld);
      const offset = sphere.center.clone().sub(eye);
      if (offset.dot(forward) < -sphere.radius || normals.some((n) => n.dot(offset) < -sphere.radius)) return;
    }
    inverse.copy(matrixWorld).invert();
    intersectMesh(mesh, matrixWorld, inverse, eye, directions, normals, forward, nearest, deformed, respectMaterialSide);
  };

  root.traverseVisible((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry?.getAttribute('position')) return;
    if ((mesh as THREE.InstancedMesh).isInstancedMesh) {
      const instanced = mesh as THREE.InstancedMesh;
      const proxy = new THREE.Mesh(mesh.geometry, mesh.material);
      for (let i = 0; i < instanced.count; i++) {
        instanced.getMatrixAt(i, instanceMatrix);
        instanceWorld.multiplyMatrices(mesh.matrixWorld, instanceMatrix);
        if (instanced.morphTexture) instanced.getMorphAt(i, proxy);
        measureMesh(proxy, instanceWorld, true);
      }
      return;
    }
    const special = (mesh as THREE.SkinnedMesh).isSkinnedMesh || Object.keys(mesh.geometry.morphAttributes).length > 0;
    measureMesh(mesh, mesh.matrixWorld, !!special);
  });

  const depths: number[] = [];
  nearest.forEach((t, k) => { if (Number.isFinite(t)) depths.push(t * directions[k].dot(forward)); });
  return pickFocusDepth(depths, directions.length);
}

/**
 * Chooses the focus depth from the depths of the rays that hit: the nearest
 * cluster that covers a meaningful part of the area, so a stray edge does not
 * steal focus from the subject behind it.
 */
export function pickFocusDepth(depths: number[], rayCount: number): number | null {
  if (!depths.length) return null;
  const sorted = [...depths].sort((a, b) => a - b);
  const support = Math.max(2, Math.ceil(rayCount * 0.12));
  for (let i = 0; i < sorted.length; i++) {
    const limit = sorted[i] * 1.08;
    let end = i;
    while (end + 1 < sorted.length && sorted[end + 1] <= limit) end++;
    if (end - i + 1 >= support) return sorted[i + ((end - i) >> 1)];
  }
  return sorted[sorted.length >> 1];
}

function intersectMesh(
  mesh: THREE.Mesh, matrixWorld: THREE.Matrix4, inverse: THREE.Matrix4, eyeWorld: THREE.Vector3, directionsWorld: THREE.Vector3[],
  normalsWorld: THREE.Vector3[], forwardWorld: THREE.Vector3, nearest: Float64Array, deformed: boolean, respectMaterialSide: boolean
) {
  const geometry = mesh.geometry;
  const position = geometry.getAttribute('position');
  const index = geometry.getIndex();
  // Unnormalized local directions keep the world ray parameter.
  const eye = eyeWorld.clone().applyMatrix4(inverse);
  const linear = new THREE.Matrix3().setFromMatrix4(inverse);
  const directions = directionsWorld.map((d) => d.clone().applyMatrix3(linear));
  // Planes map with the inverse transpose of the local-to-world transform.
  const planeMatrix = new THREE.Matrix3().setFromMatrix4(matrixWorld).transpose();
  const planes = [...normalsWorld, forwardWorld].map((n) => n.clone().applyMatrix3(planeMatrix));

  const count = position.count;
  let workspace = workspaces.get(geometry);
  if (!workspace || workspace.xs.length !== count) {
    workspace = { xs: new Float32Array(count), ys: new Float32Array(count), zs: new Float32Array(count), codes: new Uint8Array(count) };
    workspaces.set(geometry, workspace);
  }
  const { xs, ys, zs, codes } = workspace;
  const vertex = new THREE.Vector3();
  const array = (position as THREE.BufferAttribute).array as ArrayLike<number> | undefined;
  const direct = !deformed && !(position as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute && !position.normalized && position.itemSize === 3 && array;
  for (let v = 0; v < count; v++) {
    let x: number, y: number, z: number;
    if (deformed) {
      mesh.getVertexPosition(v, vertex);
      x = vertex.x; y = vertex.y; z = vertex.z;
    } else if (direct) {
      x = array[v * 3]; y = array[v * 3 + 1]; z = array[v * 3 + 2];
    } else {
      x = position.getX(v); y = position.getY(v); z = position.getZ(v);
    }
    xs[v] = x; ys[v] = y; zs[v] = z;
    const dx = x - eye.x, dy = y - eye.y, dz = z - eye.z;
    let code = 0;
    for (let p = 0; p < 5; p++) {
      const n = planes[p];
      if (n.x * dx + n.y * dy + n.z * dz < 0) code |= 1 << p;
    }
    codes[v] = code;
  }

  const indices = index?.array;
  // Preserve the material-side and group rules of the animated/instanced
  // raycaster path. Plain meshes retain their existing double-sided picking.
  const ranges = respectMaterialSide && Array.isArray(mesh.material)
    ? geometry.groups.map((group) => ({ ...group, material: (mesh.material as THREE.Material[])[group.materialIndex ?? 0] }))
    : [{ start: 0, count: Infinity, material: respectMaterialSide ? mesh.material as THREE.Material : null }];
  for (const range of ranges) {
    if (respectMaterialSide && !range.material) continue;
    const side = range.material?.side ?? THREE.DoubleSide;
    const start = Math.max(0, geometry.drawRange.start, range.start);
    const end = Math.min(index ? index.count : count, geometry.drawRange.start + geometry.drawRange.count, range.start + range.count);
    for (let t = start; t + 2 < end; t += 3) {
      const a = indices ? indices[t] : t;
      const b = indices ? indices[t + 1] : t + 1;
      const c = indices ? indices[t + 2] : t + 2;
      if (codes[a] & codes[b] & codes[c]) continue;
      const e1x = xs[b] - xs[a], e1y = ys[b] - ys[a], e1z = zs[b] - zs[a];
      const e2x = xs[c] - xs[a], e2y = ys[c] - ys[a], e2z = zs[c] - zs[a];
      const sx = eye.x - xs[a], sy = eye.y - ys[a], sz = eye.z - zs[a];
      const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
      const numerator = e2x * qx + e2y * qy + e2z * qz;
      // Möller–Trumbore with world-space distance preserved.
      for (let k = 0; k < directions.length; k++) {
        const d = directions[k];
        const px = d.y * e2z - d.z * e2y, py = d.z * e2x - d.x * e2z, pz = d.x * e2y - d.y * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) < 1e-12) continue;
        if ((side === THREE.FrontSide && det < 0) || (side === THREE.BackSide && det > 0)) continue;
        const inv = 1 / det;
        const u = (sx * px + sy * py + sz * pz) * inv;
        if (u < 0 || u > 1) continue;
        const w = (d.x * qx + d.y * qy + d.z * qz) * inv;
        if (w < 0 || u + w > 1) continue;
        const dist = numerator * inv;
        if (dist > 0 && dist < nearest[k]) nearest[k] = dist;
      }
    }
  }
}

/**
 * Guesses the length of a scene unit in metres from the model's largest
 * extent. glTF is in metres, so plausible sizes keep `1`; models hundreds
 * of units across were most likely exported in centimetres, and tens of
 * thousands in millimetres.
 */
export function guessMetersPerUnit(size: number): number {
  if (!(size > 0) || size <= 200) return 1;
  if (size <= 20_000) return 0.01;
  return 0.001;
}

/**
 * Focus pull from `from` to `to` (scene units), eased in dioptres like a
 * lens: it slightly overshoots and settles, as contrast-detect autofocus
 * hunts around the peak. Returns the distance at `elapsed` ms and whether
 * the pull has finished.
 */
export function focusPull(from: number, to: number, elapsed: number) {
  const duration = focusPullDuration(from, to);
  const p = Math.min(1, Math.max(0, elapsed / duration));
  const overshoot = 1.2;
  const q = p - 1;
  const eased = 1 + (overshoot + 1) * q * q * q + overshoot * q * q;
  const inverse = 1 / from + (1 / to - 1 / from) * eased;
  // Overshooting past infinity would flip the sign; stay in front of the lens.
  const distance = inverse > 1e-9 ? 1 / inverse : Math.max(from, to) * 4;
  return { distance: p >= 1 ? to : distance, done: p >= 1 };
}

export function focusPullDuration(from: number, to: number) {
  return Math.min(650, 260 + 220 * Math.abs(Math.log(to / from)));
}
