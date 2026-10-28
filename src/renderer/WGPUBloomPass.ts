import {BLOOM_PLAN, BLOOM_LEVELS, bloomBlurSize, bloomBlendWeight, bloomBrightDefine, bloomBrightMain, bloomDownDefine, bloomDownMain, bloomBlurDefine, bloomBlurMain, bloomBlendMain} from './wgsl/bloom.wgsl.js';
import { WGPUFullQuadPass } from './WGPUFullQuadPass.js';

const COUNT = BLOOM_LEVELS - 1;

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
    fsDefine: bloomBrightDefine,
    fsMain: bloomBrightMain
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
    fsDefine: bloomDownDefine,
    fsMain: bloomDownMain
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
    fsDefine: bloomBlurDefine,
    fsMain: bloomBlurMain
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
    fsMain: bloomBlendMain
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

  reserveCapacity() {
    [this._brightPass, ...this._downsamplePasses, ...this._blurHPasses, ...this._blurVPasses, ...this._blendPasses].forEach(pass => pass.reserveCapacity());
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
        bloomBlendWeight(radius)
      );
    });
    [...this._blurHPasses, ...this._blurVPasses].forEach((blurPass) => {
      //Some magic fomular
      blurPass.setUniform('size', bloomBlurSize(radius));
    });
  }

  createPass(encoder: GPUCommandEncoder, colorTex: GPUTexture) {
    const passes = [this._brightPass, ...this._downsamplePasses, ...this._blurHPasses,
      ...this._blurVPasses, ...this._blendPasses];
    const source = (slot: number) => slot === passes.length ? colorTex : passes[slot].getOutput('color');
    for (const [, a, b, target] of BLOOM_PLAN) {
      passes[target].createPass(encoder,
        {colorTex: source(a), colorTex1: source(a), colorTex2: source(b)});
    }
    return this._blendPasses[0].getOutput('color');
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
