//! Helpers shared by GPU tests.
use crate::GpuDevice;
use std::{sync::mpsc, time::Duration};

/// Reads a colour texture back as tightly packed rows.
pub(crate) fn read_texture(gpu: &GpuDevice, texture: &wgpu::Texture) -> Vec<u8> {
    let bytes = texture.format().block_copy_size(None).unwrap();
    let stride = (texture.width() * bytes).div_ceil(256) * 256;
    let output = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
        size: stride as u64 * texture.height() as u64,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = gpu.device.create_command_encoder(&Default::default());
    encoder.copy_texture_to_buffer(
        texture.as_image_copy(),
        wgpu::TexelCopyBufferInfo {
            buffer: &output,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(stride),
                rows_per_image: Some(texture.height()),
            },
        },
        texture.size(),
    );
    gpu.queue.submit([encoder.finish()]);
    let (tx, rx) = mpsc::channel();
    output
        .slice(..)
        .map_async(wgpu::MapMode::Read, move |result| tx.send(result).unwrap());
    gpu.device
        .poll(wgpu::PollType::Wait {
            submission_index: None,
            timeout: Some(Duration::from_secs(15)),
        })
        .unwrap();
    rx.recv_timeout(Duration::from_secs(5)).unwrap().unwrap();
    let mapped = output.slice(..).get_mapped_range().unwrap();
    mapped
        .chunks_exact(stride as usize)
        .flat_map(|row| row[..(texture.width() * bytes) as usize].iter().copied())
        .collect()
}
