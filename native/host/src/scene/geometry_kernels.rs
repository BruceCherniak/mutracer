//! The two O(N) kernels selected by the Phase 2 D4 profiling gate.
//! Scene decoding, material/instance assembly and all Web implementations stay TS.
use super::*;
use crate::layout::{geometry_kernel_entry as ke, geometry_kernel_header as kh};
unsafe extern "C" {
    fn mt_core_geometry_kernel_hypot(x: f64, y: f64, z: f64) -> f64;
}
fn floats(w: &Words<'_>, offset: usize, count: usize) -> Vec<f32> {
    (0..count).map(|i| w.f(offset + i)).collect()
}
fn bounds(positions: &[f32]) -> [f32; 6] {
    let mut result = [
        f32::INFINITY,
        f32::INFINITY,
        f32::INFINITY,
        f32::NEG_INFINITY,
        f32::NEG_INFINITY,
        f32::NEG_INFINITY,
    ];
    for p in positions.chunks_exact(3) {
        if !p.iter().all(|v| v.is_finite()) {
            continue;
        }
        for axis in 0..3 {
            let value = p[axis];
            if value < result[axis] || value == 0. && result[axis] == 0. && value.is_sign_negative()
            {
                result[axis] = value;
            }
            if value > result[axis + 3]
                || value == 0. && result[axis + 3] == 0. && value.is_sign_positive()
            {
                result[axis + 3] = value;
            }
        }
    }
    result
}
fn tangents(positions: &[f32], normals: &[f32], uvs: &[f32], indices: &[u32]) -> Vec<f32> {
    let mut accumulated = vec![0f32; positions.len()];
    for triangle in indices.chunks_exact(3) {
        let [a, b, c] = [
            triangle[0] as usize,
            triangle[1] as usize,
            triangle[2] as usize,
        ];
        let p = |vertex: usize, axis: usize| positions[vertex * 3 + axis] as f64;
        let uv = |vertex: usize, axis: usize| uvs[vertex * 2 + axis] as f64;
        let [x1, y1, z1] = [p(b, 0) - p(a, 0), p(b, 1) - p(a, 1), p(b, 2) - p(a, 2)];
        let [x2, y2, z2] = [p(c, 0) - p(a, 0), p(c, 1) - p(a, 1), p(c, 2) - p(a, 2)];
        let [s1, t1, s2, t2] = [
            uv(b, 0) - uv(a, 0),
            uv(b, 1) - uv(a, 1),
            uv(c, 0) - uv(a, 0),
            uv(c, 1) - uv(a, 1),
        ];
        let determinant = s1 * t2 - s2 * t1;
        if determinant.abs() < 1e-12 {
            continue;
        }
        let inverse = 1. / determinant;
        let tangent = [
            (x1 * t2 - x2 * t1) * inverse,
            (y1 * t2 - y2 * t1) * inverse,
            (z1 * t2 - z2 * t1) * inverse,
        ];
        for vertex in [a, b, c] {
            for axis in 0..3 {
                let index = vertex * 3 + axis;
                accumulated[index] = (accumulated[index] as f64 + tangent[axis]) as f32;
            }
        }
    }
    let mut result = vec![0f32; positions.len()];
    for vertex in 0..positions.len() / 3 {
        let base = vertex * 3;
        let [nx, ny, nz] = [
            normals[base] as f64,
            normals[base + 1] as f64,
            normals[base + 2] as f64,
        ];
        let projection = accumulated[base] as f64 * nx
            + accumulated[base + 1] as f64 * ny
            + accumulated[base + 2] as f64 * nz;
        let mut value = [
            accumulated[base] as f64 - nx * projection,
            accumulated[base + 1] as f64 - ny * projection,
            accumulated[base + 2] as f64 - nz * projection,
        ];
        // Reuse the compiled TS Math.hypot primitive rather than changing its
        // rounding or maintaining another approximation. Owner/ENTRY_LOCK holds;
        // this synchronous kernel runs between AOT steps, never inside one.
        let length = unsafe { mt_core_geometry_kernel_hypot(value[0], value[1], value[2]) };
        if length > 1e-8 {
            for axis in 0..3 {
                value[axis] /= length;
            }
        } else {
            value = [0.; 3];
        }
        for axis in 0..3 {
            result[base + axis] = value[axis] as f32;
        }
    }
    result
}
pub(super) fn packet(bytes: &[u8], include_bounds: bool) -> Option<Vec<u8>> {
    let w = Words(bytes);
    let count = w.u(h::GEOMETRY_COUNT);
    let any_tangents = (0..count).any(|i| {
        let off = w.u(h::GEOMETRY_OFFSET) + i * g::WORDS;
        w.u(off + g::NORMAL) != 0 && w.u(off + g::UV) != 0 && w.u(off + g::TANGENT) == 0
    });
    if !include_bounds && !any_tangents {
        return None;
    }
    let mut result = vec![0u32; kh::WORDS + count * ke::WORDS];
    result[kh::VERSION] = crate::layout::version::GEOMETRY_KERNELS as u32;
    result[kh::COUNT] = count as u32;
    for i in 0..count {
        let off = w.u(h::GEOMETRY_OFFSET) + i * g::WORDS;
        let vertices = w.u(off + g::VERTEX_COUNT);
        let entry = kh::WORDS + i * ke::WORDS;
        result[entry + ke::SOURCE] = i as u32;
        result[entry + ke::VERTEX_COUNT] = vertices as u32;
        let need_tangents =
            w.u(off + g::NORMAL) != 0 && w.u(off + g::UV) != 0 && w.u(off + g::TANGENT) == 0;
        if !include_bounds && !need_tangents {
            continue;
        }
        let positions = floats(&w, w.u(off + g::POSITION), vertices * 3);
        if include_bounds {
            result[entry + ke::BOUNDS] = result.len() as u32;
            result.extend(bounds(&positions).map(f32::to_bits));
        }
        if need_tangents {
            let normals = floats(&w, w.u(off + g::NORMAL), vertices * 3);
            let uvs = floats(&w, w.u(off + g::UV), vertices * 2);
            let indices = (0..w.u(off + g::INDEX_COUNT))
                .map(|j| w.u(w.u(off + g::INDICES) + j) as u32)
                .collect::<Vec<_>>();
            result[entry + ke::TANGENTS] = result.len() as u32;
            result.extend(
                tangents(&positions, &normals, &uvs, &indices)
                    .into_iter()
                    .map(f32::to_bits),
            );
        }
    }
    result[kh::LENGTH] = result.len() as u32;
    Some(result.into_iter().flat_map(u32::to_le_bytes).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    unsafe extern "C" {
        fn mt_core_geometry_kernel_reference(
            input: *const u8,
            length: usize,
            with_bounds: u32,
            output: *mut *const u8,
            size: *mut usize,
        );
    }
    fn compare(input: &[u8], include_bounds: bool) {
        validate(input).unwrap();
        let mut pointer = std::ptr::null();
        let mut size = 0;
        unsafe {
            mt_core_geometry_kernel_reference(
                input.as_ptr(),
                input.len(),
                u32::from(include_bounds),
                &mut pointer,
                &mut size,
            );
        }
        let expected = unsafe { copy_core_result(pointer, size, size).unwrap() };
        unsafe {
            mt_core_reset();
            mt_core_collect();
        }
        let actual = packet(input, include_bounds).unwrap();
        assert_eq!(
            actual, expected,
            "Rust kernel data must equal the compiled shared TS reference"
        );
    }
    #[test]
    fn geometry_kernels_preserve_production_assets() {
        let _test = ABI_TEST_LOCK.lock().unwrap();
        let _entry = ENTRY_LOCK.lock().unwrap();
        init_core();
        let mut inputs = vec![super::super::tests::input()];
        if let Ok(path) = std::env::var("MUTRACER_KERNEL_FIXTURES") {
            let cases: Vec<serde_json::Value> =
                serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
            for case in cases {
                inputs.push(fs::read(case["input"].as_str().unwrap()).unwrap());
            }
        }
        for (i, input) in inputs.iter().enumerate() {
            for hardware in [false, true] {
                let token = 2_000_000 + i as u32 * 2 + u32::from(hardware);
                let settings = settings::RenderSettings::default();
                let variants = if hardware { 2 } else { 1 };
                let (_, actual) = prepare_impl_with_kernels(
                    input, token, hardware, false, &settings, variants, true,
                )
                .unwrap();
                let (_, expected) = prepare_impl_with_kernels(
                    input, token, hardware, false, &settings, variants, false,
                )
                .unwrap();
                assert_eq!(actual.len(), expected.len());
                for (name, bytes) in actual {
                    let reference = expected.get(&name).unwrap();
                    assert!(
                        bytes == *reference,
                        "input {i}, hardware {hardware}, {name}: first difference {:?}, lengths {} / {}",
                        bytes.iter().zip(reference).position(|(a, b)| a != b),
                        bytes.len(),
                        reference.len()
                    );
                }
                let mut pointer = std::ptr::null();
                let mut size = 0;
                unsafe {
                    mt_core_scene_release(token, &mut pointer, &mut size);
                    mt_core_reset();
                    mt_core_collect();
                }
            }
        }
    }
    #[test]
    fn geometry_kernels_match_shared_ts_bytes() {
        let _test = ABI_TEST_LOCK.lock().unwrap();
        let _entry = ENTRY_LOCK.lock().unwrap();
        init_core();
        let base = super::super::tests::input();
        let mut seed = 0x12345678u32;
        for case in 0..80 {
            let count = 3 + case % 29;
            let mut words = base
                .chunks_exact(4)
                .map(|b| u32::from_le_bytes(b.try_into().unwrap()))
                .collect::<Vec<_>>();
            let mut random = || {
                seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                (seed as f64 / u32::MAX as f64 - 0.5) as f32
            };
            let geometry = words[h::GEOMETRY_OFFSET] as usize;
            words[geometry + g::VERTEX_COUNT] = count as u32;
            words[geometry + g::POSITION] = words.len() as u32;
            for i in 0..count * 3 {
                let value = if case == 0 {
                    if i % 2 == 0 { -0.0f32 } else { 0.0f32 }
                } else {
                    random() * if case % 11 == 0 { 1e20 } else { 10. }
                };
                words.push(value.to_bits());
            }
            words[geometry + g::NORMAL] = words.len() as u32;
            for _ in 0..count {
                for n in [random(), random(), 1.] {
                    words.push(n.to_bits());
                }
            }
            words[geometry + g::UV] = words.len() as u32;
            for _ in 0..count * 2 {
                words.push(if case % 7 == 0 { 0 } else { random().to_bits() });
            }
            words[geometry + g::INDICES] = words.len() as u32;
            words[geometry + g::INDEX_COUNT] = (count * 6) as u32;
            for i in 0..count * 6 {
                words.push(((i * 7 + i / 3) % count) as u32);
            }
            words[h::LENGTH] = words.len() as u32;
            let input = words
                .into_iter()
                .flat_map(u32::to_le_bytes)
                .collect::<Vec<_>>();
            for include_bounds in [false, true] {
                compare(&input, include_bounds);
            }
        }
        if let Ok(path) = std::env::var("MUTRACER_KERNEL_FIXTURES") {
            let cases: Vec<serde_json::Value> =
                serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
            for case in cases {
                let input = fs::read(case["input"].as_str().unwrap()).unwrap();
                compare(&input, true);
            }
        }
    }
}
