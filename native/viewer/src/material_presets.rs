//! Share the Web viewer's preset values and existing thumbnail assets.
use crate::scene::Material;
use eframe::egui;
use std::sync::OnceLock;

pub struct Preset {
    pub id: String,
    pub label: String,
    pub category: String,
    values: serde_json::Map<String, serde_json::Value>,
    thumbnail: &'static [u8],
}
pub fn presets() -> &'static [Preset] {
    static PRESETS: OnceLock<Vec<Preset>> = OnceLock::new();
    PRESETS.get_or_init(|| {
        let data: Vec<serde_json::Value> = serde_json::from_str(include_str!(
            "../../../viewer/src/engine/material-presets.json"
        ))
        .expect("Built-in material presets");
        let thumbnails: &[(&str, &[u8])] = &[
            (
                "white",
                include_bytes!("../../../viewer/src/assets/thumbnails/material-white.webp"),
            ),
            (
                "plastic",
                include_bytes!("../../../viewer/src/assets/thumbnails/material-plastic.webp"),
            ),
            (
                "clay",
                include_bytes!("../../../viewer/src/assets/thumbnails/material-clay.webp"),
            ),
            (
                "rubber",
                include_bytes!("../../../viewer/src/assets/thumbnails/material-rubber.webp"),
            ),
            (
                "ceramic",
                include_bytes!("../../../viewer/src/assets/thumbnails/material-ceramic.webp"),
            ),
            (
                "carpaint",
                include_bytes!("../../../viewer/src/assets/thumbnails/material-carpaint.webp"),
            ),
            (
                "pearl",
                include_bytes!("../../../viewer/src/assets/thumbnails/material-pearl.webp"),
            ),
            (
                "glow",
                include_bytes!("../../../viewer/src/assets/thumbnails/material-glow.webp"),
            ),
            (
                "metal",
                include_bytes!("../../../viewer/src/assets/thumbnails/material-metal.webp"),
            ),
            (
                "chrome",
                include_bytes!("../../../viewer/src/assets/thumbnails/material-chrome.webp"),
            ),
            (
                "gold",
                include_bytes!("../../../viewer/src/assets/thumbnails/material-gold.webp"),
            ),
            (
                "copper",
                include_bytes!("../../../viewer/src/assets/thumbnails/material-copper.webp"),
            ),
            (
                "brass",
                include_bytes!("../../../viewer/src/assets/thumbnails/material-brass.webp"),
            ),
            (
                "iron",
                include_bytes!("../../../viewer/src/assets/thumbnails/material-iron.webp"),
            ),
            (
                "brushed",
                include_bytes!("../../../viewer/src/assets/thumbnails/material-brushed.webp"),
            ),
            (
                "anodized",
                include_bytes!("../../../viewer/src/assets/thumbnails/material-anodized.webp"),
            ),
            (
                "glass",
                include_bytes!("../../../viewer/src/assets/thumbnails/material-glass.webp"),
            ),
            (
                "frosted",
                include_bytes!("../../../viewer/src/assets/thumbnails/material-frosted.webp"),
            ),
            (
                "bottle",
                include_bytes!("../../../viewer/src/assets/thumbnails/material-bottle.webp"),
            ),
            (
                "acrylic",
                include_bytes!("../../../viewer/src/assets/thumbnails/material-acrylic.webp"),
            ),
            (
                "diamond",
                include_bytes!("../../../viewer/src/assets/thumbnails/material-diamond.webp"),
            ),
            (
                "water",
                include_bytes!("../../../viewer/src/assets/thumbnails/material-water.webp"),
            ),
            (
                "honey",
                include_bytes!("../../../viewer/src/assets/thumbnails/material-honey.webp"),
            ),
            (
                "soap",
                include_bytes!("../../../viewer/src/assets/thumbnails/material-soap.webp"),
            ),
            (
                "skin",
                include_bytes!("../../../viewer/src/assets/thumbnails/material-skin.webp"),
            ),
            (
                "wax",
                include_bytes!("../../../viewer/src/assets/thumbnails/material-wax.webp"),
            ),
            (
                "jade",
                include_bytes!("../../../viewer/src/assets/thumbnails/material-jade.webp"),
            ),
            (
                "marble",
                include_bytes!("../../../viewer/src/assets/thumbnails/material-marble.webp"),
            ),
            (
                "milk",
                include_bytes!("../../../viewer/src/assets/thumbnails/material-milk.webp"),
            ),
            (
                "velvet",
                include_bytes!("../../../viewer/src/assets/thumbnails/material-velvet.webp"),
            ),
            (
                "cotton",
                include_bytes!("../../../viewer/src/assets/thumbnails/material-cotton.webp"),
            ),
            (
                "leather",
                include_bytes!("../../../viewer/src/assets/thumbnails/material-leather.webp"),
            ),
        ];
        data.into_iter()
            .map(|value| {
                let id = value["id"].as_str().unwrap();
                Preset {
                    id: id.into(),
                    label: value["label"].as_str().unwrap().into(),
                    category: value["category"].as_str().unwrap().into(),
                    values: value["values"].as_object().unwrap().clone(),
                    thumbnail: thumbnails
                        .iter()
                        .find(|(key, _)| *key == id)
                        .expect("Preset thumbnail")
                        .1,
                }
            })
            .collect()
    })
}
impl Preset {
    pub fn apply(&self, material: &mut Material) {
        for (key, value) in &self.values {
            match key.as_str() {
                "baseColor" => {
                    material.color = std::array::from_fn(|i| value[i].as_f64().unwrap() as f32)
                }
                "baseMetalness" => material.metalness = value.as_f64().unwrap() as f32,
                "specularRoughness" => material.roughness = value.as_f64().unwrap() as f32,
                "specularIor" => material.ior = value.as_f64().unwrap() as f32,
                "specularWeight" => {
                    material.layers.specular_weight = value.as_f64().unwrap() as f32
                }
                "baseDiffuseRoughness" => {
                    material.layers.diffuse_roughness = value.as_f64().unwrap() as f32
                }
                "opacity" => material.opacity = value.as_f64().unwrap() as f32,
                "transmissionWeight" => material.transmission = value.as_f64().unwrap() as f32,
                "transmissionColor" => {
                    material.layers.transmission_color =
                        std::array::from_fn(|i| value[i].as_f64().unwrap() as f32)
                }
                "transmissionDepth" => {
                    material.layers.transmission_depth = value.as_f64().unwrap() as f32
                }
                "transmissionDispersionScale" => {
                    material.layers.dispersion = value.as_f64().unwrap() as f32
                }
                "coatColor" => {
                    material.layers.coat_color =
                        std::array::from_fn(|i| value[i].as_f64().unwrap() as f32)
                }
                "specularColor" => {
                    material.layers.specular_color =
                        std::array::from_fn(|i| value[i].as_f64().unwrap() as f32)
                }
                "subsurfaceRadiusScale" => {
                    material.layers.subsurface_radius_scale =
                        std::array::from_fn(|i| value[i].as_f64().unwrap() as f32)
                }
                "coatWeight" => material.layers.coat_weight = value.as_f64().unwrap() as f32,
                "coatRoughness" => material.layers.coat_roughness = value.as_f64().unwrap() as f32,
                "coatIor" => material.layers.coat_ior = value.as_f64().unwrap() as f32,
                "subsurfaceWeight" => {
                    material.layers.subsurface_weight = value.as_f64().unwrap() as f32
                }
                "subsurfaceColor" => {
                    material.layers.subsurface_color =
                        std::array::from_fn(|i| value[i].as_f64().unwrap() as f32)
                }
                "subsurfaceRadius" => {
                    material.layers.subsurface_radius = value.as_f64().unwrap() as f32
                }
                "fuzzWeight" => material.layers.fuzz_weight = value.as_f64().unwrap() as f32,
                "fuzzColor" => {
                    material.layers.fuzz_color =
                        std::array::from_fn(|i| value[i].as_f64().unwrap() as f32)
                }
                "fuzzRoughness" => material.layers.fuzz_roughness = value.as_f64().unwrap() as f32,
                "thinFilmWeight" => material.layers.film_weight = value.as_f64().unwrap() as f32,
                "thinFilmThickness" => {
                    material.layers.film_thickness = value.as_f64().unwrap() as f32
                }
                "thinFilmIor" => material.layers.film_ior = value.as_f64().unwrap() as f32,
                "emissionColor" => {
                    material.emission = std::array::from_fn(|i| value[i].as_f64().unwrap() as f32)
                }
                "emissionLuminance" => material.emission_strength = value.as_f64().unwrap() as f32,
                "specularAnisotropy" => material.layers.anisotropy = value.as_f64().unwrap() as f32,
                "thinWalled" => material.layers.thin_walled = value.as_bool().unwrap(),
                _ => panic!("Unmapped built-in material preset field: {key}"),
            }
        }
    }
    pub fn texture(&self, ctx: &egui::Context) -> egui::TextureHandle {
        let id = egui::Id::new(("material-thumbnail", &self.id));
        if let Some(texture) = ctx.data(|data| data.get_temp::<egui::TextureHandle>(id)) {
            return texture;
        }
        let image = image::load_from_memory(self.thumbnail)
            .expect("Built-in material thumbnail")
            .into_rgba8();
        let pixels = egui::ColorImage::from_rgba_unmultiplied(
            [image.width() as usize, image.height() as usize],
            image.as_raw(),
        );
        let texture = ctx.load_texture(&self.id, pixels, egui::TextureOptions::LINEAR);
        ctx.data_mut(|data| data.insert_temp(id, texture.clone()));
        texture
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_web_preset_applies_all_values_and_keeps_textures() {
        let model = crate::scene::Model::load(
            &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/sample.glb"),
        )
        .unwrap();
        let data: Vec<serde_json::Value> = serde_json::from_str(include_str!(
            "../../../viewer/src/engine/material-presets.json"
        ))
        .unwrap();
        assert_eq!(presets().len(), data.len());
        for preset in presets() {
            let mut material = model.materials[0].clone();
            material.maps = [7; 9];
            material.layers.specular_color = [0.1; 3];
            material.layers.subsurface_radius_scale = [0.2; 3];
            // Read the packed contract independently of Preset::apply's assignments.
            preset.apply(&mut material);
            assert_eq!(material.maps, [7; 9]);
            assert_eq!(material.alpha_mode, model.materials[0].alpha_mode);
            let values = crate::scene::material_values(&material);
            for (key, expected) in &preset.values {
                let actual = &values[key];
                if let Some(expected) = expected.as_array() {
                    for (a, b) in actual.as_array().unwrap().iter().zip(expected) {
                        assert!(
                            (a.as_f64().unwrap() - b.as_f64().unwrap()).abs() < 1e-6,
                            "{}: {key}",
                            preset.id
                        );
                    }
                } else if let Some(expected) = expected.as_f64() {
                    assert!(
                        (actual.as_f64().unwrap() - expected).abs() < 1e-6,
                        "{}: {key}",
                        preset.id
                    );
                } else {
                    assert_eq!(actual, expected, "{}: {key}", preset.id);
                }
            }
            assert!(image::load_from_memory(preset.thumbnail).is_ok());
        }
    }
}
