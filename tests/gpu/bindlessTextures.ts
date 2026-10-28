import {Engine, Camera, Mesh, OpenPBRMaterial, Render, Texture, SphereLight, RectLight, createSphereGeometry} from '../../src/main.js';
import {Attribute} from '../../src/scene/Geometry.js';
import {compareBindlessSampling} from './bindlessTextureSampling.js';

function check(condition: unknown, message: string): asserts condition {if (!condition) throw new Error(message);}
function compare(a: ArrayLike<number>, b: ArrayLike<number>) {
  check(a.length === b.length, 'Mismatched image lengths');
  let max = 0, squared = 0, nonfinite = 0;
  for (let i = 0; i < a.length; i++) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) nonfinite++;
    const delta = Math.abs(a[i] - b[i]); max = Math.max(max, delta); squared += delta * delta;
  }
  return {max, rmse: Math.sqrt(squared / a.length), nonfinite};
}

/** Real-GPU behavioral comparison; invoke from a module page served by npm run dev. */
export async function runBindlessTextures(backend: 'webgpu' | 'webgl' = 'webgpu', samples = 16, expectedActive = backend === 'webgpu' ? 'bindless' : 'atlas', onCase?: (name: string) => void) {
  const engines = (['atlas', 'auto'] as const).map(textureBinding => {
    const canvas = document.createElement('canvas'); document.body.append(canvas);
    const engine = new Engine({canvas, backend, textureBinding}); engine.display.setSize(96,64); engine.bvhWorkerCount = 1;
    return engine;
  });
  const errors: string[] = [], removeErrors: (() => void)[] = [];
  for (const e of engines) e.on('error', error => errors.push(String(error)));
  const textures: Texture[] = [], materials: OpenPBRMaterial[] = [], meshes: Mesh[] = [];
  const modes = ['repeat', 'clamp-to-edge', 'mirrored-repeat'] as const;
  const geometry = createSphereGeometry(16,8);
  geometry.uv1 = new Attribute(geometry.uv!.array.slice(), 2);
  for (let i=0;i<geometry.uv1.array.length;i++) geometry.uv1.array[i]=1-geometry.uv1.array[i];
  for (let i = 0; i < 9; i++) {
    const bytes = new Uint8Array(3*2*4);
    for (let p=0;p<6;p++) bytes.set([(p*43+i*13)%256,(p*79+i*31)%256,(p*113+i*7)%256, p===0?96:255],p*4);
    const texture = new Texture({width:3,height:2,data:bytes});
    texture.wrapS=modes[Math.floor(i/3)]; texture.wrapT=modes[i%3]; texture.uvScale=[2.3,-1.7];texture.uvOffset=[-.35,.1];texture.flipY=i%2===0;
    const material = new OpenPBRMaterial({map:texture});
    const mesh = new Mesh(geometry,material);mesh.transform[0]=mesh.transform[5]=mesh.transform[10]=.45;mesh.transform[12]=(i%3-1)*1.1;mesh.transform[13]=(Math.floor(i/3)-1)*1.1;
    textures.push(texture);materials.push(material);meshes.push(mesh);
  }
  const light=new SphereLight({intensity:30});light.position=[2,3,4];
  const rect=new RectLight({texture:textures[0],intensity:3});rect.position=[-2,2,3];rect.lookAt([0,0,0]);
  const scene={meshes,lights:[light,rect]};
  const camera=new Camera({projection:'perspective'});camera.position=[0,0,6];camera.lookAt([0,0,0]);
  const renders: Render[] = [];
  const results: Record<string,unknown>[] = [];
  const sampling: unknown[] = [];
  try {
    for(const engine of engines) {
      engine.scene=scene;engine.camera=camera;engine.update();await engine.init();
      if(engine.device){const listener=(event: Event)=>{errors.push((event as GPUUncapturedErrorEvent).error.message);};engine.device.addEventListener('uncapturederror',listener);removeErrors.push(()=>engine.device?.removeEventListener('uncapturederror',listener));}
      renders.push(new Render(engine,{maxSamples:samples,bounces:3,bevel:false,directLightCandidates:2}));
    }
    const take=async(name:string)=>{
      onCase?.(name);
      const output: Float32Array[]=[], depths: (Float32Array|undefined)[]=[], diagnostics=[];
      for(let i=0;i<engines.length;i++) {
        engines[i].update();
        await renders[i].converge({samples,sampleSequenceOffset:17,timeoutMs:60000});
        output.push((await renders[i].readPixels('hdr')).data);
        depths.push(await engines[i].readDepthSamples({x:.5,y:.5,size:.1}));
        diagnostics.push(engines[i].getDiagnostics());
      }
      const image=compare(output[0],output[1]);
      check(image.nonfinite===0, name+': non-finite HDR');
      // Hardware filtering can differ at the last stored HDR bit. Sampling-level
      // checks and detailed differences remain part of the external A/B evidence.
      check(image.rmse<.001, name+': HDR mismatch '+JSON.stringify(image));
      const depth=depths[0]&&depths[1]?compare(depths[0],depths[1]):undefined;
      if(depth) check(depth.max<1e-4,name+': depth mismatch');
      results.push({name,image,depth,bindings:diagnostics.map(d=>d?.materialTextures),compilation:diagnostics.map(d=>d?.shaderCompilation?.totalTimeMs)});
    };
    await take('wrap-matrix-rectlight');
    for(const t of textures) {t.uvScale=[-.75,2.1];t.uvOffset=[1.2,-.45];}
    await take('uv-edit');
    const pixels=textures[0].image;
    if ('data' in pixels) {pixels.data[0]=22;textures[0].markUpdated();}
    await take('single-pixel-edit');
    textures[1].image={width:1,height:1,data:new Uint8Array([15,90,240,255])};
    await take('resize-and-one-texel');
    textures[2].image={width:2,height:1,data:new Float32Array([2,.25,.1,1,.1,.5,3,1])};
    await take('mixed-hdr-promotion');
    textures[4].uvChannel=1; textures[4].colorSpace='linear';
    await take('uv1-linear');
    materials[0].alphaMode='mask';materials[0].alphaCutoff=.5;
    materials[1].normalMap=textures[3];materials[1].coatWeight=.4;materials[1].coatNormalMap=textures[4];
    materials[2].emissiveMap=textures[2];materials[2].emissionLuminance=1;
    if(expectedActive==='bindless')sampling.push(await compareBindlessSampling(engines[1].device!,textures));
    await take('alpha-normal-coat-emission');
    materials[1].coatNormalMap=undefined;materials[1].normalMap=undefined;materials[0].alphaMode='opaque';materials[2].emissionLuminance=0;
    const height=new Texture({width:1,height:1,data:new Uint8Array([96,96,96,255])});
    materials[0].displacementMap=height;materials[0].displacementScale=.05;
    await take('displacement');
    materials[0].displacementMap=undefined;materials[0].displacementScale=0;
    materials[3].map=undefined;
    await take('remove-texture');
    // Force independent resizing under a common pre-scaled input for comparison.
    for(const t of textures) t.image={width:1,height:1,data:new Uint8Array([64,128,192,255])};
    await take('one-texel-set');
    const fingerprint = engines[1].getDiagnostics()?.shaderCompilation?.modules[0].sourceFingerprint;
    for(let i=0;i<24;i++) meshes[0].materials.push(new OpenPBRMaterial({map:new Texture({width:1,height:1,data:new Uint8Array([20,40,80,255])})}));
    await take('metadata-capacity-growth');
    if(expectedActive==='bindless') check(engines[1].getDiagnostics()?.shaderCompilation?.modules[0].sourceFingerprint===fingerprint,'Texture-count growth rebuilt the bindless shader');
    const image=document.createElement('canvas');image.width=3;image.height=2;
    const ctx=image.getContext('2d')!;ctx.fillStyle='rgba(100,150,200,.4)';ctx.fillRect(0,0,3,2);
    textures[0].image=image;
    if(expectedActive==='bindless')sampling.push(await compareBindlessSampling(engines[1].device!,textures));
    await take('canvas-alpha');
    const second=new Render(engines[1],{maxSamples:2,bounces:3,bevel:false,directLightCandidates:2});
    await second.converge({samples:2,sampleSequenceOffset:17,timeoutMs:60000});
    await renders[1].converge({samples,sampleSequenceOffset:17,timeoutMs:60000});second.dispose();
    engines.forEach(e=>{e.scene={meshes:[],lights:[]};});
    await take('empty-scene');
    check(errors.length===0,'GPU errors: '+errors.join('\n'));
    check(engines[1].getDiagnostics()?.materialTextures?.active===expectedActive,'Unexpected texture binding mode');
    return {backend,results,sampling,errors,active:engines[1].getDiagnostics()?.materialTextures?.active};
  } finally {removeErrors.forEach(remove=>remove());engines.forEach(e=>e.dispose());}
}
