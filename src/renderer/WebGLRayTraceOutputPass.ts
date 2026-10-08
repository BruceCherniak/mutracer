import { constants, Renderer, Texture2D } from './webgl';
import normalizeRayTraceOutput from './glsl/normalizeRayTraceOutput.frag';
import { WebGLFullQuadPass } from './WebGLFullQuadPass';
import WebGLRayTracePass from './WebGLRayTracePass';

type RayTraceInput =
  | 'colorTex'
  | 'albedoTex'
  | 'normalTex'
  | 'shadowCatcherTex';
type RayTraceOutput = 'color' | 'albedo' | 'normal' | 'shadowCatcher';

/** Converts the additive ray tracing buffers into display/denoise textures. */
export class WebGLRayTraceOutputPass {
  private readonly _renderer: Renderer;
  private readonly _pass: WebGLFullQuadPass<RayTraceInput, RayTraceOutput>;

  constructor(renderer: Renderer) {
    this._renderer = renderer;
    this._pass = new WebGLFullQuadPass('rayTraceOutput', renderer, {
      shader: normalizeRayTraceOutput,
      outputs: ['color', 'albedo', 'normal', 'shadowCatcher'],
      outputParams: {
        color: {
          type: constants.HALF_FLOAT,
          minFilter: constants.LINEAR,
          magFilter: constants.LINEAR
        },
        albedo: { type: constants.UNSIGNED_BYTE },
        normal: { type: constants.UNSIGNED_BYTE },
        shadowCatcher: { type: constants.UNSIGNED_BYTE }
      }
    });
  }

  setSize(width: number, height: number) {
    this._pass.setSize(width, height);
  }

  setSampleCount(sampleCount: number) {
    this._pass.setUniform('sampleCount', Math.max(sampleCount, 1));
  }

  createPass(rayTracePass: WebGLRayTracePass) {
    this._pass.createPass(
      {
        colorTex: rayTracePass.getOutput('color'),
        albedoTex: rayTracePass.getOutput('albedo'),
        normalTex: rayTracePass.getOutput('normal'),
        shadowCatcherTex: rayTracePass.hasShadowCatcher()
          ? rayTracePass.getOutput('shadowCatcher')
          : this._renderer.emptyTexture
      },
      undefined,
      { clear: true }
    );
  }

  getOutput(label: RayTraceOutput): Texture2D {
    return this._pass.getOutput(label);
  }

  dispose() {
    this._pass.dispose();
  }
}

