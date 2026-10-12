/** Logical image region of a reusable, larger physical scratch texture. */
const regions = new WeakMap<object, {width: number; height: number}>();
export function setTextureRegion(texture: object, width: number, height: number) {
  regions.set(texture, {width, height});
}
export function textureRegion(texture: {width: number; height: number}) {
  return regions.get(texture) ?? {width: texture.width, height: texture.height};
}
