import { constants, WebGLDevice, Texture2D } from './webgl.js';
import { WebGLFullQuadPass } from './WebGLFullQuadPass.js';
import {
  blendCompositeFragment,
  downsampleCompositeFragment,
  gaussianBlurCompositeFragment
} from './webglShaders.js';
import { brightFragment } from './glsl/webglPipeline.frag.js';

const COUNT = 5;
const outputParams = {
  color: {
    type: constants.HALF_FLOAT,
    minFilter: constants.LINEAR,
    magFilter: constants.LINEAR
  }
};

/** WebGL implementation of the same explicit bloom pass chain as WGPUBloomPass. */
export default class WebGLBloomPass {
  private readonly _brightPass: WebGLFullQuadPass<'colorTex', 'color'>;
  private readonly _downsamplePasses: WebGLFullQuadPass<'colorTex', 'color'>[] = [];
  private readonly _blurHPasses: WebGLFullQuadPass<'colorTex', 'color'>[] = [];
  private readonly _blurVPasses: WebGLFullQuadPass<'colorTex', 'color'>[] = [];
  private readonly _blendPasses: WebGLFullQuadPass<
    'colorTex1' | 'colorTex2',
    'color'
  >[] = [];

  constructor(renderer: WebGLDevice) {
    this._brightPass = new WebGLFullQuadPass('bloomBright', renderer, {
      shader: brightFragment,
      outputs: ['color'],
      outputParams
    });
    for (let i = 0; i <= COUNT; i++) {
      const downsample = new WebGLFullQuadPass<'colorTex', 'color'>(
        `bloomDownsample${i}`,
        renderer,
        { shader: downsampleCompositeFragment, outputs: ['color'], outputParams }
      );
      const blurH = new WebGLFullQuadPass<'colorTex', 'color'>(
        `bloomBlurH${i}`,
        renderer,
        { shader: gaussianBlurCompositeFragment, outputs: ['color'], outputParams }
      );
      const blurV = new WebGLFullQuadPass<'colorTex', 'color'>(
        `bloomBlurV${i}`,
        renderer,
        { shader: gaussianBlurCompositeFragment, outputs: ['color'], outputParams }
      );
      blurH.setUniform('blurDir', 0);
      blurV.setUniform('blurDir', 1);
      this._downsamplePasses.push(downsample);
      this._blurHPasses.push(blurH);
      this._blurVPasses.push(blurV);
      if (i > 0) {
        this._blendPasses.push(
          new WebGLFullQuadPass(`bloomBlend${i}`, renderer, {
            shader: blendCompositeFragment,
            outputs: ['color'],
            outputParams
          })
        );
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
    const weight = 1 - Math.max(Math.min(radius ** 0.3 * 0.8, 0.8), 0);
    this._blendPasses.forEach((pass) => {
      pass.setUniform('weight1', 1 - weight);
      pass.setUniform('weight2', weight);
    });
    const blurSize = Math.max(Math.min(radius * 2, 1), 0.2);
    [...this._blurHPasses, ...this._blurVPasses].forEach((pass) =>
      pass.setUniform('blurSize', blurSize)
    );
  }

  createPass(colorTex: Texture2D) {
    this._brightPass.createPass({ colorTex });
    for (let i = 0; i <= COUNT; i++) {
      this._downsamplePasses[i].createPass({
        colorTex:
          i === 0
            ? this._brightPass.getOutput('color')
            : this._downsamplePasses[i - 1].getOutput('color')
      });
    }
    for (let i = COUNT; i >= 0; i--) {
      this._blurHPasses[i].createPass({
        colorTex: this._downsamplePasses[i].getOutput('color')
      });
      this._blurVPasses[i].createPass({
        colorTex: this._blurHPasses[i].getOutput('color')
      });
    }
    for (let i = COUNT - 1; i >= 0; i--) {
      this._blendPasses[i].createPass({
        colorTex1:
          i === COUNT - 1
            ? this._blurVPasses[COUNT].getOutput('color')
            : this._blendPasses[i + 1].getOutput('color'),
        colorTex2: this._blurVPasses[i].getOutput('color')
      });
    }
  }

  getOutput() {
    return this._blendPasses[0].getOutput('color');
  }

  getMemoryBytes() {
    return [this._brightPass, ...this._downsamplePasses, ...this._blurHPasses, ...this._blurVPasses, ...this._blendPasses]
      .reduce((sum, pass) => sum + pass.getMemoryBytes(), 0);
  }

  dispose() {
    [
      this._brightPass,
      ...this._downsamplePasses,
      ...this._blurHPasses,
      ...this._blurVPasses,
      ...this._blendPasses
    ].forEach((pass) => pass.dispose());
  }
}
