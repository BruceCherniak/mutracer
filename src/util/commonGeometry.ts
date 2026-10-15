import { vec3 } from '../math.js';
import Geometry, { Attribute } from '../scene/Geometry.js';
import { generateVertexNormals, updateBoundingBox } from './geometry.js';

/** Unit sphere (radius 1) centered at the origin, with normals and UVs. */
export function createSphereGeometry(
  phiSegments: number = 40,
  thetaSegments: number = 20,

  phiStart = 0,
  phiLength = Math.PI * 2,
  thetaStart = 0,
  thetaLength = Math.PI
) {
  const positions: number[] = [];
  const uvs: number[] = [];
  const normals: number[] = [];
  const faces: number[] = [];

  const radius = 1;
  const divider = 1 / radius;
  for (let j = 0; j <= thetaSegments; j++) {
    for (let i = 0; i <= phiSegments; i++) {
      const u = i / phiSegments;
      const v = j / thetaSegments;

      // X axis is inverted so texture can be mapped from left to right
      const x =
        -radius *
        Math.cos(phiStart + u * phiLength) *
        Math.sin(thetaStart + v * thetaLength);
      const y = radius * Math.cos(thetaStart + v * thetaLength);
      const z =
        radius *
        Math.sin(phiStart + u * phiLength) *
        Math.sin(thetaStart + v * thetaLength);

      positions.push(x, y, z);
      uvs.push(u, v);
      normals.push(x * divider, y * divider, z * divider);
    }
  }

  let i1, i2, i3, i4;

  const len = phiSegments + 1;

  let n = 0;
  for (let j = 0; j < thetaSegments; j++) {
    for (let i = 0; i < phiSegments; i++) {
      i2 = j * len + i;
      i1 = j * len + i + 1;
      i4 = (j + 1) * len + i + 1;
      i3 = (j + 1) * len + i;

      faces[n++] = i1;
      faces[n++] = i2;
      faces[n++] = i4;

      faces[n++] = i2;
      faces[n++] = i3;
      faces[n++] = i4;
    }
  }
  const geo = new Geometry({
    uv: new Attribute(new Float32Array(uvs), 2),
    position: new Attribute(new Float32Array(positions), 3),
    normal: new Attribute(new Float32Array(normals), 3),
    indices: new Attribute(new Uint32Array(faces), 1)
  });
  vec3.set(geo.boundingBox.min, -1, -1, -1);
  vec3.set(geo.boundingBox.max, 1, 1, 1);
  return geo;
}

/**
 * 2x2 plane centered at the origin. `horizontal` lies in XZ facing +Y,
 * `vertical` lies in XY facing +Z.
 */
export function createPlaneGeometry(
  widthSegments = 1,
  heightSegments = 1,
  orient: 'horizontal' | 'vertical' = 'horizontal'
) {
  const positions: number[] = [];
  const uvs: number[] = [];
  const normals: number[] = [];
  const faces: number[] = [];
  const isVertical = orient === 'vertical';

  for (let y = 0; y <= heightSegments; y++) {
    const t = y / heightSegments;
    for (let x = 0; x <= widthSegments; x++) {
      const s = x / widthSegments;

      if (isVertical) {
        positions.push(2 * s - 1, 2 * t - 1, 0);
        if (normals) {
          normals.push(0, 0, 1);
        }
      } else {
        positions.push(2 * t - 1, 0, 2 * s - 1);
        if (normals) {
          normals.push(0, 1, 0);
        }
      }
      if (uvs) {
        uvs.push(s, t);
      }
      if (x < widthSegments && y < heightSegments) {
        const i = x + y * (widthSegments + 1);
        faces.push(i, i + 1, i + widthSegments + 1);
        faces.push(i + widthSegments + 1, i + 1, i + widthSegments + 2);
      }
    }
  }

  const geo = new Geometry({
    uv: new Attribute(new Float32Array(uvs), 2),
    position: new Attribute(new Float32Array(positions), 3),
    normal: new Attribute(new Float32Array(normals), 3),
    indices: new Attribute(new Uint32Array(faces), 1)
  });

  if (isVertical) {
    vec3.set(geo.boundingBox.min, -1, -1, 0);
    vec3.set(geo.boundingBox.max, 1, 1, 0);
  } else {
    vec3.set(geo.boundingBox.min, -1, 0, -1);
    vec3.set(geo.boundingBox.max, 1, 0, 1);
  }
  return geo;
}

/** 2x2x2 cube centered at the origin. */
export function createCubeGeometry(
  widthSegments: number = 1,
  heightSegments: number = 1,
  depthSegments: number = 1
) {
  const faces: number[] = [];
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];

  // helper variables

  let offset = 0;

  const w = 1;
  const h = 1;
  const d = 1;

  // build each side of the box geometry

  buildPlane(2, 1, 0, -1, -1, d, h, w, depthSegments, heightSegments); // px
  buildPlane(2, 1, 0, 1, -1, d, h, -w, depthSegments, heightSegments); // nx
  buildPlane(0, 2, 1, 1, 1, w, d, h, widthSegments, depthSegments); // py
  buildPlane(0, 2, 1, 1, -1, w, d, -h, widthSegments, depthSegments); // ny
  buildPlane(0, 1, 2, 1, -1, w, h, d, widthSegments, heightSegments); // pz
  buildPlane(0, 1, 2, -1, -1, w, h, -d, widthSegments, heightSegments); // nz

  // build geometry

  function buildPlane(
    u: 0 | 1 | 2,
    v: 0 | 1 | 2,
    w: 0 | 1 | 2,
    udir: number,
    vdir: number,
    width: number,
    height: number,
    depth: number,
    gridX: number,
    gridY: number
  ) {
    const segmentWidth = width / gridX;
    const segmentHeight = height / gridY;

    const widthHalf = width / 2;
    const heightHalf = height / 2;
    const depthHalf = depth / 2;

    const gridX1 = gridX + 1;
    const gridY1 = gridY + 1;

    let vertexCounter = 0;

    const vector = vec3.create();

    // generate positions, normals and uvs

    for (let iy = 0; iy < gridY1; iy++) {
      const y = iy * segmentHeight - heightHalf;

      for (let ix = 0; ix < gridX1; ix++) {
        const x = ix * segmentWidth - widthHalf;

        vector[u] = x * udir;
        vector[v] = y * vdir;
        vector[w] = depthHalf;

        positions.push(vector[0], vector[1], vector[2]);

        vector[u] = 0;
        vector[v] = 0;
        vector[w] = depth > 0 ? 1 : -1;

        normals.push(vector[0], vector[1], vector[2]);

        uvs.push(ix / gridX);
        uvs.push(1 - iy / gridY);

        vertexCounter += 1;
      }
    }

    // indices

    // 1. you need three indices to draw a single face
    // 2. a single segment consists of two faces
    // 3. so we need to generate six (2*3) indices per segment

    for (let iy = 0; iy < gridY; iy++) {
      for (let ix = 0; ix < gridX; ix++) {
        const a = offset + ix + gridX1 * iy;
        const b = offset + ix + gridX1 * (iy + 1);
        const c = offset + (ix + 1) + gridX1 * (iy + 1);
        const d = offset + (ix + 1) + gridX1 * iy;

        // faces
        faces.push(a, b, d);
        faces.push(b, c, d);
      }
    }

    offset += vertexCounter;
  }

  const geo = new Geometry({
    uv: new Attribute(new Float32Array(uvs), 2),
    position: new Attribute(new Float32Array(positions), 3),
    normal: new Attribute(new Float32Array(normals), 3),
    indices: new Attribute(new Uint32Array(faces), 1)
  });
  vec3.set(geo.boundingBox.min, -1, -1, -1);
  vec3.set(geo.boundingBox.max, 1, 1, 1);
  return geo;
}

/**
 * Studio backdrop ("infinity cove"): a floor that curves up into a back wall.
 * `curveSize` is the fraction of the profile taken by the bend.
 */
export function createCurvePlaneGeometry(curveSize = 0.2) {
  const faces: number[] = [];
  const positions: number[] = [];
  // Set width segments to 1 may have weired bands in ray tracing.
  const widthSegments = 5;
  const heightSegments = 200;
  const texcoords: number[] = [];
  const curveRadius = (curveSize / Math.PI) * 2;
  const planeSize = (1 - curveSize) / 2;

  let mm = 0;
  for (let m = 0; m <= heightSegments; m++) {
    // TODO t is stretched
    let y, z;
    let t = m / heightSegments;

    // Skip the plane part to reduce the number of vertices.
    if (
      (t > 0 && t <= planeSize - 1 / heightSegments) ||
      (t >= planeSize + curveSize + 1 / heightSegments && t < 1)
    ) {
      continue;
    }

    if (t <= planeSize) {
      y = 0;
      z = curveRadius + planeSize - t;
    } else if (t >= planeSize + curveSize) {
      y = t - planeSize - curveSize + curveRadius;
      z = 0;
    } else {
      const rad = (((t - planeSize) / curveSize) * Math.PI) / 2;
      y = (1 - Math.cos(rad)) * curveRadius;
      z = (1 - Math.sin(rad)) * curveRadius;
    }

    for (let n = 0; n <= widthSegments; n++) {
      const s = n / widthSegments;
      const x = 2 * s - 1;
      positions.push(x, y * 2, z * 2);
      texcoords.push(s, t);
      if (n < widthSegments && m < heightSegments) {
        const i = n + mm * (widthSegments + 1);
        faces.push(i, i + 1, i + widthSegments + 1);
        faces.push(i + widthSegments + 1, i + 1, i + widthSegments + 2);
      }
    }
    mm++;
  }
  const geo = new Geometry({
    uv: new Attribute(new Float32Array(texcoords), 2),
    position: new Attribute(new Float32Array(positions), 3),
    indices: new Attribute(new Uint32Array(faces), 1)
  });
  updateBoundingBox(geo);
  generateVertexNormals(geo);
  return geo;
}
