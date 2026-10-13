/** Apply a filtered beauty correction to HDR layers; all display composition stays in composeMain. */
export const customDenoiseLayersMain = /* wgsl */ `
let original = load_originalTex(uv, 0).rgb;
let filtered = load_filteredTex(uv, 0).rgb;
let foreground = load_foregroundTex(uv, 0);
let background = load_backgroundTex(uv, 0);
// Keep an identity filter exact, including zero channels and coverage.
var filteredForeground = foreground;
var filteredBackground = background;
if (any(filtered != original)) {
  let usable = abs(original) > vec3f(0.000001);
  let denominator = select(vec3f(1.0), original, usable);
  let scale = select(vec3f(1.0), filtered / denominator, usable);
  let residual = select(filtered - original, vec3f(0.0), usable);
  filteredForeground = vec4f(foreground.rgb * scale + residual, foreground.a);
  // The catcher background layer stores premultiplied radiance.
  filteredBackground = vec4f(background.rgb * scale + residual * background.a, background.a);
}
output.foreground = filteredForeground;
output.background = filteredBackground;
`;

/** Custom output alpha is ignored; retain the input composition's coverage. */
export const customDenoiseCoverageMain = /* wgsl */ `
if (globalId.x >= u32(imageSize.x) || globalId.y >= u32(imageSize.y)) { return; }
let index = globalId.x + globalId.y * u32(imageSize.x);
out_color[index] = vec4f(in_filtered[index].rgb, in_original[index].a);
`;
