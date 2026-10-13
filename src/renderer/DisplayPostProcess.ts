import type { PostProcess, PostProcessContext } from '../Display.js';
import {textureBytes} from './gpuMemory.js';

/** Target-owned ping-pong images. A failed chain never replaces the composed image. */
export class DisplayPostProcess {
  private textures: GPUTexture[] = [];
  private image?: GPUTexture;
  constructor(private readonly device: GPUDevice) {}
  get output() { return this.image; }
  reset() { this.image = undefined; }
  getMemoryBytes() { return this.textures.reduce((sum, texture) => sum + textureBytes(texture), 0); }
  private retire(textures: GPUTexture[]) {
    if (!textures.length) return;
    void this.device.queue.onSubmittedWorkDone().catch(() => {}).then(() => textures.forEach(texture => texture.destroy()));
  }
  dispose() { this.reset(); this.retire(this.textures); this.textures = []; }
  run(input: GPUTexture, passes: readonly PostProcess[], render: PostProcessContext['render']) {
    this.reset();
    if (!passes.length) return;
    if (this.textures.length === 0 || this.textures[0].width !== input.width || this.textures[0].height !== input.height || this.textures[0].format !== input.format) {
      this.retire(this.textures);
      this.textures = Array.from({length: 2}, (_, index) => this.device.createTexture({
        label: `Display post-process ${index}`, size: {width: input.width, height: input.height}, format: input.format,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST
      }));
    }
    const encoder = this.device.createCommandEncoder();
    let previous = input;
    for (let index = 0; index < passes.length; index++) {
      const output = this.textures[index % 2];
      passes[index]({device: this.device, encoder, input: previous, output, width: input.width, height: input.height, render});
      previous = output;
    }
    this.device.queue.submit([encoder.finish()]);
    this.image = previous;
  }
}
