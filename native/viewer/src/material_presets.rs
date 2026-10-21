//! Share the Web viewer's preset values and existing thumbnail assets.
use crate::scene::Material;
use eframe::egui;
use std::sync::OnceLock;

pub struct Preset {
    pub id: String,
    pub label: String,
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
                "metal",
                include_bytes!("../../../viewer/src/assets/thumbnails/material-metal.webp"),
            ),
            (
                "glass",
                include_bytes!("../../../viewer/src/assets/thumbnails/material-glass.webp"),
            ),
            (
                "carpaint",
                include_bytes!("../../../viewer/src/assets/thumbnails/material-carpaint.webp"),
            ),
            (
                "velvet",
                include_bytes!("../../../viewer/src/assets/thumbnails/material-velvet.webp"),
            ),
            (
                "skin",
                include_bytes!("../../../viewer/src/assets/thumbnails/material-skin.webp"),
            ),
            (
                "plastic",
                include_bytes!("../../../viewer/src/assets/thumbnails/material-plastic.webp"),
            ),
            (
                "soap",
                include_bytes!("../../../viewer/src/assets/thumbnails/material-soap.webp"),
            ),
        ];
        data.into_iter()
            .map(|value| {
                let id = value["id"].as_str().unwrap();
                Preset {
                    id: id.into(),
                    label: value["label"].as_str().unwrap().into(),
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
    fn presets_replace_active_layers_without_discarding_imported_material_properties() {
        let model = crate::scene::Model::load(
            &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/sample.glb"),
        )
        .unwrap();
        for preset in presets() {
            let mut material = model.materials[0].clone();
            material.maps = [7, 8, 9, 10];
            material.layers.coat_weight = 1.;
            material.layers.fuzz_weight = 1.;
            material.layers.subsurface_weight = 1.;
            material.layers.film_weight = 1.;
            material.emission_strength = 50.;
            preset.apply(&mut material);
            assert_eq!(material.maps, [7, 8, 9, 10]);
            assert_eq!(material.alpha_mode, model.materials[0].alpha_mode);
            assert_eq!(material.double_sided, model.materials[0].double_sided);
            assert!(!material.layers.thin_walled);
            assert_eq!(material.emission_strength, 0.);
            assert_eq!(
                material.layers.coat_weight,
                if preset.id == "carpaint" { 1. } else { 0. }
            );
            assert_eq!(
                material.layers.fuzz_weight,
                if preset.id == "velvet" { 1. } else { 0. }
            );
            assert_eq!(
                material.layers.subsurface_weight,
                if preset.id == "skin" { 1. } else { 0. }
            );
            assert_eq!(
                material.layers.film_weight,
                if preset.id == "soap" { 1. } else { 0. }
            );
            assert_eq!(
                material.transmission,
                if preset.id == "glass" { 1. } else { 0. }
            );
            assert_eq!(
                material.metalness,
                match preset.id.as_str() {
                    "metal" => 1.,
                    "carpaint" => 0.3,
                    _ => 0.,
                }
            );
            assert!(image::load_from_memory(preset.thumbnail).is_ok());
        }
        let mut material = model.materials[0].clone();
        presets()
            .iter()
            .find(|p| p.id == "glass")
            .unwrap()
            .apply(&mut material);
        assert_eq!(material.ior, 1.5);
        assert_eq!(material.roughness, 0.);
        assert_eq!(material.layers.transmission_depth, 0.);
        presets()
            .iter()
            .find(|p| p.id == "plastic")
            .unwrap()
            .apply(&mut material);
        assert_eq!(material.transmission, 0.);
        assert_eq!(material.color, [0.05, 0.25, 0.7]);
        assert_eq!(material.ior, 1.46);
        assert_eq!(material.roughness, 0.32);
    }
}
