import { WGPUFullQuadPass } from './WGPUFullQuadPass.js';

const COUNT = 5;

const linearSamplerDescriptor = {
  magFilter: 'linear',
  minFilter: 'linear'
} satisfies GPUSamplerDescriptor;

function createBrightPass(device: GPUDevice) {
  return new WGPUFullQuadPass('bright', device, {
    inputs: ['colorTex'],
    outputs: ['color'],
    uniforms: [
      {
        label: 'threshold',
        type: 'f32',
        data: 1
      },
      {
        label: 'scale',
        type: 'f32',
        data: 1
      }
    ],
    fsDefine: /*wgsl*/ `
fn median(a: vec4f, b: vec4f, c: vec4f) -> vec4f {
return a + b + c - min(min(a, b), c) - max(max(a, b), c);
}
`,
    fsMain: /*wgsl*/ `
${
  ''
  // Use median filter to reduce noise
  // https://github.com/keijiro/KinoBloom/blob/master/Assets/Kino/Bloom/Shader/Bloom.cginc#L96
}
let d = vec3i(1, 1, 0);

var texel = textureLoad(colorTex, uv, 0);
let s1 = textureLoad(colorTex, uv - d.xz, 0);
let s2 = textureLoad(colorTex, uv + d.xz, 0);
let s3 = textureLoad(colorTex, uv - d.zy, 0);
let s4 = textureLoad(colorTex, uv + d.zy, 0);
texel = median(median(texel, s1, s2), s3, s4);

// Premultiplied Alpha
let lum = dot(texel.rgb, vec3f(0.2125, 0.7154, 0.0721));
var color: vec4f;
if (lum > threshold && texel.a > 0.0) {
  color = vec4f(texel.rgb * scale, texel.a);
} else {
  // Bleed the alpha to avoid sharp edge when using alpha
  color = vec4f(vec3(0.0), texel.a);
}
output.color = color;
`
  });
}

function createDownsamplePass(device: GPUDevice) {
  return new WGPUFullQuadPass('downsample', device, {
    inputs: ['colorTex'],
    outputs: ['color'],
    uniforms: [],
    samplers: {
      linearSampler: device.createSampler(linearSamplerDescriptor)
    },
    fsDefine: /*wgsl*/ `
fn brightness(c: vec3f) -> f32 {
  return max(max(c.r, c.g), c.b);
}
`,
    fsMain: /*wgsl*/ `
let size = vec2f(textureDimensions(colorTex, 0));
let d = vec4f(-1.0, -1.0, 1.0, 1.0) / size.xyxy;
${
  ''
}
output.color = textureSample(colorTex, linearSampler, uv2 + d.xy) * 0.25
  + textureSample(colorTex, linearSampler, uv2 + d.zy) * 0.25
  + textureSample(colorTex, linearSampler, uv2 + d.xw) * 0.25
  + textureSample(colorTex, linearSampler, uv2 + d.zw) * 0.25;
`
  });
}

function createGaussianPass(device: GPUDevice) {
  return new WGPUFullQuadPass('gaussian', device, {
    inputs: ['colorTex'],
    outputs: ['color'],
    uniforms: [
      {
        label: 'direction',
        type: 'vec2f',
        data: [1, 0]
      },
      {
        label: 'size',
        type: 'f32',
        data: 1.0
      }
    ],
    samplers: {
      linearSampler: device.createSampler(linearSamplerDescriptor)
    },
    fsDefine: /*wgsl*/ `
const kernel = array<f32, 9>(0.07, 0.09, 0.12, 0.14, 0.16, 0.14, 0.12, 0.09, 0.07);
`,
    fsMain: /*wgsl*/ `
let texSize = vec2f(textureDimensions(colorTex, 0));
let off = direction / texSize * size;

var sum = vec4f(0.0);
var weightAll = 0.0;
for (var i = 0; i < 9; i++) {
  let w = kernel[i];
  sum += textureSample(colorTex, linearSampler, uv2 + off * f32(i - 4)) * w;
  weightAll += w;
}
output.color = sum / max(weightAll, 0.01);
`
  });
}

function createBlendPass(device: GPUDevice) {
  return new WGPUFullQuadPass('blend', device, {
    inputs: ['colorTex1', 'colorTex2'],
    outputs: ['color'],
    uniforms: [
      {
        label: 'weight',
        type: 'f32',
        data: 0.3
      }
    ],

    samplers: {
      linearSampler: device.createSampler(linearSamplerDescriptor)
    },
    fsMain: /*wgsl*/ `
let color1 = textureSample(colorTex1, linearSampler, uv2);
let color2 = textureSample(colorTex2, linearSampler, uv2);
output.color = mix(color1, color2, weight);
`
  });
}

class WGPUBloomPass {
  private _brightPass;
  private _downsamplePasses: ReturnType<typeof createDownsamplePass>[] = [];
  private _blurHPasses: ReturnType<typeof createGaussianPass>[] = [];
  private _blurVPasses: ReturnType<typeof createGaussianPass>[] = [];
  private _blendPasses: ReturnType<typeof createBlendPass>[] = [];

  constructor(device: GPUDevice) {
    this._brightPass = createBrightPass(device);
    const commonOutputParams = {
      color: {
        format: 'rgba16float'
      }
    } as const;
    this._brightPass.setOutputParams(commonOutputParams);
    for (let i = 0; i <= COUNT; i++) {
      const downsamplePass = createDownsamplePass(device);
      const blurHPass = createGaussianPass(device);
      const blurVPass = createGaussianPass(device);
      downsamplePass.setOutputParams(commonOutputParams);
      blurHPass.setOutputParams(commonOutputParams);
      blurVPass.setOutputParams(commonOutputParams);
      blurHPass.setUniform('direction', [1, 0]);
      blurVPass.setUniform('direction', [0, 1]);
      this._downsamplePasses.push(downsamplePass);
      this._blurHPasses.push(blurHPass);
      this._blurVPasses.push(blurVPass);
      if (i > 0) {
        const blendPass = createBlendPass(device);
        blendPass.setOutputParams(commonOutputParams);
        this._blendPasses.push(blendPass);
      }
    }
  }

  setSize(width: number, height: number) {
    this._brightPass.setSize(width, height);
    for (let i = 0; i <= COUNT; i++) {
      this._downsamplePasses[i].setSize(width >> (i + 1), height >> (i + 1));
      this._blurHPasses[i].setSize(width >> (i + 1), height >> (i + 1));
      this._blurVPasses[i].setSize(width >> i, height >> i);
      if (i > 0) {
        this._blendPasses[i - 1].setSize(width >> (i - 1), height >> (i - 1));
      }
    }
  }

  setBrightThreshold(threshold: number) {
    this._brightPass.setUniform('threshold', threshold);
  }

  setRadius(radius: number) {
    this._blendPasses.forEach((blendPass) => {
      blendPass.setUniform(
        'weight',
        // Use weight to control radius
        1 - Math.max(Math.min(radius ** 0.3 * 0.8, 0.8), 0)
      );
    });
    [...this._blurHPasses, ...this._blurVPasses].forEach((blurPass) => {
      //Some magic fomular
      blurPass.setUniform('size', Math.max(Math.min(radius * 2, 1.0), 0.2));
    });
  }

  createPass(encoder: GPUCommandEncoder, colorTex: GPUTexture) {
    const brightPass = this._brightPass;
    const downSamplePasses = this._downsamplePasses;
    const blendPasses = this._blendPasses;
    const blurHPasses = this._blurHPasses;
    const blurVPasses = this._blurVPasses;
    brightPass.createPass(encoder, { colorTex });
    // Downsample
    for (let i = 0; i <= COUNT; i++) {
      const colorTex1 = (
        i === 0 ? brightPass : downSamplePasses[i - 1]
      ).getOutput('color');
      downSamplePasses[i].createPass(encoder, { colorTex: colorTex1 });
    }

    // Upsample with gaussian and blending
    for (let i = COUNT; i >= 0; i--) {
      // Blur
      blurHPasses[i].createPass(encoder, {
        colorTex: downSamplePasses[i].getOutput('color')
      });
      blurVPasses[i].createPass(encoder, {
        colorTex: blurHPasses[i].getOutput('color')
      });
    }
    for (let i = COUNT - 1; i >= 0; i--) {
      blendPasses[i].createPass(encoder, {
        colorTex1: (i === COUNT - 1
          ? blurVPasses[COUNT]
          : blendPasses[i + 1]
        ).getOutput('color'),
        colorTex2: blurVPasses[i].getOutput('color')
      });
    }

    return blendPasses[0].getOutput('color');
  }

  getMemoryBytes() {
    return [this._brightPass, ...this._downsamplePasses, ...this._blurHPasses, ...this._blurVPasses, ...this._blendPasses]
      .reduce((sum, pass) => sum + pass.getMemoryBytes(), 0);
  }

  dispose() {
    this._brightPass.dispose();
    [...this._downsamplePasses, ...this._blurHPasses, ...this._blurVPasses, ...this._blendPasses].forEach(pass => pass.dispose());
  }

  getOutput() {
    return this._blendPasses[0].getOutput('color');
  }
}

export default WGPUBloomPass;
