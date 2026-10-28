use super::*;

use base64::Engine as _;
use serde_json::{Value, json};

pub(super) fn fixture(extensions: Value) -> Vec<u8> {
    let arrays: &[&[f32]] = &[
        &[-1., -1., -2., 1., -1., -2., 0., 1., -2.],
        &[0., 0., 1., 0., 0., 1., 0., 0., 1.],
        &[0., 0., 1., 0., 0.5, 1.],
        &[0.2, 0.1, 0.8, 0.1, 0.5, 0.9],
        &[1., 0., 0., 1., 1., 0., 0., 1., 1., 0., 0., 1.],
    ];
    let mut bytes = Vec::new();
    let mut views = Vec::new();
    for data in arrays {
        views.push(json!({"buffer":0,"byteOffset":bytes.len(),"byteLength":data.len()*4}));
        bytes.extend(data.iter().flat_map(|v| v.to_le_bytes()));
    }
    let images: Vec<_> = [[128,64,192,255], [64,192,128,160]].into_iter().map(|p| {
        let mut png=Vec::new();
        image::RgbaImage::from_pixel(1,1,image::Rgba(p)).write_to(&mut std::io::Cursor::new(&mut png),image::ImageFormat::Png).unwrap();
        json!({"uri":format!("data:image/png;base64,{}",base64::engine::general_purpose::STANDARD.encode(png))})
    }).collect();
    serde_json::to_vec(&json!({
        "asset":{"version":"2.0"},
        "buffers":[{"byteLength":bytes.len(),"uri":format!("data:application/octet-stream;base64,{}",base64::engine::general_purpose::STANDARD.encode(bytes))}],
        "bufferViews":views,
        "accessors":[
            {"bufferView":0,"componentType":5126,"count":3,"type":"VEC3","min":[-1,-1,-2],"max":[1,1,-2]},
            {"bufferView":1,"componentType":5126,"count":3,"type":"VEC3"},
            {"bufferView":2,"componentType":5126,"count":3,"type":"VEC2"},
            {"bufferView":3,"componentType":5126,"count":3,"type":"VEC2"},
            {"bufferView":4,"componentType":5126,"count":3,"type":"VEC4"}
        ],
        "images":images,"textures":[{"source":0},{"source":1}],
        "materials":[{"name":"test","pbrMetallicRoughness":{"baseColorFactor":[0.8,0.6,0.4,1],"metallicFactor":0.2,"roughnessFactor":0.4},"extensions":extensions}],
        "meshes":[{"primitives":[{"attributes":{"POSITION":0,"NORMAL":1,"TEXCOORD_0":2,"TEXCOORD_1":3,"TANGENT":4},"material":0}]}],
        "nodes":[{"mesh":0}],"scenes":[{"nodes":[0]}],"scene":0
    })).unwrap()
}
fn all() -> Value {
    json!({
        "KHR_materials_clearcoat":{"clearcoatFactor":0.7,"clearcoatRoughnessFactor":0.2,"clearcoatTexture":{"index":1},"clearcoatRoughnessTexture":{"index":0},"clearcoatNormalTexture":{"index":1,"scale":0.3}},
        "KHR_materials_sheen":{"sheenColorFactor":[0.1,0.3,0.6],"sheenRoughnessFactor":0.4,"sheenColorTexture":{"index":0},"sheenRoughnessTexture":{"index":1}},
        "KHR_materials_specular":{"specularFactor":0.6,"specularColorFactor":[0.5,0.7,0.9],"specularTexture":{"index":1},"specularColorTexture":{"index":0}},
        "KHR_materials_volume":{"thicknessFactor":0.5,"attenuationDistance":2,"attenuationColor":[0.8,0.6,0.4],"thicknessTexture":{"index":1}},
        "KHR_materials_iridescence":{"iridescenceFactor":0.4,"iridescenceIor":1.35,"iridescenceThicknessMinimum":120,"iridescenceThicknessMaximum":450,"iridescenceThicknessTexture":{"index":1}},
        "KHR_materials_anisotropy":{"anisotropyStrength":0.8,"anisotropyRotation":0.6,"anisotropyTexture":{"index":1}},
        "KHR_materials_dispersion":{"dispersion":0.3},
        "KHR_materials_transmission":{"transmissionFactor":0.5,"transmissionTexture":{"index":0}}
    })
}
#[test]
fn gltf_layers_and_texture_properties_survive_scene_encoding_and_edits() {
    let mut root: Value = serde_json::from_slice(&fixture(all())).unwrap();
    root["extensionsRequired"] = json!(materials::EXTENSIONS);
    let model = Model::load_bytes(&serde_json::to_vec(&root).unwrap(), None).unwrap();
    assert!(model.warnings.is_empty(), "{:?}", model.warnings);
    let mut imported = Scene::import_gltf_bytes(&serde_json::to_vec(&root).unwrap(), None).unwrap();
    let id = imported.names.materials["test"][0];
    let m = imported.scene.material(id).unwrap();
    let l = &m.values.layers;
    assert_eq!(
        (l.coat_weight, l.coat_roughness, l.coat_ior),
        (0.7, 0.2, 1.5)
    );
    assert_eq!(
        (l.fuzz_weight, l.fuzz_color, l.fuzz_roughness),
        (1., [0.1, 0.3, 0.6], 0.4)
    );
    assert_eq!(
        (l.specular_weight, l.specular_color),
        (0.6, [0.5, 0.7, 0.9])
    );
    assert!(!l.thin_walled);
    assert_eq!(
        (l.transmission_color, l.transmission_depth),
        ([0.8, 0.6, 0.4], 2.)
    );
    assert_eq!(
        (l.film_weight, l.film_ior, l.film_thickness),
        (0.4, 1.35, 0.45)
    );
    assert_eq!((l.anisotropy, l.dispersion), (0.8, 0.3));
    assert_eq!(f32::from_bits(m.properties[&62][0]), 0.12);
    assert_eq!(m.properties[&63], [1, 0, 0]);
    assert_eq!(m.properties[&30], [0, 0, 0]);
    assert_eq!(f32::from_bits(m.properties[&71][0]), 0.6);
    assert_eq!(m.properties[&75], [0.3f32.to_bits(), 0.3f32.to_bits(), 0]);
    let mut handles = Vec::new();
    for (property, pixel) in [
        (64, [64, 192, 128, 160]),
        (65, [128, 64, 192, 255]),
        (74, [64, 192, 128, 160]),
        (66, [128, 64, 192, 255]),
        (67, [64, 192, 128, 160]),
        (68, [64, 192, 128, 160]),
        (69, [128, 64, 192, 255]),
        (70, [64, 192, 128, 160]),
    ] {
        let handle = m.texture_properties[&property].unwrap();
        handles.push(handle);
        match &imported.scene.texture(handle).unwrap().pixels {
            TexturePixels::Rgba8(p) => assert_eq!(&p[..], &pixel),
            _ => panic!(),
        }
    }
    assert!(m.textures[6].is_some() && m.textures[7].is_some());
    imported.scene.descriptor().unwrap();
    // Encoding must regenerate these indices from scene handles after resource edits.
    imported.scene.texture_mut(handles[0]).unwrap().scale = [2., 3.];
    let bytes = imported.scene.descriptor().unwrap();
    crate::scene::validate(&bytes).unwrap();
    let fresh = imported
        .scene
        .next_words(None)
        .unwrap()
        .iter()
        .flat_map(|w| w.to_le_bytes())
        .collect::<Vec<_>>();
    assert_eq!(*bytes, fresh);
}
#[test]
fn gltf_defaults_metals_volume_and_explicit_approximations() {
    let values = json!({"KHR_materials_clearcoat":{},"KHR_materials_sheen":{},"KHR_materials_volume":{},"KHR_materials_iridescence":{},"KHR_materials_anisotropy":{}});
    let model = Model::load_bytes(&fixture(values), None).unwrap();
    let l = &model.materials[0].layers;
    assert_eq!((l.coat_weight, l.coat_ior), (0., 1.5));
    assert_eq!(l.fuzz_color, [0.; 3]);
    assert!(l.thin_walled);
    assert_eq!(l.transmission_depth, 0.);
    assert_eq!(
        (l.film_weight, l.film_ior, l.film_thickness),
        (0., 1.3, 0.4)
    );
    let mut root: Value = serde_json::from_slice(&fixture(all())).unwrap();
    root["materials"][0]["pbrMetallicRoughness"]["metallicFactor"] = json!(1);
    let metallic = Model::load_bytes(&serde_json::to_vec(&root).unwrap(), None).unwrap();
    assert_eq!(metallic.materials[0].layers.specular_weight, 1.);
    assert_eq!(metallic.materials[0].layers.specular_color, [1.; 3]);
    assert!(!metallic.properties[0].contains_key(&68));
    assert!(!metallic.properties[0].contains_key(&69));
    root["materials"][0]["extensions"]["KHR_materials_iridescence"]["iridescenceTexture"] =
        json!({"index":0});
    let approximate = Model::load_bytes(&serde_json::to_vec(&root).unwrap(), None).unwrap();
    assert!(
        approximate
            .warnings
            .iter()
            .any(|w| w.contains("Iridescence strength"))
    );
}
#[test]
fn gltf_generic_extension_validation_and_normal_uv_transforms() {
    for (ext, field, value) in [
        ("KHR_materials_clearcoat", "clearcoatFactor", json!(-1)),
        ("KHR_materials_sheen", "sheenColorFactor", json!([1, 2])),
        ("KHR_materials_volume", "attenuationDistance", json!(0)),
        (
            "KHR_materials_anisotropy",
            "anisotropyTexture",
            json!({"index":55}),
        ),
        (
            "KHR_materials_specular",
            "specularTexture",
            json!({"index":0,"texCoord":2}),
        ),
    ] {
        let mut ext_value = json!({});
        ext_value[ext] = json!({});
        ext_value[ext][field] = value;
        let error = Scene::import_gltf_bytes(&fixture(ext_value), None)
            .err()
            .unwrap();
        assert_eq!(error.status, Status::InvalidArgument);
        assert!(error.message.contains(field), "{}", error.message);
    }
    let mut root: Value = serde_json::from_slice(&fixture(json!({}))).unwrap();
    root["materials"][0]["normalTexture"] = json!({"index":0,"extensions":{"KHR_texture_transform":{"texCoord":1,"offset":[0.2,0.3],"scale":[2,3]}}});
    let mut model = Model::load_bytes(&serde_json::to_vec(&root).unwrap(), None).unwrap();
    let normal = model.materials[0].maps[1] as usize;
    assert_eq!(
        (
            model.textures[normal].uv,
            model.textures[normal].scale,
            model.textures[normal].offset
        ),
        (1, [2., 3.], [0.2, 0.3])
    );
    // A shared source referenced only by an extension must survive compact/replacement.
    model = Model::load_bytes(&fixture(all()), None).unwrap();
    let replacement = image::RgbaImage::from_pixel(1, 1, image::Rgba([255; 4]));
    model
        .replace_textures(0, vec![(0, Some(replacement))])
        .unwrap();
    for (&id, value) in &model.properties[0] {
        if super::model::texture_property(id) {
            assert!((value[0] as usize) < model.textures.len());
        }
    }
}

#[test]
fn gltf_browser_reference_fixture() {
    let Some(dir) = std::env::var_os("MUTRACER_GLTF_EVIDENCE") else {
        return;
    };
    let dir = std::path::PathBuf::from(dir);
    std::fs::create_dir_all(&dir).unwrap();
    let bytes = fixture(all());
    let model = Model::load_bytes(&bytes, None).unwrap();
    let mut values = crate::scene_api::encoder::material_values(&model.materials[0]);
    let schema: Vec<Value> =
        serde_json::from_str(include_str!("../../../../schemas/material-properties.json")).unwrap();
    for (&id, v) in &model.properties[0] {
        let field = &schema[id as usize - 1];
        let value = match field["type"].as_str().unwrap() {
            "float" => json!(f32::from_bits(v[0])),
            "vec2" => json!([f32::from_bits(v[0]), f32::from_bits(v[1])]),
            _ => json!(v[0]),
        };
        values.insert(field["key"].as_str().unwrap().to_owned(), value);
    }
    let mut maps = serde_json::Map::new();
    for (&id, v) in &model.properties[0] {
        if !super::model::texture_property(id) {
            continue;
        }
        let t = &model.textures[v[0] as usize];
        maps.insert(
            schema[id as usize - 1]["key"].as_str().unwrap().into(),
            json!({"pixels":t.pixels.to_vec(),"uv":t.uv,"scale":t.scale,"offset":t.offset}),
        );
    }
    for (slot, key) in [(6, "transmissionMap"), (7, "thinFilmMap")] {
        let t = &model.textures[model.materials[0].maps[slot] as usize];
        maps.insert(
            key.into(),
            json!({"pixels":t.pixels.to_vec(),"uv":t.uv,"scale":t.scale,"offset":t.offset}),
        );
    }
    std::fs::write(dir.join("layers.gltf"), bytes).unwrap();
    std::fs::write(
        dir.join("native-material.json"),
        serde_json::to_vec_pretty(&json!({"values":values,"maps":maps})).unwrap(),
    )
    .unwrap();
}

#[test]
#[ignore = "requires a real GPU; run separately"]
fn gltf_layers_render_and_retained_texture_edit_match_full() {
    use crate::api::{
        Backend, ConvergeOptions, Engine, EngineOptions, PixelKind, Render, RenderSettings,
        RenderSize,
    };
    let mut imported = Scene::import_gltf_bytes(&fixture(all()), None).unwrap();
    let env = imported
        .scene
        .add_texture(Texture {
            pixels: TexturePixels::Rgba32F(vec![0.8, 0.9, 1., 1.].into()),
            ..Texture::rgba8(1, 1, vec![])
        })
        .unwrap();
    imported
        .scene
        .set_environment(Environment {
            texture: Some(env),
            background: Some(env),
            ..Default::default()
        })
        .unwrap();
    let engine = Engine::new(EngineOptions {
        backend: Backend::Software,
    })
    .unwrap();
    let settings = RenderSettings {
        max_samples: 4,
        size: RenderSize::Fixed {
            width: 32,
            height: 24,
        },
        ..Default::default()
    };
    let render = Render::new(&engine, settings.clone()).unwrap();
    engine.set_scene_object(&imported.scene).unwrap();
    engine.update().unwrap();
    render.converge(ConvergeOptions::new(4)).unwrap();
    let before = render.read_pixels(PixelKind::Hdr).unwrap();
    assert!(before.data.iter().all(|v| v.is_finite()));
    assert!(
        render
            .read_pixels(PixelKind::Normal)
            .unwrap()
            .data
            .chunks_exact(4)
            .any(|v| v[2].abs() > 0.1),
        "no primary hits"
    );
    let mesh = MeshId(imported.scene.meshes.iter().next().unwrap().0);
    let material_id = imported.names.materials["test"][0];
    let mut aov_settings = render.settings().unwrap();
    aov_settings.aovs = PixelKind::Depth.aov_mask()
        | PixelKind::Id.aov_mask()
        | PixelKind::Roughness.aov_mask()
        | PixelKind::DiffuseAlbedo.aov_mask()
        | PixelKind::SpecularAlbedo.aov_mask();
    aov_settings.aov_samples = 4;
    render.set_settings(aov_settings).unwrap();
    render.converge(ConvergeOptions::new(4)).unwrap();
    assert_eq!(
        before,
        render.read_pixels(PixelKind::Hdr).unwrap(),
        "AOV changed glTF beauty"
    );
    let ids = render.read_pixels(PixelKind::Id).unwrap().id_data.unwrap();
    assert!(
        ids.chunks_exact(4)
            .any(|v| v[0] == mesh.aov_id() && v[2] == material_id.aov_id() && v[3] == 0)
    );
    assert!(
        render
            .read_pixels(PixelKind::Depth)
            .unwrap()
            .data
            .chunks_exact(4)
            .any(|v| v[0] > 0. && v[3] > 0.)
    );
    assert!(
        render
            .read_pixels(PixelKind::Roughness)
            .unwrap()
            .data
            .chunks_exact(4)
            .any(|p| p[2] > 0. && p[3] > 0.)
    );
    for kind in [PixelKind::DiffuseAlbedo, PixelKind::SpecularAlbedo] {
        assert!(
            render
                .read_pixels(kind)
                .unwrap()
                .data
                .chunks_exact(4)
                .all(|p| p[3] == 0.),
            "glTF unsupported layers must invalidate reflectance"
        );
    }
    let material = imported.names.materials["test"][0];
    let map = imported
        .scene
        .material(material)
        .unwrap()
        .texture_properties[&64]
        .unwrap();
    imported.scene.texture_mut(map).unwrap().pixels =
        TexturePixels::Rgba8(vec![230, 120, 80, 255].into());
    engine.set_scene_object(&imported.scene).unwrap();
    engine.update().unwrap();
    render.converge(ConvergeOptions::new(4)).unwrap();
    let edited = render.read_pixels(PixelKind::Hdr).unwrap();
    assert_ne!(
        edited.data, before.data,
        "extension texture edit has no effect"
    );
    assert_eq!(
        ids,
        render.read_pixels(PixelKind::Id).unwrap().id_data.unwrap(),
        "texture edit changed identities"
    );
    let fresh = Engine::new(EngineOptions {
        backend: Backend::Software,
    })
    .unwrap();
    fresh.set_scene_object(&imported.scene).unwrap();
    fresh.update().unwrap();
    let reference = Render::new(&fresh, settings).unwrap();
    reference.converge(ConvergeOptions::new(4)).unwrap();
    for kind in [PixelKind::Hdr, PixelKind::Normal, PixelKind::Albedo] {
        assert_eq!(
            render.read_pixels(kind).unwrap(),
            reference.read_pixels(kind).unwrap()
        );
    }
}

#[test]
fn gltf_layer_maps_environment_and_aov_identity_tables_coexist_after_edits() {
    let mut imported = Scene::import_gltf_bytes(&fixture(all()), None).unwrap();
    let mesh = MeshId(imported.scene.meshes.iter().next().unwrap().0);
    let material = imported.names.materials["test"][0];
    for settings in [
        EnvironmentSettings::default(),
        EnvironmentSettings {
            intensity: 2.,
            rotation: 0.4,
            background_intensity: 0.8,
            background_rotation: -0.3,
        },
        EnvironmentSettings::default(),
    ] {
        imported.scene.set_environment_settings(settings).unwrap();
        let bytes = imported.scene.descriptor().unwrap();
        crate::scene::validate(&bytes).unwrap();
        let words: Vec<_> = bytes
            .chunks_exact(4)
            .map(|v| u32::from_le_bytes(v.try_into().unwrap()))
            .collect();
        let objects = words[h::MESH_AOV_IDS] as usize;
        let materials = words[h::MATERIAL_AOV_IDS] as usize;
        assert_eq!(words[objects], mesh.aov_id());
        assert_eq!(words[materials], material.aov_id());
        let environment = words[h::ENVIRONMENT_SETTINGS] as usize;
        if environment != 0 {
            assert_eq!(
                [
                    words[environment],
                    words[environment + 1],
                    words[environment + 2],
                    words[environment + 3]
                ]
                .map(f32::from_bits),
                [
                    settings.intensity,
                    settings.rotation,
                    settings.background_intensity,
                    settings.background_rotation
                ]
            );
            assert!(
                environment + 4 <= objects
                    || objects + words[h::MESH_COUNT] as usize <= environment
            );
            assert!(
                environment + 4 <= materials
                    || materials + words[h::MATERIAL_COUNT] as usize <= environment
            );
        }
        let hit = imported
            .scene
            .picker()
            .unwrap()
            .raycast(Ray::default(), RaycastOptions::default())
            .unwrap()
            .unwrap();
        assert_eq!((hit.mesh, hit.material, hit.primitive), (mesh, material, 0));
        assert_eq!(
            imported
                .scene
                .material(material)
                .unwrap()
                .texture_properties
                .len(),
            8
        );
    }
}
