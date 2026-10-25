
struct AovResolvedAccumulation { geometry: vec4f, position: vec4f, diffuse: vec4f, specular: vec4f, }
struct AovResolvedCenter { identity: vec4u, motion: vec4f, }
@group(0) @binding(0) var<storage,read> accumulation: array<AovResolvedAccumulation>;
@group(0) @binding(1) var<storage,read> center: array<AovResolvedCenter>;
@group(0) @binding(2) var<storage,read_write> output: array<vec4u>;
@group(0) @binding(3) var<uniform> parameters: vec4u;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let width=parameters.x;let height=parameters.y;
  if(id.x>=width*height){return;}
  let x=id.x%width;let y=id.x/width;
  let source=x+select(y,height-1u-y,(parameters.w&256u)!=0u)*width;
  let kind=parameters.w&255u;
  if(kind==5u){output[id.x]=center[source].identity;return;}
  var value=vec4f(0.0);
  if(kind==6u){let motion=center[source].motion;value=vec4f(motion.xy,0.0,motion.w);}
  else{
    let pixel=accumulation[source];let hits=pixel.position.w;
    let scale=select(0.0,1.0/max(hits,1.0),hits>0.0);let coverage=hits/f32(max(parameters.z,1u));
    if(kind==0u){value=vec4f(pixel.geometry.x*scale,0.0,0.0,coverage);}
    else if(kind==1u){value=vec4f(pixel.position.xyz*scale,coverage);}
    else if(kind==2u){value=vec4f(pixel.geometry.yzw*scale,coverage);}
    else{let reflectance=select(pixel.diffuse,pixel.specular,kind==4u);
      let inv=select(0.0,1.0/max(reflectance.w,1.0),reflectance.w>0.0);
      value=vec4f(reflectance.xyz*inv,reflectance.w/f32(max(parameters.z,1u)));
    }
  }
  output[id.x]=bitcast<vec4u>(value);
}
