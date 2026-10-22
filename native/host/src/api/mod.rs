//! L1 object model matching the browser library: [`Engine`] owns the device and
//! the committed scene/camera, each [`Render`] is an independently configured
//! accumulation and [`Display`] composes, presents and exports images.
//!
//! An engine and its renders/display may be used from any thread, one thread at
//! a time; calls serialize on an internal lock. Full scene preparation and
//! denoising run on library threads. Callbacks run synchronously on the calling
//! thread inside `update`, `refine` and `converge`, after the internal lock is
//! released, so they may call back into the API.
//!
//! The L0 context/job API stays available. In this implementation every render
//! owns one L0 context on the engine device: N renders prepare and hold N copies
//! of the scene, and changing a render's size, sampling pattern, sample cap or
//! bevel samples fully prepares that render again.
mod display;
mod engine;
mod render;

pub use crate::status::{Status, StatusError as Error};
pub use display::{Channel, Display, DisplaySettings, Presented, ToneMapping};
pub use engine::{
    Backend, Camera, Engine, EngineEvent, EngineInfo, EngineOptions, ProgressStage, Subscription,
};
pub use render::{
    CancelToken, ConvergeOptions, ConvergeProgress, ConvergeResult, ConvergeStage, DenoiseSchedule,
    DenoiserOptions, Image, PixelKind, Render, RenderSettings, RenderSize, RenderStatus,
    SampleEvent, SamplingPattern,
};

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
        match l0(&mut operation) {
            Err(e) if e.status == Status::Busy && std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_micros(200));
            }
            result => return result,
        }
    }
}

#[cfg(test)]
mod tests;
