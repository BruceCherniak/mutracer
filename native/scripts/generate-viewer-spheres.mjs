// Convert the actual browser example, including fromTHREE's material semantics.
import {build} from 'esbuild';
import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const result=await build({stdin:{contents:`import {createMaterialSpheres} from './viewer/src/engine/loadModel.ts'; import {fromTHREEScene} from './src/main.ts'; import * as THREE from 'three'; const scene=new THREE.Scene(); scene.add(createMaterialSpheres().root); export default fromTHREEScene(scene);`,resolveDir:root},bundle:true,write:false,format:'esm',platform:'node'});
const {default:scene}=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
const geometry=scene.meshes[0].geometry;
const chunks=[geometry.position.array,geometry.normal.array,geometry.uv.array,geometry.indices.array].map((values,i)=>{
 const array=i===3?new Uint32Array(values):new Float32Array(values); return Buffer.from(array.buffer);
});
const header=Buffer.alloc(16);chunks.forEach((c,i)=>header.writeUInt32LE(c.length,4*i));
const data=Buffer.concat([header,...chunks]);
const materials=JSON.stringify(scene.meshes.map(mesh=>({name:mesh.name,transform:mesh.transform,values:mesh.materials[0]})),null,2)+'\n';
for(const [name,bytes] of [['spheres.bin',data],['spheres.json',Buffer.from(materials)]]) {
 const path=new URL('../viewer/assets/'+name,import.meta.url);
 if(process.argv.includes('--check')) {if(!readFileSync(path).equals(bytes))throw Error('Regenerate native material spheres: '+name);}
 else writeFileSync(path,bytes);
}
