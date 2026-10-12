import {textureBytes} from './gpuMemory.js';
import {setTextureRegion} from './textureRegion.js';
/** One shared conversion texture, retaining its largest allocated capacity. */
export class WGPUScratchTexture {
  private texture?: GPUTexture;
  constructor(private readonly device: GPUDevice) {}
  get(width: number, height: number) {
    if (!this.texture || width > this.texture.width || height > this.texture.height) {
      width = Math.max(width, this.texture?.width ?? 0); height = Math.max(height, this.texture?.height ?? 0);
      const previous = this.texture;
      this.texture = this.device.createTexture({label: 'Shared denoised conversion', size: {width, height}, format: 'rgba32float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC});
      if (previous) void this.device.queue.onSubmittedWorkDone().catch(() => {}).then(() => previous.destroy());
    }
    return this.texture;
  }
  setRegion(width: number, height: number) {if (this.texture) setTextureRegion(this.texture, width, height);}
  getMemoryBytes() {return textureBytes(this.texture);}
  dispose() {this.texture?.destroy();}
}
