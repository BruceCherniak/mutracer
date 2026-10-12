import { writeMaterialIndices } from './materialIndices.js';
// Portions adapted from ray-tracing-renderer@0.10.15
// (https://github.com/hoverinc/ray-tracing-renderer).
// Copyright (c) 2019 HOVER, MIT license; see LICENSES/RayTracingRenderer-MIT.txt.

import { mat3, mat4, vec3 } from '../math.js';
import Geometry, { Attribute } from '../scene/Geometry.js';
import Mesh from '../scene/Mesh.js';
import OpenPBRMaterial, {
  getMaterialHashKey,
  resetMaterialTextureId
} from '../scene/OpenPBRMaterial.js';

export interface InternalMergedMesh {
  geometry: Geometry;
  materials: OpenPBRMaterial[];
}

export function mergeMeshesToGeometry(meshes: Mesh[]): InternalMergedMesh {
  let vertexCount = 0;
  let indexCount = 0;

  const geometryAndMaterialIndex = [];
  const materialIndexMap = new Map<string, number>();
  const materials: OpenPBRMaterial[] = [];

  resetMaterialTextureId();

  for (const mesh of meshes) {
    let geometry = mesh.geometry;

    const index = geometry.indices;
    if (!index) {
      addFlatGeometryIndices(geometry);
    }

    geometry = transformGeometry(geometry, mesh.matrixWorld);

    if (!geometry.normal) {
      computeGeometryNormals(geometry);
    } else {
      vec3.forEach(
        geometry.normal.array,
        3,
        0,
        undefined,
        vec3.normalize,
        undefined
      );
    }

    vertexCount += Attribute.getCount(geometry.position);
    indexCount += Attribute.getCount(geometry.indices);

    const materialIndices = mesh.materials.map((material) => {
      const key = getMaterialHashKey(material);
      let materialIndex = materialIndexMap.get(key);
      if (materialIndex === undefined) {
        materialIndex = materialIndexMap.size;
        materialIndexMap.set(key, materialIndex);
        materials.push(material);
      }
      return materialIndex;
    });

    geometryAndMaterialIndex.push({
      geometry,
      materialIndex: materialIndices
    });
  }

  const geometry = mergeGeometry(
    geometryAndMaterialIndex,
    vertexCount,
    indexCount
  );

  return {
    geometry,
    // TODO compress materials. Reuse materials with same props.
    materials
  };
}

function mergeGeometry(
  geometryAndMaterialIndex: {
    geometry: Geometry;
    materialIndex: number[];
  }[],
  totalVertexCount: number,
  totalIndexCount: number
) {
  const positionAttrib = new Attribute(
    new Float32Array(3 * totalVertexCount),
    3
  );
  const normalAttrib = new Attribute(new Float32Array(3 * totalVertexCount), 3);
  const uvAttrib = new Attribute(new Float32Array(2 * totalVertexCount), 2);
  const uv1Attrib = new Attribute(new Float32Array(2 * totalVertexCount), 2);
  const indexAttrib = new Attribute(new Uint32Array(totalIndexCount), 1);

  const materialIndexAttrib = new Attribute(
    new Int32Array(4 * totalVertexCount),
    4
  );

  const mergedGeometry = new Geometry({
    position: positionAttrib,
    normal: normalAttrib,
    uv: uvAttrib,
    uv1: uv1Attrib,
    materialIndex: materialIndexAttrib,
    // color: colorAttrib,
    indices: indexAttrib
  });

  let currentVertex = 0;
  let currentIndex = 0;
  let currentMesh = 1;

  for (const { geometry } of geometryAndMaterialIndex) {
    if (geometry.color) {
      mergedGeometry.color = new Attribute(
        new Float32Array(3 * totalVertexCount),
        3
      );
      break;
    }
    if (geometry.tangent) {
      mergedGeometry.tangent = new Attribute(
        new Float32Array(3 * totalVertexCount),
        3
      );
      break;
    }
  }

  for (const {
    geometry,
    materialIndex: globalMaterialIndex
  } of geometryAndMaterialIndex) {
    const vertexCount = Attribute.getCount(geometry.position);

    (['position', 'normal', 'uv'] as const).forEach((attr) => {
      if (!geometry[attr]) {
        if (attr == 'normal' || attr === 'position') {
          console.error(
            'Geometry must have at least position and normal attributes.'
          );
        }
        return;
      }
      mergedGeometry[attr]!.array.set(
        geometry[attr]!.array,
        currentVertex * geometry[attr]!.itemSize
      );
    });

    uv1Attrib.array.set(
      (geometry.uv1 ?? geometry.uv)?.array ?? new Float32Array(vertexCount * 2),
      currentVertex * 2
    );

    if (mergedGeometry.color) {
      const itemSize = 3;
      if (geometry.color) {
        mergedGeometry.color.array.set(
          geometry.color.array,
          currentVertex * itemSize
        );
      } else {
        // Set to white
        for (let i = 0; i < vertexCount * itemSize; i++) {
          mergedGeometry.color.array[currentVertex * itemSize + i] = 1;
        }
      }
    }
    if (mergedGeometry.tangent) {
      const itemSize = 3;
      if (geometry.tangent) {
        mergedGeometry.tangent.array.set(
          geometry.tangent.array,
          currentVertex * itemSize
        );
      } else {
        for (let i = 0; i < vertexCount * itemSize; i++) {
          mergedGeometry.tangent.array[currentVertex * itemSize + i] = 0;
        }
      }
    }

    const meshIndices = geometry.indices.array;
    for (let i = 0; i < meshIndices.length; i++) {
      indexAttrib.array[currentIndex + i] = currentVertex + meshIndices[i];
    }

    writeMaterialIndices(geometry, globalMaterialIndex, materialIndexAttrib.array, currentVertex, true);

    currentVertex += vertexCount;
    currentIndex += meshIndices.length;
    currentMesh++;
  }

  return mergedGeometry;
}

function addFlatGeometryIndices(geometry: Geometry) {
  const position = geometry.position;

  if (!position) {
    console.warn('No position attribute');
    return;
  }

  const index = new Uint32Array(Attribute.getCount(position));

  for (let i = 0; i < index.length; i++) {
    index[i] = i;
  }

  geometry.indices = new Attribute(index, 1);

  return geometry;
}

function transformGeometry(geometry: Geometry, matrix: mat4.Mat4Array) {
  const { position, normal, uv, uv1, color, tangent, materialIndex, indices } = {
    position: geometry.position.array,
    normal: geometry.normal.array,
    uv: geometry.uv && geometry.uv.array,
    uv1: geometry.uv1 && geometry.uv1.array,
    color: geometry.color && geometry.color.array,
    tangent: geometry.tangent && geometry.tangent.array,
    materialIndex: geometry.materialIndex && geometry.materialIndex.array,
    indices: geometry.indices.array
  };
  const newGeometry = new Geometry({
    position: new Attribute(
      // TODO only copy when necessary
      new Float32Array(position),
      geometry.position.itemSize
    ),
    normal: new Attribute(new Float32Array(normal), geometry.normal.itemSize),
    // No need to clone uv
    uv: uv && new Attribute(uv, geometry.uv!.itemSize),
    uv1: uv1 && new Attribute(uv1, geometry.uv1!.itemSize),
    color: color && new Attribute(color, geometry.color!.itemSize),
    tangent:
      tangent &&
      new Attribute(new Float32Array(tangent), geometry.tangent!.itemSize),
    materialIndex: materialIndex && new Attribute(materialIndex, geometry.materialIndex!.itemSize),
    indices: indices && new Attribute(indices, geometry.indices.itemSize)
  });

  // Normal Matrix
  let normalMatrix = mat3.normalFromMat4(mat3.create(), matrix);
  if (normalMatrix == null) {
    // If matrix has NaN value. normalMatrix may be null.
    // Create an identity one.
    // TODO remove scale information
    normalMatrix = mat3.create();
  }

  vec3.forEach(
    newGeometry.position.array,
    3,
    0,
    undefined,
    vec3.transformMat4,
    matrix
  );

  if (newGeometry.normal) {
    vec3.forEach(
      newGeometry.normal.array,
      3,
      0,
      undefined,
      vec3.transformMat3,
      normalMatrix!
    );
    vec3.forEach(newGeometry.normal.array, 3, 0, undefined, vec3.normalize);
  }
  if (newGeometry.tangent) {
    vec3.forEach(
      newGeometry.tangent.array,
      3,
      0,
      undefined,
      vec3.transformMat3,
      normalMatrix!
    );
    // Try not to normalize the tangent.
    // The anisotropic needs radial tangent. The interpolation inside the triangle will be wrong if we normalize it.
    // vec3.forEach(newGeometry.tangent.array, 3, 0, undefined, vec3.normalize);
  }
  return newGeometry;
}

function computeGeometryNormals(geometry: Geometry) {
  const indices = geometry.indices;
  const positions = geometry.position.array;
  geometry.normal = new Attribute(new Float32Array(positions.length), 3);
  const normals = geometry.normal.array;

  const p1 = vec3.create();
  const p2 = vec3.create();
  const p3 = vec3.create();

  const v21 = vec3.create();
  const v32 = vec3.create();

  const n = vec3.create();

  const len = indices
    ? indices.array.length
    : Geometry.getVertexCount(geometry);
  let i1, i2, i3;
  for (let f = 0; f < len; ) {
    if (indices) {
      i1 = indices.array[f++];
      i2 = indices.array[f++];
      i3 = indices.array[f++];
    } else {
      i1 = f++;
      i2 = f++;
      i3 = f++;
    }

    vec3.set(
      p1,
      positions[i1 * 3],
      positions[i1 * 3 + 1],
      positions[i1 * 3 + 2]
    );
    vec3.set(
      p2,
      positions[i2 * 3],
      positions[i2 * 3 + 1],
      positions[i2 * 3 + 2]
    );
    vec3.set(
      p3,
      positions[i3 * 3],
      positions[i3 * 3 + 1],
      positions[i3 * 3 + 2]
    );

    vec3.sub(v21, p1, p2);
    vec3.sub(v32, p2, p3);
    vec3.cross(n, v21, v32);
    // Already be weighted by the triangle area
    for (let i = 0; i < 3; i++) {
      normals[i1 * 3 + i] = normals[i1 * 3 + i] + n[i];
      normals[i2 * 3 + i] = normals[i2 * 3 + i] + n[i];
      normals[i3 * 3 + i] = normals[i3 * 3 + i] + n[i];
    }
  }

  for (let i = 0; i < normals.length; ) {
    vec3.set(n, normals[i], normals[i + 1], normals[i + 2]);
    vec3.normalize(n, n);
    normals[i++] = n[0];
    normals[i++] = n[1];
    normals[i++] = n[2];
  }
}
