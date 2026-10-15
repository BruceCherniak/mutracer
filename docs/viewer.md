# Sharing viewer settings

Add settings to a viewer link to override the recipient's saved preferences.
For example, open the viewer with HDR output enabled:

```text
https://mutracer.meimu-studio.com/viewer/?hdrOutputEnabled=true
```

Combine settings with `&`, and use `#model=…` to choose an example:

```text
https://mutracer.meimu-studio.com/viewer/?hdrOutputEnabled=true&maxSamples=128#model=dragon
```

The viewer updates the URL as lighting, render and display settings change.
Copy the address bar to share those settings and the selected example model.
Settings also work in the hash, such as `#model=dragon&hdrOutputEnabled=true`.

## Options

Parameter names match the viewer settings and are case-sensitive:

| Group | Parameters |
| --- | --- |
| Lighting | `lighting`, `studioPreset`, `studioIntensity`, `studioRotation`, `studioSize`, `studioAmbient`, `studioAmbientColor`, `envId`, `envIntensity`, `envRotation`, `envResolution` |
| Background and ground | `background`, `backgroundColor`, `groundedHeight`, `groundedRadius`, `groundShadow`, `groundOpacity` |
| Quality | `maxSamples`, `bounces`, `resolutionScale`, `samplingPattern`, `bvhBuilder`, `clamping`, `previewEnabled`, `previewMaxResolutionScale` |
| Denoising | `denoise`, `denoiseModel`, `denoiseWhileConverging`, `jnlmStrength`, `jnlmSearchRadius`, `jnlmPatchRadius`, `jnlmAlbedoBandwidth`, `jnlmNormalBandwidth`, `jnlmIterations`, `oidnModel`, `oidnMaxTileSize` |
| Display | `hdrOutputEnabled`, `toneMapping`, `exposure`, `contrast`, `saturation`, `temperature`, `tint`, `bloomIntensity`, `bloomThreshold`, `bloomRadius`, `vignette`, `output` |

Booleans accept `true`/`false` or `1`/`0`. Numbers must be finite and within
the setting's supported range. Colors use URL-encoded hex, for example
`backgroundColor=%232a2b30`. Use `null` for automatic `groundedHeight` or
`groundedRadius`. Choices use the setting's value, for example
`toneMapping=agx`, `envResolution=2k` or `denoiseModel=jnlm`.

Valid query parameters take priority over hash parameters, then saved local
preferences, then defaults. Unknown parameters and invalid values are ignored.
Explicit defaults such as `hdrOutputEnabled=false` remain in the link so they
can override a recipient's different preference. When the viewer updates the
address, settings move into the hash; unrelated query parameters, including
`?webgl`, are preserved.

## Caveats

HDR output requires WebGPU, an HDR display and a compatible browser. Unsupported
devices fall back to SDR. `?webgl` forces WebGL 2, which does not support HDR output.

Links do not include uploaded models or environments, camera state, material
edits, object visibility or panel layout. Camera state continues to follow the
locally saved view for the current model. URL settings are applied on page load;
reload after editing parameters in the address bar.
