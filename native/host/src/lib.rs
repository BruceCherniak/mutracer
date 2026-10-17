//! Headless native experiments for raw descriptors and prepared MuTracer scenes.
//! Blocking probes and persistent contexts expose experimental subsets of MuTracer.
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    ffi::{CStr, c_char},
    fs,
    path::Path,
    sync::{Arc, Mutex, mpsc},
    time::{Duration, Instant},
};
use wgpu::util::DeviceExt;
pub mod context;
pub mod denoise;
mod denoise_ffi;
mod hardware;
pub mod hit_diagnostics;
mod material_properties;
mod native_bvh;
pub mod path_diagnostics;
mod profiling;
mod scene;
mod tinybvh;

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

unsafe extern "C" {
    fn mt_core_init();
    fn mt_core_reset();
    fn mt_core_collect();
    fn mt_core_frame(
        sample: f64,
        bounces: f64,
        seed: u32,
        output: *mut *const u8,
        size: *mut usize,
    );
    fn mt_core_camera(
        bytes: *const u8,
        length: usize,
        x: f64,
        y: f64,
        z: f64,
        output: *mut *const u8,
        size: *mut usize,
    );
    fn mt_core_material(
        r: f64,
        g: f64,
        b: f64,
        roughness: f64,
        output: *mut *const u8,
        size: *mut usize,
    );
    fn mt_core_sampling(input: *const u8, length: usize, output: *mut *const u8, size: *mut usize);
}
// scriptc init initializes module globals on every invocation. Initialize once
// so a later GPU upload/context cannot erase another scene's rooted TS state.
fn init_core() {
    static INITIALIZED: std::sync::Once = std::sync::Once::new();
    INITIALIZED.call_once(|| unsafe { mt_core_init() });
}
// scriptc state is confined to one dedicated owner for this initial probe.
// No worker thread calls into it; the mutex also rejects overlapping C entry.
static ENTRY_LOCK: Mutex<()> = Mutex::new(());
// ABI tests share process-global AOT/registry state even on Rust's test workers.
#[cfg(test)]
static ABI_TEST_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Scene {
    format: u32,
    width: u32,
    height: u32,
    samples: u32,
    shader: String,
    entry_point: String,
    buffers: Vec<Buffer>,
    textures: Vec<Texture>,
    samplers: Vec<Value>,
    bind_groups: Vec<Group>,
    rt_uniform: usize,
    color_output: usize,
    normal_output: Option<usize>,
    albedo_output: Option<usize>,
    camera_uniform: Option<usize>,
    material_buffer: Option<usize>,
    material_count: Option<u32>,
    material_stride: Option<u64>,
    material_offsets: Option<MaterialOffsets>,
    hwrt: Option<hardware::Capture>,
    native_layout: Option<hardware::NativeLayout>,
    native_bvh: Option<native_bvh::Capture>,
    sampling: Option<Sampling>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Sampling {
    max_samples: u32,
    pattern: String,
}
#[derive(Clone, Deserialize)]
struct MaterialOffsets {
    color: u64,
    roughness: u64,
}

/// Experimental C descriptor; flags 1=camera, 2=material patch, 4=authoritative HWRT.
#[repr(C)]
#[derive(Clone, Copy, serde::Serialize)]
pub struct RenderOptions {
    pub struct_size: u32,
    pub flags: u32,
    pub samples: u32,
    pub seed: u32,
    pub bounces: f32,
    pub camera_offset: [f32; 3],
    pub material_index: u32,
    pub base_color: [f32; 3],
    pub roughness: f32,
}
impl Default for RenderOptions {
    fn default() -> Self {
        Self {
            struct_size: std::mem::size_of::<Self>() as u32,
            flags: 0,
            samples: 0,
            seed: 12345,
            bounces: 6.0,
            camera_offset: [0.0; 3],
            material_index: 0,
            base_color: [0.5; 3],
            roughness: 0.5,
        }
    }
}
fn validate_options(options: &RenderOptions) -> Result<()> {
    if options.struct_size != std::mem::size_of::<RenderOptions>() as u32 {
        return Err("Render options size mismatch".into());
    }
    if options.flags & !7 != 0 {
        return Err("Unknown render options flags".into());
    }
    if !options.bounces.is_finite() {
        return Err("Non-finite bounce count".into());
    }
    if options.flags & 1 != 0 && !options.camera_offset.iter().all(|v| v.is_finite()) {
        return Err("Non-finite camera translation".into());
    }
    if options.flags & 2 != 0
        && (!options
            .base_color
            .iter()
            .all(|v| v.is_finite() && (0.0..=1.0).contains(v))
            || !options.roughness.is_finite()
            || !(0.0..=1.0).contains(&options.roughness))
    {
        return Err("Material values must be finite and in 0..1".into());
    }
    Ok(())
}

unsafe fn copy_core_result(pointer: *const u8, size: usize, expected: usize) -> Result<Vec<u8>> {
    if pointer.is_null() || size != expected {
        return Err("Invalid AOT command length".into());
    }
    let bytes = unsafe { std::slice::from_raw_parts(pointer, size) }.to_vec();
    unsafe {
        mt_core_reset();
    }
    Ok(bytes)
}
#[derive(Clone, Deserialize)]
struct Buffer {
    id: usize,
    size: u64,
    usage: u32,
    file: String,
}
#[derive(Clone, Deserialize)]
struct Texture {
    id: usize,
    width: u32,
    height: u32,
    depth: u32,
    format: String,
    usage: u32,
    writes: Vec<Value>,
}
#[derive(Clone, Deserialize)]
struct Group {
    layout: Vec<Value>,
    entries: Vec<Binding>,
}
#[derive(Clone, Deserialize)]
struct Binding {
    binding: u32,
    kind: String,
    id: usize,
}

fn number(value: &Value, key: &str, default: u32) -> u32 {
    value
        .get(key)
        .and_then(Value::as_u64)
        .map(|v| v as u32)
        .unwrap_or(default)
}
fn extent(value: &Value, default_depth: u32) -> wgpu::Extent3d {
    if value.is_array() {
        wgpu::Extent3d {
            width: value[0].as_u64().unwrap() as u32,
            height: value[1].as_u64().unwrap_or(1) as u32,
            depth_or_array_layers: value[2].as_u64().unwrap_or(default_depth as u64) as u32,
        }
    } else {
        wgpu::Extent3d {
            width: number(value, "width", 1),
            height: number(value, "height", 1),
            depth_or_array_layers: number(value, "depthOrArrayLayers", default_depth),
        }
    }
}
fn layout_entry(entry: &Value) -> wgpu::BindGroupLayoutEntry {
    let ty = if let Some(buffer) = entry.get("buffer") {
        wgpu::BindingType::Buffer {
            ty: match buffer["type"].as_str().unwrap_or("uniform") {
                "uniform" => wgpu::BufferBindingType::Uniform,
                "storage" => wgpu::BufferBindingType::Storage { read_only: false },
                "read-only-storage" => wgpu::BufferBindingType::Storage { read_only: true },
                other => panic!("Unsupported buffer layout: {other}"),
            },
            has_dynamic_offset: false,
            min_binding_size: None,
        }
    } else if let Some(texture) = entry.get("texture") {
        wgpu::BindingType::Texture {
            sample_type: wgpu::TextureSampleType::Float {
                filterable: texture["sampleType"].as_str() != Some("unfilterable-float"),
            },
            view_dimension: if texture["viewDimension"] == "2d-array" {
                wgpu::TextureViewDimension::D2Array
            } else {
                wgpu::TextureViewDimension::D2
            },
            multisampled: false,
        }
    } else if entry.get("sampler").is_some() {
        wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering)
    } else {
        panic!("Unsupported binding layout: {entry}")
    };
    wgpu::BindGroupLayoutEntry {
        binding: number(entry, "binding", 0),
        visibility: wgpu::ShaderStages::COMPUTE,
        ty,
        count: None,
    }
}

// Return sample-averaged RGBA, preserving the capture's bottom-row-first layout.
fn read_average(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    buffer: &wgpu::Buffer,
    width: u32,
    height: u32,
    samples: u32,
) -> Result<Vec<u8>> {
    let readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("MuTracer native HDR readback"),
        size: width as u64 * height as u64 * 16,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
    encoder.copy_buffer_to_buffer(buffer, 0, &readback, 0, readback.size());
    queue.submit([encoder.finish()]);
    let (sender, receiver) = mpsc::channel();
    readback
        .slice(..)
        .map_async(wgpu::MapMode::Read, move |result| {
            let _ = sender.send(result);
        });
    device.poll(wgpu::PollType::Wait {
        submission_index: None,
        timeout: Some(Duration::from_secs(30)),
    })?;
    receiver.recv_timeout(Duration::from_secs(5))??;
    let mapped = readback.slice(..).get_mapped_range()?;
    let mut values = Vec::with_capacity(mapped.len());
    for channel in mapped.chunks_exact(4) {
        let value = f32::from_le_bytes(channel.try_into()?) / samples as f32;
        if !value.is_finite() {
            return Err("Non-finite native output".into());
        }
        values.extend_from_slice(&value.to_le_bytes());
    }
    Ok(values)
}

pub fn render(scene_dir: &Path, output: &Path, requested_samples: u32) -> Result<()> {
    render_options(
        scene_dir,
        output,
        &RenderOptions {
            samples: requested_samples,
            ..Default::default()
        },
    )
}

pub fn render_options(scene_dir: &Path, output: &Path, options: &RenderOptions) -> Result<()> {
    validate_options(options)?;
    let _entry = ENTRY_LOCK
        .try_lock()
        .map_err(|_| "Native probe is already active or poisoned")?;
    context::check_owner()?;
    let scene: Scene = serde_json::from_slice(&fs::read(scene_dir.join("scene.json"))?)?;
    render_scene(scene_dir, scene, output, options, None)
}

// Device-local keys compare the full source/layout as well as hashing them, so
// collisions cannot reuse an incompatible shader. Keep retained variants bounded.
#[derive(Hash, PartialEq, Eq)]
struct PipelineKey {
    source: String,
    entry: String,
    layout: String,
    hardware: bool,
}
#[derive(Clone)]
struct CachedPipeline {
    _shader: wgpu::ShaderModule,
    layouts: Vec<wgpu::BindGroupLayout>,
    pipeline: wgpu::ComputePipeline,
}
#[derive(Clone)]
struct GpuDevice {
    device: wgpu::Device,
    queue: wgpu::Queue,
    info: wgpu::AdapterInfo,
    hardware_ray_query: bool,
    pipelines: Arc<Mutex<HashMap<PipelineKey, CachedPipeline>>>,
    pipeline_cache: Option<wgpu::PipelineCache>,
}
impl GpuDevice {
    fn new(use_hwrt: bool) -> Result<Self> {
        Self::with_backend(if use_hwrt { 1 } else { 0 })
    }
    fn with_backend(mode: u32) -> Result<Self> {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            force_fallback_adapter: false,
            compatible_surface: None,
            ..Default::default()
        }))?;
        let info = adapter.get_info();
        eprintln!(
            "Native adapter: {} ({:?}, {:?})",
            info.name, info.backend, info.device_type
        );
        let hardware_ray_query = adapter
            .features()
            .contains(wgpu::Features::EXPERIMENTAL_RAY_QUERY);
        let use_hwrt = mode != 0 && hardware_ray_query;
        let profile_features = if profiling::gpu_enabled() {
            adapter.features()
                & (wgpu::Features::TIMESTAMP_QUERY
                    | wgpu::Features::TIMESTAMP_QUERY_INSIDE_ENCODERS)
        } else {
            wgpu::Features::empty()
        };
        let cache_feature = if info.backend == wgpu::Backend::Vulkan {
            adapter.features() & wgpu::Features::PIPELINE_CACHE
        } else {
            wgpu::Features::empty()
        };
        let (device, queue) =
            pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
                label: Some("MuTracer native feasibility"),
                required_limits: adapter.limits(),
                required_features: profile_features
                    | cache_feature
                    | if use_hwrt {
                        wgpu::Features::EXPERIMENTAL_RAY_QUERY
                    } else {
                        wgpu::Features::empty()
                    },
                experimental_features: if use_hwrt {
                    unsafe { wgpu::ExperimentalFeatures::enabled() }
                } else {
                    wgpu::ExperimentalFeatures::disabled()
                },
                ..Default::default()
            }))?;
        if profiling::gpu_enabled() {
            eprintln!(
                "{}",
                json!({"nativeGpuCapabilities": {"timestampQuery": device.features().contains(wgpu::Features::TIMESTAMP_QUERY),"encoderTimestamps": device.features().contains(wgpu::Features::TIMESTAMP_QUERY_INSIDE_ENCODERS)}})
            );
        }
        // No external cache bytes are accepted; wgpu owns the cache's lifetime.
        let pipeline_cache = if cache_feature.is_empty() {
            None
        } else {
            Some(unsafe {
                device.create_pipeline_cache(&wgpu::PipelineCacheDescriptor {
                    label: Some("MuTracer device pipeline cache"),
                    data: None,
                    fallback: true,
                })
            })
        };
        Ok(Self {
            pipelines: Arc::new(Mutex::new(HashMap::new())),
            pipeline_cache,
            device,
            queue,
            info,
            hardware_ray_query,
        })
    }
}
struct GpuScene {
    retained: Option<scene::PreparedState>,
    gpu: GpuDevice,
    scene: Scene,
    buffers: HashMap<usize, wgpu::Buffer>,
    pipeline: wgpu::ComputePipeline,
    groups: Vec<wgpu::BindGroup>,
    textures: HashMap<usize, wgpu::Texture>,
    hardware: Option<hardware::Resources>,
    native_bvh: Option<(Vec<u8>, native_bvh::Stats)>,
    compile_seconds: f64,
    samples: u32,
}
impl GpuScene {
    fn new(
        scene_dir: &Path,
        scene: Scene,
        options: &RenderOptions,
        assets: Option<&HashMap<String, Vec<u8>>>,
        gpu: GpuDevice,
    ) -> Result<Self> {
        Self::new_reusing(scene_dir, scene, options, assets, gpu, None, None)
    }
    fn new_reusing(
        scene_dir: &Path,
        scene: Scene,
        options: &RenderOptions,
        assets: Option<&HashMap<String, Vec<u8>>>,
        gpu: GpuDevice,
        reusable: Option<&HashMap<usize, wgpu::Buffer>>,
        reusable_hw: Option<&HashMap<String, wgpu::Buffer>>,
    ) -> Result<Self> {
        // Drain validation/OOM errors before making a candidate scene visible to a context.
        let memory_scope = gpu.device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
        let validation_scope = gpu.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let result = Self::upload(
            scene_dir,
            scene,
            options,
            assets,
            gpu.clone(),
            reusable,
            reusable_hw,
        );
        let validation = pollster::block_on(validation_scope.pop());
        let memory = pollster::block_on(memory_scope.pop());
        if let Some(error) = validation.or(memory) {
            gpu.pipelines.lock().unwrap().clear();
            return Err(error.to_string().into());
        }
        result
    }
    fn upload(
        scene_dir: &Path,
        scene: Scene,
        options: &RenderOptions,
        assets: Option<&HashMap<String, Vec<u8>>>,
        gpu: GpuDevice,
        reusable: Option<&HashMap<usize, wgpu::Buffer>>,
        reusable_hw: Option<&HashMap<String, wgpu::Buffer>>,
    ) -> Result<Self> {
        let read = |name: &str| -> Result<Vec<u8>> {
            if let Some(assets) = assets {
                return assets
                    .get(name)
                    .cloned()
                    .ok_or_else(|| format!("Missing native resource {name}").into());
            }
            Ok(fs::read(scene_dir.join(name))?)
        };
        if scene.format != 1 || scene.width == 0 || scene.height == 0 {
            return Err("Invalid capture".into());
        }
        if options.flags & 2 != 0
            && options.material_index
                >= scene
                    .material_count
                    .ok_or("Capture has no material metadata")?
        {
            return Err("Material index is out of range".into());
        }
        let use_hwrt = options.flags & 4 != 0;
        if use_hwrt
            && !scene
                .hwrt
                .as_ref()
                .is_some_and(|capture| capture.eligible && capture.authoritative)
        {
            return Err(
                "Capture is not eligible for authoritative HWRT; use the raw scene API".into(),
            );
        }
        let device = &gpu.device;
        let queue = &gpu.queue;
        init_core();
        let native_bvh = scene
            .native_bvh
            .as_ref()
            .map(|capture| native_bvh::rebuild(scene_dir, capture))
            .transpose()?;
        let mut buffers = HashMap::new();
        let mut reused_bytes = 0u64;
        let mut allocated_bytes = 0u64;
        for buffer in &scene.buffers {
            let data = if scene
                .native_bvh
                .as_ref()
                .is_some_and(|capture| capture.buffer == buffer.id)
            {
                native_bvh
                    .as_ref()
                    .ok_or("Missing native BVH result")?
                    .0
                    .clone()
            } else {
                read(&buffer.file)?
            };
            if data.len() as u64 != buffer.size {
                return Err("Capture buffer length mismatch".into());
            }
            let mut usage =
                wgpu::BufferUsages::from_bits(buffer.usage).ok_or("Invalid buffer usage")?;
            if use_hwrt && buffer.id == 3 && scene.native_layout.as_ref().is_some_and(|l| l.indexed)
            {
                usage |= wgpu::BufferUsages::BLAS_INPUT;
            }
            usage |= wgpu::BufferUsages::COPY_DST;
            let existing = reusable
                .and_then(|buffers| buffers.get(&buffer.id))
                .filter(|b| b.size() == buffer.size && b.usage() == usage);
            let gpu_buffer = if let Some(existing) = existing {
                queue.write_buffer(existing, 0, &data);
                reused_bytes += buffer.size;
                existing.clone()
            } else {
                allocated_bytes += buffer.size;
                device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some(&buffer.file),
                    contents: &data,
                    usage,
                })
            };
            buffers.insert(buffer.id, gpu_buffer);
        }
        if let Some(sampling) = &scene.sampling {
            if sampling.pattern != "sobol" {
                return Err(
                    "Native module composition currently supports captured Sobol only".into(),
                );
            }
            let input = sampling.max_samples.to_le_bytes();
            let mut pointer = std::ptr::null();
            let mut size = 0;
            unsafe {
                mt_core_sampling(input.as_ptr(), input.len(), &mut pointer, &mut size);
            }
            let command = unsafe { copy_core_result(pointer, size, 168)? };
            if command[..4] != [0, 0, 0, 0] {
                return Err("Unexpected native sampling pattern".into());
            }
            queue.write_buffer(&buffers[&scene.rt_uniform], 160, &command[4..8]);
        }
        if options.flags & 1 != 0 {
            let id = scene
                .camera_uniform
                .ok_or("Capture has no camera metadata")?;
            let record = scene
                .buffers
                .iter()
                .find(|buffer| buffer.id == id)
                .ok_or("Missing camera buffer")?;
            let data = read(&record.file)?;
            if data.len() != 144 {
                return Err("Invalid camera uniform length".into());
            }
            let mut pointer = std::ptr::null();
            let mut size = 0;
            unsafe {
                mt_core_camera(
                    data.as_ptr(),
                    data.len(),
                    options.camera_offset[0] as f64,
                    options.camera_offset[1] as f64,
                    options.camera_offset[2] as f64,
                    &mut pointer,
                    &mut size,
                );
            }
            let command = unsafe { copy_core_result(pointer, size, 144)? };
            queue.write_buffer(&buffers[&id], 0, &command);
        }
        if options.flags & 2 != 0 {
            let id = scene
                .material_buffer
                .ok_or("Capture has no material buffer metadata")?;
            let stride = scene
                .material_stride
                .ok_or("Capture has no material stride")?;
            let offsets = scene
                .material_offsets
                .as_ref()
                .ok_or("Capture has no material offsets")?;
            let start = options.material_index as u64 * stride;
            if offsets.color + 12 > stride
                || offsets.roughness + 4 > stride
                || start + stride > buffers[&id].size()
            {
                return Err("Invalid material offsets".into());
            }
            let mut pointer = std::ptr::null();
            let mut size = 0;
            unsafe {
                mt_core_material(
                    options.base_color[0] as f64,
                    options.base_color[1] as f64,
                    options.base_color[2] as f64,
                    options.roughness as f64,
                    &mut pointer,
                    &mut size,
                );
            }
            let command = unsafe { copy_core_result(pointer, size, 16)? };
            queue.write_buffer(&buffers[&id], start + offsets.color, &command[..12]);
            queue.write_buffer(&buffers[&id], start + offsets.roughness, &command[12..]);
        }
        let mut textures = HashMap::new();
        let mut views = HashMap::new();
        for texture in &scene.textures {
            let gpu_texture = device.create_texture(&wgpu::TextureDescriptor {
                label: Some(&texture.format),
                size: wgpu::Extent3d {
                    width: texture.width,
                    height: texture.height,
                    depth_or_array_layers: texture.depth,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: match texture.format.as_str() {
                    "rgba8unorm" => wgpu::TextureFormat::Rgba8Unorm,
                    "rgba16float" => wgpu::TextureFormat::Rgba16Float,
                    "rgba32float" => wgpu::TextureFormat::Rgba32Float,
                    "r32float" => wgpu::TextureFormat::R32Float,
                    "rg32float" => wgpu::TextureFormat::Rg32Float,
                    _ => return Err("Unsupported capture texture format".into()),
                },
                usage: wgpu::TextureUsages::from_bits(texture.usage)
                    .ok_or("Invalid texture usage")?,
                view_formats: &[],
            });
            for write in &texture.writes {
                let origin = &write["origin"];
                let origin = wgpu::Origin3d {
                    x: origin[0].as_u64().unwrap_or(0) as u32,
                    y: origin[1].as_u64().unwrap_or(0) as u32,
                    z: origin[2].as_u64().unwrap_or(0) as u32,
                };
                let layout = &write["layout"];
                queue.write_texture(
                    wgpu::TexelCopyTextureInfo {
                        texture: &gpu_texture,
                        mip_level: 0,
                        origin,
                        aspect: wgpu::TextureAspect::All,
                    },
                    &read(write["file"].as_str().ok_or("Missing texture file")?)?,
                    wgpu::TexelCopyBufferLayout {
                        offset: layout["offset"].as_u64().unwrap_or(0),
                        bytes_per_row: layout["bytesPerRow"].as_u64().map(|v| v as u32),
                        rows_per_image: layout["rowsPerImage"].as_u64().map(|v| v as u32),
                    },
                    extent(&write["size"], 1),
                );
            }
            views.insert(
                texture.id,
                gpu_texture.create_view(&wgpu::TextureViewDescriptor::default()),
            );
            textures.insert(texture.id, gpu_texture);
        }
        let mut samplers = HashMap::new();
        for sampler in &scene.samplers {
            samplers.insert(
                number(sampler, "id", 0) as usize,
                device.create_sampler(&wgpu::SamplerDescriptor {
                    label: Some("MuTracer maps"),
                    mag_filter: wgpu::FilterMode::Linear,
                    min_filter: wgpu::FilterMode::Linear,
                    ..Default::default()
                }),
            );
        }
        let hardware = if use_hwrt
            && !scene
                .hwrt
                .as_ref()
                .is_some_and(|capture| capture.authoritative && capture.instances.is_empty())
        {
            Some(hardware::prepare_reusing(
                &device,
                &queue,
                scene_dir,
                scene.hwrt.as_ref().unwrap(),
                assets,
                Some(&buffers),
                reusable_hw,
            )?)
        } else {
            None
        };
        let source = String::from_utf8(read(if use_hwrt {
            scene
                .hwrt
                .as_ref()
                .unwrap()
                .shader
                .as_ref()
                .ok_or("Missing HWRT shader")?
        } else {
            &scene.shader
        })?)?;
        let key = PipelineKey {
            source,
            entry: scene.entry_point.clone(),
            layout: serde_json::to_string(
                &scene
                    .bind_groups
                    .iter()
                    .map(|g| &g.layout)
                    .collect::<Vec<_>>(),
            )?,
            hardware: hardware.is_some(),
        };
        let shader_started = Instant::now();
        let mut cache = gpu.pipelines.lock().unwrap();
        let cached = cache.get(&key).cloned();
        let cache_hit = cached.is_some();
        let compiled = if let Some(cached) = cached {
            cached
        } else {
            let layouts: Vec<_> = scene
                .bind_groups
                .iter()
                .enumerate()
                .map(|(index, group)| {
                    let mut entries: Vec<_> = group.layout.iter().map(layout_entry).collect();
                    if index == 0 && hardware.is_some() {
                        entries.extend([
                            wgpu::BindGroupLayoutEntry {
                                binding: 4,
                                visibility: wgpu::ShaderStages::COMPUTE,
                                ty: wgpu::BindingType::AccelerationStructure {
                                    vertex_return: false,
                                },
                                count: None,
                            },
                            wgpu::BindGroupLayoutEntry {
                                binding: 5,
                                visibility: wgpu::ShaderStages::COMPUTE,
                                ty: wgpu::BindingType::Buffer {
                                    ty: wgpu::BufferBindingType::Storage { read_only: true },
                                    has_dynamic_offset: false,
                                    min_binding_size: None,
                                },
                                count: None,
                            },
                        ]);
                    }
                    device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                        label: Some("MuTracer capture layout"),
                        entries: &entries,
                    })
                })
                .collect();
            let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("MuTracer capture pipeline layout"),
                bind_group_layouts: &layouts.iter().map(Some).collect::<Vec<_>>(),
                ..Default::default()
            });
            let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("MuTracer path tracer"),
                source: wgpu::ShaderSource::Wgsl(key.source.as_str().into()),
            });
            let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some("MuTracer native path tracer"),
                layout: Some(&layout),
                module: &shader,
                entry_point: Some(&scene.entry_point),
                compilation_options: Default::default(),
                cache: gpu.pipeline_cache.as_ref(),
            });
            let compiled = CachedPipeline {
                _shader: shader,
                layouts,
                pipeline,
            };
            if cache.len() >= 32 {
                cache.clear();
            }
            cache.insert(key, compiled.clone());
            compiled
        };
        drop(cache);
        let CachedPipeline {
            layouts, pipeline, ..
        } = compiled;
        let compile_seconds = shader_started.elapsed().as_secs_f64();
        if std::env::var_os("MUTRACER_NATIVE_PROFILE").is_some_and(|v| v == "1") {
            eprintln!(
                "{}",
                json!({"nativeReuseProfile": {"pipelineCacheHit": cache_hit,
                "reusedBufferBytes": reused_bytes,"allocatedBufferBytes": allocated_bytes}})
            );
        }
        let groups: Vec<_> = scene
            .bind_groups
            .iter()
            .zip(&layouts)
            .enumerate()
            .map(|(index, (group, layout))| {
                let mut entries: Vec<_> = group
                    .entries
                    .iter()
                    .map(|entry| wgpu::BindGroupEntry {
                        binding: entry.binding,
                        resource: match entry.kind.as_str() {
                            "buffer" => buffers[&entry.id].as_entire_binding(),
                            "texture" => wgpu::BindingResource::TextureView(&views[&entry.id]),
                            "sampler" => wgpu::BindingResource::Sampler(&samplers[&entry.id]),
                            other => panic!("Unsupported resource: {other}"),
                        },
                    })
                    .collect();
                if index == 0 {
                    if let Some(resources) = &hardware {
                        entries.extend([
                            wgpu::BindGroupEntry {
                                binding: 4,
                                resource: resources.tlas.as_binding(),
                            },
                            wgpu::BindGroupEntry {
                                binding: 5,
                                resource: resources.mapping.as_entire_binding(),
                            },
                        ]);
                    }
                }
                device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("MuTracer capture resources"),
                    layout,
                    entries: &entries,
                })
            })
            .collect();
        Ok(Self {
            retained: None,
            gpu,
            scene,
            buffers,
            pipeline,
            groups,
            textures: textures,
            hardware,
            native_bvh,
            compile_seconds,
            samples: 0,
        })
    }
    fn dispatch_samples(&self, start: u32, additional: u32, bounces: f32, seed: u32) -> Result<()> {
        self.dispatch_timed(start, additional, bounces, seed, None)
    }
    fn dispatch_timed(
        &self,
        start: u32,
        additional: u32,
        bounces: f32,
        seed: u32,
        timer: Option<&profiling::GpuTimer>,
    ) -> Result<()> {
        let end = start
            .checked_add(additional)
            .ok_or("Sample count overflow")?;
        if additional == 0 || end > 4096 {
            return Err("Total samples must be 1..4096".into());
        }
        let device = &self.gpu.device;
        let queue = &self.gpu.queue;
        for sample in start..end {
            let mut pointer = std::ptr::null();
            let mut size = 0;
            unsafe {
                mt_core_frame(sample as f64, bounces as f64, seed, &mut pointer, &mut size);
            }
            if size != 16 || pointer.is_null() {
                return Err("Invalid AOT frame command".into());
            }
            // Copy all arena-backed bytes before any reset/collect or next call.
            let mut frame = [0u8; 16];
            unsafe {
                frame.copy_from_slice(std::slice::from_raw_parts(pointer, size));
                mt_core_reset();
            }
            let uniform = &self.buffers[&self.scene.rt_uniform];
            queue.write_buffer(uniform, 8, &frame[0..4]);
            queue.write_buffer(uniform, 124, &frame[4..8]);
            queue.write_buffer(uniform, 156, &frame[8..12]);
            let mut encoder =
                device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
            {
                let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                    timestamp_writes: timer.map(|t| t.pass(sample - start)),
                    ..Default::default()
                });
                pass.set_pipeline(&self.pipeline);
                for (index, group) in self.groups.iter().enumerate() {
                    pass.set_bind_group(index as u32, group, &[]);
                }
                pass.dispatch_workgroups(
                    self.scene.width.div_ceil(8),
                    self.scene.height.div_ceil(8),
                    1,
                );
            }
            if sample + 1 == end {
                if let Some(t) = timer {
                    t.resolve(&mut encoder);
                }
            }
            queue.submit([encoder.finish()]);
        }
        unsafe {
            mt_core_collect();
        }
        Ok(())
    }
    fn add_samples(&mut self, additional: u32, bounces: f32, seed: u32) -> Result<()> {
        let timer = profiling::GpuTimer::new(&self.gpu.device, additional, false);
        self.dispatch_timed(self.samples, additional, bounces, seed, timer.as_ref())?;
        self.gpu.device.poll(wgpu::PollType::Wait {
            submission_index: None,
            timeout: Some(Duration::from_secs(30)),
        })?;
        if profiling::gpu_enabled() {
            let gpu_ms = timer
                .as_ref()
                .map(|t| t.milliseconds(&self.gpu.device, &self.gpu.queue))
                .transpose()?;
            eprintln!(
                "{}",
                json!({"nativeRenderProfile": {"firstSample": self.samples, "samples": additional, "kernelGpuMs": gpu_ms}})
            );
        }
        self.samples += additional;
        Ok(())
    }
    fn read_pixels(&self, kind: u32) -> Result<Vec<u8>> {
        if self.samples == 0 {
            return Err("No completed samples".into());
        }
        let id = match kind {
            0 => self.scene.color_output,
            1 => self.scene.normal_output.ok_or("No normal output")?,
            2 => self.scene.albedo_output.ok_or("No albedo output")?,
            _ => return Err("Unknown image kind".into()),
        };
        read_average(
            &self.gpu.device,
            &self.gpu.queue,
            self.buffers.get(&id).ok_or("Missing output buffer")?,
            self.scene.width,
            self.scene.height,
            self.samples,
        )
    }
    fn reset_raw(&mut self) -> Result<()> {
        // The raw resource protocol reserves 10..13 for accumulation and ray scratch.
        let mut encoder = self.gpu.device.create_command_encoder(&Default::default());
        for id in 10..=13 {
            encoder.clear_buffer(
                self.buffers
                    .get(&id)
                    .ok_or("Missing raw accumulation buffer")?,
                0,
                None,
            );
        }
        self.gpu.queue.submit([encoder.finish()]);
        self.gpu.device.poll(wgpu::PollType::Wait {
            submission_index: None,
            timeout: Some(Duration::from_secs(30)),
        })?;
        self.samples = 0;
        Ok(())
    }
    fn validate_lighting(&self, updates: &scene::LightingUpdates) -> Result<()> {
        for (id, width, height, data) in updates {
            if *id < 21 {
                if self.buffers.get(id).map(wgpu::Buffer::size) != Some(data.len() as u64) {
                    return Err("Full scene commit required: scene buffer size changed".into());
                }
            } else {
                let texture = self.textures.get(id).ok_or("Missing lighting texture")?;
                if texture.width() != *width || texture.height() != *height {
                    return Err(
                        "Full scene commit required: light sampling texture shape changed".into(),
                    );
                }
                let bpp = if *id == 22 { 8 } else { 16 };
                if data.len() != *width as usize * *height as usize * bpp {
                    return Err("Lighting texture size mismatch".into());
                }
            }
        }
        Ok(())
    }
    fn prepare_geometry_hardware(
        &self,
        updates: &scene::LightingUpdates,
    ) -> Result<
        Option<(
            hardware::Resources,
            hardware::Capture,
            wgpu::BindGroup,
            Option<wgpu::Buffer>,
        )>,
    > {
        let Some(_current) = self.scene.hwrt.as_ref().filter(|_| self.hardware.is_some()) else {
            return Ok(None);
        };
        let (capture, assets) = self
            .retained
            .as_ref()
            .ok_or("Missing retained geometry")?
            .hardware_geometry(updates)
            .map_err(|error| format!("Full scene commit required: {error}"))?;
        let device = &self.gpu.device;
        let memory_scope = device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
        let validation_scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let attributes = if capture.indexed {
            Some(
                device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("MuTracer candidate attributes"),
                    contents: assets.get("native-3").ok_or("Missing updated attributes")?,
                    usage: self.buffers[&3].usage(),
                }),
            )
        } else {
            None
        };
        let mut candidate_buffers = self.buffers.clone();
        if let Some(buffer) = &attributes {
            candidate_buffers.insert(3, buffer.clone());
        }
        let result = hardware::prepare(
            device,
            &self.gpu.queue,
            Path::new(""),
            &capture,
            Some(&assets),
            Some(&candidate_buffers),
        )
        .map(|resources| {
            let mut entries: Vec<_> = (0..4)
                .map(|i| wgpu::BindGroupEntry {
                    binding: i,
                    resource: candidate_buffers[&(i as usize + 1)].as_entire_binding(),
                })
                .collect();
            entries.extend([
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: resources.tlas.as_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 5,
                    resource: resources.mapping.as_entire_binding(),
                },
            ]);
            let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("MuTracer updated geometry"),
                layout: &self.pipeline.get_bind_group_layout(0),
                entries: &entries,
            });
            (resources, capture, group, attributes)
        });
        let validation = pollster::block_on(validation_scope.pop());
        let memory = pollster::block_on(memory_scope.pop());
        if let Some(error) = validation.or(memory) {
            return Err(format!(
                "Full scene commit required: hardware geometry preparation: {error}"
            )
            .into());
        }
        result.map(Some)
    }
    fn update_lighting(&mut self, updates: &scene::LightingUpdates) -> Result<()> {
        if let Some(layout) = &updates.native_layout {
            self.scene.native_layout = Some(layout.clone());
        }
        if profiling::enabled() {
            eprintln!(
                "{}",
                json!({"nativeUploadProfile": {"writeBytes": updates.iter().map(|(_,_,_,data)| data.len()).sum::<usize>(), "resources": updates.iter().map(|(id,_,_,data)| json!({"id": id,"bytes": data.len()})).collect::<Vec<_>>()}})
            );
        }
        for (id, width, height, data) in updates {
            if *id < 21 {
                self.gpu.queue.write_buffer(&self.buffers[id], 0, data);
            } else {
                self.gpu.queue.write_texture(
                    self.textures[id].as_image_copy(),
                    data,
                    wgpu::TexelCopyBufferLayout {
                        offset: 0,
                        bytes_per_row: Some(*width * if *id == 22 { 8 } else { 16 }),
                        rows_per_image: Some(*height),
                    },
                    wgpu::Extent3d {
                        width: *width,
                        height: *height,
                        depth_or_array_layers: 1,
                    },
                );
            }
        }
        self.reset_raw()
    }
    fn update_material(&mut self, packed: &[u8]) -> Result<()> {
        let buffer = self
            .scene
            .material_buffer
            .and_then(|id| self.buffers.get(&id))
            .ok_or("Missing raw material buffer")?;
        if buffer.size() != packed.len() as u64 {
            return Err("Material buffer size mismatch".into());
        }
        self.gpu.queue.write_buffer(buffer, 0, packed);
        self.reset_raw()
    }
    fn update_camera(&mut self, packed: &[u8]) -> Result<()> {
        let buffer = self
            .scene
            .camera_uniform
            .and_then(|id| self.buffers.get(&id))
            .ok_or("Missing raw camera buffer")?;
        if packed.len() != 144 || buffer.size() != 144 {
            return Err("Camera uniform size mismatch".into());
        }
        // Existing TS Camera/lens/packing owns the values; the host only uploads
        // the command and clears accumulation. No scene/pipeline recreation.
        self.gpu.queue.write_buffer(buffer, 0, packed);
        self.reset_raw()
    }
}

fn render_scene(
    scene_dir: &Path,
    scene: Scene,
    output: &Path,
    options: &RenderOptions,
    assets: Option<&HashMap<String, Vec<u8>>>,
) -> Result<()> {
    let samples = if options.samples == 0 {
        scene.samples
    } else {
        options.samples
    };
    if samples == 0 || samples > 4096 {
        return Err("Samples must be 1..4096".into());
    }
    fs::create_dir_all(output)?;
    let start = Instant::now();
    let use_hwrt = options.flags & 4 != 0;
    let gpu = GpuDevice::new(use_hwrt)?;
    let mut gpu_scene = GpuScene::new(scene_dir, scene, options, assets, gpu)?;
    if let Some((data, _)) = &gpu_scene.native_bvh {
        fs::write(output.join("native-bvh.bin"), data)?;
    }
    let compile_seconds = gpu_scene.compile_seconds;
    let hardware_ray_query = gpu_scene.gpu.hardware_ray_query;
    eprintln!("Native pipeline ready in {compile_seconds:.2}s; tracing {samples} samples...");
    let render_started = Instant::now();
    gpu_scene.add_samples(samples, options.bounces, options.seed)?;
    let scene = &gpu_scene.scene;
    let info = &gpu_scene.gpu.info;
    let averaged = gpu_scene.read_pixels(0)?;
    let mapped = &averaged;
    let mut aov_outputs = Vec::new();
    for (name, id) in [
        ("normal", scene.normal_output),
        ("albedo", scene.albedo_output),
    ] {
        if let Some(id) = id {
            let values = read_average(
                &gpu_scene.gpu.device,
                &gpu_scene.gpu.queue,
                gpu_scene.buffers.get(&id).ok_or("Missing AOV buffer")?,
                scene.width,
                scene.height,
                samples,
            )?;
            fs::write(output.join(format!("{name}.rgba32f")), values)?;
            aov_outputs.push(name);
        }
    }
    let mut hdr = Vec::with_capacity(mapped.len());
    let mut rgb = Vec::with_capacity(scene.width as usize * scene.height as usize * 3);
    let mut minimum = f32::INFINITY;
    let mut maximum = f32::NEG_INFINITY;
    let mut mean = 0.0f64;
    for pixel in mapped.chunks_exact(16) {
        for channel in 0..4 {
            let v = f32::from_le_bytes(pixel[channel * 4..channel * 4 + 4].try_into()?);
            if !v.is_finite() {
                return Err("Non-finite native HDR pixel".into());
            }
            hdr.extend_from_slice(&v.to_le_bytes());
            if channel < 3 {
                minimum = minimum.min(v);
                maximum = maximum.max(v);
                mean += v as f64;
                // Preview only: Reinhard plus sRGB. HDR is the comparison artifact.
                let linear = v.max(0.0) / (1.0 + v.max(0.0));
                let srgb = if linear <= 0.0031308 {
                    12.92 * linear
                } else {
                    1.055 * linear.powf(1.0 / 2.4) - 0.055
                };
                rgb.push((srgb.clamp(0.0, 1.0) * 255.0 + 0.5) as u8);
            }
        }
    }
    let render_seconds = render_started.elapsed().as_secs_f64();
    fs::write(output.join("render.rgba32f"), &hdr)?;
    // MuTracer's tracing coordinates have a bottom-left origin; PNG is top-left.
    let row_bytes = scene.width as usize * 3;
    for y in 0..scene.height as usize / 2 {
        let opposite = scene.height as usize - 1 - y;
        let (top, bottom) = rgb.split_at_mut(opposite * row_bytes);
        top[y * row_bytes..(y + 1) * row_bytes].swap_with_slice(&mut bottom[..row_bytes]);
    }
    let mut png = png::Encoder::new(
        fs::File::create(output.join("render.png"))?,
        scene.width,
        scene.height,
    );
    png.set_color(png::ColorType::Rgb);
    png.set_depth(png::BitDepth::Eight);
    png.write_header()?.write_image_data(&rgb)?;
    fs::write(
        output.join("result.json"),
        serde_json::to_vec_pretty(&json!({
            "width": scene.width, "height": scene.height, "samples": samples,
            "adapter": info.name, "backend": format!("{:?}", info.backend),
            "hardwareRayQuerySupported": hardware_ray_query, "hardwareRayTracingUsed": use_hwrt,
            "intersectionBackend": if use_hwrt { "authoritative HWRT" } else { "software BVH" },
            "shaderCompileSeconds": compile_seconds, "renderReadbackSeconds": render_seconds,
            "totalSeconds": start.elapsed().as_secs_f64(), "rgbMin": minimum, "rgbMax": maximum,
            "rgbMean": mean / (scene.width as f64 * scene.height as f64 * 3.0),
            "finitePixels": scene.width as u64 * scene.height as u64,
            "nativeSceneConstruction": assets.is_some(),
            "aot": if assets.is_some() { "native input decoding, shared scene assembly/BLAS/TLAS/attributes/materials/atlas/lights/camera/full WGSL, sampling and frame packing" } else { "original SAH BVH builder/layout and sampling modules, frame packing/normalizeBounces, shared camera packing and material patch" },
            "nativeOptions": options,
            "buildTimeJavaScript": if assets.is_some() { "none for scene construction or rendering" } else { "scene/raw geometry, TLAS/instance/material/light packing and original shader generation; eligible BLASes are rebuilt natively" },
            "runtime": "native Rust + scriptc machine code + wgpu/Metal; no Node/JS engine",
            "preview": "Reinhard + sRGB; compare render.rgba32f for numerical validation",
            "aovOutputs": aov_outputs,
            "nativeBvh": gpu_scene.native_bvh.as_ref().map(|(_, stats)| stats),
            "nativeSamplingModule": scene.sampling.is_some(),
            "hdrLayout": "little-endian f32 RGBA, bottom row first; linear sample average",
            "wholeLibraryNative": false
        }))?,
    )?;
    eprintln!("Saved {}", output.join("render.png").display());
    Ok(())
}

/// Experimental blocking C entry. Paths and writable error storage are caller-owned.
/// Calls must all use the same owner thread. The first implementation serializes calls.
/// # Safety
/// `scene` and `output` must be valid NUL-terminated UTF-8 strings. If non-null,
/// `error` must be writable for `error_capacity` bytes. No overlapping calls.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_probe_render(
    scene: *const c_char,
    output: *const c_char,
    samples: u32,
    error: *mut c_char,
    error_capacity: usize,
) -> i32 {
    let options = RenderOptions {
        samples,
        ..Default::default()
    };
    unsafe { mt_probe_render_with_options(scene, output, &options, error, error_capacity) }
}

/// Same path/storage/thread requirements as mt_probe_render. `options` must
/// point to a valid, aligned RenderOptions descriptor for the full call.
/// # Safety
/// All input pointers must be valid as described by mutracer-probe.h.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_probe_render_with_options(
    scene: *const c_char,
    output: *const c_char,
    options: *const RenderOptions,
    error: *mut c_char,
    error_capacity: usize,
) -> i32 {
    let result = std::panic::catch_unwind(|| -> Result<()> {
        if scene.is_null() || output.is_null() || options.is_null() {
            return Err("Null input path".into());
        }
        let scene = unsafe { CStr::from_ptr(scene) }.to_str()?;
        let output = unsafe { CStr::from_ptr(output) }.to_str()?;
        render_options(Path::new(scene), Path::new(output), unsafe { &*options })
    });
    let message = match result {
        Ok(Ok(())) => return 0,
        Ok(Err(error)) => error.to_string(),
        Err(panic) => panic
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| panic.downcast_ref::<&str>().map(|s| s.to_string()))
            .unwrap_or_else(|| "Native renderer panicked".into()),
    };
    if !error.is_null() && error_capacity > 0 {
        let length = message.len().min(error_capacity - 1);
        unsafe {
            std::ptr::copy_nonoverlapping(message.as_ptr(), error.cast(), length);
            *error.add(length) = 0;
        }
    }
    1
}
