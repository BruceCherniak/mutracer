//! glTF-to-descriptor adapter; all renderer preparation stays in the AOT library.
use anyhow::{Context, Result, bail, ensure};
use glam::{Mat4, Vec3};
use mutracer_native_probe::layout::{
    camera as camera_wire, geometry as g, header as h, light as light_wire, material as mat,
    mesh as wire_mesh, texture as tex,
};
use std::{collections::HashMap, path::Path, sync::Arc};

#[derive(Clone)]
pub struct Texture {
    pub source: usize,
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
    pub uv: u32,
    pub scale: [f32; 2],
    pub offset: [f32; 2],
}
#[derive(Clone)]
pub struct Material {
    pub name: String,
    pub color: [f32; 3],
    pub roughness: f32,
    pub metalness: f32,
    pub opacity: f32,
    pub transmission: f32,
    pub ior: f32,
    pub emission: [f32; 3],
    pub emission_strength: f32,
    pub maps: [u32; 4],
    pub alpha_mode: u32,
    pub alpha_cutoff: f32,
    pub double_sided: bool,
    pub normal_scale: f32,
    pub unlit: bool,
}
impl Material {}
#[derive(Clone)]
pub struct Geometry {
    pub min: Vec3,
    pub max: Vec3,
    pub positions: Vec<f32>,
    pub indices: Vec<u32>,
    pub normals: Vec<f32>,
    pub uv: [Vec<f32>; 2],
    pub colors: Vec<f32>,
    pub tangents: Vec<f32>,
}
impl Geometry {}
#[derive(Clone)]
pub struct Mesh {
    pub name: String,
    pub geometry: usize,
    pub material: usize,
    pub transform: Mat4,
}
impl Mesh {}
#[derive(Clone)]
pub struct Model {
    pub name: String,
    pub materials: Vec<Material>,
    pub textures: Arc<Vec<Texture>>,
    pub geometries: Arc<Vec<Geometry>>,
    pub picking: Arc<Vec<mutracer_native_probe::picking::PickBvh>>,
    pub meshes: Vec<Mesh>,
    pub center: Vec3,
    pub radius: f32,
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
            meshes: vec![],
            center: Vec3::ZERO,
            radius: 1.,
            warnings: vec![],
        };
        for extension in document.extensions_used().filter(|e| !known.contains(e)) {
            model.warnings.push(format!(
                "Unsupported optional extension is ignored: {extension}"
            ));
        }
        if document.animations().len() > 0 {
            model
                .warnings
                .push("Animations are not played; showing the scene's static pose.".into());
        }
        let rgba: Vec<Vec<u8>> = images.iter().map(image_rgba).collect::<Result<_>>()?;
        for material in document.materials() {
            let pbr = material.pbr_metallic_roughness();
            let base = pbr.base_color_factor();
            let mut maps = [u32::MAX; 4];
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
            maps: [u32::MAX; 4],
            alpha_mode: 1,
            alpha_cutoff: 0.5,
            double_sided: false,
            normal_scale: 1.,
            unlit: false,
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
        Ok(model)
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
        if sampler.wrap_s() != gltf::texture::WrappingMode::Repeat
            || sampler.wrap_t() != gltf::texture::WrappingMode::Repeat
        {
            self.warnings.push(
                "Texture wrapping uses repeat; clamp/mirror samplers are unsupported.".into(),
            );
        }
        let source = texture.source().index();
        let image = &images[source];
        ensure!(
            image.width as u64 * image.height as u64 <= 16_777_216,
            "Source material texture exceeds 16M pixels"
        );
        if let Some(id) = self.textures.iter().position(|t| {
            t.source == source && t.uv == uv && t.scale == scale && t.offset == offset
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
            source,
            width,
            height,
            pixels,
            uv,
            scale,
            offset,
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
                    let colors = reader
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
                        min: Vec3::ZERO,
                        max: Vec3::ZERO,
                        positions,
                        indices,
                        normals: reader
                            .read_normals()
                            .map(|v| v.flatten().collect())
                            .unwrap_or_default(),
                        uv: [0, 1].map(|i| {
                            reader
                                .read_tex_coords(i)
                                .map(|v| v.into_f32().flatten().collect())
                                .unwrap_or_default()
                        }),
                        colors,
                        tangents: reader
                            .read_tangents()
                            .map(|v| v.flatten().collect())
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
                                        if let Some(v) = target.get_mut(vertex * stride + k) {
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
                            geometry.positions[vertex * 3..vertex * 3 + 3]
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
                                    data[vertex * stride..vertex * stride + 3]
                                        .copy_from_slice(&n.to_array());
                                }
                            }
                        }
                        self.warnings.push(
                            "Skinned meshes use the initial static pose; animation is not played."
                                .into(),
                        );
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
        self.words(camera, size, environment, light)
            .into_iter()
            .flat_map(u32::to_le_bytes)
            .collect()
    }
    /// Brings `cached` up to date with this model and returns its bytes. Camera,
    /// mesh, material, light and environment edits are written into the cached
    /// words; a different layout (counts, geometry, textures, image size, light
    /// presence or map size) rebuilds it.
    pub fn update_descriptor<'a>(
        &self,
        cached: &'a mut Option<Descriptor>,
        camera: &[u8],
        size: [u32; 2],
        environment: &Environment,
        light: &KeyLight,
    ) -> &'a [u8] {
        let patched = cached
            .as_mut()
            .is_some_and(|d| self.patch(d, camera, size, environment, light));
        if !patched {
            *cached = Some(Descriptor {
                words: self.words(camera, size, environment, light),
                geometries: self.geometries.clone(),
                textures: self.textures.clone(),
                environment: environment.clone(),
            });
        }
        cached.as_ref().unwrap().bytes()
    }
    fn patch(
        &self,
        d: &mut Descriptor,
        camera: &[u8],
        size: [u32; 2],
        environment: &Environment,
        light: &KeyLight,
    ) -> bool {
        let w = &mut d.words;
        if !Arc::ptr_eq(&d.geometries, &self.geometries)
            || !Arc::ptr_eq(&d.textures, &self.textures)
            || w[h::WIDTH] != size[0]
            || w[h::HEIGHT] != size[1]
            || w[h::MESH_COUNT] as usize != self.meshes.len()
            || w[h::MATERIAL_COUNT] as usize != self.materials.len()
            || w[h::LIGHT_COUNT] != u32::from(light.enabled)
            || camera.len() != camera_wire::WORDS * 4
        {
            return false;
        }
        if !d.environment.same_pixels(environment) {
            let (width, height, pixels) = environment.pixels();
            let o = w[h::TEXTURE_OFFSET] as usize + self.textures.len() * tex::WORDS;
            if w[o + tex::WIDTH] != width || w[o + tex::HEIGHT] != height {
                return false;
            }
            let at = w[o + tex::PIXELS] as usize;
            for (k, v) in pixels.iter().enumerate() {
                w[at + k] = v.to_bits();
            }
        }
        d.environment = environment.clone();
        let at = w[h::CAMERA_OFFSET] as usize;
        for (k, b) in camera.chunks_exact(4).enumerate() {
            w[at + k] = u32::from_le_bytes(b.try_into().unwrap());
        }
        let mesh_offset = w[h::MESH_OFFSET] as usize;
        for (i, m) in self.meshes.iter().enumerate() {
            write_mesh(w, mesh_offset + i * wire_mesh::WORDS, m);
        }
        let material_offset = w[h::MATERIAL_OFFSET] as usize;
        for (i, m) in self.materials.iter().enumerate() {
            write_material(w, material_offset + i * mat::WORDS, m);
        }
        if light.enabled {
            let o = w[h::LIGHT_OFFSET] as usize;
            w[o..o + light_wire::WORDS].copy_from_slice(&light.record());
        }
        write_background(w, environment, self.textures.len() as u32 + 1);
        true
    }
    fn words(
        &self,
        camera: &[u8],
        size: [u32; 2],
        environment: &Environment,
        light: &KeyLight,
    ) -> Vec<u32> {
        let mut w = Wire(vec![0; h::WORDS]);
        w.0[h::VERSION] = mutracer_native_probe::layout::version::SCENE as u32;
        w.0[h::WIDTH] = size[0];
        w.0[h::HEIGHT] = size[1];
        w.0[h::GEOMETRY_COUNT] = self.geometries.len() as u32;
        w.0[h::MESH_COUNT] = self.meshes.len() as u32;
        w.0[h::MATERIAL_COUNT] = self.materials.len() as u32;
        w.0[h::LIGHT_COUNT] = u32::from(light.enabled);
        w.0[h::TEXTURE_COUNT] = self.textures.len() as u32 + 1;
        for (header, count, stride) in [
            (h::GEOMETRY_OFFSET, self.geometries.len(), g::WORDS),
            (h::MESH_OFFSET, self.meshes.len(), wire_mesh::WORDS),
            (h::MATERIAL_OFFSET, self.materials.len(), mat::WORDS),
            (h::TEXTURE_OFFSET, self.textures.len() + 1, tex::WORDS),
            (
                h::LIGHT_OFFSET,
                usize::from(light.enabled),
                light_wire::WORDS,
            ),
        ] {
            w.0[header] = w.0.len() as u32;
            w.0.resize(w.0.len() + count * stride, 0);
        }
        if light.enabled {
            let offset = w.0[h::LIGHT_OFFSET] as usize;
            w.0[offset..offset + light_wire::WORDS].copy_from_slice(&light.record());
        }
        w.0[h::CAMERA_OFFSET] = w.append_bytes(camera);
        for (i, g) in self.geometries.iter().enumerate() {
            let o = w.0[h::GEOMETRY_OFFSET] as usize + i * g::WORDS;
            w.0[o + g::VERTEX_COUNT] = g.positions.len() as u32 / 3;
            w.0[o + g::INDEX_COUNT] = g.indices.len() as u32;
            w.0[o + g::POSITION] = w.append_floats(&g.positions);
            w.0[o + g::INDICES] = w.append(&g.indices);
            for (k, data) in [
                (g::NORMAL, &g.normals),
                (g::UV, &g.uv[0]),
                (g::UV1, &g.uv[1]),
                (g::COLOR, &g.colors),
                (g::TANGENT, &g.tangents),
            ] {
                if !data.is_empty() {
                    w.0[o + k] = w.append_floats(data);
                }
            }
        }
        let mesh_offset = w.0[h::MESH_OFFSET] as usize;
        for (i, m) in self.meshes.iter().enumerate() {
            write_mesh(&mut w.0, mesh_offset + i * wire_mesh::WORDS, m);
        }
        for i in 0..self.materials.len() {
            let o = w.0[h::MATERIAL_OFFSET] as usize + i * mat::WORDS;
            w.0[o + mat::EXTENSION_COUNT] = MATERIAL_EXTENSIONS as u32;
            w.0[o + mat::EXTENSION_OFFSET] = w.append(&[0; MATERIAL_EXTENSIONS * 4]);
            write_material(&mut w.0, o, &self.materials[i]);
        }
        for (i, t) in self.textures.iter().enumerate() {
            let o = w.0[h::TEXTURE_OFFSET] as usize + i * tex::WORDS;
            w.0[o + tex::WIDTH] = t.width;
            w.0[o + tex::HEIGHT] = t.height;
            w.0[o + tex::PIXELS] = w.append_bytes(&t.pixels);
            w.0[o + tex::UV_CHANNEL] = t.uv;
            w.0[o + tex::UV_SCALE] = t.scale[0].to_bits();
            w.0[o + tex::UV_SCALE + 1] = t.scale[1].to_bits();
            w.0[o + tex::UV_OFFSET] = t.offset[0].to_bits();
            w.0[o + tex::UV_OFFSET + 1] = t.offset[1].to_bits();
        }
        let (width, height, pixels) = environment.pixels();
        let o = w.0[h::TEXTURE_OFFSET] as usize + self.textures.len() * tex::WORDS;
        w.0[o + tex::WIDTH] = width;
        w.0[o + tex::HEIGHT] = height;
        w.0[o + tex::STORAGE] = 1;
        w.0[o + tex::PIXELS] = w.append_floats(&pixels);
        w.0[o + tex::UV_SCALE] = 1f32.to_bits();
        w.0[o + tex::UV_SCALE + 1] = 1f32.to_bits();
        w.0[h::ENVIRONMENT_TEXTURE] = self.textures.len() as u32 + 1;
        write_background(&mut w.0, environment, self.textures.len() as u32 + 1);
        w.0[h::LENGTH] = w.0.len() as u32;
        w.0
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
/// A scene descriptor the viewer keeps between commits; see `Model::update_descriptor`.
pub struct Descriptor {
    words: Vec<u32>,
    geometries: Arc<Vec<Geometry>>,
    textures: Arc<Vec<Texture>>,
    environment: Environment,
}
impl Descriptor {
    pub fn bytes(&self) -> &[u8] {
        // Descriptor words are little-endian; on such targets the words are the bytes.
        #[cfg(target_endian = "little")]
        unsafe {
            // SAFETY: every initialized u32 is four readable bytes, the slice
            // borrows the vector, and u8 has no alignment/validity restrictions.
            std::slice::from_raw_parts(self.words.as_ptr().cast::<u8>(), self.words.len() * 4)
        }
        #[cfg(not(target_endian = "little"))]
        compile_error!("Native descriptors assume a little-endian target");
    }
}
const MATERIAL_EXTENSIONS: usize = 6;
fn write_mesh(w: &mut [u32], o: usize, m: &Mesh) {
    w[o + wire_mesh::GEOMETRY] = m.geometry as u32;
    w[o + wire_mesh::MATERIAL] = m.material as u32;
    for (k, v) in m.transform.to_cols_array().iter().enumerate() {
        w[o + wire_mesh::TRANSFORM + k] = v.to_bits();
    }
}
/// Material record and its extension values; the extension block is already allocated.
fn write_material(w: &mut [u32], o: usize, m: &Material) {
    for (field, value) in [
        (mat::BASE_COLOR, m.color[0]),
        (mat::BASE_COLOR + 1, m.color[1]),
        (mat::BASE_COLOR + 2, m.color[2]),
        (mat::ROUGHNESS, m.roughness),
        (mat::METALNESS, m.metalness),
        (mat::TRANSMISSION, m.transmission),
        (mat::IOR, m.ior),
        (mat::EMISSION_COLOR, m.emission[0]),
        (mat::EMISSION_COLOR + 1, m.emission[1]),
        (mat::EMISSION_COLOR + 2, m.emission[2]),
        (mat::EMISSION_LUMINANCE, m.emission_strength),
        (mat::COAT_WEIGHT, 0.),
        (mat::COAT_ROUGHNESS, 0.),
        (mat::OPACITY, m.opacity),
    ] {
        w[o + field] = value.to_bits();
    }
    w[o + mat::THIN_WALLED] = 1;
    for (k, v) in m.maps.iter().enumerate() {
        w[o + mat::MAP + k] = *v;
    }
    let ext: [u32; MATERIAL_EXTENSIONS * 4] = [
        38,
        u32::from(m.double_sided),
        0,
        0,
        41,
        m.alpha_mode,
        0,
        0,
        42,
        m.alpha_cutoff.to_bits(),
        0,
        0,
        45,
        m.normal_scale.to_bits(),
        m.normal_scale.to_bits(),
        0,
        52,
        u32::from(m.unlit),
        0,
        0,
        73,
        1,
        0,
        0,
    ];
    let at = w[o + mat::EXTENSION_OFFSET] as usize;
    w[at..at + ext.len()].copy_from_slice(&ext);
}
/// Background words; the environment map is texture `environment` (index + 1).
fn write_background(w: &mut [u32], environment: &Environment, texture: u32) {
    let color = if environment.background {
        [0.; 3]
    } else {
        [0.025f32, 0.025, 0.03]
    };
    for (k, c) in color.iter().enumerate() {
        w[h::BACKGROUND_COLOR + k] = c.to_bits();
    }
    w[h::BACKGROUND_COLOR + 3] = 1f32.to_bits();
    w[h::BACKGROUND_TEXTURE] = if environment.background { texture } else { 0 };
}
struct Wire(Vec<u32>);
impl Wire {
    fn append(&mut self, v: &[u32]) -> u32 {
        let o = self.0.len() as u32;
        self.0.extend(v);
        o
    }
    fn append_floats(&mut self, v: &[f32]) -> u32 {
        let o = self.0.len() as u32;
        self.0.extend(v.iter().map(|v| v.to_bits()));
        o
    }
    fn append_bytes(&mut self, v: &[u8]) -> u32 {
        let o = self.0.len() as u32;
        for b in v.chunks(4) {
            let mut word = [0; 4];
            word[..b.len()].copy_from_slice(b);
            self.0.push(u32::from_le_bytes(word));
        }
        o
    }
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
    pub background: bool,
    pub image: Option<Arc<image::Rgb32FImage>>,
    pub name: String,
}
impl Default for Environment {
    fn default() -> Self {
        Self {
            intensity: 1.,
            color: [0.8, 0.88, 1.],
            rotation: 0.,
            background: true,
            image: None,
            name: "Studio".into(),
        }
    }
}
impl Environment {
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
        self.intensity.to_bits() == other.intensity.to_bits()
            && self.color.map(f32::to_bits) == other.color.map(f32::to_bits)
            && self.rotation.to_bits() == other.rotation.to_bits()
            && match (&self.image, &other.image) {
                (Some(a), Some(b)) => Arc::ptr_eq(a, b),
                (a, b) => a.is_none() && b.is_none(),
            }
    }
    fn pixels(&self) -> (u32, u32, Vec<f32>) {
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
            let camera = self.camera.bytes();
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
            m.maps = [u32::MAX; 4];
            m.alpha_mode = step % 3;
            m.alpha_cutoff = 0.4;
            m.double_sided = step % 2 == 0;
            m.normal_scale = 0.5;
            m.unlit = step % 2 != 0;
            s.light.color = [0.3, 0.5, 0.8];
            s.light.intensity += 0.2;
            s.light.azimuth += 12.;
            s.light.elevation -= 3.;
            s.environment.background = step % 2 == 0;
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
        // The retained Arc forces copy-on-write even for an otherwise unique model.
        let allocation = s.check();
        Arc::make_mut(&mut s.model.geometries)[0].positions[0] += 0.5;
        assert_ne!(s.check(), allocation);
        let allocation = s.check();
        let textures = Arc::make_mut(&mut s.model.textures);
        textures.push(Texture {
            source: 0,
            width: 1,
            height: 1,
            pixels: vec![128, 64, 32, 255],
            uv: 0,
            scale: [1.; 2],
            offset: [0.; 2],
        });
        assert_ne!(s.check(), allocation);
        let allocation = s.check();
        Arc::make_mut(&mut s.model.textures)
            .last_mut()
            .unwrap()
            .pixels[0] = 255;
        assert_ne!(s.check(), allocation);
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
        assert_ne!(s.check(), allocation);
        // A new model with matching counts must not inherit old geometry/textures.
        let allocation = s.check();
        let other = Scene::new();
        s.model = other.model;
        assert_ne!(s.check(), allocation);
    }
}
