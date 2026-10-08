import { describe, expect, it } from 'vitest';
import Geometry, { Attribute } from '../../src/scene/Geometry';
import Mesh from '../../src/scene/Mesh';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial';
import Texture from '../../src/scene/Texture';
import {
  cachePreparedMeshGeometry,
  getCachedPreparedMeshGeometry,
  getPreparedMeshGeometryCacheKey,
  getMeshDisplacementTessellationOptions,
  getPreparedMeshGeometry,
  getTrianglesDisplacementRange
} from '../../src/renderer/prepareMeshBVH';
import { collectEmissiveTriangles } from '../../src/renderer/lightSampling';
import { mat4 } from '../../src/math';
import {
  buildOpenSubdivAdaptiveFaceLevels,
  copyDisplacementTextureData,
  getDisplacementTessellationStats,
  gradeOpenSubdivFaceLevels,
  tessellateDisplacementGeometry
} from '../../src/util/tessellateDisplacement';
import {
  precompute,
  prepareForPrecompute,
  resolveFromPrecompute
} from '../../src/util/workerHelper';

function triangleGeometry() {
  return new Geometry({
    position: new Attribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3),
    normal: new Attribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3),
    uv: new Attribute(new Float32Array([0, 0, 1, 0, 0, 1]), 2),
    indices: new Attribute(new Uint32Array([0, 1, 2]), 1)
  });
}

function heightTexture(values: number[], width: number, height = width) {
  return new Texture({ data: new Float32Array(values), width, height });
}

describe('explicit displacement tessellation', () => {
  it('builds an OpenSubdiv face mask from displaced-surface error', () => {
    const flat = buildOpenSubdivAdaptiveFaceLevels(
      triangleGeometry(),
      heightTexture([0.5, 0.5, 0.5, 0.5], 2),
      {
        mode: 'opensubdiv',
        maxSubdivisionLevel: 5,
        maxError: 0.001,
        displacementScale: 1
      }
    );
    const detailed = buildOpenSubdivAdaptiveFaceLevels(
      triangleGeometry(),
      heightTexture([
        0, 0, 0,
        0, 1, 0,
        0, 0, 0
      ], 3),
      {
        mode: 'opensubdiv',
        maxSubdivisionLevel: 5,
        maxError: 0.001,
        displacementScale: 1
      }
    );

    expect(Array.from(flat.levels)).toEqual([0]);
    expect(flat.activeFaceCount).toBe(0);
    expect(detailed.levels[0]).toBeGreaterThan(0);
    expect(detailed.activeFaceCount).toBe(1);
  });

  it('uses a minimum OpenSubdiv level for screen-space micropolygon dicing', () => {
    const result = buildOpenSubdivAdaptiveFaceLevels(
      triangleGeometry(),
      heightTexture([0.5, 0.5, 0.5, 0.5], 2),
      {
        mode: 'opensubdiv',
        minSubdivisionLevel: 3,
        maxSubdivisionLevel: 5,
        maxError: 0.001,
        displacementScale: 1
      }
    );

    expect(Array.from(result.levels)).toEqual([3]);
    expect(result.activeFaceCount).toBe(1);
  });

  it('combines per-face camera dicing with the height-error mask', () => {
    const detailedTexture = heightTexture([
      0, 0, 0,
      0, 1, 0,
      0, 0, 0
    ], 3);
    const detailed = buildOpenSubdivAdaptiveFaceLevels(
      triangleGeometry(),
      detailedTexture,
      {
        mode: 'opensubdiv',
        faceSubdivisionLevels: new Uint8Array([5]),
        maxSubdivisionLevel: 6,
        maxError: 0.001,
        displacementScale: 1
      }
    );
    const flat = buildOpenSubdivAdaptiveFaceLevels(
      triangleGeometry(),
      heightTexture([0.5, 0.5, 0.5, 0.5], 2),
      {
        mode: 'opensubdiv',
        faceSubdivisionLevels: new Uint8Array([5]),
        maxSubdivisionLevel: 6,
        maxError: 0.001,
        displacementScale: 1
      }
    );
    const coarseCamera = buildOpenSubdivAdaptiveFaceLevels(
      triangleGeometry(),
      detailedTexture,
      {
        mode: 'opensubdiv',
        faceSubdivisionLevels: new Uint8Array([1]),
        maxSubdivisionLevel: 6,
        maxError: 0.001,
        displacementScale: 1
      }
    );

    expect(Array.from(detailed.levels)).toEqual([5]);
    expect(Array.from(flat.levels)).toEqual([0]);
    expect(Array.from(coarseCamera.levels)).toEqual([1]);
  });

  it('grades screen-space levels across neighboring flat faces', () => {
    const indices = new Uint32Array([
      0, 1, 2,
      1, 3, 2,
      2, 3, 4,
      3, 5, 4,
      4, 5, 6
    ]);
    const levels = new Uint8Array([5, 0, 0, 0, 0]);

    gradeOpenSubdivFaceLevels(
      indices,
      levels,
      new Uint8Array([5, 5, 5, 5, 5])
    );

    expect(Array.from(levels)).toEqual([5, 4, 3, 2, 1]);
  });

  it('does not grade above a face camera target', () => {
    const indices = new Uint32Array([
      0, 1, 2,
      1, 3, 2,
      2, 3, 4,
      3, 5, 4
    ]);
    const levels = new Uint8Array([5, 0, 0, 0]);

    gradeOpenSubdivFaceLevels(
      indices,
      levels,
      new Uint8Array([5, 2, 1, 0])
    );

    expect(Array.from(levels)).toEqual([5, 2, 1, 0]);
  });

  it('rejects camera face levels that do not match source faces', () => {
    expect(() => buildOpenSubdivAdaptiveFaceLevels(
      triangleGeometry(),
      heightTexture([0, 0, 0, 1], 2),
      {
        mode: 'opensubdiv',
        faceSubdivisionLevels: new Uint8Array([1, 2]),
        maxSubdivisionLevel: 3
      }
    )).toThrow(/source triangle count/);
  });

  it('adapts closed hard-contour face rates to their texel footprint', () => {
    const texture = heightTexture([
      0, 0, 0,
      0, 1, 0,
      0, 0, 0
    ], 3);
    const closedContour = buildOpenSubdivAdaptiveFaceLevels(
      triangleGeometry(),
      texture,
      {
        mode: 'opensubdiv',
        edgeProfile: 'hard',
        hardContourGeometry: true,
        maxSubdivisionLevel: 6,
        maxError: 0,
        displacementScale: 1
      }
    );
    const vertexOnly = buildOpenSubdivAdaptiveFaceLevels(
      triangleGeometry(),
      texture,
      {
        mode: 'opensubdiv',
        edgeProfile: 'hard',
        hardContourGeometry: false,
        maxSubdivisionLevel: 6,
        maxError: 0,
        displacementScale: 1
      }
    );
    const largeTexture = heightTexture(
      Array.from({ length: 64 * 64 }, (_, index) => {
        const x = index % 64;
        const y = Math.floor(index / 64);
        return (Math.floor(x / 8) + Math.floor(y / 8)) % 2;
      }),
      64
    );
    const coarseSourceContour = buildOpenSubdivAdaptiveFaceLevels(
      triangleGeometry(),
      largeTexture,
      {
        mode: 'opensubdiv',
        edgeProfile: 'hard',
        hardContourGeometry: true,
        maxSubdivisionLevel: 6,
        maxError: 0,
        displacementScale: 1
      }
    );

    expect(closedContour.levels[0]).toBe(0);
    expect(coarseSourceContour.levels[0]).toBe(4);
    expect(vertexOnly.levels[0]).toBe(6);
  });

  it('uses the automatic hard-edge mask to select OpenSubdiv face density', () => {
    const texture = heightTexture(
      Array.from({ length: 32 * 4 }, (_, index) => {
        const x = index % 32;
        return x < 12 ? 0.2 : x < 20 ? 0.55 : 0.8;
      }),
      32,
      4
    );
    const automatic = buildOpenSubdivAdaptiveFaceLevels(
      triangleGeometry(),
      texture,
      {
        mode: 'opensubdiv',
        edgeProfile: 'auto',
        hardContourGeometry: true,
        maxSubdivisionLevel: 6,
        maxError: 10,
        displacementScale: 1
      }
    );
    const smooth = buildOpenSubdivAdaptiveFaceLevels(
      triangleGeometry(),
      texture,
      {
        mode: 'opensubdiv',
        edgeProfile: 'smooth',
        maxSubdivisionLevel: 6,
        maxError: 10,
        displacementScale: 1
      }
    );

    expect(automatic.levels[0]).toBeGreaterThan(0);
    expect(smooth.levels[0]).toBe(0);
  });

  it.each(['uniform', 'adaptive'] as const)(
    'reports monotonic %s tessellation progress through completion',
    (mode) => {
      const progress: number[] = [];
      tessellateDisplacementGeometry(
        triangleGeometry(),
        heightTexture([0, 0.25, 0.5, 1], 2),
        {
          mode,
          maxSubdivisionLevel: 2,
          maxError: 0,
          maxTriangles: 64
        },
        (update) => {
          expect(update.mode).toBe(mode);
          progress.push(update.progress);
        }
      );

      expect(progress[0]).toBe(0);
      expect(progress.at(-1)).toBe(1);
      expect(progress.every((value, index) =>
        index === 0 || value >= progress[index - 1]
      )).toBe(true);
    }
  );

  it('generates four ordinary triangles for one uniform level', () => {
    const generated = tessellateDisplacementGeometry(
      triangleGeometry(),
      heightTexture([0, 0, 0, 0], 2),
      { mode: 'uniform', maxSubdivisionLevel: 1, maxTriangles: 16 }
    );

    expect(generated.indices.array).toHaveLength(12);
    expect(Geometry.getVertexCount(generated)).toBeGreaterThan(3);
    expect(generated.bvh).toBeUndefined();
  });

  it('reuses uniform topology while resampling displaced vertices', () => {
    const source = triangleGeometry();
    const first = tessellateDisplacementGeometry(
      source,
      heightTexture([0, 0, 0, 0], 2),
      { mode: 'uniform', maxSubdivisionLevel: 2, topologyCacheKey: 'triangle' }
    );
    const second = tessellateDisplacementGeometry(
      source,
      heightTexture([1, 1, 1, 1], 2),
      {
        mode: 'uniform',
        maxSubdivisionLevel: 2,
        displacementScale: 0.5,
        topologyCacheKey: 'triangle'
      }
    );

    expect(getDisplacementTessellationStats(first)?.topologyCacheHit).toBe(false);
    expect(getDisplacementTessellationStats(second)?.topologyCacheHit).toBe(true);
    expect(second.indices.array).toEqual(first.indices.array);
    expect(second.position.array[2] - first.position.array[2]).toBeCloseTo(0.5);
  });

  it('does not refine a flat displaced plane in adaptive mode', () => {
    const generated = tessellateDisplacementGeometry(
      triangleGeometry(),
      heightTexture([0.5, 0.5, 0.5, 0.5], 2),
      {
        mode: 'adaptive',
        maxSubdivisionLevel: 5,
        maxError: 1e-5,
        displacementScale: 2
      }
    );

    expect(generated.indices.array).toHaveLength(3);
    for (let offset = 2; offset < generated.position.array.length; offset += 3) {
      expect(generated.position.array[offset]).toBeCloseTo(1);
    }
  });

  it('refines a height feature and respects the triangle budget', () => {
    const generated = tessellateDisplacementGeometry(
      triangleGeometry(),
      heightTexture([
        0, 0, 0,
        0, 1, 0,
        0, 0, 0
      ], 3),
      {
        mode: 'adaptive',
        maxSubdivisionLevel: 6,
        maxError: 0.01,
        maxTriangles: 24,
        displacementScale: 1
      }
    );

    expect(generated.indices.array.length / 3).toBeGreaterThan(1);
    expect(generated.indices.array.length / 3).toBeLessThanOrEqual(24);
    expect(Math.max(...generated.position.array)).toBeGreaterThan(0.5);
  });

  it('uses the height range pyramid to catch an off-sample pixel spike', () => {
    const heights = new Array(49).fill(0);
    heights[1 * 7 + 4] = 1;
    const generated = tessellateDisplacementGeometry(
      triangleGeometry(),
      heightTexture(heights, 7),
      {
        mode: 'adaptive',
        maxSubdivisionLevel: 4,
        maxError: 0.05,
        maxTriangles: 64,
        displacementScale: 1
      }
    );

    expect(generated.indices.array.length / 3).toBeGreaterThan(1);
  });

  it('keeps refining threshold edges in adaptive hard-surface mode', () => {
    const geometry = triangleGeometry();
    geometry.uv = new Attribute(
      new Float32Array([0.02, 0.02, 0.98, 0.02, 0.02, 0.98]),
      2
    );
    const checker = Array.from({ length: 16 * 16 }, (_, index) => {
      const x = index % 16;
      const y = Math.floor(index / 16);
      return (x + y) % 2;
    });
    const smooth = tessellateDisplacementGeometry(
      geometry,
      heightTexture(checker, 16),
      {
        mode: 'adaptive',
        edgeProfile: 'smooth',
        maxSubdivisionLevel: 3,
        maxError: 10,
        maxTriangles: 256
      }
    );
    const hard = tessellateDisplacementGeometry(
      geometry,
      heightTexture(checker, 16),
      {
        mode: 'adaptive',
        edgeProfile: 'hard',
        edgeWidth: 1,
        maxSubdivisionLevel: 3,
        maxError: 10,
        maxTriangles: 256
      }
    );

    expect(smooth.indices.array.length / 3).toBe(1);
    expect(hard.indices.array.length / 3).toBeGreaterThan(1);
  });

  it('places hard-surface split vertices on the sampled threshold edge', () => {
    const geometry = triangleGeometry();
    geometry.position = new Attribute(
      new Float32Array([0, 0, 0, 1, 0, 0, 0, 0.2, 0]),
      3
    );
    geometry.uv = new Attribute(
      new Float32Array([0.1, 0, 0.9, 0, 0.1, 0.1]),
      2
    );
    const texture = heightTexture([0, 0, 0, 1, 1, 1, 1, 1, 1, 1], 10, 1);
    const generated = tessellateDisplacementGeometry(
      geometry,
      texture,
      {
        mode: 'adaptive',
        edgeProfile: 'hard',
        maxSubdivisionLevel: 1,
        maxError: Number.MAX_VALUE,
        maxTriangles: 8
      }
    );
    const generatedU = Array.from(generated.uv!.array).filter(
      (_, offset) => offset % 2 === 0
    );

    expect(generatedU.some((u) => u > 0.2 && u < 0.4)).toBe(true);
    expect(generatedU).not.toContain(0.5);
  });

  it('remeshes a hard threshold into separate surfaces and closed side walls', () => {
    const geometry = triangleGeometry();
    geometry.uv = new Attribute(
      new Float32Array([0, 0, 0.75, 0, 0, 0.75]),
      2
    );
    const generated = tessellateDisplacementGeometry(
      geometry,
      heightTexture([0, 0, 1, 1], 4, 1),
      {
        mode: 'adaptive',
        edgeProfile: 'hard',
        hardContourGeometry: true,
        contourSubdivisionLevel: 0,
        maxSubdivisionLevel: 0,
        maxTriangles: 32,
        displacementScale: 1,
        heightFilter: 'nearest',
        creaseAngle: 30
      }
    );

    expect(generated.indices.array.length / 3).toBe(5);
    const positions = generated.position.array;
    const verticalPairs = new Set<string>();
    for (let index = 0; index < Geometry.getVertexCount(generated); index++) {
      const offset = index * 3;
      verticalPairs.add(
        `${positions[offset].toFixed(4)}:${positions[offset + 1].toFixed(4)}:${positions[offset + 2].toFixed(1)}`
      );
    }
    const xyWithBothHeights = new Set(
      [...verticalPairs]
        .filter((entry) => entry.endsWith(':0.0'))
        .map((entry) => entry.slice(0, -4))
        .filter((xy) => verticalPairs.has(`${xy}:1.0`))
    );
    expect(xyWithBothHeights.size).toBe(2);
    expect(generated.normal.array.every(Number.isFinite)).toBe(true);
    expect(generated.tangent?.array.every(Number.isFinite)).toBe(true);
  });

  it('preserves multiple local plateau heights in automatic edge mode', () => {
    const geometry = triangleGeometry();
    geometry.uv = new Attribute(
      new Float32Array([0.01, 0, 0.99, 0, 0.01, 0.99]),
      2
    );
    const generated = tessellateDisplacementGeometry(
      geometry,
      heightTexture([
        0, 0, 0,
        0.25, 0.25, 0.25,
        0.65, 0.65, 0.65,
        1, 1, 1
      ], 12, 1),
      {
        mode: 'uniform',
        edgeProfile: 'auto',
        hardContourGeometry: true,
        contourSmoothing: 0,
        maxSubdivisionLevel: 4,
        maxTriangles: 4096,
        displacementScale: 1,
        heightFilter: 'linear',
        creaseAngle: 30
      }
    );
    const heights = new Set(
      Array.from({ length: Geometry.getVertexCount(generated) }, (_, index) =>
        generated.position.array[index * 3 + 2].toFixed(2)
      )
    );

    expect(heights).toContain('0.00');
    expect(heights).toContain('0.25');
    expect(heights).toContain('0.65');
    expect(heights).toContain('1.00');
    expect(generated.indices.array.length / 3).toBeGreaterThan(256);
    expect(generated.normal.array.every(Number.isFinite)).toBe(true);
  });

  it('closes automatic checker contours at four-region junctions', () => {
    const geometry = new Geometry({
      position: new Attribute(new Float32Array([
        -1, -1, 0,
        1, -1, 0,
        -1, 1, 0,
        1, 1, 0
      ]), 3),
      normal: new Attribute(new Float32Array([
        0, 0, 1,
        0, 0, 1,
        0, 0, 1,
        0, 0, 1
      ]), 3),
      uv: new Attribute(new Float32Array([
        0, 0,
        1, 0,
        0, 1,
        1, 1
      ]), 2),
      indices: new Attribute(new Uint32Array([0, 1, 2, 2, 1, 3]), 1)
    });
    const size = 32;
    const generated = tessellateDisplacementGeometry(
      geometry,
      heightTexture(
        Array.from({ length: size * size }, (_, index) => {
          const x = index % size;
          const y = Math.floor(index / size);
          return (Math.floor(x / 8) + Math.floor(y / 8)) % 2;
        }),
        size
      ),
      {
        mode: 'uniform',
        edgeProfile: 'auto',
        hardContourGeometry: true,
        contourSmoothing: 0,
        maxSubdivisionLevel: 5,
        maxTriangles: 16_384,
        displacementScale: 0.25,
        heightFilter: 'nearest',
        creaseAngle: 60
      }
    );
    const positions = generated.position.array;
    const positionKey = (vertex: number) => {
      const offset = vertex * 3;
      return [0, 1, 2]
        .map((axis) => Number(positions[offset + axis].toFixed(6)))
        .join(',');
    };
    const edges = new Map<string, { count: number; midpoint: number[] }>();
    for (let offset = 0; offset < generated.indices.array.length; offset += 3) {
      const triangle = Array.from(
        generated.indices.array.subarray(offset, offset + 3)
      );
      for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
        const vertices = [triangle[a], triangle[b]];
        const key = vertices.map(positionKey).sort().join('|');
        const midpoint = [0, 1, 2].map((axis) =>
          (positions[vertices[0] * 3 + axis] +
            positions[vertices[1] * 3 + axis]) * 0.5
        );
        const edge = edges.get(key) ?? { count: 0, midpoint };
        edge.count++;
        edges.set(key, edge);
      }
    }
    const interiorBoundaryEdges = [...edges.values()].filter(({ count, midpoint }) =>
      count === 1 && Math.abs(midpoint[0]) < 0.999 && Math.abs(midpoint[1]) < 0.999
    );

    expect(interiorBoundaryEdges).toEqual([]);
  });

  it('keeps continuous gradients smooth in automatic edge mode', () => {
    const geometry = triangleGeometry();
    geometry.uv = new Attribute(
      new Float32Array([0.1, 0, 0.8, 0, 0.1, 0.8]),
      2
    );
    const generated = tessellateDisplacementGeometry(
      geometry,
      heightTexture(
        Array.from({ length: 16 }, (_, index) => index / 15),
        16,
        1
      ),
      {
        mode: 'uniform',
        edgeProfile: 'auto',
        hardContourGeometry: true,
        maxSubdivisionLevel: 1,
        maxTriangles: 32,
        displacementScale: 1,
        heightFilter: 'linear',
        creaseAngle: 180
      }
    );
    let midpointHeight: number | undefined;
    for (let index = 0; index < Geometry.getVertexCount(generated); index++) {
      const offset = index * 3;
      if (
        Math.abs(generated.position.array[offset] - 0.5) < 1e-6 &&
        Math.abs(generated.position.array[offset + 1]) < 1e-6
      ) {
        midpointHeight = generated.position.array[offset + 2];
        break;
      }
    }

    expect(midpointHeight).toBeCloseTo(0.45, 5);
    expect(generated.indices.array.length / 3).toBe(4);
  });

  it('smooths straight hard-contour runs without moving their corners', () => {
    const geometry = new Geometry({
      position: new Attribute(new Float32Array([
        0, 0, 0, 0.1, 0.5, 0, 0, 1, 0,
        1, 0, 0, 0.7, 0.5, 0, 1, 1, 0
      ]), 3),
      normal: new Attribute(new Float32Array([
        0, 0, 1, 0, 0, 1, 0, 0, 1,
        0, 0, 1, 0, 0, 1, 0, 0, 1
      ]), 3),
      uv: new Attribute(new Float32Array([
        0.25, 0, 0.25, 0.5, 0.25, 1,
        0.75, 0, 0.75, 0.5, 0.75, 1
      ]), 2),
      indices: new Attribute(new Uint32Array([
        0, 3, 4, 0, 4, 1,
        1, 4, 5, 1, 5, 2
      ]), 1)
    });
    const build = (contourSmoothing: number) => tessellateDisplacementGeometry(
      geometry,
      heightTexture([0, 0, 1, 1], 4, 1),
      {
        mode: 'adaptive',
        edgeProfile: 'hard',
        hardContourGeometry: true,
        contourSmoothing,
        contourSubdivisionLevel: 0,
        maxSubdivisionLevel: 0,
        maxTriangles: 64,
        displacementScale: 1,
        heightFilter: 'nearest',
        creaseAngle: 30
      }
    );
    const unsmoothed = build(0);
    const smoothed = build(2);
    const contourXs = (result: Geometry) => {
      const positions = result.position.array;
      const xyByHeight = new Map<string, Set<string>>();
      for (let index = 0; index < Geometry.getVertexCount(result); index++) {
        const offset = index * 3;
        const xy = `${positions[offset].toFixed(5)}:${positions[offset + 1].toFixed(5)}`;
        const heights = xyByHeight.get(xy) ?? new Set<string>();
        heights.add(positions[offset + 2].toFixed(3));
        xyByHeight.set(xy, heights);
      }
      return [...xyByHeight]
        .filter(([, heights]) => heights.has('0.000') && heights.has('1.000'))
        .map(([xy]) => Number(xy.split(':')[0]));
    };

    expect(contourXs(smoothed).length).toBeGreaterThan(0);
    expect(Math.max(...contourXs(smoothed)) - Math.min(...contourXs(smoothed)))
      .toBeLessThan(
        Math.max(...contourXs(unsmoothed)) - Math.min(...contourXs(unsmoothed))
      );
  });

  it('welds duplicated face-varying vertices into one smooth contour run', () => {
    const sourcePositions = [
      [0, 0, 0], [0.1, 0.5, 0], [0, 1, 0],
      [1, 0, 0], [0.7, 0.5, 0], [1, 1, 0]
    ];
    const sourceUvs = [
      [0.25, 0], [0.25, 0.5], [0.25, 1],
      [0.75, 0], [0.75, 0.5], [0.75, 1]
    ];
    const sourceTriangles = [
      [0, 3, 4], [0, 4, 1], [1, 4, 5], [1, 5, 2]
    ];
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    sourceTriangles.flat().forEach((sourceIndex, index) => {
      positions.push(...sourcePositions[sourceIndex]);
      normals.push(0, 0, 1);
      uvs.push(...sourceUvs[sourceIndex]);
      indices.push(index);
    });
    const geometry = new Geometry({
      position: new Attribute(new Float32Array(positions), 3),
      normal: new Attribute(new Float32Array(normals), 3),
      uv: new Attribute(new Float32Array(uvs), 2),
      indices: new Attribute(new Uint32Array(indices), 1)
    });
    const build = (contourSmoothing: number) => tessellateDisplacementGeometry(
      geometry,
      heightTexture([0, 0, 1, 1], 4, 1),
      {
        mode: 'adaptive',
        edgeProfile: 'hard',
        hardContourGeometry: true,
        contourSmoothing,
        contourSubdivisionLevel: 0,
        maxSubdivisionLevel: 0,
        maxTriangles: 64,
        displacementScale: 1,
        heightFilter: 'nearest'
      }
    );
    const contourSpread = (result: Geometry) => {
      const heightsByPoint = new Map<string, Set<string>>();
      for (let index = 0; index < Geometry.getVertexCount(result); index++) {
        const offset = index * 3;
        const key = `${result.position.array[offset].toFixed(5)}:${result.position.array[offset + 1].toFixed(5)}`;
        const heights = heightsByPoint.get(key) ?? new Set<string>();
        heights.add(result.position.array[offset + 2].toFixed(3));
        heightsByPoint.set(key, heights);
      }
      const xs = [...heightsByPoint]
        .filter(([, heights]) => heights.has('0.000') && heights.has('1.000'))
        .map(([key]) => Number(key.split(':')[0]));
      return Math.max(...xs) - Math.min(...xs);
    };

    expect(contourSpread(build(2))).toBeLessThan(contourSpread(build(0)));
  });

  it('densifies only hard-contour edges with normal-guided curve samples', () => {
    const geometry = triangleGeometry();
    geometry.uv = new Attribute(
      new Float32Array([0, 0, 0.9, 0, 0, 0.9]),
      2
    );
    geometry.normal = new Attribute(
      new Float32Array([0, 0, 1, 0.4, 0, 0.9165, 0, 0.4, 0.9165]),
      3
    );
    const build = (contourSubdivisionLevel: number) =>
      tessellateDisplacementGeometry(
        geometry,
        heightTexture([0, 0, 1, 1], 4, 1),
        {
          mode: 'adaptive',
          edgeProfile: 'hard',
          hardContourGeometry: true,
          contourSmoothing: 0,
          contourSubdivisionLevel,
          maxSubdivisionLevel: 0,
          maxTriangles: 64,
          displacementScale: 1,
          heightFilter: 'nearest'
        }
      );

    const coarse = build(0);
    const curved = build(2);
    expect(curved.indices.array.length).toBeGreaterThan(coarse.indices.array.length);
    expect(Geometry.getVertexCount(curved)).toBeGreaterThan(
      Geometry.getVertexCount(coarse)
    );
  });

  it('reduces contour density instead of discarding closed walls at the budget', () => {
    const geometry = triangleGeometry();
    geometry.uv = new Attribute(
      new Float32Array([0, 0, 0.75, 0, 0, 0.75]),
      2
    );
    const generated = tessellateDisplacementGeometry(
      geometry,
      heightTexture([0, 0, 1, 1], 4, 1),
      {
        mode: 'adaptive',
        edgeProfile: 'hard',
        hardContourGeometry: true,
        contourSubdivisionLevel: 3,
        maxSubdivisionLevel: 0,
        maxTriangles: 8,
        displacementScale: 1,
        heightFilter: 'nearest'
      }
    );
    const stats = getDisplacementTessellationStats(generated);

    expect(stats?.generatedTriangles).toBeLessThanOrEqual(8);
    expect(stats?.triangleBudgetReached).toBe(true);
    expect(generated.indices.array.length / 3).toBeGreaterThan(3);
  });

  it('keeps adjacent Phong contour samples locally directionally consistent', () => {
    const geometry = new Geometry({
      position: new Attribute(new Float32Array([
        0, 0, 0, 0.1, 0.5, 0, 0, 1, 0,
        1, 0, 0, 0.7, 0.5, 0, 1, 1, 0
      ]), 3),
      normal: new Attribute(new Float32Array([
        0, 0, 1, 0, 0, 1, 0, 0, 1,
        0, 0, 1, 0, 0, 1, 0, 0, 1
      ]), 3),
      uv: new Attribute(new Float32Array([
        0.25, 0, 0.25, 0.5, 0.25, 1,
        0.75, 0, 0.75, 0.5, 0.75, 1
      ]), 2),
      indices: new Attribute(new Uint32Array([
        0, 3, 4, 0, 4, 1,
        1, 4, 5, 1, 5, 2
      ]), 1)
    });
    const generated = tessellateDisplacementGeometry(
      geometry,
      heightTexture([0, 0, 1, 1], 4, 1),
      {
        mode: 'adaptive',
        edgeProfile: 'hard',
        hardContourGeometry: true,
        contourSmoothing: 0,
        contourSubdivisionLevel: 3,
        maxSubdivisionLevel: 0,
        maxTriangles: 256,
        displacementScale: 1,
        heightFilter: 'nearest'
      }
    );
    const positions = generated.position.array;
    const heightsByPoint = new Map<string, Set<string>>();
    for (let index = 0; index < Geometry.getVertexCount(generated); index++) {
      const offset = index * 3;
      const key = `${positions[offset].toFixed(6)}:${positions[offset + 1].toFixed(6)}`;
      const heights = heightsByPoint.get(key) ?? new Set<string>();
      heights.add(positions[offset + 2].toFixed(3));
      heightsByPoint.set(key, heights);
    }
    const contour = [...heightsByPoint]
      .filter(([, heights]) => heights.has('0.000') && heights.has('1.000'))
      .map(([key]) => key.split(':').map(Number) as [number, number])
      .sort((left, right) => left[1] - right[1]);
    const centerIndex = contour.findIndex((point) => Math.abs(point[1] - 0.5) < 1e-5);
    expect(centerIndex).toBeGreaterThan(0);
    expect(centerIndex).toBeLessThan(contour.length - 1);
    const previous = contour[centerIndex - 1];
    const center = contour[centerIndex];
    const next = contour[centerIndex + 1];
    const incoming = [center[0] - previous[0], center[1] - previous[1]];
    const outgoing = [next[0] - center[0], next[1] - center[1]];
    const directionDot =
      (incoming[0] * outgoing[0] + incoming[1] * outgoing[1]) /
      (Math.hypot(...incoming) * Math.hypot(...outgoing));
    expect(directionDot).toBeGreaterThan(0.9);
  });

  it('supports linear and nearest height filtering', () => {
    const texture = heightTexture([0, 1], 2, 1);
    const linear = tessellateDisplacementGeometry(
      triangleGeometry(),
      texture,
      {
        mode: 'uniform',
        maxSubdivisionLevel: 1,
        heightFilter: 'linear',
        creaseAngle: 180
      }
    );
    const nearest = tessellateDisplacementGeometry(
      triangleGeometry(),
      texture,
      {
        mode: 'uniform',
        maxSubdivisionLevel: 1,
        heightFilter: 'nearest',
        creaseAngle: 180
      }
    );
    const midpointHeight = (geometry: Geometry) => {
      for (let index = 0; index < Geometry.getVertexCount(geometry); index++) {
        const offset = index * 3;
        if (
          Math.abs(geometry.position.array[offset] - 0.5) < 1e-6 &&
          Math.abs(geometry.position.array[offset + 1]) < 1e-6
        ) return geometry.position.array[offset + 2];
      }
      throw new Error('Expected a generated midpoint.');
    };

    expect(midpointHeight(linear)).toBeCloseTo(0.5);
    expect(midpointHeight(nearest)).toBeCloseTo(1);
  });

  it('prefilters geometry height to the emitted triangle footprint', () => {
    const texture = heightTexture([0, 0, 0, 0, 1, 0, 0, 0, 0], 9, 1);
    const raw = tessellateDisplacementGeometry(
      triangleGeometry(),
      texture,
      {
        mode: 'uniform',
        maxSubdivisionLevel: 1,
        heightFilter: 'linear',
        heightPrefilter: false,
        creaseAngle: 180
      }
    );
    const prefiltered = tessellateDisplacementGeometry(
      triangleGeometry(),
      texture,
      {
        mode: 'uniform',
        maxSubdivisionLevel: 1,
        heightFilter: 'linear',
        heightPrefilter: true,
        creaseAngle: 180
      }
    );
    const midpointHeight = (geometry: Geometry) => {
      for (let index = 0; index < Geometry.getVertexCount(geometry); index++) {
        const offset = index * 3;
        if (
          Math.abs(geometry.position.array[offset] - 0.5) < 1e-6 &&
          Math.abs(geometry.position.array[offset + 1]) < 1e-6
        ) return geometry.position.array[offset + 2];
      }
      throw new Error('Expected a generated midpoint.');
    };

    expect(midpointHeight(raw)).toBeCloseTo(1);
    expect(midpointHeight(prefiltered)).toBeGreaterThan(0);
    expect(midpointHeight(prefiltered)).toBeLessThan(midpointHeight(raw));
  });

  it('splits generated normals at the requested crease angle', () => {
    const smoothNormals = tessellateDisplacementGeometry(
      triangleGeometry(),
      heightTexture([0, 1], 2, 1),
      {
        mode: 'uniform',
        maxSubdivisionLevel: 2,
        heightFilter: 'nearest',
        creaseAngle: 180
      }
    );
    const creasedNormals = tessellateDisplacementGeometry(
      triangleGeometry(),
      heightTexture([0, 1], 2, 1),
      {
        mode: 'uniform',
        maxSubdivisionLevel: 2,
        heightFilter: 'nearest',
        creaseAngle: 30
      }
    );

    expect(Geometry.getVertexCount(creasedNormals))
      .toBeGreaterThan(Geometry.getVertexCount(smoothNormals));
    expect(creasedNormals.normal.array.every(Number.isFinite)).toBe(true);
  });

  it('catches off-sample height details with triplanar projection', () => {
    const geometry = triangleGeometry();
    geometry.uv = undefined;
    const heights = new Array(49).fill(0);
    heights[1 * 7 + 4] = 1;
    const generated = tessellateDisplacementGeometry(
      geometry,
      heightTexture(heights, 7),
      {
        mode: 'adaptive',
        maxSubdivisionLevel: 4,
        maxError: 0.05,
        maxTriangles: 64,
        displacementScale: 1,
        uvProjection: 'triplanar'
      }
    );

    expect(generated.indices.array.length / 3).toBeGreaterThan(1);
    expect(Math.max(...generated.position.array)).toBeGreaterThan(0.5);
  });

  it('supports negative scale and a centered displacement bias', () => {
    const generated = tessellateDisplacementGeometry(
      triangleGeometry(),
      heightTexture([0.75, 0.75, 0.75, 0.75], 2),
      {
        mode: 'uniform',
        maxSubdivisionLevel: 0,
        displacementScale: -2,
        displacementBias: 1
      }
    );

    expect(generated.position.array[2]).toBeCloseTo(-0.5);
  });

  it('shares tessellated vertices across an indexed base edge', () => {
    const geometry = new Geometry({
      position: new Attribute(
        new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]),
        3
      ),
      normal: new Attribute(
        new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
        3
      ),
      uv: new Attribute(new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), 2),
      indices: new Attribute(new Uint32Array([0, 1, 2, 2, 1, 3]), 1)
    });
    const generated = tessellateDisplacementGeometry(
      geometry,
      heightTexture([0, 0, 0, 0], 2),
      { mode: 'uniform', maxSubdivisionLevel: 1, maxTriangles: 32 }
    );
    const centers: number[] = [];
    for (let index = 0; index < Geometry.getVertexCount(generated); index++) {
      const offset = index * 3;
      if (
        Math.abs(generated.position.array[offset] - 0.5) < 1e-6 &&
        Math.abs(generated.position.array[offset + 1] - 0.5) < 1e-6
      ) {
        centers.push(index);
      }
    }
    expect(centers).toHaveLength(1);
    expect(Array.from(generated.indices.array).filter((index) => index === centers[0]).length)
      .toBeGreaterThanOrEqual(4);
  });

  it('keeps a seam-safe duplicated UV edge geometrically coincident', () => {
    const geometry = new Geometry({
      position: new Attribute(
        new Float32Array([
          0, 0, 0, 1, 0, 0, 0, 1, 0,
          0, 1, 0, 1, 0, 0, 1, 1, 0
        ]),
        3
      ),
      normal: new Attribute(
        new Float32Array([
          0, 0, 1, 0, 0, 1, 0, 0, 1,
          0, 0, 1, 0, 0, 1, 0, 0, 1
        ]),
        3
      ),
      uv: new Attribute(
        new Float32Array([0.25, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0.75, 1]),
        2
      ),
      indices: new Attribute(new Uint32Array([0, 1, 2, 3, 4, 5]), 1)
    });
    const generated = tessellateDisplacementGeometry(
      geometry,
      heightTexture([0.2, 0.8, 0.4, 0.2, 0.6, 0.3, 0.7, 0.6], 4, 2),
      {
        mode: 'uniform',
        maxSubdivisionLevel: 2,
        displacementScale: 1,
        maxTriangles: 64
      }
    );
    const seamMidpoints: number[] = [];
    for (let index = 0; index < Geometry.getVertexCount(generated); index++) {
      const offset = index * 3;
      if (
        Math.abs(generated.position.array[offset] - 0.5) < 1e-6 &&
        Math.abs(generated.position.array[offset + 1] - 0.5) < 1e-6
      ) {
        seamMidpoints.push(generated.position.array[offset + 2]);
      }
    }
    expect(seamMidpoints).toHaveLength(2);
    expect(seamMidpoints[0]).toBeCloseTo(seamMidpoints[1]);
  });

  it('regenerates a tangent frame for normal mapping after displacement', () => {
    const generated = tessellateDisplacementGeometry(
      triangleGeometry(),
      heightTexture([0, 0.25, 0.5, 1], 2),
      {
        mode: 'uniform',
        maxSubdivisionLevel: 1,
        displacementScale: 0.5
      }
    );

    expect(generated.tangent).toBeDefined();
    expect(generated.tangent?.array).toHaveLength(generated.normal.array.length);
    for (let index = 0; index < Geometry.getVertexCount(generated); index++) {
      const offset = index * 3;
      const tangent = generated.tangent!.array.subarray(offset, offset + 3);
      const normal = generated.normal.array.subarray(offset, offset + 3);
      expect(tangent.every(Number.isFinite)).toBe(true);
      expect(normal.every(Number.isFinite)).toBe(true);
      expect(
        tangent[0] * normal[0] +
        tangent[1] * normal[1] +
        tangent[2] * normal[2]
      ).toBeCloseTo(0, 5);
    }
  });

  it('prepares and caches tessellated material geometry without mutating the source', () => {
    const source = triangleGeometry();
    const material = new OpenPBRMaterial();
    material.displacementMap = heightTexture([1, 1, 1, 1], 2);
    material.displacementScale = 0.25;
    material.displacementMode = 'tessellated';
    material.displacementTessellationMode = 'uniform';
    material.displacementMaxSubdivisionLevel = 1;
    const mesh = new Mesh(source, material);

    const prepared = getPreparedMeshGeometry(mesh);
    expect(prepared).not.toBe(source);
    expect(getPreparedMeshGeometry(mesh)).toBe(prepared);
    expect(source.indices.array).toHaveLength(3);
    expect(prepared.indices.array).toHaveLength(12);
    expect(prepared.position.array[2]).toBeCloseTo(0.25);
  });

  it('includes hard-surface controls in tessellation options and cache identity', () => {
    const material = new OpenPBRMaterial();
    material.displacementMap = heightTexture([0, 1, 1, 0], 2);
    material.displacementMode = 'tessellated';
    material.displacementEdgeProfile = 'beveled';
    material.displacementThreshold = 0.4;
    material.displacementEdgeWidth = 3;
    material.displacementHardContourGeometry = true;
    material.displacementContourSmoothing = 3;
    material.displacementContourSubdivisionLevel = 2;
    material.displacementCreaseAngle = 45;
    material.displacementHeightFilter = 'nearest';
    material.displacementHeightPrefilter = true;
    material.displacementMinSubdivisionLevel = 2;
    const mesh = new Mesh(triangleGeometry(), material);
    const firstKey = getPreparedMeshGeometryCacheKey(mesh);

    expect(getMeshDisplacementTessellationOptions(mesh)).toMatchObject({
      edgeProfile: 'beveled',
      threshold: 0.4,
      edgeWidth: 3,
      hardContourGeometry: true,
      contourSmoothing: 3,
      contourSubdivisionLevel: 2,
      creaseAngle: 45,
      heightFilter: 'nearest',
      heightPrefilter: true,
      minSubdivisionLevel: 2,
      simplificationRatio: 1
    });
    mesh.displacementFaceLevels = new Uint8Array([4]);
    mesh.displacementFaceLevelsHash = 0x1234;
    const cameraKey = getPreparedMeshGeometryCacheKey(mesh);
    expect(getMeshDisplacementTessellationOptions(mesh)).toMatchObject({
      faceSubdivisionLevels: mesh.displacementFaceLevels
    });
    mesh.displacementFaceLevelsHash = 0x5678;
    expect(getPreparedMeshGeometryCacheKey(mesh)).not.toBe(cameraKey);
    material.displacementThreshold = 0.6;
    expect(getPreparedMeshGeometryCacheKey(mesh)).not.toBe(firstKey);

    const contourKey = getPreparedMeshGeometryCacheKey(mesh);
    material.displacementContourSmoothing = 4;
    expect(getPreparedMeshGeometryCacheKey(mesh)).not.toBe(contourKey);

    const subdivisionKey = getPreparedMeshGeometryCacheKey(mesh);
    material.displacementContourSubdivisionLevel = 3;
    expect(getPreparedMeshGeometryCacheKey(mesh)).not.toBe(subdivisionKey);

    const geometryKey = getPreparedMeshGeometryCacheKey(mesh);
    material.displacementHardContourGeometry = false;
    expect(getPreparedMeshGeometryCacheKey(mesh)).not.toBe(geometryKey);

    const prefilterKey = getPreparedMeshGeometryCacheKey(mesh);
    material.displacementHeightPrefilter = false;
    expect(getPreparedMeshGeometryCacheKey(mesh)).not.toBe(prefilterKey);

    const minimumLevelKey = getPreparedMeshGeometryCacheKey(mesh);
    material.displacementMinSubdivisionLevel = 1;
    expect(getPreparedMeshGeometryCacheKey(mesh)).not.toBe(minimumLevelKey);

    const simplificationKey = getPreparedMeshGeometryCacheKey(mesh);
    mesh.geometrySimplificationRatio = 0.5;
    expect(getPreparedMeshGeometryCacheKey(mesh)).not.toBe(simplificationKey);
  });

  it('keeps only the latest camera-dependent tessellation cache entry', () => {
    const material = new OpenPBRMaterial();
    material.displacementMap = heightTexture([0, 1, 1, 0], 2);
    material.displacementMode = 'tessellated';
    material.displacementTessellationMode = 'opensubdiv';
    const mesh = new Mesh(triangleGeometry(), material);
    mesh.displacementFaceLevels = new Uint8Array([2]);
    mesh.displacementFaceLevelsHash = 0x1111;
    const first = triangleGeometry();
    cachePreparedMeshGeometry(mesh, first);

    mesh.displacementFaceLevelsHash = 0x2222;
    const second = triangleGeometry();
    cachePreparedMeshGeometry(mesh, second);
    expect(getCachedPreparedMeshGeometry(mesh)).toBe(second);

    mesh.displacementFaceLevelsHash = 0x1111;
    expect(getCachedPreparedMeshGeometry(mesh)).toBeUndefined();
  });

  it('caches static OpenSubdiv topology', () => {
    const material = new OpenPBRMaterial();
    material.displacementMap = heightTexture([0, 1, 1, 0], 2);
    material.displacementMode = 'tessellated';
    const mesh = new Mesh(triangleGeometry(), material);

    material.displacementTessellationMode = 'opensubdiv';
    expect(getMeshDisplacementTessellationOptions(mesh).topologyCacheKey)
      .toContain('opensubdiv');
  });

  it('keeps rendering the source mesh while async OpenSubdiv is pending', () => {
    const source = triangleGeometry();
    const material = new OpenPBRMaterial();
    material.displacementMap = heightTexture([0, 1, 1, 0], 2);
    material.displacementMode = 'tessellated';
    material.displacementTessellationMode = 'opensubdiv';
    const mesh = new Mesh(source, material);

    expect(() => getPreparedMeshGeometry(mesh)).toThrow(
      'opensubdiv displacement requires the asynchronous worker path'
    );
    expect(getPreparedMeshGeometry(mesh, {
      allowAsyncTessellationFallback: true
    })).toBe(source);
  });

  it('invalidates cached tessellation when height pixels are marked updated', () => {
    const texture = heightTexture([1, 1, 1, 1], 2);
    const material = new OpenPBRMaterial();
    material.displacementMap = texture;
    material.displacementScale = 0.5;
    material.displacementMode = 'tessellated';
    material.displacementMaxSubdivisionLevel = 0;
    const mesh = new Mesh(triangleGeometry(), material);

    const first = getPreparedMeshGeometry(mesh);
    (texture.image as { data: Float32Array }).data.fill(0);
    texture.markUpdated();
    const second = getPreparedMeshGeometry(mesh);

    expect(second).not.toBe(first);
    expect(first.position.array[2]).toBeCloseTo(0.5);
    expect(second.position.array[2]).toBeCloseTo(0);
  });

  it('reuses copied height pixels until the texture version changes', () => {
    const texture = heightTexture([0, 0.25, 0.5, 1], 2);
    const first = copyDisplacementTextureData(texture)!;
    const second = copyDisplacementTextureData(texture)!;
    expect(second.data).toBe(first.data);

    texture.markUpdated();
    const third = copyDisplacementTextureData(texture)!;
    expect(third.data).not.toBe(first.data);
  });

  it('uses an adapter texture source as the stable tessellation cache identity', () => {
    const sourceIdentity = {};
    const source = triangleGeometry();
    const makeMesh = () => {
      const texture = heightTexture([1, 1, 1, 1], 2);
      texture.source = sourceIdentity;
      texture.version = 7;
      const material = new OpenPBRMaterial();
      material.displacementMap = texture;
      material.displacementMode = 'tessellated';
      return new Mesh(source, material);
    };

    expect(getPreparedMeshGeometryCacheKey(makeMesh()))
      .toBe(getPreparedMeshGeometryCacheKey(makeMesh()));
  });

  it('generates explicit triangles inside the worker precompute path', async () => {
    const material = new OpenPBRMaterial();
    material.displacementMap = heightTexture([1, 1, 1, 1], 2);
    material.displacementScale = 0.25;
    material.displacementMode = 'tessellated';
    material.displacementTessellationMode = 'uniform';
    material.displacementMaxSubdivisionLevel = 1;
    const source = triangleGeometry();
    const mesh = new Mesh(source, material);

    const prepared = prepareForPrecompute([mesh]);

    expect(prepared.rawGeometries[0]).toBe(source);
    expect(prepared.geometries[0].indices?.buffer.byteLength).toBe(3 * 4);
    expect(prepared.tessellations[0]).toBeDefined();
    expect(prepared.displacementScales).toEqual([0]);
    expect(prepared.trianglesDisplacements).toEqual([undefined]);

    const result = await precompute(
      prepared.geometries,
      prepared.displacementScales,
      prepared.trianglesDisplacements,
      undefined,
      prepared.tessellations
    );
    resolveFromPrecompute(result, prepared);
    const generated = getPreparedMeshGeometry(mesh);

    expect(generated).not.toBe(source);
    expect(generated.indices.array).toHaveLength(12);
    expect(generated.bvh).toBeDefined();
  });

  it('propagates an external BVH builder failure without substituting a BVH', async () => {
    const prepared = prepareForPrecompute([
      new Mesh(triangleGeometry(), new OpenPBRMaterial())
    ]);
    const error = new Error('tinybvh failed');

    await expect(
      precompute(
        prepared.geometries,
        prepared.displacementScales,
        prepared.trianglesDisplacements,
        async () => {
          throw error;
        }
      )
    ).rejects.toBe(error);
  });

  it('postprocesses original geometry without a displacement map', async () => {
    const source = triangleGeometry();
    const mesh = new Mesh(source, new OpenPBRMaterial());
    mesh.geometrySimplificationRatio = 0.5;
    const prepared = prepareForPrecompute([mesh]);
    let postprocessCalls = 0;
    const simplificationProgress: number[] = [];

    expect(prepared.tessellations).toEqual([undefined]);
    expect(prepared.geometryPostprocessOptions).toEqual([
      { simplificationRatio: 0.5 }
    ]);

    const result = await precompute(
      prepared.geometries,
      prepared.displacementScales,
      prepared.trianglesDisplacements,
      undefined,
      prepared.tessellations,
      (progress) => {
        if (progress.stage === 'simplification') {
          simplificationProgress.push(progress.progress);
        }
      },
      prepared.projectiveDisplacements,
      undefined,
      (geometry, options) => {
        postprocessCalls++;
        expect(options.simplificationRatio).toBe(0.5);
        return geometry;
      },
      prepared.geometryPostprocessOptions
    );
    resolveFromPrecompute(result, prepared);

    expect(postprocessCalls).toBe(1);
    expect(simplificationProgress).toEqual([0, 1]);
    expect(getPreparedMeshGeometry(mesh)).not.toBe(source);
    expect(getPreparedMeshGeometry(mesh).bvh).toBeDefined();
  });

  it('delegates optional asynchronous topology refinement to the application', async () => {
    const material = new OpenPBRMaterial();
    material.displacementMap = heightTexture([1, 1, 1, 1], 2);
    material.displacementScale = 0.25;
    material.displacementMode = 'tessellated';
    material.displacementTessellationMode = 'opensubdiv';
    const mesh = new Mesh(triangleGeometry(), material);
    mesh.geometrySimplificationRatio = 0.5;
    const prepared = prepareForPrecompute([mesh]);
    let refinementCalls = 0;
    let postprocessCalls = 0;

    const result = await precompute(
      prepared.geometries,
      prepared.displacementScales,
      prepared.trianglesDisplacements,
      undefined,
      prepared.tessellations,
      undefined,
      prepared.projectiveDisplacements,
      async (geometry, _texture, options) => {
        refinementCalls++;
        return {
          geometry,
          postTessellationOptions: {
            ...options,
            mode: 'uniform',
            maxSubdivisionLevel: 0
          },
          triangleBudgetReached: false
        };
      },
      (geometry, options) => {
        postprocessCalls++;
        expect(options.displacementScale).toBe(0.25);
        expect(options.simplificationRatio).toBe(0.5);
        expect(geometry.position.array[2]).toBeCloseTo(0.25);
        return geometry;
      }
    );

    expect(refinementCalls).toBe(1);
    expect(postprocessCalls).toBe(1);
    expect(result.geometries[0].indices?.buffer.byteLength).toBe(3 * 4);
    expect(result.geometries[0].tessellationStats).toMatchObject({
      sourceTriangles: 1,
      generatedTriangles: 1
    });
  });

  it('defers projective height-range analysis to worker precompute', async () => {
    const material = new OpenPBRMaterial();
    material.displacementMap = heightTexture([0, 0.25, 0.5, 1], 2);
    material.displacementScale = 0.25;
    const source = triangleGeometry();
    const prepared = prepareForPrecompute([new Mesh(source, material)]);

    expect(prepared.projectiveDisplacements[0]).toBeDefined();
    expect(prepared.trianglesDisplacements).toEqual([undefined]);

    const result = await precompute(
      prepared.geometries,
      prepared.displacementScales,
      prepared.trianglesDisplacements,
      undefined,
      prepared.tessellations,
      undefined,
      prepared.projectiveDisplacements
    );

    expect(result.geometries[0].bvh).toBeDefined();
  });

  it('supports projective range bounds without UVs when using triplanar projection', () => {
    const geometry = triangleGeometry();
    geometry.uv = undefined;
    const material = new OpenPBRMaterial();
    material.displacementUvProjection = 'triplanar';
    const range = getTrianglesDisplacementRange(
      geometry,
      heightTexture([0, 0.25, 0.5, 1], 2),
      material
    );

    expect(range).toBeInstanceOf(Float32Array);
    expect(range).toHaveLength(2);
  });

  it('supports projective range bounds without UVs when using cylindrical projection', () => {
    const geometry = triangleGeometry();
    geometry.uv = undefined;
    const material = new OpenPBRMaterial();
    material.displacementUvProjection = 'cylindrical';
    material.displacementUvScale = 2;
    const range = getTrianglesDisplacementRange(
      geometry,
      heightTexture([0, 0.25, 0.5, 1], 2),
      material
    );

    expect(range).toBeInstanceOf(Float32Array);
    expect(range).toHaveLength(2);
  });

  it('caps emissive explicit meshes before their light table can explode', () => {
    const material = new OpenPBRMaterial();
    material.displacementMap = heightTexture([0, 1, 1, 0], 2);
    material.displacementMode = 'tessellated';
    material.displacementMaxTriangles = 1_000_000;
    material.emissionColor = [1, 1, 1];
    material.emissionLuminance = 2;

    expect(
      getMeshDisplacementTessellationOptions(
        new Mesh(triangleGeometry(), material)
    ).maxTriangles
    ).toBe(250_000);
  });

  it('does not cap a black material with non-zero emissive intensity', () => {
    const material = new OpenPBRMaterial();
    material.displacementMap = heightTexture([0, 1, 1, 0], 2);
    material.displacementMode = 'tessellated';
    material.displacementMaxTriangles = 1_000_000;
    material.emissionColor = [0, 0, 0];
    material.emissionLuminance = 1;

    expect(
      getMeshDisplacementTessellationOptions(
        new Mesh(triangleGeometry(), material)
      ).maxTriangles
    ).toBe(1_000_000);
  });

  it('uses displaced micro-triangle world areas under non-uniform scaling for emission', () => {
    const material = new OpenPBRMaterial();
    material.displacementMap = heightTexture([0.25, 0.25, 0.25, 0.25], 2);
    material.displacementScale = 1;
    material.displacementMode = 'tessellated';
    material.displacementTessellationMode = 'uniform';
    material.displacementMaxSubdivisionLevel = 1;
    material.emissionColor = [1, 1, 1];
    material.emissionLuminance = 2;
    const mesh = new Mesh(triangleGeometry(), material);
    mesh.matrixWorld = mat4.fromScaling(mat4.create(), [2, 3, 4]);
    const geometry = getPreparedMeshGeometry(mesh);

    const triangles = collectEmissiveTriangles(
      [{ mesh, geometry, materialIndices: [0] }],
      [material]
    );

    expect(triangles).toHaveLength(4);
    expect(triangles.reduce((sum, triangle) => sum + triangle.area, 0))
      .toBeCloseTo(3);
    expect(triangles.every((triangle) => triangle.samplingLuminance > 0))
      .toBe(true);
    expect(triangles.flatMap((triangle) => [triangle.p0, triangle.p1, triangle.p2])
      .every((position) => Math.abs(position[2] - 1) < 1e-6))
      .toBe(true);
  });
});
