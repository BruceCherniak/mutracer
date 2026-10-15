//! Validated raw scene boundary. Only returned AOT bytes are retained by Rust.
use super::*;
unsafe extern "C" {
    fn mt_core_scene(input: *const u8, length: usize, output: *mut *const u8, size: *mut usize);
}
const MAX_BYTES: usize = 64 * 1024 * 1024;

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
        if v == 0 || n == 0 || n % 3 != 0 || v > 1_000_000 || n > 3_000_000 {
            return Err("Invalid geometry counts".into());
        }
        geometry_words += v * 32 + n * 24;
        geometry_costs.push(v * 32 + n * 24);
        if geometry_words > MAX_BYTES / 4 {
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
            if geometry_words > MAX_BYTES / 4 {
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
            if geometry_words > MAX_BYTES / 4 {
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
        if pixels > 4_194_304 {
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
        if w.u(o) > 3 {
            return Err("Unsupported analytic light type".into());
        }
        w.finite(o + 1, 7)?;
        if (1..=5).any(|k| w.f(o + k) < 0.0) {
            return Err("Negative light color/intensity/size".into());
        }
        if w.u(o) == 0
            && (w.f(o + 5) <= 0.0 || w.f(o + 6) <= 0.0 || !(0.0..=1.0).contains(&w.f(o + 7)))
        {
            return Err("Invalid rectangular light".into());
        }
        if w.u(o) == 3
            && (w.f(o + 6) < 0.0
                || w.f(o + 6) > w.f(o + 7)
                || w.f(o + 7) <= 0.0
                || w.f(o + 7) >= 90.0)
        {
            return Err("Invalid spot light angles".into());
        }
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
        w.affine(o + 12)?;
    }
    let o = w.u(14);
    w.span(o, 32)?;
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

pub(super) fn prepare(bytes: &[u8]) -> Result<(Scene, HashMap<String, Vec<u8>>)> {
    validate(bytes)?;
    // The ABI bytes are borrowed only during this call; the AOT decoder copies
    // every retained array. Copy result bytes before reset or collection.
    unsafe {
        mt_core_init();
    }
    let mut pointer = std::ptr::null();
    let mut size = 0;
    unsafe {
        mt_core_scene(bytes.as_ptr(), bytes.len(), &mut pointer, &mut size);
    }
    if pointer.is_null() || size < 16 || size > 256 * 1024 * 1024 {
        return Err("Invalid native scene command".into());
    }
    let packet = unsafe { copy_core_result(pointer, size, size)? };
    unsafe {
        mt_core_collect();
    }
    let w = Words(&packet);
    if w.u(0) == 2 {
        return Err(
            "Native scene preparation rejected the scene (invalid IES or displacement inputs)"
                .into(),
        );
    }
    let count = w.u(1);
    if w.u(0) != 1 || count != 16 || packet.len() < 16 + count * 32 {
        return Err("Invalid native resource packet".into());
    }
    let mut assets = HashMap::new();
    let mut buffers = Vec::new();
    let mut textures = Vec::new();
    let mut shader = String::new();
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
            shader = name.clone();
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
