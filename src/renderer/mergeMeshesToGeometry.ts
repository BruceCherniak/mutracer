import {matrixStorage} from '../math/storage.js';
import { meshInstanceCount, meshInstanceTransform } from './meshInstances.js';
import { mergeGeometry, computeGeometryNormals } from './scenePreparation.js';
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
  const geometryAndMaterialIndex = [];
  const materialIndexMap = new Map<string, number>();
  const materials: OpenPBRMaterial[] = [];

  resetMaterialTextureId();

  for (const mesh of meshes) {
    const parent = matrixStorage(mesh.transform);
    for (let instance = 0; instance < meshInstanceCount(mesh); instance++) {
      let geometry = mesh.geometry;

      geometry = transformGeometry(geometry, meshInstanceTransform(mesh, instance, new Float64Array(16), parent));

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
  }

  const geometry = mergeGeometry(
    geometryAndMaterialIndex.map(({geometry}) => geometry),
    geometryAndMaterialIndex.map(({materialIndex}) => materialIndex),
    new Map(),
    true
  );

  return {
    geometry,
    // TODO compress materials. Reuse materials with same props.
    materials
  };
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
    indices: geometry.indexArray
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
