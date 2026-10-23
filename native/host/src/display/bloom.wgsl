// WGPUBloomPass.ts: six half-float levels, median bright pass, 9-tap Gaussian,
// independent horizontal/vertical blurs, then five coarse-to-fine blends.
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var second: texture_2d<f32>;
@group(0) @binding(2) var output: texture_storage_2d<rgba16float, write>;
struct Params { values: vec4f, direction: vec4f }
@group(0) @binding(3) var<uniform> params: Params;
fn load(pixel: vec2i) -> vec4f { return textureLoad(source, clamp(pixel, vec2i(0), vec2i(textureDimensions(source))-1), 0); }
fn sample0(uv: vec2f) -> vec4f {
  let p = uv * vec2f(textureDimensions(source)) - 0.5;
  let i = vec2i(floor(p)); let w = fract(p);
  return mix(mix(load(i),load(i+vec2i(1,0)),w.x),mix(load(i+vec2i(0,1)),load(i+vec2i(1,1)),w.x),w.y);
}
fn load1(pixel: vec2i) -> vec4f { return textureLoad(second, clamp(pixel, vec2i(0), vec2i(textureDimensions(second))-1), 0); }
fn sample1(uv: vec2f) -> vec4f {
  let p = uv * vec2f(textureDimensions(second)) - 0.5;
  let i = vec2i(floor(p)); let w = fract(p);
  return mix(mix(load1(i),load1(i+vec2i(1,0)),w.x),mix(load1(i+vec2i(0,1)),load1(i+vec2i(1,1)),w.x),w.y);
}
fn median(a: vec4f,b: vec4f,c: vec4f)->vec4f { return a+b+c-min(min(a,b),c)-max(max(a,b),c); }
@compute @workgroup_size(8,8)
fn bright(@builtin(global_invocation_id) id:vec3u) {
  if(any(id.xy>=textureDimensions(output))){return;}
  let p=vec2i(id.xy);
  let texel=median(median(load(p),load(p-vec2i(1,0)),load(p+vec2i(1,0))),load(p-vec2i(0,1)),load(p+vec2i(0,1)));
  let enabled=dot(texel.rgb,vec3f(0.2125,0.7154,0.0721))>params.values.x && texel.a>0.0;
  textureStore(output,id.xy,vec4f(select(vec3f(0.0),texel.rgb,enabled),texel.a));
}
@compute @workgroup_size(8,8)
fn down(@builtin(global_invocation_id) id:vec3u) {
  if(any(id.xy>=textureDimensions(output))){return;}
  let uv=(vec2f(id.xy)+0.5)/vec2f(textureDimensions(output));
  let d=1.0/vec2f(textureDimensions(source));
  textureStore(output,id.xy,(sample0(uv-d)+sample0(uv+vec2f(d.x,-d.y))+sample0(uv+vec2f(-d.x,d.y))+sample0(uv+d))*0.25);
}
const kernel=array<f32,9>(0.07,0.09,0.12,0.14,0.16,0.14,0.12,0.09,0.07);
@compute @workgroup_size(8,8)
fn blur(@builtin(global_invocation_id) id:vec3u) {
  if(any(id.xy>=textureDimensions(output))){return;}
  let uv=(vec2f(id.xy)+0.5)/vec2f(textureDimensions(output));
  let off=params.direction.xy/vec2f(textureDimensions(source))*params.values.y;
  var sum=vec4f(0.0);var weight=0.0;
  for(var i=0;i<9;i++){sum+=sample0(uv+off*f32(i-4))*kernel[i];weight+=kernel[i];}
  textureStore(output,id.xy,sum/max(weight,0.01));
}
@compute @workgroup_size(8,8)
fn blend(@builtin(global_invocation_id) id:vec3u) {
  if(any(id.xy>=textureDimensions(output))){return;}
  let uv=(vec2f(id.xy)+0.5)/vec2f(textureDimensions(output));
  textureStore(output,id.xy,mix(sample0(uv),sample1(uv),params.values.z));
}
