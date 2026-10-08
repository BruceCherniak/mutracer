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

export default /* wgsl */ `
const OPENPBR_LOBE_FUZZ: i32 = 0;
const OPENPBR_LOBE_COAT: i32 = 1;
const OPENPBR_LOBE_METAL: i32 = 2;
const OPENPBR_LOBE_SPECULAR: i32 = 3;
const OPENPBR_LOBE_TRANSMISSION: i32 = 4;
const OPENPBR_LOBE_DIFFUSE: i32 = 5;
const OPENPBR_LOBE_SUBSURFACE: i32 = 6;

struct OpenPbrBasis {
    tangent: vec3f,
    bitangent: vec3f,
    normal: vec3f,
};

struct OpenPbrPreparedBsdf {
    material: OpenPbrResolvedMaterial,
    basis: OpenPbrBasis,
    viewLocal: vec3f,
    diffuseColor: vec3f,
    specularEtaTOverEtaI: f32,
    specularAlpha: f32,
    diffuseSpecularEnergyCompensation: f32,

    fuzzWeight: f32,
    coatWeight: f32,
    metalWeight: f32,
    specularWeight: f32,
    transmissionWeight: f32,
    diffuseWeight: f32,
    subsurfaceWeight: f32,

    fuzzProbability: f32,
    coatProbability: f32,
    metalProbability: f32,
    specularProbability: f32,
    transmissionProbability: f32,
    diffuseProbability: f32,
    subsurfaceProbability: f32,
};

fn openpbr_luminance(color: vec3f) -> f32 {
    return dot(color, vec3f(0.212671, 0.715160, 0.072169));
}

fn openpbr_f0_from_ior(etaTOverEtaI: f32) -> f32 {
    let value = (etaTOverEtaI - 1.0) / (etaTOverEtaI + 1.0);
    return value * value;
}

fn openpbr_apply_specular_weight_to_ior(
    etaTOverEtaI: f32,
    specularWeight: f32
) -> f32 {
    let scaledF0 = min(
        openpbr_f0_from_ior(etaTOverEtaI) * specularWeight,
        0.9999
    );
    let sqrtF0 = sqrt(scaledF0);
    let externalIor = (1.0 + sqrtF0) / (1.0 - sqrtF0);
    return select(externalIor, 1.0 / externalIor, etaTOverEtaI < 1.0);
}

fn openpbr_dielectric_fresnel(cosTheta: f32, relativeIor: f32) -> f32 {
    if (abs(relativeIor - 1.0) < 1e-6) {
        return 0.0;
    }
    return sampling_dielectric_fresnel(cosTheta, relativeIor);
}

fn openpbr_energy_ior_index(ior: f32) -> f32 {
    if (ior < 1.0) {
        return 15.0 - ((1.0 / ior - 1.0) / 1.5) * 15.0;
    }
    return 16.0 + ((ior - 1.0) / 1.5) * 15.0;
}

fn openpbr_energy_fetch(cosIndex: i32, row: i32) -> f32 {
    return textureLoad(openPbrEnergyLut, vec2i(cosIndex, row), 0).r;
}

fn openpbr_energy_trilinear(
    exactIor: f32,
    exactAlpha: f32,
    exactCosine: f32
) -> f32 {
    let iorIndex = clamp(exactIor, 0.0, 31.0);
    let alphaIndex = clamp(exactAlpha, 0.0, 31.0);
    let cosineIndex = clamp(exactCosine, 0.0, 31.0);
    let ior0 = i32(floor(iorIndex));
    let alpha0 = i32(floor(alphaIndex));
    let cosine0 = i32(floor(cosineIndex));
    let ior1 = min(ior0 + 1, 31);
    let alpha1 = min(alpha0 + 1, 31);
    let cosine1 = min(cosine0 + 1, 31);
    let iorMix = iorIndex - f32(ior0);
    let alphaMix = alphaIndex - f32(alpha0);
    let cosineMix = cosineIndex - f32(cosine0);

    let v000 = openpbr_energy_fetch(cosine0, ior0 * 32 + alpha0);
    let v001 = openpbr_energy_fetch(cosine1, ior0 * 32 + alpha0);
    let v010 = openpbr_energy_fetch(cosine0, ior0 * 32 + alpha1);
    let v011 = openpbr_energy_fetch(cosine1, ior0 * 32 + alpha1);
    let v100 = openpbr_energy_fetch(cosine0, ior1 * 32 + alpha0);
    let v101 = openpbr_energy_fetch(cosine1, ior1 * 32 + alpha0);
    let v110 = openpbr_energy_fetch(cosine0, ior1 * 32 + alpha1);
    let v111 = openpbr_energy_fetch(cosine1, ior1 * 32 + alpha1);
    let v00 = mix(v000, v100, iorMix);
    let v01 = mix(v001, v101, iorMix);
    let v10 = mix(v010, v110, iorMix);
    let v11 = mix(v011, v111, iorMix);
    return mix(
        mix(v00, v10, alphaMix),
        mix(v01, v11, alphaMix),
        cosineMix
    );
}

fn openpbr_energy_bilinear(exactIor: f32, exactAlpha: f32) -> f32 {
    let iorIndex = clamp(exactIor, 0.0, 31.0);
    let alphaIndex = clamp(exactAlpha, 0.0, 31.0);
    let ior0 = i32(floor(iorIndex));
    let alpha0 = i32(floor(alphaIndex));
    let ior1 = min(ior0 + 1, 31);
    let alpha1 = min(alpha0 + 1, 31);
    let iorMix = iorIndex - f32(ior0);
    let alphaMix = alphaIndex - f32(alpha0);
    let v00 = openpbr_energy_fetch(alpha0, 1024 + ior0);
    let v01 = openpbr_energy_fetch(alpha1, 1024 + ior0);
    let v10 = openpbr_energy_fetch(alpha0, 1024 + ior1);
    let v11 = openpbr_energy_fetch(alpha1, 1024 + ior1);
    return mix(
        mix(v00, v10, iorMix),
        mix(v01, v11, iorMix),
        alphaMix
    );
}

fn openpbr_extrapolate_energy_complement(value: f32, ior: f32) -> f32 {
    if (ior > 2.5 || ior < 0.4) {
        let maxF0 = openpbr_f0_from_ior(2.5);
        let progress = (openpbr_f0_from_ior(ior) - maxF0) / (1.0 - maxF0);
        return (1.0 - progress) * value;
    }
    return value;
}

fn openpbr_opaque_energy_complement(
    ior: f32,
    alpha: f32,
    cosine: f32
) -> f32 {
    let value = openpbr_energy_trilinear(
        openpbr_energy_ior_index(ior),
        sqrt(alpha) * 31.0,
        cosine * 31.0
    );
    return openpbr_extrapolate_energy_complement(value, ior);
}

fn openpbr_opaque_average_energy_complement(ior: f32, alpha: f32) -> f32 {
    let value = openpbr_energy_bilinear(
        openpbr_energy_ior_index(ior),
        sqrt(alpha) * 31.0
    );
    return openpbr_extrapolate_energy_complement(value, ior);
}

fn openpbr_to_world(basis: OpenPbrBasis, direction: vec3f) -> vec3f {
    return direction.x * basis.tangent
        + direction.y * basis.bitangent
        + direction.z * basis.normal;
}

fn openpbr_to_local(basis: OpenPbrBasis, direction: vec3f) -> vec3f {
    return vec3f(
        dot(direction, basis.tangent),
        dot(direction, basis.bitangent),
        dot(direction, basis.normal)
    );
}

fn openpbr_make_basis(
    inputTangent: vec3f,
    normal: vec3f,
    anisotropy: f32
) -> OpenPbrBasis {
    var basis: OpenPbrBasis;
    basis.normal = normal;
    var tangent = inputTangent;
    var bitangent = vec3f(0.0);
    if (dot(tangent, tangent) < 0.001 || anisotropy < 0.001) {
        sampling_orthonormal_basis(normal, &tangent, &bitangent);
    }
    else {
        bitangent = normalize(cross(normal, tangent));
        tangent = normalize(cross(bitangent, normal));
    }
    basis.tangent = tangent;
    basis.bitangent = bitangent;
    return basis;
}

fn openpbr_fresnel_s(
    incidentIor: f32,
    transmittedIor: f32,
    incidentCosine: f32,
    transmittedCosine: f32
) -> f32 {
    return (incidentIor * incidentCosine - transmittedIor * transmittedCosine)
        / (incidentIor * incidentCosine + transmittedIor * transmittedCosine);
}

fn openpbr_fresnel_p(
    incidentIor: f32,
    transmittedIor: f32,
    incidentCosine: f32,
    transmittedCosine: f32
) -> f32 {
    return (transmittedIor * incidentCosine - incidentIor * transmittedCosine)
        / (incidentIor * transmittedCosine + transmittedIor * incidentCosine);
}

fn openpbr_transmission_s(
    incidentIor: f32,
    transmittedIor: f32,
    incidentCosine: f32,
    transmittedCosine: f32
) -> f32 {
    return 2.0 * incidentIor * incidentCosine
        / (incidentIor * incidentCosine + transmittedIor * transmittedCosine);
}

fn openpbr_transmission_p(
    incidentIor: f32,
    transmittedIor: f32,
    incidentCosine: f32,
    transmittedCosine: f32
) -> f32 {
    return 2.0 * incidentIor * incidentCosine
        / (incidentIor * transmittedCosine + transmittedIor * incidentCosine);
}

fn openpbr_complex_multiply(a: vec2f, b: vec2f) -> vec2f {
    return vec2f(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

fn openpbr_complex_divide(a: vec2f, b: vec2f) -> vec2f {
    let denominator = max(dot(b, b), 1e-9);
    return vec2f(
        (a.x * b.x + a.y * b.y) / denominator,
        (a.y * b.x - a.x * b.y) / denominator
    );
}

fn openpbr_complex_sqrt(value: vec2f) -> vec2f {
    let magnitude = length(value);
    let realPart = sqrt(max(0.0, 0.5 * (magnitude + value.x)));
    let imaginaryMagnitude = sqrt(max(0.0, 0.5 * (magnitude - value.x)));
    return vec2f(realPart, select(-imaginaryMagnitude, imaginaryMagnitude, value.y >= 0.0));
}

fn openpbr_complex_fresnel_reflection(
    incidentCosine: f32,
    incidentIor: f32,
    transmittedIor: vec2f,
    pPolarized: bool
) -> vec2f {
    let incidentSine = sqrt(max(0.0, 1.0 - incidentCosine * incidentCosine));
    let iorRatio = openpbr_complex_divide(vec2f(incidentIor, 0.0), transmittedIor);
    let transmittedSine = iorRatio * incidentSine;
    var transmittedCosine = openpbr_complex_sqrt(
        vec2f(1.0, 0.0) - openpbr_complex_multiply(transmittedSine, transmittedSine)
    );
    if (openpbr_complex_multiply(transmittedIor, transmittedCosine).y < 0.0) {
        transmittedCosine = -transmittedCosine;
    }

    let incidentIorCosine = vec2f(incidentIor * incidentCosine, 0.0);
    let transmittedIorCosine = openpbr_complex_multiply(transmittedIor, transmittedCosine);
    if (pPolarized) {
        let transmittedIorIncidentCosine = transmittedIor * incidentCosine;
        let incidentIorTransmittedCosine = transmittedCosine * incidentIor;
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

fn openpbr_airy_reflectance(
    reflection12: f32,
    transmission12: f32,
    reflection21: f32,
    transmission21: f32,
    reflection23: vec2f,
    phase: f32
) -> f32 {
    let phaseRotation = vec2f(cos(phase), sin(phase));
    let reflectedPhase = openpbr_complex_multiply(reflection23, phaseRotation);
    let numerator = reflectedPhase * (transmission12 * transmission21);
    let denominator = vec2f(1.0, 0.0) - reflectedPhase * reflection21;
    let totalReflection = vec2f(reflection12, 0.0)
        + openpbr_complex_divide(numerator, denominator);
    return dot(totalReflection, totalReflection);
}

fn openpbr_thin_film_reflectance_channel(
    incidentCosine: f32,
    wavelength: f32,
    thickness: f32,
    exteriorIor: f32,
    filmIor: f32,
    substrateIor: vec2f
) -> f32 {
    let safeIncidentCosine = clamp(abs(incidentCosine), 1e-5, 1.0);
    let filmSineSquared = pow(exteriorIor / filmIor, 2.0)
        * (1.0 - safeIncidentCosine * safeIncidentCosine);
    if (filmSineSquared >= 1.0) {
        return 1.0;
    }
    let filmCosine = sqrt(1.0 - filmSineSquared);
    let reflection12S = openpbr_fresnel_s(
        exteriorIor, filmIor, safeIncidentCosine, filmCosine
    );
    let reflection12P = openpbr_fresnel_p(
        exteriorIor, filmIor, safeIncidentCosine, filmCosine
    );
    let transmission12S = openpbr_transmission_s(
        exteriorIor, filmIor, safeIncidentCosine, filmCosine
    );
    let transmission12P = openpbr_transmission_p(
        exteriorIor, filmIor, safeIncidentCosine, filmCosine
    );
    let transmission21Scale = filmIor * filmCosine
        / max(exteriorIor * safeIncidentCosine, 1e-9);
    let phase = 2.0 * PI * (2.0 * filmIor * thickness * filmCosine) / wavelength;
    var reflectance = 0.0;
    // Both polarizations share Snell's complex solve and the Airy graph.
    for (var polarization = 0u; polarization < 2u; polarization++) {
        let reflection12 = select(reflection12S, reflection12P, polarization == 1u);
        let transmission12 = select(transmission12S, transmission12P, polarization == 1u);
        let reflection23 = openpbr_complex_fresnel_reflection(
            filmCosine, filmIor, substrateIor, polarization == 1u);
        reflectance += openpbr_airy_reflectance(reflection12, transmission12,
            -reflection12, transmission12 * transmission21Scale, reflection23, phase);
    }
    return clamp(0.5 * reflectance, 0.0, 1.0);
}


fn openpbr_metal_complex_ior(f0: f32, f82Tint: f32) -> vec2f {
    let reflectivity = clamp(f0, 0.0, 0.99);
    let sqrtReflectivity = sqrt(reflectivity);
    let minimumIor = (1.0 - reflectivity) / (1.0 + reflectivity);
    let maximumIor = (1.0 + sqrtReflectivity) / max(1.0 - sqrtReflectivity, 1e-9);
    let ior = mix(maximumIor, minimumIor, clamp(f82Tint, 0.0, 1.0));
    let extinctionSquared = (
        (ior + 1.0) * (ior + 1.0) * reflectivity
        - (ior - 1.0) * (ior - 1.0)
    ) / max(1.0 - reflectivity, 1e-9);
    return vec2f(ior, sqrt(max(extinctionSquared, 0.0)));
}


fn openpbr_thin_film_presence(thickness: f32, weight: f32) -> f32 {
    return clamp(weight, 0.0, 1.0) * smoothstep(1e-9, 30.0, thickness);
}



fn openpbr_eval_diffuse(
    material: OpenPbrResolvedMaterial,
    color: vec3f,
    viewLocal: vec3f,
    lightLocal: vec3f,
    specularEnergyCompensation: f32,
    pdf: ptr<function, f32>
) -> vec3f {
    *pdf = 0.0;
    if (lightLocal.z <= 0.0) {
        return vec3f(0.0);
    }

    let roughness = material.diffuseRoughness;
    let fonConstantA = 0.5 - 2.0 / (3.0 * PI);
    let fonConstantB = 2.0 / 3.0 - 28.0 / (15.0 * PI);
    let muInput = lightLocal.z;
    let muOutput = viewLocal.z;
    let directional = dot(lightLocal, viewLocal) - muInput * muOutput;
    let directionalOverTangent = select(
        directional,
        directional / max(max(muInput, muOutput), 1e-7),
        directional > 0.0
    );
    let singleScatterA = 1.0 / (1.0 + fonConstantA * roughness);
    let singleScatter = color * INVPI * singleScatterA
        * (1.0 + roughness * directionalOverTangent);

    let inputComplement = 1.0 - muInput;
    let outputComplement = 1.0 - muOutput;
    let inputGOverPi = inputComplement * (
        0.0571085289 + inputComplement * (
            0.491881867 + inputComplement * (
                -0.332181442 + inputComplement * 0.0714429953
            )
        )
    );
    let outputGOverPi = outputComplement * (
        0.0571085289 + outputComplement * (
            0.491881867 + outputComplement * (
                -0.332181442 + outputComplement * 0.0714429953
            )
        )
    );
    let inputAlbedo = (1.0 + roughness * inputGOverPi)
        / (1.0 + fonConstantA * roughness);
    let outputAlbedo = (1.0 + roughness * outputGOverPi)
        / (1.0 + fonConstantA * roughness);
    let averageAlbedo = singleScatterA * (1.0 + fonConstantB * roughness);
    let multipleScatterAlbedo = color * color * averageAlbedo
        / max(vec3f(1e-7), vec3f(1.0) - color * (1.0 - averageAlbedo));
    let multipleScatter = multipleScatterAlbedo * INVPI
        * max(1e-7, 1.0 - outputAlbedo)
        * max(1e-7, 1.0 - inputAlbedo)
        / max(1e-7, 1.0 - averageAlbedo);
    *pdf = lightLocal.z * INVPI;
    return (singleScatter + multipleScatter) * specularEnergyCompensation;
}

fn openpbr_fuzz_directional_albedo(viewCosine: f32, roughness: f32) -> f32 {
    let x = clamp(viewCosine, 0.0, 1.0);
    let y = clamp(roughness, 0.01, 1.0);
    let scale = y * (0.0206607 + 1.58491 * y)
        / (0.0379424 + y * (1.32227 + y));
    let mean = y * (-0.193854 + y * (-1.14885 + y * (1.7932 - 0.95943 * y * y)))
        / (0.046391 + y);
    let offset = y * (0.000654023 + (-0.0207818 + 0.119681 * y) * y)
        / (1.26264 + y * (-1.92021 + y));
    let gaussian = exp(-0.5 * pow((x - mean) / scale, 2.0))
        / (scale * sqrt(2.0 * PI));
    return max(gaussian + offset, 0.0);
}

fn openpbr_eval_fuzz(
    material: OpenPbrResolvedMaterial,
    viewLocal: vec3f,
    lightLocal: vec3f,
    pdf: ptr<function, f32>
) -> vec3f {
    *pdf = 0.0;
    if (viewLocal.z <= 0.0 || lightLocal.z <= 0.0) {
        return vec3f(0.0);
    }
    let albedo = openpbr_fuzz_directional_albedo(
        viewLocal.z,
        material.fuzzRoughness
    );
    *pdf = lightLocal.z * INVPI;
    return material.fuzzColor * albedo * INVPI;
}

fn openpbr_eval_microfacet_reflection(
    material: OpenPbrResolvedMaterial,
    viewLocal: vec3f,
    lightLocal: vec3f,
    halfVector: vec3f,
    fresnel: vec3f,
    pdf: ptr<function, f32>
) -> vec3f {
    *pdf = 0.0;
    if (lightLocal.z <= 0.0) {
        return vec3f(0.0);
    }

    let alpha = vec2f(material.alphaX, material.alphaY);
    let distribution = sampling_ggx_ndf(halfVector, alpha);
    let masking = sampling_ggx_smith_g1(viewLocal, alpha);
    let maskingShadowing = masking
        * sampling_ggx_smith_g1(lightLocal, alpha);

    *pdf = masking * distribution / (4.0 * max(viewLocal.z, 1e-8));
    return fresnel * distribution * maskingShadowing
        / (4.0 * max(lightLocal.z * viewLocal.z, 1e-8));
}

fn openpbr_eval_microfacet_refraction(
    material: OpenPbrResolvedMaterial,
    relativeIor: f32,
    tint: vec3f,
    viewLocal: vec3f,
    lightLocal: vec3f,
    halfVector: vec3f,
    fresnel: vec3f,
    pdf: ptr<function, f32>
) -> vec3f {
    *pdf = 0.0;
    if (lightLocal.z >= 0.0) {
        return vec3f(0.0);
    }

    let lightHalf = dot(lightLocal, halfVector);
    let viewHalf = dot(viewLocal, halfVector);
    let alpha = vec2f(material.alphaX, material.alphaY);
    let distribution = sampling_ggx_ndf(halfVector, alpha);
    let masking = sampling_ggx_smith_g1(viewLocal, alpha);
    let maskingShadowing = masking
        * sampling_ggx_smith_g1(lightLocal, alpha);
    var denominator = lightHalf + viewHalf * relativeIor;
    denominator *= denominator;
    let jacobian = abs(lightHalf) / max(denominator, 1e-8);
    let relativeIorSquared = relativeIor * relativeIor;

    *pdf = masking * max(0.0, viewHalf) * distribution * jacobian
        / max(viewLocal.z, 1e-8);
    return tint * (vec3f(1.0) - fresnel) * distribution * maskingShadowing
        * abs(viewHalf) * jacobian * relativeIorSquared
        / max(abs(lightLocal.z * viewLocal.z), 1e-8);
}

fn openpbr_transmission_tint(material: OpenPbrResolvedMaterial) -> vec3f {
    if (HAS_MEDIUM && material.mediumType > 0) {
        return vec3f(1.0);
    }
    return material.transmissionColor;
}

fn openpbr_thin_wall_fresnel(singleInterfaceFresnel: f32) -> f32 {
    return 2.0 * singleInterfaceFresnel / (1.0 + singleInterfaceFresnel);
}

fn openpbr_thin_wall_reflection_coefficient(
    singleInterfaceFresnel: vec3f,
    transmissionWeight: f32
) -> vec3f {
    let windowFresnel = 2.0 * singleInterfaceFresnel
        / (vec3f(1.0) + singleInterfaceFresnel);
    return mix(
        singleInterfaceFresnel,
        windowFresnel,
        clamp(transmissionWeight, 0.0, 1.0)
    );
}

fn openpbr_final_transmission_tint(
    material: OpenPbrResolvedMaterial,
    incidentCosine: f32,
    etaTOverEtaI: f32
) -> vec3f {
    let tint = openpbr_transmission_tint(material);
    if (!material.thinWalled) {
        return tint;
    }
    let incidentSineSquared = max(0.0, 1.0 - incidentCosine * incidentCosine);
    let transmittedSineSquared = incidentSineSquared
        / max(etaTOverEtaI * etaTOverEtaI, 1e-9);
    if (transmittedSineSquared >= 1.0) {
        return vec3f(0.0);
    }
    let transmittedCosine = sqrt(1.0 - transmittedSineSquared);
    return pow(max(tint, vec3f(0.0)), vec3f(1.0 / max(transmittedCosine, 1e-5)));
}

fn openpbr_eval_subsurface_boundary(
    material: OpenPbrResolvedMaterial,
    viewLocal: vec3f,
    lightLocal: vec3f,
    pdf: ptr<function, f32>
) -> vec3f {
    *pdf = 0.0;
    if (viewLocal.z <= 0.0 || lightLocal.z >= 0.0) {
        return vec3f(0.0);
    }
    let transmittedCosine = -lightLocal.z;
    let entryFresnel = sampling_dielectric_fresnel(
        viewLocal.z,
        material.relativeIor
    );
    *pdf = transmittedCosine * INVPI;
    return vec3f(1.0 - entryFresnel) * INVPI;
}

fn openpbr_normalize_probabilities(prepared: ptr<function, OpenPbrPreparedBsdf>) {
    let total = (*prepared).fuzzProbability
        + (*prepared).coatProbability
        + (*prepared).metalProbability
        + (*prepared).specularProbability
        + (*prepared).transmissionProbability
        + (*prepared).diffuseProbability
        + (*prepared).subsurfaceProbability;
    if (total <= 1e-8) {
        (*prepared).fuzzProbability = 0.0;
        (*prepared).coatProbability = 0.0;
        (*prepared).metalProbability = 0.0;
        (*prepared).specularProbability = 0.0;
        (*prepared).transmissionProbability = 0.0;
        (*prepared).diffuseProbability = 0.0;
        (*prepared).subsurfaceProbability = 0.0;
        return;
    }
    let inverseTotal = 1.0 / total;
    (*prepared).fuzzProbability *= inverseTotal;
    (*prepared).coatProbability *= inverseTotal;
    (*prepared).metalProbability *= inverseTotal;
    (*prepared).specularProbability *= inverseTotal;
    (*prepared).transmissionProbability *= inverseTotal;
    (*prepared).diffuseProbability *= inverseTotal;
    (*prepared).subsurfaceProbability *= inverseTotal;
}

fn openpbr_prepare(
    tangent: vec3f,
    material: OpenPbrResolvedMaterial,
    viewDirection: vec3f,
    normal: vec3f
) -> OpenPbrPreparedBsdf {
    var prepared: OpenPbrPreparedBsdf;
    prepared.material = material;
    prepared.basis = openpbr_make_basis(
        tangent,
        normal,
        material.specularAnisotropy
    );
    prepared.viewLocal = openpbr_to_local(prepared.basis, viewDirection);
    prepared.diffuseColor = material.baseColor;

    let dielectricBaseWeight = material.baseWeight
        * (1.0 - material.baseMetalness);
    let opaqueDielectricWeight = dielectricBaseWeight
        * (1.0 - material.transmissionWeight);
    prepared.fuzzWeight = material.fuzzWeight;
    prepared.coatWeight = material.coatWeight;
    prepared.metalWeight = material.baseWeight * material.baseMetalness;
    prepared.specularWeight = dielectricBaseWeight;
    prepared.transmissionWeight = dielectricBaseWeight
        * material.transmissionWeight;
    prepared.diffuseWeight = opaqueDielectricWeight
        * (1.0 - material.subsurfaceWeight);
    prepared.subsurfaceWeight = opaqueDielectricWeight
        * material.subsurfaceWeight;

    prepared.specularEtaTOverEtaI = openpbr_apply_specular_weight_to_ior(
        1.0 / material.relativeIor,
        material.specularWeight
    );
    prepared.material.relativeIor = 1.0 / prepared.specularEtaTOverEtaI;
    prepared.specularAlpha = material.specularRoughness
        * material.specularRoughness;
    let viewCosine = abs(prepared.viewLocal.z);
    let viewScatter = sampling_schlick_fifth_power(viewCosine);
    let singleInterfaceFresnel = openpbr_dielectric_fresnel(
        viewCosine,
        prepared.material.relativeIor
    );
    let dielectricFresnelEstimate = material.specularColor * select(
        singleInterfaceFresnel,
        mix(
            singleInterfaceFresnel,
            openpbr_thin_wall_fresnel(singleInterfaceFresnel),
            material.transmissionWeight
        ),
        material.thinWalled
    );
    let metalFresnelEstimate = mix(
        material.baseColor,
        vec3f(1.0),
        viewScatter
    );
    let transmissionFresnel = select(
        singleInterfaceFresnel,
        openpbr_thin_wall_fresnel(singleInterfaceFresnel),
        material.thinWalled
    );
    let transmissionTint = openpbr_final_transmission_tint(
        material,
        viewCosine,
        prepared.specularEtaTOverEtaI
    );
    let viewEnergyComplement = openpbr_opaque_energy_complement(
        prepared.specularEtaTOverEtaI,
        prepared.specularAlpha,
        viewCosine
    );
    let averageEnergyComplement = openpbr_opaque_average_energy_complement(
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
    openpbr_normalize_probabilities(&prepared);
    return prepared;
}


fn openpbr_eval_prepared_lobe(
    prepared: OpenPbrPreparedBsdf,
    lightDirection: vec3f,
    allowedLobe: i32,
    pdf: ptr<function, f32>
) -> vec3f {
    let material = prepared.material;
    let viewLocal = prepared.viewLocal;
    let lightLocal = openpbr_to_local(prepared.basis, lightDirection);
    let reflection = lightLocal.z * viewLocal.z > 0.0;

    var halfVector: vec3f;
    if (reflection) {
        halfVector = normalize(lightLocal + viewLocal);
    }
    else {
        halfVector = normalize(lightLocal + viewLocal * material.relativeIor);
    }
    if (halfVector.z < 0.0) {
        halfVector = -halfVector;
    }

    var response = vec3f(0.0);
    *pdf = 0.0;
    var lobePdf = 0.0;
    let allowAll = allowedLobe < 0;
    let allowFuzz = allowAll || allowedLobe == OPENPBR_LOBE_FUZZ;
    let allowCoat = allowAll || allowedLobe == OPENPBR_LOBE_COAT;
    let allowMetal = allowAll || allowedLobe == OPENPBR_LOBE_METAL;
    let allowSpecular = allowAll || allowedLobe == OPENPBR_LOBE_SPECULAR;
    let allowTransmission = allowAll ||
        allowedLobe == OPENPBR_LOBE_TRANSMISSION;
    let allowDiffuse = allowAll || allowedLobe == OPENPBR_LOBE_DIFFUSE;
    let allowSubsurface = allowAll ||
        allowedLobe == OPENPBR_LOBE_SUBSURFACE;
    let viewHalf = abs(dot(viewLocal, halfVector));
    // Reflection, solid refraction and thin-wall transmission share the same
    // dielectric optical solve. Select its half angle before evaluating the
    // film, instead of inlining that large solve in each transport branch.
    var thinWallHalf = halfVector;
    var dielectricViewHalf = viewHalf;
    if (!reflection && material.thinWalled) {
        thinWallHalf = normalize(vec3f(lightLocal.xy, -lightLocal.z) + viewLocal);
        if (thinWallHalf.z < 0.0) { thinWallHalf = -thinWallHalf; }
        dielectricViewHalf = abs(dot(viewLocal, thinWallHalf));
    }
    let evaluateDielectric =
        (reflection && prepared.specularWeight > 0.0 && allowSpecular) ||
        (!reflection && prepared.transmissionWeight > 0.0 && allowTransmission);
    let evaluateMetal = reflection && prepared.metalWeight > 0.0 && allowMetal;
    var fresnels: array<vec3f, 2>;
    if (evaluateDielectric) {
        fresnels[0] = vec3f(openpbr_dielectric_fresnel(dielectricViewHalf, material.relativeIor));
    }
    if (evaluateMetal) {
        fresnels[1] = mix(material.baseColor, vec3f(1.0), sampling_schlick_fifth_power(viewHalf));
    }
    if (material.thinFilmWeight > 0.0) {
        let wavelengths = vec3f(620.0, 540.0, 450.0);
        // Dielectric and conductor substrates share one complete optical graph.
        for (var substrate = 0u; substrate < 2u; substrate++) {
            if (!select(evaluateDielectric, evaluateMetal, substrate == 1u)) { continue; }
            var film = vec3f(0.0);
            let incidentCosine = select(dielectricViewHalf, viewHalf, substrate == 1u);
            for (var channel = 0u; channel < 3u; channel++) {
                var ior = vec2f(prepared.specularEtaTOverEtaI, 0.0);
                if (substrate == 1u) {
                    ior = openpbr_metal_complex_ior(material.baseColor[channel], material.specularColor[channel]);
                }
                film[channel] = openpbr_thin_film_reflectance_channel(incidentCosine,
                    wavelengths[channel], material.thinFilmThickness, 1.0, material.thinFilmIor, ior);
            }
            fresnels[substrate] = mix(fresnels[substrate], film,
                openpbr_thin_film_presence(material.thinFilmThickness, material.thinFilmWeight));
        }
    }
    let substrateFresnel = fresnels[0];
    let diffuseSpecularEnergyCompensation =
        prepared.diffuseSpecularEnergyCompensation
        * openpbr_opaque_energy_complement(
            prepared.specularEtaTOverEtaI,
            prepared.specularAlpha,
            abs(lightLocal.z)
        );

    if (reflection) {
        if (prepared.diffuseWeight > 0.0 && allowDiffuse) {
            response += prepared.diffuseWeight * openpbr_eval_diffuse(
                material,
                prepared.diffuseColor,
                viewLocal,
                lightLocal,
                diffuseSpecularEnergyCompensation,
                &lobePdf
            );
            *pdf += prepared.diffuseProbability * lobePdf;
        }

        if (prepared.subsurfaceWeight > 0.0 && material.thinWalled &&
            allowSubsurface) {
            response += 0.5 * prepared.subsurfaceWeight * openpbr_eval_diffuse(
                material,
                material.subsurfaceColor,
                viewLocal,
                lightLocal,
                diffuseSpecularEnergyCompensation,
                &lobePdf
            );
            *pdf += prepared.subsurfaceProbability * 0.5 * lobePdf;
        }

        if (prepared.specularWeight > 0.0 && allowSpecular) {
            var dielectricFresnel = substrateFresnel;
            if (material.thinWalled) {
                dielectricFresnel = openpbr_thin_wall_reflection_coefficient(
                    dielectricFresnel,
                    material.transmissionWeight
                );
            }
            let fresnel = material.specularColor * dielectricFresnel;
            response += prepared.specularWeight * openpbr_eval_microfacet_reflection(
                material,
                viewLocal,
                lightLocal,
                halfVector,
                fresnel,
                &lobePdf
            );
            *pdf += prepared.specularProbability * lobePdf;
        }

        if (prepared.metalWeight > 0.0 && allowMetal) {
            let fresnel = fresnels[1];
            response += prepared.metalWeight * openpbr_eval_microfacet_reflection(
                material,
                viewLocal,
                lightLocal,
                halfVector,
                fresnel,
                &lobePdf
            );
            *pdf += prepared.metalProbability * lobePdf;
        }
    }
    else {
        let fresnel = substrateFresnel;
        if (prepared.transmissionWeight > 0.0 && allowTransmission) {
            if (material.thinWalled) {
                let mirroredLight = vec3f(lightLocal.xy, -lightLocal.z);
                let windowFresnel = openpbr_thin_wall_reflection_coefficient(
                    substrateFresnel,
                    1.0
                );
                let tint = openpbr_final_transmission_tint(
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
                        tint * (vec3f(1.0) - windowFresnel),
                        &lobePdf
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
                        &lobePdf
                    );
            }
            *pdf += prepared.transmissionProbability * lobePdf;
        }
        if (prepared.subsurfaceWeight > 0.0 && allowSubsurface) {
            if (material.thinWalled) {
                let flippedLight = vec3f(lightLocal.xy, -lightLocal.z);
                response += 0.5 * prepared.subsurfaceWeight
                    * openpbr_eval_diffuse(
                        material,
                        material.subsurfaceColor,
                        viewLocal,
                        flippedLight,
                        diffuseSpecularEnergyCompensation,
                        &lobePdf
                    );
                lobePdf *= 0.5;
            }
            else {
                response += prepared.subsurfaceWeight * openpbr_eval_subsurface_boundary(
                    material,
                    viewLocal,
                    lightLocal,
                    &lobePdf
                );
            }
            *pdf += prepared.subsurfaceProbability * lobePdf;
        }
    }

    if (reflection && prepared.coatWeight > 0.0) {
        let coatFresnel = vec3f(sampling_dielectric_fresnel(
            viewHalf,
            1.0 / material.coatIor
        )) * material.coatColor;
        var coatMaterial = material;
        let coatAlpha = material.coatRoughness * material.coatRoughness;
        let coatAlphaMin = ROUGHNESS_MIN * ROUGHNESS_MIN;
        coatMaterial.alphaX = max(coatAlphaMin, coatAlpha);
        coatMaterial.alphaY = max(coatAlphaMin, coatAlpha);
        var attenuation = vec3f(1.0)
            - coatFresnel * prepared.coatWeight;
        attenuation *= mix(
            vec3f(1.0),
            material.coatColor,
            prepared.coatWeight * material.coatDarkening
        );
        response *= attenuation;
        if (allowCoat) {
            response += prepared.coatWeight * openpbr_eval_microfacet_reflection(
                coatMaterial,
                viewLocal,
                lightLocal,
                halfVector,
                coatFresnel,
                &lobePdf
            );
            *pdf += prepared.coatProbability * lobePdf;
        }
    }

    if (reflection && prepared.fuzzWeight > 0.0) {
        let fuzzAlbedo = openpbr_fuzz_directional_albedo(
            abs(viewLocal.z),
            material.fuzzRoughness
        );
        response *= max(
            vec3f(0.0),
            vec3f(1.0) - prepared.fuzzWeight * fuzzAlbedo * material.fuzzColor
        );
        if (allowFuzz) {
            response += prepared.fuzzWeight * openpbr_eval_fuzz(
                material,
                viewLocal,
                lightLocal,
                &lobePdf
            );
            *pdf += prepared.fuzzProbability * lobePdf;
        }
    }

    return response * abs(lightLocal.z);
}

fn openpbr_eval_prepared(
    prepared: OpenPbrPreparedBsdf,
    lightDirection: vec3f,
    pdf: ptr<function, f32>
) -> vec3f {
    return openpbr_eval_prepared_lobe(prepared, lightDirection, -1, pdf);
}





fn openpbr_eval(
    tangent: vec3f,
    material: OpenPbrResolvedMaterial,
    viewDirection: vec3f,
    normal: vec3f,
    lightDirection: vec3f,
    pdf: ptr<function, f32>
) -> vec3f {
    let prepared = openpbr_prepare(
        tangent,
        material,
        viewDirection,
        normal
    );
    return openpbr_eval_prepared(prepared, lightDirection, pdf);
}




// Direction-only proposals do not require the layered response or film optics.
fn openpbr_sample_direction(
    prepared: OpenPbrPreparedBsdf, randomSamples: vec3f,
    lightDirection: ptr<function, vec3f>, isTransmissionEvent: ptr<function, bool>,
    sampledLobeRoughness: ptr<function, f32>, sampledLobeSpecular: ptr<function, bool>,
    sampledLobeDiffuse: ptr<function, bool>, sampledLobeIndex: ptr<function, u32>
) -> bool {
    let material = prepared.material;
    let viewLocal = prepared.viewLocal;
    var randomX = randomSamples.x;
    let randomY = randomSamples.y;
    let lobeSample = randomSamples.z;
    *isTransmissionEvent = false;
    *sampledLobeRoughness = 1.0;
    *sampledLobeSpecular = false;
    *sampledLobeDiffuse = false;
    *sampledLobeIndex = 5u;
    *lightDirection = prepared.basis.normal;

    let fuzzCdf = prepared.fuzzProbability;
    let coatCdf = fuzzCdf + prepared.coatProbability;
    let metalCdf = coatCdf + prepared.metalProbability;
    let specularCdf = metalCdf + prepared.specularProbability;
    let transmissionCdf = specularCdf + prepared.transmissionProbability;
    let diffuseCdf = transmissionCdf + prepared.diffuseProbability;
    let subsurfaceCdf = diffuseCdf + prepared.subsurfaceProbability;
    if (subsurfaceCdf <= 0.0) {
        return false;
    }

    var lightLocal: vec3f;
    if (lobeSample < fuzzCdf || (
        lobeSample >= transmissionCdf && lobeSample < diffuseCdf
    )) {
        let sampledFuzz = lobeSample < fuzzCdf;
        *sampledLobeRoughness = select(
            1.0,
            material.fuzzRoughness,
            sampledFuzz
        );
        *sampledLobeDiffuse = !sampledFuzz;
        *sampledLobeIndex = select(
            5u,
            0u,
            sampledFuzz
        );
        lightLocal = sampling_cosine_hemisphere(vec2f(randomX, randomY));
    }
    else if (lobeSample < coatCdf) {
        *sampledLobeRoughness = material.coatRoughness;
        *sampledLobeSpecular = true;
        *sampledLobeIndex = 1u;
        var halfVector = sampling_ggx_visible_normal(
            viewLocal,
            vec2f(max(0.001, material.coatRoughness * material.coatRoughness)),
            vec2f(randomX, randomY)
        );
        if (halfVector.z < 0.0) {
            halfVector = -halfVector;
        }
        lightLocal = normalize(reflect(-viewLocal, halfVector));
    }
    else if (lobeSample < specularCdf) {
        *sampledLobeRoughness = material.specularRoughness;
        *sampledLobeSpecular = true;
        *sampledLobeIndex = select(
            3u,
            2u,
            lobeSample < metalCdf
        );
        var halfVector = sampling_ggx_visible_normal(
            viewLocal,
            vec2f(material.alphaX, material.alphaY),
            vec2f(randomX, randomY)
        );
        if (halfVector.z < 0.0) {
            halfVector = -halfVector;
        }
        lightLocal = normalize(reflect(-viewLocal, halfVector));
    }
    else if (lobeSample < transmissionCdf) {
        *sampledLobeRoughness = material.specularRoughness;
        *sampledLobeSpecular = true;
        *isTransmissionEvent = true;
        *sampledLobeIndex = 4u;
        var halfVector = sampling_ggx_visible_normal(
            viewLocal,
            vec2f(material.alphaX, material.alphaY),
            vec2f(randomX, randomY)
        );
        if (halfVector.z < 0.0) {
            halfVector = -halfVector;
        }
        if (material.thinWalled) {
            let reflectedLocal = normalize(reflect(-viewLocal, halfVector));
            lightLocal = vec3f(reflectedLocal.xy, -reflectedLocal.z);
        }
        else {
            lightLocal = refract(
                -viewLocal,
                halfVector,
                prepared.material.relativeIor
            );
            if (dot(lightLocal, lightLocal) <= 1e-8) {
                *isTransmissionEvent = false;
                return false;
            }
            lightLocal = normalize(lightLocal);
        }
    }
    else {
        *sampledLobeRoughness = 1.0;
        *sampledLobeDiffuse = true;
        *isTransmissionEvent = true;
        *sampledLobeIndex = 6u;
        if (material.thinWalled) {
            let transmit = randomX >= 0.5;
            if (transmit) {
                randomX = (randomX - 0.5) * 2.0;
            }
            else {
                randomX *= 2.0;
            }
            lightLocal = sampling_cosine_hemisphere(vec2f(randomX, randomY));
            if (transmit) {
                lightLocal.z = -lightLocal.z;
            }
            else {
                *isTransmissionEvent = false;
            }
        }
        else {
            lightLocal = sampling_cosine_hemisphere(vec2f(randomX, randomY));
            lightLocal.z = -lightLocal.z;
        }
    }

    *lightDirection = openpbr_to_world(prepared.basis, lightLocal);
    // VNDF reflection may land below the macrosurface. A mirrored thin-wall
    // transmission draw can likewise land above it. Reject that draw before
    // aggregate evaluation can accidentally turn it into the opposite lobe.
    if (lightLocal.z == 0.0 || (lightLocal.z < 0.0) != *isTransmissionEvent) {
        return false;
    }
    return true;
}

fn openpbr_sample_prepared(
    prepared: OpenPbrPreparedBsdf,
    randomSamples: vec3f,
    lightDirection: ptr<function, vec3f>,
    pdf: ptr<function, f32>,
    isTransmissionEvent: ptr<function, bool>,
    sampledLobeRoughness: ptr<function, f32>,
    sampledLobeSpecular: ptr<function, bool>,
    sampledLobeDiffuse: ptr<function, bool>,
    sampledLobeIndex: ptr<function, u32>,
    marginalPdf: ptr<function, f32>,
    fullResponse: ptr<function, vec3f>
) -> vec3f {
    *pdf = 0.0;
    *marginalPdf = 0.0;
    *fullResponse = vec3f(0.0);
    // Solid microfacet refraction is singular at exactly eta=1: the usual
    // half vector normalizes light + eta * view, which is zero for straight
    // transmission. Resolve the physically null boundary as a discrete,
    // unit-throughput continuation instead of losing the path to NaNs.
    if (!prepared.material.thinWalled &&
        abs(prepared.material.relativeIor - 1.0) <= 1e-6 &&
        prepared.transmissionProbability >= 1.0 - 1e-6) {
        *lightDirection = openpbr_to_world(
            prepared.basis,
            -prepared.viewLocal
        );
        let nullBoundaryTint = openpbr_transmission_tint(prepared.material);
        *pdf = 1.0;
        *marginalPdf = 1.0;
        *fullResponse = nullBoundaryTint;
        *isTransmissionEvent = true;
        *sampledLobeRoughness = 0.0;
        *sampledLobeSpecular = true;
        *sampledLobeDiffuse = false;
        *sampledLobeIndex = 4u;
        return nullBoundaryTint;
    }
    if (!openpbr_sample_direction(prepared, randomSamples, lightDirection,
        isTransmissionEvent, sampledLobeRoughness, sampledLobeSpecular,
        sampledLobeDiffuse, sampledLobeIndex)) { return vec3f(0.0); }
    let response = openpbr_eval_prepared(prepared, *lightDirection, pdf);
    *marginalPdf = *pdf;
    *fullResponse = response;
    return response;
}

fn openpbr_sample(
    tangent: vec3f,
    material: OpenPbrResolvedMaterial,
    randomSamples: vec3f,
    viewDirection: vec3f,
    normal: vec3f,
    lightDirection: ptr<function, vec3f>,
    pdf: ptr<function, f32>,
    isTransmissionEvent: ptr<function, bool>,
    sampledLobeRoughness: ptr<function, f32>,
    sampledLobeSpecular: ptr<function, bool>,
    sampledLobeDiffuse: ptr<function, bool>,
    sampledLobeIndex: ptr<function, u32>,
    marginalPdf: ptr<function, f32>
) -> vec3f {
    let prepared = openpbr_prepare(
        tangent,
        material,
        viewDirection,
        normal
    );
    var fullResponse = vec3f(0.0);
    return openpbr_sample_prepared(
        prepared,
        randomSamples,
        lightDirection,
        pdf,
        isTransmissionEvent,
        sampledLobeRoughness,
        sampledLobeSpecular,
        sampledLobeDiffuse,
        sampledLobeIndex,
        marginalPdf,
        &fullResponse
    );
}`;
