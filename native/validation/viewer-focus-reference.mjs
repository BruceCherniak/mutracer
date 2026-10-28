// Web focus selection/easing and opaque-surface geometry oracle.
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import * as THREE from 'three';
import {pickFocusDepth,focusPull,measureAreaDepth} from '../../viewer/src/engine/areaFocus.ts';
const out=resolve(process.argv[2]);mkdirSync(out,{recursive:true});
let seed=17;
const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
const clusters=[[],[1,1.01,3,3.01,3.02,3.03,3.04,3.05,8,9]];
for(let i=0;i<30;i++)clusters.push(Array.from({length:1+(i*7)%49},()=>Math.fround(1+Math.floor(random()*3)*5+random()*.1)));
const picks=clusters.map(values=>{const depths=values.map(Math.fround);return {depths,rays:49,depth:pickFocusDepth(depths,49)};});
const pulls=[];
for(const [from,to] of [[.1,100],[10,1],[3,3],[100,.1]])for(const elapsed of [0,50,100,260,500,700]){
 const a=Math.fround(from),b=Math.fround(to);pulls.push({from:a,to:b,elapsed,...focusPull(a,b,elapsed)});
}
const surfaces=[];
for(const width of [0,.08,1.2])for(const area of [[.5,.5],[.75,.5],[.5,.75]]){
 const planes=[{width:4,height:4,z:0}];if(width)planes.push({width,height:width,z:1});
 const root=new THREE.Group();
 for(const p of planes){const mesh=new THREE.Mesh(new THREE.PlaneGeometry(p.width,p.height),new THREE.MeshBasicMaterial());mesh.position.z=p.z;root.add(mesh);}
 root.updateMatrixWorld(true);
 const camera=new THREE.PerspectiveCamera(35,1.5,.0001,100);camera.position.z=5;camera.lookAt(0,0,0);camera.updateProjectionMatrix();
 const depth=measureAreaDepth(root,camera,{x:area[0],y:area[1],size:.07},1.5);
 surfaces.push({planes,area,depth});
}
writeFileSync(resolve(out,'web-focus-reference.json'),JSON.stringify({picks,pulls,surfaces}));
