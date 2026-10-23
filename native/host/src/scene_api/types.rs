use glam::Vec3;
use std::sync::Arc;

/// Editable OpenPBR layer parameters.
#[derive(Clone)]
pub struct MaterialLayers {
    pub diffuse_roughness: f32,
    pub specular_weight: f32,
    pub specular_color: [f32; 3],
    pub anisotropy: f32,
    pub transmission_color: [f32; 3],
    pub transmission_depth: f32,
    pub dispersion: f32,
    pub thin_walled: bool,
    pub coat_weight: f32,
    pub coat_roughness: f32,
    pub coat_ior: f32,
    pub coat_color: [f32; 3],
    pub subsurface_weight: f32,
    pub subsurface_color: [f32; 3],
    pub subsurface_radius: f32,
    pub subsurface_radius_scale: [f32; 3],
    pub fuzz_weight: f32,
    pub fuzz_color: [f32; 3],
    pub fuzz_roughness: f32,
    pub film_weight: f32,
    pub film_thickness: f32,
    pub film_ior: f32,
    pub bevel: f32,
    pub displacement_scale: f32,
    pub displacement_bias: f32,
    pub displacement_step: f32,
    pub displacement_projection: u32,
    pub displacement_projection_scale: f32,
}
impl Default for MaterialLayers {
    fn default() -> Self {
        Self {
            diffuse_roughness: 0.,
            specular_weight: 1.,
            specular_color: [1.; 3],
            anisotropy: 0.,
            transmission_color: [1.; 3],
            transmission_depth: 0.,
            dispersion: 0.,
            // Preserve the native glTF viewer's existing thin-surface interpretation.
            thin_walled: true,
            coat_weight: 0.,
            coat_roughness: 0.,
            coat_ior: 1.6,
            coat_color: [1.; 3],
            subsurface_weight: 0.,
            subsurface_color: [0.8; 3],
            subsurface_radius: 1.,
            subsurface_radius_scale: [1., 0.5, 0.25],
            fuzz_weight: 0.,
            fuzz_color: [1.; 3],
            fuzz_roughness: 0.5,
            film_weight: 0.,
            film_thickness: 0.5,
            film_ior: 1.4,
            bevel: 0.,
            displacement_scale: 0.,
            displacement_bias: 0.,
            displacement_step: 0.,
            displacement_projection: 0,
            displacement_projection_scale: 1.,
        }
    }
}
#[derive(Clone)]
pub struct Geometry {
    pub material_indices: Arc<[u32]>,
    pub min: Vec3,
    pub max: Vec3,
    pub positions: Arc<[f32]>,
    pub indices: Arc<[u32]>,
    pub normals: Arc<[f32]>,
    pub uv: [Arc<[f32]>; 2],
    pub colors: Arc<[f32]>,
    pub tangents: Arc<[f32]>,
}
impl Geometry {}
