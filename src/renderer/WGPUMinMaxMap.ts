import { WGPUFullQuadPass } from './WGPUFullQuadPass';
// import { numMipLevels, generateMipmap } from 'webgpu-utils';

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
// TODO sampler needed?
let pUv = select(uv, uv * 2, lod > 0);
let h0 = textureLoad(in_minmax, pUv, 0).rg;
let h1 = textureLoad(in_minmax, pUv + vec2i(1, 0), 0).rg;
let h2 = textureLoad(in_minmax, pUv + vec2i(0, 1), 0).rg;
let h3 = textureLoad(in_minmax, pUv + vec2i(1, 1), 0).rg;
var minmax = vec2f(min(min(h0.x, h1.x), min(h2.x, h3.x)), max(max(h0.y, h1.y), max(h2.y, h3.y)));

// if (lod == 0 || minmax.x == minmax.y) {
//   minmax.x = max(minmax.x - 0.01, 0.0);
//   minmax.y = min(minmax.y + 0.01, 1.0);
// }

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
    image: HTMLImageElement | HTMLCanvasElement,
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
      // mipLevelCount: numMipLevels({ width: w, height: w }),
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.RENDER_ATTACHMENT
    });
    // generateMipmap(device, heightMap);

    device.queue.copyExternalImageToTexture(
      { source: image, flipY },
      { texture: heightMap },
      { width: w, height: w }
    );

    let mipmapSize = w;
    for (let i = 0; i <= level; i++) {
      // console.log(i, mipmapSize);
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
    // TODO reuse?
    mipmaps.forEach((mipmap) => {
      mipmap.destroy();
    });
    heightMap.destroy();

    // Read pixels and print for every level
    // for (let i = 0; i <= level; i++) {
    //   const size = w >> i;
    //   const bytesPerPixel = 2;
    //   // Round up bytesPerRow to nearest multiple of 256
    //   const bytesPerRow = Math.ceil((size * bytesPerPixel) / 256) * 256;
    //   const readbackBuffer = device.createBuffer({
    //     size: bytesPerRow * size,
    //     usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    //   });

    //   const copyEncoder = device.createCommandEncoder();
    //   copyEncoder.copyTextureToBuffer(
    //     { texture: targetTexture, mipLevel: i, origin: [0, 0, textureIndex] },
    //     {
    //       buffer: readbackBuffer,
    //       bytesPerRow
    //     },
    //     { width: size, height: size }
    //   );
    //   device.queue.submit([copyEncoder.finish()]);

    //   readbackBuffer.mapAsync(GPUMapMode.READ).then((res) => {
    //     const data = new Uint8Array(readbackBuffer.getMappedRange());
    //     // console.log(data);
    //     let data2 = new Uint8Array(size * size * 2);
    //     let w = bytesPerRow / bytesPerPixel;
    //     for (let y = 0; y < size; y++) {
    //       for (let x = 0; x < w; x++) {
    //         const i = (y * w + x) * bytesPerPixel;
    //         data2[(y * size + x) * 2] = data[i];
    //         data2[(y * size + x) * 2 + 1] = data[i + 1];
    //       }
    //     }
    //     console.log(size, data2);
    //     readbackBuffer.unmap();
    //     readbackBuffer.destroy();
    //   });
    // }
  }
}

export default WGPUMinMaxMap;
