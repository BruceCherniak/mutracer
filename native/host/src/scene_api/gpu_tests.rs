use super::*;
use crate::api::{
    Backend, ConvergeOptions, Engine, EngineOptions, PixelKind, Render, RenderSettings, RenderSize,
};
#[test]
#[ignore = "requires a real GPU; run separately"]
fn software_scene_object_incremental_matches_full() {
    let mut s = Scene::new();
    let g = s
        .add_geometry(Geometry::new(
            vec![-1., -1., 0., 1., -1., 0., 0., 1., 0.],
            vec![0, 1, 2],
        ))
        .unwrap();
    s.geometry_mut(g).unwrap().uv[0] = vec![0., 0., 1., 0., 0.5, 1.].into();
    let t = s
        .add_texture(Texture::rgba8(1, 1, vec![255, 200, 150, 255]))
        .unwrap();
    let mut material = OpenPbrMaterial::default();
    material.textures[0] = Some(t);
    let mat = s.add_material(material).unwrap();
    let mesh = s.add_mesh(Mesh::new(g, mat)).unwrap();
    let hdr = s
        .add_texture(Texture {
            pixels: TexturePixels::Rgba32F(vec![0.4, 0.5, 0.6, 1.].into()),
            ..Texture::rgba8(1, 1, vec![])
        })
        .unwrap();
    s.set_environment(Environment {
        texture: Some(hdr),
        background: Some(hdr),
        ..Environment::default()
    })
    .unwrap();
    let light = s
        .add_light(Light::Directional {
            color: [1.; 3],
            intensity: 2.,
            transform: Mat4::IDENTITY,
        })
        .unwrap();
    s.mesh_mut(mesh).unwrap().instances = Some(Instances {
        transforms: vec![
            Mat4::IDENTITY,
            Mat4::from_translation(Vec3::new(0.3, 0., -0.2)),
        ]
        .into(),
        colors: Some(vec![1.; 6].into()),
    });
    let ies: Arc<[u8]> =
        b"IESNA:LM-63-2002\nTILT=NONE\n1 1000 1 3 1 1 2 0 0 0 1 1 20\n0 45 90\n0\n100 50 0\n"
            .as_slice()
            .into();
    let spot = s
        .add_light(Light::Spot {
            color: [1.; 3],
            intensity: 1.,
            inner: 10.,
            outer: 30.,
            transform: Mat4::from_translation(Vec3::new(0., 0., 2.)),
            ies: ies.clone(),
        })
        .unwrap();
    let mut camera = Camera::default();
    camera.world_matrix[14] = 3.;
    s.set_default_camera(Some(camera));
    let engine = Engine::new(EngineOptions {
        backend: Backend::Software,
    })
    .unwrap();
    let settings = RenderSettings {
        max_samples: 8,
        size: RenderSize::Fixed {
            width: 32,
            height: 24,
        },
        ..Default::default()
    };
    let render = Render::new(&engine, settings.clone()).unwrap();
    engine.set_scene_object(&s).unwrap();
    engine.update().unwrap();
    render.converge(ConvergeOptions::new(8)).unwrap();
    for edit in 0..16 {
        match edit {
            0 => s.material_mut(mat).unwrap().values.roughness = 0.6,
            1 => {
                s.mesh_mut(mesh).unwrap().transform = Mat4::from_translation(Vec3::new(0.1, 0., 0.))
            }
            2 => {
                Arc::make_mut(&mut s.geometry_mut(g).unwrap().positions)[0] -= 0.2;
            }
            3 => s.texture_mut(t).unwrap().scale = [2., 3.],
            4 => {
                s.texture_mut(t).unwrap().pixels =
                    TexturePixels::Rgba8(vec![150, 200, 255, 255].into())
            }
            5 => {
                *s.light_mut(light).unwrap() = Light::Directional {
                    color: [1., 0.8, 0.7],
                    intensity: 3.,
                    transform: Mat4::IDENTITY,
                }
            }
            6 => {
                s.add_light(Light::Sphere {
                    color: [1.; 3],
                    intensity: 1.,
                    radius: 0.1,
                    transform: Mat4::from_translation(Vec3::new(0., 1., 2.)),
                })
                .unwrap();
            }
            7 => s.remove_light(light).unwrap(),
            8 => {
                s.texture_mut(hdr).unwrap().pixels =
                    TexturePixels::Rgba32F(vec![0.7, 0.5, 0.2, 1.].into())
            }
            9 => {
                camera.fov = 50.;
                s.set_default_camera(Some(camera));
            }
            10 => {
                let i = s.mesh_mut(mesh).unwrap().instances.as_mut().unwrap();
                Arc::make_mut(&mut i.transforms)[1] =
                    Mat4::from_translation(Vec3::new(0.4, 0., -0.2));
            }
            11 => {
                let i = s.mesh_mut(mesh).unwrap().instances.as_mut().unwrap();
                Arc::make_mut(i.colors.as_mut().unwrap())[0] = 0.6;
            }
            12 => {
                let t = s.texture_mut(hdr).unwrap();
                t.width = 2;
                t.pixels =
                    TexturePixels::Rgba32F(vec![0.4, 0.5, 0.6, 1., 0.7, 0.8, 0.9, 1.].into());
            }
            13 => {
                *s.light_mut(spot).unwrap() = Light::Spot {
                    color: [0.8, 1., 0.9],
                    intensity: 2.,
                    inner: 12.,
                    outer: 40.,
                    transform: Mat4::from_translation(Vec3::new(0., 0., 2.)),
                    ies: ies.clone(),
                };
            }
            14 => {
                s.set_environment(Environment {
                    texture: Some(hdr),
                    background: Some(hdr),
                    color: [0.1, 0.2, 0.3, 1.],
                })
                .unwrap();
            }
            15 => s.material_mut(mat).unwrap().values.emission_strength = 2.,
            _ => unreachable!(),
        }
        let expected = if edit == 15 {
            CommitKind::Full
        } else {
            CommitKind::Incremental
        };
        assert_eq!(
            s.pending_commit_kind().unwrap(),
            expected,
            "edit {edit} prediction"
        );
        engine.set_scene_object(&s).unwrap();
        engine.update().unwrap();
        render.converge(ConvergeOptions::new(8)).unwrap();
        assert_eq!(
            render.last_commit().unwrap(),
            Some(expected),
            "edit {edit} actual"
        );
        let fresh = Engine::new(EngineOptions {
            backend: Backend::Software,
        })
        .unwrap();
        let reference = Render::new(&fresh, settings.clone()).unwrap();
        fresh.set_scene_object(&s).unwrap();
        fresh.update().unwrap();
        reference.converge(ConvergeOptions::new(8)).unwrap();
        for kind in [PixelKind::Hdr, PixelKind::Normal, PixelKind::Albedo] {
            let a = render.read_pixels(kind).unwrap();
            let b = reference.read_pixels(kind).unwrap();
            assert_eq!(
                a.data.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
                b.data.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
                "edit {edit} {kind:?}"
            );
        }
    }
}

#[test]
#[ignore = "requires a real GPU; run separately"]
fn software_displacement_map_edits_match_prediction() {
    for scale in [0.1, 0.] {
        let mut s = Scene::new();
        let g = s
            .add_geometry(Geometry::new(
                vec![-1., -1., 0., 1., -1., 0., 0., 1., 0.],
                vec![0, 1, 2],
            ))
            .unwrap();
        s.geometry_mut(g).unwrap().uv[0] = vec![0., 0., 1., 0., 0.5, 1.].into();
        let color = s
            .add_texture(Texture::rgba8(1, 1, vec![255, 200, 150, 255]))
            .unwrap();
        let height = s.add_texture(Texture::rgba8(1, 1, vec![128; 4])).unwrap();
        let mut material = OpenPbrMaterial::default();
        material.textures[0] = Some(color);
        material.textures[8] = Some(height);
        material.values.layers.displacement_scale = scale;
        let mat = s.add_material(material).unwrap();
        s.add_mesh(Mesh::new(g, mat)).unwrap();
        s.add_light(Light::Directional {
            color: [1.; 3],
            intensity: 2.,
            transform: Mat4::IDENTITY,
        })
        .unwrap();
        let mut camera = Camera::default();
        camera.world_matrix[14] = 3.;
        s.set_default_camera(Some(camera));
        let engine = Engine::new(EngineOptions {
            backend: Backend::Software,
        })
        .unwrap();
        let render = Render::new(
            &engine,
            RenderSettings {
                max_samples: 4,
                size: RenderSize::Fixed {
                    width: 16,
                    height: 12,
                },
                ..Default::default()
            },
        )
        .unwrap();
        engine.set_scene_object(&s).unwrap();
        engine.update().unwrap();
        render.converge(ConvergeOptions::new(4)).unwrap();
        for edit in 0..3 {
            let expected = match edit {
                0 => {
                    s.texture_mut(color).unwrap().pixels =
                        TexturePixels::Rgba8(vec![100, 150, 200, 255].into());
                    CommitKind::Incremental
                }
                1 => {
                    s.texture_mut(height).unwrap().pixels =
                        TexturePixels::Rgba8(vec![200; 4].into());
                    CommitKind::Full
                }
                2 => {
                    s.texture_mut(height).unwrap().scale = [2., 2.];
                    CommitKind::Full
                }
                _ => unreachable!(),
            };
            assert_eq!(
                s.pending_commit_kind().unwrap(),
                expected,
                "scale {scale} edit {edit} prediction"
            );
            engine.set_scene_object(&s).unwrap();
            engine.update().unwrap();
            render.converge(ConvergeOptions::new(4)).unwrap();
            assert_eq!(
                render.last_commit().unwrap(),
                Some(expected),
                "scale {scale} edit {edit} actual"
            );
        }
    }
}
