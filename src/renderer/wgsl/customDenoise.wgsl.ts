/** Linear HDR composition for the public custom filter, before display transforms. */
export const customDenoiseCompositionMain = /* wgsl */ `
var color = load_colorTex(uv, 0);
let coverage = clamp(load_albedoTex(uv, 0).a, 0.0, 1.0);
// Flat primary misses already contribute background radiance. Undo only
// the hit-count normalization; blank pixels are already per-sample averages.
if (flatBackgroundColor.a > 0.5 && coverage > 0.0) {
  color = vec4f(color.rgb * coverage, color.a);
}
if (shadowCatcherEnabled > 0.5) {
  let catcher = load_shadowCatcherTex(uv, 0);
  let catcherCoverage = clamp(catcher.r, 0.0, 1.0);
  let opacity = max(clamp(catcher.a / max(catcherCoverage, 0.000001), 0.0, 1.0) - (1.0 - shadowCatcherAlpha), 0.0);
  if (catcherCoverage > 0.0) {
    let foreground = load_foregroundTex(uv, 0);
    let background = load_catcherBackgroundTex(uv, 0);
    let backgroundRGB = select(background.rgb / max(background.a, 0.000001), flatBackgroundColor.rgb, flatBackgroundColor.a > 0.5);
    let shadowAlpha = catcherCoverage * opacity;
    let alpha = foreground.a + background.a * (1.0 - opacity) + shadowAlpha;
    let premultiplied = foreground.rgb * foreground.a
      + backgroundRGB * background.a * (1.0 - opacity)
      + shadowCatcherColor * shadowAlpha;
    color = vec4f(premultiplied / max(alpha, 0.000001), alpha);
  }
}
output.color = color;
`;

/** Custom output alpha is ignored; retain the input composition's coverage. */
export const customDenoiseCoverageMain = /* wgsl */ `
if (globalId.x >= u32(imageSize.x) || globalId.y >= u32(imageSize.y)) { return; }
let index = globalId.x + globalId.y * u32(imageSize.x);
out_color[index] = vec4f(in_filtered[index].rgb, in_original[index].a);
`;
