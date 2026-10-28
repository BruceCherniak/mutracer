//! Independent immutable C snapshots and original scene-resource handle mapping.
use super::*;
#[repr(C)]
#[derive(Clone, Copy)]
pub struct RayDesc {
    struct_size: u32,
    reserved: u32,
    origin: [f32; 3],
    direction: [f32; 3],
}
#[repr(C)]
#[derive(Clone, Copy)]
pub struct OptionsDesc {
    struct_size: u32,
    min_distance: f32,
    max_distance: f32,
    reserved: u32,
}
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HitDesc {
    struct_size: u32,
    instance: u32,
    primitive: u32,
    reserved: u32,
    mesh: u64,
    material: u64,
    geometry: u64,
    distance: f32,
    position: [f32; 3],
    normal: [f32; 3],
    barycentric: [f32; 3],
}
struct Snapshot {
    picker: ScenePicker,
    handles: HashMap<Resource, u64>,
}
static PICKERS: std::sync::LazyLock<Mutex<HashMap<u64, Arc<Snapshot>>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
fn get(id: u64) -> Result<Arc<Snapshot>> {
    PICKERS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&id)
        .cloned()
        .ok_or_else(invalid_handle)
}
defaults! {
 mt_scene_ray_default,RayDesc,RayDesc{struct_size:32,reserved:0,origin:[0.;3],direction:[0.,0.,-1.]};
 mt_scene_raycast_options_default,OptionsDesc,OptionsDesc{struct_size:16,min_distance:0.,max_distance:1e30,reserved:0};
 mt_scene_pick_hit_default,HitDesc,HitDesc{struct_size:80,instance:u32::MAX,primitive:0,reserved:0,mesh:0,material:0,geometry:0,distance:0.,position:[0.;3],normal:[0.;3],barycentric:[0.;3]};
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_scene_picker_create(
    scene: u64,
    out: *mut u64,
    error: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error, capacity, || {
        if out.is_null() {
            return Err(invalid("Null picker output"));
        }
        let snapshot = with_scene(scene, |e| {
            Ok(Snapshot {
                picker: e.scene.picker()?,
                handles: e.resources.iter().map(|(id, r)| (*r, *id)).collect(),
            })
        })?;
        let id = next();
        PICKERS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id, Arc::new(snapshot));
        unsafe {
            out.write(id);
        }
        Ok(())
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn mt_scene_picker_destroy(picker: u64, error: *mut c_char, capacity: usize) -> i32 {
    call(error, capacity, || {
        PICKERS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&picker)
            .ok_or_else(invalid_handle)?;
        Ok(())
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_scene_picker_raycast(
    picker: u64,
    ray: *const RayDesc,
    options: *const OptionsDesc,
    hit: *mut HitDesc,
    found: *mut u32,
    error: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error, capacity, || unsafe {
        if found.is_null() {
            return Err(invalid("Null hit-found output"));
        }
        let ray = record(ray)?;
        let old_hit = record(hit)?;
        if ray.reserved != 0 || old_hit.reserved != 0 {
            return Err(invalid("Reserved fields must be zero"));
        }
        let options = if options.is_null() {
            RaycastOptions::default()
        } else {
            let o = record(options)?;
            if o.reserved != 0 {
                return Err(invalid("Reserved fields must be zero"));
            }
            RaycastOptions {
                min_distance: o.min_distance,
                max_distance: o.max_distance,
            }
        };
        let snapshot = get(picker)?;
        let result = snapshot.picker.raycast(
            Ray {
                origin: ray.origin,
                direction: ray.direction,
            },
            options,
        )?;
        if let Some(h) = result {
            let resolve = |r| snapshot.handles.get(&r).copied().ok_or_else(invalid_handle);
            let value = HitDesc {
                struct_size: 80,
                instance: h.instance.unwrap_or(u32::MAX),
                primitive: h.primitive,
                reserved: 0,
                mesh: resolve(Resource::Mesh(h.mesh))?,
                geometry: resolve(Resource::Geometry(h.geometry))?,
                material: resolve(Resource::Material(h.material))?,
                distance: h.distance,
                position: h.position,
                normal: h.normal,
                barycentric: h.barycentric,
            };
            hit.write(value);
            found.write(1);
        } else {
            found.write(0);
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ptr::{null, null_mut};
    #[test]
    fn scene_picker_c_handles_misses_errors_and_lifetime() {
        assert_eq!(size_of::<RayDesc>(), 32);
        assert_eq!(size_of::<OptionsDesc>(), 16);
        assert_eq!(size_of::<HitDesc>(), 80);
        let mut scene = Scene::new();
        let geometry = scene
            .add_geometry(Geometry::new(
                vec![-1., -1., -2., 1., -1., -2., 0., 1., -2.],
                vec![0, 1, 2],
            ))
            .unwrap();
        let material = scene.add_material(OpenPbrMaterial::default()).unwrap();
        let mesh = scene.add_mesh(Mesh::new(geometry, material)).unwrap();
        let id = register(Entry {
            scene,
            resources: HashMap::from([
                (next(), Resource::Geometry(geometry)),
                (next(), Resource::Material(material)),
                (next(), Resource::Mesh(mesh)),
            ]),
            names: HashMap::new(),
        });
        let expected = with_scene(id, |e| {
            Ok(e.resources
                .iter()
                .map(|(id, r)| (*r, *id))
                .collect::<HashMap<_, _>>())
        })
        .unwrap();
        let mut picker = 0;
        let mut ray = RayDesc {
            struct_size: 0,
            reserved: 0,
            origin: [0.; 3],
            direction: [0.; 3],
        };
        let mut hit: HitDesc = unsafe { std::mem::zeroed() };
        let mut found = 99;
        unsafe {
            assert_eq!(mt_scene_picker_create(id, &mut picker, null_mut(), 0), 0);
            assert_eq!(mt_scene_ray_default(&mut ray), 0);
            assert_eq!(mt_scene_pick_hit_default(&mut hit), 0);
            assert_eq!(super::super::mt_scene_destroy(id, null_mut(), 0), 0);
            assert_eq!(
                mt_scene_picker_raycast(picker, &ray, null(), &mut hit, &mut found, null_mut(), 0),
                0
            );
            assert_eq!(found, 1);
            assert_eq!(hit.mesh, expected[&Resource::Mesh(mesh)]);
            assert_eq!(hit.material, expected[&Resource::Material(material)]);
            assert_eq!(hit.geometry, expected[&Resource::Geometry(geometry)]);
            assert_eq!(hit.instance, u32::MAX);
            assert_eq!(hit.distance, 2.);
            assert_eq!(hit.barycentric, [0.25, 0.25, 0.5]);
            let previous = hit;
            ray.origin[0] = 5.;
            assert_eq!(
                mt_scene_picker_raycast(picker, &ray, null(), &mut hit, &mut found, null_mut(), 0),
                0
            );
            assert_eq!(found, 0);
            assert_eq!(hit, previous);
            ray.direction = [0.; 3];
            found = 99;
            assert_eq!(
                mt_scene_picker_raycast(picker, &ray, null(), &mut hit, &mut found, null_mut(), 0),
                Status::InvalidArgument as i32
            );
            assert_eq!(found, 99);
            assert_eq!(hit, previous);
            assert_eq!(mt_scene_picker_destroy(picker, null_mut(), 0), 0);
            assert_eq!(
                mt_scene_picker_raycast(
                    picker,
                    &RayDesc {
                        direction: [0., 0., -1.],
                        ..ray
                    },
                    null(),
                    &mut hit,
                    &mut found,
                    null_mut(),
                    0
                ),
                Status::InvalidHandle as i32
            );
        }
    }
}
