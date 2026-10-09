import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { fromTHREECamera, fromTHREEScene, THREESceneSync } from '../../src/util/fromTHREE';
import Camera from '../../src/scene/Camera';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial';
import RectLight from '../../src/scene/RectLight';
import { parseIESProfile } from '../../src/scene/IESProfile';

describe('Three.js scene conversion', () => {
  it('keeps GLTFLoader unlit meshes visible without turning them into lights', () => {
    const scene = new THREE.Scene();
    const map = new THREE.Texture({ width: 1, height: 1 });
    const material = new THREE.MeshBasicMaterial({
      color: 0x80c0ff,
      map,
      transparent: true,
      opacity: 0.6,
      side: THREE.DoubleSide
    });
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(), material));

    const converted = fromTHREEScene(scene);
    expect(converted.meshes).toHaveLength(1);
    expect(converted.meshes[0].materials[0]).toMatchObject({
      unlit: true,
      baseWeight: 0,
      specularWeight: 0,
      emissionLuminance: 1,
      opacity: 0.6,
      alphaMode: 'blend',
      doubleSided: true
    });
    expect(converted.meshes[0].materials[0].emissiveMap).toBe(
      converted.meshes[0].materials[0].map
    );
  });

  it('preserves secondary UVs and per-texture UV channels', () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3)
    );
    geometry.setAttribute(
      'normal',
      new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3)
    );
    geometry.setAttribute(
      'uv',
      new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2)
    );
    geometry.setAttribute(
      'uv1',
      new THREE.Float32BufferAttribute([0.1, 0.2, 0.8, 0.2, 0.1, 0.9], 2)
    );
    geometry.setIndex([0, 1, 2]);
    const map = new THREE.Texture({ width: 1, height: 1 });
    (map as THREE.Texture & { channel: number }).channel = 1;
    const scene = new THREE.Scene();
    scene.add(
      new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ map }))
    );

    const converted = fromTHREEScene(scene).meshes[0];

    expect(Array.from(converted.geometry.uv1!.array)).toEqual(
      Array.from(new Float32Array([0.1, 0.2, 0.8, 0.2, 0.1, 0.9]))
    );
    expect(converted.materials[0].map?.uvChannel).toBe(1);
  });

  it('skips objects hidden directly or by a parent', () => {
    const scene = new THREE.Scene();
    const visible = new THREE.Mesh(
      new THREE.BoxGeometry(),
      new THREE.MeshStandardMaterial()
    );
    const hidden = visible.clone();
    hidden.visible = false;
    const hiddenGroup = new THREE.Group();
    hiddenGroup.visible = false;
    hiddenGroup.add(visible.clone());
    scene.add(visible, hidden, hiddenGroup);

    expect(fromTHREEScene(scene).meshes).toHaveLength(1);
  });

  it('uses complete TRIANGLES only and skips meshes with no complete triangle', () => {
    for (const vertexCount of [1, 2, 4, 5, 6]) {
      const geometry = new THREE.BufferGeometry();
      const positions = Array.from({ length: vertexCount }, (_unused, index) =>
        [index, index % 2, 0]).flat();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      const scene = new THREE.Scene();
      scene.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial()));

      const converted = fromTHREEScene(scene);
      const completeIndexCount = Math.floor(vertexCount / 3) * 3;
      if (!completeIndexCount) {
        expect(converted.meshes).toHaveLength(0);
        continue;
      }
      expect(converted.meshes).toHaveLength(1);
      expect(converted.meshes[0].geometry.indices.array.length)
        .toBe(completeIndexCount);
      expect(completeIndexCount % 3).toBe(0);
    }

    for (const indexCount of [1, 2, 4, 5, 6]) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute([
        0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0
      ], 3));
      geometry.setIndex(Array.from({ length: indexCount }, (_unused, index) => index));
      const scene = new THREE.Scene();
      scene.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial()));

      const converted = fromTHREEScene(scene);
      const completeIndexCount = Math.floor(indexCount / 3) * 3;
      expect(converted.meshes).toHaveLength(completeIndexCount ? 1 : 0);
      if (completeIndexCount) {
        expect(converted.meshes[0].geometry.indices.array.length)
          .toBe(completeIndexCount);
      }
    }
  });

  it('decodes normalized quantized geometry attributes', () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(
        new Uint16Array([0, 32_768, 65_535, 65_535, 0, 32_768, 0, 0, 0]),
        3,
        true
      )
    );
    geometry.setAttribute(
      'normal',
      new THREE.BufferAttribute(
        new Int8Array([0, 0, 127, 0, 127, 0, -127, 0, 0]),
        3,
        true
      )
    );
    geometry.setAttribute(
      'uv',
      new THREE.BufferAttribute(
        new Uint16Array([0, 0, 65_535, 0, 0, 65_535]),
        2,
        true
      )
    );
    geometry.setAttribute(
      'tangent',
      new THREE.BufferAttribute(
        new Float32Array([
          1, 0, 0, 1,
          0, 1, 0, -1,
          0, 0, 1, 1
        ]),
        4
      )
    );
    geometry.setIndex([0, 1, 2]);
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial()));

    const converted = fromTHREEScene(scene).meshes[0].geometry;

    expect(Array.from(converted.position.array)).toEqual(
      Array.from(
        new Float32Array([
          0,
          32_768 / 65_535,
          1,
          1,
          0,
          32_768 / 65_535,
          0,
          0,
          0
        ])
      )
    );
    expect(Array.from(converted.normal.array)).toEqual([
      0, 0, 1, 0, 1, 0, -1, 0, 0
    ]);
    expect(Array.from(converted.uv!.array)).toEqual([0, 0, 1, 0, 0, 1]);
    expect(Array.from(converted.tangent!.array)).toEqual([
      1, 0, 0,
      0, 1, 0,
      0, 0, 1
    ]);
  });

  it('converts physical materials, transforms and environment data', () => {
    const scene = new THREE.Scene();
    const material = new THREE.MeshPhysicalMaterial({
      color: 0x336699,
      roughness: 0.35,
      metalness: 0.7,
      transmission: 0.4,
      ior: 1.45,
      opacity: 0.8,
      transparent: true
    });
    const physicalMaterial = material as THREE.MeshPhysicalMaterial & {
      dispersion: number;
      anisotropy: number;
    };
    physicalMaterial.dispersion = 0.35;
    physicalMaterial.anisotropy = 0.8;
    material.userData.clayptBevelSize = 0.075;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), material);
    mesh.name = 'Converted cube';
    mesh.position.set(1, 2, 3);
    scene.add(mesh);

    const environment = new THREE.DataTexture(
      new Float32Array([1, 0.5, 0.25, 1, 0.2, 0.3, 0.4, 1]),
      2,
      1,
      THREE.RGBAFormat,
      THREE.FloatType
    );
    scene.environment = environment;
    scene.background = environment;

    const result = fromTHREEScene(scene);
    expect(result.meshes).toHaveLength(1);
    expect(result.meshes[0].name).toBe('Converted cube');
    expect(Array.from(result.meshes[0].matrixWorld.slice(12, 15))).toEqual([1, 2, 3]);
    expect(result.meshes[0].materials[0]).toMatchObject({
      specularRoughness: 0.35,
      baseMetalness: 0.7,
      transmissionWeight: 0.4,
      specularIor: 1.45,
      transmissionDispersionScale: 0.35,
      specularAnisotropy: 0.8,
      opacity: 0.8,
      bevelSize: 0.075,
      mapAlphaUsage: OpenPBRMaterial.mapAlphaUsageAlpha
    });
    expect(
      result.lights.some((light) => light.type === 'EnvironmentLight')
    ).toBe(true);
    expect(result.background && !Array.isArray(result.background)).toBe(true);
  });

  it('converts Three.js displacement settings and tessellation metadata', () => {
    const displacementMap = new THREE.DataTexture(
      new Uint8Array([128]),
      1,
      1,
      THREE.RedFormat
    );
    const material = new THREE.MeshStandardMaterial({
      displacementMap,
      displacementScale: 0.25,
      displacementBias: -0.125
    });
    material.userData.clayptDisplacementMode = 'tessellated';
    material.userData.clayptUvProjection = 'spherical';
    material.userData.clayptUvScale = [1.5, 2.5];
    material.userData.clayptUvReferenceLength = 2;
    material.userData.clayptDisplacementStepSize = 0.004;
    material.userData.clayptDisplacementUvProjection = 'cylindrical';
    material.userData.clayptDisplacementUvScale = 2.5;
    material.userData.clayptDisplacementTessellationMode = 'uniform';
    material.userData.clayptDisplacementMaxSubdivisionLevel = 3.8;
    material.userData.clayptDisplacementResolvedMaxSubdivisionLevel = 2.8;
    material.userData.clayptDisplacementResolvedMinSubdivisionLevel = 2.8;
    material.userData.clayptDisplacementMaxError = 0.001;
    material.userData.clayptDisplacementMaxTriangles = 123_456;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), material);
    mesh.userData.clayptMeshoptSimplificationRatio = 0.3;
    material.userData.clayptDisplacementEdgeProfile = 'beveled';
    material.userData.clayptDisplacementThreshold = 0.42;
    material.userData.clayptDisplacementEdgeWidth = 3.5;
    material.userData.clayptDisplacementCreaseAngle = 48;
    material.userData.clayptDisplacementHeightFilter = 'nearest';
    material.userData.clayptDisplacementHeightPrefilter = true;
    material.userData.clayptDisplacementBumpStrength = 12;
    const scene = new THREE.Scene();
    scene.add(mesh);

    const converted = fromTHREEScene(scene).meshes[0].materials[0];

    expect(converted.displacementMap?.image).toBe(displacementMap.image);
    expect(converted).toMatchObject({
      displacementScale: 0.25,
      displacementBias: -0.125,
      uvProjection: 'spherical',
      uvScale: [1.5, 2.5],
      displacementMode: 'tessellated',
      displacementStepSize: 0.004,
      displacementUvProjection: 'cylindrical',
      displacementUvScale: 2.5,
      displacementTessellationMode: 'uniform',
      displacementMinSubdivisionLevel: 2,
      displacementMaxSubdivisionLevel: 2,
      displacementMaxError: 0.001,
      displacementMaxTriangles: 123_456,
      displacementEdgeProfile: 'beveled',
      displacementThreshold: 0.42,
      displacementEdgeWidth: 3.5,
      displacementCreaseAngle: 48,
      displacementHeightFilter: 'nearest',
      displacementHeightPrefilter: true,
      displacementBumpStrength: 12
    });
    expect(fromTHREEScene(scene).meshes[0].geometrySimplificationRatio)
      .toBe(0.3);
  });

  it.each(['opensubdiv'] as const)(
    'preserves the %s displacement tessellation mode',
    (mode) => {
      const material = new THREE.MeshStandardMaterial();
      material.userData.clayptDisplacementMode = 'tessellated';
      material.userData.clayptDisplacementTessellationMode = mode;
      const scene = new THREE.Scene();
      scene.add(new THREE.Mesh(new THREE.BoxGeometry(), material));

      expect(
        fromTHREEScene(scene).meshes[0].materials[0]
          .displacementTessellationMode
      ).toBe(mode);
    }
  );

  it('converts viewer thin-film metadata', () => {
    const material = new THREE.MeshPhysicalMaterial({ transmission: 1 });
    material.userData.clayptOpenPBR = {
      thinWalled: true,
      thinFilmWeight: 1,
      thinFilmThickness: 0.52,
      thinFilmIor: 1.33
    };
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(), material));

    const converted = fromTHREEScene(scene).meshes[0].materials[0];

    expect(converted.thinWalled).toBe(true);
    expect(converted.thinFilmWeight).toBe(1);
    expect(converted.thinFilmThickness).toBeCloseTo(0.52);
    expect(converted.thinFilmIor).toBe(1.33);
  });

  it('uses native Three.js iridescence as a thin-film fallback', () => {
    const thinFilmMap = new THREE.Texture({
      width: 1,
      height: 1
    } as HTMLImageElement);
    const material = new THREE.MeshPhysicalMaterial();
    const iridescent = material as THREE.MeshPhysicalMaterial & {
      iridescence: number;
      iridescenceIOR: number;
      iridescenceThicknessRange: number[];
      iridescenceThicknessMap: THREE.Texture | null;
    };
    iridescent.iridescence = 0.75;
    iridescent.iridescenceIOR = 1.62;
    iridescent.iridescenceThicknessRange = [0, 680];
    iridescent.iridescenceThicknessMap = thinFilmMap;
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(), material));

    const converted = fromTHREEScene(scene).meshes[0].materials[0];

    expect(converted.thinFilmWeight).toBe(0.75);
    expect(converted.thinFilmThickness).toBeCloseTo(0.68);
    expect(converted.thinFilmIor).toBe(1.62);
    expect(converted.thinFilmMap).toBeDefined();
  });

  it('keeps standalone roughness and metalness textures separate', () => {
    const roughnessMap = new THREE.Texture({
      width: 2,
      height: 2
    } as HTMLImageElement);
    const metalnessMap = new THREE.Texture({
      width: 4,
      height: 4
    } as HTMLImageElement);
    const material = new THREE.MeshStandardMaterial({
      roughnessMap,
      metalnessMap
    });
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(), material));

    const converted = fromTHREEScene(scene).meshes[0].materials[0];

    expect(converted.metallicRoughnessMap).toBeUndefined();
    expect(converted.roughnessMap?.image).toBe(roughnessMap.image);
    expect(converted.metalnessMap?.image).toBe(metalnessMap.image);
  });

  it('converts canonical viewer OpenPBR metadata', () => {
    const material = new THREE.MeshPhysicalMaterial({
      transmission: 0.7,
      attenuationColor: new THREE.Color(0x80a0c0),
      attenuationDistance: 2.5,
      clearcoat: 0.4,
      sheen: 0.3
    });
    material.userData.clayptOpenPBR = {
      baseWeight: 0.8,
      baseDiffuseRoughness: 0.2,
      specularWeight: 0.9,
      specularColor: [0.9, 0.8, 0.7],
      transmissionScatter: [0.1, 0.2, 0.3],
      transmissionScatterAnisotropy: 0.35,
      transmissionDispersionScale: 0.45,
      transmissionDispersionAbbeNumber: 32,
      subsurfaceWeight: 0.6,
      subsurfaceColor: [0.8, 0.3, 0.2],
      subsurfaceRadius: 0.25,
      subsurfaceRadiusScale: [1, 0.5, 0.25],
      subsurfaceAnisotropy: 0.15,
      coatColor: [0.95, 0.9, 0.85],
      coatIor: 1.7,
      coatDarkening: 0.8,
      fuzzColor: [0.7, 0.2, 0.1],
      fuzzRoughness: 0.55,
      thinWalled: true,
      thinFilmWeight: 1,
      thinFilmThickness: 0.45,
      thinFilmIor: 1.4
    };
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(), material));

    const converted = fromTHREEScene(scene).meshes[0].materials[0];

    expect(converted).toMatchObject({
      baseWeight: 0.8,
      baseDiffuseRoughness: 0.2,
      specularWeight: 0.9,
      transmissionWeight: 0.7,
      transmissionDepth: 2.5,
      transmissionScatter: [0.1, 0.2, 0.3],
      transmissionScatterAnisotropy: 0.35,
      transmissionDispersionScale: 0.45,
      transmissionDispersionAbbeNumber: 32,
      subsurfaceWeight: 0.6,
      subsurfaceRadius: 0.25,
      subsurfaceAnisotropy: 0.15,
      coatWeight: 0.4,
      coatIor: 1.7,
      coatDarkening: 0.8,
      fuzzWeight: 0.3,
      fuzzRoughness: 0.55,
      thinWalled: true,
      thinFilmWeight: 1,
      thinFilmThickness: 0.45,
      thinFilmIor: 1.4
    });
  });

  it('keeps textured physical transmission independent from base-color alpha', () => {
    const map = new THREE.Texture({ width: 1, height: 1 } as HTMLImageElement);
    const transmissionMap = new THREE.Texture({
      width: 2,
      height: 2
    } as HTMLImageElement);
    transmissionMap.repeat.set(4, 5);
    map.repeat.set(2.5, 3);
    map.offset.set(0.2, -0.1);
    const material = new THREE.MeshPhysicalMaterial({
      map,
      transmissionMap,
      transmission: 0.8,
      metalness: 0,
      transparent: false
    });
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(), material));

    const converted = fromTHREEScene(scene).meshes[0].materials[0];

    expect(converted.transmissionWeight).toBe(0.8);
    expect(converted.transmissionMap?.image).toBe(transmissionMap.image);
    expect(converted.transmissionMap?.uvScale).toEqual([4, 5]);
    expect(converted.map).toBeDefined();
    expect(converted.map?.uvScale).toEqual([2.5, 3]);
    expect(converted.map?.uvOffset).toEqual([0.2, -0.1]);
    expect(converted.mapAlphaUsage).toBe(
      OpenPBRMaterial.mapAlphaUsageOpaque
    );
  });

  it('converts a standalone alpha map and cutoff for path tracing', () => {
    const alphaMap = new THREE.Texture({
      width: 2,
      height: 2
    } as HTMLImageElement);
    alphaMap.repeat.set(3, 4);
    const material = new THREE.MeshStandardMaterial({
      alphaMap,
      alphaTest: 0.35,
      transparent: true
    });
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(), material));

    const converted = fromTHREEScene(scene).meshes[0].materials[0];

    expect(converted.alphaMap?.image).toBe(alphaMap.image);
    expect(converted.alphaMap?.uvScale).toEqual([3, 4]);
    expect(converted.alphaCutoff).toBe(0.35);
    expect(converted.alphaMode).toBe('mask');
    expect(converted.mapAlphaUsage).toBe(
      OpenPBRMaterial.mapAlphaUsageAlpha
    );
  });

  it('preserves Three.js double-sided materials for path tracing', () => {
    const material = new THREE.MeshStandardMaterial({
      side: THREE.DoubleSide
    });
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.PlaneGeometry(), material));

    const converted = fromTHREEScene(scene).meshes[0].materials[0];

    expect(converted.doubleSided).toBe(true);
  });

  it('converts a tagged Three shadow material to a shadow catcher', () => {
    const material = new THREE.ShadowMaterial();
    material.userData.clayptShadowCatcher = true;
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.PlaneGeometry(), material));

    const converted = fromTHREEScene(scene).meshes[0].materials[0];

    expect(converted.shadowCatcher).toBe(true);
  });

  it('clamps invalid shader bevel radii during conversion', () => {
    const material = new THREE.MeshStandardMaterial();
    material.userData.clayptBevelSize = -2;
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(), material));

    expect(fromTHREEScene(scene).meshes[0].materials[0].bevelSize).toBe(0);

    material.userData.clayptBevelSize = Number.NaN;
    expect(fromTHREEScene(scene).meshes[0].materials[0].bevelSize).toBe(0);
  });

  it('maps Three analytic lights to path tracer lights', () => {
    const scene = new THREE.Scene();
    const rect = new THREE.RectAreaLight(0xffffff, 10, 2, 3);
    rect.position.set(1, 2, 3);
    const point = new THREE.PointLight(0xff0000, 4);
    point.position.set(4, 5, 6);
    point.userData.clayptRadius = 0.75;
    const directional = new THREE.DirectionalLight(0x00ff00, 2);
    directional.position.set(3, 4, 5);
    scene.add(rect, point, directional, directional.target);

    const result = fromTHREEScene(scene);
    expect(result.lights.map((light) => light.type)).toEqual([
      'RectLight',
      'SphereLight',
      'DirectionalLight'
    ]);
    expect(result.lights[1]).toMatchObject({ radius: 0.75, intensity: 4 });
  });

  it('keeps the existing unparented directional light vector', () => {
    const scene = new THREE.Scene();
    const light = new THREE.DirectionalLight();
    light.position.set(3, 4, 5);
    light.target.position.set(-1, 2, 0);
    scene.add(light, light.target);
    expect(fromTHREEScene(scene).lights[0]).toMatchObject({
      type: 'DirectionalLight', position: [4, 2, 5]
    });
  });

  it('resolves directional light and independently parented target in world coordinates', () => {
    const scene = new THREE.Scene();
    const parent = new THREE.Group(), targetParent = new THREE.Group();
    parent.matrixAutoUpdate = false;
    parent.matrix.set(0, -3, 0, 10, 2, 0, 0, 20, 0, 0, 4, 30, 0, 0, 0, 1);
    targetParent.matrixAutoUpdate = false;
    targetParent.matrix.set(0, 0, 7, -4, 0, 6, 0, 5, -5, 0, 0, -6, 0, 0, 0, 1);
    targetParent.matrixWorldNeedsUpdate = true;
    const light = new THREE.DirectionalLight();
    light.position.set(1, 0, 0); light.target.position.set(0, 0, 1);
    parent.add(light); targetParent.add(light.target); scene.add(parent);
    // The target's parent need not be part of the rendered scene.
    expect(fromTHREEScene(scene).lights[0]).toMatchObject({
      type: 'DirectionalLight', position: [7, 17, 36]
    });
  });

  it('preserves a rotated source sun with a child target under a nonuniform parent', () => {
    const scene = new THREE.Scene(), parent = new THREE.Group();
    parent.position.set(4, 2, 7); parent.scale.set(2, 0.6, 1.2);
    parent.rotation.set(0.3, -0.4, 0.1); scene.add(parent);
    const light = new THREE.DirectionalLight(); parent.add(light);
    light.position.set(1.1, 2.2, 3.3); light.scale.set(0.9, 1.1, 1.2);
    const raw = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.7, 0.2, 0.9))
      .toArray().map((value) => -value * (1 + 3e-10));
    light.quaternion.fromArray(raw); light.color.setRGB(1.234567891, 0.456789123, 0.234567891);
    light.add(light.target); light.target.position.set(0, 0, -1);
    scene.updateMatrixWorld(true);
    const origin = new THREE.Vector3().applyMatrix4(light.matrixWorld);
    const endpoint = new THREE.Vector3(0, 0, -1).applyMatrix4(light.matrixWorld);
    const expected = origin.sub(endpoint).toArray();
    const converted = fromTHREEScene(scene).lights[0];
    expect(converted).toMatchObject({ type: 'DirectionalLight', position: expected,
      color: light.color.toArray(), intensity: light.intensity });
    expect(light.quaternion.toArray()).toEqual(raw);
    expect(light.target.position.toArray()).toEqual([0, 0, -1]);
  });

  it.each([[2, 2, 2], [1.5, 0.6, 1.2], [-1.5, 0.6, 1.2]])(
    'keeps the approximated Rect sampling frame rigid under parent scale %j', (...scale) => {
      const scene = new THREE.Scene(), parent = new THREE.Group();
      parent.scale.fromArray(scale); parent.rotation.set(0.2, 0.4, 0.1); scene.add(parent);
      const rect = new THREE.RectAreaLight(0xffffff, 4, 1.5, 0.8); parent.add(rect);
      rect.position.set(1.234567891, 2.345678912, 3.456789123);
      rect.color.setRGB(1.234567891, 0.789123456, 0.345678912);
      rect.quaternion.setFromEuler(new THREE.Euler(-0.9, 0.3, 0.4));
      const raw = rect.quaternion.toArray().map((value) => -value * (1 + 3e-10));
      rect.quaternion.fromArray(raw); scene.updateMatrixWorld(true);
      const world = rect.matrixWorld.toArray(), local = rect.matrix.toArray();
      const result = fromTHREEScene(scene).lights[0];
      if (result.type !== 'RectLight') throw new Error('Expected RectLight');
      expect(result.size).toEqual([
        rect.width * Math.hypot(world[0], world[1], world[2]),
        rect.height * Math.hypot(world[4], world[5], world[6])
      ]);
      expect(result.color).toEqual(rect.color.toArray()); expect(result.intensity).toBe(4);
      const matrix = result.matrixWorld;
      const x = new THREE.Vector3(matrix[0], matrix[1], matrix[2]);
      const y = new THREE.Vector3(matrix[4], matrix[5], matrix[6]);
      const doubleRoundoff = 64 * Number.EPSILON;
      expect(Math.abs(x.lengthSq() - 1)).toBeLessThanOrEqual(doubleRoundoff);
      expect(Math.abs(y.lengthSq() - 1)).toBeLessThanOrEqual(doubleRoundoff);
      expect(Math.abs(x.dot(y))).toBeLessThanOrEqual(doubleRoundoff);
      expect(Math.abs(x.clone().cross(y).length() - 1)).toBeLessThanOrEqual(doubleRoundoff);
      // Renderer sampling vectors are packed through Float32Array. Verify the
      // actual packed geometry against the PDF area within float32 roundoff.
      const u = new THREE.Vector3(...RectLight.getUOrV(result, 0));
      const v = new THREE.Vector3(...RectLight.getUOrV(result, 1));
      expect(Math.abs(u.cross(v).length() / RectLight.getArea(result) - 1)).toBeLessThanOrEqual(16 * 2 ** -23);
      expect(matrix.slice(12, 15)).toEqual(world.slice(12, 15));
      expect(rect.quaternion.toArray()).toEqual(raw);
      expect(rect.matrix.toArray()).toEqual(local); expect(rect.matrixWorld.toArray()).toEqual(world);
      expect(rect.parent).toBe(parent);
    }
  );

  it('uses effective rectangle dimensions under rotated nonuniform parents', () => {
    for (const scale of [[2, 2, 2], [2, 3, 1]]) {
      const scene = new THREE.Scene();
      const parent = new THREE.Group();
      parent.scale.fromArray(scale);
      parent.rotation.z = 0.3;
      scene.add(parent);
      const rect = new THREE.RectAreaLight(0xffffff, 4, 1.5, 0.8);
      rect.rotation.z = 0.4;
      parent.add(rect);
      scene.updateMatrixWorld(true);
      const matrix = rect.matrixWorld.elements;
      const width = 1.5 * Math.hypot(matrix[0], matrix[1], matrix[2]);
      const height = 0.8 * Math.hypot(matrix[4], matrix[5], matrix[6]);
      const converted = fromTHREEScene(scene).lights[0];
      expect(converted.type).toBe('RectLight');
      if (converted.type !== 'RectLight') return;
      expect(converted.size[0]).toBeCloseTo(width);
      expect(converted.size[1]).toBeCloseTo(height);
      const convertedMatrix = converted.matrixWorld;
      expect(Math.hypot(convertedMatrix[0], convertedMatrix[1], convertedMatrix[2]))
        .toBeCloseTo(1);
      expect(Math.hypot(convertedMatrix[4], convertedMatrix[5], convertedMatrix[6]))
        .toBeCloseTo(1);
    }
  });

  it('converts half-float HDR data without flipping source rows', () => {
    const scene = new THREE.Scene();
    const environment = new THREE.DataTexture(
      new Uint16Array([
        0x3c00, 0x3800, 0x3400, 0x3c00,
        0x3400, 0x3800, 0x3c00, 0x3c00
      ]),
      1,
      2,
      THREE.RGBAFormat,
      THREE.HalfFloatType
    );
    environment.flipY = true;
    scene.environment = environment;
    scene.background = environment;

    const result = fromTHREEScene(scene);
    const environmentLight = result.lights.find(
      (light) => light.type === 'EnvironmentLight'
    );
    expect(environmentLight?.type).toBe('EnvironmentLight');
    if (!environmentLight || environmentLight.type !== 'EnvironmentLight') return;

    const image = environmentLight.map.image as {
      data: Float32Array;
      width: number;
      height: number;
    };
    expect(image.data).toBeInstanceOf(Float32Array);
    expect(Array.from(image.data.slice(0, 4))).toEqual([1, 0.5, 0.25, 1]);
    expect(result.background).toBe(environmentLight.map);
  });

  it('creates fresh one-shot environment lights and reads the current version', () => {
    const scene = new THREE.Scene();
    const pixels = new Float32Array([1, 0.5, 0.25, 1]);
    const environment = new THREE.DataTexture(
      pixels,
      1,
      1,
      THREE.RGBAFormat,
      THREE.FloatType
    );
    scene.environment = environment;

    const first = fromTHREEScene(scene).lights.find(
      (light) => light.type === 'EnvironmentLight'
    );
    const second = fromTHREEScene(scene).lights.find(
      (light) => light.type === 'EnvironmentLight'
    );
    expect(second).not.toBe(first);

    pixels[0] = 0.25;
    environment.needsUpdate = true;
    const updated = fromTHREEScene(scene).lights.find(
      (light) => light.type === 'EnvironmentLight'
    );
    expect(updated).not.toBe(first);
    expect(updated?.type).toBe('EnvironmentLight');
    if (!updated || updated.type !== 'EnvironmentLight') return;
    expect(updated.map.version).toBe(environment.version);
    expect((updated.map.image as { data: Float32Array }).data[0]).toBe(0.25);
  });

  it('converts grounded skybox metadata without treating its preview mesh as geometry', () => {
    const scene = new THREE.Scene();
    const environment = new THREE.DataTexture(
      new Float32Array([1, 0.5, 0.25, 1]),
      1,
      1,
      THREE.RGBAFormat,
      THREE.FloatType
    );
    scene.environment = environment;
    scene.userData.clayptGroundedSkybox = {
      texture: environment,
      height: 1.7,
      radius: 40,
      groundHeight: -0.25,
      center: [2, 3]
    };
    const preview = new THREE.Mesh(
      new THREE.SphereGeometry(),
      new THREE.MeshBasicMaterial()
    );
    preview.userData.viewerEnvironment = true;
    scene.add(preview);

    const result = fromTHREEScene(scene);

    expect(result.meshes).toHaveLength(0);
    expect(result.background).toMatchObject({
      type: 'GroundedSkybox',
      height: 1.7,
      radius: 40,
      groundHeight: -0.25,
      center: [2, 3]
    });
  });

  it('ignores viewer realtime displacement proxy meshes', () => {
    const scene = new THREE.Scene();
    const source = new THREE.Mesh(
      new THREE.BoxGeometry(),
      new THREE.MeshStandardMaterial()
    );
    const proxy = source.clone();
    proxy.userData.viewerRealtimeDisplacement = true;
    scene.add(source, proxy);

    expect(fromTHREEScene(scene).meshes).toHaveLength(1);
  });

  it('keeps environment lighting while explicitly hiding the background', () => {
    const scene = new THREE.Scene();
    const environment = new THREE.DataTexture(
      new Float32Array([1, 0.5, 0.25, 1]),
      1,
      1,
      THREE.RGBAFormat,
      THREE.FloatType
    );
    scene.environment = environment;
    scene.background = null;
    scene.userData.clayptHiddenBackground = true;

    const result = fromTHREEScene(scene);

    expect(result.lights.some((light) => light.type === 'EnvironmentLight')).toBe(true);
    expect(result.background).toEqual([0, 0, 0, 0]);
  });

  it('splits grouped Three meshes into path tracer primitives', () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(
        [-1, 0, 0, 0, 0, 0, -1, 1, 0, 0, 1, 0],
        3
      )
    );
    geometry.setIndex([0, 1, 2, 2, 1, 3]);
    geometry.addGroup(0, 3, 0);
    geometry.addGroup(3, 3, 1);
    const mesh = new THREE.Mesh(geometry, [
      new THREE.MeshStandardMaterial({ color: 0xff0000 }),
      new THREE.MeshStandardMaterial({ color: 0x00ff00 })
    ]);
    const scene = new THREE.Scene();
    scene.add(mesh);

    const result = fromTHREEScene(scene);
    expect(result.meshes).toHaveLength(2);
    expect(result.meshes[0].geometry.indices.array).toHaveLength(3);
    expect(result.meshes[1].materials[0].baseColor).toEqual([0, 1, 0]);
  });

  it('preserves shared texture references across converted mesh materials', () => {
    const image = { width: 4, height: 4 } as HTMLImageElement;
    const texture = new THREE.Texture(image);
    const material = new THREE.MeshStandardMaterial({ map: texture });
    const scene = new THREE.Scene();
    scene.add(
      new THREE.Mesh(new THREE.BoxGeometry(), material),
      new THREE.Mesh(new THREE.SphereGeometry(), material)
    );

    const result = fromTHREEScene(scene);

    expect(result.meshes).toHaveLength(2);
    expect(result.meshes[0].materials[0]).toBe(
      result.meshes[1].materials[0]
    );
    expect(result.meshes[0].materials[0].map).toBe(
      result.meshes[1].materials[0].map
    );
  });

  it('retains converted geometry and BVH while syncing transforms', () => {
    const scene = new THREE.Scene();
    const sourceGeometry = new THREE.BoxGeometry();
    const mesh = new THREE.Mesh(
      sourceGeometry,
      new THREE.MeshStandardMaterial()
    );
    scene.add(mesh);
    const sync = new THREESceneSync(scene);
    const first = sync.scene;
    const firstGeometry = first.meshes[0].geometry;
    first.meshes[0].geometry.bvh = {
      buffer: new ArrayBuffer(32),
      maxDepth: 1
    };
    mesh.position.x = 2;
    mesh.updateMatrixWorld(true);
    sync.update();
    const second = sync.scene;

    expect(second.meshes[0].geometry).toBe(firstGeometry);
    expect(second.meshes[0].geometry.bvh).toBe(first.meshes[0].geometry.bvh);
    expect(second.meshes[0].matrixWorld[12]).toBe(2);
  });

  it('uses triplanar displacement automatically for a UV-less mesh', () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3)
    );
    geometry.setAttribute(
      'normal',
      new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3)
    );
    geometry.setIndex([0, 1, 2]);
    const material = new THREE.MeshStandardMaterial();
    material.displacementMap = new THREE.DataTexture(
      new Uint8Array([0, 255, 255, 0]),
      2,
      2,
      THREE.RedFormat
    );
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(geometry, material));

    const converted = fromTHREEScene(scene).meshes[0];

    expect(converted.geometry.uv).toBeUndefined();
    expect(converted.materials[0].displacementUvProjection).toBe('triplanar');
  });

  it('uses shared triplanar projection automatically for textures on a UV-less mesh', () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3)
    );
    geometry.setAttribute(
      'normal',
      new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3)
    );
    geometry.setIndex([0, 1, 2]);
    const material = new THREE.MeshStandardMaterial({
      map: new THREE.DataTexture(
        new Uint8Array([255, 255, 255, 255]),
        1,
        1
      )
    });
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(geometry, material));

    const converted = fromTHREEScene(scene).meshes[0];

    expect(converted.geometry.uv).toBeUndefined();
    expect(converted.materials[0].uvProjection).toBe('triplanar');
  });
});

describe('Three.js camera conversion', () => {
  it('preserves orthographic bounds in constructor order', () => {
    const source = new THREE.OrthographicCamera(-4, 6, 3, -2, 0.1, 100);
    source.zoom = 2;
    const camera = fromTHREECamera(source);
    expect(camera).toMatchObject({
      left: -4,
      right: 6,
      top: 3,
      bottom: -2,
      zoom: 2,
      near: 0.1,
      far: 100
    });
  });

  it('converts THREE.SpotLight target, cone, radius, range, and IES metadata', () => {
    const scene = new THREE.Scene();
    const light = new THREE.SpotLight(0xff8040, 12, 20, Math.PI / 3, 0.25);
    light.position.set(1, 3, 2);
    light.target.position.set(1, 1, 2);
    light.userData.clayptRadius = 0.05;
    light.userData.clayptIesRotation = 30;
    light.userData.clayptIesProfile = parseIESProfile([
      'IESNA:LM-63-1995', 'TILT=NONE', '1 1 1 2 1 1 1 0 0 0',
      '1 1 1', '0 90', '0', '1 0'
    ].join('\n'));
    scene.add(light, light.target);
    const converted = fromTHREEScene(scene).lights.find((item) => item.type === 'SpotLight');
    expect(converted).toMatchObject({
      type: 'SpotLight',
      position: [1, 3, 2],
      direction: [0, -1, 0],
      intensity: 12,
      radius: 0.05,
      range: 20,
      iesRotation: 30
    });
    if (converted?.type !== 'SpotLight') throw new Error('missing converted spot light');
    expect(converted.innerAngle).toBeCloseTo(45);
    expect(converted.outerAngle).toBeCloseTo(60);
  });

  it('copies orthographic projection state into a reusable camera', () => {
    const source = fromTHREECamera(
      Object.assign(new THREE.OrthographicCamera(-3, 5, 4, -2), {
        zoom: 1.5
      })
    );
    const target = new Camera('perspective');
    source.aperture = 0.12;
    source.focusDistance = 6.5;
    Camera.copy(source, target);

    expect(target).toMatchObject({
      projection: 'orthographic',
      left: -3,
      right: 5,
      top: 4,
      bottom: -2,
      zoom: 1.5,
      aperture: 0.12,
      focusDistance: 6.5
    });
  });
});
