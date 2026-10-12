import {FrameBuffer, Texture2D, type WebGLDevice} from './webgl.js';
/** Shared read/copy framebuffers; retained images belong to the individual render. */
export class WebGLScratchCopy {
  readonly readFrameBuffer = new FrameBuffer();
  private readonly drawFrameBuffer = new FrameBuffer();
  constructor(private readonly renderer: WebGLDevice) {}
  copy(source: Texture2D, width: number, height: number, target?: Texture2D) {
    target ??= new Texture2D({type: source.storageType});
    const gl = this.renderer.gl;
    target.ensureStorage(gl, width, height, {type: source.storageType});
    this.readFrameBuffer.bind(this.renderer, [source], gl.READ_FRAMEBUFFER);
    this.drawFrameBuffer.bind(this.renderer, [target], gl.DRAW_FRAMEBUFFER);
    if (source.width < width || source.height < height) {gl.disable(gl.SCISSOR_TEST); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);}
    const copyWidth = Math.min(width, source.width), copyHeight = Math.min(height, source.height);
    gl.blitFramebuffer(0, 0, copyWidth, copyHeight, 0, 0, copyWidth, copyHeight, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    return target;
  }
  dispose() {this.readFrameBuffer.dispose(this.renderer); this.drawFrameBuffer.dispose(this.renderer);}
}
