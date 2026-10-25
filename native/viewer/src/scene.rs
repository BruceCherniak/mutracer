//! glTF-to-descriptor adapter; all renderer preparation stays in the AOT library.
use anyhow::{Result, ensure};
use glam::{Mat4, Vec3};
use mutracer_native_probe::layout::light as light_wire;
#[cfg(test)]
use mutracer_native_probe::layout::{header as h, texture as tex};
use std::{path::Path, sync::Arc};

pub use mutracer_native_probe::scene_api::viewer_support::Descriptor;
#[cfg(test)]
pub use mutracer_native_probe::scene_api::viewer_support::material_values;
pub use mutracer_native_probe::scene_api::viewer_support::{Material, Mesh, Texture};
pub use mutracer_native_probe::scene_api::{Geometry, MaterialLayers};
#[derive(Clone)]
pub struct Model(pub mutracer_native_probe::scene_api::viewer_support::Model);
impl std::ops::Deref for Model {
    type Target = mutracer_native_probe::scene_api::viewer_support::Model;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
impl std::ops::DerefMut for Model {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}
impl Model {
    pub fn load(path: &Path) -> Result<Self> {
        Ok(Self(
            mutracer_native_probe::scene_api::viewer_support::Model::load(path)?,
        ))
    }
    fn scene_object(
        &self,
        environment: &Environment,
        light: &KeyLight,
    ) -> mutracer_native_probe::scene_api::Scene {
        use mutracer_native_probe::scene_api::viewer_support as encoder;
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
        encoder::SceneData {
            properties: &self.properties,
            geometries: &self.geometries,
            materials: &self.materials,
            textures: &self.textures,
            meshes: &self.meshes,
            lights,
            ies: vec![],
        }
        .to_scene(&env)
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
                camera: Camera::fit(model.0.center, model.0.radius),
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
        s.model.0.textures = Arc::new(vec![Texture {
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
        s.model.0.materials[0].maps = [u32::MAX; 9];
        s.model.0.materials[0].maps[0] = 0;
        s.model.0.materials[0].maps[2] = 0;
        let snapshot = s.model.clone();
        assert!(
            s.model
                .set_texture_sampling(0, 0, [1, 2], [-2., 0.])
                .unwrap()
        );
        let id = s.model.0.materials[0].maps[0] as usize;
        assert_ne!(id, 0);
        assert_eq!(s.model.0.materials[0].maps[2], 0);
        assert_eq!(snapshot.textures[0].wrap, [0; 2]);
        assert_eq!(s.model.0.textures[0].scale, [1.; 2]);
        assert!(Arc::ptr_eq(
            &s.model.0.textures[0].pixels,
            &s.model.0.textures[id].pixels
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
        assert_eq!(s.model.0.textures.len(), 2);
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
    fn editable_records_reuse_storage_and_match_fresh_descriptors() {
        let mut s = Scene::new();
        let allocation = s.check();
        for step in 0..4 {
            s.camera.orbit([0.2, -0.1]);
            s.model.0.meshes[0].transform.w_axis.x += 0.1;
            let m = &mut s.model.0.materials[0];
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
        s.model.0.meshes.reverse();
        s.model.0.materials.reverse();
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
        s.model.0.materials[0].roughness = f32::NAN;
        s.check();
        s.model.0.materials[0].roughness = 0.4;
        s.check();
        // Shared source arrays use copy-on-write; the stable-size descriptor patches in place.
        let allocation = s.check();
        Arc::make_mut(&mut Arc::make_mut(&mut s.model.0.geometries)[0].positions)[0] += 0.5;
        assert_eq!(s.check(), allocation);
        let allocation = s.check();
        let textures = Arc::make_mut(&mut s.model.0.textures);
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
            &mut Arc::make_mut(&mut s.model.0.textures)
                .last_mut()
                .unwrap()
                .pixels,
        )[0] = 255;
        assert_eq!(s.check(), allocation);
        let allocation = s.check();
        s.model.0.meshes.push(s.model.0.meshes[0].clone());
        s.model.0.materials.push(s.model.0.materials[0].clone());
        assert_ne!(s.check(), allocation);
        s.model.0.meshes.pop();
        s.model.0.materials.pop();
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
        let camera = crate::renderer::Camera::fit(model.0.center, model.0.radius);
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
