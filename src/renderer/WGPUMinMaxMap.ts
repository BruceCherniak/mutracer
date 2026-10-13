import { WGPUFullQuadPass } from './WGPUFullQuadPass.js';

class WGPUMinMaxMap {
  private _pass;
  private _device: GPUDevice;

  constructor(device: GPUDevice) {
    this._device = device;

    this._pass = new WGPUFullQuadPass('minmax', device, {
      inputs: ['in_minmax'],
      outputs: ['out_minmax'],
      uniforms: [
        {
          label: 'lod',
          data: [0],
          type: 'i32'
        }
      ],
      fsMain: /*wgsl*/ `
let pUv = select(uv, uv * 2, lod > 0);
let h0 = load_in_minmax(pUv, 0).rg;
let h1 = load_in_minmax(pUv + vec2i(1, 0), 0).rg;
let h2 = load_in_minmax(pUv + vec2i(0, 1), 0).rg;
let h3 = load_in_minmax(pUv + vec2i(1, 1), 0).rg;
var minmax = vec2f(min(min(h0.x, h1.x), min(h2.x, h3.x)), max(max(h0.y, h1.y), max(h2.y, h3.y)));


output.out_minmax = vec4f(minmax, 0.0, 1.0);
`
    });

    this._pass.setOutputParams({
      out_minmax: {
        format: 'rg8unorm'
      }
    });
  }

  dispose() {
    this._pass.dispose();
  }

  /**
   * Create a minmax mipmap from an height map image.
   * Note: The image will be resized to the nearest power of two.
   * Note: The image needs to be grayscale.
   */
  createMinmaxMipmap(
    targetTexture: GPUTexture,
    image: HTMLImageElement | HTMLCanvasElement | ImageBitmap | OffscreenCanvas,
    flipY: boolean,
    textureIndex: number
  ) {
    const device = this._device;

    const w = image.width;

    const mipmaps: GPUTexture[] = [];
    const level = Math.log2(w);

    const heightMap = device.createTexture({
      size: {
        width: w,
        height: w
      },
      format: 'rg8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.RENDER_ATTACHMENT
    });

    device.queue.copyExternalImageToTexture(
      { source: image, flipY },
      { texture: heightMap },
      { width: w, height: w }
    );

    let mipmapSize = w;
    for (let i = 0; i <= level; i++) {
      const encoder = device.createCommandEncoder();
      const mipmap = device.createTexture({
        size: {
          width: mipmapSize,
          height: mipmapSize
        },
        format: 'rg8unorm',
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_SRC |
          GPUTextureUsage.RENDER_ATTACHMENT
      });
      this._pass.setUniform('lod', [i]);
      this._pass.createPass(
        encoder,
        {
          in_minmax: i === 0 ? heightMap : mipmaps[i - 1]
        },
        {
          out_minmax: mipmap
        }
      );
      device.queue.submit([encoder.finish()]);
      mipmaps[i] = mipmap;

      mipmapSize /= 2;
    }

    const encoder = device.createCommandEncoder();
    // Copy the mipmaps to the final texture
    for (let i = 0; i < mipmaps.length; i++) {
      encoder.copyTextureToTexture(
        { texture: mipmaps[i] },
        { texture: targetTexture, origin: [0, 0, textureIndex], mipLevel: i },
        { width: w >> i, height: w >> i }
      );
    }
    device.queue.submit([encoder.finish()]);

    // Destroy the mipmaps
    mipmaps.forEach((mipmap) => {
      mipmap.destroy();
    });
    heightMap.destroy();

  }
}

export default WGPUMinMaxMap;
