// Estimate the direct lighting integral using multiple importance sampling
// http://www.pbr-book.org/3ed-2018/Light_Transport_I_Surface_Reflection/Direct_Lighting.html#EstimatingtheDirectLightingIntegral

import { glsl } from '../../shader';
export default glsl`
vec3 DirectLight(SurfaceInteraction si, OpenPbrResolvedMaterial mat, inout Path path, vec3 ffnormal, float ndv, bool isSurface) {
  float occluded = 1.0;
  vec3 lightRnd = vec3(sample2D(bounceDim(LIGHT_POSITION)), sample1D(bounceDim(LIGHT_SELECT)));

  LightSampleRec lightSample;
  sampleLight(si.position, lightRnd, lightSample, false);
  lightSample.emission = sampling_spectral_rgb_filter(lightSample.emission, pathWavelength);

  vec3 lightDir = lightSample.direction;
  vec3 viewDir = -path.ray.d;
  float lightPdf = lightSample.pdf;
  // Opaque surfaces are rendered two-sided by the core renderer. Use the
  // face-forward shading normal here as well, otherwise the early-out rejects
  // every direct-light sample seen from the back of a triangle (for example
  // the inside of an imported room wall).
  float cosThetaL = dot(ffnormal, lightDir);

  if (lightPdf <= 0.0 || max(max(lightSample.emission.x, lightSample.emission.y), lightSample.emission.z) <= 0.0) {
    return vec3(0.0);
  }

  float scatteringPdf = 0.0;
  vec3 f = vec3(0.0);
  if (isSurface) {
    if (cosThetaL <= 0.0 && mat.transmissionWeight <= 0.0 && mat.subsurfaceWeight <= 0.0) {
      return vec3(0.0);
    }
    vec3 surfaceTangent = vec3(0.0);
#ifdef USE_TANGENT
    surfaceTangent = si.tangent;
#endif
    f = openpbr_eval(
      surfaceTangent,
      mat,
      viewDir,
      ffnormal,
      lightDir,
      scatteringPdf
    );
  }
  else {
    scatteringPdf = sampling_henyey_greenstein_phase(
      dot(viewDir, lightDir),
      si.mediumAnisotropy
    );
    f = vec3(scatteringPdf);
  }

  if (scatteringPdf <= 0.0 || max(max(f.x, f.y), f.z) <= 0.0) {
    return vec3(0.0);
  }

  Ray lightRay;
  vec3 shadowOrigin = si.position + EPS * lightDir;
  if (isSurface) {
    const float shadowTerminatorCutoff = 0.1;
    float normalLight = dot(si.normal, lightDir);
    vec3 geometricNormal = normalLight < 0.0 ? -si.faceNormal : si.faceNormal;
    normalLight = abs(normalLight);
    float geometricLight = dot(geometricNormal, lightDir);
    float offsetAmount = normalLight < shadowTerminatorCutoff
      ? clamp(
          2.0 - (geometricLight + normalLight) / shadowTerminatorCutoff,
          0.0,
          1.0
        )
      : clamp(1.0 - geometricLight / shadowTerminatorCutoff, 0.0, 1.0);
    shadowOrigin += si.shadowOffset * offsetAmount;
  }
  initRay(lightRay, shadowOrigin, lightDir);
  if (intersectSceneShadow(lightRay, lightSample.dist - EPS, si.triangleIndex)) {
    return vec3(0.0);
  }

  // Delta lights cannot be sampled by the BSDF strategy, so their MIS weight
  // is exactly one even when their light-selection PMF is small.
  float misWeight = lightSample.isDelta
    ? 1.0
    : sampling_power_heuristic(lightPdf, scatteringPdf);
  return misWeight > 0.0
    ? misWeight * lightSample.emission * f / lightPdf
    : vec3(0.0);
}

void SampleMaterial(inout SurfaceInteraction si, OpenPbrResolvedMaterial mat, inout Path path) {
  vec3 matRnd = vec3(sample2D(bounceDim(BSDF_DIRECTION)), sample1D(bounceDim(BSDF_LOBE)));
  float ndv1 = -dot(si.faceNormal, path.ray.d);
  float ndv2 = -dot(si.normal, path.ray.d);
  if ((mat.transmissionWeight > 0.0 || mat.subsurfaceWeight > 0.0) && mat.thinWalled) {
    // Always treat thin material as entering medium
    if (ndv1 < 0.0) {
      si.faceNormal = -si.faceNormal;
      ndv1 = -ndv1;
    }
    if (ndv2 < 0.0) {
      si.normal = -si.normal;
      ndv2 = -ndv2;
    }
  }
  // In same edge cases normal is not torwards the camera while we can still see the face.
  // We need to choose faceNormal in this case.
  bool useFaceN = ndv1 >= 0.0 && ndv2 < 0.0;
  float ndv = useFaceN ? ndv1 : ndv2;
  vec3 normal = useFaceN ? si.faceNormal : si.normal;

  // In or out
  mat.relativeIor = ndv > 0.0 ? (1.0 / mat.specularIor) : mat.specularIor;
  vec3 ffnormal = ndv >= 0.0 ? normal : -normal;


  float scatteringPdf;
  vec3 scatterDir;
  bool mediumSampled = false;
  bool crossedBoundary = false;

#ifdef HAS_MEDIUM
  int mediumType = si.mediumType;
  float d = distance(si.position, path.ray.o);
  vec3 segmentOrigin = path.ray.o;
  vec3 extinction = si.mediumExtinction;
  vec3 scattering = min(si.mediumScattering, extinction);
  float majorant = max(max(extinction.x, extinction.y), extinction.z);
  if (mediumType > 0 && majorant > 0.0) {
    // Sample one RGB extinction channel and divide by the mixture PDF. This
    // is the homogeneous-medium estimator used by PBRT and avoids the very
    // large exp((majorant - extinction) * distance) weights produced by
    // majorant tracking when OpenPBR SSS radii differ strongly by channel.
    int mediumChannel = min(int(sample1D(bounceDim(MEDIUM_CHANNEL)) * 3.0), 2);
    float channelExtinction = extinction[mediumChannel];
    float scatterDist = channelExtinction > 0.0
      ? min(-log(max(sample1D(bounceDim(MEDIUM_DISTANCE)), 1e-7)) / channelExtinction, d)
      : d;
    mediumSampled = scatterDist < d;
    vec3 transmittance = exp(-extinction * scatterDist);
    vec3 density = mediumSampled
      ? extinction * transmittance
      : transmittance;
    float mediumPdf = max(
      (density.x + density.y + density.z) / 3.0,
      1e-8
    );
    if (mediumSampled) {
      path.beta *= transmittance * scattering / mediumPdf;
      // Move from the start of the segment, not from its end surface.
      path.ray.o = segmentOrigin + scatterDist * path.ray.d;
      si.position = path.ray.o;
      path.li += DirectLight(si, mat, path, ffnormal, ndv, false) * path.beta;

      // Pick a new direction based on the phase function
      scatterDir = sampling_henyey_greenstein(
        -path.ray.d,
        si.mediumAnisotropy,
        sample2D(bounceDim(PHASE_DIRECTION))
      );
      scatteringPdf = sampling_henyey_greenstein_phase(
        dot(scatterDir, -path.ray.d),
        si.mediumAnisotropy
      );
    }
    else {
      path.beta *= transmittance / mediumPdf;
    }
  }
#endif

  // Direct lighting
  if (!mediumSampled) {
    path.li += mat.emission * path.beta;
    if (mat.materialType == UNLIT) {
      path.abort = true;
      return;
    }
    path.li += DirectLight(si, mat, path, ffnormal, ndv, true) * path.beta;
    // Sample BSDF for color and outgoing direction
    bool isNextRefraction;
    vec3 surfaceTangent = vec3(0.0);
#ifdef USE_TANGENT
    surfaceTangent = si.tangent;
#endif
    vec3 f = openpbr_sample(
      surfaceTangent,
      mat,
      matRnd,
      -path.ray.d,
      ffnormal,
      scatterDir,
      scatteringPdf,
      isNextRefraction
    );
    if (scatteringPdf > 0.0) {
      path.beta *= f / scatteringPdf;
    }
    crossedBoundary = !mat.thinWalled &&
      isNextRefraction;
    path.isNextRefraction = isNextRefraction;
    // TODO prefer the opaque surface when transmission surface and opaque surface are overlapped.
    // Or the ray go out from transmission material will miss the opque surface.
    path.ray.o = si.position + EPS * scatterDir;
  }

  path.scatteringPdf = scatteringPdf;
  initRay(path.ray, path.ray.o, scatterDir);
  if (mediumSampled) {
    path.isNextRefraction = false;
  }
  path.fromEye = false;

#ifdef HAS_MEDIUM
  // A reflected ray stays in its current medium. Only a sampled transmission
  // event crosses the boundary of a medium-bearing closed mesh.
  if (!mediumSampled && crossedBoundary && mat.mediumType > 0) {
    if (ndv1 >= 0.0) {
      si.mediumType = mat.mediumType;
      si.mediumExtinction = mat.mediumExtinction;
      si.mediumScattering = mat.mediumScattering;
      si.mediumAnisotropy = mat.mediumAnisotropy;
    }
    else {
      si.mediumType = 0;
      si.mediumExtinction = vec3(0.0);
      si.mediumScattering = vec3(0.0);
      si.mediumAnisotropy = 0.0;
    }
  }
#endif
}
`;
