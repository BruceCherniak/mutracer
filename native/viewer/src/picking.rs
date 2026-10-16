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
        let origin = camera.eye();
        let forward = (camera.target - origin).normalize();
        let right = forward.cross(Vec3::Y).normalize();
        let up = right.cross(forward);
        let half = (camera.fov.to_radians() * 0.5).tan();
        let direction = (forward
            + right * ((uv[0] * 2. - 1.) * aspect * half)
            + up * ((1. - uv[1] * 2.) * half))
            .normalize();
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
            for tri in g.indices.chunks_exact(3) {
                let vertex =
                    |i: u32| Vec3::from_slice(&g.positions[i as usize * 3..i as usize * 3 + 3]);
                let a = vertex(tri[0]);
                let e1 = vertex(tri[1]) - a;
                let e2 = vertex(tri[2]) - a;
                let p = d.cross(e2);
                let det = e1.dot(p);
                if det.abs() < 1e-20 {
                    continue;
                }
                let inv = 1. / det;
                let s = o - a;
                let u = s.dot(p) * inv;
                if !(0. ..=1.).contains(&u) {
                    continue;
                }
                let q = s.cross(e1);
                let v = d.dot(q) * inv;
                if v < 0. || u + v > 1. {
                    continue;
                }
                let distance = e2.dot(q) * inv;
                if distance > camera.radius * 0.0001 && distance < nearest {
                    nearest = distance;
                    selected = Some(id);
                }
            }
        }
        selected
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
        }];
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
