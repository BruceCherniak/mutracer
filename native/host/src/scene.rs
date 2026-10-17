//! Validated raw scene boundary. Only returned AOT bytes are retained by Rust.
use super::*;
unsafe extern "C" {
    fn mt_core_native_hardware_scene(
        input: *const u8,
        length: usize,
        token: u32,
        output: *mut *const u8,
        size: *mut usize,
    );
    fn mt_core_native_scene_begin(
        input: *const u8,
        length: usize,
        token: u32,
        output: *mut *const u8,
        size: *mut usize,
    );
    fn mt_core_native_scene_blas(
        input: *const u8,
        length: usize,
        token: u32,
        output: *mut *const u8,
        size: *mut usize,
    );
    fn mt_core_native_scene_finish(
        input: *const u8,
        length: usize,
        token: u32,
        output: *mut *const u8,
        size: *mut usize,
    );
    fn mt_core_scene_release(token: u32, output: *mut *const u8, size: *mut usize);
    fn mt_core_scene_material(
        input: *const u8,
        length: usize,
        token: u32,
        output: *mut *const u8,
        size: *mut usize,
    );
    fn mt_core_native_geometry_begin(
        input: *const u8,
        length: usize,
        token: u32,
        output: *mut *const u8,
        size: *mut usize,
    );
    fn mt_core_native_geometry_finish(
        input: *const u8,
        length: usize,
        token: u32,
        output: *mut *const u8,
        size: *mut usize,
    );
    fn mt_core_scene_accept_geometry(token: u32, output: *mut *const u8, size: *mut usize);
    fn mt_core_native_transform_begin(
        input: *const u8,
        length: usize,
        token: u32,
        output: *mut *const u8,
        size: *mut usize,
    );
    fn mt_core_native_transform_finish(
        input: *const u8,
        length: usize,
        token: u32,
        output: *mut *const u8,
        size: *mut usize,
    );
    fn mt_core_scene_accept_transform(token: u32, output: *mut *const u8, size: *mut usize);
    fn mt_core_scene_accept_lighting(token: u32, output: *mut *const u8, size: *mut usize);
    fn mt_core_scene_light(
        input: *const u8,
        length: usize,
        token: u32,
        output: *mut *const u8,
        size: *mut usize,
    );
    fn mt_core_scene_environment(
        input: *const u8,
        length: usize,
        token: u32,
        output: *mut *const u8,
        size: *mut usize,
    );
    fn mt_core_scene_camera(
        input: *const u8,
        length: usize,
        width: u32,
        height: u32,
        output: *mut *const u8,
        size: *mut usize,
    );
}
pub(crate) const MAX_BYTES: usize = 512 * 1024 * 1024;
const MAX_PREPARED_BYTES: usize = 1024 * 1024 * 1024;

struct Words<'a>(&'a [u8]);
impl Words<'_> {
    fn len(&self) -> usize {
        self.0.len() / 4
    }
    fn u(&self, i: usize) -> usize {
        u32::from_le_bytes(self.0[i * 4..i * 4 + 4].try_into().unwrap()) as usize
    }
    fn f(&self, i: usize) -> f32 {
        f32::from_bits(self.u(i) as u32)
    }
    fn span(&self, off: usize, count: usize) -> Result<()> {
        if off < 32 || off > self.len() || count > self.len() - off {
            return Err("Scene span is out of bounds".into());
        }
        Ok(())
    }
    fn finite(&self, off: usize, count: usize) -> Result<()> {
        if !(off..off + count).all(|i| self.f(i).is_finite()) {
            return Err("Scene contains non-finite values".into());
        }
        Ok(())
    }
    fn affine(&self, off: usize) -> Result<()> {
        self.finite(off, 16)?;
        let m = |i| self.f(off + i) as f64;
        let det = m(0) * (m(5) * m(10) - m(6) * m(9)) - m(4) * (m(1) * m(10) - m(2) * m(9))
            + m(8) * (m(1) * m(6) - m(2) * m(5));
        if [3, 7, 11].iter().any(|&i| m(i) != 0.0) || m(15) != 1.0 || det.abs() < 1e-12 {
            return Err("Scene requires invertible affine transforms".into());
        }
        Ok(())
    }
    fn reserved(&self, off: usize, count: usize) -> Result<()> {
        if (off..off + count).any(|i| self.u(i) != 0) {
            return Err("Unknown scene descriptor fields".into());
        }
        Ok(())
    }
}
fn validate(bytes: &[u8]) -> Result<()> {
    if bytes.len() < 128 || bytes.len() > MAX_BYTES || bytes.len() % 4 != 0 {
        return Err("Invalid scene byte length".into());
    }
    let w = Words(bytes);
    if ![1, 2, 3].contains(&w.u(0)) || w.u(1) != w.len() {
        return Err("Scene descriptor version/length mismatch".into());
    }
    if w.u(2) == 0 || w.u(3) == 0 || w.u(2) > 4096 || w.u(3) > 4096 || w.u(2) * w.u(3) > 4_194_304 {
        return Err("Scene image dimensions exceed probe limits".into());
    }
    if w.u(4) == 0
        || w.u(4) > 4096
        || w.u(5) == 0
        || w.u(5) > 65536
        || w.u(6) == 0
        || w.u(6) > 65536
        || w.u(7) > 64
        || w.u(8) > 256
    {
        return Err("Scene count exceeds probe limits; empty scenes are pending".into());
    }
    for (count, offset, stride) in [
        (4, 9, 12),
        (5, 10, 20),
        (6, 11, 24),
        (7, 12, 28),
        (8, 13, 12),
    ] {
        w.span(w.u(offset), w.u(count) * stride)?;
    }
    w.reserved(15, 1)?;
    if w.u(0) == 1 {
        w.reserved(20, 12)?;
    } else {
        w.reserved(24, 8)?;
        if w.u(23) != 0 {
            w.span(w.u(23), w.u(5) * 4)?;
        }
        if w.u(22) & !7 != 0 || w.u(22) & 4 != 0 && w.u(21) != 0 {
            return Err("Unknown/incompatible scene quality flags".into());
        }
        for field in [20, 21] {
            let reference = w.u(field);
            if reference > w.u(8) {
                return Err("Environment/background texture reference is out of range".into());
            }
            if reference != 0 && w.u(w.u(13) + (reference - 1) * 12 + 2) != 1 {
                return Err("Environment/background requires linear RGBA32F".into());
            }
        }
    }
    w.finite(16, 4)?;
    let mut geometry_words = 0usize;
    let mut geometry_costs = Vec::new();
    for i in 0..w.u(4) {
        let o = w.u(9) + i * 12;
        let v = w.u(o);
        let n = w.u(o + 1);
        if v == 0 || n == 0 || n % 3 != 0 || v > 4_000_000 || n > 12_000_000 {
            return Err("Invalid geometry counts".into());
        }
        geometry_words += v * 32 + n * 24;
        geometry_costs.push(v * 32 + n * 24);
        if geometry_words > MAX_PREPARED_BYTES / 4 {
            return Err("Prepared geometry exceeds probe budget".into());
        }
        w.span(w.u(o + 2), v * 3)?;
        w.finite(w.u(o + 2), v * 3)?;
        w.span(w.u(o + 3), n)?;
        if (0..n).any(|k| w.u(w.u(o + 3) + k) >= v) {
            return Err("Geometry index is out of range".into());
        }
        for (field, stride) in [(4, 3), (5, 2), (6, 2)] {
            if w.u(o + field) != 0 {
                w.span(w.u(o + field), v * stride)?;
                w.finite(w.u(o + field), v * stride)?;
            }
        }
        if w.u(0) == 1 {
            w.reserved(o + 7, 5)?;
        } else {
            for (field, stride) in [(7, 3), (8, 4)] {
                if w.u(o + field) != 0 {
                    w.span(w.u(o + field), v * stride)?;
                    w.finite(w.u(o + field), v * stride)?;
                }
            }
            if w.u(o + 9) != 0 {
                w.span(w.u(o + 9), v)?;
            }
            w.reserved(o + 10, 2)?;
        }
    }
    let mut expanded_instances = 0usize;
    for i in 0..w.u(5) {
        let o = w.u(10) + i * 20;
        if w.u(o) >= w.u(4) || w.u(o + 1) >= w.u(6) {
            return Err("Mesh geometry/material reference is out of range".into());
        }
        let material_count;
        if w.u(0) == 1 {
            w.reserved(o + 2, 2)?;
            material_count = 1;
        } else {
            material_count = w.u(o + 3).max(1);
            if w.u(o + 3) > 65536 || w.u(o + 3) == 0 && w.u(o + 2) != 0 {
                return Err("Invalid mesh material table".into());
            }
            if w.u(o + 3) != 0 {
                w.span(w.u(o + 2), w.u(o + 3))?;
                if (0..w.u(o + 3)).any(|k| w.u(w.u(o + 2) + k) >= w.u(6)) {
                    return Err("Mesh material table reference is out of range".into());
                }
            }
        }
        let geometry = w.u(9) + w.u(o) * 12;
        if w.u(0) >= 2 && w.u(geometry + 9) != 0 {
            if (0..w.u(geometry)).any(|k| w.u(w.u(geometry + 9) + k) >= material_count) {
                return Err("Vertex material index is out of range".into());
            }
            geometry_words += geometry_costs[w.u(o)];
            if geometry_words > MAX_PREPARED_BYTES / 4 {
                return Err("Multi-material geometry expansion exceeds probe budget".into());
            }
        }
        let mut instance_count = 1;
        if w.u(0) >= 2 && w.u(23) != 0 {
            let io = w.u(23) + i * 4;
            w.reserved(io + 3, 1)?;
            if w.u(io) == u32::MAX as usize {
                w.reserved(io + 1, 2)?;
            } else {
                instance_count = w.u(io);
                if instance_count > 65536 {
                    return Err("Too many batch instances".into());
                }
                if instance_count == 0 {
                    w.reserved(io + 1, 2)?;
                } else {
                    w.span(w.u(io + 1), instance_count * 16)?;
                    for k in 0..instance_count {
                        w.affine(w.u(io + 1) + k * 16)?;
                    }
                    if w.u(io + 2) != 0 {
                        w.span(w.u(io + 2), instance_count * 3)?;
                        w.finite(w.u(io + 2), instance_count * 3)?;
                    }
                }
            }
        }
        expanded_instances += instance_count;
        if expanded_instances > 65536 {
            return Err("Expanded instance count exceeds probe limit".into());
        }
        w.affine(o + 4)?;
    }
    let mut displacement = Vec::new();
    for i in 0..w.u(6) {
        let mut disp = (u32::MAX as usize, 0.1f32, 0usize, 1f32, 0.01f32);
        let o = w.u(11) + i * 24;
        w.finite(o, 14)?;
        if [3, 4, 5, 11, 12, 13]
            .iter()
            .any(|&k| !(0.0..=1.0).contains(&w.f(o + k)))
            || w.f(o + 6) < 1.0
            || w.u(o + 14) > 1
            || [0, 1, 2, 7, 8, 9, 10].iter().any(|&k| w.f(o + k) < 0.0)
        {
            return Err("Invalid material values".into());
        }
        for k in 15..19 {
            if w.u(o + k) != 0xffffffff && w.u(o + k) >= w.u(8) {
                return Err("Material texture reference is out of range".into());
            }
        }
        if w.u(0) == 1 {
            w.reserved(o + 19, 5)?;
        } else {
            w.reserved(o + 21, 3)?;
            let count = w.u(o + 19);
            let offset = w.u(o + 20);
            if count > 75 || count == 0 && offset != 0 {
                return Err("Invalid material extension count/offset".into());
            }
            if count != 0 {
                w.span(offset, count * 4)?;
            }
            let mut seen = [false; 76];
            for i in 0..count {
                let entry = offset + i * 4;
                let id = w.u(entry);
                let &(kind, variants) = material_properties::MATERIAL_PROPERTIES
                    .get(id)
                    .ok_or("Unknown material property ID")?;
                if kind == 6 || seen[id] || w.u(0) < 3 && (57..=61).contains(&id) {
                    return Err("Unsupported or duplicate material property".into());
                }
                seen[id] = true;
                match id {
                    57 => disp.2 = w.u(entry + 1),
                    58 => disp.3 = w.f(entry + 1),
                    59 => disp.0 = w.u(entry + 1),
                    60 => disp.1 = w.f(entry + 1),
                    61 => disp.4 = w.f(entry + 1),
                    _ => {}
                }
                let components = if kind == 1 {
                    3
                } else if kind == 2 {
                    2
                } else {
                    1
                };
                w.reserved(entry + 1 + components, 3 - components)?;
                if kind <= 2 {
                    w.finite(entry + 1, components)?;
                } else if kind == 3 && w.u(entry + 1) > 1
                    || kind == 4 && w.u(entry + 1) >= variants as usize
                {
                    return Err("Invalid material boolean/enum".into());
                } else if kind == 5
                    && w.u(entry + 1) != u32::MAX as usize
                    && w.u(entry + 1) >= w.u(8)
                {
                    return Err("Material extension texture reference is out of range".into());
                }
            }
        }
        if disp.4 <= 0.0 {
            return Err("Displacement step size must be positive".into());
        }
        displacement.push(disp);
    }
    // Bound projective copies and numeric coordinate loops before entering AOT.
    for i in 0..w.u(5) {
        let mesh = w.u(10) + i * 20;
        let material = if w.u(0) >= 2 && w.u(mesh + 3) > 0 {
            w.u(w.u(mesh + 2))
        } else {
            w.u(mesh + 1)
        };
        let (texture, scale, projection, uv_scale, _) = displacement[material];
        if texture == u32::MAX as usize || scale.abs() <= 1e-6 {
            continue;
        }
        if uv_scale.abs() > 1_000_000.0 {
            return Err("Displacement projection scale exceeds the preparation limit".into());
        }
        let geo = w.u(9) + w.u(mesh) * 12;
        let tex = w.u(13) + texture * 12;
        let width = w.u(tex);
        if width == 0 || !width.is_power_of_two() || width != w.u(tex + 1) {
            return Err("Displacement requires a square power-of-two texture".into());
        }
        if projection == 0 && w.u(geo + 5) == 0 {
            return Err("UV displacement requires UV coordinates".into());
        }
        for (offset, count) in [(w.u(geo + 2), w.u(geo) * 3), (w.u(geo + 5), w.u(geo) * 2)] {
            if offset != 0
                && (0..count)
                    .any(|k| (w.f(offset + k) as f64 * uv_scale as f64).abs() > 1_000_000.0)
            {
                return Err("Displacement coordinates exceed the preparation limit".into());
            }
        }
        if projection != 0 {
            geometry_words += geometry_costs[w.u(mesh)];
            if geometry_words > MAX_PREPARED_BYTES / 4 {
                return Err("Displaced geometry expansion exceeds probe budget".into());
            }
        }
    }
    let mut pixels = 0;
    for i in 0..w.u(8) {
        let o = w.u(13) + i * 12;
        let width = w.u(o);
        let height = w.u(o + 1);
        if width == 0
            || height == 0
            || width > 4096
            || height > 4096
            || w.u(o + 2) > 1
            || w.u(o + 4) > 1
            || w.u(o + 5) > 1
        {
            return Err("Invalid raw texture descriptor".into());
        }
        pixels += width * height;
        if pixels > 16_777_216 {
            return Err("Raw textures exceed probe budget".into());
        }
        let count = width * height * if w.u(o + 2) == 0 { 1 } else { 4 };
        w.span(w.u(o + 3), count)?;
        if w.u(o + 2) == 1 {
            w.finite(w.u(o + 3), count)?;
        }
        w.finite(o + 6, 4)?;
        w.reserved(o + 10, 2)?;
    }
    for i in 0..w.u(7) {
        let o = w.u(12) + i * 28;
        validate_light(&w, o)?;
        if w.u(0) < 3 {
            w.reserved(o + 8, 4)?;
        } else {
            w.reserved(o + 11, 1)?;
            let reference = w.u(o + 8);
            if reference > w.u(8) || reference != 0 && w.u(o) != 0 {
                return Err("Rectangular light texture reference/type is invalid".into());
            }
            let (offset, length) = (w.u(o + 9), w.u(o + 10));
            if length == 0 {
                if offset != 0 {
                    return Err("Empty IES source has an offset".into());
                }
            } else {
                if w.u(o) != 3 || length > 16384 {
                    return Err("IES source requires a spot light and at most 16 KiB".into());
                }
                w.span(offset, length.div_ceil(4))?;
                std::str::from_utf8(&bytes[offset * 4..offset * 4 + length])?;
            }
        }
    }
    let o = w.u(14);
    w.span(o, 32)?;
    validate_camera(&w, o)
}
fn validate_light(w: &Words<'_>, o: usize) -> Result<()> {
    if w.u(o) > 3 {
        return Err("Unsupported analytic light type".into());
    }
    w.finite(o + 1, 7)?;
    if (1..=5).any(|k| w.f(o + k) < 0.0) {
        return Err("Negative light color/intensity/size".into());
    }
    if w.u(o) == 0 && (w.f(o + 5) <= 0.0 || w.f(o + 6) <= 0.0 || !(0.0..=1.0).contains(&w.f(o + 7)))
    {
        return Err("Invalid rectangular light".into());
    }
    if w.u(o) == 3
        && (w.f(o + 6) < 0.0 || w.f(o + 6) > w.f(o + 7) || w.f(o + 7) <= 0.0 || w.f(o + 7) >= 90.0)
    {
        return Err("Invalid spot light angles".into());
    }
    w.affine(o + 12)
}
fn validate_camera(w: &Words<'_>, o: usize) -> Result<()> {
    w.finite(o + 1, 12)?;
    if w.u(o) > 1
        || w.f(o + 2) <= 0.0
        || w.f(o + 3) <= w.f(o + 2)
        || w.f(o + 8) <= 0.0
        || w.f(o + 9) < 0.0
        || w.f(o + 10) <= 0.0
        || w.f(o + 11) <= 0.0
        || w.f(o + 12) <= 0.0
    {
        return Err("Invalid camera lens".into());
    }
    if w.u(o) == 0 && !(w.f(o + 1) > 0.0 && w.f(o + 1) < 180.0)
        || w.u(o) == 1 && (w.f(o + 4) >= w.f(o + 5) || w.f(o + 6) >= w.f(o + 7))
    {
        return Err("Invalid camera projection".into());
    }
    w.reserved(o + 13, 3)?;
    w.affine(o + 16)?;
    Ok(())
}
pub(super) fn prepare_camera(bytes: &[u8], width: u32, height: u32) -> Result<Vec<u8>> {
    if bytes.len() != 128 {
        return Err("Camera descriptor must contain exactly 128 bytes".into());
    }
    validate_camera(&Words(bytes), 0)?;
    let mut pointer = std::ptr::null();
    let mut size = 0;
    let packed = unsafe {
        mt_core_scene_camera(
            bytes.as_ptr(),
            bytes.len(),
            width,
            height,
            &mut pointer,
            &mut size,
        );
        let result = copy_core_result(pointer, size, 144);
        mt_core_reset();
        mt_core_collect();
        result?
    };
    if !packed
        .chunks_exact(4)
        .all(|b| f32::from_le_bytes(b.try_into().unwrap()).is_finite())
    {
        return Err("Camera produces non-finite GPU parameters".into());
    }
    Ok(packed)
}
fn buffer_layout(binding: u32, ty: &str) -> Value {
    json!({"binding":binding,"visibility":4,"buffer":{"type":ty}})
}
fn texture_layout(binding: u32, array: bool, filter: bool) -> Value {
    json!({"binding":binding,"visibility":4,"texture":{"viewDimension":if array {"2d-array"}else{"2d"},"sampleType":if filter {"float"}else{"unfilterable-float"}}})
}
fn binding(binding: u32, kind: &str, id: usize) -> Binding {
    Binding {
        binding,
        kind: kind.into(),
        id,
    }
}

// RAII lifetime matches the committed native scene, including failed candidates.
// Every AOT arena reset/collection leaves these explicitly rooted TS objects alive.
pub(super) struct PreparedState {
    token: u32,
    indexed: bool,
    material_count: usize,
    light_count: usize,
    authoritative_shader: Vec<u8>,
    authoritative_indices: Vec<u8>,
    authoritative_as_indices: Vec<u8>,
    authoritative_bounds: Vec<u8>,
}
impl Drop for PreparedState {
    fn drop(&mut self) {
        let mut pointer = std::ptr::null();
        let mut size = 0;
        unsafe {
            init_core();
            mt_core_scene_release(self.token, &mut pointer, &mut size);
            mt_core_reset();
            mt_core_collect();
        }
    }
}
// Buffer records have zero dimensions; texture records carry their exact extent.
pub(super) struct LightingUpdates {
    resources: Vec<(usize, u32, u32, Vec<u8>)>,
    pub native_layout: Option<hardware::NativeLayout>,
    pub hardware_positions: Option<Vec<u8>>,
}
impl std::ops::Deref for LightingUpdates {
    type Target = [(usize, u32, u32, Vec<u8>)];
    fn deref(&self) -> &Self::Target {
        &self.resources
    }
}
impl<'a> IntoIterator for &'a LightingUpdates {
    type Item = &'a (usize, u32, u32, Vec<u8>);
    type IntoIter = std::slice::Iter<'a, (usize, u32, u32, Vec<u8>)>;
    fn into_iter(self) -> Self::IntoIter {
        self.resources.iter()
    }
}
impl PreparedState {
    fn native_update(
        &self,
        begin: NativeStep,
        finish: NativeStep,
        bytes: &[u8],
        ids: &[usize],
    ) -> Result<LightingUpdates> {
        let requests = native_step(begin, bytes, self.token)?;
        let tlas = if self.indexed {
            requests.clone()
        } else {
            tinybvh::jobs(&requests, true)?
        };
        let mut pointer = std::ptr::null();
        let mut size = 0;
        unsafe {
            finish(
                tlas.as_ptr(),
                tlas.len(),
                self.token,
                &mut pointer,
                &mut size,
            );
        }
        lighting_result(pointer, size, ids)
    }

    pub(super) fn geometry(&self, bytes: &[u8]) -> Result<LightingUpdates> {
        if bytes.len() < 16 || bytes.len() > MAX_BYTES || bytes.len() % 4 != 0 {
            return Err("Invalid geometry update length".into());
        }
        let w = Words(bytes);
        let flags = w.u(3);
        let count = w.u(2);
        if w.u(0) != 1 || flags > 3 || count == 0 || count > 4_194_304 {
            return Err("Invalid geometry version/flags/vertex count".into());
        }
        if w.len()
            != 4 + count * (3 + usize::from(flags & 1 != 0) * 3 + usize::from(flags & 2 != 0) * 4)
        {
            return Err("Geometry attribute length mismatch".into());
        }
        w.finite(4, w.len() - 4)?;
        self.native_update(
            mt_core_native_geometry_begin,
            mt_core_native_geometry_finish,
            bytes,
            &[1, 2, 3, 7, 8, 24, 31, 41],
        )
    }
    pub(super) fn accept_geometry(&self) -> Result<()> {
        let mut pointer = std::ptr::null();
        let mut size = 0;
        unsafe {
            mt_core_scene_accept_geometry(self.token, &mut pointer, &mut size);
        }
        let packet = unsafe {
            let result = copy_core_result(pointer, size, 16);
            mt_core_collect();
            result?
        };
        if packet[..4] != 1u32.to_le_bytes() {
            return Err("Native geometry acceptance failed".into());
        }
        Ok(())
    }
    pub(super) fn hardware_geometry(
        &self,
        updates: &LightingUpdates,
    ) -> Result<(hardware::Capture, HashMap<String, Vec<u8>>)> {
        let mut assets: HashMap<_, _> = updates
            .iter()
            .map(|(id, _, _, data)| (format!("native-{id}"), data.clone()))
            .collect();
        assets.insert("native-33".into(), self.authoritative_shader.clone());
        assets.insert("native-35".into(), self.authoritative_indices.clone());
        assets.insert("native-42".into(), self.authoritative_as_indices.clone());
        if let Some(positions) = &updates.hardware_positions {
            assets.insert("native-41".into(), positions.clone());
        }
        assets.insert("native-38".into(), self.authoritative_bounds.clone());
        let layout = updates
            .native_layout
            .as_ref()
            .ok_or("Missing geometry HWRT metadata")?;
        let mut capture = hardware::capture_from_prepared(&mut assets, layout)?;
        capture.allow_updates();
        Ok((capture, assets))
    }
    pub(super) fn transform(&self, bytes: &[u8]) -> Result<LightingUpdates> {
        if bytes.len() != 80 {
            return Err("Transform descriptor must contain exactly 80 bytes".into());
        }
        let w = Words(bytes);
        if w.u(0) != 1 || w.u(3) != 0 {
            return Err("Invalid transform version/reserved fields".into());
        }
        w.affine(4)?;
        self.native_update(
            mt_core_native_transform_begin,
            mt_core_native_transform_finish,
            bytes,
            &[1, 2, 7, 8, 24, 31],
        )
    }
    pub(super) fn accept_transform(&self) -> Result<()> {
        let mut pointer = std::ptr::null();
        let mut size = 0;
        unsafe {
            mt_core_scene_accept_transform(self.token, &mut pointer, &mut size);
        }
        let packet = unsafe {
            let result = copy_core_result(pointer, size, 16);
            mt_core_collect();
            result?
        };
        if packet[..4] != 1u32.to_le_bytes() {
            return Err("Native transform acceptance failed".into());
        }
        Ok(())
    }
    pub(super) fn environment(&self, bytes: &[u8]) -> Result<LightingUpdates> {
        if bytes.len() < 48 || bytes.len() > MAX_BYTES || bytes.len() % 4 != 0 {
            return Err("Invalid environment descriptor length".into());
        }
        let w = Words(bytes);
        if w.u(0) != 1 || w.u(3) > 1 || w.u(10) != 0 || w.u(11) != 0 {
            return Err("Invalid environment version/visibility/reserved fields".into());
        }
        let mut pixels = 0;
        for i in [1, 8] {
            let (width, height) = (w.u(i), w.u(i + 1));
            if (width == 0) != (height == 0)
                || width > 16382
                || height > 16382
                || width * height > 4_194_304
            {
                return Err("Environment dimensions exceed limits".into());
            }
            pixels += width * height;
        }
        if w.len() != 12 + pixels * 4 {
            return Err("Environment pixel length mismatch".into());
        }
        w.finite(4, 4)?;
        w.finite(12, pixels * 4)?;
        if (12..w.len()).any(|i| w.f(i) < 0.) {
            return Err("Environment pixels must be nonnegative".into());
        }
        let mut pointer = std::ptr::null();
        let mut size = 0;
        unsafe {
            mt_core_scene_environment(
                bytes.as_ptr(),
                bytes.len(),
                self.token,
                &mut pointer,
                &mut size,
            );
        }
        lighting_result(pointer, size, &[7, 8, 21, 22, 23, 24])
    }
    pub(super) fn light(&self, bytes: &[u8]) -> Result<LightingUpdates> {
        if bytes.len() != 128 {
            return Err("Light descriptor must contain exactly 128 bytes".into());
        }
        let w = Words(bytes);
        if w.u(0) != 1 || w.u(1) >= self.light_count {
            return Err("Invalid light descriptor version/index".into());
        }
        w.reserved(2, 2)?;
        w.reserved(12, 4)?;
        validate_light(&w, 4)?;
        let mut pointer = std::ptr::null();
        let mut size = 0;
        unsafe {
            mt_core_scene_light(
                bytes.as_ptr(),
                bytes.len(),
                self.token,
                &mut pointer,
                &mut size,
            );
        }
        lighting_result(pointer, size, &[7, 8, 24])
    }
    pub(super) fn accept_lighting(&self) -> Result<()> {
        let mut pointer = std::ptr::null();
        let mut size = 0;
        unsafe {
            mt_core_scene_accept_lighting(self.token, &mut pointer, &mut size);
        }
        let packet = unsafe {
            let result = copy_core_result(pointer, size, 16);
            mt_core_collect();
            result?
        };
        if packet[..4] != 1u32.to_le_bytes() {
            return Err("Native lighting acceptance failed".into());
        }
        Ok(())
    }
    pub(super) fn material(&self, bytes: &[u8]) -> Result<Vec<u8>> {
        if bytes.len() != 48 {
            return Err("Material descriptor must contain exactly 48 bytes".into());
        }
        let w = Words(bytes);
        if w.u(0) != 1
            || w.u(1) >= self.material_count
            || w.u(2) != 0
            || w.u(3) != 0
            || w.u(11) != 0
        {
            return Err("Invalid material descriptor version/index/reserved fields".into());
        }
        w.finite(4, 7)?;
        let mut pointer = std::ptr::null();
        let mut size = 0;
        unsafe {
            mt_core_scene_material(
                bytes.as_ptr(),
                bytes.len(),
                self.token,
                &mut pointer,
                &mut size,
            );
        }
        if pointer.is_null() || size < 16 || size > 64 * 1024 * 1024 {
            return Err("Invalid AOT material command".into());
        }
        let packet = unsafe {
            let result = copy_core_result(pointer, size, size);
            mt_core_collect();
            result?
        };
        let w = Words(&packet);
        if w.u(0) == 2 {
            let reason = match w.u(1) {
                1 => "Native retained material state is unavailable",
                2 => "Invalid source material reference",
                3 => "Full scene commit required: unused material",
                4 => "Full scene commit required: unlit material affects emission",
                5 => "Full scene commit required: medium shader feature changed",
                _ => "Invalid AOT material rejection",
            };
            return Err(reason.into());
        }
        if w.u(0) != 1
            || w.u(1) != packet.len() - 16
            || w.u(2) != 0
            || w.u(3) != 0
            || packet.len() % 4 != 0
        {
            return Err("Invalid AOT material payload".into());
        }
        w.finite(4, w.len() - 4)?;
        Ok(packet[16..].to_vec())
    }
}
fn lighting_result(pointer: *const u8, size: usize, ids: &[usize]) -> Result<LightingUpdates> {
    let header_length = 16 + ids.len() * 32;
    if pointer.is_null() || size < 16 || size > MAX_PREPARED_BYTES || size % 4 != 0 {
        return Err("Invalid AOT lighting command".into());
    }
    let packet = unsafe {
        let result = copy_core_result(pointer, size, size);
        mt_core_collect();
        result?
    };
    let w = Words(&packet);
    if w.u(0) == 2 {
        return Err(if w.u(1) == 2 {
            "Full scene commit required: resource shape or shader feature changed"
        } else {
            "Invalid or unavailable retained scene reference"
        }
        .into());
    }
    if w.u(0) != 1 || w.u(1) != ids.len() || packet.len() < header_length {
        return Err("Invalid AOT lighting resources".into());
    }
    let mut updates = Vec::new();
    let mut native_layout = None;
    let mut hardware_positions = None;
    for (i, &id) in ids.iter().enumerate() {
        let o = 4 + i * 8;
        let (length, offset) = (w.u(o + 2), w.u(o + 7));
        if w.u(o) != id
            || offset < header_length
            || offset % 4 != 0
            || (id != 31 && length % 4 != 0)
            || offset > packet.len()
            || length > packet.len() - offset
            || w.u(o + 1)
                != if id == 31 || id == 41 {
                    3
                } else {
                    usize::from(id >= 21)
                }
            || w.u(o + 6)
                != if id == 31 || id == 41 {
                    0
                } else if id == 22 {
                    4
                } else if id >= 21 {
                    2
                } else {
                    0
                }
        {
            return Err("Invalid AOT lighting resource span/format".into());
        }
        if id == 41 {
            w.finite(offset / 4, length / 4)?;
            hardware_positions = Some(packet[offset..offset + length].to_vec());
            continue;
        }
        if id == 31 {
            native_layout = Some(serde_json::from_slice::<hardware::NativeLayout>(
                &packet[offset..offset + length],
            )?);
            continue;
        }
        if id >= 7 || id == 3 {
            w.finite(offset / 4, length / 4)?;
        }
        if id == 2 && length >= 160 {
            for i in (offset / 4..(offset + length) / 4).step_by(40) {
                w.finite(i + 3, 37)?;
            }
        }
        updates.push((
            id,
            w.u(o + 3) as u32,
            w.u(o + 4) as u32,
            packet[offset..offset + length].to_vec(),
        ));
    }
    if let Some((_, _, _, data)) = updates.iter().find(|record| record.0 == 1) {
        let rt = updates
            .iter()
            .find(|record| record.0 == 7)
            .ok_or("Missing geometry RT parameters")?;
        if rt.3.len() != 176 {
            return Err("Invalid geometry RT size".into());
        }
        let limit = native_layout
            .as_ref()
            .ok_or("Missing geometry layout")?
            .blas_offset
            * 16;
        if limit > data.len() {
            return Err("Invalid geometry BLAS offset".into());
        }
        let mut stack = if limit == 0 { vec![] } else { vec![0usize] };
        let mut visited = 0;
        let bvh = Words(data);
        while let Some(node) = stack.pop() {
            let at = node * 4;
            visited += 1;
            if at + 8 > limit / 4 || visited > limit / 32 {
                return Err("Invalid geometry TLAS".into());
            }
            bvh.finite(at, 3)?;
            bvh.finite(at + 4, 3)?;
            let child = bvh.u(at + 3) as u32 as i32;
            if child >= 0 {
                stack.push(node + 2);
                stack.push(child as usize);
            }
        }
    }
    Ok(LightingUpdates {
        resources: updates,
        native_layout,
        hardware_positions,
    })
}
pub(super) fn prepare_retained(
    bytes: &[u8],
    hardware: bool,
) -> Result<(Scene, HashMap<String, Vec<u8>>, PreparedState)> {
    static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);
    let token = NEXT
        .fetch_update(
            std::sync::atomic::Ordering::Relaxed,
            std::sync::atomic::Ordering::Relaxed,
            |v| v.checked_add(1),
        )
        .map_err(|_| "Native preparation token space exhausted")?;
    let mut state = PreparedState {
        token,
        indexed: hardware,
        authoritative_shader: Vec::new(),
        authoritative_indices: Vec::new(),
        authoritative_as_indices: Vec::new(),
        authoritative_bounds: Vec::new(),
        light_count: if bytes.len() >= 32 {
            Words(bytes).u(7)
        } else {
            0
        },
        material_count: if bytes.len() >= 28 {
            Words(bytes).u(6)
        } else {
            0
        },
    };
    let (scene, assets) = prepare_impl(bytes, token, hardware, false)?;
    state.authoritative_shader = assets
        .get("native-33")
        .ok_or("Missing authoritative shader")?
        .clone();
    state.authoritative_as_indices = assets.get("native-42").cloned().unwrap_or_default();
    state.authoritative_bounds = assets.get("native-38").cloned().unwrap_or_default();
    state.authoritative_indices = assets
        .get("native-35")
        .ok_or("Missing explicit HWRT indices")?
        .clone();
    Ok((scene, assets, state))
}
pub(super) fn prepare_hardware(bytes: &[u8]) -> Result<(Scene, HashMap<String, Vec<u8>>)> {
    prepare_diagnostic(bytes, hardware::direct_input_enabled())
}
pub(super) fn prepare_diagnostic(
    bytes: &[u8],
    hardware: bool,
) -> Result<(Scene, HashMap<String, Vec<u8>>)> {
    prepare_impl(bytes, 0, hardware, true)
}
pub(super) fn prepare(bytes: &[u8]) -> Result<(Scene, HashMap<String, Vec<u8>>)> {
    prepare_impl(bytes, 0, false, false)
}
type NativeStep = unsafe extern "C" fn(*const u8, usize, u32, *mut *const u8, *mut usize);
fn native_step(step: NativeStep, bytes: &[u8], token: u32) -> Result<Vec<u8>> {
    let mut pointer = std::ptr::null();
    let mut size = 0;
    unsafe {
        step(bytes.as_ptr(), bytes.len(), token, &mut pointer, &mut size);
    }
    if pointer.is_null() || size < 16 || size > MAX_PREPARED_BYTES {
        return Err("Invalid native scene construction result".into());
    }
    let packet = unsafe {
        let result = copy_core_result(pointer, size, size);
        mt_core_collect();
        result?
    };
    let w = Words(&packet);
    if w.u(0) != 1 {
        return Err(match w.u(1) {
            2 => "Full scene commit required: resource shape or shader feature changed",
            1 | 3 => "Invalid or unavailable retained scene reference",
            _ => "Native scene preparation rejected the scene (invalid IES or displacement inputs)",
        }
        .into());
    }
    Ok(packet)
}
fn prepare_impl(
    bytes: &[u8],
    token: u32,
    hardware: bool,
    diagnostic: bool,
) -> Result<(Scene, HashMap<String, Vec<u8>>)> {
    let profile = std::env::var_os("MUTRACER_NATIVE_PROFILE").is_some_and(|v| v == "1");
    let started = Instant::now();
    validate(bytes)?;
    let validated = Instant::now();
    // The ABI bytes are borrowed only during this call; the AOT decoder copies
    // every retained array. Copy result bytes before reset or collection.
    init_core();
    let work = (|| -> Result<Vec<u8>> {
        if hardware {
            let result = native_step(mt_core_native_hardware_scene, bytes, token)?;
            if profile {
                eprintln!(
                    "{}",
                    json!({"nativePreparationProfile": {
                "validateMs": validated.duration_since(started).as_secs_f64()*1000.0,
                "hardwarePrepareComposeMs": validated.elapsed().as_secs_f64()*1000.0,
                "blasMs":0.0,"tlasMs":0.0}})
                );
            }
            return Ok(result);
        }
        let requests = native_step(mt_core_native_scene_begin, bytes, token)?;
        let decoded = Instant::now();
        let blases = tinybvh::jobs_with_ids(&requests, false, diagnostic)?;
        let built = Instant::now();
        let instances = native_step(mt_core_native_scene_blas, &blases, token)?;
        let packed = Instant::now();
        let tlas = tinybvh::jobs(&instances, true)?;
        let top = Instant::now();
        let result = native_step(mt_core_native_scene_finish, &tlas, token)?;
        if profile {
            eprintln!(
                "{}",
                json!({"nativePreparationProfile": {
                    "validateMs": validated.duration_since(started).as_secs_f64() * 1000.0,
                    "decodeMs": decoded.duration_since(validated).as_secs_f64() * 1000.0,
                    "blasMs": built.duration_since(decoded).as_secs_f64() * 1000.0,
                    "meshMs": packed.duration_since(built).as_secs_f64() * 1000.0,
                    "tlasMs": top.duration_since(packed).as_secs_f64() * 1000.0,
                    "composeMs": top.elapsed().as_secs_f64() * 1000.0,
                }})
            );
        }
        Ok(result)
    })();
    if work.is_err() {
        let mut pointer = std::ptr::null();
        let mut size = 0;
        unsafe {
            mt_core_scene_release(token, &mut pointer, &mut size);
            mt_core_reset();
            mt_core_collect();
        }
    }
    let packet = work?;
    let w = Words(&packet);
    if w.u(0) == 2 {
        return Err(
            "Native scene preparation rejected the scene (invalid IES or displacement inputs)"
                .into(),
        );
    }
    let count = w.u(1);
    if w.u(0) != 1 || !(24..=27).contains(&count) || packet.len() < 16 + count * 32 {
        return Err("Invalid native resource packet".into());
    }
    let mut assets = HashMap::new();
    let mut buffers = Vec::new();
    let mut textures = Vec::new();
    let mut shader = String::new();
    let mut native_layout = None;
    for i in 0..count {
        let o = 4 + i * 8;
        let id = w.u(o);
        let kind = w.u(o + 1);
        let length = w.u(o + 2);
        let offset = w.u(o + 7);
        if offset < 16 + count * 32 || offset > packet.len() || length > packet.len() - offset {
            return Err("Native resource span exceeds packet".into());
        }
        let name = format!("native-{id}");
        let mut data = packet[offset..offset + length].to_vec();
        if kind == 0 {
            // Runtime storage arrays require one complete element even for empty payloads.
            let minimum = 16;
            data.resize(data.len().max(minimum), 0);
            buffers.push(Buffer {
                id,
                size: data.len() as u64,
                usage: if id <= 4 { 140 } else { 72 },
                file: name.clone(),
            });
        } else if kind == 1 {
            let (width, height, depth) = (w.u(o + 3) as u32, w.u(o + 4) as u32, w.u(o + 5) as u32);
            let (format, bpp) = match w.u(o + 6) {
                0 => ("rgba8unorm", 4),
                1 => ("rgba16float", 8),
                2 => ("rgba32float", 16),
                3 => ("r32float", 4),
                4 => ("rg32float", 8),
                _ => return Err("Unknown native texture encoding".into()),
            };
            if data.len() != width as usize * height as usize * depth as usize * bpp {
                return Err("Native texture length mismatch".into());
            }
            textures.push(Texture{id,width,height,depth,format:format.into(),usage:6,writes:vec![json!({"origin":[0,0,0],"size":[width,height,depth],"layout":{"bytesPerRow":width as usize*bpp,"rowsPerImage":height},"file":name})]});
        } else if kind == 2 {
            if id == 30 {
                shader = name.clone();
            } else if id != 33 && id != 34 && id != 36 && id != 37 && id != 39 {
                return Err("Unknown native shader variant".into());
            }
        } else if kind == 3 && id == 31 {
            native_layout = Some(serde_json::from_slice::<hardware::NativeLayout>(&data)?);
        } else if kind == 3
            && (id == 35 || id == 38 || id == 40 || id == 41 || id == 42)
            && data.len() % 4 == 0
        {
            // CPU packet payload; uploaded only when HWRT is selected.
        } else {
            return Err("Unknown native resource command".into());
        }
        if assets.insert(name, data).is_some() {
            return Err("Duplicate native resource".into());
        }
    }
    let pixels = w.u(2) * w.u(3);
    for id in 10..=13 {
        let size = pixels * if id == 13 { 48 } else { 16 };
        let name = format!("native-{id}");
        assets.insert(name.clone(), vec![0; size]);
        buffers.push(Buffer {
            id,
            size: size as u64,
            usage: 140,
            file: name,
        });
    }
    let groups = vec![
        Group {
            layout: (0..4)
                .map(|i| buffer_layout(i, "read-only-storage"))
                .collect(),
            entries: (0..4)
                .map(|i| binding(i, "buffer", i as usize + 1))
                .collect(),
        },
        Group {
            layout: vec![
                json!({"binding":0,"visibility":4,"sampler":{}}),
                texture_layout(1, true, true),
                buffer_layout(3, "uniform"),
                texture_layout(4, false, false),
                texture_layout(5, false, false),
                texture_layout(6, false, false),
                texture_layout(8, false, false),
                texture_layout(9, false, false),
                texture_layout(10, false, false),
            ],
            entries: vec![
                binding(0, "sampler", 40),
                binding(1, "texture", 20),
                binding(3, "buffer", 5),
                binding(4, "texture", 21),
                binding(5, "texture", 22),
                binding(6, "texture", 23),
                binding(8, "texture", 24),
                binding(9, "texture", 25),
                binding(10, "texture", 26),
            ],
        },
        Group {
            layout: (0..3).map(|i| buffer_layout(i, "uniform")).collect(),
            entries: (0..3)
                .map(|i| binding(i, "buffer", i as usize + 6))
                .collect(),
        },
        Group {
            layout: (0..4).map(|i| buffer_layout(i, "storage")).collect(),
            entries: (0..4)
                .map(|i| binding(i, "buffer", i as usize + 10))
                .collect(),
        },
    ];
    Ok((
        Scene {
            format: 1,
            width: w.u(2) as u32,
            height: w.u(3) as u32,
            samples: 64,
            shader,
            native_layout,
            entry_point: "main".into(),
            buffers,
            textures,
            samplers: vec![json!({"id":40})],
            bind_groups: groups,
            rt_uniform: 7,
            color_output: 10,
            normal_output: Some(11),
            albedo_output: Some(12),
            camera_uniform: Some(6),
            material_buffer: Some(4),
            material_count: None,
            material_stride: None,
            material_offsets: None,
            hwrt: None,
            native_bvh: None,
            sampling: Some(Sampling {
                max_samples: 64,
                pattern: "sobol".into(),
            }),
        },
        assets,
    ))
}

/// Raw version-1 descriptors; paths and all bytes are borrowed for the call.
/// # Safety
/// `input` must be readable for `length` bytes and output/error strings follow
/// mutracer-scene.h. Calls use the same owner thread as the replay API.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_probe_render_scene(
    input: *const u8,
    length: usize,
    output: *const c_char,
    samples: u32,
    error: *mut c_char,
    error_capacity: usize,
) -> i32 {
    let result = std::panic::catch_unwind(|| -> Result<()> {
        if input.is_null() || output.is_null() || length > MAX_BYTES {
            return Err("Null scene input or oversized descriptor".into());
        }
        if samples == 0 || samples > 4096 {
            return Err("Samples must be 1..4096".into());
        }
        let _entry = ENTRY_LOCK
            .try_lock()
            .map_err(|_| "Native probe is already active or poisoned")?;
        context::check_owner()?;
        let bytes = unsafe { std::slice::from_raw_parts(input, length) };
        let output = unsafe { CStr::from_ptr(output) }.to_str()?;
        let (scene, assets) = prepare(bytes)?;
        render_scene(
            Path::new(""),
            scene,
            Path::new(output),
            &RenderOptions {
                samples,
                ..Default::default()
            },
            Some(&assets),
        )
    });
    let message = match result {
        Ok(Ok(())) => return 0,
        Ok(Err(e)) => e.to_string(),
        Err(_) => "Native scene renderer panicked".into(),
    };
    if !error.is_null() && error_capacity > 0 {
        let count = message.len().min(error_capacity - 1);
        unsafe {
            std::ptr::copy_nonoverlapping(message.as_ptr(), error.cast(), count);
            *error.add(count) = 0;
        }
    }
    1
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn camera_rejects_finite_inputs_with_nonfinite_packing_and_recovers() {
        let _test = ABI_TEST_LOCK.lock().unwrap();
        let _entry = ENTRY_LOCK.lock().unwrap();
        init_core();
        let scene = input();
        let camera = &scene[88 * 4..120 * 4];
        let expected = prepare_camera(camera, 8, 8).unwrap();
        let mut extreme = camera.to_vec();
        extreme[28 * 4..29 * 4].copy_from_slice(&f32::MAX.to_le_bytes());
        assert!(validate_camera(&Words(&extreme), 0).is_ok());
        assert!(
            prepare_camera(&extreme, 8, 8)
                .unwrap_err()
                .to_string()
                .contains("non-finite")
        );
        assert_eq!(prepare_camera(camera, 8, 8).unwrap(), expected);
    }
    fn input() -> Vec<u8> {
        let mut words = vec![0u32; 132];
        words[..15].copy_from_slice(&[1, 132, 8, 8, 1, 1, 1, 0, 0, 32, 44, 64, 88, 88, 88]);
        words[16..20].copy_from_slice(&[0, 0, 0, 1f32.to_bits()]);
        words[32..36].copy_from_slice(&[3, 3, 120, 129]);
        for off in [48, 104] {
            for k in [0, 5, 10, 15] {
                words[off + k] = 1f32.to_bits();
            }
        }
        for (k, x) in [(0, 0.8), (1, 0.8), (2, 0.8), (3, 0.3), (6, 1.5), (13, 1.)] {
            words[64 + k] = (x as f32).to_bits();
        }
        for k in 15..19 {
            words[64 + k] = u32::MAX;
        }
        for (k, x) in [
            (1, 45.),
            (2, 0.1),
            (3, 100.),
            (8, 1.),
            (10, 10.),
            (11, 24.),
            (12, 1.),
        ] {
            words[88 + k] = (x as f32).to_bits();
        }
        for (k, x) in [-1f32, 0., 0., 1., 0., 0., 0., 1., 0.].iter().enumerate() {
            words[120 + k] = x.to_bits();
        }
        words[129..].copy_from_slice(&[0, 1, 2]);
        words.into_iter().flat_map(u32::to_le_bytes).collect()
    }
    fn change(bytes: &[u8], word: usize, value: u32) -> Vec<u8> {
        let mut result = bytes.to_vec();
        result[word * 4..word * 4 + 4].copy_from_slice(&value.to_le_bytes());
        result
    }
    #[test]
    fn raw_descriptor_validation_preserves_supported_input() {
        assert!(validate(&input()).is_ok());
    }
    #[test]
    fn bad_spans_references_numbers_and_unknown_fields_are_recoverable() {
        let bytes = input();
        for (word, value) in [
            (0, 4),
            (1, 1),
            (2, 0),
            (4, 0),
            (7, 65),
            (9, u32::MAX),
            (34, 131),
            (35, 131),
            (44, 1),
            (45, 1),
            (46, 1),
            (48, 0),
            (79, 0),
            (88, 2),
            (89, 0),
            (90, 0),
            (96, 0),
            (101, 1),
            (120, f32::NAN.to_bits()),
            (129, 3),
            (20, 1),
        ] {
            assert!(
                validate(&change(&bytes, word, value)).is_err(),
                "word {word}"
            );
        }
        assert!(validate(&[]).is_err());
        assert!(validate(&bytes[..bytes.len() - 1]).is_err());
    }
    fn extend(mut bytes: Vec<u8>, words: &[u32]) -> Vec<u8> {
        for word in words {
            bytes.extend_from_slice(&word.to_le_bytes());
        }
        let count = (bytes.len() / 4) as u32;
        bytes[4..8].copy_from_slice(&count.to_le_bytes());
        bytes
    }
    #[test]
    fn v2_environment_roles_validate_encoding_references_and_flags() {
        let mut descriptor = vec![0u32; 16];
        descriptor[..4].copy_from_slice(&[1, 1, 1, 144]);
        descriptor[6] = 1f32.to_bits();
        descriptor[7] = 1f32.to_bits();
        descriptor[15] = 1f32.to_bits();
        let mut bytes = extend(change(&input(), 0, 2), &descriptor);
        for (word, value) in [(8, 1), (13, 132), (20, 1), (21, 1)] {
            bytes = change(&bytes, word, value);
        }
        assert!(validate(&bytes).is_ok());
        for (word, value) in [(20, 2), (21, 2), (22, 8), (22, 4), (134, 0), (135, 147)] {
            assert!(
                validate(&change(&bytes, word, value)).is_err(),
                "word {word}"
            );
        }
        assert!(validate(&change(&change(&bytes, 21, 0), 22, 4)).is_ok());
    }
    #[test]
    fn v2_material_extensions_validate_types_uniqueness_and_support() {
        let mut bytes = extend(change(&input(), 0, 2), &[5, 0.6f32.to_bits(), 0, 0]);
        bytes = change(&bytes, 83, 1);
        bytes = change(&bytes, 84, 132);
        assert!(validate(&bytes).is_ok());
        for (word, value) in [
            (132, 0),
            (132, 59),
            (132, 76),
            (133, f32::NAN.to_bits()),
            (134, 1),
            (83, 76),
            (84, 135),
        ] {
            assert!(validate(&change(&bytes, word, value)).is_err());
        }
        for (id, payload) in [(37, 2), (41, 4), (39, 0)] {
            assert!(validate(&change(&change(&bytes, 132, id), 133, payload)).is_err());
        }
        assert!(validate(&change(&change(&bytes, 132, 39), 133, u32::MAX)).is_ok());
        let duplicate = change(&extend(bytes, &[5, 0.2f32.to_bits(), 0, 0]), 83, 2);
        assert!(validate(&duplicate).is_err());
    }
    #[test]
    fn v2_vertex_attributes_and_material_tables_reject_invalid_spans_and_indices() {
        // Three RGB colors, three XYZW tangents, local material IDs and one material table.
        let mut payload = vec![0u32; 25];
        for i in 0..3 {
            payload[9 + i * 4] = 1f32.to_bits();
            payload[12 + i * 4] = 1f32.to_bits();
        }
        let mut bytes = extend(change(&input(), 0, 2), &payload);
        for (word, value) in [(39, 132), (40, 141), (41, 153), (46, 156), (47, 1)] {
            bytes = change(&bytes, word, value);
        }
        assert!(validate(&bytes).is_ok());
        for (word, value) in [
            (39, 156),
            (40, 156),
            (41, 156),
            (153, 1),
            (156, 1),
            (47, 0),
            (132, f32::NAN.to_bits()),
            (144, f32::INFINITY.to_bits()),
        ] {
            assert!(
                validate(&change(&bytes, word, value)).is_err(),
                "word {word}"
            );
        }
    }
    #[test]
    fn v2_batches_validate_transforms_colors_empty_and_ordinary_meshes() {
        let mut payload = vec![0u32; 23];
        payload[..4].copy_from_slice(&[1, 136, 152, 0]);
        for k in [0, 5, 10, 15] {
            payload[4 + k] = 1f32.to_bits();
        }
        payload[20..].fill(1f32.to_bits());
        let bytes = change(&extend(change(&input(), 0, 2), &payload), 23, 132);
        assert!(validate(&bytes).is_ok());
        for (word, value) in [
            (132, 65537),
            (133, 154),
            (134, 154),
            (135, 1),
            (136, 0),
            (139, 1f32.to_bits()),
            (152, f32::NAN.to_bits()),
            (132, 0),
            (132, u32::MAX),
        ] {
            assert!(
                validate(&change(&bytes, word, value)).is_err(),
                "word {word}"
            );
        }
        let no_arrays = change(&change(&bytes, 133, 0), 134, 0);
        assert!(validate(&change(&no_arrays, 132, 0)).is_ok());
        assert!(validate(&change(&no_arrays, 132, u32::MAX)).is_ok());
    }
    #[test]
    fn v3_displacement_checks_projection_uv_texture_and_numeric_limits() {
        let mut payload = vec![0u32; 54];
        payload[6..10].copy_from_slice(&[2, 2, 1, 150]);
        payload[12] = 1f32.to_bits();
        payload[13] = 1f32.to_bits();
        payload[34..].copy_from_slice(&[
            59,
            0,
            0,
            0,
            60,
            0.3f32.to_bits(),
            0,
            0,
            61,
            0.01f32.to_bits(),
            0,
            0,
            57,
            0,
            0,
            0,
            58,
            1f32.to_bits(),
            0,
            0,
        ]);
        let mut bytes = extend(change(&input(), 0, 3), &payload);
        for (word, value) in [(8, 1), (13, 138), (37, 132), (83, 5), (84, 166)] {
            bytes = change(&bytes, word, value);
        }
        assert!(validate(&bytes).is_ok());
        for (word, value) in [
            (0, 2),
            (37, 0),
            (138, 3),
            (139, 1),
            (175, 0),
            (179, 4),
            (183, 1e30f32.to_bits()),
            (120, 1e30f32.to_bits()),
        ] {
            assert!(
                validate(&change(&bytes, word, value)).is_err(),
                "word {word}"
            );
        }
        assert!(validate(&change(&change(&bytes, 37, 0), 179, 1)).is_ok());
        let mut zero_coordinates = bytes.clone();
        for word in 120..129 {
            zero_coordinates = change(&zero_coordinates, word, 0);
        }
        assert!(validate(&change(&zero_coordinates, 183, 1e30f32.to_bits())).is_err());
        // Zero amplitude does not require UVs or a square texture.
        assert!(validate(&change(&change(&change(&bytes, 37, 0), 171, 0), 139, 1)).is_ok());
    }
    #[test]
    fn v3_light_extensions_validate_roles_utf8_and_byte_spans() {
        let mut light = vec![0u32; 28];
        light[0] = 3;
        for k in 1..=7 {
            light[k] = 1f32.to_bits();
        }
        light[6] = 20f32.to_bits();
        light[7] = 40f32.to_bits();
        light[9] = 160;
        light[10] = 4;
        for k in [0, 5, 10, 15] {
            light[12 + k] = 1f32.to_bits();
        }
        light.push(u32::from_le_bytes(*b"test"));
        let mut bytes = extend(change(&input(), 0, 3), &light);
        bytes = change(&change(&bytes, 7, 1), 12, 132);
        assert!(validate(&bytes).is_ok()); // Syntax is checked by the original AOT IES parser.
        for (word, value) in [
            (0, 2),
            (140, 1),
            (141, 161),
            (142, 0),
            (142, 16385),
            (143, 1),
            (160, u32::MAX),
        ] {
            assert!(
                validate(&change(&bytes, word, value)).is_err(),
                "word {word}"
            );
        }
    }
}
