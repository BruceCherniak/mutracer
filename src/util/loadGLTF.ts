/**
 * glTF Loader
 * Specification https://github.com/KhronosGroup/glTF/blob/master/specification/README.md
 *
 * TODO:
 * Morph targets
 * glTF type definitions
 * Animation
 * Skinning
 * Remaining material extensions (transmission and IOR are supported)
 */

import Camera from '../scene/Camera.js';
import Texture from '../scene/Texture.js';
import OpenPBRMaterial from '../scene/OpenPBRMaterial.js';
import Mesh from '../scene/Mesh.js';
import Geometry, { Attribute, GeometryData } from '../scene/Geometry.js';
import HierarchyNode from '../scene/HierarchyNode.js';
import { generateVertexNormals, updateBoundingBox } from './geometry.js';
import { mat4, quat, vec3 } from '../math.js';

const TEXTURE_2D = 0x0de1;

type GLTFFormat = any;
type GLTFNode = any;
type GLTFTexture = any;
type GLTFMaterial = any;
type GLTFMesh = any;
type GLTFBuffer = any;
type GLTFBufferView = any;

interface ParsedLib {
  json: GLTFFormat;
  buffers: ArrayBuffer[];
  bufferViews: ArrayBuffer[];

  rootNode: HierarchyNode;
  cameras: Camera[];
  nodes: HierarchyNode[];
  textures: Texture[];
  materials: OpenPBRMaterial[];
  meshes: Mesh[][];

  instancedMeshes: Mesh[];
}

export type GLTFLoadResult = Pick<
  ParsedLib,
  'json' | 'rootNode' | 'cameras' | 'textures' | 'materials' | 'nodes'
> & {
  meshes: Mesh[];
};

const semanticAttributeMap = {
  NORMAL: 'normal',
  POSITION: 'position',
  TANGENT: 'tangent',
  TEXCOORD_0: 'uv',
  WEIGHTS_0: 'weight',
  JOINTS_0: 'joint',
  COLOR_0: 'color'
};

const ARRAY_CTOR_MAP = {
  5120: Int8Array,
  5121: Uint8Array,
  5122: Int16Array,
  5123: Uint16Array,
  5125: Uint32Array,
  5126: Float32Array
} as const;
const SIZE_MAP = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16
};

type AccessorDataViews =
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Uint32Array
  | Float32Array;

function relative2absolute(path: string, basePath: string) {
  if (!basePath || path.match(/^\//)) {
    return path;
  }
  const pathParts = path.split('/');
  const basePathParts = basePath.split('/');

  let item = pathParts[0];
  while (item === '.' || item === '..') {
    if (item === '..') {
      basePathParts.pop();
    }
    pathParts.shift();
    item = pathParts[0];
  }
  return basePathParts.join('/') + '/' + pathParts.join('/');
}

function getAccessorData(
  json: GLTFFormat,
  lib: ParsedLib,
  accessorIdx: number,
  isIndices?: boolean
): AccessorDataViews {
  const accessorInfo = json.accessors[accessorIdx];

  const buffer = lib.bufferViews[accessorInfo.bufferView];
  const byteOffset = accessorInfo.byteOffset || 0;
  const ArrayCtor =
    (ARRAY_CTOR_MAP as any)[accessorInfo.componentType] || Float32Array;

  let size = (SIZE_MAP as any)[accessorInfo.type];
  if (size == null && isIndices) {
    size = 1;
  }
  let arr = new ArrayCtor(buffer, byteOffset, size * accessorInfo.count);

  const quantizeExtension =
    accessorInfo.extensions &&
    accessorInfo.extensions.WEB3D_quantized_attributes;
  if (quantizeExtension) {
    const decodedArr = new Float32Array(size * accessorInfo.count);
    const decodeMatrix = quantizeExtension.decodeMatrix;
    const decodeOffset = [];
    const decodeScale = [];
    for (let k = 0; k < size; k++) {
      decodeOffset[k] = decodeMatrix[size * (size + 1) + k];
      decodeScale[k] = decodeMatrix[k * (size + 1) + k];
    }
    for (let i = 0; i < accessorInfo.count; i++) {
      for (let k = 0; k < size; k++) {
        decodedArr[i * size + k] =
          arr[i * size + k] * decodeScale[k] + decodeOffset[k];
      }
    }

    arr = decodedArr;
  }
  if (accessorInfo.normalized && !(arr instanceof Float32Array)) {
    const decodedArr = new Float32Array(arr.length);
    const signed = arr instanceof Int8Array || arr instanceof Int16Array;
    const maximum = arr instanceof Int8Array || arr instanceof Uint8Array
      ? (signed ? 127 : 255)
      : (signed ? 32_767 : 65_535);
    for (let index = 0; index < arr.length; index++) {
      decodedArr[index] = signed
        ? Math.max(arr[index] / maximum, -1)
        : arr[index] / maximum;
    }
    arr = decodedArr;
  }
  return arr;
}

function base64ToBinary(input: string, charStart: number) {
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const lookup = new Uint8Array(130);
  for (let i = 0; i < chars.length; i++) {
    lookup[chars.charCodeAt(i)] = i;
  }
  // Ignore
  let len = input.length - charStart;
  if (input.charAt(len - 1) === '=') {
    len--;
  }
  if (input.charAt(len - 1) === '=') {
    len--;
  }

  const uarray = new Uint8Array((len / 4) * 3);

  for (let i = 0, j = charStart; i < uarray.length; ) {
    const c1 = lookup[input.charCodeAt(j++)];
    const c2 = lookup[input.charCodeAt(j++)];
    const c3 = lookup[input.charCodeAt(j++)];
    const c4 = lookup[input.charCodeAt(j++)];

    uarray[i++] = (c1 << 2) | (c2 >> 4);
    uarray[i++] = ((c2 & 15) << 4) | (c3 >> 2);
    uarray[i++] = ((c3 & 3) << 6) | c4;
  }

  return uarray.buffer;
}

interface GLTFLoadOpts {
  /**
   * Explicit container format. This is useful for object URLs, which do not
   * preserve the uploaded file extension.
   */
  format?: 'gltf' | 'glb';

  /**
   * Root path for uri parsing.
   */
  rootPath?: string;

  /**
   * Root path for texture uri parsing. Defaultly use the rootPath
   * @type {string}
   */
  textureRootPath?: string;

  /**
   * Root path for buffer uri parsing. Defaultly use the rootPath
   */
  bufferRootPath?: string;

  /**
   * If loading the cameras.
   */
  includeCamera?: boolean;

  /**
   * If loading the meshes
   */
  includeMesh?: boolean;
  /**
   * If loading the textures.
   */
  includeTexture?: boolean;

  /**
   * @type {string}
   */
  crossOrigin: string;
  /**
   * @see https://github.com/KhronosGroup/glTF/issues/674
   */
  textureFlipY: boolean;

  /**
   * If convert texture to power-of-two
   */
  textureConvertToPOT: boolean;
}

/**
 * Minimal glTF 2.0 loader that produces MuTracer meshes directly. Prefer
 * Three.js `GLTFLoader` with {@link fromTHREEScene} for full glTF support.
 */
export async function load(
  url: string,
  opts?: Partial<GLTFLoadOpts>
): Promise<GLTFLoadResult> {
  opts = Object.assign(
    {

      includeCamera: true,

      includeMesh: true,
      includeTexture: true,

      rootPath: url.slice(0, url.lastIndexOf('/')),

      crossOrigin: '',
      textureFlipY: false,

      textureConvertToPOT: false
    },
    opts
  );

  const isBinary = opts.format === 'glb' || (!opts.format && url.endsWith('.glb'));

  const res = await fetch(url);
  const data = await (isBinary ? res.arrayBuffer() : res.json());
  if (isBinary) {
    return parseBinary(data, opts);
  } else {
    return parse(data, undefined, opts);
  }
}

/**
 * Parse glTF binary
 * @param {ArrayBuffer} buffer
 * @return Parsed glTF scene data.
 */
export async function parseBinary(
  buffer: ArrayBuffer,
  opts: Partial<GLTFLoadOpts>
): Promise<GLTFLoadResult> {
  const header = new Uint32Array(buffer, 0, 4);
  if (header[0] !== 0x46546c67) {
    throw new Error('Invalid glTF binary format: Invalid header');
  }
  if (header[1] < 2) {
    throw new Error('Only glTF2.0 is supported.');
  }

  const dataView = new DataView(buffer, 12);

  let json;
  const buffers = [];
  // Read chunks
  for (let i = 0; i < dataView.byteLength; ) {
    const chunkLength = dataView.getUint32(i, true);
    i += 4;
    const chunkType = dataView.getUint32(i, true);
    i += 4;

    // json
    if (chunkType === 0x4e4f534a) {
      const arr = new Uint8Array(buffer, i + 12, chunkLength);
      const decoder = new TextDecoder();
      const str = decoder.decode(arr);
      try {
        json = JSON.parse(str);
      } catch (e) {
        throw new Error('JSON Parse error:' + e);
      }
    } else if (chunkType === 0x004e4942) {
      buffers.push(buffer.slice(i + 12, i + 12 + chunkLength));
    }

    i += chunkLength;
  }
  if (!json) {
    throw new Error("Invalid glTF binary format: Can't find JSON.");
  }

  return parse(json, buffers, opts);
}

export async function parse(
  json: GLTFFormat,
  buffers: ArrayBuffer[] | undefined,
  opts: Partial<GLTFLoadOpts>
) {
  const lib: ParsedLib = {
    rootNode: new HierarchyNode(),
    json: json,
    buffers: [],
    bufferViews: [],
    materials: [],
    textures: [],
    meshes: [],
    cameras: [],
    nodes: [],
    instancedMeshes: []
  };
  // Mount on the root node if given
  const rootNode = lib.rootNode;

  // If already load buffers
  if (buffers) {
    lib.buffers = buffers.slice();
  } else {
    // Load buffers
    await Promise.all(
      (json.buffers || []).map((bufferInfo: GLTFBuffer, idx: number) => {
        const path = bufferInfo.uri;

        return loadBuffers(path, opts).then((buffer) => {
          lib.buffers[idx] = buffer;
        });
      })
    );
  }

  // Buffer not load complete.
  if (lib.buffers.length !== json.buffers.length) {
    throw new Error('Buffer not load complete.');
  }

  (json.bufferViews || []).forEach(
    (bufferViewInfo: GLTFBufferView, idx: number) => {
      // PENDING Performance
      lib.bufferViews[idx] = lib.buffers[bufferViewInfo.buffer].slice(
        bufferViewInfo.byteOffset || 0,
        (bufferViewInfo.byteOffset || 0) + (bufferViewInfo.byteLength || 0)
      );
    }
  );
  // @ts-ignore
  lib.buffers = undefined;
  if (opts.includeMesh) {
    if (opts.includeTexture) {
      await parseTextures(json, lib, opts);
    }
    parseMaterials(json, lib);
    parseMeshes(json, lib);
  }
  parseNodes(json, lib, opts);

  // Only support one scene.
  if (json.scenes) {
    const sceneInfo = json.scenes[json.scene || 0]; // Default use the first scene.
    if (sceneInfo) {
      for (let i = 0; i < sceneInfo.nodes.length; i++) {
        const node = lib.nodes[sceneInfo.nodes[i]];
        node.updateMatrixWorld();
        rootNode.children.push(node);
      }
    }
  }

  return {
    json,
    rootNode: lib.rootNode,
    cameras: lib.cameras,
    textures: lib.textures,
    materials: lib.materials,
    meshes: lib.instancedMeshes,
    nodes: lib.nodes
  };
}

/**
 * Binary file path resolver. User can override it
 * @param {string} path
 */
function resolveBufferPath(path: string, opts: Partial<GLTFLoadOpts>) {
  if (path && path.match(/^data:(.*?)base64,/)) {
    return path;
  }

  return relative2absolute(path, opts.bufferRootPath || opts.rootPath!);
}

/**
 * Texture file path resolver. User can override it
 * @param {string} path
 */
function resolveTexturePath(path: string, opts: Partial<GLTFLoadOpts>) {
  if (path && path.match(/^data:(.*?)base64,/)) {
    return path;
  }

  return relative2absolute(path, opts.textureRootPath || opts.rootPath || '');
}

async function loadBuffers(path: string, opts: Partial<GLTFLoadOpts>) {
  const base64Prefix = 'data:application/octet-stream;base64,';
  const strStart = path.substr(0, base64Prefix.length);
  if (strStart === base64Prefix) {
    return base64ToBinary(path, base64Prefix.length);
  } else {
    const res = await fetch(resolveBufferPath(path, opts));
    return await res.arrayBuffer();
  }
}

function parseTextures(
  json: GLTFFormat,
  lib: ParsedLib,
  opts: Partial<GLTFLoadOpts>
) {
  return Promise.all(
    (json.textures || []).map((textureInfo: GLTFTexture, idx: number) => {
      // TODO wrapS, wrapT
      // samplers is optional

      const target = textureInfo.target || TEXTURE_2D;

      return new Promise((resolve) => {
        if (target === TEXTURE_2D) {
          const imageInfo = json.images[textureInfo.source];
          let uri: string | undefined;
          if (imageInfo.uri) {
            uri = resolveTexturePath(imageInfo.uri, opts);
          } else if (imageInfo.bufferView != null) {
            uri = URL.createObjectURL(
              new Blob([lib.bufferViews[imageInfo.bufferView]], {
                type: imageInfo.mimeType
              })
            );
          }
          const image = new Image();
          image.onload = () => {};
          image.src = uri || '';
          image.crossOrigin = opts.crossOrigin || null;
          const texture = new Texture(image);
          lib.textures[idx] = texture;
          image.onload = () => {
            resolve(texture);
          };
          image.onerror = () => {
            console.error(`Texture ${uri} not found`);
            resolve(texture);
          };
        }
      });
    })
  );
}


function pbrMetallicRoughnessToStandard(
  materialInfo: GLTFMaterial,
  metallicRoughnessMatInfo: any,
  lib: ParsedLib
) {
  let material;
  let diffuseMap, metallicRoughnessMap, normalMap, emissiveMap,
    transmissionMap;

  /**
   * The scalar multiplier applied to each normal vector of the normal texture.
   *
   * @type {number}
   *
   * XXX This value is ignored if `materialInfo.normalTexture` is not specified.
   */
  let normalScale = 1.0;
  // TODO texCoord
  if (metallicRoughnessMatInfo.baseColorTexture) {
    diffuseMap = lib.textures[metallicRoughnessMatInfo.baseColorTexture.index];
  }
  if (metallicRoughnessMatInfo.metallicRoughnessTexture) {
    metallicRoughnessMap =
      lib.textures[metallicRoughnessMatInfo.metallicRoughnessTexture.index];
  }
  if (materialInfo.normalTexture) {
    normalMap = lib.textures[materialInfo.normalTexture.index];

    if (typeof materialInfo.normalTexture.scale === 'number') {
      normalScale = materialInfo.normalTexture.scale;
    }
  }
  if (materialInfo.emissiveTexture) {
    emissiveMap = lib.textures[materialInfo.emissiveTexture.index];
  }
  const transmissionInfo =
    materialInfo.extensions?.KHR_materials_transmission;
  if (transmissionInfo?.transmissionTexture) {
    transmissionMap =
      lib.textures[transmissionInfo.transmissionTexture.index];
  }
  const baseColor = metallicRoughnessMatInfo.baseColorFactor || [1, 1, 1, 1];

  material = new OpenPBRMaterial();

  material.map = diffuseMap;
  material.metallicRoughnessMap = metallicRoughnessMap;
  material.normalMap = normalMap;
  material.emissiveMap = emissiveMap;
  material.transmissionMap = transmissionMap;
  material.baseColor = baseColor.slice(0, 3);
  material.opacity = baseColor[3];
  // glTF 2.0 defines both omitted factors as 1.0. Exporters commonly omit
  // values that equal the schema default, including Blender for fully rough
  // diffuse surfaces and fully metallic materials. Falling back to zero here
  // silently turned those materials into smooth dielectrics.
  material.baseMetalness = metallicRoughnessMatInfo.metallicFactor ?? 1;
  material.specularRoughness = metallicRoughnessMatInfo.roughnessFactor ?? 1;
  material.transmissionWeight = transmissionInfo?.transmissionFactor ?? 0;
  material.specularIor = materialInfo.extensions?.KHR_materials_ior?.ior ?? 1.5;
  material.emissionColor = materialInfo.emissiveFactor || [0, 0, 0];
  material.emissionLuminance = 1;
  material.doubleSided = materialInfo.doubleSided ?? false;
  const alphaMode = materialInfo.alphaMode ?? 'OPAQUE';
  material.alphaMode = alphaMode.toLowerCase() as 'opaque' | 'mask' | 'blend';
  material.mapAlphaUsage = alphaMode === 'OPAQUE'
    ? OpenPBRMaterial.mapAlphaUsageOpaque
    : OpenPBRMaterial.mapAlphaUsageAlpha;
  material.alphaCutoff = alphaMode === 'MASK'
    ? materialInfo.alphaCutoff ?? 0.5
    : 0;
  material.normalScale = [normalScale, normalScale];

  return material;
}

function parseMaterials(json: GLTFFormat, lib: ParsedLib) {
  lib.materials = (json.materials ?? []).map((materialInfo: GLTFMaterial) =>
    pbrMetallicRoughnessToStandard(
      materialInfo,
      materialInfo.pbrMetallicRoughness ?? {},
      lib
    )
  );
}

function parseMeshes(json: GLTFFormat, lib: ParsedLib) {
  (json.meshes || []).forEach((meshInfo: GLTFMesh, idx: number) => {
    lib.meshes[idx] = [];
    // Geometry
    for (let pp = 0; pp < meshInfo.primitives.length; pp++) {
      const primitiveInfo = meshInfo.primitives[pp];
      const geometry = new Geometry({} as GeometryData);
      // Parse attributes
      const semantics = Object.keys(primitiveInfo.attributes);
      let hasBoundingBox = false;
      for (let ss = 0; ss < semantics.length; ss++) {
        const semantic = semantics[ss];
        const accessorIdx = primitiveInfo.attributes[semantic];
        const attributeInfo = json.accessors[accessorIdx];
        const attributeName = (semanticAttributeMap as any)[semantic];
        if (!attributeName) {
          continue;
        }
        const size = (SIZE_MAP as any)[attributeInfo.type];
        let attributeArray = getAccessorData(json, lib, accessorIdx);
        // WebGL attribute buffer not support uint32.
        // Direct use Float32Array may also have issue.
        if (attributeArray instanceof Uint32Array) {
          attributeArray = new Float32Array(attributeArray);
        }
        if (semantic === 'WEIGHTS_0' && size === 4) {
          // Weight data in QTEK has only 3 component, the last component can be evaluated since it is normalized
          const weightArray = new (attributeArray as any).constructor(
            attributeInfo.count * 3
          );
          for (let i = 0; i < attributeInfo.count; i++) {
            const i4 = i * 4,
              i3 = i * 3;
            const w1 = attributeArray[i4],
              w2 = attributeArray[i4 + 1],
              w3 = attributeArray[i4 + 2],
              w4 = attributeArray[i4 + 3];
            const wSum = w1 + w2 + w3 + w4;
            weightArray[i3] = w1 / wSum;
            weightArray[i3 + 1] = w2 / wSum;
            weightArray[i3 + 2] = w3 / wSum;
          }
          (geometry as any)[attributeName] = new Attribute(weightArray, 4);
        } else if (
          (semantic === 'COLOR_0' || semantic === 'TANGENT') &&
          size === 4
        ) {
          const vectorArray = new (attributeArray as any).constructor(
            attributeInfo.count * 3
          );
          for (let i = 0; i < attributeInfo.count; i++) {
            const i4 = i * 4,
              i3 = i * 3;
            vectorArray[i3] = attributeArray[i4];
            vectorArray[i3 + 1] = attributeArray[i4 + 1];
            vectorArray[i3 + 2] = attributeArray[i4 + 2];
          }
          (geometry as any)[attributeName] = new Attribute(vectorArray, 3);
        } else {
          (geometry as any)[attributeName] = new Attribute(
            attributeArray as any,
            size
          );
        }
        if (semantic === 'POSITION') {
          // Bounding Box
          const min = attributeInfo.min;
          const max = attributeInfo.max;
          if (min && max) {
            vec3.set(geometry.boundingBox.min, min[0], min[1], min[2]);
            vec3.set(geometry.boundingBox.max, max[0], max[1], max[2]);
            hasBoundingBox = true;
          }
        }
      }

      if (!geometry.normal) {
        generateVertexNormals(geometry);
      }
      if (!hasBoundingBox) {
        updateBoundingBox(geometry);
      }

      // Parse indices
      if (primitiveInfo.indices != null) {
        geometry.indices = new Attribute(
          getAccessorData(
            json,
            lib,
            primitiveInfo.indices,
            true
          ) as Uint16Array,
          1
        );
        if (
          Geometry.getVertexCount(geometry) <= 0xffff &&
          geometry.indices.array instanceof Uint32Array
        ) {
          geometry.indices.array = new Uint16Array(geometry.indices.array);
        }
        if (geometry.indices.array instanceof Uint8Array) {
          geometry.indices.array = new Uint16Array(geometry.indices.array);
        }
      }

      let material = lib.materials[primitiveInfo.material];
      // Use default material
      if (!material) {
        material = new OpenPBRMaterial();
      }
      const mesh = new Mesh(geometry, material);
      mesh.name = meshInfo.name || '';

      lib.meshes[idx].push(mesh);
    }
  });
}

function instanceCamera(json: GLTFFormat, nodeInfo: GLTFNode) {
  const cameraInfo = json.cameras[nodeInfo.camera];

  if (cameraInfo.type === 'perspective') {
    const perspectiveInfo = cameraInfo.perspective || {};
    return new Camera(
      'perspective',
      (perspectiveInfo.yfov / Math.PI) * 180,
      perspectiveInfo.aspectRatio,
      perspectiveInfo.znear,
      perspectiveInfo.zfar
    );
  } else {
    // TODO orthographic camera
  }
}

function parseNodes(
  json: GLTFFormat,
  lib: ParsedLib,
  opts: Partial<GLTFLoadOpts>
) {
  function instanceMesh(mesh: Mesh): Mesh {
    const newMesh = new Mesh(mesh.geometry, mesh.materials);
    newMesh.name = mesh.name;
    return newMesh;
  }

  (json.nodes || []).forEach((nodeInfo: GLTFNode, idx: number) => {
    const node = new HierarchyNode();
    if (nodeInfo.camera != null && opts.includeCamera) {
      const camera = instanceCamera(json, nodeInfo);
      if (camera) {
        lib.cameras.push(camera);
        node.sceneNodes = [camera];
      }
    } else if (nodeInfo.mesh != null && opts.includeMesh) {
      const primitives = lib.meshes[nodeInfo.mesh];
      if (primitives) {
        if (primitives.length === 1) {
          // Replace the node with mesh directly
          const mesh = instanceMesh(primitives[0]);
          lib.instancedMeshes!.push(mesh);
          node.sceneNodes = [mesh];
        } else {
          const meshes: Mesh[] = [];
          for (let j = 0; j < primitives.length; j++) {
            const newMesh = instanceMesh(primitives[j]);
            meshes.push(newMesh);
            lib.instancedMeshes!.push(newMesh);
          }
          node.sceneNodes = meshes;
        }
      }
    }
    if (node) {
      if (nodeInfo.matrix) {
        mat4.copy(node.matrix, nodeInfo.matrix);
      } else {
        mat4.fromRotationTranslation(
          node.matrix,
          nodeInfo.rotation || quat.create(),
          nodeInfo.translation || vec3.create()
        );
        mat4.scale(
          node.matrix,
          node.matrix,
          nodeInfo.scale || vec3.fromValues(1, 1, 1)
        );
      }
      lib.nodes[idx] = node;
    }
  });

  // Build hierarchy
  (json.nodes || []).forEach((nodeInfo: GLTFNode, idx: number) => {
    const node = lib.nodes[idx];
    if (nodeInfo.children) {
      for (let i = 0; i < nodeInfo.children.length; i++) {
        const childIdx = nodeInfo.children[i];
        const child = lib.nodes[childIdx];
        node.children.push(child);
      }
    }
  });
}
