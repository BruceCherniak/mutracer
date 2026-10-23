//! glTF-to-descriptor adapter; all renderer preparation stays in the AOT library.
use anyhow::{Context, Result, bail, ensure};
use glam::{Mat4, Vec3};
use mutracer_native_probe::layout::light as light_wire;
#[cfg(test)]
use mutracer_native_probe::layout::{header as h, texture as tex};
use std::{collections::HashMap, path::Path, sync::Arc};

pub use mutracer_native_probe::scene_api::Descriptor;
#[cfg(test)]
pub use mutracer_native_probe::scene_api::encoder::material_values;
pub use mutracer_native_probe::scene_api::encoder::{
    Geometry, Material, MaterialLayers, Mesh, Texture,
};
#[derive(Clone)]
pub struct Model {
    pub name: String,
    pub materials: Vec<Material>,
    pub textures: Arc<Vec<Texture>>,
    pub geometries: Arc<Vec<Geometry>>,
    pub picking: Arc<Vec<Arc<mutracer_native_probe::picking::PickBvh>>>,
    pub animation: Option<crate::animation::Animation>,
    pub meshes: Vec<Mesh>,
    pub center: Vec3,
    pub radius: f32,
    pub ground_y: f32,
    pub warnings: Vec<String>,
}
impl Model {
    pub fn load(path: &Path) -> Result<Self> {
        ensure!(
            path.metadata()?.len() <= 128 * 1024 * 1024,
            "Model file exceeds 128 MiB"
        );
        let (document, buffers, images) =
            crate::import::load(path).context("Loading GLTF/GLB and its buffers/images")?;
        ensure!(
            buffers.iter().map(|b| b.len()).sum::<usize>() <= 512 * 1024 * 1024,
            "Model buffers exceed 512 MiB"
        );
        let known = [
            "KHR_materials_ior",
            "KHR_materials_transmission",
            "KHR_materials_emissive_strength",
            "KHR_materials_unlit",
            "KHR_texture_transform",
            "EXT_meshopt_compression",
            "KHR_mesh_quantization",
            "EXT_texture_webp",
            "EXT_mesh_gpu_instancing",
        ];
        for extension in document.extensions_required() {
            ensure!(
                known.contains(&extension),
                "Required glTF extension is unsupported: {extension}"
            );
        }
        let mut model = Self {
            name: path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into(),
            materials: vec![],
            textures: Arc::new(vec![]),
            geometries: Arc::new(vec![]),
            picking: Arc::new(vec![]),
            animation: crate::animation::Animation::load(&document, &buffers)?,
            meshes: vec![],
            center: Vec3::ZERO,
            radius: 1.,
            ground_y: 0.,
            warnings: vec![],
        };
        for extension in document.extensions_used().filter(|e| !known.contains(e)) {
            model.warnings.push(format!(
                "Unsupported optional extension is ignored: {extension}"
            ));
        }
        let rgba: Vec<Vec<u8>> = images.iter().map(image_rgba).collect::<Result<_>>()?;
        for material in document.materials() {
            let pbr = material.pbr_metallic_roughness();
            let base = pbr.base_color_factor();
            let mut maps = [u32::MAX; 9];
            if let Some(info) = pbr.base_color_texture() {
                maps[0] = model.add_map(
                    info.texture(),
                    info.tex_coord(),
                    info.texture_transform()
                        .map(|t| (t.offset(), t.scale(), t.rotation(), t.tex_coord())),
                    &images,
                    &rgba,
                )?;
            }
            if let Some(info) = material.normal_texture() {
                maps[1] = model.add_map(info.texture(), info.tex_coord(), None, &images, &rgba)?;
            }
            if let Some(info) = pbr.metallic_roughness_texture() {
                maps[2] = model.add_map(
                    info.texture(),
                    info.tex_coord(),
                    info.texture_transform()
                        .map(|t| (t.offset(), t.scale(), t.rotation(), t.tex_coord())),
                    &images,
                    &rgba,
                )?;
            }
            if let Some(info) = material.emissive_texture() {
                maps[3] = model.add_map(
                    info.texture(),
                    info.tex_coord(),
                    info.texture_transform()
                        .map(|t| (t.offset(), t.scale(), t.rotation(), t.tex_coord())),
                    &images,
                    &rgba,
                )?;
            }
            if material.occlusion_texture().is_some() {
                model
                    .warnings
                    .push("Occlusion textures are ignored by this path-traced example.".into());
            }
            if material
                .transmission()
                .and_then(|t| t.transmission_texture())
                .is_some()
            {
                model
                    .warnings
                    .push("Transmission textures are ignored; using the scalar factor.".into());
            }
            model.materials.push(Material {
                name: material.name().map(str::to_owned).unwrap_or_else(|| {
                    format!(
                        "Material {}",
                        material
                            .index()
                            .map(|i| i.to_string())
                            .unwrap_or("default".into())
                    )
                }),
                color: [base[0], base[1], base[2]],
                opacity: if material.alpha_mode() == gltf::material::AlphaMode::Opaque {
                    1.
                } else {
                    base[3]
                },
                roughness: pbr.roughness_factor(),
                metalness: pbr.metallic_factor(),
                transmission: material
                    .transmission()
                    .map(|t| t.transmission_factor())
                    .unwrap_or(0.),
                ior: material.ior().unwrap_or(1.5),
                emission: material.emissive_factor(),
                emission_strength: material.emissive_strength().unwrap_or(1.),
                maps,
                alpha_mode: match material.alpha_mode() {
                    gltf::material::AlphaMode::Opaque => 1,
                    gltf::material::AlphaMode::Mask => 2,
                    gltf::material::AlphaMode::Blend => 3,
                },
                alpha_cutoff: material.alpha_cutoff().unwrap_or(0.5),
                double_sided: material.double_sided(),
                normal_scale: material.normal_texture().map(|t| t.scale()).unwrap_or(1.),
                unlit: material.unlit(),
                layers: MaterialLayers::default(),
            });
        }
        model.materials.push(Material {
            name: "Default".into(),
            color: [1.; 3],
            roughness: 1.,
            metalness: 1.,
            opacity: 1.,
            transmission: 0.,
            ior: 1.5,
            emission: [0.; 3],
            emission_strength: 1.,
            maps: [u32::MAX; 9],
            alpha_mode: 1,
            alpha_cutoff: 0.5,
            double_sided: false,
            normal_scale: 1.,
            unlit: false,
            layers: MaterialLayers::default(),
        });
        let scene = document
            .default_scene()
            .or_else(|| document.scenes().next())
            .context("glTF has no scene")?;
        let mut worlds = vec![Mat4::IDENTITY; document.nodes().len()];
        fn world(
            node: gltf::Node<'_>,
            parent: Mat4,
            worlds: &mut [Mat4],
            depth: usize,
        ) -> Result<()> {
            ensure!(
                depth < 512,
                "Node hierarchy exceeds 512 levels or contains a cycle"
            );
            let matrix = parent * Mat4::from_cols_array_2d(&node.transform().matrix());
            worlds[node.index()] = matrix;
            for child in node.children() {
                world(child, matrix, worlds, depth + 1)?;
            }
            Ok(())
        }
        let children: std::collections::HashSet<_> = document
            .nodes()
            .flat_map(|n| n.children().map(|c| c.index()))
            .collect();
        for node in document.nodes().filter(|n| !children.contains(&n.index())) {
            world(node, Mat4::IDENTITY, &mut worlds, 0)?;
        }
        let mut cache = HashMap::new();
        for node in scene.nodes() {
            model.visit(
                node,
                Mat4::IDENTITY,
                &buffers,
                &mut cache,
                &document,
                &worlds,
                0,
            )?;
        }
        ensure!(
            !model.meshes.is_empty(),
            "The selected scene has no triangle meshes"
        );
        let mut min = Vec3::splat(f32::INFINITY);
        let mut max = Vec3::splat(f32::NEG_INFINITY);
        for mesh in &model.meshes {
            for p in model.geometries[mesh.geometry].positions.chunks_exact(3) {
                let p = mesh.transform.transform_point3(Vec3::from_slice(p));
                min = min.min(p);
                max = max.max(p);
            }
        }
        model.center = (min + max) * 0.5;
        model.radius = (max - min).length() * 0.5;
        model.ground_y = min.y;
        ensure!(
            model.center.is_finite() && model.radius.is_finite() && model.radius > 1e-8,
            "Invalid or degenerate model bounds"
        );
        for mesh in &model.meshes {
            for id in model.materials[mesh.material].maps {
                if id != u32::MAX {
                    ensure!(
                        !model.geometries[mesh.geometry].uv
                            [model.textures[id as usize].uv as usize]
                            .is_empty(),
                        "Material references a missing texture coordinate set"
                    );
                }
            }
        }
        model.warnings.sort();
        model.warnings.dedup();
        model.rebuild_picking()?;
        if model.apply_animation()? {
            model.refresh_bounds();
        }
        Ok(model)
    }
    /// Replaces slots atomically. Existing slots provide UV sampling, then base color.
    pub fn replace_textures(
        &mut self,
        material: usize,
        images: Vec<(usize, Option<image::RgbaImage>)>,
    ) -> Result<()> {
        ensure!(material < self.materials.len(), "Unknown material");
        ensure!(
            images.iter().all(|(slot, _)| *slot < 9),
            "Unknown texture slot"
        );
        let mut candidate = self.clone();
        let references: Vec<_> = images
            .iter()
            .map(|(slot, _)| {
                let maps = self.materials[material].maps;
                let id = if maps[*slot] != u32::MAX {
                    maps[*slot]
                } else {
                    maps[0]
                };
                self.textures.get(id as usize).cloned()
            })
            .collect();
        for (slot, _) in &images {
            candidate.materials[material].maps[*slot] = u32::MAX;
        }
        candidate.compact_textures();
        let used: u64 = candidate
            .textures
            .iter()
            .map(|t| t.width as u64 * t.height as u64)
            .sum();
        let count = images.iter().filter(|(_, image)| image.is_some()).count();
        // Reserve the maximum supported environment image (4M pixels).
        let available = 12_582_912u64.saturating_sub(used);
        ensure!(
            count == 0 || available >= count as u64,
            "Material texture budget is full"
        );
        let per_image = if count == 0 {
            available
        } else {
            available / count as u64
        };
        let edge = if count == 0 {
            4096
        } else {
            ((available / count as u64) as f64)
                .sqrt()
                .floor()
                .min(4096.) as u32
        };
        for ((slot, image), reference) in images.into_iter().zip(references) {
            let Some(mut image) = image else { continue };
            ensure!(image.width() > 0 && image.height() > 0, "Empty texture");
            if slot == 8 {
                let size = image
                    .width()
                    .max(image.height())
                    .min(edge)
                    .next_power_of_two();
                let size = if size > edge { size / 2 } else { size };
                image = image::imageops::resize(
                    &image,
                    size,
                    size,
                    image::imageops::FilterType::Triangle,
                );
            } else if image.width().max(image.height()) > 4096
                || image.width() as u64 * image.height() as u64 > per_image
            {
                let factor = (4096. / image.width().max(image.height()) as f64).min(
                    (per_image as f64 / (image.width() as f64 * image.height() as f64)).sqrt(),
                );
                image = image::imageops::resize(
                    &image,
                    (image.width() as f64 * factor).floor().max(1.) as u32,
                    (image.height() as f64 * factor).floor().max(1.) as u32,
                    image::imageops::FilterType::Triangle,
                );
            }
            ensure!(candidate.textures.len() < 255, "Texture limit reached");
            let uv = reference.as_ref().map_or(0, |t| t.uv);
            let uv = if candidate
                .meshes
                .iter()
                .filter(|m| m.material == material)
                .any(|m| candidate.geometries[m.geometry].uv[uv as usize].is_empty())
            {
                0
            } else {
                uv
            };
            let id = candidate.textures.len() as u32;
            Arc::make_mut(&mut candidate.textures).push(Texture {
                float_pixels: None,
                storage: 0,
                flip_y: false,
                source: usize::MAX,
                width: image.width(),
                height: image.height(),
                pixels: image.into_raw().into(),
                uv,
                scale: reference.as_ref().map_or([1.; 2], |t| t.scale),
                offset: reference.as_ref().map_or([0.; 2], |t| t.offset),
                wrap: reference.as_ref().map_or([0; 2], |t| t.wrap),
            });
            candidate.materials[material].maps[slot] = id;
            if slot == 8
                && candidate.materials[material].layers.displacement_projection == 0
                && candidate
                    .meshes
                    .iter()
                    .filter(|m| m.material == material)
                    .any(|m| candidate.geometries[m.geometry].uv[0].is_empty())
            {
                candidate.materials[material].layers.displacement_projection = 1;
            }
        }
        self.materials = candidate.materials;
        self.textures = candidate.textures;
        Ok(())
    }
    fn compact_textures(&mut self) {
        let mut ids = vec![u32::MAX; self.textures.len()];
        let mut textures = Vec::new();
        for material in &mut self.materials {
            for id in &mut material.maps {
                if *id == u32::MAX {
                    continue;
                }
                let old = *id as usize;
                if ids[old] == u32::MAX {
                    ids[old] = textures.len() as u32;
                    textures.push(self.textures[old].clone());
                }
                *id = ids[old];
            }
        }
        self.textures = Arc::new(textures);
    }
    pub fn set_texture_sampling(
        &mut self,
        material: usize,
        slot: usize,
        wrap: [u32; 2],
        scale: [f32; 2],
    ) -> Result<bool> {
        ensure!(
            wrap.iter().all(|v| *v <= 2) && scale.iter().all(|v| v.is_finite()),
            "Invalid texture sampling"
        );
        ensure!(
            material < self.materials.len() && slot < 9,
            "Unknown material texture slot"
        );
        let id = self.materials[material].maps[slot];
        ensure!(id != u32::MAX, "Texture slot is empty");
        let texture = &self.textures[id as usize];
        if texture.wrap == wrap && texture.scale == scale {
            return Ok(false);
        }
        let shared = self
            .materials
            .iter()
            .flat_map(|m| m.maps)
            .filter(|map| *map == id)
            .count()
            > 1;
        let target = if shared {
            // Sampling belongs to this material slot; share immutable pixels with the new record.
            ensure!(
                self.textures.len() < 255,
                "Texture limit reached; cannot separate this shared map"
            );
            let texture = texture.clone();
            let target = self.textures.len();
            Arc::make_mut(&mut self.textures).push(texture);
            self.materials[material].maps[slot] = target as u32;
            target
        } else {
            id as usize
        };
        let texture = &mut Arc::make_mut(&mut self.textures)[target];
        texture.wrap = wrap;
        texture.scale = scale;
        Ok(true)
    }
    fn add_map(
        &mut self,
        texture: gltf::Texture<'_>,
        uv: u32,
        transform: Option<([f32; 2], [f32; 2], f32, Option<u32>)>,
        images: &[gltf::image::Data],
        rgba: &[Vec<u8>],
    ) -> Result<u32> {
        let (offset, scale, rotation, override_uv) =
            transform.unwrap_or(([0.; 2], [1.; 2], 0., None));
        let uv = override_uv.unwrap_or(uv);
        ensure!(uv <= 1, "Only TEXCOORD_0/1 are supported");
        if rotation != 0. {
            self.warnings
                .push("Texture rotation is ignored; offset and scale are applied.".into());
        }
        let sampler = texture.sampler();
        let mode = |wrap| match wrap {
            gltf::texture::WrappingMode::Repeat => 0,
            gltf::texture::WrappingMode::ClampToEdge => 1,
            gltf::texture::WrappingMode::MirroredRepeat => 2,
        };
        let wrap = [mode(sampler.wrap_s()), mode(sampler.wrap_t())];
        let source = texture.source().index();
        let image = &images[source];
        ensure!(
            image.width as u64 * image.height as u64 <= 16_777_216,
            "Source material texture exceeds 16M pixels"
        );
        if let Some(id) = self.textures.iter().position(|t| {
            t.source == source
                && t.uv == uv
                && t.scale == scale
                && t.offset == offset
                && t.wrap == wrap
        }) {
            return Ok(id as u32);
        }
        let id = self.textures.len() as u32;
        let (width, height, pixels) = if image.width.max(image.height) > 512 {
            let factor = 512. / image.width.max(image.height) as f32;
            let width = (image.width as f32 * factor).round().max(1.) as u32;
            let height = (image.height as f32 * factor).round().max(1.) as u32;
            let input = image::RgbaImage::from_raw(image.width, image.height, rgba[source].clone())
                .context("Invalid decoded texture size")?;
            self.warnings
                .push("Material textures are limited to 512 pixels on the longest side.".into());
            (
                width,
                height,
                image::imageops::resize(
                    &input,
                    width,
                    height,
                    image::imageops::FilterType::Triangle,
                )
                .into_raw(),
            )
        } else {
            (image.width, image.height, rgba[source].clone())
        };
        Arc::make_mut(&mut self.textures).push(Texture {
            float_pixels: None,
            storage: 0,
            flip_y: false,
            source,
            width,
            height,
            pixels: pixels.into(),
            uv,
            scale,
            offset,
            wrap,
        });
        Ok(id)
    }
    fn visit(
        &mut self,
        node: gltf::Node<'_>,
        parent: Mat4,
        buffers: &[gltf::buffer::Data],
        cache: &mut HashMap<(usize, usize, usize), usize>,
        document: &gltf::Document,
        worlds: &[Mat4],
        depth: usize,
    ) -> Result<()> {
        ensure!(
            depth < 512,
            "Node hierarchy exceeds 512 levels or contains a cycle"
        );
        let transform = parent * Mat4::from_cols_array_2d(&node.transform().matrix());
        ensure!(
            transform.is_finite() && transform.determinant().abs() >= 1e-12,
            "Node transform must be finite and invertible"
        );
        if let Some(mesh) = node.mesh() {
            for primitive in mesh.primitives() {
                let unique = node.skin().is_some() || primitive.morph_targets().len() > 0;
                let key = (
                    mesh.index(),
                    primitive.index(),
                    if unique { node.index() } else { usize::MAX },
                );
                let index = if let Some(&index) = cache.get(&key) {
                    index
                } else {
                    let reader = primitive.reader(|b| Some(&buffers[b.index()]));
                    let positions: Vec<f32> = reader
                        .read_positions()
                        .context("Mesh is missing POSITION")?
                        .flatten()
                        .collect();
                    let input: Vec<u32> = reader
                        .read_indices()
                        .map(|i| i.into_u32().collect())
                        .unwrap_or_else(|| (0..positions.len() as u32 / 3).collect());
                    let mut indices = vec![];
                    match primitive.mode() {
                        gltf::mesh::Mode::Triangles => indices = input,
                        gltf::mesh::Mode::TriangleStrip => {
                            for i in 2..input.len() {
                                indices.extend(if i % 2 == 0 {
                                    [input[i - 2], input[i - 1], input[i]]
                                } else {
                                    [input[i - 1], input[i - 2], input[i]]
                                });
                            }
                        }
                        gltf::mesh::Mode::TriangleFan => {
                            for i in 2..input.len() {
                                indices.extend([input[0], input[i - 1], input[i]]);
                            }
                        }
                        _ => bail!(
                            "Only triangle, triangle-strip and triangle-fan primitives are supported"
                        ),
                    }
                    let colors: Vec<f32> = reader
                        .read_colors(0)
                        .map(|c| {
                            let rgba: Vec<_> = c.into_rgba_f32().collect();
                            if rgba.iter().any(|c| c[3] != 1.) {
                                self.warnings.push(
                                    "Vertex color alpha is ignored; RGB is preserved.".into(),
                                );
                            }
                            rgba.into_iter().flat_map(|c| [c[0], c[1], c[2]]).collect()
                        })
                        .unwrap_or_default();
                    let mut geometry = Geometry {
                        material_indices: Arc::from([]),
                        min: Vec3::ZERO,
                        max: Vec3::ZERO,
                        positions: positions.into(),
                        indices: indices.into(),
                        normals: reader
                            .read_normals()
                            .map(|v| v.flatten().collect::<Vec<_>>().into())
                            .unwrap_or_default(),
                        uv: [0, 1].map(|i| {
                            reader
                                .read_tex_coords(i)
                                .map(|v| v.into_f32().flatten().collect::<Vec<_>>().into())
                                .unwrap_or_default()
                        }),
                        colors: colors.into(),
                        tangents: reader
                            .read_tangents()
                            .map(|v| v.flatten().collect::<Vec<_>>().into())
                            .unwrap_or_default(),
                    };
                    ensure!(
                        geometry.indices.len() % 3 == 0
                            && geometry
                                .indices
                                .iter()
                                .all(|&i| (i as usize) < geometry.positions.len() / 3),
                        "Invalid triangle indices"
                    );
                    if let Some(animation) = &mut self.animation {
                        animation.bind_geometry(
                            &node,
                            &primitive,
                            buffers,
                            self.geometries.len(),
                            &geometry,
                        )?;
                    }
                    let weights = node.weights().or_else(|| mesh.weights()).unwrap_or(&[]);
                    for (i, (positions, normals, tangents)) in
                        reader.read_morph_targets().enumerate()
                    {
                        let weight = weights.get(i).copied().unwrap_or(0.);
                        for (target, delta, stride) in [
                            (&mut geometry.positions, positions, 3),
                            (&mut geometry.normals, normals, 3),
                            (&mut geometry.tangents, tangents, 4),
                        ] {
                            if let Some(delta) = delta {
                                for (vertex, d) in delta.enumerate() {
                                    for k in 0..3 {
                                        if let Some(v) =
                                            Arc::make_mut(target).get_mut(vertex * stride + k)
                                        {
                                            *v += weight * d[k];
                                        }
                                    }
                                }
                            }
                        }
                    }
                    if let Some(skin) = node.skin() {
                        let inverse: Vec<_> = skin
                            .reader(|b| Some(&buffers[b.index()]))
                            .read_inverse_bind_matrices()
                            .map(|v| v.map(|m| Mat4::from_cols_array_2d(&m)).collect())
                            .unwrap_or_else(|| vec![Mat4::IDENTITY; skin.joints().len()]);
                        ensure!(
                            inverse.len() == skin.joints().len(),
                            "Invalid inverse bind matrix count"
                        );
                        let joints: Vec<_> = skin
                            .joints()
                            .zip(inverse)
                            .map(|(n, bind)| transform.inverse() * worlds[n.index()] * bind)
                            .collect();
                        let ids: Vec<_> = reader
                            .read_joints(0)
                            .context("Skinned mesh has no JOINTS_0")?
                            .into_u16()
                            .collect();
                        let weights: Vec<_> = reader
                            .read_weights(0)
                            .context("Skinned mesh has no WEIGHTS_0")?
                            .into_f32()
                            .collect();
                        ensure!(
                            ids.len() == geometry.positions.len() / 3 && ids.len() == weights.len(),
                            "Invalid skin attribute count"
                        );
                        ensure!(
                            reader.read_joints(1).is_none(),
                            "More than four skin influences are unsupported"
                        );
                        for (vertex, (ids, weights)) in ids.iter().zip(&weights).enumerate() {
                            let sum: f32 = weights.iter().sum();
                            ensure!(sum.is_finite() && sum > 0., "Invalid skin weights");
                            let mut matrix = Mat4::ZERO;
                            for k in 0..4 {
                                matrix +=
                                    *joints.get(ids[k] as usize).context("Invalid skin joint")?
                                        * (weights[k] / sum);
                            }
                            let p = matrix.transform_point3(Vec3::from_slice(
                                &geometry.positions[vertex * 3..vertex * 3 + 3],
                            ));
                            Arc::make_mut(&mut geometry.positions)[vertex * 3..vertex * 3 + 3]
                                .copy_from_slice(&p.to_array());
                            for (data, stride) in
                                [(&mut geometry.normals, 3), (&mut geometry.tangents, 4)]
                            {
                                if !data.is_empty() {
                                    let n = matrix
                                        .transform_vector3(Vec3::from_slice(
                                            &data[vertex * stride..vertex * stride + 3],
                                        ))
                                        .normalize_or_zero();
                                    Arc::make_mut(data)[vertex * stride..vertex * stride + 3]
                                        .copy_from_slice(&n.to_array());
                                }
                            }
                        }
                    }
                    geometry.min = Vec3::splat(f32::INFINITY);
                    geometry.max = Vec3::splat(f32::NEG_INFINITY);
                    for p in geometry.positions.chunks_exact(3) {
                        let v = Vec3::from_slice(p);
                        geometry.min = geometry.min.min(v);
                        geometry.max = geometry.max.max(v);
                    }
                    let index = self.geometries.len();
                    Arc::make_mut(&mut self.geometries).push(geometry);
                    cache.insert(key, index);
                    index
                };
                let mut instances = vec![Mat4::IDENTITY];
                if let Some(ext) = node.extension_value("EXT_mesh_gpu_instancing") {
                    let attrs = &ext["attributes"];
                    let read3 = |name: &str| -> Result<Option<Vec<[f32; 3]>>> {
                        let Some(id) = attrs[name].as_u64() else {
                            return Ok(None);
                        };
                        let a = document
                            .accessors()
                            .nth(id as usize)
                            .context("Invalid instance accessor")?;
                        Ok(Some(
                            gltf::accessor::Iter::<[f32; 3]>::new(a, |b| Some(&buffers[b.index()]))
                                .context("Invalid instance attribute")?
                                .collect(),
                        ))
                    };
                    let translation = read3("TRANSLATION")?;
                    let scale = read3("SCALE")?;
                    let rotation = if let Some(id) = attrs["ROTATION"].as_u64() {
                        let a = document
                            .accessors()
                            .nth(id as usize)
                            .context("Invalid rotation accessor")?;
                        ensure!(
                            a.data_type() == gltf::accessor::DataType::F32,
                            "Quantized instance rotation is unsupported"
                        );
                        Some(
                            gltf::accessor::Iter::<[f32; 4]>::new(a, |b| Some(&buffers[b.index()]))
                                .context("Invalid instance rotation")?
                                .collect::<Vec<_>>(),
                        )
                    } else {
                        None
                    };
                    let count = translation
                        .as_ref()
                        .map(Vec::len)
                        .or_else(|| scale.as_ref().map(Vec::len))
                        .or_else(|| rotation.as_ref().map(Vec::len))
                        .context("Instance transforms missing")?;
                    ensure!(
                        count <= 65536
                            && translation.as_ref().is_none_or(|v| v.len() == count)
                            && scale.as_ref().is_none_or(|v| v.len() == count)
                            && rotation.as_ref().is_none_or(|v| v.len() == count),
                        "Invalid instance counts"
                    );
                    instances = (0..count)
                        .map(|i| {
                            Mat4::from_scale_rotation_translation(
                                scale
                                    .as_ref()
                                    .map(|v| Vec3::from(v[i]))
                                    .unwrap_or(Vec3::ONE),
                                rotation
                                    .as_ref()
                                    .map(|v| glam::Quat::from_array(v[i]).normalize())
                                    .unwrap_or(glam::Quat::IDENTITY),
                                translation
                                    .as_ref()
                                    .map(|v| Vec3::from(v[i]))
                                    .unwrap_or(Vec3::ZERO),
                            )
                        })
                        .collect();
                }
                for (instance, local) in instances.into_iter().enumerate() {
                    let matrix = transform * local;
                    ensure!(
                        matrix.is_finite() && matrix.determinant().abs() >= 1e-12,
                        "Invalid instance transform"
                    );
                    self.meshes.push(Mesh {
                        materials: vec![],
                        instances: None,
                        name: format!(
                            "{} / {}{}",
                            node.name()
                                .or_else(|| mesh.name())
                                .map(str::to_owned)
                                .unwrap_or_else(|| format!("Mesh {}", node.index() + 1)),
                            primitive.index() + 1,
                            if instance == 0 {
                                String::new()
                            } else {
                                format!(" · {}", instance + 1)
                            }
                        ),
                        geometry: index,
                        material: primitive
                            .material()
                            .index()
                            .unwrap_or(self.materials.len() - 1),
                        transform: matrix,
                    });
                    if let Some(animation) = &mut self.animation {
                        animation.bind_mesh(node.index(), local);
                    }
                }
            }
        }
        for child in node.children() {
            self.visit(
                child,
                transform,
                buffers,
                cache,
                document,
                worlds,
                depth + 1,
            )?;
        }
        Ok(())
    }
    fn scene_object(
        &self,
        environment: &Environment,
        light: &KeyLight,
    ) -> mutracer_native_probe::scene_api::Scene {
        use mutracer_native_probe::scene_api::{Scene, encoder};
        let mut lights = environment
            .studio
            .records(self.center, self.radius, self.ground_y);
        if light.enabled {
            lights.push(light.record());
        }
        let (width, height, pixels) = environment.pixels_shared();
        let env = encoder::Environment {
            enabled: true,
            width,
            height,
            pixels: pixels.into(),
            background: environment.background,
            background_color: if environment.background {
                [0.; 3]
            } else {
                environment.background_color
            },
            background_alpha: if environment.background {
                1.
            } else {
                environment.background_alpha
            },
        };
        Scene::from_indexed(
            &encoder::SceneData {
                properties: &[],
                geometries: &self.geometries,
                materials: &self.materials,
                textures: &self.textures,
                meshes: &self.meshes,
                lights,
                ies: vec![],
            },
            &env,
        )
        .expect("Validated imported scene")
    }
    pub fn descriptor(&self, camera: &[u8], size: [u32; 2], environment: &Environment) -> Vec<u8> {
        self.descriptor_with_light(camera, size, environment, &KeyLight::default())
    }
    pub fn descriptor_with_light(
        &self,
        camera: &[u8],
        size: [u32; 2],
        environment: &Environment,
        light: &KeyLight,
    ) -> Vec<u8> {
        self.update_descriptor(&mut None, camera, size, environment, light)
            .to_vec()
    }
    pub fn update_descriptor<'a>(
        &self,
        cached: &'a mut Option<Descriptor>,
        camera: &[u8],
        size: [u32; 2],
        environment: &Environment,
        light: &KeyLight,
    ) -> &'a [u8] {
        self.scene_object(environment, light)
            .update_descriptor(cached, camera, size)
            .expect("Encoding imported scene")
    }
}

fn image_rgba(image: &gltf::image::Data) -> Result<Vec<u8>> {
    use gltf::image::Format::*;
    let (channels, bytes) = match image.format {
        R8 => (1, 1),
        R8G8 => (2, 1),
        R8G8B8 => (3, 1),
        R8G8B8A8 => (4, 1),
        R16 => (1, 2),
        R16G16 => (2, 2),
        R16G16B16 => (3, 2),
        R16G16B16A16 => (4, 2),
        _ => bail!("Floating-point glTF material images are unsupported"),
    };
    let mut result = Vec::with_capacity(image.width as usize * image.height as usize * 4);
    for pixel in image.pixels.chunks_exact(channels * bytes) {
        let get = |i: usize| {
            if bytes == 1 {
                pixel[i]
            } else {
                (u16::from_ne_bytes([pixel[i * 2], pixel[i * 2 + 1]]) / 257) as u8
            }
        };
        let rgb = if channels < 3 {
            [get(0); 3]
        } else {
            [get(0), get(1), get(2)]
        };
        result.extend(rgb);
        result.push(if channels == 2 {
            get(1)
        } else if channels == 4 {
            get(3)
        } else {
            255
        });
    }
    Ok(result)
}
#[derive(Clone)]
pub struct KeyLight {
    pub enabled: bool,
    pub color: [f32; 3],
    pub intensity: f32,
    pub azimuth: f32,
    pub elevation: f32,
}
impl Default for KeyLight {
    fn default() -> Self {
        Self {
            enabled: false,
            color: [1., 0.95, 0.85],
            intensity: 2.,
            azimuth: 45.,
            elevation: 60.,
        }
    }
}
impl KeyLight {
    fn record(&self) -> [u32; light_wire::WORDS] {
        let mut words = [0; light_wire::WORDS];
        words[light_wire::TYPE] = 2;
        for (k, value) in self.color.iter().enumerate() {
            words[light_wire::COLOR + k] = value.to_bits();
        }
        words[light_wire::INTENSITY] = self.intensity.to_bits();
        let transform = Mat4::from_rotation_y(self.azimuth.to_radians())
            * Mat4::from_rotation_x(-self.elevation.to_radians());
        for (k, value) in transform.to_cols_array().iter().enumerate() {
            words[light_wire::TRANSFORM + k] = value.to_bits();
        }
        words
    }
}

#[derive(Clone)]
pub struct Environment {
    pub intensity: f32,
    pub color: [f32; 3],
    pub rotation: f32,
    pub studio: crate::studio::Studio,
    pub background: bool,
    pub background_color: [f32; 3],
    pub background_alpha: f32,
    pub image: Option<Arc<image::Rgb32FImage>>,
    pub name: String,
    pixel_cache: Arc<std::sync::Mutex<Option<(Box<Environment>, Arc<[f32]>)>>>,
}
impl Default for Environment {
    fn default() -> Self {
        Self {
            intensity: 1.,
            color: [0.8, 0.88, 1.],
            rotation: 0.,
            studio: crate::studio::Studio::default(),
            background: true,
            background_color: [0.025, 0.025, 0.03],
            background_alpha: 1.,
            image: None,
            name: "Built-in environment".into(),
            pixel_cache: Arc::new(std::sync::Mutex::new(None)),
        }
    }
}
impl Environment {
    fn pixels_shared(&self) -> (u32, u32, Arc<[f32]>) {
        let mut cache = self.pixel_cache.lock().unwrap();
        if let Some((previous, pixels)) = &*cache {
            if previous.same_pixels(self) {
                let (w, h) = if self.studio.enabled {
                    (64, 32)
                } else {
                    self.image
                        .as_ref()
                        .map(|i| i.dimensions())
                        .unwrap_or((64, 32))
                };
                return (w, h, pixels.clone());
            }
        }
        let (w, h, pixels) = self.pixels();
        let pixels: Arc<[f32]> = pixels.into();
        let mut previous = self.clone();
        previous.pixel_cache = Arc::new(std::sync::Mutex::new(None));
        *cache = Some((Box::new(previous), pixels.clone()));
        (w, h, pixels)
    }
    pub fn load(&mut self, path: &Path) -> Result<()> {
        let img = image::ImageReader::open(path)?
            .with_guessed_format()?
            .decode()?
            .into_rgb32f();
        ensure!(
            img.width() as u64 * img.height() as u64 <= 4_194_304,
            "Environment exceeds 4M pixels"
        );
        ensure!(
            img.pixels()
                .all(|p| p.0.iter().all(|v| v.is_finite() && *v >= 0.)),
            "Environment must be finite and nonnegative"
        );
        self.image = Some(Arc::new(img));
        self.name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into();
        Ok(())
    }
    /// Whether `pixels` would return the same map.
    fn same_pixels(&self, other: &Self) -> bool {
        if self.studio.enabled != other.studio.enabled {
            return false;
        }
        if self.studio.enabled {
            return self.studio.same_ambient(&other.studio);
        }
        self.intensity.to_bits() == other.intensity.to_bits()
            && self.color.map(f32::to_bits) == other.color.map(f32::to_bits)
            && self.rotation.to_bits() == other.rotation.to_bits()
            && match (&self.image, &other.image) {
                (Some(a), Some(b)) => Arc::ptr_eq(a, b),
                (a, b) => a.is_none() && b.is_none(),
            }
    }
    fn pixels(&self) -> (u32, u32, Vec<f32>) {
        if self.studio.enabled {
            return self.studio.pixels();
        }
        let (width, height) = self
            .image
            .as_ref()
            .map(|i| i.dimensions())
            .unwrap_or((64, 32));
        let mut pixels = Vec::with_capacity(width as usize * height as usize * 4);
        for y in 0..height {
            for x in 0..width {
                let sx = ((x as f32 + self.rotation / 360. * width as f32).rem_euclid(width as f32))
                    as u32;
                let rgb = if let Some(image) = &self.image {
                    image.get_pixel(sx, y).0
                } else {
                    let bright = if (7..20).contains(&sx) && (6..14).contains(&y) {
                        5.
                    } else {
                        0.
                    };
                    let sky = 0.12 + 0.6 * (1. - y as f32 / height as f32);
                    [sky + bright, sky + bright, sky + bright]
                };
                for (k, c) in rgb.iter().enumerate() {
                    pixels.push(c * self.color[k] * self.intensity);
                }
                pixels.push(1.);
            }
        }
        (width, height, pixels)
    }
}

#[cfg(test)]
mod descriptor_tests {
    use super::*;
    use crate::renderer::Camera;

    struct Scene {
        model: Model,
        camera: Camera,
        environment: Environment,
        light: KeyLight,
        size: [u32; 2],
        descriptor: Option<Descriptor>,
    }
    impl Scene {
        fn new() -> Self {
            let model =
                Model::load(&Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/sample.glb"))
                    .unwrap();
            Self {
                camera: Camera::fit(model.center, model.radius),
                model,
                environment: Environment::default(),
                light: KeyLight {
                    enabled: true,
                    ..KeyLight::default()
                },
                size: [160, 104],
                descriptor: None,
            }
        }
        // Byte equality also checks every payload offset after a layout change.
        fn check(&mut self) -> usize {
            let camera = self.camera.bytes(self.size);
            let expected = self.model.descriptor_with_light(
                &camera,
                self.size,
                &self.environment,
                &self.light,
            );
            let actual = self.model.update_descriptor(
                &mut self.descriptor,
                &camera,
                self.size,
                &self.environment,
                &self.light,
            );
            assert_eq!(actual, expected);
            actual.as_ptr() as usize
        }
    }

    #[test]
    fn texture_sampling_edits_separate_shared_slots_and_pack_wrap_and_repeat() {
        let mut s = Scene::new();
        s.model.textures = Arc::new(vec![Texture {
            float_pixels: None,
            storage: 0,
            flip_y: false,
            source: 0,
            width: 1,
            height: 1,
            pixels: vec![200, 80, 30, 255].into(),
            uv: 0,
            scale: [1.; 2],
            offset: [0.; 2],
            wrap: [0; 2],
        }]);
        s.model.materials[0].maps = [u32::MAX; 9];
        s.model.materials[0].maps[0] = 0;
        s.model.materials[0].maps[2] = 0;
        let snapshot = s.model.clone();
        assert!(
            s.model
                .set_texture_sampling(0, 0, [1, 2], [-2., 0.])
                .unwrap()
        );
        let id = s.model.materials[0].maps[0] as usize;
        assert_ne!(id, 0);
        assert_eq!(s.model.materials[0].maps[2], 0);
        assert_eq!(snapshot.textures[0].wrap, [0; 2]);
        assert_eq!(s.model.textures[0].scale, [1.; 2]);
        assert!(Arc::ptr_eq(
            &s.model.textures[0].pixels,
            &s.model.textures[id].pixels
        ));
        assert!(
            !s.model
                .set_texture_sampling(0, 0, [1, 2], [-2., 0.])
                .unwrap()
        );
        assert!(
            s.model
                .set_texture_sampling(0, 0, [2, 1], [25., -3.])
                .unwrap()
        );
        assert_eq!(s.model.textures.len(), 2);
        let camera = s.camera.bytes(s.size);
        let bytes = s
            .model
            .descriptor_with_light(&camera, s.size, &s.environment, &s.light);
        let words: Vec<u32> = bytes
            .chunks_exact(4)
            .map(|b| u32::from_le_bytes(b.try_into().unwrap()))
            .collect();
        let record = words[h::TEXTURE_OFFSET] as usize + id * tex::WORDS;
        assert_eq!(words[record + tex::WRAP_S], 2);
        assert_eq!(words[record + tex::WRAP_T], 1);
        assert_eq!(f32::from_bits(words[record + tex::UV_SCALE]), 25.);
        assert_eq!(f32::from_bits(words[record + tex::UV_SCALE + 1]), -3.);
        let allocation = s.check();
        assert!(
            s.model
                .set_texture_sampling(0, 0, [0, 0], [0., -1.])
                .unwrap()
        );
        assert_eq!(s.check(), allocation);
        assert!(s.model.set_texture_sampling(0, 0, [3, 0], [1.; 2]).is_err());
        assert!(
            s.model
                .set_texture_sampling(0, 0, [0; 2], [f32::NAN, 1.])
                .is_err()
        );
    }

    #[test]
    fn imported_maps_keep_independent_gltf_sampler_modes() {
        let document = gltf::Gltf::from_slice(br#"{"asset":{"version":"2.0"},"images":[{"uri":"unused.png"}],"samplers":[{"wrapS":33071,"wrapT":33648},{}],"textures":[{"source":0,"sampler":0},{"source":0,"sampler":1}]}"#).unwrap();
        let image = gltf::image::Data {
            pixels: vec![255; 4],
            format: gltf::image::Format::R8G8B8A8,
            width: 1,
            height: 1,
        };
        let mut model = Scene::new().model;
        let pixels = vec![vec![255; 4]];
        for texture in document.textures() {
            model
                .add_map(texture, 0, None, std::slice::from_ref(&image), &pixels)
                .unwrap();
        }
        assert_eq!(model.textures.len(), 2);
        assert_eq!(model.textures[0].wrap, [1, 2]);
        assert_eq!(model.textures[1].wrap, [0, 0]);
    }

    #[test]
    fn editable_records_reuse_storage_and_match_fresh_descriptors() {
        let mut s = Scene::new();
        let allocation = s.check();
        for step in 0..4 {
            s.camera.orbit([0.2, -0.1]);
            s.model.meshes[0].transform.w_axis.x += 0.1;
            let m = &mut s.model.materials[0];
            m.color = [0.1, 0.2, 0.3];
            m.roughness = 0.2 + step as f32 * 0.1;
            m.metalness = 0.6;
            m.opacity = 0.8;
            m.transmission = 0.3;
            m.ior = 1.7;
            m.emission = [0.3, 0.4, 0.5];
            m.emission_strength = 2.;
            m.maps = [u32::MAX; 9];
            m.alpha_mode = step % 3;
            m.alpha_cutoff = 0.4;
            m.double_sided = step % 2 == 0;
            m.normal_scale = 0.5;
            m.unlit = step % 2 != 0;
            m.layers = MaterialLayers {
                diffuse_roughness: 0.2,
                specular_weight: 0.8,
                anisotropy: 0.3,
                transmission_color: [0.3, 0.8, 0.5],
                transmission_depth: 0.2,
                dispersion: 0.1,
                thin_walled: step % 2 == 0,
                coat_weight: 0.4,
                coat_roughness: 0.1,
                coat_ior: 1.7,
                coat_color: [0.9, 0.8, 0.7],
                subsurface_weight: 0.2,
                subsurface_color: [0.9, 0.5, 0.3],
                subsurface_radius: 0.1,
                fuzz_weight: 0.3,
                fuzz_color: [0.8, 0.7, 0.6],
                fuzz_roughness: 0.6,
                film_weight: 0.5,
                film_thickness: 0.4,
                film_ior: 1.6,
                bevel: 0.01,
                specular_color: [0.3, 0.7, 0.9],
                subsurface_radius_scale: [1., 0.6, 0.2],
                displacement_scale: 0.02,
                displacement_bias: -0.01,
                displacement_step: 0.,
                displacement_projection: 1,
                displacement_projection_scale: 2.,
            };
            s.light.color = [0.3, 0.5, 0.8];
            s.light.intensity += 0.2;
            s.light.azimuth += 12.;
            s.light.elevation -= 3.;
            s.environment.background = step % 2 == 0;
            s.environment.background_color = [step as f32 * 0.1, 0.1, 0.3];
            s.environment.background_alpha = if step % 2 == 0 { 1. } else { 0. };
            assert_eq!(s.check(), allocation);
            // Snapshot moved to and back from a worker still owns the same buffer.
            let cached = s.descriptor.take();
            s.descriptor = std::thread::spawn(move || cached).join().unwrap();
            assert_eq!(s.check(), allocation);
        }
        s.model.meshes.reverse();
        s.model.materials.reverse();
        assert_eq!(s.check(), allocation);
    }

    #[test]
    fn environment_edits_replace_only_pixels_until_dimensions_change() {
        let mut s = Scene::new();
        let allocation = s.check();
        for step in 0..4 {
            s.environment.rotation = step as f32 * 47.;
            s.environment.intensity = step as f32 * 0.4;
            s.environment.color = [0.2, 0.6, 0.9];
            assert_eq!(s.check(), allocation);
        }
        s.environment.intensity = -0.;
        s.check();
        s.environment.intensity = 0.;
        assert_eq!(s.check(), allocation);
        s.environment.image = Some(Arc::new(image::Rgb32FImage::from_pixel(
            64,
            32,
            image::Rgb([2., 1., 0.5]),
        )));
        assert_eq!(s.check(), allocation);
        s.environment.intensity = 1.;
        s.check();
        Arc::make_mut(s.environment.image.as_mut().unwrap()).put_pixel(
            0,
            0,
            image::Rgb([4., 3., 2.]),
        );
        assert_eq!(s.check(), allocation);
        s.environment.image = Some(Arc::new(image::Rgb32FImage::new(8, 4)));
        assert_ne!(s.check(), allocation);
        s.environment.image = None;
        s.check();
    }

    #[test]
    fn structural_changes_and_rejected_values_do_not_leave_stale_payloads() {
        let mut s = Scene::new();
        s.check();
        s.model.materials[0].roughness = f32::NAN;
        s.check();
        s.model.materials[0].roughness = 0.4;
        s.check();
        // Shared source arrays use copy-on-write; the stable-size descriptor patches in place.
        let allocation = s.check();
        Arc::make_mut(&mut Arc::make_mut(&mut s.model.geometries)[0].positions)[0] += 0.5;
        assert_eq!(s.check(), allocation);
        let allocation = s.check();
        let textures = Arc::make_mut(&mut s.model.textures);
        textures.push(Texture {
            float_pixels: None,
            storage: 0,
            flip_y: false,
            source: 0,
            width: 1,
            height: 1,
            pixels: vec![128, 64, 32, 255].into(),
            uv: 0,
            scale: [1.; 2],
            offset: [0.; 2],
            wrap: [0; 2],
        });
        assert_ne!(s.check(), allocation);
        let allocation = s.check();
        Arc::make_mut(
            &mut Arc::make_mut(&mut s.model.textures)
                .last_mut()
                .unwrap()
                .pixels,
        )[0] = 255;
        assert_eq!(s.check(), allocation);
        let allocation = s.check();
        s.model.meshes.push(s.model.meshes[0].clone());
        s.model.materials.push(s.model.materials[0].clone());
        assert_ne!(s.check(), allocation);
        s.model.meshes.pop();
        s.model.materials.pop();
        s.check();
        let allocation = s.check();
        s.light.enabled = false;
        assert_ne!(s.check(), allocation);
        s.light.enabled = true;
        s.check();
        let allocation = s.check();
        s.size = [320, 208];
        assert_eq!(s.check(), allocation);
        // A new model with matching counts must not inherit old geometry/textures.
        let allocation = s.check();
        let other = Scene::new();
        s.model = other.model;
        assert_ne!(s.check(), allocation);
    }
}

#[test]
fn scene_api_matches_saved_legacy_viewer_encoding() {
    if let Ok(path) = std::env::var("MT_SCENE_BASELINE") {
        let model =
            Model::load(&Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/sample.glb")).unwrap();
        let camera = crate::renderer::Camera::fit(model.center, model.radius);
        assert_eq!(
            model.descriptor(
                &camera.bytes([160, 104]),
                [160, 104],
                &Environment::default()
            ),
            std::fs::read(Path::new(&path).join("viewer-scene.bin")).unwrap()
        );
    }
}
