//! Scene construction with checked, generational handles. Arrays are shared; edits
//! take effect when the scene is passed to `Engine::set_scene_object` and updated.
#[doc(hidden)]
pub mod encoder;
use crate::api::{self, Camera, CommitKind, Result, Status};
use crate::layout::{header as h, light as l, mesh as m};
pub use encoder::{Geometry, MaterialLayers};
use glam::{Mat4, Vec3};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

static NEXT_SCENE: AtomicU64 = AtomicU64::new(1);
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
struct Key {
    owner: u64,
    index: u32,
    generation: u32,
}
macro_rules! ids { ($($id:ident),*) => {$ (
    #[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
    pub struct $id(Key);
)*}; }
ids!(GeometryId, MaterialId, TextureId, MeshId, LightId);
#[derive(Clone)]
struct Slot<T> {
    generation: u32,
    value: Option<T>,
}
struct Arena<T> {
    slots: Vec<Slot<T>>,
    owner: u64,
}
impl<T> Arena<T> {
    fn new(owner: u64) -> Self {
        Self {
            slots: Vec::new(),
            owner,
        }
    }
    fn add(&mut self, value: T) -> Key {
        if let Some((i, s)) = self
            .slots
            .iter_mut()
            .enumerate()
            .find(|(_, s)| s.value.is_none() && s.generation < u32::MAX)
        {
            s.value = Some(value);
            return Key {
                owner: self.owner,
                index: i as u32,
                generation: s.generation,
            };
        }
        let k = Key {
            owner: self.owner,
            index: self.slots.len() as u32,
            generation: 1,
        };
        self.slots.push(Slot {
            generation: 1,
            value: Some(value),
        });
        k
    }
    fn get(&self, k: Key) -> Result<&T> {
        self.slots
            .get(k.index as usize)
            .filter(|s| k.owner == self.owner && s.generation == k.generation)
            .and_then(|s| s.value.as_ref())
            .ok_or_else(invalid_handle)
    }
    fn get_mut(&mut self, k: Key) -> Result<&mut T> {
        self.slots
            .get_mut(k.index as usize)
            .filter(|s| k.owner == self.owner && s.generation == k.generation)
            .and_then(|s| s.value.as_mut())
            .ok_or_else(invalid_handle)
    }
    fn remove(&mut self, k: Key) -> Result<T> {
        self.get(k)?;
        let s = &mut self.slots[k.index as usize];
        let v = s.value.take().unwrap();
        s.generation = s.generation.saturating_add(1);
        Ok(v)
    }
    fn iter(&self) -> impl Iterator<Item = (Key, &T)> {
        self.slots.iter().enumerate().filter_map(|(i, s)| {
            s.value.as_ref().map(|v| {
                (
                    Key {
                        owner: self.owner,
                        index: i as u32,
                        generation: s.generation,
                    },
                    v,
                )
            })
        })
    }
}
fn invalid_handle() -> api::Error {
    api::error(
        Status::InvalidHandle,
        "Invalid, deleted or foreign scene handle",
    )
}
fn invalid(message: &str) -> api::Error {
    api::error(Status::InvalidArgument, message)
}

impl Geometry {
    /// Positions are XYZ and indices are triangle triples. Other attributes default absent.
    pub fn new(positions: impl Into<Arc<[f32]>>, indices: impl Into<Arc<[u32]>>) -> Self {
        let positions = positions.into();
        let mut min = Vec3::splat(f32::INFINITY);
        let mut max = Vec3::splat(f32::NEG_INFINITY);
        for p in positions.chunks_exact(3) {
            let p = Vec3::from_slice(p);
            min = min.min(p);
            max = max.max(p);
        }
        Self {
            positions,
            indices: indices.into(),
            min,
            max,
            normals: Arc::from([]),
            uv: [Arc::from([]), Arc::from([])],
            colors: Arc::from([]),
            tangents: Arc::from([]),
            material_indices: Arc::from([]),
        }
    }
}
/// OpenPBR values. Defaults: gray 0.8, roughness 0.3, IOR 1.5, opaque,
/// no emission, transmission, maps or coating; solid surfaces.
#[derive(Clone)]
pub struct OpenPbrMaterial {
    pub values: encoder::Material,
    pub textures: [Option<TextureId>; 9],
    /// Frozen material property IDs; values are three raw words (unused words zero).
    pub properties: BTreeMap<u32, [u32; 3]>,
}
impl Default for OpenPbrMaterial {
    fn default() -> Self {
        Self {
            values: encoder::Material {
                name: String::new(),
                color: [0.8; 3],
                roughness: 0.3,
                metalness: 0.,
                opacity: 1.,
                transmission: 0.,
                ior: 1.5,
                emission: [1.; 3],
                emission_strength: 0.,
                maps: [u32::MAX; 9],
                alpha_mode: 0,
                alpha_cutoff: 0.5,
                double_sided: false,
                normal_scale: 1.,
                unlit: false,
                layers: MaterialLayers {
                    thin_walled: false,
                    ..MaterialLayers::default()
                },
            },
            textures: [None; 9],
            properties: BTreeMap::new(),
        }
    }
}
/// Texture pixels are row-major RGBA. Defaults: repeat, UV0, scale 1, offset 0, no flip.
#[derive(Clone)]
pub struct Texture {
    pub pixels: TexturePixels,
    pub width: u32,
    pub height: u32,
    pub uv: u32,
    pub scale: [f32; 2],
    pub offset: [f32; 2],
    pub wrap: [u32; 2],
    pub flip_y: bool,
}
#[derive(Clone)]
pub enum TexturePixels {
    Rgba8(Arc<[u8]>),
    Rgba32F(Arc<[f32]>),
}
impl Texture {
    pub fn rgba8(width: u32, height: u32, pixels: impl Into<Arc<[u8]>>) -> Self {
        Self {
            width,
            height,
            pixels: TexturePixels::Rgba8(pixels.into()),
            uv: 0,
            scale: [1.; 2],
            offset: [0.; 2],
            wrap: [0; 2],
            flip_y: false,
        }
    }
}
/// Local instance matrices and optional RGB multipliers; default colors are white.
#[derive(Clone, Default)]
pub struct Instances {
    pub transforms: Arc<[Mat4]>,
    pub colors: Option<Arc<[f32]>>,
}
#[derive(Clone)]
pub struct Mesh {
    pub geometry: GeometryId,
    pub material: MaterialId,
    pub materials: Vec<MaterialId>,
    pub transform: Mat4,
    pub instances: Option<Instances>,
}
impl Mesh {
    /// One ordinary mesh, identity world matrix, no per-vertex material table.
    pub fn new(geometry: GeometryId, material: MaterialId) -> Self {
        Self {
            geometry,
            material,
            materials: vec![],
            transform: Mat4::IDENTITY,
            instances: None,
        }
    }
}
#[derive(Clone)]
pub enum Light {
    Rect {
        color: [f32; 3],
        intensity: f32,
        width: f32,
        height: f32,
        spread: f32,
        transform: Mat4,
        texture: Option<TextureId>,
    },
    Sphere {
        color: [f32; 3],
        intensity: f32,
        radius: f32,
        transform: Mat4,
    },
    Directional {
        color: [f32; 3],
        intensity: f32,
        transform: Mat4,
    },
    Spot {
        color: [f32; 3],
        intensity: f32,
        inner: f32,
        outer: f32,
        transform: Mat4,
        ies: Arc<[u8]>,
    },
}
/// Environment/background map handles; None disables each map. Default black,
/// opaque background and no environment. Maps use their linear pixel values.
#[derive(Clone)]
pub struct Environment {
    pub texture: Option<TextureId>,
    pub background: Option<TextureId>,
    pub color: [f32; 4],
}
impl Default for Environment {
    fn default() -> Self {
        Self {
            texture: None,
            background: None,
            color: [0., 0., 0., 1.],
        }
    }
}

#[derive(Default)]
struct Dirty {
    geometry: BTreeSet<Key>,
    material: BTreeSet<Key>,
    texture: BTreeSet<Key>,
    mesh: BTreeSet<Key>,
    light: BTreeSet<Key>,
    structure: bool,
    environment: bool,
    camera: bool,
}
struct Cache {
    bytes: Arc<Vec<u8>>,
    words: Vec<u32>,
    revision: u64,
    geometries: Vec<Geometry>,
    textures: Vec<encoder::Texture>,
}
/// A flat scene. Handles are scoped to this scene; removing referenced resources
/// returns InvalidHandle until their users are edited or removed.
pub struct Scene {
    geometries: Arena<Geometry>,
    materials: Arena<OpenPbrMaterial>,
    textures: Arena<Texture>,
    meshes: Arena<Mesh>,
    lights: Arena<Light>,
    environment: Environment,
    camera: Option<Camera>,
    dirty: Dirty,
    revision: u64,
    cache: Mutex<Option<Cache>>,
}
impl Default for Scene {
    fn default() -> Self {
        Self::new()
    }
}
impl Scene {
    pub fn new() -> Self {
        let owner = NEXT_SCENE.fetch_add(1, Ordering::Relaxed);
        Self {
            geometries: Arena::new(owner),
            materials: Arena::new(owner),
            textures: Arena::new(owner),
            meshes: Arena::new(owner),
            lights: Arena::new(owner),
            environment: Environment::default(),
            camera: None,
            dirty: Dirty {
                structure: true,
                ..Dirty::default()
            },
            revision: 1,
            cache: Mutex::new(None),
        }
    }
    fn changed(&mut self) {
        self.revision += 1;
    }
    pub fn set_environment(&mut self, environment: Environment) -> Result<()> {
        for id in [environment.texture, environment.background]
            .into_iter()
            .flatten()
        {
            self.textures.get(id.0)?;
        }
        self.environment = environment;
        self.dirty.environment = true;
        self.changed();
        Ok(())
    }
    /// Optional fallback camera, default the standard 45 degree perspective camera.
    pub fn set_default_camera(&mut self, camera: Option<Camera>) {
        self.camera = camera;
        self.dirty.camera = true;
        self.changed();
    }
}
macro_rules! resources {($($name:ident,$add:ident,$get:ident,$edit:ident,$remove:ident,$ty:ty,$id:ident,$dirty:ident);* $(;)?)=>{$(impl Scene {
    pub fn $add(&mut self,value:$ty)->Result<$id> {let k=self.$name.add(value);self.dirty.structure=true;self.changed();Ok($id(k))}
    pub fn $get(&self,id:$id)->Result<&$ty> {self.$name.get(id.0)}
    pub fn $edit(&mut self,id:$id)->Result<&mut $ty> {self.$name.get(id.0)?;self.dirty.$dirty.insert(id.0);self.changed();self.$name.get_mut(id.0)}
    pub fn $remove(&mut self,id:$id)->Result<()> {self.$name.remove(id.0)?;self.dirty.structure=true;self.changed();Ok(())}
})*};}
resources! {
 geometries,add_geometry,geometry,geometry_mut,remove_geometry,Geometry,GeometryId,geometry;
 materials,add_material,material,material_mut,remove_material,OpenPbrMaterial,MaterialId,material;
 textures,add_texture,texture,texture_mut,remove_texture,Texture,TextureId,texture;
 meshes,add_mesh,mesh,mesh_mut,remove_mesh,Mesh,MeshId,mesh;
 lights,add_light,light,light_mut,remove_light,Light,LightId,light;
}
struct Resolved {
    geometries: Vec<Geometry>,
    materials: Vec<encoder::Material>,
    textures: Vec<encoder::Texture>,
    meshes: Vec<encoder::Mesh>,
    lights: Vec<[u32; l::WORDS]>,
    ies: Vec<Arc<[u8]>>,
    properties: Vec<BTreeMap<u32, [u32; 3]>>,
    environment: Environment,
    environment_index: u32,
    background_index: u32,
}
fn index<T>(a: &Arena<T>, k: Key) -> Result<usize> {
    a.get(k)?;
    a.iter()
        .position(|(key, _)| key == k)
        .ok_or_else(invalid_handle)
}
impl Scene {
    fn resolve(&self) -> Result<Resolved> {
        for (_, g) in self.geometries.iter() {
            let vertices = g.positions.len() / 3;
            if g.positions.len() % 3 != 0
                || g.indices.len() % 3 != 0
                || [
                    (g.normals.len(), 3),
                    (g.uv[0].len(), 2),
                    (g.uv[1].len(), 2),
                    (g.colors.len(), 3),
                    (g.tangents.len(), 4),
                    (g.material_indices.len(), 1),
                ]
                .iter()
                .any(|&(len, n)| len != 0 && len != vertices * n)
            {
                return Err(invalid("Invalid geometry attribute length"));
            }
        }
        for (_, t) in self.textures.iter() {
            let pixels = match &t.pixels {
                TexturePixels::Rgba8(p) => p.len(),
                TexturePixels::Rgba32F(p) => p.len(),
            };
            if pixels as u64 != u64::from(t.width) * u64::from(t.height) * 4 {
                return Err(invalid("Invalid texture pixel length"));
            }
        }
        for (_, m) in self.meshes.iter() {
            if let Some(i) = &m.instances {
                if i.colors
                    .as_ref()
                    .is_some_and(|c| c.len() != i.transforms.len() * 3)
                {
                    return Err(invalid("Invalid instance color length"));
                }
            }
        }
        let mut r = Resolved {
            geometries: self.geometries.iter().map(|(_, g)| g.clone()).collect(),
            materials: vec![],
            textures: vec![],
            meshes: vec![],
            lights: vec![],
            ies: vec![],
            properties: vec![],
            environment: self.environment.clone(),
            environment_index: 0,
            background_index: 0,
        };
        for (_, t) in self.textures.iter() {
            let (storage, pixels, float_pixels) = match &t.pixels {
                TexturePixels::Rgba8(p) => (0, p.clone(), None),
                TexturePixels::Rgba32F(p) => (1, Arc::from([]), Some(p.clone())),
            };
            r.textures.push(encoder::Texture {
                float_pixels,
                storage,
                flip_y: t.flip_y,
                source: usize::MAX,
                width: t.width,
                height: t.height,
                pixels,
                uv: t.uv,
                scale: t.scale,
                offset: t.offset,
                wrap: t.wrap,
            });
        }
        for (_, material) in self.materials.iter() {
            let mut v = material.values.clone();
            for (slot, id) in material.textures.iter().enumerate() {
                v.maps[slot] = id
                    .map(|id| index(&self.textures, id.0))
                    .transpose()?
                    .map_or(u32::MAX, |i| i as u32);
            }
            r.materials.push(v);
            r.properties.push(material.properties.clone());
        }
        for (_, mesh) in self.meshes.iter() {
            r.meshes.push(encoder::Mesh {
                name: String::new(),
                geometry: index(&self.geometries, mesh.geometry.0)?,
                material: index(&self.materials, mesh.material.0)?,
                materials: mesh
                    .materials
                    .iter()
                    .map(|id| index(&self.materials, id.0))
                    .collect::<Result<_>>()?,
                transform: mesh.transform,
                instances: mesh.instances.clone(),
            });
        }
        for (_, light) in self.lights.iter() {
            let mut w = [0; l::WORDS];
            let mut ies = Arc::from([]);
            let (kind, color, intensity, transform) = match light {
                Light::Rect {
                    color,
                    intensity,
                    width,
                    height,
                    spread,
                    transform,
                    texture,
                } => {
                    w[l::SIZE] = width.to_bits();
                    w[l::HEIGHT_OR_INNER] = height.to_bits();
                    w[l::SPREAD_OR_OUTER] = spread.to_bits();
                    w[l::TEXTURE] = texture
                        .map(|id| index(&self.textures, id.0))
                        .transpose()?
                        .map_or(0, |i| i as u32 + 1);
                    (0, color, intensity, transform)
                }
                Light::Sphere {
                    color,
                    intensity,
                    radius,
                    transform,
                } => {
                    w[l::SIZE] = radius.to_bits();
                    (1, color, intensity, transform)
                }
                Light::Directional {
                    color,
                    intensity,
                    transform,
                } => (2, color, intensity, transform),
                Light::Spot {
                    color,
                    intensity,
                    inner,
                    outer,
                    transform,
                    ies: profile,
                } => {
                    w[l::HEIGHT_OR_INNER] = inner.to_bits();
                    w[l::SPREAD_OR_OUTER] = outer.to_bits();
                    ies = profile.clone();
                    (3, color, intensity, transform)
                }
            };
            w[l::TYPE] = kind;
            w[l::INTENSITY] = intensity.to_bits();
            for i in 0..3 {
                w[l::COLOR + i] = color[i].to_bits();
            }
            for (i, v) in transform.to_cols_array().iter().enumerate() {
                w[l::TRANSFORM + i] = v.to_bits();
            }
            r.lights.push(w);
            r.ies.push(ies);
        }
        r.environment_index = self
            .environment
            .texture
            .map(|id| index(&self.textures, id.0))
            .transpose()?
            .map_or(0, |i| i as u32 + 1);
        r.background_index = self
            .environment
            .background
            .map(|id| index(&self.textures, id.0))
            .transpose()?
            .map_or(0, |i| i as u32 + 1);
        Ok(r)
    }
    fn next_words(&self, previous: Option<&[u32]>) -> Result<Vec<u32>> {
        let mut words = previous.unwrap_or(&[]).to_vec();
        self.encode_into(&mut words, None)?;
        Ok(words)
    }
    fn encode_into(
        &self,
        words: &mut Vec<u32>,
        previous: Option<(&[Geometry], &[encoder::Texture])>,
    ) -> Result<()> {
        let r = self.resolve()?;
        let camera = self.camera.unwrap_or_default().to_bytes();
        let env = encoder::Environment {
            enabled: false,
            width: 0,
            height: 0,
            pixels: Arc::from([]),
            background: false,
            background_color: [
                r.environment.color[0],
                r.environment.color[1],
                r.environment.color[2],
            ],
            background_alpha: r.environment.color[3],
        };
        let data = encoder::SceneData {
            properties: &r.properties,
            geometries: &r.geometries,
            materials: &r.materials,
            textures: &r.textures,
            meshes: &r.meshes,
            lights: r.lights.clone(),
            ies: r.ies.clone(),
        };
        if !data.patch_selected(words, &camera, [1, 1], &env, previous) {
            *words = data.encode(&camera, [1, 1], &env);
        }
        words[h::ENVIRONMENT_TEXTURE] = r.environment_index;
        words[h::BACKGROUND_TEXTURE] = r.background_index;
        Ok(())
    }
    /// Encodes an immutable snapshot. Repeated calls without edits share one buffer.
    pub fn descriptor(&self) -> Result<Arc<Vec<u8>>> {
        let mut cache = self.cache.lock().unwrap();
        if let Some(c) = &*cache {
            if c.revision == self.revision {
                return Ok(c.bytes.clone());
            }
        }
        let mut words = cache
            .as_mut()
            .map(|c| std::mem::take(&mut c.words))
            .unwrap_or_default();
        if let Err(e) = self.encode_into(
            &mut words,
            cache
                .as_ref()
                .map(|c| (c.geometries.as_slice(), c.textures.as_slice())),
        ) {
            if let Some(c) = cache.as_mut() {
                c.words = c
                    .bytes
                    .chunks_exact(4)
                    .map(|b| u32::from_le_bytes(b.try_into().unwrap()))
                    .collect();
            }
            return Err(e);
        }
        let mut bytes = cache
            .as_mut()
            .and_then(|c| Arc::get_mut(&mut c.bytes))
            .map(std::mem::take)
            .unwrap_or_default();
        bytes.clear();
        bytes.extend(words.iter().flat_map(|w| w.to_le_bytes()));
        crate::scene::validate(&bytes)
            .map_err(|e| api::error(Status::InvalidArgument, e.to_string()))?;
        let r = self.resolve()?;
        let bytes = Arc::new(bytes);
        *cache = Some(Cache {
            bytes: bytes.clone(),
            words,
            revision: self.revision,
            geometries: r.geometries,
            textures: r.textures,
        });
        Ok(bytes)
    }
    /// Predicts the next descriptor commit using the retained update planner.
    /// Full is returned before the first snapshot; the engine reports the actual result.
    pub fn pending_commit_kind(&self) -> Result<CommitKind> {
        let cache = self.cache.lock().unwrap();
        let Some(c) = &*cache else {
            return Ok(CommitKind::Full);
        };
        if c.revision == self.revision {
            return Ok(CommitKind::Incremental);
        }
        let next = self.next_words(Some(&c.words))?;
        let bytes: Vec<u8> = next.iter().flat_map(|w| w.to_le_bytes()).collect();
        crate::scene::validate(&bytes).map_err(|e| invalid(&e.to_string()))?;
        Ok(predict(&c.bytes, &bytes))
    }
}
fn predict(previous: &[u8], next: &[u8]) -> CommitKind {
    let a: Vec<u32> = previous
        .chunks_exact(4)
        .map(|b| u32::from_le_bytes(b.try_into().unwrap()))
        .collect();
    let b: Vec<u32> = next
        .chunks_exact(4)
        .map(|b| u32::from_le_bytes(b.try_into().unwrap()))
        .collect();
    if [h::GEOMETRY_COUNT, h::MESH_COUNT, h::MATERIAL_COUNT]
        .iter()
        .any(|&i| a[i] != b[i])
    {
        return CommitKind::Full;
    }
    let n = b[h::MESH_COUNT] as usize;
    let mut structural = false;
    for i in 0..n {
        let ao = a[h::MESH_OFFSET] as usize + i * m::WORDS;
        let bo = b[h::MESH_OFFSET] as usize + i * m::WORDS;
        if a[ao..ao + 4] != b[bo..bo + 4] {
            structural = true;
        }
    }
    let sync = crate::scene::SceneSync {
        meshes: if structural { 2 } else { 1 },
        lights: true,
        background: true,
        camera: true,
        resolution: false,
        quality: false,
        transforms: (0..n).collect(),
        colors: vec![],
        geometries: (0..b[h::GEOMETRY_COUNT] as usize).collect(),
        materials: (0..b[h::MATERIAL_COUNT] as usize).collect(),
    };
    if crate::commit_plan::plan(previous, next, &sync, true).is_some() {
        CommitKind::Incremental
    } else {
        CommitKind::Full
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn triangle() -> (Scene, MeshId) {
        let mut s = Scene::new();
        let g = s
            .add_geometry(Geometry::new(
                vec![-1., 0., 0., 1., 0., 0., 0., 1., 0.],
                vec![0, 1, 2],
            ))
            .unwrap();
        let m = s.add_material(OpenPbrMaterial::default()).unwrap();
        let mesh = s.add_mesh(Mesh::new(g, m)).unwrap();
        (s, mesh)
    }
    #[test]
    fn handles_are_typed_generational_and_scene_scoped() {
        let (mut s, mesh) = triangle();
        let old = s.mesh(mesh).unwrap().geometry;
        s.remove_geometry(old).unwrap();
        assert_eq!(s.descriptor().unwrap_err().status, Status::InvalidHandle);
        let new = s
            .add_geometry(Geometry::new(vec![0.; 9], vec![0, 1, 2]))
            .unwrap();
        assert_ne!(old, new);
        assert_eq!(s.geometry(old).err().unwrap().status, Status::InvalidHandle);
        let other = Scene::new();
        assert_eq!(
            other.geometry(new).err().unwrap().status,
            Status::InvalidHandle
        );
    }
    #[test]
    fn cached_encoding_and_incremental_edits_match_full_encoder() {
        let (mut s, mesh) = triangle();
        assert_eq!(s.pending_commit_kind().unwrap(), CommitKind::Full);
        let initial = s.descriptor().unwrap();
        assert!(Arc::ptr_eq(&initial, &s.descriptor().unwrap()));
        s.mesh_mut(mesh).unwrap().transform = Mat4::from_translation(Vec3::new(0.2, 0., 0.));
        assert_eq!(s.pending_commit_kind().unwrap(), CommitKind::Incremental);
        let patched = s.descriptor().unwrap();
        let full = s
            .next_words(None)
            .unwrap()
            .iter()
            .flat_map(|w| w.to_le_bytes())
            .collect::<Vec<_>>();
        assert_eq!(*patched, full);
        let g = s.mesh(mesh).unwrap().geometry;
        Arc::make_mut(&mut s.geometry_mut(g).unwrap().positions)[0] -= 0.1;
        assert_eq!(s.pending_commit_kind().unwrap(), CommitKind::Incremental);
        s.descriptor().unwrap();
        let m = s.mesh(mesh).unwrap().material;
        s.material_mut(m).unwrap().values.roughness = 0.7;
        assert_eq!(s.pending_commit_kind().unwrap(), CommitKind::Incremental);
        s.descriptor().unwrap();
        let g = s.geometry_mut(g).unwrap();
        g.indices = vec![2, 1, 0].into();
        assert_eq!(s.pending_commit_kind().unwrap(), CommitKind::Full);
    }
    #[test]
    fn synthetic_records_and_patch_match_full() {
        let (mut s, mesh) = triangle();
        let texture = s.add_texture(Texture::rgba8(1, 1, vec![255; 4])).unwrap();
        let m = s.mesh(mesh).unwrap().material;
        s.material_mut(m).unwrap().textures[0] = Some(texture);
        let hdr = s
            .add_texture(Texture {
                pixels: TexturePixels::Rgba32F(vec![1.; 4].into()),
                ..Texture::rgba8(1, 1, vec![])
            })
            .unwrap();
        s.set_environment(Environment {
            texture: Some(hdr),
            background: Some(hdr),
            ..Environment::default()
        })
        .unwrap();
        let mat2 = s.add_material(OpenPbrMaterial::default()).unwrap();
        s.mesh_mut(mesh).unwrap().materials = vec![m, mat2];
        let geo = s.mesh(mesh).unwrap().geometry;
        s.geometry_mut(geo).unwrap().material_indices = vec![0, 1, 0].into();
        s.geometry_mut(geo).unwrap().uv[0] = vec![0.; 6].into();
        s.mesh_mut(mesh).unwrap().instances = Some(Instances {
            transforms: vec![Mat4::IDENTITY, Mat4::from_translation(Vec3::X)].into(),
            colors: Some(vec![1.; 6].into()),
        });
        for light in [
            Light::Rect {
                color: [1.; 3],
                intensity: 1.,
                width: 1.,
                height: 1.,
                spread: 1.,
                transform: Mat4::IDENTITY,
                texture: Some(texture),
            },
            Light::Sphere {
                color: [1.; 3],
                intensity: 1.,
                radius: 0.5,
                transform: Mat4::IDENTITY,
            },
            Light::Directional {
                color: [1.; 3],
                intensity: 1.,
                transform: Mat4::IDENTITY,
            },
            Light::Spot {
                color: [1.; 3],
                intensity: 1.,
                inner: 10.,
                outer: 30.,
                transform: Mat4::IDENTITY,
                ies: Arc::from([]),
            },
        ] {
            s.add_light(light).unwrap();
        }
        s.descriptor().unwrap();
        s.texture_mut(texture).unwrap().scale = [2., 3.];
        let a = s.descriptor().unwrap();
        let b = s
            .next_words(None)
            .unwrap()
            .iter()
            .flat_map(|w| w.to_le_bytes())
            .collect::<Vec<_>>();
        assert_eq!(*a, b);
    }
}
mod descriptor;
#[cfg(test)]
mod gpu_tests;
pub use descriptor::Descriptor;
