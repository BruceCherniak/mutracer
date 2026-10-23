use super::CancelToken;

/// Owned linear RGBA32F images, bottom row first. RGB color is a raw per-sample
/// average (including background); alpha is path coverage. Guides match L0 AOVs.
pub struct DenoiseInput {
    /// Width and height in pixels.
    pub size: [u32; 2],
    /// RGBA color, `width * height * 4` floats.
    pub color: Vec<f32>,
    /// Normal guide, same layout.
    pub normal: Vec<f32>,
    /// Albedo guide, same layout.
    pub albedo: Vec<f32>,
    /// Opt-in copies on the rendering device, STORAGE | COPY_SRC buffers.
    pub buffers: Option<DenoiseBuffers>,
    /// Cloned rendering device for optional GPU filtering. Input is read back
    /// before dispatch; opt-in buffers upload on the worker. Never destroy the device.
    pub device: wgpu::Device,
    /// Queue access for GPU filtering on `device`.
    pub gpu: DenoiseGpu,
}
/// Owned copies with the same layout as CPU inputs. Do not destroy these buffers
/// while submitted work still uses them; submit through DenoiseGpu.
pub struct DenoiseBuffers {
    pub color: wgpu::Buffer,
    pub normal: wgpu::Buffer,
    pub albedo: wgpu::Buffer,
}
/// Submission access coordinated with window reconfiguration.
pub struct DenoiseGpu(pub(crate) crate::GpuQueue);
impl DenoiseGpu {
    /// Submits command buffers on the rendering queue, coordinated with window
    /// reconfiguration.
    pub fn submit(
        &self,
        commands: impl IntoIterator<Item = wgpu::CommandBuffer>,
    ) -> wgpu::SubmissionIndex {
        self.0.submit(commands)
    }
    /// Queues a buffer write on the rendering queue.
    pub fn write_buffer(&self, buffer: &wgpu::Buffer, offset: u64, data: &[u8]) {
        self.0.write_buffer(buffer, offset, data);
    }
}
/// Filtered image returned by [`CustomDenoiser::denoise`].
pub enum DenoiseOutput {
    /// Exactly width*height*4 finite values, same orientation and alpha semantics.
    Cpu(Vec<f32>),
    /// Same layout in a COPY_SRC buffer on the input device, at offset zero.
    /// Submit all writes before returning; ownership transfers to the worker.
    Gpu(wgpu::Buffer),
}
/// User filter invoked on detached library threads. Calls may overlap after
/// cancellation/replacement. Keep all referenced resources owned by this object.
/// Cancellation is cooperative: API cancellation/destruction never joins a
/// callback, and cancelled results are discarded. A stuck callback keeps its
/// inputs and Arc alive; hosts must stop it before unloading callback code.
pub trait CustomDenoiser: Send + Sync + 'static {
    /// Default false. True additionally uploads CPU inputs as GPU storage buffers
    /// on the worker. This is a readback+upload path, with extra memory/copy cost.
    fn gpu_inputs(&self) -> bool {
        false
    }
    /// Filters one image on a library thread and returns the same size and
    /// layout, or an error message. Poll `cancel` to stop early; results of
    /// cancelled calls are discarded.
    fn denoise(
        &self,
        input: DenoiseInput,
        cancel: CancelToken,
    ) -> std::result::Result<DenoiseOutput, String>;
}

pub(super) fn validate(pixels: Vec<f32>, size: [u32; 2]) -> std::result::Result<Vec<f32>, String> {
    if pixels.len() != size[0] as usize * size[1] as usize * 4
        || pixels.iter().any(|v| !v.is_finite())
    {
        return Err("Custom denoiser must return finite RGBA pixels of the input size".into());
    }
    Ok(pixels)
}

// User Drop/release code is as unbounded as the filter call itself. Retire its
// final API-owned reference off-thread too, including failed registration.
#[derive(Default)]
pub(super) struct Filter(pub Option<std::sync::Arc<dyn CustomDenoiser>>);
impl Drop for Filter {
    fn drop(&mut self) {
        if let Some(filter) = self.0.take() {
            std::thread::spawn(move || drop(filter));
        }
    }
}
