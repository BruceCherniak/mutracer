// Independent Web placement oracle for the native viewer's rect-light adapter.
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import * as THREE from 'three';
import {STUDIO_PRESETS,buildStudioRig,createStudioAmbient} from '../../viewer/src/engine/studio.ts';
const out=resolve(process.argv[2]);
mkdirSync(out,{recursive:true});
const fixtures=[];
for(const [presetId,preset] of STUDIO_PRESETS.entries())for(const scale of [0.01,1,10]){
  const sphere=new THREE.Sphere(new THREE.Vector3(.3*scale,.4*scale,-.2*scale),.5*scale);
  const input={preset:presetId,center:sphere.center.toArray(),radius:sphere.radius,ground:0,intensity:1.2,rotation:30,size:1.5};
  const lights=buildStudioRig(preset,sphere,input.intensity,input.rotation,input.size,input.ground).map(light=>{
    light.updateMatrix();
    return {width:light.width,height:light.height,intensity:light.intensity,transform:light.matrix.toArray()};
  });
  fixtures.push({...input,lights});
}
writeFileSync(resolve(out,'web-studio-reference.json'),JSON.stringify(fixtures));
writeFileSync(resolve(out,'web-ambient-reference.json'),JSON.stringify(Array.from(createStudioAmbient().data)));
