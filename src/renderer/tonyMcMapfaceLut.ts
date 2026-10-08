import { TONY_MC_MAPFACE_RGB9E5_BASE64 } from './tonyMcMapfaceLutData';

export const TONY_MC_MAPFACE_LUT_SIZE = 48;

export function createTonyMcMapfaceLut(device: GPUDevice) {
  const encoded = atob(TONY_MC_MAPFACE_RGB9E5_BASE64);
  const data = new Uint8Array(encoded.length);
  for (let index = 0; index < encoded.length; index++) {
    data[index] = encoded.charCodeAt(index);
  }
  const expectedBytes = TONY_MC_MAPFACE_LUT_SIZE ** 3 * 4;
  if (data.byteLength !== expectedBytes) {
    throw new Error(
      `Invalid Tony McMapface LUT: expected ${expectedBytes} bytes, got ${data.byteLength}`
    );
  }

  const texture = device.createTexture({
    label: 'Tony McMapface neutral LUT',
    size: [
      TONY_MC_MAPFACE_LUT_SIZE,
      TONY_MC_MAPFACE_LUT_SIZE,
      TONY_MC_MAPFACE_LUT_SIZE
    ],
    dimension: '3d',
    format: 'rgb9e5ufloat',
    usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING
  });
  device.queue.writeTexture(
    { texture },
    data,
    {
      bytesPerRow: TONY_MC_MAPFACE_LUT_SIZE * 4,
      rowsPerImage: TONY_MC_MAPFACE_LUT_SIZE
    },
    {
      width: TONY_MC_MAPFACE_LUT_SIZE,
      height: TONY_MC_MAPFACE_LUT_SIZE,
      depthOrArrayLayers: TONY_MC_MAPFACE_LUT_SIZE
    }
  );
  return texture;
}
