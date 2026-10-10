/** One mask plus a premultiplied primary background contribution per pixel. */
export const SHADOW_CATCHER_ACCUMULATION_BYTES = 32;

export default /* wgsl */ `
struct ShadowCatcherAccumulation {
  // Primary catcher coverage, background alpha, background hits, shadow opacity.
  mask: vec4f,
  background: vec4f,
}
`;
