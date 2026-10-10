# Materials

`OpenPBRMaterial` implements the
[OpenPBR 1.1](https://academysoftwarefoundation.github.io/OpenPBR/) surface.
Property names are camel-case spellings of the OpenPBR inputs. Colors are
linear RGB.

```ts
import { OpenPBRMaterial } from 'mutracer';

const glass = new OpenPBRMaterial();
glass.transmissionWeight = 1;
glass.specularRoughness = 0;
glass.transmissionColor = [0.72, 0.9, 1];
glass.transmissionDepth = 0.5;

const gold = Object.assign(new OpenPBRMaterial(), {
  baseColor: [1.0, 0.78, 0.34],
  baseMetalness: 1,
  specularRoughness: 0.2
});
```

After editing a material that is already rendering, call `material.markUpdated()`:

```ts
gold.specularRoughness = 0.4;
gold.baseColor[1] = 0.7;
gold.markUpdated();
```

Both backends update parameter buffers without merging geometry or rebuilding
BVHs. Emission changes also refresh emission-related sampling state; texture
changes rebuild the atlas. Displacement geometry settings require a full mesh
update, as do emission edits on tessellated displacement materials. Shading-only
`displacementBumpStrength` edits use the textures path.

Materials occupy slots by object identity. Sharing one material shares its slot;
separate objects with equal values remain separate slots. Referenced textures
still share atlas layers. Call `texture.markUpdated()` after pixel or UV-array
element edits; assigning a new texture, image or UV array is detected directly.

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
`'triplanar'`, `'spherical'` or `'cylindrical'` with `uvScale`.

## Alpha

`alphaMode` is `'auto'` (default; derived from the alpha inputs), `'opaque'`,
`'mask'` (alpha test against `alphaCutoff`) or `'blend'`. `mapAlphaUsage`
selects how `map`'s alpha channel is used:
`OpenPBRMaterial.mapAlphaUsageOpaque`, `mapAlphaUsageAlpha` or
`mapAlphaUsageTransmission`. Blended primary rays follow
`renderer.alphaBlendStrategy`.

## Renderer extensions

| Property | Description |
| --- | --- |
| `shadowCatcher` | Invisible ground that only receives shadows; composite over a transparent background |
| `unlit` | Shows emission without scattering or lighting other surfaces |
| `bevelSize` | Rounded-edge shading radius in scene units; `0` disables (see below) |

**Shader bevel.** `bevelSize > 0` rounds hard edges in shading only, without
changing geometry or silhouettes. It samples nearby surface normals of the same
instance, similar to Blender Cycles' Bevel node. `renderer.bevelSamples`
trades noise for speed. A radius of 0.5–2% of the model size is a reasonable
start.

## Displacement

`displacementMap` (red channel) with `displacementScale` (local units) and
`displacementBias` supports two modes:

- `displacementMode = 'projective'` (default) ray-marches the height field in
  the shader (`displacementStepSize`). No extra geometry; silhouettes stay flat.
- `displacementMode = 'tessellated'` generates real triangles before rendering,
  so silhouettes, shadows and intersections are displaced. The geometry is
  built automatically with the BVH; for large meshes, run it in a worker with
  the [precompute helpers](./bvh.md#worker-precomputation).

Tessellation options:

| Property | Default | Description |
| --- | --- | --- |
| `displacementTessellationMode` | `'adaptive'` | `'uniform'`, `'adaptive'` or `'opensubdiv'` (needs a topology refiner passed to `precompute`) |
| `displacementMinSubdivisionLevel`, `displacementMaxSubdivisionLevel` | 0, 3 | Subdivision range |
| `displacementMaxError` | 0.0025 | Adaptive geometric error target |
| `displacementMaxTriangles` | 1,000,000 | Hard cap per mesh |
| `displacementEdgeProfile` | `'smooth'` | `'smooth'`, `'beveled'`, `'hard'`, `'auto'` for thresholded maps |
| `displacementThreshold`, `displacementEdgeWidth` | 0.5, 2 | Hard-edge threshold and bevel width (texels) |
| `displacementHardContourGeometry` | `true` | Remesh hard contours with vertical walls |
| `displacementCreaseAngle` | 60 | Normal split angle (degrees) |
| `displacementBumpStrength` | 0 | Reuse the height map as bump detail |

The remaining `displacement*` properties are documented in the type
declarations.

## Implementation notes

The BSDF evaluates fuzz, coat, metal, dielectric specular, transmission,
diffuse and subsurface as separate lobes, with energy compensation tables and
thin-film interference adapted from
[Adobe's OpenPBR BSDF](https://github.com/adobe/openpbr-bsdf). Small
differences from offline references remain, from finite path depth, RGB
thin-film evaluation and texture filtering.
