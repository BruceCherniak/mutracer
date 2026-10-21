//! Studio presets share their data and placement convention with the web viewer.
use glam::{DMat4, DVec3, Vec3};
use mutracer_native_probe::layout::light as wire;
use std::sync::OnceLock;

pub struct Preset {
    pub name: String,
    pub tag: String,
    lights: Vec<Panel>,
}
struct Panel {
    azimuth: f64,
    elevation: f64,
    distance: f64,
    width: f64,
    height: f64,
    power: f64,
}
pub fn presets() -> &'static [Preset] {
    static PRESETS: OnceLock<Vec<Preset>> = OnceLock::new();
    PRESETS.get_or_init(|| {
        let data: serde_json::Value = serde_json::from_str(include_str!(
            "../../../viewer/src/engine/studio-presets.json"
        ))
        .expect("Built-in studio preset data");
        data.as_array()
            .unwrap()
            .iter()
            .map(|p| Preset {
                name: p["name"].as_str().unwrap().into(),
                tag: p["tag"].as_str().unwrap().into(),
                lights: p["lights"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|l| Panel {
                        azimuth: l["azimuth"].as_f64().unwrap(),
                        elevation: l["elevation"].as_f64().unwrap(),
                        distance: l["distance"].as_f64().unwrap(),
                        width: l["width"].as_f64().unwrap(),
                        height: l["height"].as_f64().unwrap(),
                        power: l["power"].as_f64().unwrap(),
                    })
                    .collect(),
            })
            .collect()
    })
}
#[derive(Clone, PartialEq)]
pub struct Studio {
    pub enabled: bool,
    pub preset: usize,
    pub intensity: f32,
    pub rotation: f32,
    pub size: f32,
    pub ambient: f32,
    pub ambient_color: [f32; 3],
}
impl Default for Studio {
    fn default() -> Self {
        Self {
            enabled: false,
            preset: 0,
            intensity: 1.,
            rotation: 0.,
            size: 1.,
            ambient: 0.1,
            ambient_color: [1.; 3],
        }
    }
}
impl Studio {
    pub fn records(&self, center: Vec3, radius: f32, ground_y: f32) -> Vec<[u32; wire::WORDS]> {
        if !self.enabled {
            return vec![];
        }
        let radius = (radius as f64).max(1e-3);
        let size = self.size as f64;
        presets()[self.preset]
            .lights
            .iter()
            .map(|panel| {
                let azimuth = (panel.azimuth + self.rotation as f64).to_radians();
                let width = panel.width * size * radius;
                let height = panel.height * size * radius;
                let distance = panel.distance * radius;
                let x = DVec3::new(azimuth.cos(), 0., -azimuth.sin());
                let place = |elevation: f64| {
                    let z = DVec3::new(
                        azimuth.sin() * elevation.cos(),
                        elevation.sin(),
                        azimuth.cos() * elevation.cos(),
                    );
                    let y = z.cross(x);
                    let position = center.as_dvec3() + z * distance;
                    (y, z, position)
                };
                let mut elevation = panel.elevation.to_radians();
                let (mut y, mut z, mut position) = place(elevation);
                for _ in 0..16 {
                    if position.y - y.y.abs() * height / 2. >= ground_y as f64 + 0.02 * radius {
                        break;
                    }
                    elevation += 2f64.to_radians();
                    (y, z, position) = place(elevation);
                }
                let transform = DMat4::from_cols(
                    x.extend(0.),
                    y.extend(0.),
                    z.extend(0.),
                    position.extend(1.),
                )
                .as_mat4();
                let radiance = std::f64::consts::PI
                    * 2.
                    * self.intensity as f64
                    * panel.power
                    * panel.distance.powi(2)
                    / (panel.width * panel.height * size * size);
                let mut record = [0; wire::WORDS];
                record[wire::COLOR..wire::COLOR + 3].fill(1f32.to_bits());
                record[wire::INTENSITY] = (radiance as f32).to_bits();
                record[wire::SIZE] = (width as f32).to_bits();
                record[wire::HEIGHT_OR_INNER] = (height as f32).to_bits();
                record[wire::SPREAD_OR_OUTER] = 1f32.to_bits();
                for (i, v) in transform.to_cols_array().iter().enumerate() {
                    record[wire::TRANSFORM + i] = v.to_bits();
                }
                record
            })
            .collect()
    }
    pub fn same_ambient(&self, other: &Self) -> bool {
        self.ambient.to_bits() == other.ambient.to_bits()
            && self.ambient_color.map(f32::to_bits) == other.ambient_color.map(f32::to_bits)
    }
    pub fn pixels(&self) -> (u32, u32, Vec<f32>) {
        let mut pixels = Vec::with_capacity(64 * 32 * 4);
        for row in 0..32 {
            let y = (((row as f64 + 0.5) / 32.) * std::f64::consts::PI).cos();
            let value = if y >= 0. {
                0.6 + 0.4 * y
            } else {
                0.6 + 0.35 * y
            } as f32;
            for _ in 0..64 {
                pixels.extend(self.ambient_color.map(|c| value * self.ambient * c));
                pixels.push(1.);
            }
        }
        (64, 32, pixels)
    }
}
