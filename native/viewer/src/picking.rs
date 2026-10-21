//! Click-only geometric picking. It shares loaded geometry without GPU readback.
use crate::{renderer::Camera, scene::Model};
use glam::Vec3;
fn bounds(origin: Vec3, direction: Vec3, min: Vec3, max: Vec3, nearest: f32) -> bool {
    let mut near = 0f32;
    let mut far = nearest;
    for k in 0..3 {
        if direction[k].abs() < 1e-20 {
            if origin[k] < min[k] || origin[k] > max[k] {
                return false;
            }
        } else {
            let a = (min[k] - origin[k]) / direction[k];
            let b = (max[k] - origin[k]) / direction[k];
            near = near.max(a.min(b));
            far = far.min(a.max(b));
        }
    }
    near <= far
}
impl Model {
    pub fn pick(&self, camera: &Camera, uv: [f32; 2], aspect: f32) -> Option<usize> {
        self.pick_hit(camera, uv, aspect).map(|(id, _)| id)
    }
    pub fn pick_hit(&self, camera: &Camera, uv: [f32; 2], aspect: f32) -> Option<(usize, Vec3)> {
        let (origin, direction) = camera.ray(uv, aspect);
        let origin = origin + direction * (camera.radius * 0.0001).max(0.00001);
        let mut nearest = f32::INFINITY;
        let mut selected = None;
        for (id, mesh) in self.meshes.iter().enumerate() {
            let g = &self.geometries[mesh.geometry];
            let inverse = mesh.transform.inverse();
            let o = inverse.transform_point3(origin);
            let d = inverse.transform_vector3(direction);
            if !bounds(o, d, g.min, g.max, nearest) {
                continue;
            }
            if let Some(distance) =
                self.picking
                    .get(mesh.geometry)?
                    .intersect(o.to_array(), d.to_array(), nearest)
            {
                nearest = distance;
                selected = Some(id);
            }
        }
        selected.map(|id| (id, origin + direction * nearest))
    }
    pub fn rebuild_picking(&mut self) -> anyhow::Result<()> {
        self.picking = std::sync::Arc::new(
            self.geometries
                .iter()
                .map(|g| {
                    mutracer_native_probe::picking::PickBvh::new(&g.positions, &g.indices)
                        .map_err(anyhow::Error::msg)
                })
                .collect::<anyhow::Result<Vec<_>>>()?,
        );
        Ok(())
    }
    pub fn refresh_bounds(&mut self) {
        let mut min = Vec3::splat(f32::INFINITY);
        let mut max = Vec3::splat(f32::NEG_INFINITY);
        for id in 0..self.meshes.len() {
            let (lo, hi) = self.mesh_bounds(id);
            min = min.min(lo);
            max = max.max(hi);
        }
        self.center = (min + max) * 0.5;
        self.radius = (max - min).length() * 0.5;
    }
    pub fn mesh_bounds(&self, id: usize) -> (Vec3, Vec3) {
        let mesh = &self.meshes[id];
        let geometry = &self.geometries[mesh.geometry];
        let mut min = Vec3::splat(f32::INFINITY);
        let mut max = Vec3::splat(f32::NEG_INFINITY);
        for x in [geometry.min.x, geometry.max.x] {
            for y in [geometry.min.y, geometry.max.y] {
                for z in [geometry.min.z, geometry.max.z] {
                    let p = mesh.transform.transform_point3(Vec3::new(x, y, z));
                    min = min.min(p);
                    max = max.max(p);
                }
            }
        }
        (min, max)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::scene::{Geometry, Mesh};
    #[test]
    fn nearest_instance_is_picked_and_empty_pixels_miss() {
        let mut model = Model::load(
            &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/sample.glb"),
        )
        .unwrap();
        model.geometries = vec![Geometry {
            positions: vec![-1., -1., 0., 1., -1., 0., 0., 1., 0.],
            indices: vec![0, 1, 2],
            normals: vec![],
            uv: [vec![], vec![]],
            colors: vec![],
            tangents: vec![],
            min: Vec3::new(-1., -1., 0.),
            max: Vec3::new(1., 1., 0.),
        }]
        .into();
        model.rebuild_picking().unwrap();
        model.meshes = [0., 1.]
            .map(|z| Mesh {
                name: format!("{z}"),
                geometry: 0,
                material: 0,
                transform: glam::Mat4::from_translation(Vec3::new(0., 0., z)),
            })
            .into_iter()
            .collect();
        let mut camera = Camera::fit(Vec3::ZERO, 1.);
        camera.yaw = 0.;
        camera.pitch = 0.;
        assert_eq!(model.pick(&camera, [0.5, 0.5], 1.5), Some(1));
        assert_eq!(model.pick(&camera, [0., 0.], 1.5), None);
        model.meshes[1].transform = glam::Mat4::from_scale_rotation_translation(
            Vec3::new(-0.5, 2., 1.),
            glam::Quat::IDENTITY,
            Vec3::new(0., 0., 1.),
        );
        assert_eq!(model.pick(&camera, [0.5, 0.5], 1.5), Some(1));
    }
}

#[cfg(test)]
mod transformed_tests {
    use super::*;
    #[test]
    fn bvh_matches_world_triangle_oracle_under_mirrors_and_nonuniform_scales() {
        let mut model = Model::load(
            &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/sample.glb"),
        )
        .unwrap();
        let vertices = [
            Vec3::new(-1., -1., 0.),
            Vec3::new(1., -1., 0.),
            Vec3::new(0., 1., 0.),
        ];
        model.geometries = vec![crate::scene::Geometry {
            positions: vertices.iter().flat_map(|v| v.to_array()).collect(),
            indices: vec![0, 1, 2],
            normals: vec![],
            uv: [vec![], vec![]],
            colors: vec![],
            tangents: vec![],
            min: Vec3::new(-1., -1., 0.),
            max: Vec3::new(1., 1., 0.),
        }]
        .into();
        model.meshes = [
            (-0.4, 0.5, Vec3::new(-1.4, 0.5, 2.)),
            (0.3, -0.5, Vec3::new(0.7, 1.8, 0.3)),
        ]
        .into_iter()
        .map(|(x, z, scale)| crate::scene::Mesh {
            name: String::new(),
            geometry: 0,
            material: 0,
            transform: glam::Mat4::from_scale_rotation_translation(
                scale,
                glam::Quat::IDENTITY,
                Vec3::new(x, 0., z),
            ),
        })
        .collect();
        model.rebuild_picking().unwrap();
        let mut camera = Camera::fit(Vec3::ZERO, 2.);
        camera.yaw = 0.;
        camera.pitch = 0.;
        for orthographic in [false, true] {
            camera.orthographic = orthographic;
            for y in 0..21 {
                for x in 0..21 {
                    let uv = [x as f32 / 20., y as f32 / 20.];
                    let eye = camera.eye();
                    let f = (camera.target - eye).normalize();
                    let r = f.cross(Vec3::Y).normalize();
                    let u = r.cross(f);
                    let half = (camera.fov.to_radians() * 0.5).tan();
                    let offset = r * ((uv[0] * 2. - 1.) * half) + u * ((1. - uv[1] * 2.) * half);
                    let (eye, d) = if orthographic {
                        (eye + offset * camera.distance, f)
                    } else {
                        (eye, (f + offset).normalize())
                    };
                    let mut expected = None;
                    let mut nearest = f32::INFINITY;
                    for (id, mesh) in model.meshes.iter().enumerate() {
                        let a = mesh.transform.transform_point3(vertices[0]);
                        let b = mesh.transform.transform_point3(vertices[1]);
                        let c = mesh.transform.transform_point3(vertices[2]);
                        let e1 = b - a;
                        let e2 = c - a;
                        let p = d.cross(e2);
                        let det = e1.dot(p);
                        if det.abs() < 1e-10 {
                            continue;
                        }
                        let s = eye - a;
                        let q = s.cross(e1);
                        let u = s.dot(p) / det;
                        let v = d.dot(q) / det;
                        let t = e2.dot(q) / det;
                        if u >= 0.
                            && v >= 0.
                            && u + v <= 1.
                            && t > camera.radius * 0.0001
                            && t < nearest
                        {
                            nearest = t;
                            expected = Some(id);
                        }
                    }
                    assert_eq!(model.pick(&camera, uv, 1.), expected, "uv={uv:?}");
                }
            }
        }
    }
}
