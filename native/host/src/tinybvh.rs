//! Native binding to the same official TinyBVH adapter used by the browser.
use super::Result;
use std::ffi::c_void;
unsafe extern "C" {
    fn mt_native_tiny_blas(
        positions: *const f32,
        vertices: u32,
        normals: *const f32,
        indices: *const u32,
        index_count: u32,
        scale: f32,
        ranges: *const f32,
    ) -> *mut c_void;
    fn mt_native_tiny_aabbs(boxes: *const f32, count: u32) -> *mut c_void;
    fn tinybvh_result_data(result: *const c_void) -> usize;
    fn tinybvh_result_size(result: *const c_void) -> u32;
    fn tinybvh_result_max_depth(result: *const c_void) -> u32;
    fn tinybvh_result_layout(result: *const c_void) -> u32;
    fn tinybvh_result_destroy(result: *mut c_void);
}
struct Handle(*mut c_void);
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe { tinybvh_result_destroy(self.0) }
    }
}
pub(super) struct Built {
    pub bytes: Vec<u8>,
    pub depth: u32,
    pub leaf_primitives: u32,
}
fn finish(pointer: *mut c_void, primitive_count: usize) -> Result<Built> {
    if pointer.is_null() {
        return Err("Native TinyBVH allocation/build failed".into());
    }
    let handle = Handle(pointer);
    let size = unsafe { tinybvh_result_size(handle.0) } as usize;
    let address = unsafe { tinybvh_result_data(handle.0) };
    let depth = unsafe { tinybvh_result_max_depth(handle.0) };
    if unsafe { tinybvh_result_layout(handle.0) } != 0
        || size % 16 != 0
        || size > 1024 * 1024 * 1024
        || (size > 0 && address == 0)
    {
        return Err("Invalid native TinyBVH output".into());
    }
    if size == 0 {
        return Ok(Built {
            bytes: vec![],
            depth: 0,
            leaf_primitives: 0,
        });
    }
    let bytes = unsafe { std::slice::from_raw_parts(address as *const u8, size) }.to_vec();
    let words: Vec<_> = bytes
        .chunks_exact(4)
        .map(|v| u32::from_le_bytes(v.try_into().unwrap()))
        .collect();
    let mut stack = vec![(0usize, 1u32)];
    let mut visited = vec![false; size / 16];
    let mut max_depth = 0;
    let mut leaf_primitives = 0;
    let mut count = 0usize;
    while let Some((node, level)) = stack.pop() {
        if node >= visited.len() || visited[node] || node * 4 + 8 > words.len() {
            return Err("Invalid native TinyBVH node graph".into());
        }
        visited[node] = true;
        max_depth = max_depth.max(level);
        let at = node * 4;
        if [0, 1, 2, 4, 5, 6]
            .iter()
            .any(|i| !f32::from_bits(words[at + i]).is_finite())
        {
            return Err("Non-finite native TinyBVH bounds".into());
        }
        let child = words[at + 3] as i32;
        if child >= 0 {
            stack.push((node + 2, level + 1));
            stack.push((child as usize, level + 1));
        } else {
            let primitives = child.unsigned_abs();
            leaf_primitives = leaf_primitives.max(primitives);
            if (node + 2 + primitives as usize) * 4 > words.len() {
                return Err("Invalid native TinyBVH leaf".into());
            }
            count += primitives as usize;
        }
    }
    if max_depth != depth || count != primitive_count {
        return Err("Native TinyBVH primitive/depth mismatch".into());
    }
    Ok(Built {
        bytes,
        depth,
        leaf_primitives,
    })
}
pub(super) fn blas(
    positions: &[f32],
    normals: Option<&[f32]>,
    indices: &[u32],
    scale: f32,
    ranges: Option<&[f32]>,
) -> Result<Built> {
    if positions.len() % 3 != 0
        || indices.len() % 3 != 0
        || positions.len() / 3 > 4_194_304
        || indices.len() > 12_582_912
        || indices.iter().any(|&v| v as usize >= positions.len() / 3)
        || positions.iter().any(|v| !v.is_finite())
        || !scale.is_finite()
        || normals.is_some_and(|v| v.len() != positions.len() || v.iter().any(|v| !v.is_finite()))
        || ranges
            .is_some_and(|v| v.len() != indices.len() / 3 * 2 || v.iter().any(|v| !v.is_finite()))
    {
        return Err("Invalid native TinyBVH geometry".into());
    }
    let pointer = unsafe {
        mt_native_tiny_blas(
            positions.as_ptr(),
            (positions.len() / 3) as u32,
            normals.map_or(std::ptr::null(), |v| v.as_ptr()),
            indices.as_ptr(),
            indices.len() as u32,
            scale,
            ranges.map_or(std::ptr::null(), |v| v.as_ptr()),
        )
    };
    finish(pointer, indices.len() / 3)
}
pub(super) fn aabbs(boxes: &[f32]) -> Result<Built> {
    if boxes.len() % 6 != 0
        || boxes.len() / 6 > 65_536
        || boxes.iter().any(|v| !v.is_finite())
        || boxes
            .chunks_exact(6)
            .any(|b| (0..3).any(|i| b[i] > b[i + 3]))
    {
        return Err("Invalid native TinyBVH instance bounds".into());
    }
    finish(
        unsafe { mt_native_tiny_aabbs(boxes.as_ptr(), (boxes.len() / 6) as u32) },
        boxes.len() / 6,
    )
}
// Internal batch protocol:resourcePacket records carry packed input jobs, then
// the same records return BVH2 bytes/depth/leaf bounds. No JS-prepared BVH input.
pub(super) fn jobs(packet: &[u8], instances: bool) -> Result<Vec<u8>> {
    let word = |i: usize| u32::from_le_bytes(packet[i * 4..i * 4 + 4].try_into().unwrap()) as usize;
    if packet.len() < 16 || packet.len() % 4 != 0 || word(0) != 1 {
        return Err("Invalid native TinyBVH request packet".into());
    }
    let count = word(1);
    let header = 16 + count * 32;
    if count > 65_536 || packet.len() < header || (instances && count != 1) {
        return Err("Invalid native TinyBVH request count".into());
    }
    let mut built = Vec::new();
    let mut total = header;
    for i in 0..count {
        let o = 4 + i * 8;
        let length = word(o + 2);
        let offset = word(o + 7);
        if word(o) != i
            || word(o + 1) != 0
            || offset < header
            || offset % 4 != 0
            || length % 4 != 0
            || offset > packet.len()
            || length > packet.len() - offset
        {
            return Err("Invalid native TinyBVH request span".into());
        }
        let data = &packet[offset..offset + length];
        let floats = |data: &[u8]| {
            data.chunks_exact(4)
                .map(|v| f32::from_le_bytes(v.try_into().unwrap()))
                .collect::<Vec<_>>()
        };
        let result = if instances {
            aabbs(&floats(data))?
        } else {
            if data.len() < 16 {
                return Err("Short native TinyBVH geometry request".into());
            }
            let u =
                |i: usize| u32::from_le_bytes(data[i * 4..i * 4 + 4].try_into().unwrap()) as usize;
            let vertices = u(0);
            let indices = u(1);
            let displacement = u(2);
            if vertices > 4_194_304 || indices > 12_582_912 || displacement > 1 || indices % 3 != 0
            {
                return Err("Invalid native TinyBVH geometry request".into());
            }
            let positions_size = vertices * 12;
            let normals_size = positions_size * displacement;
            let indices_size = indices * 4;
            let ranges_size = indices / 3 * 8 * displacement;
            if data.len() != 16 + positions_size + normals_size + indices_size + ranges_size {
                return Err("Native TinyBVH request length mismatch".into());
            }
            let p = 16;
            let n = p + positions_size;
            let idx = n + normals_size;
            let r = idx + indices_size;
            let positions = floats(&data[p..n]);
            let normals = floats(&data[n..idx]);
            let ranges = floats(&data[r..]);
            let indices: Vec<_> = data[idx..r]
                .chunks_exact(4)
                .map(|v| u32::from_le_bytes(v.try_into().unwrap()))
                .collect();
            blas(
                &positions,
                if displacement == 1 {
                    Some(&normals)
                } else {
                    None
                },
                &indices,
                f32::from_bits(u(3) as u32),
                if displacement == 1 {
                    Some(&ranges)
                } else {
                    None
                },
            )?
        };
        total += result.bytes.len();
        if total > 1024 * 1024 * 1024 || result.depth > 64 {
            return Err("Native TinyBVH result exceeds byte/stack budget".into());
        }
        built.push(result);
    }
    let mut output = vec![0u8; total];
    let put = |data: &mut [u8], i: usize, value: u32| {
        data[i * 4..i * 4 + 4].copy_from_slice(&value.to_le_bytes())
    };
    put(&mut output, 0, 1);
    put(&mut output, 1, count as u32);
    let mut offset = header;
    for (i, bvh) in built.iter().enumerate() {
        let o = 4 + i * 8;
        put(&mut output, o, i as u32);
        put(&mut output, o + 2, bvh.bytes.len() as u32);
        put(&mut output, o + 3, bvh.depth);
        put(&mut output, o + 4, bvh.leaf_primitives);
        put(&mut output, o + 7, offset as u32);
        output[offset..offset + bvh.bytes.len()].copy_from_slice(&bvh.bytes);
        offset += bvh.bytes.len();
    }
    Ok(output)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_triangle_preserves_geometry_and_lifetime() {
        for _ in 0..100 {
            let b = blas(
                &[-1., 0., 0., 1., 0., 0., 0., 2., 0.],
                None,
                &[0, 1, 2],
                0.,
                None,
            )
            .unwrap();
            assert_eq!((b.depth, b.leaf_primitives), (1, 1));
            let w: Vec<_> = b
                .bytes
                .chunks_exact(4)
                .map(|v| u32::from_le_bytes(v.try_into().unwrap()))
                .collect();
            assert_eq!(&w[8..11], &[0, 1, 2]);
            assert_eq!(f32::from_bits(w[0]), -1.);
            assert_eq!(f32::from_bits(w[5]), 2.);
        }
    }
    #[test]
    fn native_boxes_and_empty_inputs() {
        assert!(aabbs(&[]).unwrap().bytes.is_empty());
        let b = aabbs(&[-2., 0., 0., -1., 1., 1., 1., 0., 0., 2., 1., 1.]).unwrap();
        assert!(!b.bytes.is_empty());
        assert!(blas(&[f32::NAN, 0., 0.], None, &[0, 0, 0], 0., None).is_err());
        assert!(aabbs(&[2., 0., 0., 1., 1., 1.]).is_err());
    }
    #[test]
    fn large_threaded_builds_keep_bounds_and_every_primitive() {
        // Cross upstream's 50,000-primitive worker threshold for BLAS and TLAS.
        // Serialized output must remain deterministic despite task scheduling.
        let count = 65_536usize;
        let mut positions = Vec::with_capacity(count * 9);
        let mut boxes = Vec::with_capacity(count * 6);
        for i in 0..count {
            let x = (i % 256) as f32;
            let y = (i / 256) as f32;
            let z = ((i * 17) % 31) as f32 * 0.125;
            positions.extend_from_slice(&[x, y, z, x + 0.75, y, z, x, y + 0.5, z + 0.25]);
            boxes.extend_from_slice(&[x, y, z, x + 0.75, y + 0.5, z + 0.25]);
        }
        let indices: Vec<u32> = (0..count as u32 * 3).collect();
        for is_tlas in [false, true] {
            let build = || {
                if is_tlas {
                    aabbs(&boxes).unwrap()
                } else {
                    blas(&positions, None, &indices, 0., None).unwrap()
                }
            };
            let built = build();
            for _ in 0..3 {
                assert_eq!(build().bytes, built.bytes);
            }
            let words: Vec<u32> = built
                .bytes
                .chunks_exact(4)
                .map(|v| u32::from_le_bytes(v.try_into().unwrap()))
                .collect();
            let mut stack = vec![(0usize, None::<[f32; 6]>)];
            let mut seen = vec![false; count];
            while let Some((node, parent)) = stack.pop() {
                let at = node * 4;
                let bounds = [0, 1, 2, 4, 5, 6].map(|j| f32::from_bits(words[at + j]));
                for axis in 0..3 {
                    assert!(bounds[axis] <= bounds[axis + 3]);
                    if let Some(parent) = parent {
                        assert!(bounds[axis] >= parent[axis]);
                        assert!(bounds[axis + 3] <= parent[axis + 3]);
                    }
                }
                let child = words[at + 3] as i32;
                if child >= 0 {
                    stack.push((node + 2, Some(bounds)));
                    stack.push((child as usize, Some(bounds)));
                } else {
                    for i in 0..child.unsigned_abs() as usize {
                        let record = at + 8 + i * 4;
                        let id = words[record] as usize / if is_tlas { 1 } else { 3 };
                        assert!(!seen[id], "duplicate primitive {id}");
                        seen[id] = true;
                        for corner in 0..3 {
                            assert_eq!(
                                words[record + corner] as usize,
                                if is_tlas { id } else { id * 3 + corner }
                            );
                        }
                        for axis in 0..3 {
                            assert!(bounds[axis] <= boxes[id * 6 + axis]);
                            assert!(bounds[axis + 3] >= boxes[id * 6 + axis + 3]);
                        }
                    }
                }
            }
            assert!(seen.iter().all(|v| *v));
        }
    }
    #[test]
    fn batch_rejects_invalid_spans_and_counts() {
        // One empty TLAS record is valid; malformed framing must never reach C++.
        let mut packet = vec![0u8; 48];
        let put = |p: &mut [u8], at: usize, value: u32| {
            p[at * 4..at * 4 + 4].copy_from_slice(&value.to_le_bytes())
        };
        put(&mut packet, 0, 1);
        put(&mut packet, 1, 1);
        put(&mut packet, 11, 48);
        let output = jobs(&packet, true).unwrap();
        assert_eq!(output, packet);
        for (at, value) in [
            (0, 2),
            (1, u32::MAX),
            (4, 1),
            (5, 1),
            (6, 4),
            (11, 0),
            (11, 49),
            (11, u32::MAX),
        ] {
            let mut bad = packet.clone();
            put(&mut bad, at, value);
            assert!(jobs(&bad, true).is_err(), "field {at} value {value}");
        }
        assert!(jobs(&packet, false).is_err());
        for length in 0..48 {
            assert!(jobs(&packet[..length], true).is_err());
        }
    }
}
