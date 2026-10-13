/*
 * OpenPBR energy-compensation, EON and thin-film portions Copyright 2026 Adobe.
 * Licensed under the Apache License, Version 2.0.
 * https://www.apache.org/licenses/LICENSE-2.0
 */

/*
 * Renderer-specific OpenPBR layered BSDF.
 *
 * The prepare/eval/sample/pdf organization and fixed-lobe composition follow:
 * - https://github.com/adobe/openpbr-bsdf
 * - https://github.com/portsmouth/OpenPBR-viewer
 *
 * This compact GPU implementation reuses the renderer's GGX VNDF and volume
 * integrator. Adobe's opaque-dielectric energy tables are used for the base
 * rough-diffuse/specular coupling; fuzz still uses an analytic approximation.
 */
import { glsl } from '../../shader.js';

export default glsl`
const int OPENPBR_LOBE_FUZZ = 0;
const int OPENPBR_LOBE_COAT = 1;
const int OPENPBR_LOBE_METAL = 2;
const int OPENPBR_LOBE_SPECULAR = 3;
const int OPENPBR_LOBE_TRANSMISSION = 4;
const int OPENPBR_LOBE_DIFFUSE = 5;
const int OPENPBR_LOBE_SUBSURFACE = 6;

struct OpenPbrBasis {
    vec3 tangent;
    vec3 bitangent;
    vec3 normal;
};

struct OpenPbrPreparedBsdf {
    OpenPbrResolvedMaterial material;
    OpenPbrBasis basis;
    vec3 viewLocal;
    vec3 diffuseColor;
    float specularEtaTOverEtaI;
    float specularAlpha;
    float diffuseSpecularEnergyCompensation;

    float fuzzWeight;
    float coatWeight;
    float metalWeight;
    float specularWeight;
    float transmissionWeight;
    float diffuseWeight;
    float subsurfaceWeight;

    float fuzzProbability;
    float coatProbability;
    float metalProbability;
    float specularProbability;
    float transmissionProbability;
    float diffuseProbability;
    float subsurfaceProbability;
};

float openpbr_luminance(vec3 color) {
    return dot(color, vec3(0.212671, 0.715160, 0.072169));
}

float openpbr_f0_from_ior(float etaTOverEtaI) {
    float value = (etaTOverEtaI - 1.0) / (etaTOverEtaI + 1.0);
    return value * value;
}

float openpbr_apply_specular_weight_to_ior(
    float etaTOverEtaI,
    float specularWeight
) {
    float scaledF0 = min(
        openpbr_f0_from_ior(etaTOverEtaI) * specularWeight,
        0.9999
    );
    float sqrtF0 = sqrt(scaledF0);
    float externalIor = (1.0 + sqrtF0) / (1.0 - sqrtF0);
    return etaTOverEtaI < 1.0 ? 1.0 / externalIor : externalIor;
}

float openpbr_dielectric_fresnel(float cosTheta, float relativeIor) {
    if (abs(relativeIor - 1.0) < 1e-6) {
        return 0.0;
    }
    return sampling_dielectric_fresnel(cosTheta, relativeIor);
}

float openpbr_energy_ior_index(float ior) {
    if (ior < 1.0) {
        return 15.0 - ((1.0 / ior - 1.0) / 1.5) * 15.0;
    }
    return 16.0 + ((ior - 1.0) / 1.5) * 15.0;
}

float openpbr_energy_fetch(int cosIndex, int row) {
    return texelFetch(openPbrEnergyLut, ivec2(cosIndex, row), 0).r;
}

float openpbr_energy_trilinear(
    float exactIor,
    float exactAlpha,
    float exactCosine
) {
    float iorIndex = clamp(exactIor, 0.0, 31.0);
    float alphaIndex = clamp(exactAlpha, 0.0, 31.0);
    float cosineIndex = clamp(exactCosine, 0.0, 31.0);
    int ior0 = int(floor(iorIndex));
    int alpha0 = int(floor(alphaIndex));
    int cosine0 = int(floor(cosineIndex));
    int ior1 = min(ior0 + 1, 31);
    int alpha1 = min(alpha0 + 1, 31);
    int cosine1 = min(cosine0 + 1, 31);
    float iorMix = iorIndex - float(ior0);
    float alphaMix = alphaIndex - float(alpha0);
    float cosineMix = cosineIndex - float(cosine0);

    float v000 = openpbr_energy_fetch(cosine0, ior0 * 32 + alpha0);
    float v001 = openpbr_energy_fetch(cosine1, ior0 * 32 + alpha0);
    float v010 = openpbr_energy_fetch(cosine0, ior0 * 32 + alpha1);
    float v011 = openpbr_energy_fetch(cosine1, ior0 * 32 + alpha1);
    float v100 = openpbr_energy_fetch(cosine0, ior1 * 32 + alpha0);
    float v101 = openpbr_energy_fetch(cosine1, ior1 * 32 + alpha0);
    float v110 = openpbr_energy_fetch(cosine0, ior1 * 32 + alpha1);
    float v111 = openpbr_energy_fetch(cosine1, ior1 * 32 + alpha1);
    float v00 = mix(v000, v100, iorMix);
    float v01 = mix(v001, v101, iorMix);
    float v10 = mix(v010, v110, iorMix);
    float v11 = mix(v011, v111, iorMix);
    return mix(
        mix(v00, v10, alphaMix),
        mix(v01, v11, alphaMix),
        cosineMix
    );
}

float openpbr_energy_bilinear(float exactIor, float exactAlpha) {
    float iorIndex = clamp(exactIor, 0.0, 31.0);
    float alphaIndex = clamp(exactAlpha, 0.0, 31.0);
    int ior0 = int(floor(iorIndex));
    int alpha0 = int(floor(alphaIndex));
    int ior1 = min(ior0 + 1, 31);
    int alpha1 = min(alpha0 + 1, 31);
    float iorMix = iorIndex - float(ior0);
    float alphaMix = alphaIndex - float(alpha0);
    float v00 = openpbr_energy_fetch(alpha0, 1024 + ior0);
    float v01 = openpbr_energy_fetch(alpha1, 1024 + ior0);
    float v10 = openpbr_energy_fetch(alpha0, 1024 + ior1);
    float v11 = openpbr_energy_fetch(alpha1, 1024 + ior1);
    return mix(
        mix(v00, v10, iorMix),
        mix(v01, v11, iorMix),
        alphaMix
    );
}

float openpbr_extrapolate_energy_complement(float value, float ior) {
    if (ior > 2.5 || ior < 0.4) {
        float maxF0 = openpbr_f0_from_ior(2.5);
        float progress = (openpbr_f0_from_ior(ior) - maxF0) / (1.0 - maxF0);
        return (1.0 - progress) * value;
    }
    return value;
}

float openpbr_opaque_energy_complement(
    float ior,
    float alpha,
    float cosine
) {
    float value = openpbr_energy_trilinear(
        openpbr_energy_ior_index(ior),
        sqrt(alpha) * 31.0,
        cosine * 31.0
    );
    return openpbr_extrapolate_energy_complement(value, ior);
}

float openpbr_opaque_average_energy_complement(float ior, float alpha) {
    float value = openpbr_energy_bilinear(
        openpbr_energy_ior_index(ior),
        sqrt(alpha) * 31.0
    );
    return openpbr_extrapolate_energy_complement(value, ior);
}

vec3 openpbr_to_world(OpenPbrBasis basis, vec3 direction) {
    return direction.x * basis.tangent
        + direction.y * basis.bitangent
        + direction.z * basis.normal;
}

vec3 openpbr_to_local(OpenPbrBasis basis, vec3 direction) {
    return vec3(
        dot(direction, basis.tangent),
        dot(direction, basis.bitangent),
        dot(direction, basis.normal)
    );
}

OpenPbrBasis openpbr_make_basis(
    vec3 inputTangent,
    vec3 normal,
    float anisotropy
) {
    OpenPbrBasis basis;
    basis.normal = normal;
    basis.tangent = vec3(0.0);
#ifdef USE_TANGENT
    basis.tangent = inputTangent;
#endif
    if (dot(basis.tangent, basis.tangent) < 0.001 || anisotropy <= 0.0) {
        sampling_orthonormal_basis(normal, basis.tangent, basis.bitangent);
    }
    else {
        basis.bitangent = normalize(cross(normal, basis.tangent));
        basis.tangent = normalize(cross(basis.bitangent, normal));
    }
    return basis;
}

float openpbr_fresnel_s(
    float incidentIor,
    float transmittedIor,
    float incidentCosine,
    float transmittedCosine
) {
    return (incidentIor * incidentCosine - transmittedIor * transmittedCosine)
        / (incidentIor * incidentCosine + transmittedIor * transmittedCosine);
}

float openpbr_fresnel_p(
    float incidentIor,
    float transmittedIor,
    float incidentCosine,
    float transmittedCosine
) {
    return (transmittedIor * incidentCosine - incidentIor * transmittedCosine)
        / (incidentIor * transmittedCosine + transmittedIor * incidentCosine);
}

float openpbr_transmission_s(
    float incidentIor,
    float transmittedIor,
    float incidentCosine,
    float transmittedCosine
) {
    return 2.0 * incidentIor * incidentCosine
        / (incidentIor * incidentCosine + transmittedIor * transmittedCosine);
}

float openpbr_transmission_p(
    float incidentIor,
    float transmittedIor,
    float incidentCosine,
    float transmittedCosine
) {
    return 2.0 * incidentIor * incidentCosine
        / (incidentIor * transmittedCosine + transmittedIor * incidentCosine);
}

vec2 openpbr_complex_multiply(vec2 a, vec2 b) {
    return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

vec2 openpbr_complex_divide(vec2 a, vec2 b) {
    float denominator = max(dot(b, b), 1e-9);
    return vec2(
        (a.x * b.x + a.y * b.y) / denominator,
        (a.y * b.x - a.x * b.y) / denominator
    );
}

vec2 openpbr_complex_sqrt(vec2 value) {
    float magnitude = length(value);
    float realPart = sqrt(max(0.0, 0.5 * (magnitude + value.x)));
    float imaginaryMagnitude = sqrt(max(0.0, 0.5 * (magnitude - value.x)));
    return vec2(realPart, value.y >= 0.0 ? imaginaryMagnitude : -imaginaryMagnitude);
}

vec2 openpbr_complex_fresnel_reflection(
    float incidentCosine,
    float incidentIor,
    vec2 transmittedIor,
    bool pPolarized
) {
    float incidentSine = sqrt(max(0.0, 1.0 - incidentCosine * incidentCosine));
    vec2 iorRatio = openpbr_complex_divide(vec2(incidentIor, 0.0), transmittedIor);
    vec2 transmittedSine = iorRatio * incidentSine;
    vec2 transmittedCosine = openpbr_complex_sqrt(
        vec2(1.0, 0.0) - openpbr_complex_multiply(transmittedSine, transmittedSine)
    );
    if (openpbr_complex_multiply(transmittedIor, transmittedCosine).y < 0.0) {
        transmittedCosine = -transmittedCosine;
    }

    vec2 incidentIorCosine = vec2(incidentIor * incidentCosine, 0.0);
    vec2 transmittedIorCosine = openpbr_complex_multiply(transmittedIor, transmittedCosine);
    if (pPolarized) {
        vec2 transmittedIorIncidentCosine = transmittedIor * incidentCosine;
        vec2 incidentIorTransmittedCosine = transmittedCosine * incidentIor;
        return openpbr_complex_divide(
            transmittedIorIncidentCosine - incidentIorTransmittedCosine,
            transmittedIorIncidentCosine + incidentIorTransmittedCosine
        );
    }
    return openpbr_complex_divide(
        incidentIorCosine - transmittedIorCosine,
        incidentIorCosine + transmittedIorCosine
    );
}

float openpbr_airy_reflectance(
    float reflection12,
    float transmission12,
    float reflection21,
    float transmission21,
    vec2 reflection23,
    float phase
) {
    vec2 phaseRotation = vec2(cos(phase), sin(phase));
    vec2 reflectedPhase = openpbr_complex_multiply(reflection23, phaseRotation);
    vec2 numerator = reflectedPhase * (transmission12 * transmission21);
    vec2 denominator = vec2(1.0, 0.0) - reflectedPhase * reflection21;
    vec2 totalReflection = vec2(reflection12, 0.0)
        + openpbr_complex_divide(numerator, denominator);
    return dot(totalReflection, totalReflection);
}

float openpbr_thin_film_reflectance_channel(
    float incidentCosine,
    float wavelength,
    float thickness,
    float exteriorIor,
    float filmIor,
    vec2 substrateIor
) {
    incidentCosine = clamp(abs(incidentCosine), 1e-5, 1.0);
    float filmSineSquared = pow(exteriorIor / filmIor, 2.0)
        * (1.0 - incidentCosine * incidentCosine);
    if (filmSineSquared >= 1.0) {
        return 1.0;
    }
    float filmCosine = sqrt(1.0 - filmSineSquared);
    float reflection12S = openpbr_fresnel_s(
        exteriorIor, filmIor, incidentCosine, filmCosine
    );
    float reflection12P = openpbr_fresnel_p(
        exteriorIor, filmIor, incidentCosine, filmCosine
    );
    float transmission12S = openpbr_transmission_s(
        exteriorIor, filmIor, incidentCosine, filmCosine
    );
    float transmission12P = openpbr_transmission_p(
        exteriorIor, filmIor, incidentCosine, filmCosine
    );
    float transmission21Scale = filmIor * filmCosine
        / max(exteriorIor * incidentCosine, 1e-9);
    vec2 reflection23S = openpbr_complex_fresnel_reflection(
        filmCosine, filmIor, substrateIor, false
    );
    vec2 reflection23P = openpbr_complex_fresnel_reflection(
        filmCosine, filmIor, substrateIor, true
    );
    float phase = 2.0 * PI * (2.0 * filmIor * thickness * filmCosine) / wavelength;
    float reflectanceS = openpbr_airy_reflectance(
        reflection12S,
        transmission12S,
        -reflection12S,
        transmission12S * transmission21Scale,
        reflection23S,
        phase
    );
    float reflectanceP = openpbr_airy_reflectance(
        reflection12P,
        transmission12P,
        -reflection12P,
        transmission12P * transmission21Scale,
        reflection23P,
        phase
    );
    return clamp(0.5 * (reflectanceS + reflectanceP), 0.0, 1.0);
}

vec3 openpbr_thin_film_dielectric_reflectance(
    float incidentCosine,
    float thickness,
    float filmIor,
    float substrateIor
) {
    return vec3(
        openpbr_thin_film_reflectance_channel(
            incidentCosine, 620.0, thickness, 1.0, filmIor, vec2(substrateIor, 0.0)
        ),
        openpbr_thin_film_reflectance_channel(
            incidentCosine, 540.0, thickness, 1.0, filmIor, vec2(substrateIor, 0.0)
        ),
        openpbr_thin_film_reflectance_channel(
            incidentCosine, 450.0, thickness, 1.0, filmIor, vec2(substrateIor, 0.0)
        )
    );
}

// OpenPBR 1.1.1 Metal: analytic F82-tint correction to Schlick.
// Saturation follows Adobe impl/openpbr_lobe_utils.h, openpbr_metal_schlick_with_f82_tint.
vec3 openpbr_metal_fresnel(float cosine, vec3 f0, vec3 tint) {
    vec3 schlick = mix(f0, vec3(1.0), sampling_schlick_fifth_power(cosine));
    if (all(equal(tint, vec3(1.0)))) { return schlick; }
    float edgeCosine = 1.0 / 7.0;
    float edgeComplement = 1.0 - edgeCosine;
    vec3 edgeFresnel = mix(f0, vec3(1.0), sampling_schlick_fifth_power(edgeCosine));
    float complement = 1.0 - cosine;
    float correction = cosine * sampling_schlick_fifth_power(cosine) * complement
        / (edgeCosine * pow(edgeComplement, 6.0));
    return clamp(schlick - correction * (edgeFresnel - tint * edgeFresnel), vec3(0.0), vec3(1.0));
}

vec2 openpbr_metal_complex_ior(float f0, float f82Tint) {
    float reflectivity = clamp(f0, 0.0, 0.99);
    float sqrtReflectivity = sqrt(reflectivity);
    float minimumIor = (1.0 - reflectivity) / (1.0 + reflectivity);
    float maximumIor = (1.0 + sqrtReflectivity) / max(1.0 - sqrtReflectivity, 1e-9);
    float ior = mix(maximumIor, minimumIor, clamp(f82Tint, 0.0, 1.0));
    float extinctionSquared = (
        (ior + 1.0) * (ior + 1.0) * reflectivity
        - (ior - 1.0) * (ior - 1.0)
    ) / max(1.0 - reflectivity, 1e-9);
    return vec2(ior, sqrt(max(extinctionSquared, 0.0)));
}

vec3 openpbr_thin_film_metal_reflectance(
    float incidentCosine,
    float thickness,
    float filmIor,
    vec3 metalF0,
    vec3 metalF82Tint
) {
    return vec3(
        openpbr_thin_film_reflectance_channel(
            incidentCosine,
            620.0,
            thickness,
            1.0,
            filmIor,
            openpbr_metal_complex_ior(metalF0.r, metalF82Tint.r)
        ),
        openpbr_thin_film_reflectance_channel(
            incidentCosine,
            540.0,
            thickness,
            1.0,
            filmIor,
            openpbr_metal_complex_ior(metalF0.g, metalF82Tint.g)
        ),
        openpbr_thin_film_reflectance_channel(
            incidentCosine,
            450.0,
            thickness,
            1.0,
            filmIor,
            openpbr_metal_complex_ior(metalF0.b, metalF82Tint.b)
        )
    );
}

float openpbr_thin_film_presence(float thickness, float weight) {
    return clamp(weight, 0.0, 1.0) * smoothstep(1e-9, 30.0, thickness);
}

vec3 openpbr_apply_dielectric_thin_film(
    vec3 substrateFresnel,
    float incidentCosine,
    float thickness,
    float filmIor,
    float substrateIor,
    float weight
) {
    vec3 filmFresnel = openpbr_thin_film_dielectric_reflectance(
        incidentCosine,
        thickness,
        filmIor,
        substrateIor
    );
    return mix(
        substrateFresnel,
        filmFresnel,
        openpbr_thin_film_presence(thickness, weight)
    );
}

vec3 openpbr_apply_metal_thin_film(
    vec3 substrateFresnel,
    float incidentCosine,
    float thickness,
    float filmIor,
    vec3 metalF0,
    vec3 metalF82Tint,
    float weight
) {
    vec3 filmFresnel = openpbr_thin_film_metal_reflectance(
        incidentCosine,
        thickness,
        filmIor,
        metalF0,
        metalF82Tint
    );
    return mix(
        substrateFresnel,
        filmFresnel,
        openpbr_thin_film_presence(thickness, weight)
    );
}

vec3 openpbr_eval_diffuse(
    OpenPbrResolvedMaterial material,
    vec3 color,
    vec3 viewLocal,
    vec3 lightLocal,
    float specularEnergyCompensation,
    out float pdf
) {
    pdf = 0.0;
    if (lightLocal.z <= 0.0) {
        return vec3(0.0);
    }

    float roughness = material.diffuseRoughness;
    float fonConstantA = 0.5 - 2.0 / (3.0 * PI);
    float fonConstantB = 2.0 / 3.0 - 28.0 / (15.0 * PI);
    float muInput = lightLocal.z;
    float muOutput = viewLocal.z;
    float directional = dot(lightLocal, viewLocal) - muInput * muOutput;
    float directionalOverTangent = directional > 0.0
        ? directional / max(max(muInput, muOutput), 1e-7)
        : directional;
    float singleScatterA = 1.0 / (1.0 + fonConstantA * roughness);
    vec3 singleScatter = color * INVPI * singleScatterA
        * (1.0 + roughness * directionalOverTangent);

    float inputComplement = 1.0 - muInput;
    float outputComplement = 1.0 - muOutput;
    float inputGOverPi = inputComplement * (
        0.0571085289 + inputComplement * (
            0.491881867 + inputComplement * (
                -0.332181442 + inputComplement * 0.0714429953
            )
        )
    );
    float outputGOverPi = outputComplement * (
        0.0571085289 + outputComplement * (
            0.491881867 + outputComplement * (
                -0.332181442 + outputComplement * 0.0714429953
            )
        )
    );
    float inputAlbedo = (1.0 + roughness * inputGOverPi)
        / (1.0 + fonConstantA * roughness);
    float outputAlbedo = (1.0 + roughness * outputGOverPi)
        / (1.0 + fonConstantA * roughness);
    float averageAlbedo = singleScatterA * (1.0 + fonConstantB * roughness);
    vec3 multipleScatterAlbedo = color * color * averageAlbedo
        / max(vec3(1e-7), vec3(1.0) - color * (1.0 - averageAlbedo));
    vec3 multipleScatter = multipleScatterAlbedo * INVPI
        * max(1e-7, 1.0 - outputAlbedo)
        * max(1e-7, 1.0 - inputAlbedo)
        / max(1e-7, 1.0 - averageAlbedo);
    pdf = lightLocal.z * INVPI;
    return (singleScatter + multipleScatter) * specularEnergyCompensation;
}

float openpbr_fuzz_directional_albedo(float viewCosine, float roughness) {
    float x = clamp(viewCosine, 0.0, 1.0);
    float y = clamp(roughness, 0.01, 1.0);
    float scale = y * (0.0206607 + 1.58491 * y)
        / (0.0379424 + y * (1.32227 + y));
    float mean = y * (-0.193854 + y * (-1.14885 + y * (1.7932 - 0.95943 * y * y)))
        / (0.046391 + y);
    float offset = y * (0.000654023 + (-0.0207818 + 0.119681 * y) * y)
        / (1.26264 + y * (-1.92021 + y));
    float gaussian = exp(-0.5 * pow((x - mean) / scale, 2.0))
        / (scale * sqrt(2.0 * PI));
    return max(gaussian + offset, 0.0);
}

vec3 openpbr_eval_fuzz(
    OpenPbrResolvedMaterial material,
    vec3 viewLocal,
    vec3 lightLocal,
    out float pdf
) {
    pdf = 0.0;
    if (viewLocal.z <= 0.0 || lightLocal.z <= 0.0) {
        return vec3(0.0);
    }
    float albedo = openpbr_fuzz_directional_albedo(
        viewLocal.z,
        material.fuzzRoughness
    );
    pdf = lightLocal.z * INVPI;
    return material.fuzzColor * albedo * INVPI;
}

vec3 openpbr_eval_microfacet_reflection(
    OpenPbrResolvedMaterial material,
    vec3 viewLocal,
    vec3 lightLocal,
    vec3 halfVector,
    vec3 fresnel,
    out float pdf
) {
    pdf = 0.0;
    if (lightLocal.z <= 0.0) {
        return vec3(0.0);
    }

    vec2 alpha = vec2(material.alphaX, material.alphaY);
    float distribution = sampling_ggx_ndf(halfVector, alpha);
    float masking = sampling_ggx_smith_g1(viewLocal, alpha);
    float maskingShadowing = masking
        * sampling_ggx_smith_g1(lightLocal, alpha);

    pdf = masking * distribution / (4.0 * max(viewLocal.z, 1e-8));
    return fresnel * distribution * maskingShadowing
        / (4.0 * max(lightLocal.z * viewLocal.z, 1e-8));
}

vec3 openpbr_eval_microfacet_refraction(
    OpenPbrResolvedMaterial material,
    float relativeIor,
    vec3 tint,
    vec3 viewLocal,
    vec3 lightLocal,
    vec3 halfVector,
    vec3 fresnel,
    out float pdf
) {
    pdf = 0.0;
    if (lightLocal.z >= 0.0) {
        return vec3(0.0);
    }

    float lightHalf = dot(lightLocal, halfVector);
    float viewHalf = dot(viewLocal, halfVector);
    vec2 alpha = vec2(material.alphaX, material.alphaY);
    float distribution = sampling_ggx_ndf(halfVector, alpha);
    float masking = sampling_ggx_smith_g1(viewLocal, alpha);
    float maskingShadowing = masking
        * sampling_ggx_smith_g1(lightLocal, alpha);
    float denominator = lightHalf + viewHalf * relativeIor;
    denominator *= denominator;
    float jacobian = abs(lightHalf) / max(denominator, 1e-8);
    float relativeIorSquared = relativeIor * relativeIor;

    pdf = masking * max(0.0, viewHalf) * distribution * jacobian
        / max(viewLocal.z, 1e-8);
    return tint * (vec3(1.0) - fresnel) * distribution * maskingShadowing
        * abs(viewHalf) * jacobian * relativeIorSquared
        / max(abs(lightLocal.z * viewLocal.z), 1e-8);
}

vec3 openpbr_transmission_tint(OpenPbrResolvedMaterial material) {
#ifdef HAS_MEDIUM
    if (material.mediumType > 0) {
        return vec3(1.0);
    }
#endif
    return material.transmissionColor;
}

float openpbr_thin_wall_fresnel(float singleInterfaceFresnel) {
    return 2.0 * singleInterfaceFresnel / (1.0 + singleInterfaceFresnel);
}

vec3 openpbr_thin_wall_reflection_coefficient(
    vec3 singleInterfaceFresnel,
    float transmissionWeight
) {
    vec3 windowFresnel = 2.0 * singleInterfaceFresnel
        / (vec3(1.0) + singleInterfaceFresnel);
    return mix(
        singleInterfaceFresnel,
        windowFresnel,
        clamp(transmissionWeight, 0.0, 1.0)
    );
}

vec3 openpbr_final_transmission_tint(
    OpenPbrResolvedMaterial material,
    float incidentCosine,
    float etaTOverEtaI
) {
    vec3 tint = openpbr_transmission_tint(material);
    if (!material.thinWalled) {
        return tint;
    }
    float incidentSineSquared = max(0.0, 1.0 - incidentCosine * incidentCosine);
    float transmittedSineSquared = incidentSineSquared
        / max(etaTOverEtaI * etaTOverEtaI, 1e-9);
    if (transmittedSineSquared >= 1.0) {
        return vec3(0.0);
    }
    float transmittedCosine = sqrt(1.0 - transmittedSineSquared);
    return pow(max(tint, vec3(0.0)), vec3(1.0 / max(transmittedCosine, 1e-5)));
}

vec3 openpbr_eval_subsurface_boundary(
    OpenPbrResolvedMaterial material,
    vec3 viewLocal,
    vec3 lightLocal,
    out float pdf
) {
    pdf = 0.0;
    if (viewLocal.z <= 0.0 || lightLocal.z >= 0.0) {
        return vec3(0.0);
    }
    float transmittedCosine = -lightLocal.z;
    float entryFresnel = sampling_dielectric_fresnel(
        viewLocal.z,
        material.relativeIor
    );
    pdf = transmittedCosine * INVPI;
    return vec3(1.0 - entryFresnel) * INVPI;
}

void openpbr_normalize_probabilities(inout OpenPbrPreparedBsdf prepared) {
    float total = prepared.fuzzProbability
        + prepared.coatProbability
        + prepared.metalProbability
        + prepared.specularProbability
        + prepared.transmissionProbability
        + prepared.diffuseProbability
        + prepared.subsurfaceProbability;
    if (total <= 1e-8) {
        prepared.fuzzProbability = 0.0;
        prepared.coatProbability = 0.0;
        prepared.metalProbability = 0.0;
        prepared.specularProbability = 0.0;
        prepared.transmissionProbability = 0.0;
        prepared.diffuseProbability = 0.0;
        prepared.subsurfaceProbability = 0.0;
        return;
    }
    float inverseTotal = 1.0 / total;
    prepared.fuzzProbability *= inverseTotal;
    prepared.coatProbability *= inverseTotal;
    prepared.metalProbability *= inverseTotal;
    prepared.specularProbability *= inverseTotal;
    prepared.transmissionProbability *= inverseTotal;
    prepared.diffuseProbability *= inverseTotal;
    prepared.subsurfaceProbability *= inverseTotal;
}

OpenPbrPreparedBsdf openpbr_prepare(
    vec3 tangent,
    OpenPbrResolvedMaterial material,
    vec3 viewDirection,
    vec3 normal
) {
    OpenPbrPreparedBsdf prepared;
    prepared.material = material;
    prepared.basis = openpbr_make_basis(
        tangent,
        normal,
        max(material.specularAnisotropy, material.coatAnisotropy)
    );
    prepared.viewLocal = openpbr_to_local(prepared.basis, viewDirection);
    prepared.diffuseColor = material.baseColor;

    float dielectricBaseWeight = 1.0 - material.baseMetalness;
    float opaqueDielectricWeight = dielectricBaseWeight
        * (1.0 - material.transmissionWeight);
    prepared.fuzzWeight = material.fuzzWeight;
    prepared.coatWeight = material.coatWeight;
    prepared.metalWeight = material.baseMetalness;
    prepared.specularWeight = dielectricBaseWeight;
    prepared.transmissionWeight = dielectricBaseWeight
        * material.transmissionWeight;
    prepared.diffuseWeight = opaqueDielectricWeight
        * (1.0 - material.subsurfaceWeight) * material.baseWeight;
    prepared.subsurfaceWeight = opaqueDielectricWeight
        * material.subsurfaceWeight;

    prepared.specularEtaTOverEtaI = openpbr_apply_specular_weight_to_ior(
        1.0 / material.relativeIor,
        material.specularWeight
    );
    prepared.material.relativeIor = 1.0 / prepared.specularEtaTOverEtaI;
    prepared.specularAlpha = material.specularRoughness
        * material.specularRoughness;
    float viewCosine = abs(prepared.viewLocal.z);
    float singleInterfaceFresnel = openpbr_dielectric_fresnel(
        viewCosine,
        prepared.material.relativeIor
    );
    vec3 dielectricFresnelEstimate = material.specularColor * (
        material.thinWalled
            ? mix(
                singleInterfaceFresnel,
                openpbr_thin_wall_fresnel(singleInterfaceFresnel),
                material.transmissionWeight
            )
            : singleInterfaceFresnel
    );
    vec3 metalFresnelEstimate = material.specularWeight * openpbr_metal_fresnel(
        viewCosine,
        material.baseWeight * material.baseColor,
        material.specularColor
    );
    float transmissionFresnel = material.thinWalled
        ? openpbr_thin_wall_fresnel(singleInterfaceFresnel)
        : singleInterfaceFresnel;
    vec3 transmissionTint = openpbr_final_transmission_tint(
        material,
        viewCosine,
        prepared.specularEtaTOverEtaI
    );
    float viewEnergyComplement = openpbr_opaque_energy_complement(
        prepared.specularEtaTOverEtaI,
        prepared.specularAlpha,
        viewCosine
    );
    float averageEnergyComplement = openpbr_opaque_average_energy_complement(
        prepared.specularEtaTOverEtaI,
        prepared.specularAlpha
    );
    prepared.diffuseSpecularEnergyCompensation = viewEnergyComplement
        / max(averageEnergyComplement, 1e-12);

    prepared.fuzzProbability = prepared.fuzzWeight
        * openpbr_luminance(material.fuzzColor)
        * max(openpbr_fuzz_directional_albedo(
            viewCosine,
            material.fuzzRoughness
        ), 0.02);
    prepared.coatProbability = prepared.coatWeight
        * sampling_dielectric_fresnel(viewCosine, 1.0 / material.coatIor);
    prepared.metalProbability = prepared.metalWeight
        * openpbr_luminance(metalFresnelEstimate);
    prepared.specularProbability = prepared.specularWeight
        * openpbr_luminance(dielectricFresnelEstimate);
    prepared.transmissionProbability = prepared.transmissionWeight
        * (1.0 - transmissionFresnel)
        * openpbr_luminance(transmissionTint);
    prepared.diffuseProbability = prepared.diffuseWeight
        * openpbr_luminance(prepared.diffuseColor)
        * prepared.diffuseSpecularEnergyCompensation;
    prepared.subsurfaceProbability = prepared.subsurfaceWeight
        * (1.0 - transmissionFresnel)
        * openpbr_luminance(material.subsurfaceColor)
        * prepared.diffuseSpecularEnergyCompensation;
    openpbr_normalize_probabilities(prepared);
    return prepared;
}

vec3 openpbr_eval_prepared(
    OpenPbrPreparedBsdf prepared,
    vec3 lightDirection,
    out float pdf
) {
    OpenPbrResolvedMaterial material = prepared.material;
    vec3 viewLocal = prepared.viewLocal;
    vec3 lightLocal = openpbr_to_local(prepared.basis, lightDirection);
    bool reflection = lightLocal.z * viewLocal.z > 0.0;

    vec3 halfVector;
    if (reflection) {
        halfVector = normalize(lightLocal + viewLocal);
    }
    else {
        halfVector = normalize(lightLocal + viewLocal * material.relativeIor);
    }
    if (halfVector.z < 0.0) {
        halfVector = -halfVector;
    }

    vec3 response = vec3(0.0);
    pdf = 0.0;
    float lobePdf = 0.0;
    float viewHalf = abs(dot(viewLocal, halfVector));
    float diffuseSpecularEnergyCompensation =
        prepared.diffuseSpecularEnergyCompensation
        * openpbr_opaque_energy_complement(
            prepared.specularEtaTOverEtaI,
            prepared.specularAlpha,
            abs(lightLocal.z)
        );

    if (reflection) {
        if (prepared.diffuseWeight > 0.0) {
            response += prepared.diffuseWeight * openpbr_eval_diffuse(
                material,
                prepared.diffuseColor,
                viewLocal,
                lightLocal,
                diffuseSpecularEnergyCompensation,
                lobePdf
            );
            pdf += prepared.diffuseProbability * lobePdf;
        }

        if (prepared.subsurfaceWeight > 0.0 && material.thinWalled) {
            response += 0.5 * prepared.subsurfaceWeight * openpbr_eval_diffuse(
                material,
                material.subsurfaceColor,
                viewLocal,
                lightLocal,
                diffuseSpecularEnergyCompensation,
                lobePdf
            );
            pdf += prepared.subsurfaceProbability * 0.5 * lobePdf;
        }

        if (prepared.specularWeight > 0.0) {
            vec3 dielectricFresnel = vec3(openpbr_dielectric_fresnel(
                viewHalf,
                material.relativeIor
            ));
            if (material.thinFilmWeight > 0.0) {
                dielectricFresnel = openpbr_apply_dielectric_thin_film(
                    dielectricFresnel,
                    viewHalf,
                    material.thinFilmThickness,
                    material.thinFilmIor,
                    prepared.specularEtaTOverEtaI,
                    material.thinFilmWeight
                );
            }
            if (material.thinWalled) {
                dielectricFresnel = openpbr_thin_wall_reflection_coefficient(
                    dielectricFresnel,
                    material.transmissionWeight
                );
            }
            vec3 fresnel = material.specularColor * dielectricFresnel;
            response += prepared.specularWeight * openpbr_eval_microfacet_reflection(
                material,
                viewLocal,
                lightLocal,
                halfVector,
                fresnel,
                lobePdf
            );
            pdf += prepared.specularProbability * lobePdf;
        }

        if (prepared.metalWeight > 0.0) {
            vec3 fresnel = openpbr_metal_fresnel(
                viewHalf,
                material.baseWeight * material.baseColor,
                material.specularColor
            );
            if (material.thinFilmWeight > 0.0) {
                fresnel = openpbr_apply_metal_thin_film(
                    fresnel,
                    viewHalf,
                    material.thinFilmThickness,
                    material.thinFilmIor,
                    material.baseWeight * material.baseColor,
                    material.specularColor,
                    material.thinFilmWeight
                );
            }
            fresnel *= material.specularWeight;
            response += prepared.metalWeight * openpbr_eval_microfacet_reflection(
                material,
                viewLocal,
                lightLocal,
                halfVector,
                fresnel,
                lobePdf
            );
            pdf += prepared.metalProbability * lobePdf;
        }
    }
    else {
        vec3 fresnel = vec3(sampling_dielectric_fresnel(
            viewHalf,
            material.relativeIor
        ));
        if (material.thinFilmWeight > 0.0) {
            fresnel = openpbr_apply_dielectric_thin_film(
                fresnel,
                viewHalf,
                material.thinFilmThickness,
                material.thinFilmIor,
                prepared.specularEtaTOverEtaI,
                material.thinFilmWeight
            );
        }
        if (prepared.transmissionWeight > 0.0) {
            if (material.thinWalled) {
                vec3 mirroredLight = vec3(lightLocal.xy, -lightLocal.z);
                vec3 thinWallHalf = normalize(mirroredLight + viewLocal);
                if (thinWallHalf.z < 0.0) {
                    thinWallHalf = -thinWallHalf;
                }
                float thinWallViewHalf = abs(dot(viewLocal, thinWallHalf));
                vec3 thinWallFresnel = vec3(openpbr_dielectric_fresnel(
                    thinWallViewHalf,
                    prepared.material.relativeIor
                ));
                if (material.thinFilmWeight > 0.0) {
                    thinWallFresnel = openpbr_apply_dielectric_thin_film(
                        thinWallFresnel,
                        thinWallViewHalf,
                        material.thinFilmThickness,
                        material.thinFilmIor,
                        prepared.specularEtaTOverEtaI,
                        material.thinFilmWeight
                    );
                }
                vec3 windowFresnel = openpbr_thin_wall_reflection_coefficient(
                    thinWallFresnel,
                    1.0
                );
                vec3 tint = openpbr_final_transmission_tint(
                    material,
                    abs(viewLocal.z),
                    prepared.specularEtaTOverEtaI
                );
                response += prepared.transmissionWeight
                    * openpbr_eval_microfacet_reflection(
                        material,
                        viewLocal,
                        mirroredLight,
                        thinWallHalf,
                        tint * (vec3(1.0) - windowFresnel),
                        lobePdf
                    );
            }
            else {
                response += prepared.transmissionWeight
                    * openpbr_eval_microfacet_refraction(
                        material,
                        material.relativeIor,
                        openpbr_transmission_tint(material),
                        viewLocal,
                        lightLocal,
                        halfVector,
                        fresnel,
                        lobePdf
                    );
            }
            pdf += prepared.transmissionProbability * lobePdf;
        }
        if (prepared.subsurfaceWeight > 0.0) {
            if (material.thinWalled) {
                vec3 flippedLight = vec3(lightLocal.xy, -lightLocal.z);
                response += 0.5 * prepared.subsurfaceWeight
                    * openpbr_eval_diffuse(
                        material,
                        material.subsurfaceColor,
                        viewLocal,
                        flippedLight,
                        diffuseSpecularEnergyCompensation,
                        lobePdf
                    );
                lobePdf *= 0.5;
            }
            else {
                response += prepared.subsurfaceWeight * openpbr_eval_subsurface_boundary(
                    material,
                    viewLocal,
                    lightLocal,
                    lobePdf
                );
            }
            pdf += prepared.subsurfaceProbability * lobePdf;
        }
    }

    if (reflection && prepared.coatWeight > 0.0) {
        vec3 coatFresnel = vec3(sampling_dielectric_fresnel(
            viewHalf,
            1.0 / material.coatIor
        )) * material.coatColor;
        OpenPbrResolvedMaterial coatMaterial = material;
        vec2 coatAlpha = openpbr_roughness_to_alpha(material.coatRoughness, material.coatAnisotropy);
        coatMaterial.alphaX = coatAlpha.x;
        coatMaterial.alphaY = coatAlpha.y;
        vec3 attenuation = vec3(1.0)
            - coatFresnel * prepared.coatWeight;
        attenuation *= mix(
            vec3(1.0),
            material.coatColor,
            prepared.coatWeight * material.coatDarkening
        );
        response *= attenuation;
        response += prepared.coatWeight * openpbr_eval_microfacet_reflection(
            coatMaterial,
            viewLocal,
            lightLocal,
            halfVector,
            coatFresnel,
            lobePdf
        );
        pdf += prepared.coatProbability * lobePdf;
    }

    if (reflection && prepared.fuzzWeight > 0.0) {
        float fuzzAlbedo = openpbr_fuzz_directional_albedo(
            abs(viewLocal.z),
            material.fuzzRoughness
        );
        response *= max(
            vec3(0.0),
            vec3(1.0 - prepared.fuzzWeight * fuzzAlbedo)
        );
        response += prepared.fuzzWeight * openpbr_eval_fuzz(
            material,
            viewLocal,
            lightLocal,
            lobePdf
        );
        pdf += prepared.fuzzProbability * lobePdf;
    }

    return response * abs(lightLocal.z);
}

vec3 openpbr_eval(
    vec3 tangent,
    OpenPbrResolvedMaterial material,
    vec3 viewDirection,
    vec3 normal,
    vec3 lightDirection,
    out float pdf
) {
    OpenPbrPreparedBsdf prepared = openpbr_prepare(
        tangent,
        material,
        viewDirection,
        normal
    );
    return openpbr_eval_prepared(prepared, lightDirection, pdf);
}

float openpbr_pdf(
    vec3 tangent,
    OpenPbrResolvedMaterial material,
    vec3 viewDirection,
    vec3 normal,
    vec3 lightDirection
) {
    float pdf;
    openpbr_eval(
        tangent,
        material,
        viewDirection,
        normal,
        lightDirection,
        pdf
    );
    return pdf;
}

vec3 openpbr_sample(
    vec3 tangent,
    OpenPbrResolvedMaterial material,
    vec3 randomSamples,
    vec3 viewDirection,
    vec3 normal,
    out vec3 lightDirection,
    out float pdf,
    out bool isTransmissionEvent
) {
    OpenPbrPreparedBsdf prepared = openpbr_prepare(
        tangent,
        material,
        viewDirection,
        normal
    );
    vec3 viewLocal = prepared.viewLocal;
    float randomX = randomSamples.x;
    float randomY = randomSamples.y;
    float lobeSample = randomSamples.z;
    pdf = 0.0;
    isTransmissionEvent = false;
    lightDirection = normal;

    // At eta=1 the solid-refraction half vector is the zero vector. Treat the
    // physically null interface as straight, unit-throughput transmission.
    if (!prepared.material.thinWalled &&
        abs(prepared.material.relativeIor - 1.0) <= 1e-6 &&
        prepared.transmissionProbability >= 1.0 - 1e-6) {
        lightDirection = openpbr_to_world(prepared.basis, -viewLocal);
        pdf = 1.0;
        isTransmissionEvent = true;
        return openpbr_transmission_tint(prepared.material);
    }

    float fuzzCdf = prepared.fuzzProbability;
    float coatCdf = fuzzCdf + prepared.coatProbability;
    float metalCdf = coatCdf + prepared.metalProbability;
    float specularCdf = metalCdf + prepared.specularProbability;
    float transmissionCdf = specularCdf + prepared.transmissionProbability;
    float diffuseCdf = transmissionCdf + prepared.diffuseProbability;
    float subsurfaceCdf = diffuseCdf + prepared.subsurfaceProbability;
    if (subsurfaceCdf <= 0.0) {
        return vec3(0.0);
    }

    vec3 lightLocal;
    if (lobeSample < fuzzCdf || (
        lobeSample >= transmissionCdf && lobeSample < diffuseCdf
    )) {
        lightLocal = sampling_cosine_hemisphere(vec2(randomX, randomY));
    }
    else if (lobeSample < coatCdf) {
        vec3 halfVector = sampling_ggx_visible_normal(
            viewLocal,
            // The VNDF must use the same alpha as the evaluated coat PDF.
            openpbr_roughness_to_alpha(material.coatRoughness, material.coatAnisotropy),
            vec2(randomX, randomY)
        );
        if (halfVector.z < 0.0) {
            halfVector = -halfVector;
        }
        lightLocal = normalize(reflect(-viewLocal, halfVector));
    }
    else if (lobeSample < specularCdf) {
        vec3 halfVector = sampling_ggx_visible_normal(
            viewLocal,
            vec2(material.alphaX, material.alphaY),
            vec2(randomX, randomY)
        );
        if (halfVector.z < 0.0) {
            halfVector = -halfVector;
        }
        lightLocal = normalize(reflect(-viewLocal, halfVector));
    }
    else if (lobeSample < transmissionCdf) {
        isTransmissionEvent = true;
        vec3 halfVector = sampling_ggx_visible_normal(
            viewLocal,
            vec2(material.alphaX, material.alphaY),
            vec2(randomX, randomY)
        );
        if (halfVector.z < 0.0) {
            halfVector = -halfVector;
        }
        float viewHalf = abs(dot(viewLocal, halfVector));
        vec3 fresnel = vec3(openpbr_dielectric_fresnel(
            viewHalf,
            prepared.material.relativeIor
        ));
        if (material.thinFilmWeight > 0.0) {
            fresnel = openpbr_apply_dielectric_thin_film(
                fresnel,
                viewHalf,
                material.thinFilmThickness,
                material.thinFilmIor,
                prepared.specularEtaTOverEtaI,
                material.thinFilmWeight
            );
        }
        if (material.thinWalled) {
            vec3 reflectedLocal = normalize(reflect(-viewLocal, halfVector));
            lightLocal = vec3(reflectedLocal.xy, -reflectedLocal.z);
        }
        else {
            lightLocal = refract(
                -viewLocal,
                halfVector,
                prepared.material.relativeIor
            );
            if (dot(lightLocal, lightLocal) <= 1e-8) {
                isTransmissionEvent = false;
                return vec3(0.0);
            }
            lightLocal = normalize(lightLocal);
        }
    }
    else {
        isTransmissionEvent = true;
        if (material.thinWalled) {
            float hemisphereSample = randomX;
            bool transmit = hemisphereSample >= 0.5;
            randomX = transmit
                ? (hemisphereSample - 0.5) * 2.0
                : hemisphereSample * 2.0;
            lightLocal = sampling_cosine_hemisphere(vec2(randomX, randomY));
            if (transmit) {
                lightLocal.z = -lightLocal.z;
            }
            else {
                isTransmissionEvent = false;
            }
        }
        else {
            lightLocal = sampling_cosine_hemisphere(vec2(randomX, randomY));
            lightLocal.z = -lightLocal.z;
        }
    }

    lightDirection = openpbr_to_world(prepared.basis, lightLocal);
    // Reject VNDF draws on the wrong side before aggregate BSDF evaluation.
    if (lightLocal.z == 0.0 || (lightLocal.z < 0.0) != isTransmissionEvent) {
        return vec3(0.0);
    }
    return openpbr_eval_prepared(prepared, lightDirection, pdf);
}`;
