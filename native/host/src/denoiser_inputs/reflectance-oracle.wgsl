// Test-only tensor quadrature of the production BSDF. Unlike the baseline's
// balanced VNDF/cosine estimator, reflection is integrated with a GGX NDF
// half-vector change of variables; diffuse uses a separate cosine grid.
// This reference deliberately supports only the isotropic, unlayered fixtures.
fn mtFrameReflectance(prepared: OpenPbrPreparedBsdf) -> MtReflectance {
    var result = MtReflectance();
    let n = min(rtUniform.loopUnrollGuard, 4u) * 32u;
    let count = f32(n * n);
    let view = prepared.viewLocal;
    let alpha = prepared.material.alphaX;
    for (var row = 0u; row < n; row++) {
        let u = (f32(row) + 0.5) / f32(n);
        let hCos = sqrt((1.0 - u) / (1.0 + (alpha * alpha - 1.0) * u));
        let hSin = sqrt(max(0.0, 1.0 - hCos * hCos));
        for (var column = 0u; column < n; column++) {
            let phi = TWOPI * (f32(column) + 0.5) / f32(n);
            let half = vec3f(hSin * cos(phi), hSin * sin(phi), hCos);
            let reflected = reflect(-view, half);
            let halfPdf = sampling_ggx_ndf(half, vec2f(alpha)) * half.z;
            let jacobian = 4.0 * abs(dot(view, half));
            let cosineLight = vec3f(sqrt(u) * cos(phi), sqrt(u) * sin(phi), sqrt(1.0 - u));
            for (var layer = 0u; layer < min(3u, rtUniform.loopUnrollGuard); layer++) {
                var light = reflected;
                var scale = 0.0;
                if (light.z > 0.0 && dot(view, half) > 0.0) {
                    scale = jacobian / (halfPdf * count);
                }
                var lobe = -1;
                if (layer != 1u) { lobe = OPENPBR_LOBE_DIFFUSE; }
                if (layer == 0u) { light = cosineLight; scale = PI / (count * light.z); }
                if (layer == 2u) { scale = -scale; }
                var unusedPdf = 0.0;
                let value = openpbr_eval_prepared_lobe(prepared,
                    openpbr_to_world(prepared.basis, light), lobe, &unusedPdf) * scale;
                if (layer == 0u) { result.diffuse += value; }
                else { result.specular += value; }
            }
        }
    }
    return result;
}
