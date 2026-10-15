import { DirectionalLight, SphereLight, SpotLight, RectLightState, TextureState,
  MeshState, InstanceState, MaterialState, LightChoiceBuffer, buildLightAliasTable,
  estimateAnalyticLightPower, estimateEnvironmentPower, collectEmissiveTriangles,
  EmissiveTriangleCache, packEmissiveTriangles, packIESProfiles, packLightsData,
  validateSceneLights, sphereSolidAnglePdf } from '../../src/renderer/lightCore.js';
import type { AnalyticLightState } from '../../src/scene/lightState.js';
import type { LightChoiceInput } from '../../src/renderer/lightSampling.js';
import IESProfile from '../../src/scene/IESProfile.js';
import { createPlaneGeometry } from '../../src/util/commonGeometry.js';
import { read, write } from '../../src/math/access.js';

export function lightParameters(bytes: Uint8Array): Uint8Array {
  const flags = new Uint32Array(bytes.buffer, bytes.byteOffset, 1)[0];
  const rect = new RectLightState({size: [2, 3], color: [.25, .5, 1], intensity: 4, spread: .75});
  const sphere = new SphereLight({radius: flags & 1 ? 0 : .25, intensity: 3});
  const spot = new SpotLight({radius: flags & 2 ? 0 : .125, innerAngle: 20, outerAngle: 40, intensity: 2});
  const directional = new DirectionalLight({color: [1, .5, .25], intensity: .75});
  rect.position = [1, 2, 3]; rect.lookAt([0, 0, 0]);
  sphere.position = [-2, 1, 0]; spot.position = [2, 3, 1]; spot.lookAt([0, 0, 0]);
  directional.lookAt([1, -1, 2]);
  if (flags & 4) rect.texture = new TextureState({width: 2, height: 2});
  if (flags & 8) { sphere.intensity = -1; rect.size = [-2, NaN]; spot.innerAngle = 90; }
  if (flags & 16) spot.iesProfile = new IESProfile('fixture', [0, 90], [0], [1, .5], 1, new Float32Array(128 * 128).fill(.5));
  const lights: AnalyticLightState[] = flags & 64 ? [] : [directional, sphere, spot, rect, spot];
  let warnings = 0;
  validateSceneLights(lights, () => { warnings++; });
  const choices = new LightChoiceBuffer(); choices.reserve(lights.length + 2);
  const inputs: LightChoiceInput[] = [];
  for (let i = 0; i < lights.length; i++) {
    const weight = estimateAnalyticLightPower(lights[i]);
    choices.push(2, i, weight); inputs.push({sourceType: 2, sourceIndex: i, weight});
  }
  choices.push(3, 0, -1); inputs.push({sourceType: 3, sourceIndex: 0, weight: -1});
  const distribution = buildLightAliasTable(flags & 32 ? inputs : choices);
  const ies = packIESProfiles(lights, 7);
  const packedLights = packLightsData(lights, lights.map(light => light.type === 'RectLight' ? 7 : -1),
    i => distribution.pmfs[i], () => undefined, i => ies.offsets[i]);
  const geometry = createPlaneGeometry(2, 2);
  const material = new MaterialState({emissionColor: [1, .5, .25], emissionLuminance: 3,
    coatColor: [.25, .5, 1], coatWeight: .5, unlit: !!(flags & 64)});
  const materials = [material];
  const mesh = new MeshState(geometry, material);
  let instances: InstanceState | undefined;
  if (flags & 2) {
    instances = new InstanceState({count: 3});
    instances.transforms[28] = .5; instances.transforms[44] = -1;
    mesh.setInstanceState(instances);
  }
  if (flags & 4) {
    const matrix: number[] = []; for (let i = 0; i < 16; i++) matrix.push(read(mesh.transform, i));
    matrix[12] = .25 + 1e-12; mesh.transform = matrix;
  }
  const bindings = [{mesh, geometry, materialIndices: [0]}], cache = new EmissiveTriangleCache();
  const first = new Uint8Array(packEmissiveTriangles(collectEmissiveTriangles(bindings, materials)).buffer);
  const cached = new Uint8Array(packEmissiveTriangles(cache.collect(bindings, materials)).buffer);
  const repeated = new Uint8Array(packEmissiveTriangles(cache.collect(bindings, materials)).buffer);
  if (flags & 1) material.emissionLuminance = 2;
  if (flags & 2 && instances) { instances.transforms[12] = .75; instances.markTransformsUpdated(); }
  if (flags & 4) write(mesh.transform, 12, read(mesh.transform, 12) + .125);
  if (flags & 8) { geometry.position.array[0] += .125; geometry.markVerticesUpdated(); }
  const updated = new Uint8Array(packEmissiveTriangles(cache.collect(bindings, materials)).buffer);
  const rebuilt = new Uint8Array(packEmissiveTriangles(collectEmissiveTriangles(bindings, materials)).buffer);
  const image = {width: 2, height: 2, data: new Float32Array([1,.5,.25,1, 0,0,0,1, 2,1,.5,1, 1,1,1,1])};
  const power = estimateEnvironmentPower(image); image.data[0] = 100;
  const metadata = new Float64Array([warnings, distribution.totalWeight, power, estimateEnvironmentPower(image),
    sphereSolidAnglePdf(3, .25), sphereSolidAnglePdf(0, 1), ies.texelCount, estimateEnvironmentPower(undefined),
    ...(lights.map(estimateAnalyticLightPower)), mesh.instanceData?.count ?? 1,
    mesh.instanceData?.transformsVersion ?? 0]);
  const sections = [new Uint8Array(metadata.buffer), new Uint8Array(packedLights.buffer),
    new Uint8Array(distribution.choices.buffer), new Uint8Array(distribution.pmfs.buffer),
    new Uint8Array(ies.offsets.buffer), new Uint8Array(ies.data.buffer), first, cached, repeated, updated, rebuilt];
  const header = new Uint32Array(2 + sections.length); header.set([1, sections.length]);
  for (let i = 0; i < sections.length; i++) header[i + 2] = sections[i].length;
  const output = new Uint8Array(header.byteLength + sections.reduce((sum, section) => sum + section.length, 0));
  output.set(new Uint8Array(header.buffer)); let offset = header.byteLength;
  for (const section of sections) { output.set(section, offset); offset += section.length; }
  return output;
}
