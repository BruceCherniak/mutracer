import { zipSync, strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { bakeChannels, parseMaterialX } from '../src/engine/materialx';
import { readMaterialXPackage } from '../src/engine/materialxFiles';

const doc = (body: string) => `<?xml version="1.0"?>\n<materialx version="1.38">\n${body}\n</materialx>`;
const material = (shader: string) => `<surfacematerial name="M" type="material">
  <input name="surfaceshader" type="surfaceshader" nodename="${shader}" />
</surfacematerial>`;

describe('MaterialX import', () => {
  it('folds constant node graphs, as in the MatLib parametric metals', () => {
    const result = parseMaterialX(doc(`
  <nodegraph name="NG">
    <constant name="Oxidation" type="float"><input name="value" type="float" value="0.5" /></constant>
    <mix name="Color" type="color3">
      <input name="fg" type="color3" value="0, 0.2, 0.4" />
      <input name="bg" type="color3" value="1, 0.6, 0.4" />
      <input name="mix" type="float" nodename="Oxidation" />
    </mix>
    <multiply name="Rough" type="float">
      <input name="in1" type="float" value="0.4" />
      <input name="in2" type="float" nodename="Oxidation" />
    </multiply>
    <output name="color" type="color3" nodename="Color" />
    <output name="rough" type="float" nodename="Rough" />
  </nodegraph>
  <standard_surface name="S" type="surfaceshader">
    <input name="base" type="float" value="1" />
    <input name="base_color" type="color3" nodegraph="NG" output="color" />
    <input name="metalness" type="float" value="1" />
    <input name="specular_color" type="color3" nodegraph="NG" output="color" />
    <input name="specular_roughness" type="float" nodegraph="NG" output="rough" />
  </standard_surface>
  ${material('S')}`));
    expect(result.values.baseColor).toEqual([0.5, 0.4, 0.4]);
    expect(result.values.specularColor).toEqual([0.5, 0.4, 0.4]);
    expect(result.values.specularRoughness).toBeCloseTo(0.2);
    expect(result.values.baseMetalness).toBe(1);
    expect(result.maps).toEqual({});
    expect(result.warnings).toEqual([]);
  });

  it('maps an ORM texture to the packed slot and bakes a remapped roughness', () => {
    const graph = (roughness: string) => doc(`
  <nodegraph name="NG">
    <texcoord name="uv" type="vector2" />
    <multiply name="tiled" type="vector2">
      <input name="in1" type="vector2" nodename="uv" />
      <input name="in2" type="float" value="2" />
    </multiply>
    <image name="color" type="color3">
      <input name="file" type="filename" colorspace="srgb_texture" value="textures/Base.png" />
      <input name="texcoord" type="vector2" nodename="tiled" />
    </image>
    <image name="orm" type="vector3">
      <input name="file" type="filename" value="textures/ORM.png" />
      <input name="texcoord" type="vector2" nodename="tiled" />
    </image>
    <image name="nrm" type="vector3">
      <input name="file" type="filename" value="textures/Normal.png" />
      <input name="texcoord" type="vector2" nodename="tiled" />
    </image>
    <extract name="r" type="float"><input name="in" type="vector3" nodename="orm" /><input name="index" type="integer" value="1" /></extract>
    <extract name="m" type="float"><input name="in" type="vector3" nodename="orm" /><input name="index" type="integer" value="2" /></extract>
    ${roughness}
    <normalmap name="n" type="vector3"><input name="in" type="vector3" nodename="nrm" /></normalmap>
    <output name="base_color" type="color3" nodename="color" />
    <output name="metal" type="float" nodename="m" />
    <output name="normal" type="vector3" nodename="n" />
  </nodegraph>
  <standard_surface name="S" type="surfaceshader">
    <input name="base" type="float" value="0.8" />
    <input name="base_color" type="color3" nodegraph="NG" output="base_color" />
    <input name="metalness" type="float" nodegraph="NG" output="metal" />
    <input name="specular_roughness" type="float" nodegraph="NG" output="rough" />
    <input name="normal" type="vector3" nodegraph="NG" output="normal" />
  </standard_surface>
  ${material('S')}`);

    const plain = parseMaterialX(graph('<output name="rough" type="float" nodename="r" />'));
    expect(plain.maps).toEqual({
      map: { file: 'textures/Base.png', srgb: true },
      metallicRoughnessMap: { file: 'textures/ORM.png' },
      normalMap: { file: 'textures/Normal.png' }
    });
    expect(plain.values.baseColor).toEqual([0.8, 0.8, 0.8]);
    expect(plain.values.specularRoughness).toBe(1);
    expect(plain.values.baseMetalness).toBe(1);
    expect(plain.uvScale).toEqual([2, 2]);

    const remapped = parseMaterialX(graph(`
    <mix name="levels" type="float">
      <input name="fg" type="float" value="1" />
      <input name="bg" type="float" value="0.25" />
      <input name="mix" type="float" nodename="r" />
    </mix>
    <output name="rough" type="float" nodename="levels" />`));
    expect(remapped.maps.metallicRoughnessMap).toEqual({
      file: 'textures/ORM.png',
      bake: [
        { target: 1, file: 'textures/ORM.png', channel: 1, gain: 0.75, bias: 0.25 },
        { target: 2, file: 'textures/ORM.png', channel: 2, gain: 1, bias: 0 }
      ]
    });
    expect(remapped.warnings).toEqual([]);
  });

  it('converts Standard Surface units and folds the base weight', () => {
    const result = parseMaterialX(doc(`
  <standard_surface name="S" type="surfaceshader">
    <input name="base" type="float" value="0.5" />
    <input name="base_color" type="color3" value="0.8, 0.4, 0.2" />
    <input name="thin_film_thickness" type="float" value="450" />
    <input name="sheen" type="float" value="0.7" />
    <input name="subsurface_radius" type="color3" value="1, 0.4, 0.1" />
    <input name="subsurface_scale" type="float" value="0.2" />
    <input name="transmission_dispersion" type="float" value="40" />
    <input name="opacity" type="color3" value="0.5, 0.5, 0.5" />
  </standard_surface>
  ${material('S')}`));
    expect(result.values.baseColor).toEqual([0.4, 0.2, 0.1]);
    expect(result.values.thinFilmWeight).toBe(1);
    expect(result.values.thinFilmThickness).toBeCloseTo(0.45);
    expect(result.values.fuzzWeight).toBe(0.7);
    expect(result.values.fuzzRoughness).toBe(0.3);
    expect(result.values.subsurfaceRadius).toBe(0.2);
    expect(result.values.subsurfaceRadiusScale).toEqual([1, 0.4, 0.1]);
    expect(result.values.transmissionDispersionScale).toBe(0.5);
    expect(result.values.opacity).toBe(0.5);
    expect(result.values.specularRoughness).toBe(0.2);
  });

  it('reads OpenPBR inputs one to one', () => {
    const result = parseMaterialX(doc(`
  <open_pbr_surface name="S" type="surfaceshader">
    <input name="base_color" type="color3" value="0.1, 0.2, 0.3" />
    <input name="coat_weight" type="float" value="1" />
    <input name="thin_film_thickness" type="float" value="0.3" />
    <input name="geometry_thin_walled" type="boolean" value="true" />
  </open_pbr_surface>
  ${material('S')}`));
    expect(result.shader).toBe('open_pbr_surface');
    expect(result.values.baseColor).toEqual([0.1, 0.2, 0.3]);
    expect(result.values.coatWeight).toBe(1);
    expect(result.values.coatIor).toBe(1.6);
    expect(result.values.thinFilmThickness).toBe(0.3);
    expect(result.values.thinWalled).toBe(true);
  });

  it('reports unsupported nodes and keeps the shader default', () => {
    const result = parseMaterialX(doc(`
  <nodegraph name="NG">
    <noise2d name="noise" type="float" />
    <image name="color" type="color3"><input name="file" type="filename" value="a.png" /></image>
    <image name="tint" type="color3"><input name="file" type="filename" value="b.png" /></image>
    <multiply name="both" type="color3">
      <input name="in1" type="color3" nodename="color" />
      <input name="in2" type="color3" nodename="tint" />
    </multiply>
    <output name="rough" type="float" nodename="noise" />
    <output name="color" type="color3" nodename="both" />
  </nodegraph>
  <standard_surface name="S" type="surfaceshader">
    <input name="specular_roughness" type="float" nodegraph="NG" output="rough" />
    <input name="base_color" type="color3" nodegraph="NG" output="color" />
  </standard_surface>
  ${material('S')}`));
    expect(result.values.specularRoughness).toBe(0.2);
    expect(result.values.baseColor).toEqual([0.8, 0.8, 0.8]);
    expect(result.maps).toEqual({});
    expect(result.warnings).toEqual(['"multiply" combining textures', '"noise2d" node']);
  });

  it('rejects documents without a supported shader', () => {
    expect(() => parseMaterialX(doc(`<surface name="S" type="surfaceshader" />${material('S')}`))).toThrow(/Unsupported shader "surface"/);
    expect(() => parseMaterialX('<materialx></materialx>')).toThrow(/no surfacematerial/);
    expect(() => parseMaterialX('<materialx><nodegraph></materialx>')).toThrow(/Malformed/);
  });

  it('bakes remapped channels into a packed map', () => {
    const source = new Uint8ClampedArray([0, 255, 102, 255, 0, 0, 255, 255]);
    const pixels = bakeChannels([
      { target: 1, file: 'orm', channel: 1, gain: 0.75, bias: 0.25 },
      { target: 2, file: 'orm', channel: 2, gain: 1, bias: 0 }
    ], new Map([['orm', source]]), 2);
    expect([...pixels]).toEqual([0, 255, 102, 255, 0, 64, 255, 255]);
  });

  it('reads zip packages and resolves textures case-insensitively', async () => {
    const zip = zipSync({
      'Wallpaper/Wallpaper.mtlx': strToU8('<materialx />'),
      'Wallpaper/textures/Wallpaper_normal.png': new Uint8Array([1, 2, 3]),
      '__MACOSX/Wallpaper/._Wallpaper.mtlx': new Uint8Array([0])
    });
    const pkg = await readMaterialXPackage([{ file: new File([zip], 'Wallpaper.zip'), path: 'Wallpaper.zip' }]);
    expect(pkg.path).toBe('Wallpaper/Wallpaper.mtlx');
    expect(pkg.text).toBe('<materialx />');
    const normal = pkg.resolve('textures/Wallpaper_Normal.png');
    expect(normal?.type).toBe('image/png');
    expect(normal?.size).toBe(3);
    expect(pkg.resolve('./textures/../textures/wallpaper_normal.png')).toBe(normal);
    expect(pkg.resolve('missing.png')).toBeUndefined();
  });
});
