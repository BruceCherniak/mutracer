import {expect,it,vi} from 'vitest';
import {makeShaderDataDefinitions} from 'webgpu-utils';
import {mat4} from '../../src/math';
import RectLight from '../../src/scene/RectLight';
import SpotLight from '../../src/scene/SpotLight';
import DirectionalLight from '../../src/scene/DirectionalLight';
import {getLightDirection,getRigidLightFrame,getRectLightUOrV,packLightsToBuffer,validateSceneLights} from '../../src/renderer/lightsUtil';
import {packAnalyticsLightsToBuffer} from '../../src/renderer/WGPURayTracePass';
import rayTraceCore from '../../src/renderer/wgsl/chunks/rayTraceCore.wgsl';
it('packs a rigid light frame and ignores scale for both layouts',()=>{
 const light=new RectLight({size:[2,3]});mat4.fromScaling(light.transform,[7,8,9]);light.position=[1,2,3];
 expect(Math.hypot(...getRectLightUOrV(light,0))).toBeCloseTo(2);expect(Math.hypot(...getRectLightUOrV(light,1))).toBeCloseTo(3);
 const gl=packLightsToBuffer([light],[-1]),gpu=packAnalyticsLightsToBuffer([light],[-1],[1]);
 expect(gl[17]).toBe(6);expect(gpu[7]).toBe(6);expect(gl.slice(20,23)).toEqual(gpu.slice(20,23));
 vi.stubGlobal('GPUShaderStage',{VERTEX:1,FRAGMENT:2,COMPUTE:4});
 const layout=makeShaderDataDefinitions(rayTraceCore({})).structs.Light;
 expect(gpu.byteLength).toBe(layout.size);expect(layout.fields.iesReference.offset).toBe(20*4);vi.unstubAllGlobals();
});
it('uses local -Z for directional lights regardless of their position',()=>{
 const light=new DirectionalLight();light.position=[100,200,300];light.lookAt([101,200,300]);
 expect(getLightDirection(light)[0]).toBeCloseTo(1);
 const gl=packLightsToBuffer([light],[-1]),gpu=packAnalyticsLightsToBuffer([light],[-1],[1]);
 expect(gl[8]).toBeCloseTo(1);expect(gpu[8]).toBeCloseTo(1);
});
it('rotates the IES azimuth reference continuously through z=0 and with local Z rotation',()=>{
 const light=new SpotLight();light.lookAt([0,0,-1]);const before=getRigidLightFrame(light);
 mat4.rotateZ(light.transform,light.transform,Math.PI/2);const after=getRigidLightFrame(light);
 expect(before.x[0]).toBeCloseTo(1);expect(after.x[1]).toBeCloseTo(1);
 light.position=[-2,3,0];light.lookAt([0,0,-.0001],[0,0,-1]);const a=getRigidLightFrame(light);
 light.lookAt([0,0,.0001],[0,0,-1]);const b=getRigidLightFrame(light);
 expect(Array.from(a.x).reduce((sum,v,i)=>sum+v*b.x[i],0)).toBeGreaterThan(.9999);
});
it('clamps invalid mutable options without throwing and reports once',()=>{
 const light=new SpotLight({radius:-1,innerAngle:999,outerAngle:200});const warn=vi.spyOn(console,'warn').mockImplementation(()=>{}),error=vi.fn();
 try {validateSceneLights([light],error);expect(light.radius).toBe(0);expect(light.outerAngle).toBe(180);expect(light.innerAngle).toBe(180);
 light.radius=-2;validateSceneLights([light],error);expect(error).toHaveBeenCalledTimes(1);expect(warn).toHaveBeenCalledTimes(1);expect(packLightsToBuffer([light],[-1]).every(Number.isFinite)).toBe(true);
 }finally {warn.mockRestore();}
});
