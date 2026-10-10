import Geometry, { Attribute } from '../scene/Geometry.js';
import OpenPBRMaterial from '../scene/OpenPBRMaterial.js';
import type {
  DisplacementEdgeProfile,
  DisplacementHeightFilter
} from '../scene/OpenPBRMaterial.js';
import type Texture from '../scene/Texture.js';
import {
  getHeightPixels,
  setDisplacementTessellationStats,
  type HeightPixels
} from './displacementData.js';
export {
  copyDisplacementTextureData,
  getDisplacementTessellationStats,
  setDisplacementTessellationStats
} from './displacementData.js';
import {
  generateCreasedVertexNormals,
  generateVertexTangents,
  updateBoundingBox
} from './geometry.js';

export type DisplacementTessellationMode =
  OpenPBRMaterial['displacementTessellationMode'];

export interface DisplacementTessellationOptions {
  mode?: DisplacementTessellationMode;
  /** Minimum adaptive level; useful for camera-driven micropolygon dicing. */
  minSubdivisionLevel?: number;
  /** Optional camera-derived dicing target for each source triangle. */
  faceSubdivisionLevels?: Uint8Array;
  /** Uniform level, or the maximum adaptive level. One level is roughly 1 -> 4. */
  maxSubdivisionLevel?: number;
  /** Maximum mesh-local deviation accepted by adaptive tessellation. */
  maxError?: number;
  /** Hard budget for generated triangles. Crack-closing splits take precedence. */
  maxTriangles?: number;
  /** Fraction of final displaced triangles an application postprocessor may retain. */
  simplificationRatio?: number;
  displacementScale?: number;
  displacementBias?: number;
  uvProjection?: OpenPBRMaterial['displacementUvProjection'];
  uvScale?: number;
  edgeProfile?: DisplacementEdgeProfile;
  threshold?: number;
  edgeWidth?: number;
  /** Cuts hard threshold contours into the mesh and closes height jumps with walls. */
  hardContourGeometry?: boolean;
  /** Number of UV-corner-preserving contour relaxation passes. */
  contourSmoothing?: number;
  /** Curvature-aware subdivisions per hard-contour segment (2^level). */
  contourSubdivisionLevel?: number;
  creaseAngle?: number;
  heightFilter?: DisplacementHeightFilter;
  /** Filters geometry heights to each emitted vertex's triangle footprint. */
  heightPrefilter?: boolean;
  /** Stable source-topology identity used by the persistent worker cache. */
  topologyCacheKey?: string;
}

export interface DisplacementTessellationProgress {
  mode: DisplacementTessellationMode;
  /** Normalized progress for one geometry. */
  progress: number;
}

interface HeightRangeLevel {
  min: Float32Array;
  max: Float32Array;
  width: number;
  height: number;
}

interface HeightRangePyramid {
  levels: HeightRangeLevel[];
}

interface HeightAnalysis {
  image: Texture['image'];
  version: number;
  pixels: HeightPixels;
  heightRanges?: HeightRangePyramid;
  edgeDistances?: Map<number, EdgeDistanceField>;
  autoEdges?: AutoEdgeField;
}

interface EdgeDistanceField {
  distances: Float32Array;
  minimum: number;
  maximum: number;
  width: number;
  height: number;
}

interface EdgeMaskLevel {
  values: Uint8Array;
  width: number;
  height: number;
}

interface AutoEdgeField {
  /** Connected texel regions separated only by detected hard transitions. */
  regions: Int32Array;
  maskLevels: EdgeMaskLevel[];
  width: number;
  height: number;
  hardEdgeCount: number;
}

type ResolvedDisplacementOptions = Required<Pick<
  DisplacementTessellationOptions,
  | 'displacementScale'
  | 'displacementBias'
  | 'uvProjection'
  | 'uvScale'
  | 'edgeProfile'
  | 'threshold'
  | 'edgeWidth'
  | 'hardContourGeometry'
  | 'contourSmoothing'
  | 'contourSubdivisionLevel'
  | 'creaseAngle'
  | 'heightFilter'
  | 'heightPrefilter'
>>;
type DisplacementSamplingOptions = ResolvedDisplacementOptions & {
  edgeDistance?: EdgeDistanceField;
  autoEdge?: AutoEdgeField;
};

const heightAnalysisByTexture = new WeakMap<Texture, HeightAnalysis>();
const heightAnalysisByCacheKey = new Map<string, HeightAnalysis>();
export interface DisplacementTessellationStats {
  sourceTriangles: number;
  generatedTriangles: number;
  sourceVertices: number;
  generatedVertices: number;
  buildTimeMs: number;
  topologyTimeMs: number;
  displacementTimeMs: number;
  normalTimeMs: number;
  tangentTimeMs: number;
  boundsTimeMs: number;
  topologyCacheHit: boolean;
  triangleBudgetReached: boolean;
  /** Triangle count before an optional geometry simplification pass. */
  preSimplificationTriangles?: number;
  /** Vertex count before an optional geometry simplification pass. */
  preSimplificationVertices?: number;
  /** Time spent simplifying the geometry used by the BVH. */
  simplificationTimeMs?: number;
  /** Normalized error reported by the simplifier. */
  simplificationError?: number;
  /** Requested OpenSubdiv base-face counts by level, before budget capping. */
  adaptiveFaceLevelCounts?: number[];
  /** Triangle pairs recovered as quad faces in the OpenSubdiv control cage. */
  recoveredQuadCount?: number;
  /** Source triangles that remain triangle faces in the control cage. */
  remainingControlTriangleCount?: number;
}

interface WorkingVertex {
  basePosition: [number, number, number];
  baseNormal: [number, number, number];
  uv: [number, number];
  displacedPosition: [number, number, number];
  color?: [number, number, number];
  materialIndex?: number[];
  /** Generated by adaptive refinement exactly where an edge crosses the threshold. */
  thresholdContour?: boolean;
}

interface WorkingTriangle {
  vertices: [number, number, number];
  depth: number;
}

interface RefinementCandidate {
  edge: string;
  error: number;
  hardSurfaceSpanTexels?: number;
}

const OPEN_SUBDIV_HARD_CONTOUR_TARGET_TEXEL_SPAN = 4;

interface UniformTessellationTopology {
  basePositions: Float32Array;
  baseNormals: Float32Array;
  uvs?: Float32Array;
  colors?: Float32Array;
  materialIndices?: Int32Array;
  materialIndexItemSize: number;
  indices: Uint32Array;
  triangleBudgetReached: boolean;
}

const uniformTopologiesByGeometry = new WeakMap<
  Geometry,
  Map<string, UniformTessellationTopology>
>();
const uniformTopologiesByCacheKey = new Map<string, UniformTessellationTopology>();
const maxPersistentUniformTopologies = 4;

function now() {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number) {
  return Math.min(Math.max(Math.floor(value ?? fallback), min), max);
}

function fract(value: number) {
  return value - Math.floor(value);
}

function edgeKey(a: number, b: number) {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function triangleEdges(triangle: WorkingTriangle) {
  const [a, b, c] = triangle.vertices;
  return [
    { key: edgeKey(a, b), a, b, opposite: c },
    { key: edgeKey(b, c), a: b, b: c, opposite: a },
    { key: edgeKey(c, a), a: c, b: a, opposite: b }
  ];
}

function normalize3(value: ArrayLike<number>): [number, number, number] {
  const length = Math.hypot(value[0], value[1], value[2]);
  if (!(length > 1e-12)) return [0, 0, 1];
  return [value[0] / length, value[1] / length, value[2] / length];
}

function mix3(a: ArrayLike<number>, b: ArrayLike<number>, t = 0.5): [number, number, number] {
  const s = 1 - t;
  return [
    a[0] * s + b[0] * t,
    a[1] * s + b[1] * t,
    a[2] * s + b[2] * t
  ];
}

function mix2(a: ArrayLike<number>, b: ArrayLike<number>, t = 0.5): [number, number] {
  const s = 1 - t;
  return [a[0] * s + b[0] * t, a[1] * s + b[1] * t];
}

function buildHeightRangePyramid(pixels: HeightPixels): HeightRangePyramid {
  const baseMin = new Float32Array(pixels.width * pixels.height);
  const baseMax = new Float32Array(baseMin.length);
  for (let y = 0; y < pixels.height; y++) {
    for (let x = 0; x < pixels.width; x++) {
      const value = readHeight(pixels, x, y);
      baseMin[y * pixels.width + x] = value;
      baseMax[y * pixels.width + x] = value;
    }
  }
  const levels: HeightRangeLevel[] = [
    { min: baseMin, max: baseMax, width: pixels.width, height: pixels.height }
  ];
  while (
    levels[levels.length - 1].width > 1 ||
    levels[levels.length - 1].height > 1
  ) {
    const previous = levels[levels.length - 1];
    const width = Math.max(1, Math.ceil(previous.width / 2));
    const height = Math.max(1, Math.ceil(previous.height / 2));
    const min = new Float32Array(width * height);
    const max = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let cellMin = Infinity;
        let cellMax = -Infinity;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const px = x * 2 + dx;
            const py = y * 2 + dy;
            if (px >= previous.width || py >= previous.height) continue;
            const offset = py * previous.width + px;
            cellMin = Math.min(cellMin, previous.min[offset]);
            cellMax = Math.max(cellMax, previous.max[offset]);
          }
        }
        min[y * width + x] = cellMin;
        max[y * width + x] = cellMax;
      }
    }
    levels.push({ min, max, width, height });
  }
  return { levels };
}

function getHeightAnalysis(texture: Texture, needsHeightRanges: boolean) {
  const cacheKey = texture.tessellationCacheKey;
  let analysis = cacheKey
    ? heightAnalysisByCacheKey.get(cacheKey)
    : heightAnalysisByTexture.get(texture);
  if (
    !analysis ||
    (!cacheKey &&
      (analysis.image !== texture.image ||
        analysis.version !== texture.version))
  ) {
    const pixels = getHeightPixels(texture);
    if (!pixels) return undefined;
    analysis = {
      image: texture.image,
      version: texture.version,
      pixels
    };
    if (cacheKey) {
      if (heightAnalysisByCacheKey.size >= 4) {
        heightAnalysisByCacheKey.delete(
          heightAnalysisByCacheKey.keys().next().value!
        );
      }
      heightAnalysisByCacheKey.set(cacheKey, analysis);
    } else {
      heightAnalysisByTexture.set(texture, analysis);
    }
  }
  if (needsHeightRanges && !analysis.heightRanges) {
    analysis.heightRanges = buildHeightRangePyramid(analysis.pixels);
  }
  return analysis;
}

function buildEdgeDistanceField(
  pixels: HeightPixels,
  threshold: number
): EdgeDistanceField {
  const count = pixels.width * pixels.height;
  const high = new Uint8Array(count);
  const distances = new Float32Array(count);
  let minimum = Infinity;
  let maximum = -Infinity;
  for (let y = 0; y < pixels.height; y++) {
    for (let x = 0; x < pixels.width; x++) {
      const offset = y * pixels.width + x;
      const value = readHeight(pixels, x, y);
      minimum = Math.min(minimum, value);
      maximum = Math.max(maximum, value);
      high[offset] = value >= threshold ? 1 : 0;
      distances[offset] = Infinity;
    }
  }

  const neighborOffsets = [[-1, 0], [1, 0], [0, -1], [0, 1]] as const;
  for (let y = 0; y < pixels.height; y++) {
    for (let x = 0; x < pixels.width; x++) {
      const offset = y * pixels.width + x;
      for (const [dx, dy] of neighborOffsets) {
        const nx = (x + dx + pixels.width) % pixels.width;
        const ny = (y + dy + pixels.height) % pixels.height;
        if (high[ny * pixels.width + nx] !== high[offset]) {
          distances[offset] = 0.5;
          break;
        }
      }
    }
  }

  const update = (x: number, y: number, nx: number, ny: number, cost: number) => {
    if (nx < 0 || nx >= pixels.width || ny < 0 || ny >= pixels.height) return;
    const offset = y * pixels.width + x;
    distances[offset] = Math.min(
      distances[offset],
      distances[ny * pixels.width + nx] + cost
    );
  };
  const diagonal = Math.SQRT2;
  for (let y = 0; y < pixels.height; y++) {
    for (let x = 0; x < pixels.width; x++) {
      update(x, y, x - 1, y, 1);
      update(x, y, x, y - 1, 1);
      update(x, y, x - 1, y - 1, diagonal);
      update(x, y, x + 1, y - 1, diagonal);
    }
  }
  for (let y = pixels.height - 1; y >= 0; y--) {
    for (let x = pixels.width - 1; x >= 0; x--) {
      update(x, y, x + 1, y, 1);
      update(x, y, x, y + 1, 1);
      update(x, y, x + 1, y + 1, diagonal);
      update(x, y, x - 1, y + 1, diagonal);
    }
  }
  for (let offset = 0; offset < count; offset++) {
    if (!Number.isFinite(distances[offset])) {
      distances[offset] = Math.max(pixels.width, pixels.height);
    }
    if (!high[offset]) distances[offset] *= -1;
  }
  return { distances, minimum, maximum, width: pixels.width, height: pixels.height };
}

function getEdgeDistanceField(analysis: HeightAnalysis, threshold: number) {
  const key = Math.round(Math.min(Math.max(threshold, 0), 1) * 10_000);
  analysis.edgeDistances ??= new Map();
  let field = analysis.edgeDistances.get(key);
  if (!field) {
    field = buildEdgeDistanceField(analysis.pixels, key / 10_000);
    if (analysis.edgeDistances.size >= 4) {
      analysis.edgeDistances.delete(analysis.edgeDistances.keys().next().value!);
    }
    analysis.edgeDistances.set(key, field);
  }
  return field;
}

function buildAutoEdgeField(
  pixels: HeightPixels,
  cachedHeights?: Float32Array
): AutoEdgeField {
  const { width, height } = pixels;
  const count = width * height;
  const parents = new Int32Array(count);
  parents.fill(-1);
  const mask = new Uint8Array(count);
  let minimum = Infinity;
  let maximum = -Infinity;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = cachedHeights?.[y * width + x] ?? readHeight(pixels, x, y);
      minimum = Math.min(minimum, value);
      maximum = Math.max(maximum, value);
    }
  }
  const valueRange = Math.max(maximum - minimum, 0);
  const noiseFloor = Math.max(
    valueRange * 1e-4,
    pixels.normalized ? 0.75 / 255 : 1e-7
  );
  const minimumJump = Math.max(
    valueRange * 0.01,
    pixels.normalized ? 2 / 255 : valueRange * 1e-4,
    1e-7
  );
  const wrappedRead = (x: number, y: number) => {
    const wrappedX = (x + width) % width;
    const wrappedY = (y + height) % height;
    return cachedHeights?.[wrappedY * width + wrappedX] ??
      readHeight(pixels, wrappedX, wrappedY);
  };
  const find = (value: number) => {
    let root = value;
    while (parents[root] >= 0) root = parents[root];
    while (value !== root) {
      const next = parents[value];
      parents[value] = root;
      value = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    let rootA = find(a);
    let rootB = find(b);
    if (rootA === rootB) return;
    if (parents[rootA] > parents[rootB]) [rootA, rootB] = [rootB, rootA];
    parents[rootA] += parents[rootB];
    parents[rootB] = rootA;
  };
  const sideStability = (
    center: number,
    normal1: number,
    normal2: number
  ) => {
    return Math.max(
      Math.abs(center - normal1),
      Math.abs(normal1 - normal2)
    );
  };
  const isHardTransition = (
    x: number,
    y: number,
    dx: number,
    dy: number
  ) => {
    if ((dx !== 0 && width <= 1) || (dy !== 0 && height <= 1)) return false;
    const a = wrappedRead(x, y);
    const b = wrappedRead(x + dx, y + dy);
    const jump = Math.abs(b - a);
    if (jump < minimumJump) return false;
    const aStability = sideStability(
      a,
      wrappedRead(x - dx, y - dy),
      wrappedRead(x - dx * 2, y - dy * 2)
    );
    const bStability = sideStability(
      b,
      wrappedRead(x + dx * 2, y + dy * 2),
      wrappedRead(x + dx * 3, y + dy * 3)
    );
    // At least one side must form a stable plateau. This admits one-pixel
    // circuit traces (their outer side is stable) while a continuous ramp has
    // comparable derivatives on both sides and therefore remains smooth.
    return jump >= (Math.min(aStability, bStability) + noiseFloor) * 3;
  };

  let hardEdgeCount = 0;
  const connect = (x: number, y: number, dx: number, dy: number) => {
    const nx = (x + dx + width) % width;
    const ny = (y + dy + height) % height;
    const a = y * width + x;
    const b = ny * width + nx;
    if (isHardTransition(x, y, dx, dy)) {
      mask[a] = 1;
      mask[b] = 1;
      hardEdgeCount++;
    } else {
      union(a, b);
    }
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      connect(x, y, 1, 0);
      connect(x, y, 0, 1);
    }
  }
  // Compress non-roots while roots still carry their negative set sizes, then
  // turn roots into stable region ids. This reuses the union-find allocation;
  // a 4K map therefore needs one 32-bit region buffer rather than two.
  for (let index = 0; index < count; index++) {
    if (parents[index] >= 0) parents[index] = find(index);
  }
  for (let index = 0; index < count; index++) {
    if (parents[index] < 0) parents[index] = index;
  }

  const maskLevels: EdgeMaskLevel[] = [{ values: mask, width, height }];
  while (
    maskLevels[maskLevels.length - 1].width > 1 ||
    maskLevels[maskLevels.length - 1].height > 1
  ) {
    const previous = maskLevels[maskLevels.length - 1];
    const nextWidth = Math.max(1, Math.ceil(previous.width / 2));
    const nextHeight = Math.max(1, Math.ceil(previous.height / 2));
    const values = new Uint8Array(nextWidth * nextHeight);
    for (let y = 0; y < nextHeight; y++) {
      for (let x = 0; x < nextWidth; x++) {
        let value = 0;
        for (let dy = 0; dy < 2 && !value; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const px = x * 2 + dx;
            const py = y * 2 + dy;
            if (
              px < previous.width && py < previous.height &&
              previous.values[py * previous.width + px]
            ) {
              value = 1;
              break;
            }
          }
        }
        values[y * nextWidth + x] = value;
      }
    }
    maskLevels.push({ values, width: nextWidth, height: nextHeight });
  }
  return { regions: parents, maskLevels, width, height, hardEdgeCount };
}

function getAutoEdgeField(analysis: HeightAnalysis) {
  analysis.autoEdges ??= buildAutoEdgeField(
    analysis.pixels,
    analysis.heightRanges?.levels[0].min
  );
  return analysis.autoEdges;
}

function transformedUv(
  texture: Texture,
  uv: ArrayLike<number>
): [number, number] {
  const u = uv[0] * texture.uvScale[0] + texture.uvOffset[0];
  let v = uv[1] * texture.uvScale[1] + texture.uvOffset[1];
  if (texture.flipY) v = 1 - v;
  return [u, v];
}

function unwrapTriangleUvs(uvs: [number, number][]) {
  const result = uvs.map((uv) => [...uv] as [number, number]);
  const fullSpan = [0, 1].map((axis) => {
    const values = result.map((uv) => uv[axis]);
    return Math.max(...values) - Math.min(...values) >= 0.999999;
  });
  for (let index = 1; index < result.length; index++) {
    for (let axis = 0; axis < 2; axis++) {
      if (fullSpan[axis]) continue;
      while (result[index][axis] - result[0][axis] > 0.5) result[index][axis]--;
      while (result[index][axis] - result[0][axis] < -0.5) result[index][axis]++;
    }
  }
  return result;
}

function splitWrappedInterval(minimum: number, maximum: number) {
  if (maximum - minimum >= 1) return [[0, 1]] as [number, number][];
  const start = fract(minimum);
  const end = start + (maximum - minimum);
  return end <= 1
    ? [[start, end]] as [number, number][]
    : [[start, 1], [0, end - 1]] as [number, number][];
}

function queryHeightRangeRect(
  pyramid: HeightRangePyramid,
  minU: number,
  maxU: number,
  minV: number,
  maxV: number
) {
  const base = pyramid.levels[0];
  const queryMinX = minU * Math.max(base.width - 1, 0);
  const queryMaxX = maxU * Math.max(base.width - 1, 0);
  const queryMinY = minV * Math.max(base.height - 1, 0);
  const queryMaxY = maxV * Math.max(base.height - 1, 0);
  let resultMin = Infinity;
  let resultMax = -Infinity;
  const visit = (levelIndex: number, x: number, y: number) => {
    const level = pyramid.levels[levelIndex];
    if (x >= level.width || y >= level.height) return;
    const size = 2 ** levelIndex;
    const cellMinX = x * size;
    const cellMinY = y * size;
    const cellMaxX = Math.min((x + 1) * size - 1, base.width - 1);
    const cellMaxY = Math.min((y + 1) * size - 1, base.height - 1);
    if (
      cellMaxX < queryMinX || cellMinX > queryMaxX ||
      cellMaxY < queryMinY || cellMinY > queryMaxY
    ) return;
    const fullyCovered =
      cellMinX >= queryMinX && cellMaxX <= queryMaxX &&
      cellMinY >= queryMinY && cellMaxY <= queryMaxY;
    if (fullyCovered || levelIndex === 0) {
      const offset = y * level.width + x;
      resultMin = Math.min(resultMin, level.min[offset]);
      resultMax = Math.max(resultMax, level.max[offset]);
      return;
    }
    const childLevel = levelIndex - 1;
    visit(childLevel, x * 2, y * 2);
    visit(childLevel, x * 2 + 1, y * 2);
    visit(childLevel, x * 2, y * 2 + 1);
    visit(childLevel, x * 2 + 1, y * 2 + 1);
  };
  const top = pyramid.levels.length - 1;
  const root = pyramid.levels[top];
  for (let y = 0; y < root.height; y++) {
    for (let x = 0; x < root.width; x++) visit(top, x, y);
  }
  return { min: resultMin, max: resultMax };
}

function triangleHeightRange(
  pyramid: HeightRangePyramid,
  texture: Texture,
  vertices: WorkingVertex[],
  projection: OpenPBRMaterial['displacementUvProjection'],
  projectionScale: number
) {
  const projectedUvs = vertices.map((vertex) =>
    transformedUv(
      texture,
      projectUv(
        vertex.basePosition,
        vertex.baseNormal,
        vertex.uv,
        projection,
        projectionScale
      )
    )
  );
  // Spherical/cylindrical projections wrap geometrically at the angular seam.
  // Ordinary UVs and planar projections interpolate through their numeric
  // coordinates and may intentionally span multiple texture repeats.
  const uvs = projection === 'spherical' || projection === 'cylindrical'
    ? unwrapTriangleUvs(projectedUvs)
    : projectedUvs;
  const minU = Math.min(...uvs.map((uv) => uv[0]));
  const maxU = Math.max(...uvs.map((uv) => uv[0]));
  const minV = Math.min(...uvs.map((uv) => uv[1]));
  const maxV = Math.max(...uvs.map((uv) => uv[1]));
  const base = pyramid.levels[0];
  const spanTexels = Math.max(
    (maxU - minU) * Math.max(base.width - 1, 0),
    (maxV - minV) * Math.max(base.height - 1, 0)
  );
  let resultMin = Infinity;
  let resultMax = -Infinity;
  for (const [u0, u1] of splitWrappedInterval(minU, maxU)) {
    for (const [v0, v1] of splitWrappedInterval(minV, maxV)) {
      const range = queryHeightRangeRect(pyramid, u0, u1, v0, v1);
      resultMin = Math.min(resultMin, range.min);
      resultMax = Math.max(resultMax, range.max);
    }
  }
  return { min: resultMin, max: resultMax, spanTexels };
}

function queryEdgeMaskRect(
  field: AutoEdgeField,
  minU: number,
  maxU: number,
  minV: number,
  maxV: number
) {
  if (!field.hardEdgeCount) return false;
  const queryMinX = minU * Math.max(field.width - 1, 0);
  const queryMaxX = maxU * Math.max(field.width - 1, 0);
  const queryMinY = minV * Math.max(field.height - 1, 0);
  const queryMaxY = maxV * Math.max(field.height - 1, 0);
  const visit = (levelIndex: number, x: number, y: number): boolean => {
    const level = field.maskLevels[levelIndex];
    if (x >= level.width || y >= level.height) return false;
    const offset = y * level.width + x;
    if (!level.values[offset]) return false;
    const size = 2 ** levelIndex;
    const cellMinX = x * size;
    const cellMinY = y * size;
    const cellMaxX = Math.min((x + 1) * size - 1, field.width - 1);
    const cellMaxY = Math.min((y + 1) * size - 1, field.height - 1);
    if (
      cellMaxX < queryMinX || cellMinX > queryMaxX ||
      cellMaxY < queryMinY || cellMinY > queryMaxY
    ) return false;
    if (levelIndex === 0) return true;
    const childLevel = levelIndex - 1;
    return (
      visit(childLevel, x * 2, y * 2) ||
      visit(childLevel, x * 2 + 1, y * 2) ||
      visit(childLevel, x * 2, y * 2 + 1) ||
      visit(childLevel, x * 2 + 1, y * 2 + 1)
    );
  };
  const top = field.maskLevels.length - 1;
  const root = field.maskLevels[top];
  for (let y = 0; y < root.height; y++) {
    for (let x = 0; x < root.width; x++) {
      if (visit(top, x, y)) return true;
    }
  }
  return false;
}

function triangleAutoEdgeRange(
  field: AutoEdgeField,
  texture: Texture,
  vertices: WorkingVertex[],
  projection: OpenPBRMaterial['displacementUvProjection'],
  projectionScale: number
) {
  const projectedUvs = vertices.map((vertex) =>
    transformedUv(
      texture,
      projectUv(
        vertex.basePosition,
        vertex.baseNormal,
        vertex.uv,
        projection,
        projectionScale
      )
    )
  );
  const uvs = projection === 'spherical' || projection === 'cylindrical'
    ? unwrapTriangleUvs(projectedUvs)
    : projectedUvs;
  const minU = Math.min(...uvs.map((uv) => uv[0]));
  const maxU = Math.max(...uvs.map((uv) => uv[0]));
  const minV = Math.min(...uvs.map((uv) => uv[1]));
  const maxV = Math.max(...uvs.map((uv) => uv[1]));
  const spanTexels = Math.max(
    (maxU - minU) * Math.max(field.width - 1, 0),
    (maxV - minV) * Math.max(field.height - 1, 0)
  );
  for (const [u0, u1] of splitWrappedInterval(minU, maxU)) {
    for (const [v0, v1] of splitWrappedInterval(minV, maxV)) {
      if (queryEdgeMaskRect(field, u0, u1, v0, v1)) {
        return { hasEdge: true, spanTexels };
      }
    }
  }
  return { hasEdge: false, spanTexels };
}

function projectUv(
  position: ArrayLike<number>,
  normal: ArrayLike<number>,
  uv: ArrayLike<number>,
  projection: OpenPBRMaterial['displacementUvProjection'],
  scale: number
): [number, number] {
  if (projection === 'triplanar') {
    const ax = Math.abs(normal[0]);
    const ay = Math.abs(normal[1]);
    const az = Math.abs(normal[2]);
    if (ax > ay && ax > az) return [position[1] * scale, position[2] * scale];
    if (ay > ax && ay > az) return [position[0] * scale, position[2] * scale];
    return [position[0] * scale, position[1] * scale];
  }
  if (projection === 'spherical') {
    const n = normalize3(position);
    return [
      (Math.atan2(n[0], n[2]) / (Math.PI * 2) + 0.5) * scale,
      (1 - Math.acos(Math.min(Math.max(n[1], -1), 1)) / Math.PI) * scale
    ];
  }
  if (projection === 'cylindrical') {
    return [
      (Math.atan2(position[2], position[0]) / (Math.PI * 2) + 0.5) * scale,
      position[1] * scale
    ];
  }
  return [uv[0], uv[1]];
}

function readHeight(pixels: HeightPixels, x: number, y: number) {
  const value = pixels.data[(y * pixels.width + x) * pixels.channels];
  return pixels.normalized ? value / 255 : value;
}

function sampleGrid(
  width: number,
  height: number,
  read: (x: number, y: number) => number,
  u: number,
  v: number,
  filter: DisplacementHeightFilter,
  footprint?: readonly [number, number]
) {
  const px = u * Math.max(width - 1, 0);
  const py = v * Math.max(height - 1, 0);
  if (filter === 'nearest') {
    return read(Math.round(px), Math.round(py));
  }
  const sampleLinear = (sampleU: number, sampleV: number) => {
    // Preserve the existing exact u/v = 1 edge sample while wrapping only
    // footprint taps that cross the tiled texture boundary.
    const wrappedU = sampleU < 0 || sampleU > 1 ? fract(sampleU) : sampleU;
    const wrappedV = sampleV < 0 || sampleV > 1 ? fract(sampleV) : sampleV;
    const sampleX = wrappedU * Math.max(width - 1, 0);
    const sampleY = wrappedV * Math.max(height - 1, 0);
    const x0 = Math.floor(sampleX);
    const y0 = Math.floor(sampleY);
    const x1 = Math.min(x0 + 1, width - 1);
    const y1 = Math.min(y0 + 1, height - 1);
    const tx = sampleX - x0;
    const ty = sampleY - y0;
    const h0 = read(x0, y0) * (1 - tx) + read(x1, y0) * tx;
    const h1 = read(x0, y1) * (1 - tx) + read(x1, y1) * tx;
    return h0 * (1 - ty) + h1 * ty;
  };
  const footprintX = Math.min(Math.max(footprint?.[0] ?? 1, 1), 32);
  const footprintY = Math.min(Math.max(footprint?.[1] ?? 1, 1), 32);
  if (footprintX <= 1.01 && footprintY <= 1.01) {
    return sampleLinear(u, v);
  }

  // A compact separable tent approximates the mip/derivative filtering used
  // by micropolygon renderers. It is deliberately applied only to geometry
  // height samples; hybrid bump continues to see the original full-resolution
  // map. This prevents a coarse triangle from connecting unrelated texel peaks.
  const radiusU = width > 1 ? (footprintX - 1) * 0.5 / (width - 1) : 0;
  const radiusV = height > 1 ? (footprintY - 1) * 0.5 / (height - 1) : 0;
  const tapsX = radiusU > 0
    ? [[-radiusU, 1], [0, 2], [radiusU, 1]] as const
    : [[0, 1]] as const;
  const tapsY = radiusV > 0
    ? [[-radiusV, 1], [0, 2], [radiusV, 1]] as const
    : [[0, 1]] as const;
  let sum = 0;
  let weightSum = 0;
  for (const [offsetU, weightU] of tapsX) {
    for (const [offsetV, weightV] of tapsY) {
      const weight = weightU * weightV;
      sum += sampleLinear(u + offsetU, v + offsetV) * weight;
      weightSum += weight;
    }
  }
  return sum / weightSum;
}

function sampleRawHeight(
  pixels: HeightPixels,
  texture: Texture,
  position: ArrayLike<number>,
  normal: ArrayLike<number>,
  uv: ArrayLike<number>,
  options: DisplacementSamplingOptions,
  footprint?: readonly [number, number]
) {
  const projected = projectUv(
    position,
    normal,
    uv,
    options.uvProjection,
    options.uvScale
  );
  const u = fract(projected[0] * texture.uvScale[0] + texture.uvOffset[0]);
  let v = fract(projected[1] * texture.uvScale[1] + texture.uvOffset[1]);
  if (texture.flipY) v = 1 - v;
  const raw = sampleGrid(
    pixels.width,
    pixels.height,
    (x, y) => readHeight(pixels, x, y),
    u,
    v,
    options.heightFilter,
    footprint
  );
  return raw;
}

function autoSampleCoordinates(
  texture: Texture,
  position: ArrayLike<number>,
  normal: ArrayLike<number>,
  uv: ArrayLike<number>,
  options: DisplacementSamplingOptions
) {
  const projected = projectUv(
    position,
    normal,
    uv,
    options.uvProjection,
    options.uvScale
  );
  const u = fract(projected[0] * texture.uvScale[0] + texture.uvOffset[0]);
  let v = fract(projected[1] * texture.uvScale[1] + texture.uvOffset[1]);
  if (texture.flipY) v = 1 - v;
  return [u, v] as const;
}

function sampleAutoRegionAtUv(field: AutoEdgeField, u: number, v: number) {
  const x = Math.min(
    Math.max(Math.round(u * Math.max(field.width - 1, 0)), 0),
    field.width - 1
  );
  const y = Math.min(
    Math.max(Math.round(v * Math.max(field.height - 1, 0)), 0),
    field.height - 1
  );
  return field.regions[y * field.width + x];
}

function sampleAutoRegion(
  texture: Texture,
  position: ArrayLike<number>,
  normal: ArrayLike<number>,
  uv: ArrayLike<number>,
  options: DisplacementSamplingOptions
) {
  const field = options.autoEdge;
  if (!field) return -1;
  const [u, v] = autoSampleCoordinates(texture, position, normal, uv, options);
  return sampleAutoRegionAtUv(field, u, v);
}

function sampleAutoHeight(
  pixels: HeightPixels,
  texture: Texture,
  position: ArrayLike<number>,
  normal: ArrayLike<number>,
  uv: ArrayLike<number>,
  options: DisplacementSamplingOptions
) {
  const field = options.autoEdge;
  if (!field) {
    return sampleRawHeight(pixels, texture, position, normal, uv, options);
  }
  const [u, v] = autoSampleCoordinates(texture, position, normal, uv, options);
  const px = u * Math.max(field.width - 1, 0);
  const py = v * Math.max(field.height - 1, 0);
  if (options.heightFilter === 'nearest') {
    return readHeight(pixels, Math.round(px), Math.round(py));
  }
  const x0 = Math.floor(px);
  const y0 = Math.floor(py);
  const x1 = Math.min(x0 + 1, field.width - 1);
  const y1 = Math.min(y0 + 1, field.height - 1);
  const tx = px - x0;
  const ty = py - y0;
  const selectedRegion = sampleAutoRegionAtUv(field, u, v);
  const samples = [
    [x0, y0, (1 - tx) * (1 - ty)],
    [x1, y0, tx * (1 - ty)],
    [x0, y1, (1 - tx) * ty],
    [x1, y1, tx * ty]
  ] as const;
  let height = 0;
  let weight = 0;
  for (const [x, y, sampleWeight] of samples) {
    if (field.regions[y * field.width + x] !== selectedRegion) continue;
    height += readHeight(pixels, x, y) * sampleWeight;
    weight += sampleWeight;
  }
  if (weight > 1e-8) return height / weight;
  return readHeight(pixels, Math.round(px), Math.round(py));
}

function sampleHeight(
  pixels: HeightPixels,
  texture: Texture,
  position: ArrayLike<number>,
  normal: ArrayLike<number>,
  uv: ArrayLike<number>,
  options: DisplacementSamplingOptions,
  footprint?: readonly [number, number]
) {
  const raw = sampleRawHeight(
    pixels,
    texture,
    position,
    normal,
    uv,
    options,
    footprint
  );
  if (options.edgeProfile === 'smooth') return raw;
  if (options.edgeProfile === 'auto') {
    return sampleAutoHeight(pixels, texture, position, normal, uv, options);
  }
  const field = options.edgeDistance;
  const minimum = field?.minimum ?? 0;
  const maximum = field?.maximum ?? 1;
  if (options.edgeProfile === 'hard' || !field) {
    return raw >= options.threshold ? maximum : minimum;
  }
  const projected = projectUv(
    position,
    normal,
    uv,
    options.uvProjection,
    options.uvScale
  );
  const u = fract(projected[0] * texture.uvScale[0] + texture.uvOffset[0]);
  let v = fract(projected[1] * texture.uvScale[1] + texture.uvOffset[1]);
  if (texture.flipY) v = 1 - v;
  const signedDistance = sampleGrid(
    field.width,
    field.height,
    (x, y) => field.distances[y * field.width + x],
    u,
    v,
    'linear'
  );
  const width = Math.max(options.edgeWidth, 0.01);
  const t = Math.min(Math.max(0.5 + signedDistance / width, 0), 1);
  const beveled = t * t * (3 - 2 * t);
  return minimum + (maximum - minimum) * beveled;
}

function thresholdSplit(
  vertices: WorkingVertex[],
  a: number,
  b: number,
  pixels: HeightPixels,
  texture: Texture,
  options: DisplacementSamplingOptions
) {
  if (options.edgeProfile === 'smooth') {
    return { t: 0.5, crossesThreshold: false };
  }
  const va = vertices[a];
  const vb = vertices[b];
  const sampleAt = (t: number) => sampleRawHeight(
    pixels,
    texture,
    mix3(va.basePosition, vb.basePosition, t),
    normalize3(mix3(va.baseNormal, vb.baseNormal, t)),
    mix2(va.uv, vb.uv, t),
    options
  );
  if (options.edgeProfile === 'auto') {
    const regionAt = (t: number) => sampleAutoRegion(
      texture,
      mix3(va.basePosition, vb.basePosition, t),
      normalize3(mix3(va.baseNormal, vb.baseNormal, t)),
      mix2(va.uv, vb.uv, t),
      options
    );
    const aRegion = regionAt(0);
    const bRegion = regionAt(1);
    if (aRegion === bRegion) return { t: 0.5, crossesThreshold: false };
    let low = 0;
    let high = 1;
    for (let iteration = 0; iteration < 12; iteration++) {
      const middle = (low + high) * 0.5;
      if (regionAt(middle) === aRegion) low = middle;
      else high = middle;
    }
    return { t: (low + high) * 0.5, crossesThreshold: true };
  }
  const aHigh = sampleAt(0) >= options.threshold;
  const bHigh = sampleAt(1) >= options.threshold;
  if (aHigh === bHigh) return { t: 0.5, crossesThreshold: false };
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 10; iteration++) {
    const middle = (low + high) * 0.5;
    if ((sampleAt(middle) >= options.threshold) === aHigh) {
      low = middle;
    } else {
      high = middle;
    }
  }
  return { t: (low + high) * 0.5, crossesThreshold: true };
}

function displacedPosition(
  pixels: HeightPixels,
  texture: Texture,
  position: [number, number, number],
  normal: [number, number, number],
  uv: [number, number],
  options: DisplacementSamplingOptions,
  footprint?: readonly [number, number]
): [number, number, number] {
  const height = options.displacementBias + options.displacementScale * sampleHeight(
    pixels,
    texture,
    position,
    normal,
    uv,
    options,
    footprint
  );
  return [
    position[0] + normal[0] * height,
    position[1] + normal[1] * height,
    position[2] + normal[2] * height
  ];
}

function mixMaterialIndices(a?: number[], b?: number[]) {
  if (!a && !b) return undefined;
  if (!a) return b?.slice();
  if (!b) return a.slice();
  const weights = new Map<number, number>();
  for (const values of [a, b]) {
    for (const packed of values) {
      if (packed <= 0) continue;
      const [index, weight] = Geometry.unpackMaterialIndexAndWeightFromInt(packed);
      weights.set(index, (weights.get(index) ?? 0) + weight * 0.5);
    }
  }
  const selected = [...weights.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 4);
  const total = selected.reduce((sum, entry) => sum + entry[1], 0) || 1;
  const result = new Array(4).fill(0);
  selected.forEach(([index, weight], slot) => {
    result[slot] = Geometry.packMaterialIndexAndWeightToInt(index, weight / total);
  });
  return result;
}

function interpolateVertex(
  vertices: WorkingVertex[],
  a: number,
  b: number,
  pixels: HeightPixels,
  texture: Texture,
  options: DisplacementSamplingOptions,
  t = 0.5
): WorkingVertex {
  const va = vertices[a];
  const vb = vertices[b];
  const basePosition = mix3(va.basePosition, vb.basePosition, t);
  const baseNormal = normalize3(mix3(va.baseNormal, vb.baseNormal, t));
  const uv = mix2(va.uv, vb.uv, t);
  return {
    basePosition,
    baseNormal,
    uv,
    displacedPosition: displacedPosition(
      pixels,
      texture,
      basePosition,
      baseNormal,
      uv,
      options
    ),
    color: va.color && vb.color ? mix3(va.color, vb.color, t) : va.color ?? vb.color,
    materialIndex: mixMaterialIndices(va.materialIndex, vb.materialIndex)
  };
}

function positionError(actual: ArrayLike<number>, approximated: ArrayLike<number>) {
  return Math.hypot(
    actual[0] - approximated[0],
    actual[1] - approximated[1],
    actual[2] - approximated[2]
  );
}

function refinementCandidate(
  triangle: WorkingTriangle,
  vertices: WorkingVertex[],
  pixels: HeightPixels,
  texture: Texture,
  heightRanges: HeightRangePyramid | undefined,
  options: DisplacementSamplingOptions,
  smoothRangeErrorCap = Number.POSITIVE_INFINITY
): RefinementCandidate {
  let selectedEdge = '';
  let selectedError = -1;
  let longestEdge = '';
  let longestLength = -1;
  for (const edge of triangleEdges(triangle)) {
    let error = 0;
    for (const t of [0.25, 0.5, 0.75]) {
      const sampled = interpolateVertex(
        vertices,
        edge.a,
        edge.b,
        pixels,
        texture,
        options,
        t
      );
      const approximated = mix3(
        vertices[edge.a].displacedPosition,
        vertices[edge.b].displacedPosition,
        t
      );
      error = Math.max(error, positionError(sampled.displacedPosition, approximated));
    }
    const pa = vertices[edge.a].displacedPosition;
    const pb = vertices[edge.b].displacedPosition;
    const length = Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]);
    if (error > selectedError) {
      selectedError = error;
      selectedEdge = edge.key;
    }
    if (length > longestLength) {
      longestLength = length;
      longestEdge = edge.key;
    }
  }

  const [a, b, c] = triangle.vertices.map((index) => vertices[index]);
  const basePosition: [number, number, number] = [
    (a.basePosition[0] + b.basePosition[0] + c.basePosition[0]) / 3,
    (a.basePosition[1] + b.basePosition[1] + c.basePosition[1]) / 3,
    (a.basePosition[2] + b.basePosition[2] + c.basePosition[2]) / 3
  ];
  const baseNormal = normalize3([
    a.baseNormal[0] + b.baseNormal[0] + c.baseNormal[0],
    a.baseNormal[1] + b.baseNormal[1] + c.baseNormal[1],
    a.baseNormal[2] + b.baseNormal[2] + c.baseNormal[2]
  ]);
  const uv: [number, number] = [
    (a.uv[0] + b.uv[0] + c.uv[0]) / 3,
    (a.uv[1] + b.uv[1] + c.uv[1]) / 3
  ];
  const actual = displacedPosition(
    pixels,
    texture,
    basePosition,
    baseNormal,
    uv,
    options
  );
  const approximated: [number, number, number] = [
    (a.displacedPosition[0] + b.displacedPosition[0] + c.displacedPosition[0]) / 3,
    (a.displacedPosition[1] + b.displacedPosition[1] + c.displacedPosition[1]) / 3,
    (a.displacedPosition[2] + b.displacedPosition[2] + c.displacedPosition[2]) / 3
  ];
  const centerError = positionError(actual, approximated);
  let rangeError = 0;
  let hardSurfaceSpanTexels: number | undefined;
  if (heightRanges) {
    const samples = [a, b, c].map((vertex) =>
      sampleHeight(
        pixels,
        texture,
        vertex.basePosition,
        vertex.baseNormal,
        vertex.uv,
        options
      )
    );
    const range = triangleHeightRange(
      heightRanges,
      texture,
      [a, b, c],
      options.uvProjection,
      options.uvScale
    );
    const sampledMin = Math.min(...samples);
    const sampledMax = Math.max(...samples);
    rangeError = Math.max(
      sampledMin - range.min,
      range.max - sampledMax,
      0
    ) * Math.abs(options.displacementScale);
    if (
      options.edgeProfile === 'smooth' ||
      options.edgeProfile === 'auto'
    ) {
      rangeError = Math.min(rangeError, smoothRangeErrorCap);
    }
    const autoEdgeRange = options.edgeProfile === 'auto' && options.autoEdge
      ? triangleAutoEdgeRange(
          options.autoEdge,
          texture,
          [a, b, c],
          options.uvProjection,
          options.uvScale
        )
      : undefined;
    const crossesHardEdge = autoEdgeRange
      ? autoEdgeRange.hasEdge
      : range.min < options.threshold && range.max >= options.threshold;
    if (
      (options.edgeProfile === 'hard' || options.edgeProfile === 'auto') &&
      options.hardContourGeometry &&
      crossesHardEdge
    ) {
      hardSurfaceSpanTexels = autoEdgeRange?.spanTexels ?? range.spanTexels;
    }
    const targetEdgeWidth =
      options.edgeProfile === 'hard' || options.edgeProfile === 'auto'
        ? 1
        : Math.max(options.edgeWidth, 1);
    if (
      options.edgeProfile !== 'smooth' &&
      crossesHardEdge &&
      (autoEdgeRange?.spanTexels ?? range.spanTexels) > targetEdgeWidth
    ) {
      // Discontinuous maps can cross a triangle without touching its vertices,
      // midpoint, or centroid. Keep refining until the transition is localized
      // to approximately the requested edge width in texture space.
      rangeError = Number.POSITIVE_INFINITY;
    }
  }
  if (Math.max(centerError, rangeError) > selectedError) {
    selectedEdge = longestEdge;
  }
  return {
    edge: selectedEdge,
    error: Math.max(selectedError, centerError, rangeError),
    hardSurfaceSpanTexels
  };
}

export interface OpenSubdivAdaptiveFaceLevels {
  levels: Uint8Array;
  activeFaceCount: number;
  maximumLevel: number;
}

/**
 * Limits abrupt inner-rate changes between adjacent screen-space faces.
 * OpenSubdiv can stitch arbitrary edge/inner rates without cracks, but a
 * level-zero face beside a highly diced face produces a conspicuous triangle
 * fan. Propagating a one-level falloff keeps that transition local while still
 * allowing broad flat regions to decay back to one triangle.
 */
export function gradeOpenSubdivFaceLevels(
  indices: ArrayLike<number>,
  levels: Uint8Array,
  ceilings: Uint8Array
) {
  if (levels.length !== ceilings.length) {
    throw new Error('OpenSubdiv face-level ceilings must match face levels.');
  }
  const neighbors = Array.from({ length: levels.length }, () => [] as number[]);
  let vertexStride = 1;
  for (let offset = 0; offset < indices.length; offset++) {
    vertexStride = Math.max(vertexStride, indices[offset] + 1);
  }
  const edgeOwner = new Map<number, number>();
  for (let face = 0; face < levels.length; face++) {
    const offset = face * 3;
    for (let edge = 0; edge < 3; edge++) {
      const first = indices[offset + edge];
      const second = indices[offset + (edge + 1) % 3];
      const key = first < second
        ? first * vertexStride + second
        : second * vertexStride + first;
      const adjacent = edgeOwner.get(key);
      if (adjacent == null) {
        edgeOwner.set(key, face);
      } else if (adjacent !== face) {
        neighbors[face].push(adjacent);
        neighbors[adjacent].push(face);
      }
    }
  }

  const queued = new Uint8Array(levels.length);
  const queue: number[] = [];
  for (let face = 0; face < levels.length; face++) {
    if (levels[face] > 1) {
      queue.push(face);
      queued[face] = 1;
    }
  }
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const face = queue[cursor];
    queued[face] = 0;
    const propagated = levels[face] - 1;
    if (propagated <= 0) continue;
    for (const adjacent of neighbors[face]) {
      const next = Math.min(propagated, ceilings[adjacent]);
      if (next <= levels[adjacent]) continue;
      levels[adjacent] = next;
      if (!queued[adjacent]) {
        queue.push(adjacent);
        queued[adjacent] = 1;
      }
    }
  }
  return levels;
}

/**
 * Classifies base faces before OpenSubdiv evaluation. The level is driven by
 * displaced-surface error rather than absolute height, so elevated but flat
 * regions can remain coarse while coastlines and curved landforms are diced.
 */
export function buildOpenSubdivAdaptiveFaceLevels(
  geometry: Geometry,
  texture: Texture,
  inputOptions: DisplacementTessellationOptions = {}
): OpenSubdivAdaptiveFaceLevels {
  if (!geometry.position || !geometry.indices || !geometry.normal) {
    throw new Error(
      'OpenSubdiv adaptive displacement requires indexed positions and normals.'
    );
  }
  const uvProjection = inputOptions.uvProjection ?? 'none';
  if (!geometry.uv && uvProjection === 'none') {
    throw new Error(
      'UV displacement tessellation requires texture coordinates.'
    );
  }
  const analysis = getHeightAnalysis(texture, true);
  if (!analysis?.heightRanges) {
    throw new Error('The displacement texture is not CPU-readable.');
  }

  const maximumLevel = clampInteger(
    inputOptions.maxSubdivisionLevel,
    3,
    0,
    8
  );
  const minimumLevel = clampInteger(
    inputOptions.minSubdivisionLevel,
    0,
    0,
    maximumLevel
  );
  const maxError = Math.max(inputOptions.maxError ?? 0.0025, 0);
  const edgeProfile = inputOptions.edgeProfile ?? 'smooth';
  const threshold = Math.min(Math.max(inputOptions.threshold ?? 0.5, 0), 1);
  const displacementOptions: DisplacementSamplingOptions = {
    displacementScale: inputOptions.displacementScale ?? 1,
    displacementBias: inputOptions.displacementBias ?? 0,
    uvProjection,
    uvScale: inputOptions.uvScale ?? 1,
    edgeProfile,
    threshold,
    edgeWidth: Math.max(inputOptions.edgeWidth ?? 2, 0.01),
    hardContourGeometry: inputOptions.hardContourGeometry ?? true,
    contourSmoothing: clampInteger(inputOptions.contourSmoothing, 2, 0, 8),
    contourSubdivisionLevel: clampInteger(
      inputOptions.contourSubdivisionLevel,
      0,
      0,
      3
    ),
    creaseAngle: Math.min(Math.max(inputOptions.creaseAngle ?? 60, 0), 180),
    heightFilter: inputOptions.heightFilter ?? 'linear',
    heightPrefilter: inputOptions.heightPrefilter ?? false,
    edgeDistance:
      edgeProfile === 'hard' || edgeProfile === 'beveled'
        ? getEdgeDistanceField(analysis, threshold)
        : undefined,
    autoEdge: edgeProfile === 'auto' ? getAutoEdgeField(analysis) : undefined
  };
  const position = geometry.position.array;
  const normal = geometry.normal.array;
  const uv = geometry.uv?.array;
  const vertices: WorkingVertex[] = [];
  for (let index = 0; index < Geometry.getVertexCount(geometry); index++) {
    const basePosition: [number, number, number] = [
      position[index * geometry.position.itemSize],
      position[index * geometry.position.itemSize + 1],
      position[index * geometry.position.itemSize + 2]
    ];
    const baseNormal = normalize3([
      normal[index * geometry.normal.itemSize],
      normal[index * geometry.normal.itemSize + 1],
      normal[index * geometry.normal.itemSize + 2]
    ]);
    const vertexUv: [number, number] = uv
      ? [
          uv[index * geometry.uv!.itemSize],
          uv[index * geometry.uv!.itemSize + 1]
        ]
      : [0, 0];
    vertices.push({
      basePosition,
      baseNormal,
      uv: vertexUv,
      displacedPosition: displacedPosition(
        analysis.pixels,
        texture,
        basePosition,
        baseNormal,
        vertexUv,
        displacementOptions
      )
    });
  }

  const sourceIndices = geometry.indices.array;
  const levels = new Uint8Array(Math.floor(sourceIndices.length / 3));
  const faceSubdivisionLevels = inputOptions.faceSubdivisionLevels;
  if (
    faceSubdivisionLevels &&
    faceSubdivisionLevels.length !== levels.length
  ) {
    throw new Error(
      'OpenSubdiv face dicing levels must match the source triangle count.'
    );
  }
  let activeFaceCount = 0;
  for (let face = 0; face < levels.length; face++) {
    if (maximumLevel === 0) continue;
    if (minimumLevel === maximumLevel) {
      levels[face] = minimumLevel;
      activeFaceCount++;
      continue;
    }
    const offset = face * 3;
    const candidate = refinementCandidate(
      {
        vertices: [
          sourceIndices[offset],
          sourceIndices[offset + 1],
          sourceIndices[offset + 2]
        ],
        depth: 0
      },
      vertices,
      analysis.pixels,
      texture,
      analysis.heightRanges,
      displacementOptions,
      maxError > 0 ? maxError : Number.POSITIVE_INFINITY
    );
    if (!(candidate.error > maxError)) {
      if (minimumLevel > 0) {
        levels[face] = minimumLevel;
        activeFaceCount++;
      }
      continue;
    }
    // Closed hard contours are located exactly by the clipping pass. Select
    // only enough Bfr dicing for the source face's texture footprint instead
    // of letting the discontinuous height jump force the global maximum.
    const faceLevelCap = candidate.hardSurfaceSpanTexels == null
      ? maximumLevel
      : Math.min(
          maximumLevel,
          Math.max(
            0,
            Math.ceil(Math.log2(Math.max(
              candidate.hardSurfaceSpanTexels /
                OPEN_SUBDIV_HARD_CONTOUR_TARGET_TEXEL_SPAN,
              1
            )))
          )
        );
    const adaptiveLevel = !Number.isFinite(candidate.error) || maxError === 0
      ? faceLevelCap
      : Math.min(
          faceLevelCap,
          Math.max(
            1,
            Math.ceil(
              Math.log(Math.max(candidate.error / maxError, 1)) /
                Math.log(4)
            )
          )
        );
    // Screen-space dicing controls density only on faces selected by the
    // height-error mask. Exactly flat regions therefore stay coarse, while
    // selected features can get finer on zoom and coarser outside the view.
    const cameraLevel = Math.min(
      faceSubdivisionLevels?.[face] ?? 0,
      maximumLevel
    );
    const level = faceSubdivisionLevels
      ? Math.max(minimumLevel, cameraLevel)
      : Math.max(minimumLevel, adaptiveLevel);
    if (level === 0) continue;
    levels[face] = level;
    activeFaceCount++;
  }
  if (
    faceSubdivisionLevels &&
    edgeProfile === 'smooth' &&
    minimumLevel < maximumLevel
  ) {
    gradeOpenSubdivFaceLevels(
      sourceIndices,
      levels,
      faceSubdivisionLevels
    );
    activeFaceCount = 0;
    for (const level of levels) {
      if (level > 0) activeFaceCount++;
    }
  }
  return { levels, activeFaceCount, maximumLevel };
}

function splitTriangle(
  triangle: WorkingTriangle,
  splitEdge: string,
  vertices: WorkingVertex[],
  midpointByEdge: Map<string, number>,
  pixels: HeightPixels,
  texture: Texture,
  options: DisplacementSamplingOptions
): [WorkingTriangle, WorkingTriangle] {
  const edge = triangleEdges(triangle).find((candidate) => candidate.key === splitEdge)!;
  let midpoint = midpointByEdge.get(splitEdge);
  if (midpoint == null) {
    const threshold = thresholdSplit(
      vertices,
      edge.a,
      edge.b,
      pixels,
      texture,
      options
    );
    midpoint = vertices.length;
    const vertex = interpolateVertex(
      vertices,
      edge.a,
      edge.b,
      pixels,
      texture,
      options,
      threshold.t
    );
    vertex.thresholdContour = threshold.crossesThreshold;
    vertices.push(vertex);
    midpointByEdge.set(splitEdge, midpoint);
  }
  return [
    { vertices: [edge.a, midpoint, edge.opposite], depth: triangle.depth + 1 },
    { vertices: [midpoint, edge.b, edge.opposite], depth: triangle.depth + 1 }
  ];
}

type ContourSide = -1 | 1;

interface ContourPoint {
  key: string;
  base: WorkingVertex;
  sourceIndex?: number;
  side: -1 | 0 | 1;
  /** One-sided local plateau heights used by automatic multi-level contours. */
  autoHeights?: Map<number, number>;
}

function forceDisplacementHeight(
  vertex: WorkingVertex,
  height: number,
  options: DisplacementSamplingOptions,
  uv = vertex.uv
): WorkingVertex {
  const distance = options.displacementBias + options.displacementScale * height;
  return {
    basePosition: [...vertex.basePosition],
    baseNormal: [...vertex.baseNormal],
    uv: [...uv],
    displacedPosition: [
      vertex.basePosition[0] + vertex.baseNormal[0] * distance,
      vertex.basePosition[1] + vertex.baseNormal[1] * distance,
      vertex.basePosition[2] + vertex.baseNormal[2] * distance
    ],
    color: vertex.color ? [...vertex.color] : undefined,
    materialIndex: vertex.materialIndex?.slice(),
    thresholdContour: true
  };
}

function compactContourPolygon(points: ContourPoint[]) {
  const compacted = points.filter(
    (point, index) => index === 0 || point.key !== points[index - 1].key
  );
  if (
    compacted.length > 1 &&
    compacted[0].key === compacted[compacted.length - 1].key
  ) {
    compacted.pop();
  }
  return compacted;
}

function smoothContourGraph(
  segments: Map<string, [ContourPoint, ContourPoint]>,
  texture: Texture,
  options: DisplacementSamplingOptions
) {
  const iterations = Math.min(Math.max(Math.floor(options.contourSmoothing), 0), 8);
  if (!iterations || !segments.size) return;
  const nodes = new Map<
    string,
    { point: ContourPoint; neighbors: Map<string, ContourPoint> }
  >();
  const addNeighbor = (point: ContourPoint, neighbor: ContourPoint) => {
    let node = nodes.get(point.key);
    if (!node) {
      node = { point, neighbors: new Map() };
      nodes.set(point.key, node);
    }
    node.neighbors.set(neighbor.key, neighbor);
  };
  for (const [start, end] of segments.values()) {
    addNeighbor(start, end);
    addNeighbor(end, start);
  }
  const parameterUv = (point: ContourPoint) => transformedUv(
    texture,
    projectUv(
      point.base.basePosition,
      point.base.baseNormal,
      point.base.uv,
      options.uvProjection,
      options.uvScale
    )
  );
  const wrappedDelta = (value: number) => {
    let result = value;
    while (result > 0.5) result--;
    while (result < -0.5) result++;
    return result;
  };

  for (let iteration = 0; iteration < iterations; iteration++) {
    const updates = new Map<
      string,
      { position: [number, number, number]; normal: [number, number, number] }
    >();
    for (const [key, node] of nodes) {
      const neighbors = [...node.neighbors.values()];
      if (neighbors.length !== 2) continue;
      const centerUv = parameterUv(node.point);
      const firstUv = parameterUv(neighbors[0]);
      const secondUv = parameterUv(neighbors[1]);
      const firstDirection = [
        wrappedDelta(firstUv[0] - centerUv[0]),
        wrappedDelta(firstUv[1] - centerUv[1])
      ];
      const secondDirection = [
        wrappedDelta(secondUv[0] - centerUv[0]),
        wrappedDelta(secondUv[1] - centerUv[1])
      ];
      const firstLength = Math.hypot(...firstDirection);
      const secondLength = Math.hypot(...secondDirection);
      if (firstLength < 1e-9 || secondLength < 1e-9) continue;
      const directionDot =
        (firstDirection[0] * secondDirection[0] +
          firstDirection[1] * secondDirection[1]) /
        (firstLength * secondLength);
      // Relax only locally straight texture contours. Checker corners and
      // junctions stay pinned, preserving the intended hard-surface shape.
      if (directionDot > -0.8) continue;
      const center = node.point.base.basePosition;
      const first = neighbors[0].base.basePosition;
      const second = neighbors[1].base.basePosition;
      const centerNormal = node.point.base.baseNormal;
      const firstNormal = neighbors[0].base.baseNormal;
      const secondNormal = neighbors[1].base.baseNormal;
      const average: [number, number, number] = [
        (first[0] + second[0]) * 0.5,
        (first[1] + second[1]) * 0.5,
        (first[2] + second[2]) * 0.5
      ];
      const delta = [
        average[0] - center[0],
        average[1] - center[1],
        average[2] - center[2]
      ];
      const normalDistance =
        delta[0] * centerNormal[0] +
        delta[1] * centerNormal[1] +
        delta[2] * centerNormal[2];
      updates.set(key, {
        position: [
          center[0] +
            (delta[0] - centerNormal[0] * normalDistance) * 0.5,
          center[1] +
            (delta[1] - centerNormal[1] * normalDistance) * 0.5,
          center[2] +
            (delta[2] - centerNormal[2] * normalDistance) * 0.5
        ],
        normal: normalize3([
          centerNormal[0] * 0.5 +
            (firstNormal[0] + secondNormal[0]) * 0.25,
          centerNormal[1] * 0.5 +
            (firstNormal[1] + secondNormal[1]) * 0.25,
          centerNormal[2] * 0.5 +
            (firstNormal[2] + secondNormal[2]) * 0.25
        ])
      });
    }
    for (const [key, update] of updates) {
      const point = nodes.get(key)!.point;
      point.base.basePosition = update.position;
      point.base.baseNormal = update.normal;
    }
  }
}

function densifyContourSegments(
  segments: Map<string, [ContourPoint, ContourPoint]>,
  polygons: Array<{ low: ContourPoint[]; high: ContourPoint[]; depth: number }>,
  contourSubdivisionLevel: number,
  options: DisplacementSamplingOptions
) {
  const level = Math.min(
    Math.max(Math.floor(contourSubdivisionLevel), 0),
    3
  );
  if (!level || options.uvProjection !== 'none' || !segments.size) {
    return segments;
  }
  const segmentCount = 1 << level;
  const chains = new Map<string, ContourPoint[]>();
  const projectToTangentPlane = (
    point: ArrayLike<number>,
    origin: ArrayLike<number>,
    normal: ArrayLike<number>
  ): [number, number, number] => {
    const distance =
      (point[0] - origin[0]) * normal[0] +
      (point[1] - origin[1]) * normal[1] +
      (point[2] - origin[2]) * normal[2];
    return [
      point[0] - normal[0] * distance,
      point[1] - normal[1] * distance,
      point[2] - normal[2] * distance
    ];
  };
  for (const [key, [start, end]] of segments) {
    const p0 = start.base.basePosition;
    const p1 = end.base.basePosition;
    const n0 = start.base.baseNormal;
    const n1 = end.base.baseNormal;
    const chain = [start];
    for (let index = 1; index < segmentCount; index++) {
      const t = index / segmentCount;
      const linear = mix3(p0, p1, t);
      // Phong tessellation blends projections onto both endpoint tangent
      // planes. Unlike an unconstrained cubic it remains local to the chord,
      // so increasing contour density cannot introduce overshoot spikes.
      const basePosition = mix3(
        projectToTangentPlane(linear, p0, n0),
        projectToTangentPlane(linear, p1, n1),
        t
      );
      const baseNormal = normalize3(mix3(n0, n1, t));
      const uv = mix2(start.base.uv, end.base.uv, t);
      chain.push({
        key: `${key}:curve:${index}`,
        side: 0,
        autoHeights: start.autoHeights && end.autoHeights
          ? new Map(
              [...start.autoHeights]
                .filter(([region]) => end.autoHeights!.has(region))
                .map(([region, height]) => [
                  region,
                  height * (1 - t) + end.autoHeights!.get(region)! * t
                ])
            )
          : undefined,
        base: {
          basePosition,
          baseNormal,
          uv,
          displacedPosition: [...basePosition],
          color: start.base.color && end.base.color
            ? mix3(start.base.color, end.base.color, t)
            : start.base.color ?? end.base.color,
          materialIndex: t < 0.5
            ? start.base.materialIndex?.slice()
            : end.base.materialIndex?.slice(),
          thresholdContour: true
        }
      });
    }
    chain.push(end);
    chains.set(key, chain);
  }
  const expandPolygon = (polygon: ContourPoint[]) => {
    const expanded: ContourPoint[] = [];
    for (let index = 0; index < polygon.length; index++) {
      const start = polygon[index];
      const end = polygon[(index + 1) % polygon.length];
      expanded.push(start);
      if (start.side !== 0 || end.side !== 0) continue;
      const key = [start.key, end.key].sort().join('|');
      const chain = chains.get(key);
      if (!chain) continue;
      const oriented = chain[0].key === start.key ? chain : [...chain].reverse();
      expanded.push(...oriented.slice(1, -1));
    }
    return expanded;
  };
  for (const polygon of polygons) {
    polygon.low = expandPolygon(polygon.low);
    polygon.high = expandPolygon(polygon.high);
  }
  const subdivided = new Map<string, [ContourPoint, ContourPoint]>();
  for (const chain of chains.values()) {
    for (let index = 0; index + 1 < chain.length; index++) {
      subdivided.set(
        `${chain[index].key}|${chain[index + 1].key}`,
        [chain[index], chain[index + 1]]
      );
    }
  }
  return subdivided;
}

/**
 * Clips hard-threshold triangles into separate low/high surface polygons and
 * closes every height discontinuity with an explicitly triangulated wall.
 * The contour is cached per source edge, so neighboring faces share the same
 * base-space intersection even though their displaced surface vertices split.
 */
function remeshHardContours(
  vertices: WorkingVertex[],
  triangles: WorkingTriangle[],
  pixels: HeightPixels,
  texture: Texture,
  options: DisplacementSamplingOptions,
  maxTriangles: number
) {
  if (
    !options.hardContourGeometry ||
    options.edgeProfile !== 'hard' ||
    !options.edgeDistance
  ) {
    return { triangles, triangleBudgetReached: false };
  }

  const originalVertexCount = vertices.length;
  const sampledSides = new Int8Array(originalVertexCount);
  for (let index = 0; index < originalVertexCount; index++) {
    const vertex = vertices[index];
    sampledSides[index] = vertex.thresholdContour
      ? 0
      : sampleRawHeight(
          pixels,
          texture,
          vertex.basePosition,
          vertex.baseNormal,
          vertex.uv,
          options
        ) >= options.threshold
        ? 1
        : -1;
  }

  // OpenSubdiv keeps face-varying UVs by duplicating vertices at face
  // boundaries. Index-based contour keys therefore leave visually continuous
  // contour runs disconnected, making smoothing a no-op and curve samples
  // collinear. Weld only mapping-equivalent contour points: position and
  // normal protect geometric creases, while wrapped mapped UV protects UV
  // islands that happen to overlap in object space.
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < originalVertexCount; index++) {
    const position = vertices[index].basePosition;
    for (let axis = 0; axis < 3; axis++) {
      minimum[axis] = Math.min(minimum[axis], position[axis]);
      maximum[axis] = Math.max(maximum[axis], position[axis]);
    }
  }
  const positionTolerance = Math.max(
    Math.hypot(
      maximum[0] - minimum[0],
      maximum[1] - minimum[1],
      maximum[2] - minimum[2]
    ) * 1e-6,
    1e-12
  );
  const quantize = (value: number, tolerance: number) =>
    Math.round(value / tolerance);
  const wrappedCoordinate = (value: number) => {
    const wrapped = fract(value);
    return wrapped > 1 - 1e-6 ? 0 : wrapped;
  };
  const contourKey = (vertex: WorkingVertex) => {
    const uv = transformedUv(
      texture,
      projectUv(
        vertex.basePosition,
        vertex.baseNormal,
        vertex.uv,
        options.uvProjection,
        options.uvScale
      )
    );
    return [
      'c',
      ...vertex.basePosition.map((value, axis) =>
        quantize(value - minimum[axis], positionTolerance)
      ),
      ...vertex.baseNormal.map((value) => quantize(value, 1e-5)),
      quantize(wrappedCoordinate(uv[0]), 1e-6),
      quantize(wrappedCoordinate(uv[1]), 1e-6)
    ].join(':');
  };
  const contourPoints = new Map<string, ContourPoint>();
  const canonicalContourPoint = (
    base: WorkingVertex,
    sourceIndex?: number
  ) => {
    const key = contourKey(base);
    const cached = contourPoints.get(key);
    if (cached) return cached;
    const point: ContourPoint = { key, base, sourceIndex, side: 0 };
    contourPoints.set(key, point);
    return point;
  };
  const originalPoint = (index: number): ContourPoint =>
    sampledSides[index] === 0
      ? canonicalContourPoint(vertices[index], index)
      : {
          key: `v:${index}`,
          base: vertices[index],
          sourceIndex: index,
          side: sampledSides[index] as -1 | 1
        };
  const intersections = new Map<string, ContourPoint>();
  const intersection = (a: ContourPoint, b: ContourPoint) => {
    if (a.side === 0) return a;
    if (b.side === 0) return b;
    const aIndex = a.sourceIndex!;
    const bIndex = b.sourceIndex!;
    const sourceEdgeKey = edgeKey(aIndex, bIndex);
    const cached = intersections.get(sourceEdgeKey);
    if (cached) return cached;
    const split = thresholdSplit(
      vertices,
      aIndex,
      bIndex,
      pixels,
      texture,
      options
    );
    const base = interpolateVertex(
      vertices,
      aIndex,
      bIndex,
      pixels,
      texture,
      options,
      split.t
    );
    base.thresholdContour = true;
    const point = canonicalContourPoint(base);
    intersections.set(sourceEdgeKey, point);
    return point;
  };
  const clip = (polygon: ContourPoint[], side: ContourSide) => {
    const result: ContourPoint[] = [];
    for (let index = 0; index < polygon.length; index++) {
      const start = polygon[index];
      const end = polygon[(index + 1) % polygon.length];
      const startInside = start.side === 0 || start.side === side;
      const endInside = end.side === 0 || end.side === side;
      if (endInside) {
        if (!startInside) result.push(intersection(start, end));
        result.push(end);
      } else if (startInside) {
        result.push(intersection(start, end));
      }
    }
    return compactContourPolygon(result);
  };

  const lowHeight = options.edgeDistance.minimum;
  const highHeight = options.edgeDistance.maximum;
  const surfaceVertices = new Map<string, number>();
  const surfaceVertex = (point: ContourPoint, side: ContourSide) => {
    if (point.side !== 0 && point.sourceIndex != null) return point.sourceIndex;
    const key = `${point.key}:${side}`;
    const cached = surfaceVertices.get(key);
    if (cached != null) return cached;
    const index = vertices.length;
    vertices.push(forceDisplacementHeight(
      point.base,
      side === 1 ? highHeight : lowHeight,
      options
    ));
    surfaceVertices.set(key, index);
    return index;
  };
  const generated: WorkingTriangle[] = [];
  const segments = new Map<string, [ContourPoint, ContourPoint]>();
  const clippedPolygons: Array<{
    low: ContourPoint[];
    high: ContourPoint[];
    depth: number;
  }> = [];
  const appendPolygon = (
    polygon: ContourPoint[],
    side: ContourSide,
    depth: number
  ) => {
    if (polygon.length < 3) return;
    const root = surfaceVertex(polygon[0], side);
    for (let index = 1; index + 1 < polygon.length; index++) {
      generated.push({
        vertices: [
          root,
          surfaceVertex(polygon[index], side),
          surfaceVertex(polygon[index + 1], side)
        ],
        depth
      });
    }
  };

  for (const triangle of triangles) {
    const polygon = triangle.vertices.map(originalPoint);
    const low = clip(polygon, -1);
    const high = clip(polygon, 1);
    clippedPolygons.push({ low, high, depth: triangle.depth });

    const contour = new Map<string, ContourPoint>();
    for (const point of [...low, ...high]) {
      if (point.side === 0) contour.set(point.key, point);
    }
    const contourPoints = [...contour.values()];
    const highPoint = polygon.find((point) => point.side === 1);
    if (contourPoints.length === 2 && highPoint) {
      let [start, end] = contourPoints;
      const direction = [
        end.base.basePosition[0] - start.base.basePosition[0],
        end.base.basePosition[1] - start.base.basePosition[1],
        end.base.basePosition[2] - start.base.basePosition[2]
      ];
      const towardHigh = [
        highPoint.base.basePosition[0] - start.base.basePosition[0],
        highPoint.base.basePosition[1] - start.base.basePosition[1],
        highPoint.base.basePosition[2] - start.base.basePosition[2]
      ];
      const originalA = vertices[triangle.vertices[0]].basePosition;
      const originalB = vertices[triangle.vertices[1]].basePosition;
      const originalC = vertices[triangle.vertices[2]].basePosition;
      const ab = [
        originalB[0] - originalA[0],
        originalB[1] - originalA[1],
        originalB[2] - originalA[2]
      ];
      const ac = [
        originalC[0] - originalA[0],
        originalC[1] - originalA[1],
        originalC[2] - originalA[2]
      ];
      const faceNormal = [
        ab[1] * ac[2] - ab[2] * ac[1],
        ab[2] * ac[0] - ab[0] * ac[2],
        ab[0] * ac[1] - ab[1] * ac[0]
      ];
      const highOnLeft =
        (direction[1] * towardHigh[2] - direction[2] * towardHigh[1]) * faceNormal[0] +
        (direction[2] * towardHigh[0] - direction[0] * towardHigh[2]) * faceNormal[1] +
        (direction[0] * towardHigh[1] - direction[1] * towardHigh[0]) * faceNormal[2];
      if (highOnLeft < 0) [start, end] = [end, start];
      const segmentKey = [start.key, end.key].sort().join('|');
      segments.set(segmentKey, [start, end]);
    }
  }

  smoothContourGraph(segments, texture, options);
  const baseSurfaceTriangles = clippedPolygons.reduce(
    (sum, polygon) =>
      sum +
      Math.max(polygon.low.length - 2, 0) +
      Math.max(polygon.high.length - 2, 0),
    0
  );
  const baseContourTriangles = baseSurfaceTriangles + segments.size * 2;
  const requestedContourSubdivisionLevel = options.contourSubdivisionLevel;
  let contourSubdivisionLevel = requestedContourSubdivisionLevel;
  while (
    contourSubdivisionLevel > 0 &&
    baseContourTriangles +
      segments.size * 4 * ((1 << contourSubdivisionLevel) - 1) >
      maxTriangles
  ) {
    contourSubdivisionLevel--;
  }
  const contourDensityClamped =
    contourSubdivisionLevel < requestedContourSubdivisionLevel;
  const wallSegments = densifyContourSegments(
    segments,
    clippedPolygons,
    contourSubdivisionLevel,
    options
  );
  for (const polygon of clippedPolygons) {
    appendPolygon(polygon.low, -1, polygon.depth);
    appendPolygon(polygon.high, 1, polygon.depth);
  }

  // Side-wall vertices must be shared along a contour run. Duplicating all
  // four vertices per segment gives every wall quad its own normal, turning a
  // smooth curved border into a row of shiny saw teeth. The later crease pass
  // still splits true checker corners according to creaseAngle.
  const wallVertices = new Map<string, number>();
  const appendWallVertex = (point: ContourPoint, side: ContourSide) => {
    const key = `${point.key}:${side}`;
    const cached = wallVertices.get(key);
    if (cached != null) return cached;
    const index = vertices.length;
    vertices.push(forceDisplacementHeight(
      point.base,
      side === 1 ? highHeight : lowHeight,
      options,
      point.base.uv
    ));
    wallVertices.set(key, index);
    return index;
  };
  for (const [start, end] of wallSegments.values()) {
    const highStart = appendWallVertex(start, 1);
    const lowStart = appendWallVertex(start, -1);
    const lowEnd = appendWallVertex(end, -1);
    const highEnd = appendWallVertex(end, 1);
    if (options.displacementScale * (highHeight - lowHeight) >= 0) {
      generated.push(
        { vertices: [highStart, lowStart, lowEnd], depth: 0 },
        { vertices: [highStart, lowEnd, highEnd], depth: 0 }
      );
    } else {
      generated.push(
        { vertices: [highStart, lowEnd, lowStart], depth: 0 },
        { vertices: [highStart, highEnd, lowEnd], depth: 0 }
      );
    }
  }

  if (generated.length > maxTriangles) {
    // A partially closed contour is worse than the original sloped triangle:
    // discard the entire contour pass when its reserved budget is insufficient.
    vertices.length = originalVertexCount;
    return { triangles, triangleBudgetReached: true };
  }
  return {
    triangles: generated,
    triangleBudgetReached: contourDensityClamped
  };
}

/**
 * Closes locally detected multi-level transitions. Unlike the legacy hard
 * profile, each contour keeps the actual one-sided height from the image, so
 * a single graphic height map may contain any number of plateaus.
 */
function remeshAutoContours(
  vertices: WorkingVertex[],
  triangles: WorkingTriangle[],
  pixels: HeightPixels,
  texture: Texture,
  options: DisplacementSamplingOptions,
  maxTriangles: number
) {
  if (
    !options.hardContourGeometry ||
    options.edgeProfile !== 'auto' ||
    !options.autoEdge ||
    !options.autoEdge.hardEdgeCount
  ) {
    return { triangles, triangleBudgetReached: false };
  }

  type AutoPoint = ContourPoint & { region?: number };
  const originalVertexCount = vertices.length;
  const sampledRegions = new Int32Array(originalVertexCount);
  const sampledHeights = new Float32Array(originalVertexCount);
  for (let index = 0; index < originalVertexCount; index++) {
    const vertex = vertices[index];
    sampledRegions[index] = sampleAutoRegion(
      texture,
      vertex.basePosition,
      vertex.baseNormal,
      vertex.uv,
      options
    );
    sampledHeights[index] = sampleAutoHeight(
      pixels,
      texture,
      vertex.basePosition,
      vertex.baseNormal,
      vertex.uv,
      options
    );
  }

  // Connected-component ids describe topology, not height. At a checker
  // junction the two diagonal texel islands on the same plateau therefore
  // have different ids, so one diced triangle can appear to contain three
  // regions even though it contains only two actual surface heights. Leaving
  // that triangle uncut creates open surface and wall edges around the
  // junction. Alias locally observed constant-height regions before clipping
  // so binary and repeated-height graphics retain two-sided closed contours.
  const plateauTolerance = pixels.normalized ? 0.5 / 255 : 1e-6;
  const regionHeightRanges = new Map<
    number,
    { minimum: number; maximum: number }
  >();
  for (let index = 0; index < originalVertexCount; index++) {
    const region = sampledRegions[index];
    const height = sampledHeights[index];
    const range = regionHeightRanges.get(region);
    if (range) {
      range.minimum = Math.min(range.minimum, height);
      range.maximum = Math.max(range.maximum, height);
    } else {
      regionHeightRanges.set(region, { minimum: height, maximum: height });
    }
  }
  const regionParents = new Map<number, number>();
  const findRegion = (region: number): number => {
    const parent = regionParents.get(region);
    if (parent == null) {
      regionParents.set(region, region);
      return region;
    }
    if (parent === region) return region;
    const root = findRegion(parent);
    regionParents.set(region, root);
    return root;
  };
  const unionRegions = (a: number, b: number) => {
    const rootA = findRegion(a);
    const rootB = findRegion(b);
    if (rootA === rootB) return;
    const root = Math.min(rootA, rootB);
    regionParents.set(rootA, root);
    regionParents.set(rootB, root);
  };
  for (const triangle of triangles) {
    for (const [aCorner, bCorner] of [[0, 1], [1, 2], [2, 0]]) {
      const a = triangle.vertices[aCorner];
      const b = triangle.vertices[bCorner];
      const aRegion = sampledRegions[a];
      const bRegion = sampledRegions[b];
      if (aRegion === bRegion) continue;
      const aRange = regionHeightRanges.get(aRegion)!;
      const bRange = regionHeightRanges.get(bRegion)!;
      if (
        aRange.maximum - aRange.minimum <= plateauTolerance &&
        bRange.maximum - bRange.minimum <= plateauTolerance &&
        Math.abs(
          (aRange.minimum + aRange.maximum) * 0.5 -
          (bRange.minimum + bRange.maximum) * 0.5
        ) <= plateauTolerance
      ) {
        unionRegions(aRegion, bRegion);
      }
    }
  }
  for (let index = 0; index < originalVertexCount; index++) {
    sampledRegions[index] = findRegion(sampledRegions[index]);
  }

  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < originalVertexCount; index++) {
    const position = vertices[index].basePosition;
    for (let axis = 0; axis < 3; axis++) {
      minimum[axis] = Math.min(minimum[axis], position[axis]);
      maximum[axis] = Math.max(maximum[axis], position[axis]);
    }
  }
  const positionTolerance = Math.max(
    Math.hypot(
      maximum[0] - minimum[0],
      maximum[1] - minimum[1],
      maximum[2] - minimum[2]
    ) * 1e-6,
    1e-12
  );
  const quantize = (value: number, tolerance: number) =>
    Math.round(value / tolerance);
  const wrappedCoordinate = (value: number) => {
    const wrapped = fract(value);
    return wrapped > 1 - 1e-6 ? 0 : wrapped;
  };
  const contourKey = (vertex: WorkingVertex) => {
    const uv = transformedUv(
      texture,
      projectUv(
        vertex.basePosition,
        vertex.baseNormal,
        vertex.uv,
        options.uvProjection,
        options.uvScale
      )
    );
    return [
      'a',
      ...vertex.basePosition.map((value, axis) =>
        quantize(value - minimum[axis], positionTolerance)
      ),
      ...vertex.baseNormal.map((value) => quantize(value, 1e-5)),
      quantize(wrappedCoordinate(uv[0]), 1e-6),
      quantize(wrappedCoordinate(uv[1]), 1e-6)
    ].join(':');
  };
  const contourPoints = new Map<string, AutoPoint>();
  const canonicalContourPoint = (
    base: WorkingVertex,
    heights: Map<number, number>
  ) => {
    const key = contourKey(base);
    const cached = contourPoints.get(key);
    if (cached) {
      cached.autoHeights ??= new Map();
      for (const [region, height] of heights) {
        cached.autoHeights.set(region, height);
      }
      return cached;
    }
    const point: AutoPoint = {
      key,
      base,
      side: 0,
      autoHeights: new Map(heights)
    };
    contourPoints.set(key, point);
    return point;
  };
  const originalPoint = (index: number): AutoPoint => ({
    key: `v:${index}`,
    base: vertices[index],
    sourceIndex: index,
    side: 1,
    region: sampledRegions[index],
    autoHeights: new Map([[sampledRegions[index], sampledHeights[index]]])
  });
  const sampleEdge = (a: WorkingVertex, b: WorkingVertex, t: number) => {
    const position = mix3(a.basePosition, b.basePosition, t);
    const normal = normalize3(mix3(a.baseNormal, b.baseNormal, t));
    const uv = mix2(a.uv, b.uv, t);
    return {
      region: findRegion(
        sampleAutoRegion(texture, position, normal, uv, options)
      ),
      height: sampleAutoHeight(pixels, texture, position, normal, uv, options)
    };
  };
  const intersections = new Map<string, AutoPoint>();
  const intersection = (a: AutoPoint, b: AutoPoint) => {
    if (a.region == null) return a;
    if (b.region == null) return b;
    const aIndex = a.sourceIndex!;
    const bIndex = b.sourceIndex!;
    const sourceEdgeKey = edgeKey(aIndex, bIndex);
    const cached = intersections.get(sourceEdgeKey);
    if (cached) return cached;
    const va = vertices[aIndex];
    const vb = vertices[bIndex];
    let low = 0;
    let high = 1;
    let lowSample = sampleEdge(va, vb, low);
    let highSample = sampleEdge(va, vb, high);
    for (let iteration = 0; iteration < 14; iteration++) {
      const middle = (low + high) * 0.5;
      const sample = sampleEdge(va, vb, middle);
      if (sample.region === lowSample.region) {
        low = middle;
        lowSample = sample;
      } else {
        high = middle;
        highSample = sample;
      }
    }
    const base = interpolateVertex(
      vertices,
      aIndex,
      bIndex,
      pixels,
      texture,
      options,
      (low + high) * 0.5
    );
    base.thresholdContour = true;
    const point = canonicalContourPoint(base, new Map([
      [a.region, a.region === lowSample.region ? lowSample.height : highSample.height],
      [b.region, b.region === highSample.region ? highSample.height : lowSample.height]
    ]));
    intersections.set(sourceEdgeKey, point);
    return point;
  };
  const clip = (polygon: AutoPoint[], region: number) => {
    const result: AutoPoint[] = [];
    for (let index = 0; index < polygon.length; index++) {
      const start = polygon[index];
      const end = polygon[(index + 1) % polygon.length];
      const startInside = start.region == null || start.region === region;
      const endInside = end.region == null || end.region === region;
      if (endInside) {
        if (!startInside) result.push(intersection(start, end));
        result.push(end);
      } else if (startInside) {
        result.push(intersection(start, end));
      }
    }
    return compactContourPolygon(result) as AutoPoint[];
  };

  const generated: WorkingTriangle[] = [];
  const segments = new Map<string, [ContourPoint, ContourPoint]>();
  const clippedPolygons: Array<{
    low: ContourPoint[];
    high: ContourPoint[];
    lowRegion: number;
    highRegion: number;
    depth: number;
  }> = [];
  for (const triangle of triangles) {
    const polygon = triangle.vertices.map(originalPoint);
    const regions = [...new Set(polygon.map((point) => point.region!))];
    if (regions.length !== 2) {
      // Three-region junctions are already localized to the final diced
      // triangle. Keeping that tiny source triangle avoids inventing a
      // topologically ambiguous connection between unrelated contours.
      generated.push(triangle);
      continue;
    }
    const averageHeight = (region: number) => {
      const samples = polygon
        .filter((point) => point.region === region)
        .map((point) => point.autoHeights!.get(region)!);
      return samples.reduce((sum, value) => sum + value, 0) / samples.length;
    };
    let lowRegion = regions[0];
    let highRegion = regions[1];
    if (averageHeight(lowRegion) > averageHeight(highRegion)) {
      [lowRegion, highRegion] = [highRegion, lowRegion];
    }
    const low = clip(polygon, lowRegion);
    const high = clip(polygon, highRegion);
    clippedPolygons.push({
      low,
      high,
      lowRegion,
      highRegion,
      depth: triangle.depth
    });

    const contour = new Map<string, AutoPoint>();
    for (const point of [...low, ...high]) {
      if (point.region == null) contour.set(point.key, point);
    }
    const points = [...contour.values()];
    const highPoint = polygon.find((point) => point.region === highRegion);
    if (points.length !== 2 || !highPoint) continue;
    let [start, end] = points;
    const direction = [
      end.base.basePosition[0] - start.base.basePosition[0],
      end.base.basePosition[1] - start.base.basePosition[1],
      end.base.basePosition[2] - start.base.basePosition[2]
    ];
    const towardHigh = [
      highPoint.base.basePosition[0] - start.base.basePosition[0],
      highPoint.base.basePosition[1] - start.base.basePosition[1],
      highPoint.base.basePosition[2] - start.base.basePosition[2]
    ];
    const [a, b, c] = triangle.vertices.map(
      (index) => vertices[index].basePosition
    );
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const faceNormal = [
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0]
    ];
    const highOnLeft =
      (direction[1] * towardHigh[2] - direction[2] * towardHigh[1]) * faceNormal[0] +
      (direction[2] * towardHigh[0] - direction[0] * towardHigh[2]) * faceNormal[1] +
      (direction[0] * towardHigh[1] - direction[1] * towardHigh[0]) * faceNormal[2];
    if (highOnLeft < 0) [start, end] = [end, start];
    segments.set([start.key, end.key].sort().join('|'), [start, end]);
  }

  smoothContourGraph(segments, texture, options);
  const baseSurfaceTriangles = clippedPolygons.reduce(
    (sum, polygon) =>
      sum + Math.max(polygon.low.length - 2, 0) +
      Math.max(polygon.high.length - 2, 0),
    0
  );
  const baseContourTriangles =
    generated.length + baseSurfaceTriangles + segments.size * 2;
  const requestedContourSubdivisionLevel = options.contourSubdivisionLevel;
  let contourSubdivisionLevel = requestedContourSubdivisionLevel;
  while (
    contourSubdivisionLevel > 0 &&
    baseContourTriangles +
      segments.size * 4 * ((1 << contourSubdivisionLevel) - 1) >
      maxTriangles
  ) {
    contourSubdivisionLevel--;
  }
  const contourDensityClamped =
    contourSubdivisionLevel < requestedContourSubdivisionLevel;
  const wallSegments = densifyContourSegments(
    segments,
    clippedPolygons,
    contourSubdivisionLevel,
    options
  );

  const surfaceVertices = new Map<string, number>();
  const surfaceVertex = (point: AutoPoint, region: number) => {
    if (point.region != null && point.sourceIndex != null) {
      return point.sourceIndex;
    }
    const key = `${point.key}:${region}`;
    const cached = surfaceVertices.get(key);
    if (cached != null) return cached;
    const height = point.autoHeights?.get(region) ?? sampleAutoHeight(
      pixels,
      texture,
      point.base.basePosition,
      point.base.baseNormal,
      point.base.uv,
      options
    );
    const index = vertices.length;
    vertices.push(forceDisplacementHeight(point.base, height, options));
    surfaceVertices.set(key, index);
    return index;
  };
  const appendPolygon = (
    polygon: AutoPoint[],
    region: number,
    depth: number
  ) => {
    if (polygon.length < 3) return;
    const root = surfaceVertex(polygon[0], region);
    for (let index = 1; index + 1 < polygon.length; index++) {
      generated.push({
        vertices: [
          root,
          surfaceVertex(polygon[index], region),
          surfaceVertex(polygon[index + 1], region)
        ],
        depth
      });
    }
  };
  for (const polygon of clippedPolygons) {
    appendPolygon(polygon.low as AutoPoint[], polygon.lowRegion, polygon.depth);
    appendPolygon(polygon.high as AutoPoint[], polygon.highRegion, polygon.depth);
  }

  const wallVertices = new Map<string, number>();
  const appendWallVertex = (
    point: AutoPoint,
    region: number,
    height: number
  ) => {
    const key = `${point.key}:${region}`;
    const cached = wallVertices.get(key);
    if (cached != null) return cached;
    const index = vertices.length;
    vertices.push(forceDisplacementHeight(point.base, height, options));
    wallVertices.set(key, index);
    return index;
  };
  for (const [startBase, endBase] of wallSegments.values()) {
    const start = startBase as AutoPoint;
    const end = endBase as AutoPoint;
    const commonRegions = [...(start.autoHeights?.keys() ?? [])]
      .filter((region) => end.autoHeights?.has(region));
    if (commonRegions.length < 2) continue;
    commonRegions.sort((left, right) => {
      const leftHeight =
        (start.autoHeights!.get(left)! + end.autoHeights!.get(left)!) * 0.5;
      const rightHeight =
        (start.autoHeights!.get(right)! + end.autoHeights!.get(right)!) * 0.5;
      return leftHeight - rightHeight;
    });
    const lowRegion = commonRegions[0];
    const highRegion = commonRegions[commonRegions.length - 1];
    const lowStartHeight = start.autoHeights!.get(lowRegion)!;
    const highStartHeight = start.autoHeights!.get(highRegion)!;
    const lowEndHeight = end.autoHeights!.get(lowRegion)!;
    const highEndHeight = end.autoHeights!.get(highRegion)!;
    const highStart = appendWallVertex(start, highRegion, highStartHeight);
    const lowStart = appendWallVertex(start, lowRegion, lowStartHeight);
    const lowEnd = appendWallVertex(end, lowRegion, lowEndHeight);
    const highEnd = appendWallVertex(end, highRegion, highEndHeight);
    const heightDelta =
      ((highStartHeight + highEndHeight) -
        (lowStartHeight + lowEndHeight)) * 0.5;
    if (options.displacementScale * heightDelta >= 0) {
      generated.push(
        { vertices: [highStart, lowStart, lowEnd], depth: 0 },
        { vertices: [highStart, lowEnd, highEnd], depth: 0 }
      );
    } else {
      generated.push(
        { vertices: [highStart, lowEnd, lowStart], depth: 0 },
        { vertices: [highStart, highEnd, lowEnd], depth: 0 }
      );
    }
  }

  if (generated.length > maxTriangles) {
    vertices.length = originalVertexCount;
    return { triangles, triangleBudgetReached: true };
  }
  return {
    triangles: generated,
    triangleBudgetReached: contourDensityClamped
  };
}

function createGeometryFromWorkingMesh(
  vertices: WorkingVertex[],
  triangles: WorkingTriangle[],
  hasUvs: boolean,
  hasColors: boolean,
  materialIndexItemSize: number,
  onVertex?: (index: number) => void
) {
  const positions = new Float32Array(vertices.length * 3);
  const uvs = hasUvs ? new Float32Array(vertices.length * 2) : undefined;
  const colors = hasColors ? new Float32Array(vertices.length * 3) : undefined;
  const materialIndices = materialIndexItemSize > 0
    ? new Int32Array(vertices.length * materialIndexItemSize)
    : undefined;
  vertices.forEach((vertex, index) => {
    positions.set(vertex.displacedPosition, index * 3);
    if (uvs) uvs.set(vertex.uv, index * 2);
    if (colors && vertex.color) colors.set(vertex.color, index * 3);
    if (materialIndices && vertex.materialIndex) {
      materialIndices.set(vertex.materialIndex, index * materialIndexItemSize);
    }
    onVertex?.(index);
  });
  const indices = new Uint32Array(triangles.length * 3);
  triangles.forEach((triangle, index) => indices.set(triangle.vertices, index * 3));
  return new Geometry({
    position: new Attribute(positions, 3),
    normal: new Attribute(new Float32Array(positions.length), 3),
    uv: uvs ? new Attribute(uvs, 2) : undefined,
    color: colors ? new Attribute(colors, 3) : undefined,
    indices: new Attribute(indices, 1),
    materialIndex: materialIndices
      ? new Attribute(materialIndices, materialIndexItemSize)
      : undefined
  });
}

function uniformEdgeKey(a: number, b: number) {
  const minimum = Math.min(a, b);
  const maximum = Math.max(a, b);
  const sum = minimum + maximum;
  return (sum * (sum + 1)) / 2 + maximum;
}

function buildUniformTopology(
  geometry: Geometry,
  maxSubdivisionLevel: number,
  maxTriangles: number,
  reportProgress: (progress: number, force?: boolean) => void
): UniformTessellationTopology {
  const sourceVertexCount = Geometry.getVertexCount(geometry);
  const position = geometry.position.array;
  const normal = geometry.normal!.array;
  const uv = geometry.uv?.array;
  const color = geometry.color?.array;
  const materialIndex = geometry.materialIndex?.array;
  const materialIndexItemSize = geometry.materialIndex?.itemSize ?? 0;
  const basePositions = Array.from({ length: sourceVertexCount * 3 }, (_, offset) =>
    position[Math.floor(offset / 3) * geometry.position.itemSize + (offset % 3)]
  );
  const baseNormals: number[] = [];
  const uvs = uv
    ? Array.from({ length: sourceVertexCount * 2 }, (_, offset) =>
        uv[Math.floor(offset / 2) * geometry.uv!.itemSize + (offset % 2)]
      )
    : undefined;
  const colors = color
    ? Array.from({ length: sourceVertexCount * 3 }, (_, offset) =>
        color[Math.floor(offset / 3) * geometry.color!.itemSize + (offset % 3)]
      )
    : undefined;
  const materialIndices = materialIndex
    ? Array.from({ length: sourceVertexCount * materialIndexItemSize }, (_, offset) =>
        materialIndex[offset]
      )
    : undefined;
  for (let index = 0; index < sourceVertexCount; index++) {
    baseNormals.push(...normalize3([
      normal[index * geometry.normal!.itemSize],
      normal[index * geometry.normal!.itemSize + 1],
      normal[index * geometry.normal!.itemSize + 2]
    ]));
  }

  let indices = Array.from(geometry.indices.array);
  let triangleBudgetReached = false;
  const midpointByEdge = new Map<number, number>();
  const appendMidpoint = (a: number, b: number) => {
    const key = uniformEdgeKey(a, b);
    const cached = midpointByEdge.get(key);
    if (cached != null) return cached;
    const midpoint = basePositions.length / 3;
    const position = mix3(
      basePositions.slice(a * 3, a * 3 + 3),
      basePositions.slice(b * 3, b * 3 + 3)
    );
    const normal = normalize3(mix3(
      baseNormals.slice(a * 3, a * 3 + 3),
      baseNormals.slice(b * 3, b * 3 + 3)
    ));
    basePositions.push(...position);
    baseNormals.push(...normal);
    if (uvs) {
      uvs.push(...mix2(uvs.slice(a * 2, a * 2 + 2), uvs.slice(b * 2, b * 2 + 2)));
    }
    if (colors) {
      colors.push(...mix3(
        colors.slice(a * 3, a * 3 + 3),
        colors.slice(b * 3, b * 3 + 3)
      ));
    }
    if (materialIndices) {
      const mixed = mixMaterialIndices(
        materialIndices.slice(a * materialIndexItemSize, (a + 1) * materialIndexItemSize),
        materialIndices.slice(b * materialIndexItemSize, (b + 1) * materialIndexItemSize)
      ) ?? new Array(materialIndexItemSize).fill(0);
      materialIndices.push(...mixed.slice(0, materialIndexItemSize));
    }
    midpointByEdge.set(key, midpoint);
    return midpoint;
  };

  for (let level = 0; level < maxSubdivisionLevel; level++) {
    const triangleCount = indices.length / 3;
    if (triangleCount * 4 > maxTriangles) {
      triangleBudgetReached = true;
      break;
    }
    const refined = new Array<number>(indices.length * 4);
    let writeOffset = 0;
    for (let offset = 0; offset < indices.length; offset += 3) {
      const a = indices[offset];
      const b = indices[offset + 1];
      const c = indices[offset + 2];
      const ab = appendMidpoint(a, b);
      const bc = appendMidpoint(b, c);
      const ca = appendMidpoint(c, a);
      refined[writeOffset++] = a;
      refined[writeOffset++] = ab;
      refined[writeOffset++] = ca;
      refined[writeOffset++] = ab;
      refined[writeOffset++] = b;
      refined[writeOffset++] = bc;
      refined[writeOffset++] = ca;
      refined[writeOffset++] = bc;
      refined[writeOffset++] = c;
      refined[writeOffset++] = ab;
      refined[writeOffset++] = bc;
      refined[writeOffset++] = ca;
    }
    indices = refined;
    reportProgress(
      0.08 + ((level + 1) / Math.max(maxSubdivisionLevel, 1)) * 0.46
    );
  }

  return {
    basePositions: Float32Array.from(basePositions),
    baseNormals: Float32Array.from(baseNormals),
    uvs: uvs ? Float32Array.from(uvs) : undefined,
    colors: colors ? Float32Array.from(colors) : undefined,
    materialIndices: materialIndices ? Int32Array.from(materialIndices) : undefined,
    materialIndexItemSize,
    indices: Uint32Array.from(indices),
    triangleBudgetReached
  };
}

function getUniformTopology(
  geometry: Geometry,
  maxSubdivisionLevel: number,
  maxTriangles: number,
  cacheKey: string | undefined,
  reportProgress: (progress: number, force?: boolean) => void
) {
  const localKey = `${geometry.version}|${maxSubdivisionLevel}|${maxTriangles}`;
  const persistentKey = cacheKey && `${cacheKey}|${maxSubdivisionLevel}|${maxTriangles}`;
  const persistent = persistentKey
    ? uniformTopologiesByCacheKey.get(persistentKey)
    : undefined;
  let entries = uniformTopologiesByGeometry.get(geometry);
  const local = entries?.get(localKey);
  const cached = persistent ?? local;
  if (cached) {
    reportProgress(0.54, true);
    return { topology: cached, cacheHit: true };
  }

  const topology = buildUniformTopology(
    geometry,
    maxSubdivisionLevel,
    maxTriangles,
    reportProgress
  );
  if (!entries) {
    entries = new Map();
    uniformTopologiesByGeometry.set(geometry, entries);
  }
  if (entries.size >= 2) entries.clear();
  entries.set(localKey, topology);
  if (persistentKey) {
    if (
      uniformTopologiesByCacheKey.size >= maxPersistentUniformTopologies &&
      !uniformTopologiesByCacheKey.has(persistentKey)
    ) {
      uniformTopologiesByCacheKey.delete(
        uniformTopologiesByCacheKey.keys().next().value!
      );
    }
    uniformTopologiesByCacheKey.set(persistentKey, topology);
  }
  return { topology, cacheHit: false };
}

function computeUniformVertexHeightFootprints(
  topology: UniformTessellationTopology,
  pixels: HeightPixels,
  texture: Texture,
  options: DisplacementSamplingOptions
) {
  if (
    !options.heightPrefilter ||
    options.heightFilter !== 'linear' ||
    options.edgeProfile !== 'smooth'
  ) {
    return undefined;
  }
  const vertexCount = topology.basePositions.length / 3;
  const mappedUvs = new Float64Array(vertexCount * 2);
  for (let index = 0; index < vertexCount; index++) {
    const positionOffset = index * 3;
    const uvOffset = index * 2;
    const projected = projectUv(
      topology.basePositions.subarray(positionOffset, positionOffset + 3),
      topology.baseNormals.subarray(positionOffset, positionOffset + 3),
      topology.uvs?.subarray(uvOffset, uvOffset + 2) ?? [0, 0],
      options.uvProjection,
      options.uvScale
    );
    const mapped = transformedUv(texture, projected);
    mappedUvs[uvOffset] = mapped[0];
    mappedUvs[uvOffset + 1] = mapped[1];
  }

  const footprints = new Float32Array(vertexCount * 2);
  footprints.fill(1);
  const wrapsGeometrically =
    options.uvProjection === 'spherical' ||
    options.uvProjection === 'cylindrical';
  const appendEdge = (a: number, b: number) => {
    let deltaU = mappedUvs[b * 2] - mappedUvs[a * 2];
    let deltaV = mappedUvs[b * 2 + 1] - mappedUvs[a * 2 + 1];
    if (wrapsGeometrically) {
      deltaU -= Math.round(deltaU);
      deltaV -= Math.round(deltaV);
    }
    const footprintX = Math.max(
      Math.abs(deltaU) * Math.max(pixels.width - 1, 0),
      1
    );
    const footprintY = Math.max(
      Math.abs(deltaV) * Math.max(pixels.height - 1, 0),
      1
    );
    footprints[a * 2] = Math.max(footprints[a * 2], footprintX);
    footprints[a * 2 + 1] = Math.max(footprints[a * 2 + 1], footprintY);
    footprints[b * 2] = Math.max(footprints[b * 2], footprintX);
    footprints[b * 2 + 1] = Math.max(footprints[b * 2 + 1], footprintY);
  };
  for (let offset = 0; offset < topology.indices.length; offset += 3) {
    const a = topology.indices[offset];
    const b = topology.indices[offset + 1];
    const c = topology.indices[offset + 2];
    appendEdge(a, b);
    appendEdge(b, c);
    appendEdge(c, a);
  }
  return footprints;
}

function tessellateUniformDisplacementGeometry(
  geometry: Geometry,
  texture: Texture,
  pixels: HeightPixels,
  maxSubdivisionLevel: number,
  maxTriangles: number,
  displacementOptions: DisplacementSamplingOptions,
  topologyCacheKey: string | undefined,
  buildStart: number,
  reportProgress: (progress: number, force?: boolean) => void
) {
  const topologyStart = now();
  const { topology, cacheHit } = getUniformTopology(
    geometry,
    maxSubdivisionLevel,
    maxTriangles,
    topologyCacheKey,
    reportProgress
  );
  const topologyTimeMs = now() - topologyStart;
  reportProgress(0.55, true);

  const displacementStart = now();
  const vertexCount = topology.basePositions.length / 3;
  const positions = new Float32Array(topology.basePositions.length);
  const heightFootprints = computeUniformVertexHeightFootprints(
    topology,
    pixels,
    texture,
    displacementOptions
  );
  for (let index = 0; index < vertexCount; index++) {
    const offset = index * 3;
    const uvOffset = index * 2;
    const position: [number, number, number] = [
      topology.basePositions[offset],
      topology.basePositions[offset + 1],
      topology.basePositions[offset + 2]
    ];
    const normal: [number, number, number] = [
      topology.baseNormals[offset],
      topology.baseNormals[offset + 1],
      topology.baseNormals[offset + 2]
    ];
    const uv: [number, number] = topology.uvs
      ? [topology.uvs[uvOffset], topology.uvs[uvOffset + 1]]
      : [0, 0];
    positions.set(
      displacedPosition(
        pixels,
        texture,
        position,
        normal,
        uv,
        displacementOptions,
        heightFootprints
          ? [heightFootprints[uvOffset], heightFootprints[uvOffset + 1]]
          : undefined
      ),
      offset
    );
    if ((index & 8191) === 0) {
      reportProgress(0.55 + (index / Math.max(vertexCount, 1)) * 0.29);
    }
  }
  const displacementTimeMs = now() - displacementStart;
  reportProgress(0.84, true);

  let generatedTriangleCount = topology.indices.length / 3;
  let contourBudgetReached = false;
  let result: Geometry;
  if (
    displacementOptions.hardContourGeometry &&
    (
      displacementOptions.edgeProfile === 'hard' ||
      displacementOptions.edgeProfile === 'auto'
    )
  ) {
    const vertices: WorkingVertex[] = [];
    for (let index = 0; index < vertexCount; index++) {
      const positionOffset = index * 3;
      const uvOffset = index * 2;
      vertices.push({
        basePosition: [
          topology.basePositions[positionOffset],
          topology.basePositions[positionOffset + 1],
          topology.basePositions[positionOffset + 2]
        ],
        baseNormal: [
          topology.baseNormals[positionOffset],
          topology.baseNormals[positionOffset + 1],
          topology.baseNormals[positionOffset + 2]
        ],
        uv: topology.uvs
          ? [topology.uvs[uvOffset], topology.uvs[uvOffset + 1]]
          : [0, 0],
        displacedPosition: [
          positions[positionOffset],
          positions[positionOffset + 1],
          positions[positionOffset + 2]
        ],
        color: topology.colors
          ? [
              topology.colors[positionOffset],
              topology.colors[positionOffset + 1],
              topology.colors[positionOffset + 2]
            ]
          : undefined,
        materialIndex: topology.materialIndices
          ? Array.from(topology.materialIndices.subarray(
              index * topology.materialIndexItemSize,
              (index + 1) * topology.materialIndexItemSize
            ))
          : undefined
      });
    }
    const triangles: WorkingTriangle[] = [];
    for (let offset = 0; offset < topology.indices.length; offset += 3) {
      triangles.push({
        vertices: [
          topology.indices[offset],
          topology.indices[offset + 1],
          topology.indices[offset + 2]
        ],
        depth: maxSubdivisionLevel * 2
      });
    }
    const contour = displacementOptions.edgeProfile === 'auto'
      ? remeshAutoContours(
          vertices,
          triangles,
          pixels,
          texture,
          displacementOptions,
          maxTriangles
        )
      : remeshHardContours(
          vertices,
          triangles,
          pixels,
          texture,
          displacementOptions,
          maxTriangles
        );
    generatedTriangleCount = contour.triangles.length;
    contourBudgetReached = contour.triangleBudgetReached;
    result = createGeometryFromWorkingMesh(
      vertices,
      contour.triangles,
      !!topology.uvs,
      !!topology.colors,
      topology.materialIndexItemSize
    );
  } else {
    // Cached topology owns its buffers. Copy attributes because worker results
    // are transferred back to the main thread and therefore become detached.
    result = new Geometry({
      position: new Attribute(positions, 3),
      normal: new Attribute(new Float32Array(positions.length), 3),
      uv: topology.uvs ? new Attribute(topology.uvs.slice(), 2) : undefined,
      color: topology.colors ? new Attribute(topology.colors.slice(), 3) : undefined,
      indices: new Attribute(topology.indices.slice(), 1),
      materialIndex: topology.materialIndices
        ? new Attribute(topology.materialIndices.slice(), topology.materialIndexItemSize)
        : undefined
    });
  }

  const normalStart = now();
  generateCreasedVertexNormals(result, displacementOptions.creaseAngle);
  const normalTimeMs = now() - normalStart;
  reportProgress(0.94, true);
  const tangentStart = now();
  if (result.uv) generateVertexTangents(result);
  const tangentTimeMs = now() - tangentStart;
  reportProgress(0.98, true);
  const boundsStart = now();
  updateBoundingBox(result);
  const boundsTimeMs = now() - boundsStart;
  const completed = setDisplacementTessellationStats(result, {
    sourceTriangles: geometry.indices.array.length / 3,
    generatedTriangles: generatedTriangleCount,
    sourceVertices: Geometry.getVertexCount(geometry),
    generatedVertices: Geometry.getVertexCount(result),
    buildTimeMs: now() - buildStart,
    topologyTimeMs,
    displacementTimeMs,
    normalTimeMs,
    tangentTimeMs,
    boundsTimeMs,
    topologyCacheHit: cacheHit,
    triangleBudgetReached: topology.triangleBudgetReached || contourBudgetReached
  });
  reportProgress(1, true);
  return completed;
}
/**
 * Creates an ordinary triangle mesh whose vertices have been displaced by a
 * height texture. Adaptive mode uses conforming edge bisection: a split edge
 * is propagated to every incident triangle, so the result has no T-junctions.
 */
export function tessellateDisplacementGeometry(
  geometry: Geometry,
  texture: Texture,
  inputOptions: DisplacementTessellationOptions = {},
  onProgress?: (progress: DisplacementTessellationProgress) => void
) {
  const buildStart = now();
  const mode = inputOptions.mode ?? 'adaptive';
  if (mode === 'opensubdiv') {
    throw new Error(`${mode} displacement requires the asynchronous worker path.`);
  }
  let lastReportedProgress = -1;
  const reportProgress = (progress: number, force = false) => {
    if (!onProgress) return;
    const normalized = Math.min(Math.max(progress, 0), 1);
    if (
      !force &&
      lastReportedProgress >= 0 &&
      normalized - lastReportedProgress < 0.01
    ) {
      return;
    }
    lastReportedProgress = normalized;
    onProgress?.({ mode, progress: normalized });
  };
  reportProgress(0, true);
  const analysis = getHeightAnalysis(texture, mode === 'adaptive');
  if (!analysis) throw new Error('The displacement texture is not CPU-readable.');
  reportProgress(0.08, true);
  const { pixels, heightRanges } = analysis;
  if (!geometry.position || !geometry.indices) {
    throw new Error('Displacement tessellation requires indexed positions.');
  }
  if (!geometry.normal) {
    throw new Error('Displacement tessellation requires vertex normals.');
  }
  if (!geometry.uv && (!inputOptions.uvProjection || inputOptions.uvProjection === 'none')) {
    throw new Error('UV displacement tessellation requires texture coordinates.');
  }

  const maxSubdivisionLevel = clampInteger(inputOptions.maxSubdivisionLevel, 3, 0, 8);
  const maxDepth = maxSubdivisionLevel * 2;
  const maxError = Math.max(inputOptions.maxError ?? 0.0025, 0);
  const initialTriangleCount = Math.floor(geometry.indices.array.length / 3);
  const maxTriangles = Math.max(
    clampInteger(inputOptions.maxTriangles, 1_000_000, 1, 8_000_000),
    initialTriangleCount
  );
  const position = geometry.position.array;
  const normal = geometry.normal.array;
  const uv = geometry.uv?.array;
  const color = geometry.color?.array;
  const materialIndex = geometry.materialIndex?.array;
  const edgeProfile = inputOptions.edgeProfile ?? 'smooth';
  const threshold = Math.min(Math.max(inputOptions.threshold ?? 0.5, 0), 1);
  const displacementOptions: DisplacementSamplingOptions = {
    displacementScale: inputOptions.displacementScale ?? 1,
    displacementBias: inputOptions.displacementBias ?? 0,
    uvProjection: inputOptions.uvProjection ?? 'none',
    uvScale: inputOptions.uvScale ?? 1,
    edgeProfile,
    threshold,
    edgeWidth: Math.max(inputOptions.edgeWidth ?? 2, 0.01),
    hardContourGeometry: inputOptions.hardContourGeometry ?? true,
    contourSmoothing: clampInteger(inputOptions.contourSmoothing, 2, 0, 8),
    contourSubdivisionLevel: clampInteger(
      inputOptions.contourSubdivisionLevel,
      0,
      0,
      3
    ),
    creaseAngle: Math.min(Math.max(inputOptions.creaseAngle ?? 60, 0), 180),
    heightFilter: inputOptions.heightFilter ?? 'linear',
    heightPrefilter: inputOptions.heightPrefilter ?? false,
    edgeDistance:
      edgeProfile === 'hard' || edgeProfile === 'beveled'
        ? getEdgeDistanceField(analysis, threshold)
        : undefined,
    autoEdge: edgeProfile === 'auto' ? getAutoEdgeField(analysis) : undefined
  };

  if (mode === 'uniform') {
    return tessellateUniformDisplacementGeometry(
      geometry,
      texture,
      pixels,
      maxSubdivisionLevel,
      maxTriangles,
      displacementOptions,
      inputOptions.topologyCacheKey,
      buildStart,
      reportProgress
    );
  }

  const topologyStart = now();
  const vertices: WorkingVertex[] = [];
  const sourceVertexCount = Geometry.getVertexCount(geometry);
  for (let index = 0; index < sourceVertexCount; index++) {
    const basePosition: [number, number, number] = [
      position[index * geometry.position.itemSize],
      position[index * geometry.position.itemSize + 1],
      position[index * geometry.position.itemSize + 2]
    ];
    const baseNormal = normalize3([
      normal[index * geometry.normal.itemSize],
      normal[index * geometry.normal.itemSize + 1],
      normal[index * geometry.normal.itemSize + 2]
    ]);
    const vertexUv: [number, number] = uv
      ? [uv[index * geometry.uv!.itemSize], uv[index * geometry.uv!.itemSize + 1]]
      : [0, 0];
    vertices.push({
      basePosition,
      baseNormal,
      uv: vertexUv,
      displacedPosition: displacedPosition(
        pixels,
        texture,
        basePosition,
        baseNormal,
        vertexUv,
        displacementOptions
      ),
      color: color
        ? [
            color[index * geometry.color!.itemSize],
            color[index * geometry.color!.itemSize + 1],
            color[index * geometry.color!.itemSize + 2]
          ]
        : undefined,
      materialIndex: materialIndex
        ? Array.from(
            materialIndex.subarray(
              index * geometry.materialIndex!.itemSize,
              (index + 1) * geometry.materialIndex!.itemSize
            )
          )
        : undefined
    });
    if ((index & 4095) === 0) {
      reportProgress(0.08 + (index / Math.max(sourceVertexCount, 1)) * 0.12);
    }
  }
  reportProgress(0.2, true);

  let triangles: WorkingTriangle[] = [];
  const sourceIndices = geometry.indices.array;
  for (let offset = 0; offset + 2 < sourceIndices.length; offset += 3) {
    triangles.push({
      vertices: [sourceIndices[offset], sourceIndices[offset + 1], sourceIndices[offset + 2]],
      depth: 0
    });
  }

  const contourBudgetReserved =
    displacementOptions.hardContourGeometry &&
    (edgeProfile === 'hard' || edgeProfile === 'auto');
  const refinementTriangleBudget = contourBudgetReserved
    ? Math.max(initialTriangleCount, Math.floor(maxTriangles * 0.8))
    : maxTriangles;
  const splitEdges = new Set<string>();
  const midpointByEdge = new Map<string, number>();
  let triangleBudgetReached = false;
  while (triangles.length < refinementTriangleBudget) {
    const edgeOccurrences = new Map<string, number>();
    triangles.forEach((triangle) => {
      triangleEdges(triangle).forEach((edge) => {
        edgeOccurrences.set(edge.key, (edgeOccurrences.get(edge.key) ?? 0) + 1);
      });
    });

    const closureEdges = new Set<string>();
    triangles.forEach((triangle) => {
      triangleEdges(triangle).forEach((edge) => {
        if (splitEdges.has(edge.key)) closureEdges.add(edge.key);
      });
    });
    let reservedSplits = [...closureEdges].reduce(
      (sum, edge) => sum + (edgeOccurrences.get(edge) ?? 0),
      0
    );
    let availableSplits = Math.max(
      refinementTriangleBudget - triangles.length - reservedSplits,
      0
    );

    const candidates = new Map<string, number>();
    triangles.forEach((triangle) => {
      if (triangle.depth >= maxDepth) return;
      if (triangleEdges(triangle).some((edge) => splitEdges.has(edge.key))) return;
      const candidate = refinementCandidate(
        triangle,
        vertices,
        pixels,
        texture,
        heightRanges,
        displacementOptions
      );
      if (candidate.error > maxError) {
        candidates.set(candidate.edge, Math.max(candidates.get(candidate.edge) ?? 0, candidate.error));
      }
    });

    const requestedEdges = new Set<string>();
    [...candidates.entries()]
      .sort((left, right) => right[1] - left[1])
      .forEach(([edge]) => {
        const cost = edgeOccurrences.get(edge) ?? 0;
        if (cost > 0 && cost <= availableSplits) {
          requestedEdges.add(edge);
          splitEdges.add(edge);
          availableSplits -= cost;
          reservedSplits += cost;
        }
      });

    if (candidates.size > requestedEdges.size) {
      triangleBudgetReached = true;
    }

    if (!closureEdges.size && !requestedEdges.size) break;
    const nextTriangles: WorkingTriangle[] = [];
    let deepestTriangle = 0;
    for (const triangle of triangles) {
      const edge = triangleEdges(triangle).find((candidate) => splitEdges.has(candidate.key));
      if (!edge) {
        nextTriangles.push(triangle);
        if (onProgress) {
          deepestTriangle = Math.max(deepestTriangle, triangle.depth);
        }
        continue;
      }
      const split = splitTriangle(
        triangle,
        edge.key,
        vertices,
        midpointByEdge,
        pixels,
        texture,
        displacementOptions
      );
      nextTriangles.push(...split);
      if (onProgress) {
        deepestTriangle = Math.max(deepestTriangle, split[0].depth);
      }
    }
    triangles = nextTriangles;
    if (onProgress) {
      const depthProgress = maxDepth > 0 ? deepestTriangle / maxDepth : 1;
      const budgetProgress = triangles.length / refinementTriangleBudget;
      reportProgress(
        0.2 + Math.min(Math.max(depthProgress, budgetProgress), 1) * 0.62
      );
    }
  }
  const contour = edgeProfile === 'auto'
    ? remeshAutoContours(
        vertices,
        triangles,
        pixels,
        texture,
        displacementOptions,
        maxTriangles
      )
    : remeshHardContours(
        vertices,
        triangles,
        pixels,
        texture,
        displacementOptions,
        maxTriangles
      );
  triangles = contour.triangles;
  triangleBudgetReached ||= contour.triangleBudgetReached;
  reportProgress(0.84, true);

  const positions = new Float32Array(vertices.length * 3);
  const uvs = geometry.uv ? new Float32Array(vertices.length * 2) : undefined;
  const colors = geometry.color ? new Float32Array(vertices.length * 3) : undefined;
  const materialIndices = geometry.materialIndex
    ? new Int32Array(vertices.length * geometry.materialIndex.itemSize)
    : undefined;
  vertices.forEach((vertex, index) => {
    positions.set(vertex.displacedPosition, index * 3);
    if (uvs) uvs.set(vertex.uv, index * 2);
    if (colors && vertex.color) colors.set(vertex.color, index * 3);
    if (materialIndices && vertex.materialIndex) {
      materialIndices.set(vertex.materialIndex, index * geometry.materialIndex!.itemSize);
    }
    if ((index & 8191) === 0) {
      reportProgress(0.84 + (index / Math.max(vertices.length, 1)) * 0.1);
    }
  });
  const generatedIndices = new Uint32Array(triangles.length * 3);
  triangles.forEach((triangle, index) => generatedIndices.set(triangle.vertices, index * 3));

  const result = new Geometry({
    position: new Attribute(positions, 3),
    normal: new Attribute(new Float32Array(positions.length), 3),
    uv: uvs ? new Attribute(uvs, 2) : undefined,
    color: colors ? new Attribute(colors, 3) : undefined,
    indices: new Attribute(generatedIndices, 1),
    materialIndex: materialIndices
      ? new Attribute(materialIndices, geometry.materialIndex!.itemSize)
      : undefined
  });
  const topologyTimeMs = now() - topologyStart;
  const normalStart = now();
  generateCreasedVertexNormals(result, displacementOptions.creaseAngle);
  const normalTimeMs = now() - normalStart;
  reportProgress(0.96, true);
  const tangentStart = now();
  if (result.uv) generateVertexTangents(result);
  const tangentTimeMs = now() - tangentStart;
  const boundsStart = now();
  updateBoundingBox(result);
  const boundsTimeMs = now() - boundsStart;
  const completed = setDisplacementTessellationStats(result, {
    sourceTriangles: initialTriangleCount,
    generatedTriangles: triangles.length,
    sourceVertices: Geometry.getVertexCount(geometry),
    generatedVertices: Geometry.getVertexCount(result),
    buildTimeMs: now() - buildStart,
    topologyTimeMs,
    displacementTimeMs: 0,
    normalTimeMs,
    tangentTimeMs,
    boundsTimeMs,
    topologyCacheHit: false,
    triangleBudgetReached
  });
  reportProgress(1, true);
  return completed;
}
