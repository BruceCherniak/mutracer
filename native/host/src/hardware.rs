use serde::Deserialize;
use std::{collections::HashMap, fs, path::Path, sync::mpsc, time::Duration};
use wgpu::util::DeviceExt;
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capture {
    pub eligible: bool,
    pub reason: Option<String>,
    pub shader: Option<String>,
    #[serde(default = "default_hardware_closest")]
    pub hardware_closest: bool,
    #[serde(default)]
    pub geometries: Vec<Geometry>,
    #[serde(default)]
    pub instances: Vec<Instance>,
    pub triangle_map: Option<String>,
}
fn default_hardware_closest() -> bool {
    true
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Geometry {
    positions: String,
    vertex_count: u32,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Instance {
    geometry: usize,
    custom_index: u32,
    transform: [f32; 12],
}

pub struct Resources {
    pub tlas: wgpu::Tlas,
    pub mapping: wgpu::Buffer,
    pub counters: wgpu::Buffer,
    _blases: Vec<wgpu::Blas>,
    _vertices: Vec<wgpu::Buffer>,
    raw_instances: Option<HashMap<(u32, u32), (usize, u32)>>,
}

pub fn prepare(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    directory: &Path,
    capture: &Capture,
    assets: Option<&HashMap<String, Vec<u8>>>,
) -> Result<Resources> {
    let read = |name: &str| -> Result<Vec<u8>> {
        if let Some(assets) = assets {
            return assets
                .get(name)
                .cloned()
                .ok_or_else(|| format!("Missing HWRT resource {name}").into());
        }
        Ok(fs::read(directory.join(name))?)
    };
    if !capture.eligible {
        return Err(capture
            .reason
            .clone()
            .unwrap_or("Unsupported hardware capture".into())
            .into());
    }
    // Profiling waits are opt-in and separate from ordinary wall-time runs.
    // Drain unrelated resource uploads before timing acceleration structures.
    if super::profiling::gpu_enabled() {
        queue.submit([]);
        device.poll(wgpu::PollType::Wait {
            submission_index: None,
            timeout: Some(Duration::from_secs(30)),
        })?;
    }
    let as_started = std::time::Instant::now();
    let mut vertices = Vec::new();
    let mut sizes = Vec::new();
    let mut blases = Vec::new();
    for geometry in &capture.geometries {
        let data = read(&geometry.positions)?;
        if data.len() != geometry.vertex_count as usize * 12 {
            return Err("Invalid hardware vertex bytes".into());
        }
        vertices.push(
            device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("MuTracer HWRT vertices"),
                contents: &data,
                usage: wgpu::BufferUsages::BLAS_INPUT,
            }),
        );
        sizes.push(wgpu::BlasTriangleGeometrySizeDescriptor {
            vertex_format: wgpu::VertexFormat::Float32x3,
            vertex_count: geometry.vertex_count,
            index_format: None,
            index_count: None,
            flags: wgpu::AccelerationStructureGeometryFlags::OPAQUE,
        });
        blases.push(device.create_blas(
            &wgpu::CreateBlasDescriptor {
                label: Some("MuTracer hardware BLAS"),
                flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
                update_mode: wgpu::AccelerationStructureUpdateMode::Build,
            },
            wgpu::BlasGeometrySizeDescriptors::Triangles {
                descriptors: vec![sizes.last().unwrap().clone()],
            },
        ));
    }
    let mut tlas = device.create_tlas(&wgpu::CreateTlasDescriptor {
        label: Some("MuTracer hardware TLAS"),
        max_instances: capture.instances.len() as u32,
        flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
        update_mode: wgpu::AccelerationStructureUpdateMode::Build,
    });
    for (index, instance) in capture.instances.iter().enumerate() {
        tlas[index] = Some(wgpu::TlasInstance::new(
            blases
                .get(instance.geometry)
                .ok_or("Invalid BLAS reference")?,
            instance.transform,
            instance.custom_index,
            255,
        ));
    }
    let entries: Vec<_> = blases
        .iter()
        .zip(&sizes)
        .zip(&vertices)
        .map(|((blas, size), vertex_buffer)| wgpu::BlasBuildEntry {
            blas,
            geometry: wgpu::BlasGeometries::TriangleGeometries(vec![wgpu::BlasTriangleGeometry {
                size,
                vertex_buffer,
                first_vertex: 0,
                vertex_stride: 12,
                index_buffer: None,
                first_index: None,
                transform_buffer: None,
                transform_buffer_offset: None,
            }]),
        })
        .collect();
    let timer = super::profiling::GpuTimer::new(device, 1, true);
    let mut encoder = device.create_command_encoder(&Default::default());
    if let Some(t) = &timer {
        t.stamp(&mut encoder, 0);
    }
    encoder.build_acceleration_structures(entries.iter(), [&tlas]);
    if let Some(t) = &timer {
        t.stamp(&mut encoder, 1);
        t.resolve(&mut encoder);
    }
    queue.submit([encoder.finish()]);
    let build_submit_ms = as_started.elapsed().as_secs_f64() * 1000.0;
    let completed_wall_ms = if super::profiling::gpu_enabled() {
        device.poll(wgpu::PollType::Wait {
            submission_index: None,
            timeout: Some(Duration::from_secs(30)),
        })?;
        Some(as_started.elapsed().as_secs_f64() * 1000.0)
    } else {
        None
    };
    if super::profiling::enabled() || super::profiling::gpu_enabled() {
        let gpu_ms = timer
            .as_ref()
            .map(|t| t.milliseconds(device, queue))
            .transpose()?;
        eprintln!(
            "{}",
            serde_json::json!({"nativeAsProfile": {"cpuBuildSubmitMs": build_submit_ms,"completedWallMs": completed_wall_ms,"gpuMs": gpu_ms,"gpuTimestampUnavailable": if super::profiling::gpu_enabled() && timer.is_none() { Some("Encoder timestamp queries unavailable") } else { None },"blasCount": blases.len(),"instanceCount": capture.instances.len(),"vertexUploadBytes": vertices.iter().map(|b| b.size()).sum::<u64>()}})
        );
    }
    let data = read(
        capture
            .triangle_map
            .as_ref()
            .ok_or("Missing HWRT triangle map")?,
    )?;
    let mapping = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("MuTracer hardware primitive identity"),
        contents: &data,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
    });
    if super::profiling::enabled() {
        eprintln!(
            "{}",
            serde_json::json!({"nativeHardwareUploadProfile": {"kind":"geometry","writeBytes":vertices.iter().map(|b| b.size()).sum::<u64>() + data.len() as u64,"instanceCount":capture.instances.len()}})
        );
    }
    let counters = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("MuTracer hardware query counts"),
        size: 44,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    // Software TLAS rebuilds may reorder instances. Match BLAS root/vertex region
    // rather than the previous instance index, preserving primitive identity.
    let raw_instances = assets
        .and_then(|assets| assets.get("native-2"))
        .map(|bytes| {
            bytes
                .chunks_exact(160)
                .zip(&capture.instances)
                .enumerate()
                .map(|(i, (record, instance))| {
                    let word =
                        |offset| u32::from_le_bytes(record[offset..offset + 4].try_into().unwrap());
                    (
                        (word(0), word(4)),
                        (
                            instance.geometry,
                            u32::from_le_bytes(data[i * 4..i * 4 + 4].try_into().unwrap()),
                        ),
                    )
                })
                .collect()
        });
    Ok(Resources {
        raw_instances,
        tlas,
        mapping,
        counters,
        _blases: blases,
        _vertices: vertices,
    })
}

// A validated plan owns no GPU side effects; rejected updates preserve old ASes.
pub struct TransformPlan {
    instances: Vec<Instance>,
    mapping: Vec<u8>,
}
impl Resources {
    pub fn transform_plan(&self, capture: &Capture, bytes: &[u8]) -> Result<TransformPlan> {
        let roots = self
            .raw_instances
            .as_ref()
            .ok_or("Full scene commit required: no raw hardware instance metadata")?;
        if bytes.len() != capture.instances.len() * 160 {
            return Err("Full scene commit required: hardware instance membership changed".into());
        }
        let mut instances = Vec::new();
        let mut mapping = Vec::new();
        let mut closest = true;
        for (i, record) in bytes.chunks_exact(160).enumerate() {
            let word = |offset| u32::from_le_bytes(record[offset..offset + 4].try_into().unwrap());
            let &(geometry, base) = roots
                .get(&(word(0), word(4)))
                .ok_or("Full scene commit required: hardware BLAS placement changed")?;
            let m: Vec<_> = (0..16)
                .map(|k| f32::from_bits(word(80 + k * 4)) as f64)
                .collect();
            if m.iter().any(|v| !v.is_finite()) {
                return Err("Non-finite hardware instance matrix".into());
            }
            closest &= supports_closest(&m);
            instances.push(Instance {
                geometry,
                custom_index: i as u32,
                transform: [0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14].map(|k| m[k] as f32),
            });
            mapping.extend(base.to_le_bytes());
        }
        if closest != capture.hardware_closest {
            return Err(
                "Full scene commit required: hardware closest-hit eligibility changed".into(),
            );
        }
        Ok(TransformPlan { instances, mapping })
    }
    pub fn update_transforms(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        plan: TransformPlan,
    ) {
        for (i, instance) in plan.instances.iter().enumerate() {
            self.tlas[i] = Some(wgpu::TlasInstance::new(
                &self._blases[instance.geometry],
                instance.transform,
                instance.custom_index,
                255,
            ));
        }
        if super::profiling::enabled() {
            eprintln!(
                "{}",
                serde_json::json!({"nativeHardwareUploadProfile": {"kind":"transform","writeBytes":plan.mapping.len(),"instanceCount":plan.instances.len()}})
            );
        }
        queue.write_buffer(&self.mapping, 0, &plan.mapping);
        let mut encoder = device.create_command_encoder(&Default::default());
        encoder.build_acceleration_structures(
            std::iter::empty::<&wgpu::BlasBuildEntry<'_>>(),
            [&self.tlas],
        );
        queue.submit([encoder.finish()]);
    }
}
fn supports_closest(m: &[f64]) -> bool {
    let a = [m[0], m[1], m[2]];
    let b = [m[4], m[5], m[6]];
    let c = [m[8], m[9], m[10]];
    let dot = |u: [f64; 3], v: [f64; 3]| u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
    let scale = dot(a, a).max(dot(b, b)).max(dot(c, c));
    let epsilon = scale * 1e-5;
    let determinant = a[0] * (b[1] * c[2] - b[2] * c[1]) - b[0] * (a[1] * c[2] - a[2] * c[1])
        + c[0] * (a[1] * b[2] - a[2] * b[1]);
    determinant > 0.
        && scale > 0.
        && (dot(a, a) - dot(b, b)).abs() <= epsilon
        && (dot(a, a) - dot(c, c)).abs() <= epsilon
        && dot(a, b).abs() <= epsilon
        && dot(a, c).abs() <= epsilon
        && dot(b, c).abs() <= epsilon
}

pub fn counts(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    resources: &Resources,
) -> Result<[u32; 11]> {
    let readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("HWRT counter readback"),
        size: 44,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = device.create_command_encoder(&Default::default());
    encoder.copy_buffer_to_buffer(&resources.counters, 0, &readback, 0, 44);
    queue.submit([encoder.finish()]);
    let (sender, receiver) = mpsc::channel();
    readback
        .slice(..)
        .map_async(wgpu::MapMode::Read, move |value| {
            let _ = sender.send(value);
        });
    device.poll(wgpu::PollType::Wait {
        submission_index: None,
        timeout: Some(Duration::from_secs(30)),
    })?;
    receiver.recv_timeout(Duration::from_secs(5))??;
    let values = readback.slice(..).get_mapped_range()?;
    Ok(std::array::from_fn(|i| {
        u32::from_le_bytes(values[i * 4..i * 4 + 4].try_into().unwrap())
    }))
}

// Native counterpart of prepare-hwrt.mjs: consume the original AOT-packed BVH,
// attributes and TLAS leaf order, then create platform acceleration structures.
// No browser capture or alternative scene/material preparation is involved.
pub fn from_raw(
    scene: &super::Scene,
    assets: &mut HashMap<String, Vec<u8>>,
    version: u32,
) -> Result<Capture> {
    if version >= 3 {
        return Err("HWRT displacement descriptors are not supported yet".into());
    }
    let source = String::from_utf8(
        assets
            .get(&scene.shader)
            .ok_or("Missing native shader")?
            .clone(),
    )?;
    let constant = |name: &str| -> Result<&str> {
        source
            .lines()
            .find_map(|line| {
                line.trim()
                    .strip_prefix(&format!("const {name} = "))
                    .and_then(|s| s.strip_suffix(';'))
            })
            .ok_or_else(|| format!("Missing WGSL constant {name}").into())
    };
    if constant("HAS_ALPHA")? != "false" {
        return Err("Alpha materials retain software traversal".into());
    }
    let words = |name: &str| -> Result<Vec<u32>> {
        let bytes = assets.get(name).ok_or("Missing packed HWRT input")?;
        if bytes.len() % 4 != 0 {
            return Err("Invalid packed HWRT input".into());
        }
        Ok(bytes
            .chunks_exact(4)
            .map(|v| u32::from_le_bytes(v.try_into().unwrap()))
            .collect())
    };
    let uniform = words("native-7")?;
    if uniform.get(24) != Some(&0) {
        return Err("Shader bevel retains software traversal".into());
    }
    if uniform.get(23) != Some(&0) {
        return Err("Empty scenes retain software traversal".into());
    }
    let blas_offset = *uniform.get(22).ok_or("Missing BLAS offset")? as usize;
    let instances = words("native-2")?;
    let bvh = words("native-1")?;
    let attributes = words("native-3")?;
    let stride = constant("ATTR_STRIDE")?.parse::<usize>()? * 4;
    let position = constant("POSITION_OFF")?.parse::<usize>()? * 4;
    if stride == 0 || instances.len() % 40 != 0 {
        return Err("Invalid native HWRT layout".into());
    }
    let count = instances.len() / 40;
    let mut mapping = vec![0u32; count];
    let mut geometries = Vec::new();
    let mut placements = Vec::new();
    let mut cache = HashMap::new();
    // Keep the measured affine closest-hit limitation: hardware shadows still run.
    let mut hardware_closest = true;
    let mut generated = HashMap::new();
    for id in 0..count {
        let encoded = instances[id * 40];
        if encoded >> 30 != 0 {
            return Err("HWRT requires BVH2 packing".into());
        }
        let root = blas_offset + encoded as usize;
        let vertex_offset = instances[id * 40 + 1] as usize;
        let geometry = if let Some(&(index, _)) = cache.get(&(root, vertex_offset)) {
            index
        } else {
            let mut stack = vec![root];
            let mut positions = Vec::<u8>::new();
            let base = mapping.len() as u32;
            let mut visited = 0;
            while let Some(node) = stack.pop() {
                visited += 1;
                if visited > bvh.len() / 4 {
                    return Err("Invalid cyclic BVH input".into());
                }
                let child = *bvh.get(node * 4 + 3).ok_or("BVH node out of bounds")? as i32;
                if child >= 0 {
                    stack.push(root + child as usize);
                    stack.push(node + 2);
                    continue;
                }
                for k in 0..child.unsigned_abs() as usize {
                    let record = node + 2 + k;
                    mapping.push(record as u32);
                    for corner in 0..3 {
                        let vertex = *bvh
                            .get(record * 4 + corner)
                            .ok_or("BVH triangle out of bounds")?
                            as usize
                            + vertex_offset;
                        let off = vertex
                            .checked_mul(stride)
                            .and_then(|v| v.checked_add(position))
                            .ok_or("Attribute offset overflow")?;
                        for &word in attributes
                            .get(off..off + 3)
                            .ok_or("HWRT vertex out of bounds")?
                        {
                            if !f32::from_bits(word).is_finite() {
                                return Err("Non-finite HWRT vertex".into());
                            }
                            positions.extend(word.to_le_bytes());
                        }
                    }
                }
            }
            if positions.is_empty() {
                return Err("Empty HWRT geometry".into());
            }
            let index = geometries.len();
            let name = format!("native-hwrt-positions-{index}");
            geometries.push(Geometry {
                positions: name.clone(),
                vertex_count: (positions.len() / 12) as u32,
            });
            generated.insert(name, positions);
            cache.insert((root, vertex_offset), (index, base));
            index
        };
        mapping[id] = cache
            .get(&(root, vertex_offset))
            .ok_or("Missing HWRT map base")?
            .1;
        let m: Vec<_> = instances[id * 40 + 20..id * 40 + 36]
            .iter()
            .map(|v| f64::from(f32::from_bits(*v)))
            .collect();
        hardware_closest &= supports_closest(&m);
        placements.push(Instance {
            geometry,
            custom_index: id as u32,
            transform: [0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14].map(|i| m[i] as f32),
        });
    }
    let mut shader = source;
    for name in ["intersectScene", "intersectSceneShadow"] {
        let marker = format!("fn {name}(");
        if shader.matches(&marker).count() != 1 {
            return Err("Unexpected native intersection definitions".into());
        }
        shader = shader.replace(&marker, &format!("fn {name}Software("));
    }
    let wrapper = include_str!("../../hwrt-intersect.wgsl")
        .replace(
            "const MT_SOFTWARE_CLOSEST: bool = false;",
            &format!("const MT_SOFTWARE_CLOSEST: bool = {};", !hardware_closest),
        )
        .replace(
            "const MT_VALIDATE_SHADOWS: bool = false;",
            &format!(
                "const MT_VALIDATE_SHADOWS: bool = {};",
                std::env::var("MUTRACER_NATIVE_VALIDATE_SHADOWS").as_deref() == Ok("1")
            ),
        );
    generated.insert(
        "native-hwrt-map".into(),
        mapping.iter().flat_map(|v| v.to_le_bytes()).collect(),
    );
    generated.insert(
        "native-hwrt-shader".into(),
        format!("enable wgpu_ray_query;\n{shader}\n{wrapper}").into_bytes(),
    );
    assets.extend(generated);
    Ok(Capture {
        eligible: true,
        reason: None,
        shader: Some("native-hwrt-shader".into()),
        hardware_closest,
        geometries,
        instances: placements,
        triangle_map: Some("native-hwrt-map".into()),
    })
}
