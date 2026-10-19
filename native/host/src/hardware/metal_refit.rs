//! Metal's actual BLAS update path through wgpu's supported HAL interop.
//!
//! wgpu-core 30.0.1 command/ray_tracing.rs::map_blas always encodes Build,
//! including PreferUpdate. Keep complete commits on the normal wgpu path.
//! Opt-in stable-topology edits refit into a separate candidate AS, keeping the
//! accepted source intact. The caller registers the raw build and fences its
//! completion before submitting the high-level TLAS build.
use super::{Geometry, Result};
use wgpu::hal::{self, CommandEncoder as _, Device as _};
type Metal = hal::api::Metal;
pub(super) fn available(device: &wgpu::Device) -> bool {
    // The guard is only inspected and dropped; no HAL resource is destroyed.
    unsafe { device.as_hal::<Metal>() }.is_some()
}

fn with_entries<T>(
    device: &wgpu::Device,
    vertices: &wgpu::Buffer,
    indices: Option<&wgpu::Buffer>,
    geometry: &Geometry,
    body: impl FnOnce(
        &hal::metal::Device,
        &hal::AccelerationStructureEntries<'_, hal::metal::Buffer>,
    ) -> Result<T>,
) -> Result<T> {
    // SAFETY: wgpu's HAL guards share one non-reentrant snatch lock. Take
    // pointers with separate guards, then release each guard before the next.
    // The context registry serializes edits and publication; device, inputs,
    // source/candidate ASes and scratch have live owning handles throughout it.
    // No destroy or resource replacement is allowed until the completion fence.
    // wgpu stores these HAL objects in stable owned resource allocations.
    let device_pointer = {
        let raw = unsafe { device.as_hal::<Metal>() }.ok_or("Metal refit device unavailable")?;
        &*raw as *const hal::metal::Device
    };
    let vertices_pointer = {
        let raw =
            unsafe { vertices.as_hal::<Metal>() }.ok_or("Metal refit vertices unavailable")?;
        &*raw as *const hal::metal::Buffer
    };
    let indices_pointer = indices
        .map(|buffer| {
            let raw =
                unsafe { buffer.as_hal::<Metal>() }.ok_or("Metal refit indices unavailable")?;
            Ok::<_, Box<dyn std::error::Error>>(&*raw as *const hal::metal::Buffer)
        })
        .transpose()?;
    let device = unsafe { &*device_pointer };
    let vertices = unsafe { &*vertices_pointer };
    let indices = indices_pointer.map(|pointer| unsafe { &*pointer });
    let entries = if geometry.procedural {
        hal::AccelerationStructureEntries::AABBs(vec![hal::AccelerationStructureAABBs {
            buffer: Some(vertices),
            offset: geometry.bounds_offset * 24,
            count: geometry.index_count.unwrap_or(geometry.vertex_count) / 3,
            stride: 24,
            flags: wgpu::AccelerationStructureGeometryFlags::empty(),
        }])
    } else {
        hal::AccelerationStructureEntries::Triangles(vec![hal::AccelerationStructureTriangles {
            vertex_buffer: Some(vertices),
            vertex_format: wgpu::VertexFormat::Float32x3,
            first_vertex: geometry.first_vertex,
            vertex_count: geometry.vertex_count,
            vertex_stride: geometry.vertex_stride,
            indices: indices
                .as_ref()
                .map(|buffer| hal::AccelerationStructureTriangleIndices {
                    format: wgpu::IndexFormat::Uint32,
                    buffer: Some(*buffer),
                    offset: geometry.index_offset * 4,
                    count: geometry.index_count.unwrap_or(geometry.vertex_count),
                }),
            transform: None,
            flags: if geometry.non_opaque {
                wgpu::AccelerationStructureGeometryFlags::empty()
            } else {
                wgpu::AccelerationStructureGeometryFlags::OPAQUE
            },
        }])
    };
    body(device, &entries)
}

pub(super) fn scratch_size(
    device: &wgpu::Device,
    vertices: &wgpu::Buffer,
    indices: Option<&wgpu::Buffer>,
    geometry: &Geometry,
    update: bool,
) -> Result<u64> {
    with_entries(device, vertices, indices, geometry, |device, entries| {
        let sizes = unsafe {
            device.get_acceleration_structure_build_sizes(
                &hal::GetAccelerationStructureBuildSizesDescriptor {
                    entries,
                    flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE
                        | wgpu::AccelerationStructureFlags::ALLOW_UPDATE,
                },
            )
        };
        Ok(if update {
            sizes.update_scratch_size
        } else {
            sizes.build_scratch_size
        }
        .max(256)
        .next_multiple_of(256))
    })
}

pub(super) fn encode(
    device: &wgpu::Device,
    encoder: &mut wgpu::CommandEncoder,
    blas: &mut wgpu::Blas,
    source: &mut wgpu::Blas,
    vertices: &wgpu::Buffer,
    indices: Option<&wgpu::Buffer>,
    geometry: &Geometry,
    scratch: &wgpu::Buffer,
) -> Result<()> {
    // Source and destination are different AS allocations, both created with
    // ALLOW_UPDATE and identical geometry sizes. No accepted AS is mutated.
    // Same context-lock/lifetime preconditions as with_entries: guards may not nest.
    let source_pointer = {
        let raw = unsafe { source.as_hal::<Metal>() }.ok_or("Metal source BLAS unavailable")?;
        &*raw as *const hal::metal::AccelerationStructure
    };
    let destination_pointer = {
        let raw = unsafe { blas.as_hal::<Metal>() }.ok_or("Metal refit BLAS unavailable")?;
        &*raw as *const hal::metal::AccelerationStructure
    };
    let scratch_pointer = {
        let raw = unsafe { scratch.as_hal::<Metal>() }.ok_or("Metal refit scratch unavailable")?;
        &*raw as *const hal::metal::Buffer
    };
    let raw_source = unsafe { &*source_pointer };
    let raw_blas = unsafe { &*destination_pointer };
    let scratch = unsafe { &*scratch_pointer };
    with_entries(device, vertices, indices, geometry, |_device, entries| {
        // This is a fresh encoder used only through HAL. Inputs and scratch are
        // retained by Resources until the blocking edit's GPU completion fence.
        // The caller drains input uploads before this encoder and waits for its
        // completion before any high-level TLAS build. Queue order alone did not
        // reliably make replacement BLAS contents visible in the Metal tests.
        unsafe {
            encoder.as_hal_mut::<Metal, _, _>(|encoder| {
                let encoder = encoder.ok_or("Metal refit encoder unavailable")?;
                encoder.build_acceleration_structures(
                    1,
                    [hal::BuildAccelerationStructureDescriptor {
                        entries,
                        mode: hal::AccelerationStructureBuildMode::Update,
                        flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE
                            | wgpu::AccelerationStructureFlags::ALLOW_UPDATE,
                        source_acceleration_structure: Some(raw_source),
                        destination_acceleration_structure: raw_blas,
                        scratch_buffer: scratch,
                        scratch_buffer_offset: 0,
                    }],
                );
                Ok(())
            })
        }
    })
}

// Read-only Metal sizing queries use with_entries' owning-handle lifetime.
// These report required internal AS storage separately from application buffers.
pub(super) fn storage_bytes(
    device: &wgpu::Device,
    vertices: &[wgpu::Buffer],
    indices: &[Option<wgpu::Buffer>],
    geometries: &[Geometry],
    instances: u32,
) -> Result<u64> {
    let mut bytes = 0;
    for ((geometry, vertices), indices) in geometries.iter().zip(vertices).zip(indices) {
        bytes += with_entries(
            device,
            vertices,
            indices.as_ref(),
            geometry,
            |device, entries| {
                Ok(unsafe {
                    device.get_acceleration_structure_build_sizes(
                        &hal::GetAccelerationStructureBuildSizesDescriptor {
                            entries,
                            flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
                        },
                    )
                }
                .acceleration_structure_size)
            },
        )?;
    }
    // Metal requires an instance-buffer handle even for this read-only size
    // query. Its contents are never submitted or included in upload payload.
    let query_buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("AS sizing query instances"),
        size: (instances as u64
            * std::mem::size_of::<objc2_metal::MTLIndirectAccelerationStructureInstanceDescriptor>()
                as u64)
            .max(4),
        usage: wgpu::BufferUsages::BLAS_INPUT,
        mapped_at_creation: false,
    });
    let buffer_pointer = {
        let raw = unsafe { query_buffer.as_hal::<Metal>() }
            .ok_or("Metal AS sizing buffer unavailable")?;
        &*raw as *const hal::metal::Buffer
    };
    let raw = unsafe { device.as_hal::<Metal>() }.ok_or("Metal AS sizing unavailable")?;
    let entries =
        hal::AccelerationStructureEntries::Instances(hal::AccelerationStructureInstances {
            buffer: Some(unsafe { &*buffer_pointer }),
            offset: 0,
            count: instances,
        });
    bytes += unsafe {
        raw.get_acceleration_structure_build_sizes(
            &hal::GetAccelerationStructureBuildSizesDescriptor {
                entries: &entries,
                flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
            },
        )
    }
    .acceleration_structure_size;
    Ok(bytes)
}
