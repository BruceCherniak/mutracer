import * as THREE from 'three';
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';
import Engine from '../../src/Engine.ts';
import Render from '../../src/Render.ts';
import {THREESync} from '../../src/util/fromTHREE.ts';
import {initUNetFromBuffer} from 'oidn-web';
const status=document.querySelector('pre');
const save=async(name,data)=>{const r=await fetch('/evidence?name='+encodeURIComponent(name),{method:'POST',body:typeof data==='string'||ArrayBuffer.isView(data)?data:JSON.stringify(data,null,2)});if(!r.ok)throw Error(await r.text());};
const native=async(job)=>{const r=await fetch('/denoise-native',{method:'POST',body:JSON.stringify(job)});if(!r.ok)throw Error(await r.text());return r.json();};
try {
  const config=await(await fetch('/denoise-config')).json();
  const engine=new Engine({canvas:document.querySelector('canvas'),backend:'webgpu'});
  await engine.init();
  const device=engine.device;
  const adapterInfo=engine.getDiagnostics();
  await save('browser.json',{userAgent:navigator.userAgent,adapterInfo,features:[...device.features]});
  status.textContent='Loading complex glTF scene';
  const gltf=await new GLTFLoader().loadAsync(config.model);
  gltf.scene.updateMatrixWorld(true);
  const box=new THREE.Box3().setFromObject(gltf.scene), center=box.getCenter(new THREE.Vector3()),radius=box.getSize(new THREE.Vector3()).length()/2;
  const camera=gltf.cameras[0]??new THREE.PerspectiveCamera(40,16/9,.01,10000);
  if(!gltf.cameras.length){camera.position.copy(center).add(new THREE.Vector3(radius*.7,radius*.4,radius*1.8));camera.lookAt(center);}
  const scene=new THREE.Scene();scene.add(gltf.scene);scene.add(new THREE.HemisphereLight(0xffffff,0x777777,1));
  const sync=new THREESync(engine,{scene,camera});sync.update();
  await engine.prepare(sync.scene);engine.update();
  const weights=await(await fetch('/oidn/weights/rt_hdr_alb_nrm.tza')).arrayBuffer();
  const results=[];
  for(const [requestedWidth,requestedHeight] of config.sizes){
    camera.aspect=requestedWidth/requestedHeight;camera.updateProjectionMatrix();sync.update();engine.update();
    const render=new Render(engine,{width:requestedWidth,height:requestedHeight,maxSamples:8,bounces:6});
    status.textContent=`Rendering ${requestedWidth}x${requestedHeight}, 8 spp`;
    await render.converge({samples:8,samplesPerBatch:1,sampleSequenceOffset:0});
    const images=[];
    for(const name of ['hdr','normal','albedo'])images.push(await render.readPixels(name));
    const {width,height}=images[0],key=`${width}x${height}`;
    for(let i=0;i<3;i++)await save(`${key}/${['hdr','normal','albedo'][i]}.rgba32f`,images[i].data);
    await save(`${key}/input.json`,{width,height,requestedWidth,requestedHeight,samples:8,model:config.model});
    render.dispose();
    for(let round=0;round<config.rounds;round++){
      const order=round%2?['web','cpu','cuda']:['cuda','cpu','web'];
      for(const backend of order){
        status.textContent=`${key}, round ${round+1}/${config.rounds}: ${backend}`;
        // Drain earlier rendering and do not overlap CPU/CUDA/WebGPU work.
        await device.queue.onSubmittedWorkDone();
        if(backend!=='web'){results.push({key,round,...await native({key,width,height,backend:backend==='cpu'?1:3,round,iterations:config.iterations})});continue;}
        const started=performance.now();
        // Fixed tiles make repeated observations comparable; adaptive defaults
        // otherwise keep changing tile shapes during the short timing window.
        const unet=await initUNetFromBuffer(weights,{device},{aux:true,hdr:true,engine:'wgsl',precision:'auto',maxTileSize:512,dynamicTile:false});
        const createMs=performance.now()-started;
        const buffers=images.map(()=>device.createBuffer({size:width*height*16,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST}));
        const readback=device.createBuffer({size:width*height*16,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
        let output,firstMs;
        const warmMs=[],residentMs=[];
        for(let i=0;i<config.iterations+3;i++){
          const start=performance.now();
          images.forEach((image,j)=>device.queue.writeBuffer(buffers[j],0,image.data));
          const inferenceStart=performance.now();
          const filtered=await new Promise((done,error)=>unet.tileExecute({color:{data:buffers[0],width,height},normal:{data:buffers[1],width,height},albedo:{data:buffers[2],width,height},done,error,scheduling:'event-loop'}));
          const inferenceMs=performance.now()-inferenceStart;
          const encoder=device.createCommandEncoder();encoder.copyBufferToBuffer(filtered.data,0,readback,0,width*height*16);device.queue.submit([encoder.finish()]);
          await readback.mapAsync(GPUMapMode.READ);output=new Float32Array(readback.getMappedRange().slice(0));readback.unmap();
          const ms=performance.now()-start;if(i===0)firstMs=ms;if(i>=3){warmMs.push(ms);residentMs.push(inferenceMs);}
        }
        if(!output.every(Number.isFinite))throw Error('Non-finite WebGPU output');
        const report={key,round,backend:'oidn-web',size:[width,height],createMs,firstMs,warmMs,residentMs,runtime:unet.getRuntimeInfo(),timing:'host upload + tiled inference + host readback; residentMs excludes host readback but includes pending upload',inputScale:1};
        await save(`${key}/round-${round}/web/result.json`,report);await save(`${key}/round-${round}/web/output.rgba32f`,output);results.push(report);
        unet.dispose();buffers.forEach(b=>b.destroy());readback.destroy();
      }
    }
  }
  await save('complete.json',results);status.textContent='PASS: CPU / CUDA / oidn-web comparison complete';sync.dispose();engine.dispose();
} catch(error){status.textContent=error.stack??String(error);await save('failure.json',{error:error.stack??String(error)});console.error(error);}
