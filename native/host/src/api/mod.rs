//! L1 object model matching the browser library: [`Engine`] owns the device and
//! the committed scene/camera, each [`Render`] is an independently configured
//! accumulation and [`Display`] composes, presents and exports images.
//! [`RenderLoop`] implements the browser preview/final policy on top of them;
//! the host calls [`RenderLoop::tick`] each frame while [`RenderLoop::needs_tick`].
//!
//! An engine and its renders/display may be used from any thread, one thread at
//! a time. Full scene preparation and CPU denoising run on library threads.
//! Event/progress callbacks run synchronously on the calling
//! thread inside `update`, `read_depth_samples`, `refine`, `converge` and loop
//! `tick`, and may call back into the API.
//!
//! The L0 context/job API stays available. An engine prepares and holds its scene
//! once, whatever the number of renders; a render holds only its camera, settings
//! uniforms and accumulation, so changing its size or settings, a converge
//! camera or sequence offset never prepares the scene again.
pub(crate) mod abi;
mod custom_denoise;
pub(crate) mod custom_gpu;
#[cfg(test)]
mod custom_gpu_failure_tests;
mod custom_gpu_submission;
#[cfg(test)]
mod custom_gpu_tests;
pub use custom_denoise::{
    CustomDenoiser, DenoiseAov, DenoiseBuffers, DenoiseGpu, DenoiseInput, DenoiseOutput, GpuAov,
};
pub use custom_gpu::{
    DenoiseAcceptance, DenoiseFrameId, DenoiseFrameStatus, DenoiseInputMode, GpuDenoiseInput,
    GpuDenoiseOutput,
};
mod depth;
mod display;
mod engine;
mod post_process;
mod render;
mod render_loop;
mod surface;

pub use crate::device_loss::DeviceLossNotifier;
pub use crate::status::{Status, StatusError as Error};
pub use depth::{DEPTH_SAMPLE_COUNT, DEPTH_SAMPLE_GRID, DepthSampleArea};
pub use display::{
    AovDisplayOptions, AovIdComponent, Channel, Display, DisplaySettings, Presented, ToneMapping,
};
pub use engine::{
    Backend, Camera, Diagnostics, Engine, EngineEvent, EngineInfo, EngineOptions, ProgressStage,
    RenderDiagnostics, Subscription,
};
pub use post_process::{OutputKind, PostProcessContext, PostProcessSubscription};
pub use render::{
    AdaptiveResolution, AlphaBlendStrategy, CancelToken, CommitKind, ConvergeOptions,
    ConvergeProgress, ConvergeResult, ConvergeStage, DENOISE_OIDN_WEBGPU, DenoiseReport,
    DenoiseSchedule, DenoiserOptions, Image, OIDN_WEBGPU_AVAILABLE, PixelKind, Render,
    RenderSettings, RenderSize, RenderStatus, SampleEvent, SamplingPattern,
};
pub use render_loop::{
    LoopRender, LoopSubscription, LoopSync, RenderLoop, RenderLoopOptions, RenderLoopStatus,
    SelectInfo, Selection, SharedSync, SyncActivity, select_default,
};
pub use surface::{SurfaceInfo, SurfaceOptions, SurfaceStatus};

/// Result of a native API call; an error carries a [`Status`] and a message.
pub type Result<T> = std::result::Result<T, Error>;

pub(crate) fn error(status: Status, message: impl Into<String>) -> Error {
    Error {
        status,
        message: message.into(),
    }
}

/// Status code of an L0 call result.
fn status_from(code: i32) -> Status {
    use Status::*;
    [
        Ok,
        Error,
        InvalidArgument,
        InvalidHandle,
        Busy,
        InvalidState,
        FullCommitRequired,
        Cancelled,
        BufferTooSmall,
        ContextFailed,
        Unavailable,
        Timeout,
    ]
    .into_iter()
    .find(|status| *status as i32 == code)
    .unwrap_or(Error)
}
fn l0_result(code: i32, message: &[std::ffi::c_char]) -> Result<()> {
    if code == 0 {
        return Ok(());
    }
    let bytes: Vec<u8> = message
        .iter()
        .take_while(|c| **c != 0)
        .map(|c| *c as u8)
        .collect();
    Err(error(
        status_from(code),
        String::from_utf8_lossy(&bytes).into_owned(),
    ))
}
/// Runs one L0 ABI call with an owned error buffer.
fn l0(operation: impl FnOnce(*mut std::ffi::c_char, usize) -> i32) -> Result<()> {
    let mut message = [0 as std::ffi::c_char; 1024];
    let code = operation(message.as_mut_ptr(), message.len());
    l0_result(code, &message)
}
/// Blocking callers retry L0 registry contention, which lasts one short operation.
fn l0_blocking(mut operation: impl FnMut(*mut std::ffi::c_char, usize) -> i32) -> Result<()> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    loop {
        crate::runtime::check_loss().map_err(|e| error(Status::Unavailable, e.to_string()))?;
        match l0(&mut operation) {
            Err(e) if e.status == Status::Busy && std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_micros(200));
            }
            result => return result,
        }
    }
}

#[cfg(test)]
mod alpha_tests;
#[cfg(test)]
mod depth_tests;
#[cfg(test)]
mod device_loss_tests;
#[cfg(test)]
mod display_effects_tests;
#[cfg(test)]
mod gpu_output_tests;
#[cfg(test)]
mod hdr_tests;
#[cfg(test)]
mod loop_tests;
#[cfg(test)]
mod tests;

#[cfg(test)]
mod backlog_tests;

#[cfg(test)]
mod lifecycle_tests;

#[cfg(test)]
mod aov_tests;

mod temporal;
pub use temporal::{
    TemporalCamera, TemporalCapabilities, TemporalFrame, TemporalGlassCapabilities,
    TemporalGlassCapability, TemporalGlassKind, TemporalGlassMotion, TemporalGuide,
    TemporalMetadata, TemporalPixelRecord, TemporalProjection, TemporalResetReason,
    TemporalSupport, temporal_validity,
};

#[cfg(test)]
mod aov_display_tests;
