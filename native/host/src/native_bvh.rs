//! Compose the original AOT SAH/layout module with native geometry input and
//! the existing BVH2 GPU byte contract. TLAS and scene metadata stay captured.
use serde::{Deserialize, Serialize};
use std::{fs, path::Path};
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

unsafe extern "C" {
    fn mt_core_bvh(input: *const u8, length: usize, output: *mut *const u8, size: *mut usize);
    fn mt_core_reset();
}
#[derive(Clone, Deserialize)]
pub struct Capture {
    pub buffer: usize,
    size: usize,
    prefix: String,
    geometries: Vec<Geometry>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Geometry {
    positions: String,
    indices: String,
    stride: usize,
    offset: usize,
    size: usize,
    max_depth: u32,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    geometries: usize,
    triangles: usize,
    bytes: usize,
    source: &'static str,
}
fn read_words(path: &Path) -> Result<Vec<u32>> {
    let bytes = fs::read(path)?;
    if bytes.len() % 4 != 0 {
        return Err("Unaligned geometry input".into());
    }
    Ok(bytes
        .chunks_exact(4)
        .map(|v| u32::from_le_bytes(v.try_into().unwrap()))
        .collect())
}
pub fn rebuild(directory: &Path, capture: &Capture) -> Result<(Vec<u8>, Stats)> {
    let scene_dir = directory.to_owned();
    let capture = capture.clone();
    super::runtime::call(move || rebuild_inner(&scene_dir, &capture))
}
fn rebuild_inner(directory: &Path, capture: &Capture) -> Result<(Vec<u8>, Stats)> {
    let prefix = fs::read(directory.join(&capture.prefix))?;
    if prefix.len() > capture.size {
        return Err("Invalid BVH prefix size".into());
    }
    let mut output = vec![0u8; capture.size];
    output[..prefix.len()].copy_from_slice(&prefix);
    let mut total = 0;
    let mut end = prefix.len();
    for geometry in &capture.geometries {
        let positions = read_words(&directory.join(&geometry.positions))?;
        let indices = read_words(&directory.join(&geometry.indices))?;
        if geometry.stride < 3 || positions.len() % geometry.stride != 0 || indices.len() % 3 != 0 {
            return Err("Invalid native geometry shape".into());
        }
        let count = indices.len() / 3;
        if count == 0 || count > 10_000_000 {
            return Err("Unsupported native triangle count".into());
        }
        let mut boxes = Vec::with_capacity(count * 24);
        for triangle in indices.chunks_exact(3) {
            let mut bounds = [f32::INFINITY; 6];
            bounds[3..].fill(f32::NEG_INFINITY);
            for vertex in triangle {
                let start = *vertex as usize * geometry.stride;
                if start + 3 > positions.len() {
                    return Err("Native geometry index out of bounds".into());
                }
                for axis in 0..3 {
                    let value = f32::from_bits(positions[start + axis]);
                    if !value.is_finite() {
                        return Err("Native BVH requires finite positions".into());
                    }
                    bounds[axis] = bounds[axis].min(value);
                    bounds[axis + 3] = bounds[axis + 3].max(value);
                }
            }
            for value in bounds {
                boxes.extend_from_slice(&value.to_le_bytes());
            }
        }
        let mut pointer = std::ptr::null();
        let mut length = 0;
        unsafe {
            mt_core_bvh(boxes.as_ptr(), boxes.len(), &mut pointer, &mut length);
        }
        if pointer.is_null() || length < 32 || length % 4 != 0 || length > (8 + count * 21) * 4 {
            return Err("Invalid AOT BVH output length".into());
        }
        // Copy before arena reset or another call into the composed core.
        let bytes = unsafe { std::slice::from_raw_parts(pointer, length) }.to_vec();
        unsafe {
            mt_core_reset();
        }
        let words: Vec<u32> = bytes
            .chunks_exact(4)
            .map(|v| u32::from_le_bytes(v.try_into().unwrap()))
            .collect();
        let nodes = words[1] as usize;
        if words[0] != 1
            || words[2] as usize != count
            || words[4] != geometry.max_depth
            || length != (8 + nodes * 10 + count) * 4
            || words[3] as usize * 16 != geometry.size
            || geometry.offset != end
            || geometry.size > output.len().saturating_sub(end)
        {
            return Err("AOT BVH layout differs from captured shader/instance contract".into());
        }
        let bounds = 8;
        let left = bounds + nodes * 6;
        let prim_count = left + nodes;
        let primitives = prim_count + nodes;
        let order = primitives + count;
        let offsets = order + nodes;
        let target = &mut output[end..end + geometry.size];
        let write = |target: &mut [u8], word: usize, value: u32| {
            target[word * 4..word * 4 + 4].copy_from_slice(&value.to_le_bytes());
        };
        for &node in &words[order..order + nodes] {
            let node = node as usize;
            let o = words[offsets + node] as usize * 4;
            for axis in 0..3 {
                write(target, o + axis, words[bounds + node * 6 + axis]);
                write(target, o + 4 + axis, words[bounds + node * 6 + 3 + axis]);
            }
            let prims = words[prim_count + node] as usize;
            let first = words[left + node] as usize;
            write(
                target,
                o + 3,
                if prims == 0 {
                    words[offsets + first + 1]
                } else {
                    (-(prims as i32)) as u32
                },
            );
            for i in 0..prims {
                let triangle = words[primitives + first + i] as usize;
                for corner in 0..3 {
                    write(
                        target,
                        o + 8 + i * 4 + corner,
                        indices[triangle * 3 + corner],
                    );
                }
            }
        }
        end += geometry.size;
        total += count;
    }
    if end != output.len() {
        return Err("Native BVH capture has unused trailing storage".into());
    }
    let stats = Stats {
        geometries: capture.geometries.len(),
        triangles: total,
        bytes: output.len(),
        source: "raw indexed geometry + native bounds + original TypeScript SAH/layout AOT; captured TLAS",
    };
    Ok((output, stats))
}
