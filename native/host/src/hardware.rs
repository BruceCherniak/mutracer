use serde::Deserialize;
use std::{fs, path::Path, sync::mpsc, time::Duration};
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
}

pub fn prepare(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    directory: &Path,
    capture: &Capture,
) -> Result<Resources> {
    if !capture.eligible {
        return Err(capture
            .reason
            .clone()
            .unwrap_or("Unsupported hardware capture".into())
            .into());
    }
    let mut vertices = Vec::new();
    let mut sizes = Vec::new();
    let mut blases = Vec::new();
    for geometry in &capture.geometries {
        let data = fs::read(directory.join(&geometry.positions))?;
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
    let mut encoder = device.create_command_encoder(&Default::default());
    encoder.build_acceleration_structures(entries.iter(), [&tlas]);
    queue.submit([encoder.finish()]);
    let data = fs::read(
        directory.join(
            capture
                .triangle_map
                .as_ref()
                .ok_or("Missing HWRT triangle map")?,
        ),
    )?;
    let mapping = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("MuTracer hardware primitive identity"),
        contents: &data,
        usage: wgpu::BufferUsages::STORAGE,
    });
    let counters = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("MuTracer hardware query counts"),
        size: 44,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    Ok(Resources {
        tlas,
        mapping,
        counters,
        _blases: blases,
        _vertices: vertices,
    })
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
