import type Geometry from '../scene/Geometry.js';
import Texture, { isTextureDataSource } from '../scene/Texture.js';
import type { DisplacementTessellationStats } from './tessellateDisplacement.js';

export interface HeightPixels {
  data: Float32Array | Uint8Array | Uint8ClampedArray | Int32Array;
  width: number;
  height: number;
  channels: number;
  normalized: boolean;
}

const heightPixelCopies = new WeakMap<
  object,
  {
    version: number;
    image: Texture['image'];
    data: Float32Array | Uint8Array | Int32Array;
    width: number;
    height: number;
  }
>();

const tessellationStats = new WeakMap<Geometry, DisplacementTessellationStats>();

export function getDisplacementTessellationStats(geometry: Geometry) {
  return tessellationStats.get(geometry);
}

export function setDisplacementTessellationStats(
  geometry: Geometry,
  stats: DisplacementTessellationStats
) {
  tessellationStats.set(geometry, stats);
  return geometry;
}

export function getHeightPixels(texture: Texture): HeightPixels | undefined {
  const image = texture.image;
  if (!image.width || !image.height) return undefined;
  if (isTextureDataSource(image)) {
    const channels = Math.max(
      Math.floor(image.data.length / (image.width * image.height)),
      1
    );
    return {
      data: image.data,
      width: image.width,
      height: image.height,
      channels,
      normalized:
        image.data instanceof Uint8Array ||
        image.data instanceof Uint8ClampedArray
    };
  }
  if (typeof document === 'undefined') return undefined;
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext('2d');
  if (!context) return undefined;
  context.drawImage(image, 0, 0);
  return {
    data: context.getImageData(0, 0, canvas.width, canvas.height).data,
    width: canvas.width,
    height: canvas.height,
    channels: 4,
    normalized: true
  };
}

/** Returns cached CPU pixels suitable for a structured-clone worker message. */
export function copyDisplacementTextureData(texture: Texture) {
  const identity = texture.source ?? texture;
  const cached = heightPixelCopies.get(identity);
  if (
    cached &&
    cached.version === texture.version &&
    cached.image === texture.image
  ) {
    return cached;
  }
  const pixels = getHeightPixels(texture);
  if (!pixels) return undefined;
  const data = pixels.data instanceof Float32Array
    ? new Float32Array(pixels.data)
    : pixels.data instanceof Int32Array
      ? new Int32Array(pixels.data)
      : new Uint8Array(pixels.data);
  const copy = {
    version: texture.version,
    image: texture.image,
    data,
    width: pixels.width,
    height: pixels.height
  };
  heightPixelCopies.set(identity, copy);
  return copy;
}
