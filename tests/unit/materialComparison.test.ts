import {describe,expect,it,vi} from 'vitest';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial';
import {materialAliases,openPbrSchema} from '../../src/scene/openPbrSchema';
import {MaterialChangeTracker} from '../../src/renderer/materialChanges';
import Texture from '../../src/scene/Texture';
import Mesh from '../../src/scene/Mesh';
import {createCubeGeometry} from '../../src/util/commonGeometry';
import {SceneChangeDetector,materialParametersEqual,snapshotMaterialParameters} from '../../src/renderer/sceneChangeDetector';

const texture = () => new Texture({width:1,height:1,data:new Uint8Array(4)});
function fixture() {
  const material = new OpenPBRMaterial(), mesh = new Mesh(createCubeGeometry(),material);
  const scene = {meshes:[mesh],lights:[]}, detector = new SceneChangeDetector();
  detector.detect(scene); detector.commit();
  return {material,scene,detector};
}
function changedValue(field: typeof openPbrSchema[number]) {
  const value = field.default;
  if (field.type === 'texture') return texture();
  if (Array.isArray(value)) return value.map(v=>v+.125);
  if (typeof value === 'number') return value+.125;
  if (typeof value === 'boolean') return !value;
  const enums: Record<string,string> = {alphaMode:'mask',mapAlphaUsage:'alpha',uvProjection:'triplanar',displacementUvProjection:'triplanar',thinFilmMapChannel:'g',specularAnisotropyModel:'gltf'};
  return enums[field.key];
}

describe('material comparison behavior',()=>{
  for(const field of openPbrSchema) {
    it(`detects ${field.key} and becomes stable only after committing it`,()=>{
      const {material,scene,detector} = fixture();
      const tracker = new MaterialChangeTracker(); tracker.capture([material]);
      Object.assign(material,{[field.key]:changedValue(field)});
      const change = detector.detect(scene);
      expect(change).toMatchObject({meshes:'incremental',materials:[material],transforms:[],geometries:[]});
      const level = field.category === 'geometry' || field.key === 'displacementMap' ? 'geometry' : field.category === 'texture' ? 'textures' : ['emissionColor','emissionLuminance','coatWeight','coatColor','unlit','shadowCatcher'].includes(field.key) ? 'emission' : 'params';
      expect(tracker.classify(change.materials).level).toBe(level);
      expect(detector.detect(scene)).toEqual(change);
      detector.commit();expect(detector.detect(scene).meshes).toBe('none');
    });
    if(field.type === 'texture') {
      it(`detects ${field.key} metadata and preserves pixel/UV notification rules`,()=>{
        const {material,scene,detector} = fixture(), map=texture();
        Object.assign(material,{[field.key]:map});detector.detect(scene);detector.commit();
        const edits=[()=>{map.image={width:1,height:1,data:new Uint8Array(4)};},()=>{map.flipY=true;},
          ()=>{map.uvScale=[2,3];},()=>{map.uvOffset=[.2,.3];},()=>{map.uvChannel=1;},()=>{map.markUpdated();}];
        for(const edit of edits){edit();expect(detector.detect(scene).materials).toEqual([material]);detector.commit();expect(detector.detect(scene).materials).toEqual([]);}
        map.uvScale[0]++;expect(detector.detect(scene).materials).toEqual([]);
        map.markUpdated();expect(detector.detect(scene).materials).toEqual([material]);detector.commit();
        Object.assign(material,{[field.key]:undefined});expect(detector.detect(scene).materials).toEqual([material]);
      });
    }
    if(field.type === 'color' || field.type === 'vec2') {
      it(`detects ${field.key} elements and accepts equal-value array replacements`,()=>{
        const {material,scene,detector} = fixture();
        const tracker = new MaterialChangeTracker(); tracker.capture([material]);
        const vector=material[field.key] as number[];
        Object.assign(material,{[field.key]:vector.slice()});expect(detector.detect(scene).materials).toEqual([]);
        (material[field.key] as number[])[0]+=.125;const change=detector.detect(scene);expect(change.materials).toEqual([material]);
        expect(tracker.classify(change.materials).level).toBe(['emissionColor','coatColor'].includes(field.key)?'emission':'params');detector.commit();
        // JS callers may also supply typed vectors; comparison remains by value.
        const typed=new Float32Array(material[field.key] as number[]);Object.assign(material,{[field.key]:typed});
        detector.detect(scene);detector.commit();typed[0]+=.125;
        expect(detector.detect(scene).materials).toEqual([material]);
      });
    }
  }
  it('retains Object.is semantics for NaN and signed zero in scalars and vectors',()=>{
    const {material,scene,detector}=fixture();
    material.specularRoughness=NaN;material.baseColor[0]=NaN;detector.detect(scene);detector.commit();
    expect(detector.detect(scene).materials).toEqual([]);
    material.baseWeight=0;material.baseColor[1]=0;detector.detect(scene);detector.commit();
    material.baseWeight=-0;expect(detector.detect(scene).materials).toEqual([material]);detector.commit();
    material.baseColor[1]=-0;expect(detector.detect(scene).materials).toEqual([material]);detector.commit();
    expect(detector.detect(scene).materials).toEqual([]);
  });
  it('preserves value comparisons for unusual arrays passed to scalar fields from JS',()=>{
    const material=new OpenPBRMaterial();
    for(const value of [[1,NaN,-0],new Float32Array([1,2,3])]) {
      Object.assign(material,{baseWeight:value});const previous=snapshotMaterialParameters(material);
      expect(materialParametersEqual(material,previous)).toBe(true);
      value[0]=2;expect(materialParametersEqual(material,previous)).toBe(false);
    }
    Object.assign(material,{baseColor:[1,2,3,4]});const previous=snapshotMaterialParameters(material);
    material.baseColor.push(5);expect(materialParametersEqual(material,previous)).toBe(false);
  });
});

it('retains committed material values across unrelated commits, pending overwrite and rollback',()=>{
  const {material,scene,detector}=fixture(), other=new OpenPBRMaterial();
  scene.meshes.push(new Mesh(scene.meshes[0].geometry,other));detector.detect(scene);detector.commit();
  for(let frame=0;frame<6;frame++) {
    scene.meshes[0].transform[12]++;
    expect(detector.detect(scene).materials).toEqual([]);detector.commit();
    material.baseColor[0]=.2+frame/10;
    expect(detector.detect(scene).materials).toEqual([material]);
    material.baseColor[0]=.25+frame/10;
    expect(detector.detect(scene).materials).toEqual([material]);detector.commit();
    expect(detector.detect(scene).materials).toEqual([]);
    const value=other.specularRoughness;other.specularRoughness=.6;
    expect(detector.detect(scene).materials).toEqual([other]);other.specularRoughness=value;
    expect(detector.detect(scene).materials).toEqual([]);detector.commit();
    other.normalScale[1]+=.1;expect(detector.detect(scene).materials).toEqual([other]);detector.commit();
    expect(detector.detect(scene).materials).toEqual([]);
  }
});

it('reads an unchanged shared material only once when another material or transform changes',()=>{
  const {material,scene,detector}=fixture(), other=new OpenPBRMaterial();
  for(let i=0;i<10;i++)scene.meshes.push(new Mesh(scene.meshes[0].geometry,other));detector.detect(scene);detector.commit();
  const read=vi.fn(()=>1);Object.defineProperty(other,'baseWeight',{get:read,configurable:true});
  material.baseColor[0]=.25;expect(detector.detect(scene).materials).toEqual([material]);expect(read).toHaveBeenCalledOnce();detector.commit();
  read.mockClear();scene.meshes[0].transform[12]++;
  expect(detector.detect(scene).materials).toEqual([]);expect(read).toHaveBeenCalledOnce();detector.commit();
  material.baseColor[0]=.6;expect(detector.detect(scene).materials).toEqual([material]);
});

it('reuses equal vector snapshots while keeping changed vectors isolated from prior snapshots',()=>{
  const material=new OpenPBRMaterial(), first=snapshotMaterialParameters(material);
  material.baseWeight=.6;const second=snapshotMaterialParameters(material,first);
  expect(materialParametersEqual(material,first)).toBe(false);expect(materialParametersEqual(material,second)).toBe(true);
  material.baseColor[0]=.25;const third=snapshotMaterialParameters(material,second);
  expect(materialParametersEqual(material,second)).toBe(false);expect(materialParametersEqual(material,third)).toBe(true);
  material.baseColor[0]=.8;material.baseWeight=1;expect(materialParametersEqual(material,first)).toBe(true);
});

it('keeps shared texture metadata uncommitted while snapshot buffers share unchanged entries',()=>{
  const {material,scene,detector}=fixture(), other=new OpenPBRMaterial(), map=texture();
  material.map=other.map=map;scene.meshes.push(new Mesh(scene.meshes[0].geometry,other));detector.detect(scene);detector.commit();
  for(let frame=0;frame<4;frame++) {
    scene.meshes[0].transform[12]++;detector.detect(scene);detector.commit();
    map.flipY=!map.flipY;
    expect(detector.detect(scene).materials).toEqual([material,other]);
    expect(detector.detect(scene).materials).toEqual([material,other]);
    detector.commit();expect(detector.detect(scene).materials).toEqual([]);
  }
});

for (const alias of Object.keys(materialAliases) as (keyof typeof materialAliases)[]) {
  it(`automatically detects ${alias} through its shared storage`, () => {
    const {material,scene,detector} = fixture();
    const tracker = new MaterialChangeTracker(); tracker.capture([material]);
    Object.assign(material,{[alias]:alias === 'geometryThinWalled' ? true : .4});
    const change = detector.detect(scene);
    expect(change.materials).toEqual([material]);
    expect(change.transforms).toEqual([]); expect(change.geometries).toEqual([]);
    expect(tracker.classify(change.materials)).toEqual({level:'params',emission:false,emissiveMap:false});
    detector.commit(); expect(detector.detect(scene).materials).toEqual([]);
  });
}
