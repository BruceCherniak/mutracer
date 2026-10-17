use serde::Deserialize;
use std::{borrow::Cow, collections::HashMap, fs, path::Path, time::Duration};
use wgpu::util::DeviceExt;
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

// Explicit AOT packet metadata; units belong to the contract, not uniform words.
#[derive(Clone, serde::Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeLayout {
    pub has_alpha: bool,
    pub attribute_stride_bytes: usize,
    pub position_offset_bytes: usize,
    pub blas_offset: usize,
    pub is_empty: bool,
    pub bevel: bool,
    pub has_displacement: bool,
    #[serde(default)]
    pub indexed: bool,
    #[serde(default)]
    pub hardware_geometries: Vec<IndexedGeometry>,
}

#[derive(Clone, serde::Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexedGeometry {
    index_offset: u32,
    index_count: u32,
    vertex_offset: u32,
    vertex_count: u32,
    procedural: bool,
    dynamic: bool,
    bounds_offset: u32,
}
#[derive(Clone, serde::Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capture {
    pub eligible: bool,
    #[serde(default)]
    pub authoritative: bool,
    #[serde(default)]
    pub indexed: bool,
    pub reason: Option<String>,
    pub shader: Option<String>,
    #[serde(default)]
    pub geometries: Vec<Geometry>,
    #[serde(default)]
    pub instances: Vec<Instance>,
    pub triangle_map: Option<String>,
}
impl Capture {
    // A first stable-topology edit declares these rebuilt BLASes mutable. Keep
    // fast-trace static builds lean; the replacement reserves update support for
    // subsequent Phase 2 refits without changing the experimental descriptor.
    pub(super) fn allow_updates(&mut self) {
        for geometry in &mut self.geometries {
            geometry.dynamic = true;
        }
    }
}
#[derive(Clone, serde::Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[derive(Default)]
pub struct Geometry {
    positions: String,
    #[serde(default)]
    indices: Option<String>,
    vertex_count: u32,
    #[serde(default)]
    index_count: Option<u32>,
    #[serde(default)]
    index_offset: u32,
    #[serde(default)]
    first_vertex: u32,
    #[serde(default = "default_stride")]
    vertex_stride: u64,
    #[serde(default)]
    bounds_offset: u32,
    #[serde(default)]
    dynamic: bool,
    #[serde(default)]
    pub(super) procedural: bool,
    #[serde(default)]
    non_opaque: bool,
}
#[derive(Clone, serde::Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Instance {
    geometry: usize,
    custom_index: u32,
    transform: [f32; 12],
}

fn default_stride() -> u64 {
    12
}

pub struct Resources {
    pub inputs: HashMap<String, wgpu::Buffer>,
    indexed: bool,
    pub tlas: wgpu::Tlas,
    pub mapping: wgpu::Buffer,
    _blases: Vec<wgpu::Blas>,
    _vertices: Vec<wgpu::Buffer>,
    _indices: Vec<Option<wgpu::Buffer>>,
    raw_instances: Option<HashMap<(u32, u32), (usize, u32)>>,
}

// Source-order indexed soup builds AS inputs without a software BVH. The
// opt-out retains leaf-order inputs for explicit regression diagnostics.
pub(super) fn direct_input_enabled() -> bool {
    std::env::var_os("MUTRACER_NATIVE_DIRECT_AS").is_none_or(|v| v != "0")
}

pub fn prepare(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    directory: &Path,
    capture: &Capture,
    assets: Option<&HashMap<String, Vec<u8>>>,
    _buffers: Option<&HashMap<usize, wgpu::Buffer>>,
) -> Result<Resources> {
    prepare_reusing(device, queue, directory, capture, assets, _buffers, None)
}
pub fn prepare_reusing(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    directory: &Path,
    capture: &Capture,
    assets: Option<&HashMap<String, Vec<u8>>>,
    _buffers: Option<&HashMap<usize, wgpu::Buffer>>,
    reusable: Option<&HashMap<String, wgpu::Buffer>>,
) -> Result<Resources> {
    let read = |name: &str| -> Result<Cow<'_, [u8]>> {
        if let Some(assets) = assets {
            return assets
                .get(name)
                .map(|bytes| Cow::Borrowed(bytes.as_slice()))
                .ok_or_else(|| format!("Missing HWRT resource {name}").into());
        }
        Ok(Cow::Owned(fs::read(directory.join(name))?))
    };
    if !capture.eligible {
        return Err(capture
            .reason
            .clone()
            .unwrap_or("Unsupported hardware capture".into())
            .into());
    }
    let preparation_started = std::time::Instant::now();
    if capture.instances.len() > device.limits().max_tlas_instance_count as usize {
        return Err("HWRT TLAS instance count exceeds device limit".into());
    }
    if capture.geometries.iter().any(|g| {
        g.index_count.unwrap_or(g.vertex_count) / 3 > device.limits().max_blas_primitive_count
    }) {
        return Err("HWRT BLAS primitive count exceeds device limit".into());
    }
    let mut inputs = HashMap::new();
    let mut reused_bytes = 0u64;
    let mut upload = |name: &str, data: &[u8], usage: wgpu::BufferUsages| {
        let usage = usage | wgpu::BufferUsages::COPY_DST;
        let previous = reusable
            .and_then(|b| b.get(name))
            .filter(|b| b.size() == data.len() as u64 && b.usage() == usage);
        let buffer = if let Some(previous) = previous {
            queue.write_buffer(previous, 0, data);
            reused_bytes += previous.size();
            previous.clone()
        } else {
            device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some(name),
                contents: data,
                usage,
            })
        };
        inputs.insert(name.to_string(), buffer.clone());
        buffer
    };
    let direct_indices = if capture.indexed {
        Some(upload(
            "MuTracer merged indices",
            &read("native-35")?,
            wgpu::BufferUsages::BLAS_INPUT
                | wgpu::BufferUsages::STORAGE
                | wgpu::BufferUsages::COPY_DST,
        ))
    } else {
        None
    };
    let direct_blas_indices = if capture.indexed {
        Some(upload(
            "MuTracer soup indices",
            &read("native-42")?,
            wgpu::BufferUsages::BLAS_INPUT,
        ))
    } else {
        None
    };
    let direct_bounds = if capture.indexed && capture.geometries.iter().any(|g| g.procedural) {
        Some(upload(
            "MuTracer displacement bounds",
            &read("native-38")?,
            wgpu::BufferUsages::BLAS_INPUT,
        ))
    } else {
        None
    };
    let direct_positions = if capture.indexed && capture.geometries.iter().any(|g| !g.procedural) {
        Some(upload(
            "MuTracer compact positions",
            &read("native-41")?,
            wgpu::BufferUsages::BLAS_INPUT,
        ))
    } else {
        None
    };
    let mut vertices = Vec::new();
    let mut sizes = Vec::new();
    let mut indices = Vec::new();
    let mut blases = Vec::new();
    for (geometry_id, geometry) in capture.geometries.iter().enumerate() {
        let data = if capture.indexed {
            Cow::Borrowed(&[] as &[u8])
        } else {
            read(&geometry.positions)?
        };
        if !capture.indexed
            && data.len()
                != if geometry.procedural {
                    geometry.vertex_count as usize / 3 * 24
                } else {
                    geometry.vertex_count as usize * 12
                }
        {
            return Err("Invalid hardware vertex bytes".into());
        }
        vertices.push(if capture.indexed {
            if geometry.procedural {
                direct_bounds
                    .as_ref()
                    .ok_or("Missing direct AABBs")?
                    .clone()
            } else {
                direct_positions
                    .as_ref()
                    .ok_or("Missing compact positions")?
                    .clone()
            }
        } else {
            upload(&geometry.positions, &data, wgpu::BufferUsages::BLAS_INPUT)
        });
        indices.push(if capture.indexed {
            if geometry.procedural {
                None
            } else {
                direct_blas_indices.clone()
            }
        } else {
            geometry
                .indices
                .as_ref()
                .map(|name| -> Result<wgpu::Buffer> {
                    let data = read(name)?;
                    if data.len() < geometry.vertex_count as usize * 4 {
                        return Err("HWRT explicit index buffer is too short".into());
                    }
                    Ok(upload(
                        &format!("geometry-{geometry_id}:{name}:indices"),
                        &data[..geometry.vertex_count as usize * 4],
                        wgpu::BufferUsages::BLAS_INPUT,
                    ))
                })
                .transpose()?
        });
        let flags = if geometry.non_opaque {
            wgpu::AccelerationStructureGeometryFlags::empty()
        } else {
            wgpu::AccelerationStructureGeometryFlags::OPAQUE
        };
        let descriptors = if geometry.procedural {
            wgpu::BlasGeometrySizeDescriptors::AABBs {
                descriptors: vec![wgpu::BlasAABBGeometrySizeDescriptor {
                    primitive_count: geometry.index_count.unwrap_or(geometry.vertex_count) / 3,
                    flags: wgpu::AccelerationStructureGeometryFlags::empty(),
                }],
            }
        } else {
            wgpu::BlasGeometrySizeDescriptors::Triangles {
                descriptors: vec![wgpu::BlasTriangleGeometrySizeDescriptor {
                    vertex_format: wgpu::VertexFormat::Float32x3,
                    vertex_count: geometry.vertex_count,
                    index_format: geometry.indices.as_ref().map(|_| wgpu::IndexFormat::Uint32),
                    index_count: geometry
                        .indices
                        .as_ref()
                        .map(|_| geometry.index_count.unwrap_or(geometry.vertex_count)),
                    flags,
                }],
            }
        };
        blases.push(device.create_blas(
            &wgpu::CreateBlasDescriptor {
                label: Some("MuTracer hardware BLAS"),
                flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE
                    | if geometry.dynamic {
                        wgpu::AccelerationStructureFlags::ALLOW_UPDATE
                    } else {
                        wgpu::AccelerationStructureFlags::empty()
                    },
                update_mode: if geometry.dynamic {
                    wgpu::AccelerationStructureUpdateMode::PreferUpdate
                } else {
                    wgpu::AccelerationStructureUpdateMode::Build
                },
            },
            descriptors.clone(),
        ));
        sizes.push(descriptors);
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
        .enumerate()
        .map(|(i, ((blas, size), vertex_buffer))| wgpu::BlasBuildEntry {
            blas,
            geometry: match size {
                wgpu::BlasGeometrySizeDescriptors::Triangles { descriptors } => {
                    wgpu::BlasGeometries::TriangleGeometries(vec![wgpu::BlasTriangleGeometry {
                        size: &descriptors[0],
                        vertex_buffer,
                        first_vertex: capture.geometries[i].first_vertex,
                        vertex_stride: capture.geometries[i].vertex_stride,
                        index_buffer: indices[i].as_ref(),
                        first_index: indices[i]
                            .as_ref()
                            .map(|_| capture.geometries[i].index_offset),
                        transform_buffer: None,
                        transform_buffer_offset: None,
                    }])
                }
                wgpu::BlasGeometrySizeDescriptors::AABBs { descriptors } => {
                    wgpu::BlasGeometries::AabbGeometries(vec![wgpu::BlasAabbGeometry {
                        size: &descriptors[0],
                        stride: 24,
                        aabb_buffer: vertex_buffer,
                        primitive_offset: capture.geometries[i].bounds_offset * 24,
                    }])
                }
            },
        })
        .collect();
    let setup_ms = preparation_started.elapsed().as_secs_f64() * 1000.0;
    // All AS input uploads above must complete before the AS wall clock starts.
    // Metal does not expose encoder timestamps through this wgpu version.
    let drain_started = std::time::Instant::now();
    if super::profiling::gpu_enabled() {
        queue.submit([]);
        device.poll(wgpu::PollType::Wait {
            submission_index: None,
            timeout: Some(Duration::from_secs(30)),
        })?;
    }
    let upload_drain_ms = drain_started.elapsed().as_secs_f64() * 1000.0;
    let as_started = std::time::Instant::now();
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
            serde_json::json!({"nativeAsProfile": {"inputSetupMs": setup_ms,"uploadDrainMs":upload_drain_ms,"cpuBuildSubmitMs": build_submit_ms,"completedWallMs": completed_wall_ms,"gpuMs": gpu_ms,"gpuTimestampUnavailable": if super::profiling::gpu_enabled() && timer.is_none() { Some("Encoder timestamp queries unavailable") } else { None },"blasCount": blases.len(),"instanceCount": capture.instances.len(),"vertexUploadBytes": vertices.iter().map(|b| b.size()).sum::<u64>()}})
        );
    }
    let data = read(
        capture
            .triangle_map
            .as_ref()
            .ok_or("Missing HWRT triangle map")?,
    )?;
    let mapping = if let Some(buffer) = direct_indices {
        buffer
    } else {
        upload(
            "MuTracer hardware primitive identity",
            &data,
            wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        )
    };
    if super::profiling::enabled() {
        eprintln!(
            "{}",
            serde_json::json!({"nativeHardwareUploadProfile": {"kind":"geometry","writeBytes":vertices.iter().map(|b| b.size()).sum::<u64>() + data.len() as u64,"instanceCount":capture.instances.len()}})
        );
    }
    drop(upload);
    if super::profiling::enabled() {
        eprintln!(
            "{}",
            serde_json::json!({"nativeHardwareReuseProfile": {"reusedBytes": reused_bytes}})
        );
    }
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
                            if capture.indexed {
                                word(0)
                            } else {
                                u32::from_le_bytes(data[i * 4..i * 4 + 4].try_into().unwrap())
                            },
                        ),
                    )
                })
                .collect()
        });
    Ok(Resources {
        inputs,
        indexed: capture.indexed,
        raw_instances,
        tlas,
        mapping,
        _blases: blases,
        _vertices: vertices,
        _indices: indices,
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
            instances.push(Instance {
                geometry,
                custom_index: i as u32,
                transform: [0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14].map(|k| m[k] as f32),
            });
            mapping.extend(base.to_le_bytes());
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
        if !self.indexed {
            queue.write_buffer(&self.mapping, 0, &plan.mapping);
        }
        let mut encoder = device.create_command_encoder(&Default::default());
        encoder.build_acceleration_structures(
            std::iter::empty::<&wgpu::BlasBuildEntry<'_>>(),
            [&self.tlas],
        );
        queue.submit([encoder.finish()]);
    }
}
// Source-order inputs use the shared TS geometry regions. Leaf-order extraction
// remains available for explicit regression diagnostics; both supply identity
// only, never a software recomputation of a hardware hit or miss.
pub fn capture_from_prepared(
    assets: &mut HashMap<String, Vec<u8>>,
    layout: &NativeLayout,
) -> Result<Capture> {
    if layout.indexed {
        return from_indexed(assets, layout);
    }
    let source = assets
        .get("native-33")
        .ok_or("Missing authoritative HWRT shader")?
        .clone();
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
    let blas_offset = layout.blas_offset;
    let instances = words("native-2")?;
    let bvh = words("native-1")?;
    let attributes = words("native-3")?;
    if layout.attribute_stride_bytes % 4 != 0 || layout.position_offset_bytes % 4 != 0 {
        return Err("Invalid native HWRT attribute alignment".into());
    }
    let stride = layout.attribute_stride_bytes / 4;
    let position = layout.position_offset_bytes / 4;
    if !layout.is_empty && (stride == 0 || instances.len() % 40 != 0) {
        return Err("Invalid native HWRT layout".into());
    }
    let count = if layout.is_empty {
        0
    } else {
        instances.len() / 40
    };
    let mut mapping = vec![0u32; count];
    let mut geometries = Vec::new();
    let mut placements = Vec::new();
    let mut cache = HashMap::new();
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
            let mut bounds = Vec::<u8>::new();
            let mut displaced = false;
            let mut triangle_count = 0u32;
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
                    triangle_count += 1;
                    displaced |= f32::from_bits(instances[id * 40 + 3]).abs() > 0.0
                        && *bvh
                            .get(record * 4 + 3)
                            .ok_or("Missing displacement range")?
                            != 0;
                    for coordinate in [0, 1, 2, 4, 5, 6] {
                        bounds.extend(
                            bvh.get(node * 4 + coordinate)
                                .ok_or("Missing leaf bounds")?
                                .to_le_bytes(),
                        );
                    }
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
                indices: (!displaced).then(|| "native-35".into()),
                vertex_count: triangle_count * 3,
                procedural: displaced,
                non_opaque: layout.has_alpha,
                vertex_stride: 12,
                ..Default::default()
            });
            generated.insert(name, if displaced { bounds } else { positions });
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
        placements.push(Instance {
            geometry,
            custom_index: id as u32,
            transform: [0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14].map(|i| m[i] as f32),
        });
    }
    generated.insert(
        "native-hwrt-map".into(),
        mapping.iter().flat_map(|v| v.to_le_bytes()).collect(),
    );
    generated.insert("native-hwrt-shader".into(), source);
    assets.extend(generated);
    Ok(Capture {
        eligible: true,
        indexed: false,
        authoritative: true,
        reason: None,
        shader: Some("native-hwrt-shader".into()),
        geometries,
        instances: placements,
        triangle_map: Some("native-hwrt-map".into()),
    })
}

// TS supplies merged geometry regions and local displacement AABBs. Rust only
// binds buffers and converts instance matrices for the wgpu API.
fn from_indexed(assets: &mut HashMap<String, Vec<u8>>, layout: &NativeLayout) -> Result<Capture> {
    if layout.position_offset_bytes != 0 || layout.attribute_stride_bytes < 12 {
        return Err("Unsupported HWRT position layout".into());
    }
    let attributes = assets.get("native-3").ok_or("Missing indexed attributes")?;
    if attributes.len() < layout.attribute_stride_bytes && !layout.is_empty {
        return Err("Missing indexed attributes".into());
    }
    let geometries = layout
        .hardware_geometries
        .iter()
        .map(|g| Geometry {
            positions: if g.procedural {
                "native-38"
            } else {
                "native-41"
            }
            .into(),
            indices: (!g.procedural).then(|| "native-42".into()),
            vertex_count: g.index_count,
            first_vertex: g.index_offset,
            index_count: Some(g.index_count),
            index_offset: g.index_offset,
            vertex_stride: 12,
            bounds_offset: g.bounds_offset,
            dynamic: g.dynamic,
            procedural: g.procedural,
            non_opaque: layout.has_alpha,
        })
        .collect();
    let mut instances = Vec::new();
    if !layout.is_empty {
        for (i, record) in assets
            .get("native-2")
            .ok_or("Missing indexed instances")?
            .chunks_exact(160)
            .enumerate()
        {
            let word = |k: usize| u32::from_le_bytes(record[k * 4..k * 4 + 4].try_into().unwrap());
            let geometry = layout
                .hardware_geometries
                .iter()
                .position(|g| g.index_offset / 3 == word(0))
                .ok_or("Missing indexed geometry region")?;
            instances.push(Instance {
                geometry,
                custom_index: i as u32,
                transform: [0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14]
                    .map(|k| f32::from_bits(word(20 + k))),
            });
        }
    }
    Ok(Capture {
        eligible: true,
        authoritative: true,
        indexed: true,
        reason: None,
        shader: Some("native-33".into()),
        geometries,
        instances,
        triangle_map: Some("native-35".into()),
    })
}

// Explicit diagnostic isolation; never called by commit/render entry points.
pub fn isolate_diagnostic(
    capture: &mut Capture,
    assets: &mut HashMap<String, Vec<u8>>,
    instance: u32,
    primitive: Option<usize>,
) -> Result<()> {
    capture.instances.retain(|i| i.custom_index == instance);
    let placement = capture
        .instances
        .first()
        .ok_or("Unknown diagnostic instance")?;
    if let Some(primitive) = primitive {
        let geometry = &mut capture.geometries[placement.geometry];
        if geometry.procedural {
            return Err("Diagnostic isolation expects triangles".into());
        }
        if capture.indexed {
            let base = geometry.index_offset / 3 + primitive as u32;
            geometry.index_offset += primitive as u32 * 3;
            geometry.index_count = Some(3);
            let records = assets
                .get_mut("native-2")
                .ok_or("Missing indexed instances")?;
            records[instance as usize * 160..instance as usize * 160 + 4]
                .copy_from_slice(&base.to_le_bytes());
            return Ok(());
        }
        let source = assets
            .get(&geometry.positions)
            .ok_or("Missing diagnostic vertices")?;
        let vertices = source
            .get(primitive * 36..primitive * 36 + 36)
            .ok_or("Unknown diagnostic primitive")?
            .to_vec();
        assets.insert(geometry.positions.clone(), vertices);
        geometry.vertex_count = 3;
        let name = capture
            .triangle_map
            .as_ref()
            .ok_or("Missing diagnostic mapping")?;
        let old = assets.get(name).ok_or("Missing diagnostic mapping")?;
        let read = |i: usize| u32::from_le_bytes(old[i * 4..i * 4 + 4].try_into().unwrap());
        let record = read(read(instance as usize) as usize + primitive);
        let mut mapping = vec![0u32; instance as usize + 2];
        mapping[instance as usize] = instance + 1;
        mapping[instance as usize + 1] = record;
        assets.insert(
            name.clone(),
            mapping.iter().flat_map(|v| v.to_le_bytes()).collect(),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retired_indices_are_reused_for_every_geometry_size() {
        let Ok(gpu) = crate::GpuDevice::with_backend(1) else {
            return;
        };
        if !gpu.hardware_ray_query {
            return;
        }
        let mut assets = HashMap::new();
        let triangle = [-1f32, 0., 0., 1., 0., 0., 0., 1., 0.];
        assets.insert(
            "a".into(),
            triangle.iter().flat_map(|v| v.to_le_bytes()).collect(),
        );
        assets.insert(
            "b".into(),
            triangle
                .repeat(2)
                .iter()
                .flat_map(|v| v.to_le_bytes())
                .collect(),
        );
        assets.insert(
            "indices".into(),
            (0..6u32).flat_map(u32::to_le_bytes).collect(),
        );
        assets.insert(
            "map".into(),
            [2u32, 3, 10, 11, 12]
                .into_iter()
                .flat_map(u32::to_le_bytes)
                .collect(),
        );
        let capture = Capture {
            eligible: true,
            authoritative: true,
            indexed: false,
            reason: None,
            shader: None,
            triangle_map: Some("map".into()),
            geometries: [3, 6]
                .into_iter()
                .enumerate()
                .map(|(i, count)| Geometry {
                    positions: if i == 0 { "a" } else { "b" }.into(),
                    indices: Some("indices".into()),
                    vertex_count: count,
                    vertex_stride: 12,
                    ..Default::default()
                })
                .collect(),
            instances: (0..2)
                .map(|geometry| Instance {
                    geometry,
                    custom_index: geometry as u32,
                    transform: [1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0.],
                })
                .collect(),
        };
        let first = prepare(
            &gpu.device,
            &gpu.queue,
            Path::new(""),
            &capture,
            Some(&assets),
            None,
        )
        .unwrap();
        gpu.device
            .poll(wgpu::PollType::Wait {
                submission_index: None,
                timeout: Some(Duration::from_secs(30)),
            })
            .unwrap();
        let second = prepare_reusing(
            &gpu.device,
            &gpu.queue,
            Path::new(""),
            &capture,
            Some(&assets),
            None,
            Some(&first.inputs),
        )
        .unwrap();
        gpu.device
            .poll(wgpu::PollType::Wait {
                submission_index: None,
                timeout: Some(Duration::from_secs(30)),
            })
            .unwrap();
        // Both BLASes read the same source index array, with different lengths.
        // A cache keyed only by that source name loses one of these buffers.
        for i in 0..2 {
            assert_eq!(first._indices[i], second._indices[i]);
            assert_eq!(first._vertices[i], second._vertices[i]);
        }
        assert_eq!(first.mapping, second.mapping);
    }
}
