//! Optional GPU timings for the blocking benchmark path. No shader instrumentation.
use super::{Duration, Result, mpsc};
pub(super) fn enabled() -> bool {
    std::env::var_os("MUTRACER_NATIVE_PROFILE").is_some_and(|v| v == "1")
}
pub(super) fn gpu_enabled() -> bool {
    std::env::var_os("MUTRACER_NATIVE_GPU_TIMESTAMPS").is_some_and(|v| v == "1")
}
pub(super) struct GpuTimer {
    queries: wgpu::QuerySet,
    resolved: wgpu::Buffer,
    readback: wgpu::Buffer,
    count: u32,
}
impl GpuTimer {
    pub fn new(device: &wgpu::Device, pairs: u32, encoder: bool) -> Option<Self> {
        let features = device.features();
        if !gpu_enabled()
            || !features.contains(wgpu::Features::TIMESTAMP_QUERY)
            || encoder && !features.contains(wgpu::Features::TIMESTAMP_QUERY_INSIDE_ENCODERS)
        {
            return None;
        }
        let count = pairs * 2;
        Some(Self {
            queries: device.create_query_set(&wgpu::QuerySetDescriptor {
                label: Some("MuTracer optional benchmark timestamps"),
                ty: wgpu::QueryType::Timestamp,
                count,
            }),
            resolved: device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("MuTracer timestamp resolve"),
                size: count as u64 * 8,
                usage: wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC,
                mapped_at_creation: false,
            }),
            readback: device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("MuTracer timestamp readback"),
                size: count as u64 * 8,
                usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            }),
            count,
        })
    }
    pub fn pass(&self, pair: u32) -> wgpu::ComputePassTimestampWrites<'_> {
        wgpu::ComputePassTimestampWrites {
            query_set: &self.queries,
            beginning_of_pass_write_index: Some(pair * 2),
            end_of_pass_write_index: Some(pair * 2 + 1),
        }
    }
    pub fn stamp(&self, encoder: &mut wgpu::CommandEncoder, index: u32) {
        encoder.write_timestamp(&self.queries, index);
    }
    pub fn resolve(&self, encoder: &mut wgpu::CommandEncoder) {
        encoder.resolve_query_set(&self.queries, 0..self.count, &self.resolved, 0);
        encoder.copy_buffer_to_buffer(&self.resolved, 0, &self.readback, 0, self.count as u64 * 8);
    }
    pub fn milliseconds(&self, device: &wgpu::Device, queue: &wgpu::Queue) -> Result<f64> {
        let (sender, receiver) = mpsc::channel();
        self.readback
            .slice(..)
            .map_async(wgpu::MapMode::Read, move |r| {
                let _ = sender.send(r);
            });
        device.poll(wgpu::PollType::Wait {
            submission_index: None,
            timeout: Some(Duration::from_secs(30)),
        })?;
        receiver.recv_timeout(Duration::from_secs(5))??;
        let mapped = self.readback.slice(..).get_mapped_range()?;
        let mut ticks = 0u64;
        for pair in mapped.chunks_exact(16) {
            let begin = u64::from_le_bytes(pair[..8].try_into().unwrap());
            let end = u64::from_le_bytes(pair[8..].try_into().unwrap());
            let elapsed = end.checked_sub(begin).ok_or("Unordered GPU timestamps")?;
            ticks = ticks
                .checked_add(elapsed)
                .ok_or("GPU timestamp sum overflow")?;
        }
        if ticks == 0 {
            return Err("GPU timestamps did not advance".into());
        }
        Ok(ticks as f64 * queue.get_timestamp_period() as f64 / 1e6)
    }
}
