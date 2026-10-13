# Materials

`OpenPBRMaterial` implements the
[OpenPBR 1.1](https://academysoftwarefoundation.github.io/OpenPBR/) surface.
Property names are camel-case spellings of the OpenPBR inputs. Colors are
linear RGB. Pass optional properties to `new OpenPBRMaterial(params)`; omitted
properties use the defaults below and in TSDoc.

```ts
import { OpenPBRMaterial } from '@meimu/mutracer';

const glass = new OpenPBRMaterial();
glass.transmissionWeight = 1;
glass.specularRoughness = 0;
glass.transmissionColor = [0.72, 0.9, 1];
glass.transmissionDepth = 0.5;

const gold = new OpenPBRMaterial({
  baseColor: [1.0, 0.78, 0.34],
  baseMetalness: 1,
  specularRoughness: 0.2
});
```

After editing a material that is already rendering, call `material.markUpdated()`
(see [scene updates](./updates.md#materials-textures-and-lights) for costs):

```ts
gold.specularRoughness = 0.4;
gold.baseColor[1] = 0.7;
gold.markUpdated();
```

Materials occupy GPU slots by object identity: share one material object to
share its slot. Separate objects with equal values take separate slots, but
the textures they reference still share atlas space.

## Inputs

| Layer | Inputs (default) |
| --- | --- |
| Base | `baseWeight` (1), `baseColor` (0.8), `baseDiffuseRoughness` (0), `baseMetalness` (0) |
| Specular | `specularWeight` (1), `specularColor` (1), `specularRoughness` (0.3), `specularIor` (1.5), `specularAnisotropy` (0) |
| Transmission | `transmissionWeight` (0), `transmissionColor` (1), `transmissionDepth` (0), `transmissionScatter` (0), `transmissionScatterAnisotropy` (0), `transmissionDispersionScale` (0), `transmissionDispersionAbbeNumber` (20) |
| Subsurface | `subsurfaceWeight` (0), `subsurfaceColor` (0.8), `subsurfaceRadius` (1), `subsurfaceRadiusScale` ([1, 0.5, 0.25]), `subsurfaceAnisotropy` (0) |
| Fuzz | `fuzzWeight` (0), `fuzzColor` (1), `fuzzRoughness` (0.5) |
| Coat | `coatWeight` (0), `coatColor` (1), `coatRoughness` (0), `coatAnisotropy` (0), `coatIor` (1.6), `coatDarkening` (1) |
| Thin film | `thinFilmWeight` (0), `thinFilmThickness` (0.5 µm), `thinFilmIor` (1.4) |
| Emission | `emissionColor` (1), `emissionLuminance` (0) |
| Geometry | `opacity` (1), `thinWalled` (false), `doubleSided` (false) |

Units: `transmissionDepth` and `subsurfaceRadius` are in scene units;
`thinFilmThickness` is in micrometres (`0.45` = 450 nm).

`baseWeight` scales diffuse reflection and the metallic normal-incidence color
(`baseWeight * baseColor`). Dielectric specular, transmission and subsurface
retain their own strengths. For metals, `specularColor` tints the F82 Fresnel
curve near grazing angles and `specularWeight` scales the entire reflection,
including thin-film reflection. At their default values, F82 reduces to Schlick.

`specularAnisotropy` and `coatAnisotropy` use the OpenPBR GGX mapping:
`alphaT = roughness² * sqrt(2 / (1 + (1 - anisotropy)²))` and
`alphaB = (1 - anisotropy) * alphaT`, with the renderer's minimum alpha.
Both layers use the geometry tangent; a separate coat tangent is not available.
A rough coat broadens the underlying metal, dielectric reflection and transmission
using `mix(rB, min(1, rB^4 + 2*rC^4)^0.25, coatWeight)` before the GGX mapping.

`coatColor` is the squared transmittance at normal incidence. Each passage
through the coat applies `sqrt(coatColor)` raised to the inverse refracted
cosine. Coat reflection stays uncolored; reflection from the base crosses the
coat twice, and transmission crosses it once. `coatDarkening` controls the
extra darkening from internal reflections, while absorption remains active at
zero. The base is attenuated by the coat directional albedo on the view side
and by an internal-reflection factor estimated from the base slab albedos.
Partial coat coverage is mixed independently for each passage.
Emission uses a normal-incidence single passage: it is multiplied by
`mix(1, sqrt(coatColor), coatWeight)`. The same attenuated emission determines
emissive-light selection and hit MIS weights. This approximation has no angular
dependence and does not apply coat darkening or fuzz attenuation to emission.
Unlit and shadow-catching materials keep their existing emission behavior.

The base reflection beneath a coat uses the surrounding IOR
`mix(1, coatIor, coatWeight)`. `specularWeight` adjusts the base IOR relative
to that medium; refraction uses the resulting absolute base IOR relative to air.
Solid back-face exits ignore the coat IOR; thin walls use the exterior rule
on either side. Reflection inverts a coat-to-base ratio below one when the
base IOR is at least one, avoiding false total internal reflection caused by
the approximate coat model. Dispersion adjusts the base IOR before these rules.

`fuzzColor` colors the fuzz reflection only. Fuzz attenuates the underlying
material using its white directional albedo, so colored fuzz does not tint
the substrate through the attenuation term.

**Interior media.** Transmission describes a homogeneous volume:
`transmissionColor` is the color that survives one `transmissionDepth`, and
`transmissionScatter` is the scattering albedo. With `transmissionDepth = 0`
the tint is applied at the surface. Subsurface is a separate layer driven by its
color and per-channel radius. When both are active, their coefficients combine
into one volume. Dispersion (`transmissionDispersionScale > 0`) samples
wavelengths spectrally.

## Textures

| Property | Channel | Notes |
| --- | --- | --- |
| `map` | RGB (sRGB), A | Multiplies `baseColor`; alpha use set by `mapAlphaUsage` |
| `alphaMap` | G | Opacity, as in Three.js |
| `normalMap`, `normalScale` | RGB | Tangent space; tangents are generated when missing |
| `metallicRoughnessMap` | G = roughness, B = metalness | glTF convention |
| `roughnessMap` | G | |
| `metalnessMap` | B | |
| `emissiveMap` | RGB | Multiplies `emissionColor` |
| `transmissionMap` | R | Multiplies `transmissionWeight` |
| `thinFilmMap` | | Thin-film thickness |
| `displacementMap` | R | See [displacement](#displacement) |

`Texture.uvScale`, `uvOffset` and `uvChannel` (0 or 1) transform UVs per
texture. For geometry without usable UVs, set `uvProjection` to
`'triplanar'`, `'spherical'` or `'cylindrical'` with `uvProjectionScale` (default `[1, 1]`).

Call `texture.markUpdated()` after editing pixels or UV-array elements;
assigning a new texture, image or UV array is detected automatically.

## Alpha

`alphaMode` is `'auto'` (default; derived from the alpha inputs), `'opaque'`,
`'mask'` (alpha test against `alphaCutoff`) or `'blend'`. `mapAlphaUsage`
selects how `map`'s alpha channel is used:
`'opaque'` (default), `'alpha'` or `'transmission'`. Blended primary rays follow
`render.alphaBlendStrategy`. Both WebGPU and WebGL 2 apply these modes to
surface hits and shadow rays: `opaque` ignores opacity and alpha textures;
`mask` resolves coverage to 0 below `alphaCutoff` and 1 at or above it;
`blend` retains fractional coverage. In `auto`, a positive cutoff selects
`mask`; otherwise opacity below 1, alpha use of `map`, or an `alphaMap`
selects `blend`. With none of these inputs, `auto` selects `opaque`.

## Renderer extensions

| Property | Description |
| --- | --- |
| `shadowCatcher` | Invisible ground that only receives shadows; composite over a transparent background |
| `unlit` | Shows emission without scattering or lighting other surfaces |
| `bevelSize` | Rounded-edge shading radius in scene units; `0` disables (see below) |

**Shader bevel.** `bevelSize > 0` rounds hard edges in shading only, without
changing geometry or silhouettes. It samples nearby surface normals of the same
instance, similar to Blender Cycles' Bevel node. `render.bevelSamples`
trades noise for speed. A radius of 0.5–2% of the model size is a reasonable
start.

## Displacement

`displacementMap` (red channel) with `displacementScale` (local units)
ray-marches the height field in the shader. `displacementStepSize` controls the
ray-marching step (default `0.01`). No extra triangles are generated.
`displacementUvProjection` (default `'none'`) and `displacementUvProjectionScale`
(default `1`) control height-map coordinates.

`displacementBumpStrength` (default `0`) reuses the height map for bump shading.
The remaining `displacement*` properties are documented in the type declarations.

## Implementation notes

The BSDF evaluates fuzz, coat, metal, dielectric specular, transmission,
diffuse and subsurface as separate lobes, with energy compensation tables and
thin-film interference adapted from
[Adobe's OpenPBR BSDF](https://github.com/adobe/openpbr-bsdf). Small
differences from offline references remain, from finite path depth, RGB
thin-film evaluation and texture filtering.
