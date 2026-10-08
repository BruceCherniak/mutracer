import { FragmentShader, ShaderDefineValue } from './shader';
import {
  FrameBuffer,
  Renderer,
  Texture2D,
  TextureOptions,
  WebGLProgramBindings
} from './webgl';

export interface WebGLFullQuadPassOutput extends TextureOptions {}

export interface WebGLPassOptions {
  clear?: boolean;
  blend?: boolean;
  viewport?: { x: number; y: number; width: number; height: number };
  scissor?: { x: number; y: number; width: number; height: number };
}

/**
 * Explicit WebGL 2.0 render pass matching the lifecycle of WGPUFullQuadPass.
 * It owns its output textures and framebuffer; there is no render graph.
 */
export class WebGLFullQuadPass<I extends string, O extends string> {
  private readonly _renderer: Renderer;
  private readonly _bindings: WebGLProgramBindings;
  private readonly _outputs: O[];
  private readonly _frameBuffer = new FrameBuffer();
  private readonly _outputTextures = {} as Record<O, Texture2D>;
  private _outputParams = {} as Record<O, WebGLFullQuadPassOutput>;
  private _width = 1;
  private _height = 1;
  private _renderToScreen = false;

  constructor(
    _label: string,
    renderer: Renderer,
    options: {
      shader: FragmentShader;
      outputs?: O[];
      outputParams?: Partial<Record<O, WebGLFullQuadPassOutput>>;
    }
  ) {
    this._renderer = renderer;
    this._bindings = new WebGLProgramBindings(options.shader);
    this._outputs = options.outputs || (options.shader.outputs as O[]);
    this.setOutputParams(
      Object.fromEntries(
        this._outputs.map((name) => [
          name,
          options.outputParams?.[name] || {}
        ])
      ) as Record<O, WebGLFullQuadPassOutput>
    );
  }

  setSize(width: number, height: number) {
    if (this._width === width && this._height === height) return;
    this._width = Math.max(1, width);
    this._height = Math.max(1, height);
    this.setUniform('viewportSize', [this._width, this._height]);
  }

  setOutputParams(params: Record<O, WebGLFullQuadPassOutput>) {
    this._outputParams = params;
  }

  setRenderToScreen(renderToScreen = true) {
    this._renderToScreen = renderToScreen;
  }

  setUniform(label: string, data: unknown) {
    return this._bindings.set(label, data);
  }

  setUniforms(values: Record<string, unknown>) {
    this._bindings.setUniforms(values);
  }

  getUniform(label: string) {
    return this._bindings.get(label);
  }

  setDefines(
    defines: Record<
      string,
      ShaderDefineValue | undefined
    >
  ) {
    let changed = false;
    for (const [name, value] of Object.entries(defines)) {
      const oldValue = this._bindings.defines[name];
      if (!value) {
        if (name in this._bindings.defines) {
          this._bindings.deleteDefine(name);
          changed = true;
        }
      } else if (oldValue !== value) {
        this._bindings.setDefine(name, value);
        changed = true;
      }
    }
    return changed;
  }

  getOutput(name: O) {
    return this._outputTextures[name];
  }

  private _prepareOutputs(explicitOutputs?: Partial<Record<O, Texture2D>>) {
    const gl = this._renderer.gl;
    for (const name of this._outputs) {
      const explicit = explicitOutputs?.[name];
      const texture =
        explicit ||
        this._outputTextures[name] ||
        new Texture2D(this._outputParams[name]);
      texture.ensureStorage(
        gl,
        this._width,
        this._height,
        this._outputParams[name]
      );
      this._outputTextures[name] = texture;
    }
  }

  createPass(
    inputs: Record<I, Texture2D>,
    explicitOutputs?: Partial<Record<O, Texture2D>>,
    options: WebGLPassOptions = {}
  ) {
    const renderer = this._renderer;
    const gl = renderer.gl;

    if (this._renderToScreen) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    } else {
      this._prepareOutputs(explicitOutputs);
      this._frameBuffer.bind(
        renderer,
        this._outputs.map((name) => this._outputTextures[name])
      );
    }

    const viewport = options.viewport || {
      x: 0,
      y: 0,
      width: this._width,
      height: this._height
    };
    renderer.setViewport(
      viewport.x,
      viewport.y,
      viewport.width,
      viewport.height
    );

    // Clear the full accumulation target before enabling the tile scissor.
    // Otherwise every tile outside the first one retains stale camera data.
    if (options.clear) {
      gl.disable(gl.SCISSOR_TEST);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }

    if (options.scissor) {
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(
        options.scissor.x,
        options.scissor.y,
        options.scissor.width,
        options.scissor.height
      );
    } else {
      gl.disable(gl.SCISSOR_TEST);
    }

    this._bindings.setUniforms(inputs);
    this._bindings.bind(renderer);
    gl.disable(gl.DEPTH_TEST);
    if (options.blend) {
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ONE);
    } else {
      gl.disable(gl.BLEND);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.SCISSOR_TEST);
  }

  dispose() {
    const gl = this._renderer.gl;
    (Object.values(this._outputTextures) as Texture2D[]).forEach((texture) =>
      texture.dispose(gl)
    );
    this._frameBuffer.dispose(this._renderer);
  }
}
