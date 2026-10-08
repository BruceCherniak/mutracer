import { describe, expect, it } from 'vitest';
import {
  buildLightAliasTable,
  collectEmissiveTriangles,
  estimateAnalyticLightPower,
  
  LIGHT_CHOICE_ANALYTIC,
  packEmissiveTriangles
} from '../../src/renderer/lightSampling';
import RectLight from '../../src/scene/RectLight';
import SphereLight from '../../src/scene/SphereLight';
import SpotLight from '../../src/scene/SpotLight';
import Mesh from '../../src/scene/Mesh';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial';
import { Attribute } from '../../src/scene/Geometry';
import { createPlaneGeometry } from '../../src/util/commonGeometry';
import rayTraceGlsl from '../../src/renderer/glsl/rayTrace.frag';
import sampleLight from '../../src/renderer/wgsl/chunks/sampleLight.wgsl';

describe('power-weighted light sampling', () => {
  it('does not treat delta directional lights as finite geometry hits', () => {
    expect(rayTraceGlsl.main).toContain('float d = INF');
    expect(rayTraceGlsl.main).not.toContain('float d;');
  });

  it('normalizes PMFs and creates valid alias entries', () => {
    const result = buildLightAliasTable(
      [1, 3, 6].map((weight, sourceIndex) => ({
        sourceType: LIGHT_CHOICE_ANALYTIC,
        sourceIndex,
        weight
      }))
    );
    expect(result.pmfs[0]).toBeCloseTo(0.1);
    expect(result.pmfs[1]).toBeCloseTo(0.3);
    expect(result.pmfs[2]).toBeCloseTo(0.6);
    expect(result.totalWeight).toBe(10);
    const probabilities = new Float32Array(result.choices.buffer);
    const aliases = new Int32Array(result.choices.buffer);
    for (let i = 0; i < 3; i++) {
      expect(probabilities[i * 4]).toBeGreaterThan(0);
      expect(probabilities[i * 4]).toBeLessThanOrEqual(1);
      expect(aliases[i * 4 + 1]).toBeGreaterThanOrEqual(0);
      expect(aliases[i * 4 + 1]).toBeLessThan(3);
    }
  });

  it('weights an area light by luminance and area', () => {
    const light = new RectLight([2, 3], [1, 1, 1], 4);
    expect(estimateAnalyticLightPower(light)).toBeCloseTo(24 * Math.PI);
  });

  it('keeps zero-radius sphere and spot emitters finite, weighted, and delta', () => {
    const point = new SphereLight([0, 0, 0], [1, 0.5, 0.25], 12, 0);
    const spot = new SpotLight(
      [0, 0, 0],
      [0, 0, -1],
      [1, 0.5, 0.25],
      12,
      0,
      10,
      30
    );
    expect(SphereLight.getArea(point)).toBe(0);
    expect(SpotLight.getArea(spot)).toBe(0);
    expect(SpotLight.getRadiance(spot)).toBe(12);
    expect(estimateAnalyticLightPower(point)).toBeGreaterThan(0);
    expect(estimateAnalyticLightPower(spot)).toBeGreaterThan(0);
    expect(Number.isFinite(SpotLight.getRadiance(spot))).toBe(true);
    expect(sampleLight).toContain('light.radiusOrSpread <= 0.0');
    expect(sampleLight).toContain('centerDistance * centerDistance');
  });

  it('collects and packs emissive mesh triangles in world space', () => {
    const material = new OpenPBRMaterial();
    material.emissionColor = [2, 1, 0.5];
    material.emissionLuminance = 3;
    const geometry = createPlaneGeometry();
    geometry.uv1 = new Attribute(
      Float32Array.from(geometry.uv!.array, (value) => 1 - value),
      2
    );
    const mesh = new Mesh(geometry, material);
    mesh.matrixWorld[12] = 5;
    const triangles = collectEmissiveTriangles(
      [{ mesh, geometry: mesh.geometry, materialIndices: [0] }],
      [material]
    );

    expect(triangles).toHaveLength(2);
    expect(triangles[0].p0[0]).toBeGreaterThanOrEqual(4);
    expect(triangles[0].samplingLuminance).toBeGreaterThan(0);
    expect(triangles[0].secondaryUv0).not.toEqual(triangles[0].uv0);
    const packed = packEmissiveTriangles(triangles);
    expect(packed).toHaveLength(48);
    expect(Array.from(packed.slice(18, 24))).toEqual([
      ...triangles[0].secondaryUv0,
      ...triangles[0].secondaryUv1,
      ...triangles[0].secondaryUv2
    ]);
    expect(sampleLight).toContain(
      'i32(triangle.materialIndex), uv, secondaryUv'
    );
  });

  it('does not sample unlit surfaces as mesh lights', () => {
    const material = new OpenPBRMaterial();
    material.unlit = true;
    material.emissionColor = [1, 1, 1];
    material.emissionLuminance = 1;
    const mesh = new Mesh(createPlaneGeometry(), material);
    expect(collectEmissiveTriangles(
      [{ mesh, geometry: mesh.geometry, materialIndices: [0] }],
      [material]
    )).toHaveLength(0);
  });
});
