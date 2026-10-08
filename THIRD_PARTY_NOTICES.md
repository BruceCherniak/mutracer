# Third-party notices

ClayPT is released under the MIT License (see [`LICENSE`](./LICENSE)). It
includes or adapts the following third-party work. License texts are in
[`LICENSES/`](./LICENSES) unless noted otherwise.

## TinyBVH

The WebAssembly BVH builder (`src/tinybvh/`) wraps
[jbikker/tinybvh](https://github.com/jbikker/tinybvh) at commit
`0e4584287823252cf83f0e9cd072848bec5f79c5`.

Copyright (c) 2024-2026 Jacco Bikker / Breda University of Applied Sciences.
MIT License. The license text is at
[`src/tinybvh/LICENSE`](./src/tinybvh/LICENSE) and is copied next to
`tinybvh.wasm` in published builds.

## Adobe OpenPBR BSDF

The opaque-dielectric energy lookup tables (`src/renderer/openPbrEnergyLut.ts`)
and parts of the energy-conserving rough diffuse, GGX spherical-cap VNDF
sampling, thin-film Airy interference and thin-wall implementations in the
OpenPBR shader chunks are adapted from
[adobe/openpbr-bsdf](https://github.com/adobe/openpbr-bsdf) at commit
`9edf806740d2140846d9bef76e4342fc458e2ef5`.

Copyright 2026 Adobe. Apache License 2.0
([`LICENSES/Apache-2.0.txt`](./LICENSES/Apache-2.0.txt)). Modified for WGSL and
GLSL; the upstream project has no NOTICE file.

## GLSL-PathTracer

The PCG random number generator in the `rand` shader chunks, and parts of the
original GLSL path tracing structure, are adapted from
[knightcrawler25/GLSL-PathTracer](https://github.com/knightcrawler25/GLSL-PathTracer).
The generator in that project credits Moroz Mykhailo
([Shadertoy wltcRS](https://www.shadertoy.com/view/wltcRS)).

Copyright (c) 2019 Asif Ali. MIT License
([`LICENSES/GLSL-PathTracer-MIT.txt`](./LICENSES/GLSL-PathTracer-MIT.txt)).

## ZetaRay

The histogram auto exposure pass (`src/renderer/WGPUAutoExposure.ts`) is
adapted from [alipbcs/ZetaRay](https://github.com/alipbcs/ZetaRay).

Copyright (c) 2023-2024 Ali Behnoudfar. MIT License
([`LICENSES/ZetaRay-MIT.txt`](./LICENSES/ZetaRay-MIT.txt)).

## Tony McMapface

The tone-mapping lookup table (`src/renderer/tonyMcMapfaceLutData.ts`) is
generated from `tony_mc_mapface.dds` in
[h3r2tic/tony-mc-mapface](https://github.com/h3r2tic/tony-mc-mapface).

Copyright (c) 2023 Tomasz Stachowiak. MIT License
([`LICENSES/TonyMcMapface-MIT.txt`](./LICENSES/TonyMcMapface-MIT.txt)).

## KinoBloom

The bloom prefilter's median filter follows
[keijiro/KinoBloom](https://github.com/keijiro/KinoBloom).

Copyright (c) 2015-2017 Keijiro Takahashi. MIT License
([`LICENSES/KinoBloom-MIT.txt`](./LICENSES/KinoBloom-MIT.txt)).

## Blue noise texture

`src/renderer/texture/HDR_L_0.png` (embedded in `noise.ts`) is from Christoph
Peters' [free blue noise textures](http://momentsingraphics.de/BlueNoise.html),
released under CC0 1.0.

## Intel Open Image Denoise weights

The `.tza` files in [`oidn/weights/`](./oidn/weights) are trained weights from
[Intel Open Image Denoise](https://github.com/OpenImageDenoise/oidn).

Copyright Intel Corporation. Apache License 2.0
([`oidn/weights/LICENSE.txt`](./oidn/weights/LICENSE.txt)). Denoising runs
through the [`oidn-web`](https://www.npmjs.com/package/oidn-web) package, which
carries its own license.
