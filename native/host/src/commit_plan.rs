//! Maps a descriptor sync to the retained incremental update paths. Anything a
//! path cannot express exactly falls back to full preparation (`None`).
use crate::layout::{
    batch as b, camera as cam, geometry as g, header as h, light as l, material as mat, mesh as m,
    texture as t,
};
use crate::scene::SceneSync;

#[derive(Debug, PartialEq)]
pub(crate) enum Step {
    Geometry(Vec<u8>),
    Transform(Vec<u8>),
    Material(Vec<u8>),
    Light(Vec<u8>),
    Environment(Vec<u8>),
    Camera(Vec<u8>),
}

struct Words<'a>(&'a [u8]);
impl Words<'_> {
    fn len(&self) -> usize {
        self.0.len() / 4
    }
    fn u(&self, i: usize) -> usize {
        u32::from_le_bytes(self.0[i * 4..i * 4 + 4].try_into().unwrap()) as usize
    }
    fn span(&self, offset: usize, count: usize) -> Option<&[u8]> {
        self.0.get(offset * 4..(offset + count) * 4)
    }
}
fn record(words: &[u32]) -> Vec<u8> {
    words.iter().flat_map(|w| w.to_le_bytes()).collect()
}
/// Same referenced content (offsets may differ); both absent counts as equal.
fn same_span(a: &Words, ao: usize, b: &Words, bo: usize, count: usize) -> Option<bool> {
    if (ao == 0) != (bo == 0) {
        return Some(false);
    }
    if ao == 0 {
        return Some(true);
    }
    Some(a.span(ao, count)? == b.span(bo, count)?)
}

/// Texture records and pixels must be unchanged: atlas updates need a full commit.
fn textures_unchanged(a: &Words, b: &Words) -> Option<bool> {
    if a.u(h::TEXTURE_COUNT) != b.u(h::TEXTURE_COUNT) {
        return Some(false);
    }
    for i in 0..b.u(h::TEXTURE_COUNT) {
        let (ao, bo) = (
            a.u(h::TEXTURE_OFFSET) + i * t::WORDS,
            b.u(h::TEXTURE_OFFSET) + i * t::WORDS,
        );
        for k in 0..t::WORDS {
            if k != t::PIXELS && a.u(ao + k) != b.u(bo + k) {
                return Some(false);
            }
        }
        let texels = b.u(bo + t::WIDTH)
            * b.u(bo + t::HEIGHT)
            * if b.u(bo + t::STORAGE) == 0 { 1 } else { 4 };
        if !same_span(a, a.u(ao + t::PIXELS), b, b.u(bo + t::PIXELS), texels)? {
            return Some(false);
        }
    }
    Some(true)
}

fn geometry_step(a: &Words, b: &Words, index: usize) -> Option<Step> {
    let (ao, bo) = (
        a.u(h::GEOMETRY_OFFSET) + index * g::WORDS,
        b.u(h::GEOMETRY_OFFSET) + index * g::WORDS,
    );
    let vertices = b.u(bo + g::VERTEX_COUNT);
    if a.u(ao + g::VERTEX_COUNT) != vertices || a.u(ao + g::INDEX_COUNT) != b.u(bo + g::INDEX_COUNT)
    {
        return None;
    }
    // The retained path replaces positions, normals and authored tangents only.
    for (field, count) in [
        (g::INDICES, b.u(bo + g::INDEX_COUNT)),
        (g::UV, vertices * 2),
        (g::UV1, vertices * 2),
        (g::COLOR, vertices * 3),
        (g::MATERIAL_INDEX, vertices),
    ] {
        if !same_span(a, a.u(ao + field), b, b.u(bo + field), count)? {
            return None;
        }
    }
    if (a.u(ao + g::NORMAL) == 0) != (b.u(bo + g::NORMAL) == 0)
        || (a.u(ao + g::TANGENT) == 0) != (b.u(bo + g::TANGENT) == 0)
    {
        return None;
    }
    let normals = b.u(bo + g::NORMAL) != 0;
    let tangents = b.u(bo + g::TANGENT) != 0;
    let mut bytes = record(&[
        1,
        index as u32,
        vertices as u32,
        u32::from(normals) | u32::from(tangents) << 1,
    ]);
    bytes.extend_from_slice(b.span(b.u(bo + g::POSITION), vertices * 3)?);
    if normals {
        bytes.extend_from_slice(b.span(b.u(bo + g::NORMAL), vertices * 3)?);
    }
    if tangents {
        bytes.extend_from_slice(b.span(b.u(bo + g::TANGENT), vertices * 4)?);
    }
    Some(Step::Geometry(bytes))
}

fn transform_step(b: &Words, index: usize) -> Option<Step> {
    // Instance matrices need the range paths of a later phase.
    if b.u(h::BATCH_OFFSET) != 0
        && b.u(b.u(h::BATCH_OFFSET) + index * b::WORDS + b::COUNT) != u32::MAX as usize
    {
        return None;
    }
    let mo = b.u(h::MESH_OFFSET) + index * m::WORDS;
    let mut bytes = record(&[1, index as u32, 0, 0]);
    bytes.extend_from_slice(b.span(mo + m::TRANSFORM, 16)?);
    Some(Step::Transform(bytes))
}

fn material_step(a: &Words, b: &Words, index: usize) -> Option<Step> {
    let (ao, bo) = (
        a.u(h::MATERIAL_OFFSET) + index * mat::WORDS,
        b.u(h::MATERIAL_OFFSET) + index * mat::WORDS,
    );
    // The retained path patches base color, roughness, metalness, transmission and IOR.
    for k in mat::EMISSION_COLOR..mat::WORDS {
        if k != mat::EXTENSION_OFFSET && a.u(ao + k) != b.u(bo + k) {
            return None;
        }
    }
    let extensions = b.u(bo + mat::EXTENSION_COUNT) * crate::layout::extension::WORDS;
    if !same_span(
        a,
        a.u(ao + mat::EXTENSION_OFFSET),
        b,
        b.u(bo + mat::EXTENSION_OFFSET),
        extensions,
    )? {
        return None;
    }
    let mut bytes = record(&[1, index as u32, 0, 0]);
    bytes.extend_from_slice(b.span(bo + mat::BASE_COLOR, 7)?);
    bytes.extend_from_slice(&0u32.to_le_bytes());
    Some(Step::Material(bytes))
}

fn light_steps(a: &Words, b: &Words, steps: &mut Vec<Step>) -> Option<()> {
    if a.u(h::LIGHT_COUNT) != b.u(h::LIGHT_COUNT)
        || a.u(h::ENVIRONMENT_TEXTURE) != b.u(h::ENVIRONMENT_TEXTURE)
    {
        return None;
    }
    for i in 0..b.u(h::LIGHT_COUNT) {
        let (ao, bo) = (
            a.u(h::LIGHT_OFFSET) + i * l::WORDS,
            b.u(h::LIGHT_OFFSET) + i * l::WORDS,
        );
        let ies = b.u(bo + l::IES_BYTES).div_ceil(4);
        let same = (0..l::WORDS).all(|k| k == l::IES_OFFSET || a.u(ao + k) == b.u(bo + k))
            && same_span(a, a.u(ao + l::IES_OFFSET), b, b.u(bo + l::IES_OFFSET), ies)?;
        if same {
            continue;
        }
        // Attachments are preserved by the retained path, so they must not change.
        if a.u(ao + l::TEXTURE) != b.u(bo + l::TEXTURE)
            || a.u(ao + l::IES_BYTES) != b.u(bo + l::IES_BYTES)
            || !same_span(a, a.u(ao + l::IES_OFFSET), b, b.u(bo + l::IES_OFFSET), ies)?
        {
            return None;
        }
        let mut words: Vec<u8> = b.span(bo, l::WORDS)?.to_vec();
        words[l::TEXTURE * 4..(l::RESERVED + 1) * 4].fill(0);
        let mut bytes = record(&[1, i as u32, 0, 0]);
        bytes.extend_from_slice(&words);
        steps.push(Step::Light(bytes));
    }
    Some(())
}

fn environment_step(a: &Words, b: &Words) -> Option<Step> {
    if a.u(h::ENVIRONMENT_TEXTURE) != b.u(h::ENVIRONMENT_TEXTURE)
        || a.u(h::BACKGROUND_TEXTURE) != b.u(h::BACKGROUND_TEXTURE)
        || (a.u(h::QUALITY_FLAGS) ^ b.u(h::QUALITY_FLAGS)) & 4 != 0
    {
        return None;
    }
    let map = |reference: usize| -> Option<(u32, u32, &[u8])> {
        if reference == 0 {
            return Some((0, 0, &[]));
        }
        let to = b.u(h::TEXTURE_OFFSET) + (reference - 1) * t::WORDS;
        if b.u(to + t::STORAGE) != 1 {
            return None;
        }
        let (w, hgt) = (b.u(to + t::WIDTH), b.u(to + t::HEIGHT));
        Some((
            w as u32,
            hgt as u32,
            b.span(b.u(to + t::PIXELS), w * hgt * 4)?,
        ))
    };
    let (ew, eh, environment) = map(b.u(h::ENVIRONMENT_TEXTURE))?;
    let (bw, bh, background) = map(b.u(h::BACKGROUND_TEXTURE))?;
    let mut bytes = record(&[1, ew, eh, u32::from(b.u(h::QUALITY_FLAGS) & 4 != 0)]);
    bytes.extend_from_slice(b.span(h::BACKGROUND_COLOR, 4)?);
    bytes.extend_from_slice(&record(&[bw, bh, 0, 0]));
    bytes.extend_from_slice(environment);
    bytes.extend_from_slice(background);
    Some(Step::Environment(bytes))
}

/// Ordered retained updates equivalent to committing `next` over `previous`,
/// or `None` when only full preparation reproduces it.
pub(crate) fn plan(previous: &[u8], next: &[u8], sync: &SceneSync) -> Option<Vec<Step>> {
    let (a, b) = (Words(previous), Words(next));
    if a.len() < h::WORDS
        || b.len() < h::WORDS
        || sync.resolution
        || sync.quality
        || sync.meshes == 2
        || !sync.colors.is_empty()
        || !textures_unchanged(&a, &b)?
    {
        return None;
    }
    let mut steps = Vec::new();
    for &index in &sync.geometries {
        steps.push(geometry_step(&a, &b, index)?);
    }
    for &index in &sync.transforms {
        steps.push(transform_step(&b, index)?);
    }
    for &index in &sync.materials {
        steps.push(material_step(&a, &b, index)?);
    }
    if sync.lights {
        light_steps(&a, &b, &mut steps)?;
    }
    // Environment pixel edits change textures and were excluded above.
    if sync.background {
        steps.push(environment_step(&a, &b)?);
    }
    if sync.camera {
        steps.push(Step::Camera(
            b.span(b.u(h::CAMERA_OFFSET), cam::WORDS)?.to_vec(),
        ));
    }
    Some(steps)
}
