import { expect, it } from 'vitest';
import OpenPBRMaterial, { materialKeys, materialTextureKeys, materialGeometryKeys, materialParamKeys } from '../../src/scene/OpenPBRMaterial';

it('versions material edits and exhaustively classifies independent property groups', () => {
  const material = new OpenPBRMaterial();
  expect(material.version).toBe(0);
  expect(material.markUpdated()).toBe(material);
  expect(material.version).toBe(1);
  const grouped = [...materialTextureKeys, ...materialGeometryKeys, ...materialParamKeys];
  expect(new Set(grouped).size).toBe(grouped.length);
  expect([...grouped].sort()).toEqual([...materialKeys].sort());
  expect(Object.keys(material).filter(key => key !== 'version').sort()).toEqual([...materialKeys].sort());
});

import { vi } from 'vitest';
import { SceneChangeDetector } from '../../src/renderer/sceneChangeDetector';
import Mesh from '../../src/scene/Mesh';
import Texture from '../../src/scene/Texture';
import { createCubeGeometry } from '../../src/util/commonGeometry';

it('warns once for unnotified material array/scalar edits and permits automatic texture changes', () => {
  const material = new OpenPBRMaterial(), geometry = createCubeGeometry();
  const scene = { meshes:[new Mesh(geometry,material)],lights:[] };
  const detector = new SceneChangeDetector(true);
  const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
  try {
    detector.detect(scene); detector.commit();
    material.map = new Texture({data:new Uint8Array(4),width:1,height:1});
    detector.detect(scene);detector.commit(); material.map.markUpdated();
    detector.detect(scene);detector.commit();material.map.uvScale[0] = 2;material.map.markUpdated();
    detector.detect(scene);detector.commit();expect(warn).not.toHaveBeenCalled();
    material.specularRoughness=.7;material.markUpdated();detector.detect(scene);detector.commit();
    expect(warn).not.toHaveBeenCalled();
    material.baseColor[0]=.25;detector.detect(scene);detector.commit();
    expect(warn).toHaveBeenCalledWith('material changed without markUpdated()',material);
    material.specularRoughness=.2;detector.detect(scene);detector.commit();
    expect(warn).toHaveBeenCalledTimes(1);
    const other = new OpenPBRMaterial();scene.meshes[0].materials=[other];detector.detect(scene);detector.commit();
    other.displacementBumpStrength=.5;detector.detect(scene);expect(warn).toHaveBeenCalledTimes(2);
  } finally {warn.mockRestore();}
});

it('checks at most 200 materials per frame and eventually visits every material', () => {
  const geometry=createCubeGeometry(); const materials=Array.from({length:401},()=>new OpenPBRMaterial());
  const scene={meshes:materials.map(m=>new Mesh(geometry,m)),lights:[]};
  const detector=new SceneChangeDetector(true);const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
  try {
    for(let i=0;i<3;i++){detector.detect(scene);detector.commit();}
    for(const m of materials)m.baseColor[0]=.2;
    for(let i=0;i<3;i++){const before=warn.mock.calls.length;detector.detect(scene);detector.commit();expect(warn.mock.calls.length-before).toBeLessThanOrEqual(200);}
    expect(warn).toHaveBeenCalledTimes(401);
  }finally {warn.mockRestore();}
});
