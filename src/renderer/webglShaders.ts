import { FragmentShader, glsl, Shader } from './shader.js';

export const blendCompositeFragment = new FragmentShader({
  name: 'blend',
  uniforms: {
    colorTex1: Shader.uniform('sampler2D'),
    colorTex2: Shader.uniform('sampler2D'),
    weight1: Shader.uniform('float', 0.5),
    weight2: Shader.uniform('float', 0.5)
  },
  main: glsl`void main() {
    out_color = texture(colorTex1, v_Texcoord) * weight1
      + texture(colorTex2, v_Texcoord) * weight2;
  }`
});

export const downsampleCompositeFragment = new FragmentShader({
  name: 'downsample',
  uniforms: { colorTex: Shader.uniform('sampler2D') },
  main: glsl`void main() {
    vec2 d = 1.0 / vec2(textureSize(colorTex, 0));
    out_color = (texture(colorTex, v_Texcoord + d * vec2(-0.5, -0.5))
      + texture(colorTex, v_Texcoord + d * vec2(0.5, -0.5))
      + texture(colorTex, v_Texcoord + d * vec2(-0.5, 0.5))
      + texture(colorTex, v_Texcoord + d * vec2(0.5, 0.5))) * 0.25;
  }`
});

export const gaussianBlurCompositeFragment = new FragmentShader({
  name: 'gaussianBlur',
  uniforms: {
    colorTex: Shader.uniform('sampler2D'),
    blurDir: Shader.uniform('int', 0),
    blurSize: Shader.uniform('float', 1)
  },
  main: glsl`void main() {
    vec2 size = vec2(textureSize(colorTex, 0));
    vec2 d = (blurDir == 0 ? vec2(1.0, 0.0) : vec2(0.0, 1.0)) * blurSize / size;
    out_color = texture(colorTex, v_Texcoord) * 0.227027
      + (texture(colorTex, v_Texcoord + d * 1.384615) + texture(colorTex, v_Texcoord - d * 1.384615)) * 0.316216
      + (texture(colorTex, v_Texcoord + d * 3.230769) + texture(colorTex, v_Texcoord - d * 3.230769)) * 0.070270;
  }`
});
