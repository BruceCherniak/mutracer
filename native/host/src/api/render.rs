//! Independent accumulations. The engine prepares its scene once in a shared L0
//! context; each render's L0 context is a target linked to it (S2).
use super::engine::{
    Camera, Engine, EngineEvent, ProgressStage, QUALITY_BEVEL, QUALITY_DISPERSION, State,
    Subscription,
};
use super::{Result, Status, error, l0, l0_blocking, l0_result};
use crate::context::{self, CommitOutcome, CommitPath};
use crate::display::Display as Capture;
use crate::settings::RenderSettings as L0Settings;
use std::path::PathBuf;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
    mpsc,
};
use std::time::{Duration, Instant};

/// L0 limit on accumulated samples per context.
const MAX_TOTAL_SAMPLES: u32 = 4096;
/// L0 limit on samples dispatched by one job poll.
const MAX_BATCH: u32 = 64;

/// Sampling sequence.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum SamplingPattern {
    #[default]
    Sobol,
    ZSobol,
    Random,
}
/// Fixed dimensions or a display-relative scale.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum RenderSize {
    /// Display-relative scale; the size follows [`super::Display::set_size`] at the next refine.
    Scale(f64),
    Fixed {
        width: u32,
        height: u32,
    },
}
impl Default for RenderSize {
    fn default() -> Self {
        Self::Scale(1.)
    }
}
/// Per-render execution and image-quality settings. Defaults match the browser library.
#[derive(Clone, Debug, PartialEq)]
pub struct RenderSettings {
    /// Maximum complete samples, 1–4096. Default 2048. Raising it continues the
    /// accumulation; with [`SamplingPattern::ZSobol`] a change restarts it.
    pub max_samples: u32,
    /// Maximum scattering depth, clamped to 1–20. Default 3.
    pub bounces: u32,
    /// Per-sample radiance clamp; 0 disables it. Default 0.
    pub clamping: f64,
    /// Default [`SamplingPattern::Sobol`].
    pub sampling_pattern: SamplingPattern,
    /// Light candidates per vertex, clamped to 1–16. Default 4.
    pub direct_light_candidates: u32,
    /// Rounded material edges. Default true.
    pub bevel: bool,
    /// Bevel probes, clamped to 1–32. Default 8.
    pub bevel_samples: u32,
    /// Dispersion wavelengths per sample, 1 or 3. Default 3.
    pub dispersion_wavelengths: u32,
    /// Minimum transmissive path alpha. Default 1.
    pub transmissive_output_alpha_min: f64,
    /// Interactive frame budget in milliseconds for [`Render::refine`]. Default 21.
    pub time_budget_ms: f64,
    /// Let one refine submit several samples when the measured sample time fits the
    /// budget. Default false (one sample per refine).
    pub allow_multiple_samples_per_frame: bool,
    /// Size of the image. Default `Scale(1.0)`.
    pub size: RenderSize,
    /// Random sequence seed. Default 12345.
    pub seed: u32,
    /// Adapts the scale of a [`RenderSize::Scale`] render to frame timing, between
    /// `min_scale` and that scale. Default `None`.
    pub adaptive_resolution: Option<AdaptiveResolution>,
}
/// Browser `adaptiveResolution`: after each observed batch the scale moves
/// toward `target_frame_ms`; it grows only after four fast batches, by at most 25%.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AdaptiveResolution {
    /// Positive frame time to aim for, in milliseconds.
    pub target_frame_ms: f64,
    /// Positive lower bound, at most the render's scale.
    pub min_scale: f64,
}
impl Default for RenderSettings {
    fn default() -> Self {
        Self {
            max_samples: 2048,
            bounces: 3,
            clamping: 0.,
            sampling_pattern: SamplingPattern::Sobol,
            direct_light_candidates: 4,
            bevel: true,
            bevel_samples: 8,
            dispersion_wavelengths: 3,
            transmissive_output_alpha_min: 1.,
            time_budget_ms: 21.,
            allow_multiple_samples_per_frame: false,
            size: RenderSize::Scale(1.),
            seed: 12345,
            adaptive_resolution: None,
        }
    }
}
impl RenderSettings {
    pub fn validate(&self) -> Result<()> {
        let invalid = |message: &str| Err(error(Status::InvalidArgument, message));
        if !(1..=MAX_TOTAL_SAMPLES).contains(&self.max_samples) {
            return invalid("max_samples must be 1..4096");
        }
        if self.dispersion_wavelengths != 1 && self.dispersion_wavelengths != 3 {
            return invalid("dispersion_wavelengths must be 1 or 3");
        }
        if !self.clamping.is_finite() || self.clamping < 0. {
            return invalid("clamping must be finite and non-negative");
        }
        if !self.transmissive_output_alpha_min.is_finite() {
            return invalid("transmissive_output_alpha_min must be finite");
        }
        if !self.time_budget_ms.is_finite() || self.time_budget_ms <= 0. {
            return invalid("time_budget_ms must be positive");
        }
        match self.size {
            RenderSize::Scale(scale) if !scale.is_finite() || scale <= 0. => {
                invalid("Resolution scale must be positive")
            }
            RenderSize::Fixed { width, height } if width == 0 || height == 0 => {
                invalid("Fixed width and height must be positive")
            }
            _ => Ok(()),
        }?;
        match (self.adaptive_resolution, self.size) {
            (None, _) => Ok(()),
            (Some(a), RenderSize::Scale(scale))
                if a.target_frame_ms.is_finite()
                    && a.target_frame_ms > 0.
                    && a.min_scale.is_finite()
                    && a.min_scale > 0.
                    && a.min_scale <= scale =>
            {
                Ok(())
            }
            _ => invalid(
                "adaptive_resolution requires a scale-based render with positive target_frame_ms and min_scale <= its scale",
            ),
        }
    }
    /// The L0 sample cap. Only ZSobol depends on it (its Morton sample bits);
    /// Sobol and Random use a fixed cap, so raising `max_samples` continues the
    /// accumulation instead of preparing again, as in the browser library.
    pub(super) fn sample_cap(&self, samples: u32) -> u32 {
        if self.sampling_pattern == SamplingPattern::ZSobol {
            samples
        } else {
            MAX_TOTAL_SAMPLES
        }
    }
    /// The L0 settings record; `cap` and `offset` differ only for converge.
    pub(super) fn l0(&self, cap: u32, offset: u32) -> L0Settings {
        L0Settings {
            sampling_pattern: match self.sampling_pattern {
                SamplingPattern::Sobol => 0,
                SamplingPattern::ZSobol => 1,
                SamplingPattern::Random => 2,
            },
            seed: self.seed,
            max_samples: cap,
            bounces: self.bounces,
            direct_light_candidates: self.direct_light_candidates,
            bevel_samples: self.bevel_samples,
            sample_sequence_offset: offset,
            clamping: self.clamping,
            transmissive_output_alpha_min: self.transmissive_output_alpha_min,
            ..L0Settings::default()
        }
    }
    pub(super) fn quality(&self) -> u32 {
        (if self.bevel { QUALITY_BEVEL } else { 0 })
            | (if self.dispersion_wavelengths == 3 {
                QUALITY_DISPERSION
            } else {
                0
            })
    }
    pub(super) fn resolve_size(&self, display: [u32; 2]) -> [u32; 2] {
        match self.size {
            RenderSize::Fixed { width, height } => [width, height],
            RenderSize::Scale(scale) => display.map(|v| ((v as f64 * scale).round() as u32).max(1)),
        }
    }
}

/// Execution state of one render, matching the browser `RenderStatus`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RenderStatus {
    /// No committed scene yet, or scene preparation is running.
    Preparing,
    /// Reserved: pipeline compilation is currently part of preparation.
    Compiling,
    Converging,
    Denoising,
    Finished,
    Error,
}
/// One complete batch of samples.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SampleEvent {
    /// Complete samples since the last restart.
    pub samples: u32,
    /// Whether this batch is the first after a restart.
    pub is_first_frame: bool,
    /// Wall time from submission to observed completion of the batch.
    pub frame_time_ms: f64,
}
/// Image read by [`Render::read_pixels`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PixelKind {
    Hdr,
    /// Denoised HDR when a denoised image is available, otherwise HDR.
    Denoised,
    Albedo,
    Normal,
}
/// Linear RGBA f32 pixels, top row first.
#[derive(Clone, Debug, PartialEq)]
pub struct Image {
    pub width: u32,
    pub height: u32,
    pub data: Vec<f32>,
}
/// When a render filters its complete samples.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum DenoiseSchedule {
    /// Once, when the render reaches `max_samples`.
    #[default]
    Converged,
    /// At 1 sample, then at twice the last denoised count (at least 4) up to
    /// `max_samples`; after 10 s without a result, at the next sample. Sampling
    /// pauses while a filter runs; the last denoised image stays presented until
    /// the next one.
    Progressive,
    /// After every complete batch; sampling pauses while a filter runs.
    EverySample,
}
/// How a commit reached the published scene.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CommitKind {
    /// Scene preparation from the descriptor.
    Full,
    /// Retained updates of the previous scene.
    Incremental,
}
/// The last finished denoising run.
#[derive(Clone, Debug, PartialEq)]
pub struct DenoiseReport {
    /// Complete samples of the filtered image.
    pub samples: u32,
    /// OIDN device, for example "OIDN Metal" or "OIDN CPU".
    pub backend: String,
    /// Filter wall time, excluding the input readback.
    pub milliseconds: f64,
    /// Load or execution failure; denoising then stops until the denoiser is set again.
    pub error: Option<String>,
}
/// Browser `_nextSampleTarget`: the sample count to trace toward before the next filter.
pub(super) fn sample_target(
    schedule: Option<DenoiseSchedule>,
    samples: u32,
    max_samples: u32,
    denoised: u32,
    since_denoise: Option<Duration>,
) -> u32 {
    match schedule {
        None | Some(DenoiseSchedule::Converged) => max_samples,
        Some(DenoiseSchedule::EverySample) => max_samples.min(samples + 1),
        Some(DenoiseSchedule::Progressive) if denoised == 0 => 1,
        Some(DenoiseSchedule::Progressive)
            if since_denoise.is_some_and(|d| d >= Duration::from_secs(10)) =>
        {
            max_samples.min(samples + 1)
        }
        Some(DenoiseSchedule::Progressive) => max_samples.min(denoised.saturating_mul(2).max(4)),
    }
}
/// Open Image Denoise on a library thread.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct DenoiserOptions {
    /// 0 GPU (Metal/CUDA/HIP) then CPU, 1 CPU, 2 Metal, 3 CUDA, 4 HIP. Default 0.
    pub backend: u32,
    /// OIDN library path. Default the bundled library or `MUTRACER_OIDN_LIBRARY`.
    pub library: Option<PathBuf>,
    /// Default [`DenoiseSchedule::Converged`].
    pub schedule: DenoiseSchedule,
}
/// Cross-thread cancellation for [`Render::converge`].
#[derive(Clone, Debug, Default)]
pub struct CancelToken(Arc<AtomicBool>);
impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConvergeStage {
    Final,
    Denoising,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ConvergeProgress {
    pub stage: ConvergeStage,
    pub samples: u32,
    pub target_samples: u32,
}
/// Deterministic offline rendering options.
pub struct ConvergeOptions {
    /// Final complete samples, 1–4096. Required.
    pub samples: u32,
    /// Camera for this output only. Default the committed engine camera.
    pub camera: Option<Camera>,
    /// Deterministic sequence base. Default 0.
    pub sample_sequence_offset: u32,
    /// Maximum samples per submitted batch, clamped to 1–64. Default 8.
    pub samples_per_batch: u32,
    /// Timeout for preparation and rendering. Default 600000.
    pub timeout_ms: u64,
    /// Called after every complete batch and before denoising. Default none.
    pub on_progress: Option<Box<dyn FnMut(ConvergeProgress) + Send>>,
    /// Default none.
    pub cancel: Option<CancelToken>,
}
impl ConvergeOptions {
    pub fn new(samples: u32) -> Self {
        Self {
            samples,
            camera: None,
            sample_sequence_offset: 0,
            samples_per_batch: 8,
            timeout_ms: 600_000,
            on_progress: None,
            cancel: None,
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ConvergeResult {
    pub samples: u32,
}

/// What a render's L0 context must hold to be current.
#[derive(Clone, PartialEq)]
pub(super) struct TargetKey {
    scene: u64,
    camera: u64,
    size: [u32; 2],
    quality: u32,
    settings: L0Settings,
    camera_override: Option<[u8; 128]>,
}
/// Full preparation of the shared scene on a library thread.
struct Pending {
    revision: u64,
    result: mpsc::Receiver<Result<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}
/// The engine's prepared scene: one L0 context committed with fixed settings,
/// whose 1×1 own target is never rendered. Renders link their targets to it.
#[derive(Default)]
pub(super) struct SharedScene {
    context: Option<u64>,
    /// Scene revision of the published scene.
    published: Option<u64>,
    /// Full preparations published so far.
    generation: u64,
    pending: Option<Pending>,
    failed: Option<(u64, String)>,
}
impl SharedScene {
    /// Destroys the scene context once its preparation has drained; renders first.
    pub(super) fn release(&mut self) {
        let Some(context) = self.context.take() else {
            return;
        };
        if self.pending.is_some() {
            let _ = l0_blocking(|e, n| unsafe { context::mt_context_cancel_commit(context, e, n) });
        }
        let _ = l0_blocking(|e, n| unsafe { context::mt_context_destroy(context, e, n) });
        if let Some(mut pending) = self.pending.take() {
            if let Some(thread) = pending.thread.take() {
                let _ = thread.join();
            }
        }
    }
    pub(super) fn context(&self) -> Option<u64> {
        self.context
    }
}
/// Scene commits use fixed settings; render settings only shape targets.
fn scene_settings() -> L0Settings {
    RenderSettings::default().l0(MAX_TOTAL_SAMPLES, 0)
}
struct Flight {
    job: u64,
    count: u32,
    started: Instant,
    /// Abandoned by a commit or restart; its samples are never counted.
    cancelled: bool,
    /// Resolution scale the batch was traced at.
    scale: f64,
}
/// Browser adaptive-resolution state of one render.
struct Adaptive {
    /// Current scale; the image uses min(scale, the configured scale).
    scale: f64,
    /// The configured scale it was reset to.
    configured: f64,
    fast_frames: u32,
    /// Time and scale of the last observed batch, not yet evaluated.
    frame: Option<(f64, f64)>,
}
impl Adaptive {
    fn new(settings: &RenderSettings) -> Self {
        let configured = match settings.size {
            RenderSize::Scale(scale) => scale,
            RenderSize::Fixed { .. } => 1.,
        };
        Self {
            scale: configured,
            configured,
            fast_frames: 0,
            frame: None,
        }
    }
}
/// Browser `nextPreviewScale`: the scale whose frame time would meet the target,
/// rounded to 1/16 (1/128 below 0.25), kept unless it differs by at least 15%.
pub(super) fn next_preview_scale(
    measured_scale: f64,
    frame_ms: f64,
    target_ms: f64,
    max_scale: f64,
    current_scale: f64,
    min_scale: f64,
) -> f64 {
    let raw = measured_scale * (target_ms / frame_ms.max(0.1)).sqrt();
    let steps = if raw < 0.25 { 128. } else { 16. };
    let next = ((raw * steps).round() / steps)
        .max(min_scale)
        .min(min_scale.max(max_scale));
    if (next / current_scale).ln().abs() >= 1.15f64.ln() {
        next
    } else {
        current_scale
    }
}
/// Pixels or an error, the OIDN device and the filter time in milliseconds.
type DenoiseResult = (std::result::Result<Vec<f32>, String>, String, f64);
#[derive(Default)]
struct Denoise {
    options: Option<DenoiserOptions>,
    /// Kept across `set_denoiser` calls with the same library and backend.
    filter: Arc<Mutex<Option<crate::denoise::Denoiser>>>,
    worker: Option<(u32, mpsc::Receiver<DenoiseResult>)>,
    last: Option<Instant>,
    report: Option<DenoiseReport>,
    /// Samples of the denoised image and its pixels, bottom row first like L0.
    denoised: Option<(u32, Vec<f32>)>,
    failed: bool,
}

pub(super) struct RenderState {
    pub(super) settings: RenderSettings,
    pub(super) fallback: Option<u64>,
    /// L0 context linked as a target to the engine's shared scene.
    context: u64,
    published: Option<TargetKey>,
    /// `SharedScene::generation` of the published target.
    generation: u64,
    failed: Option<(TargetKey, String)>,
    job: Option<Flight>,
    /// Complete samples in the published accumulation.
    samples: u32,
    first_frame: bool,
    sample_ms: Option<f64>,
    pub(super) capture: Option<Capture>,
    capture_key: Option<TargetKey>,
    captured: u32,
    needs_capture: bool,
    status: RenderStatus,
    error: bool,
    busy: bool,
    denoise: Denoise,
    adaptive: Adaptive,
}
impl RenderState {
    /// Image size for a display size: the configured size, scaled down by
    /// adaptive resolution.
    fn image_size(&self, display: [u32; 2]) -> [u32; 2] {
        match (self.settings.adaptive_resolution, self.settings.size) {
            (Some(_), RenderSize::Scale(scale)) => {
                let scale = self.adaptive.scale.min(scale);
                display.map(|v| ((v as f64 * scale).round() as u32).max(1))
            }
            _ => self.settings.resolve_size(display),
        }
    }
    /// Browser `_adaptResolution`, evaluated on the batch observed last.
    fn adapt_resolution(&mut self) {
        let (Some(adaptive), RenderSize::Scale(max_scale)) =
            (self.settings.adaptive_resolution, self.settings.size)
        else {
            return;
        };
        if self.busy || self.samples == 0 {
            return;
        }
        let Some((elapsed, scale)) = self.adaptive.frame.take() else {
            return;
        };
        let next = next_preview_scale(
            scale,
            elapsed,
            adaptive.target_frame_ms,
            max_scale,
            self.adaptive.scale,
            adaptive.min_scale,
        );
        if next > self.adaptive.scale {
            self.adaptive.fast_frames += 1;
            if self.adaptive.fast_frames < 4 {
                return;
            }
            self.adaptive.scale = next.min(self.adaptive.scale * 1.25);
        } else {
            self.adaptive.scale = next;
        }
        self.adaptive.fast_frames = 0;
    }
    /// Destroys the target context once its GPU work has drained.
    pub(super) fn release(mut self) {
        let context = self.context;
        if let Some(flight) = self.job.as_mut() {
            flight.cancelled = true;
            let job = flight.job;
            let _ = l0_blocking(|e, n| unsafe { context::mt_job_cancel(job, e, n) });
        }
        let _ = drain(&mut self);
        let _ = l0_blocking(|e, n| unsafe { context::mt_context_destroy(context, e, n) });
    }
    fn publish(&mut self, key: TargetKey, full: bool) {
        self.published = Some(key);
        self.failed = None;
        self.error = false;
        self.samples = 0;
        self.first_frame = true;
        self.needs_capture = false;
        self.adaptive.frame = None;
        self.status = RenderStatus::Converging;
        if full {
            self.sample_ms = None;
        }
        cancel_denoise(self);
    }
    #[cfg(test)]
    pub(super) fn context(&self) -> u64 {
        self.context
    }
    #[cfg(test)]
    pub(super) fn in_flight(&self) -> bool {
        self.job.is_some()
    }
    /// CPU uploads into the display and whether it shows a denoised image.
    #[cfg(test)]
    pub(super) fn display_uploads(&self) -> (u32, bool) {
        self.capture
            .as_ref()
            .map_or((0, false), |c| (c.uploads, c.using_denoised))
    }
    pub(super) fn presented_samples(&self) -> u32 {
        self.captured
    }
    fn current(&self, state_scene: u64, state_camera: u64) -> bool {
        self.published
            .as_ref()
            .is_some_and(|k| k.scene == state_scene && k.camera == state_camera)
    }
}
fn cancel_denoise(render: &mut RenderState) {
    render.denoise.worker = None;
    render.denoise.denoised = None;
    render.denoise.report = None;
    if let Some(capture) = render.capture.as_mut() {
        capture.original();
    }
}

/// Readiness of one render for presentation (browser `_complete` / `_presentable`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub(super) struct Readiness {
    pub(super) complete: bool,
    pub(super) presentable: bool,
}
pub(super) fn readiness(state: &State, id: u64) -> Readiness {
    let Some(render) = state.renders.get(&id) else {
        return Readiness::default();
    };
    let complete = render.current(state.scene_revision, state.camera_revision)
        && render.capture_key == render.published
        && render.captured > 0;
    let denoise = &render.denoise;
    let presentable = complete
        && (denoise.worker.is_none()
            || denoise.denoised.is_some()
            || (denoise
                .options
                .as_ref()
                .is_some_and(|o| o.schedule == DenoiseSchedule::Converged)
                && render.settings.max_samples > 1));
    Readiness {
        complete,
        presentable,
    }
}

fn desired(state: &State, render: &RenderState) -> Option<TargetKey> {
    state.scene.as_ref()?;
    Some(TargetKey {
        scene: state.scene_revision,
        camera: state.camera_revision,
        size: render.image_size(state.display.size),
        quality: render.settings.quality(),
        settings: render
            .settings
            .l0(render.settings.sample_cap(render.settings.max_samples), 0),
        camera_override: None,
    })
}

/// Called by `Engine::update` for every render.
pub(super) fn synchronize(state: &mut State, id: u64, inputs_changed: bool) {
    if inputs_changed {
        if let Some(render) = state.renders.get_mut(&id) {
            cancel_denoise(render);
        }
    }
    let Some(key) = state.renders.get(&id).and_then(|r| desired(state, r)) else {
        return;
    };
    if state.renders[&id].busy {
        return;
    }
    if let Err(e) = commit(state, id, key, false) {
        state.report(e.message);
    }
}

enum Step {
    Published,
    Waiting,
    /// Reported through an engine error event; `failed` holds the message.
    Failed,
}
/// Bring the render's L0 context to `key`. Returns whether it is published;
/// `false` with `error` set means the commit failed and was reported.
/// Non-blocking callers retry later; blocking callers wait for preparation.
fn commit(state: &mut State, id: u64, key: TargetKey, blocking: bool) -> Result<bool> {
    loop {
        let mut events = Vec::new();
        let step = commit_step(state, id, &key, blocking, &mut events);
        for event in events {
            if let EngineEvent::Error { message } = &event {
                state.last_error = Some(message.clone());
            }
            state.engine_events.push(event);
        }
        match step? {
            Step::Published => return Ok(true),
            Step::Failed => return Ok(false),
            Step::Waiting if !blocking => return Ok(false),
            Step::Waiting => {
                if state.shared.pending.is_none() {
                    std::thread::sleep(Duration::from_micros(200));
                }
            }
        }
    }
}
enum SceneStep {
    Published,
    Waiting,
    Failed(String),
}
/// Brings the shared scene to the engine's scene revision. Incremental commits
/// apply on this thread; full preparation runs on a library thread while the
/// previous scene stays published. After each publication every render's target
/// is set again.
fn scene_step(
    state: &mut State,
    blocking: bool,
    events: &mut Vec<EngineEvent>,
) -> Result<SceneStep> {
    let revision = state.scene_revision;
    let shared = &mut state.shared;
    if let Some(pending) = shared.pending.as_mut() {
        if pending.revision != revision {
            let context = shared.context.unwrap();
            let _ = l0(|e, n| unsafe { context::mt_context_cancel_commit(context, e, n) });
        }
        let received = if blocking {
            pending
                .result
                .recv()
                .map_err(|_| mpsc::TryRecvError::Disconnected)
        } else {
            pending.result.try_recv()
        };
        let outcome = match received {
            Ok(outcome) => outcome,
            Err(mpsc::TryRecvError::Empty) => return Ok(SceneStep::Waiting),
            Err(mpsc::TryRecvError::Disconnected) => Err(error(
                Status::ContextFailed,
                "Scene preparation thread stopped",
            )),
        };
        let mut pending = shared.pending.take().unwrap();
        if let Some(thread) = pending.thread.take() {
            let _ = thread.join();
        }
        match outcome {
            Ok(()) => {
                shared.published = Some(pending.revision);
                shared.failed = None;
                shared.generation += 1;
                events.push(EngineEvent::Progress {
                    stage: ProgressStage::Preparation,
                    progress: 1.,
                });
                refresh_targets(state, events);
            }
            Err(e) if e.status == Status::Cancelled => {}
            Err(e) => {
                shared.failed = Some((pending.revision, e.message.clone()));
                events.push(EngineEvent::Error { message: e.message });
            }
        }
    }
    let shared = &mut state.shared;
    if shared.published == Some(revision) {
        return Ok(SceneStep::Published);
    }
    if let Some((_, message)) = shared.failed.as_ref().filter(|(r, _)| *r == revision) {
        return Ok(SceneStep::Failed(message.clone()));
    }
    if shared.pending.is_some() {
        return Ok(SceneStep::Waiting);
    }
    let context = match shared.context {
        Some(context) => context,
        None => {
            let context = context::create_scene_with_gpu(state.gpu.clone(), state.backend.code())
                .map_err(|e| error(Status::Unavailable, e))?;
            state.shared.context = Some(context);
            context
        }
    };
    // The descriptor as given: its size and quality bits only shape the
    // context's own target, which L0 keeps minimal.
    let bytes = state.scene.clone().expect("committed scene");
    let settings = scene_settings();
    let mut outcome = CommitOutcome::Done;
    let mut message = [0 as std::ffi::c_char; 1024];
    let code = context::commit_path(
        context,
        &bytes,
        &settings,
        CommitPath::IncrementalOnly,
        &mut outcome,
        &mut message,
    );
    match l0_result(code, &message) {
        Ok(()) => match outcome {
            CommitOutcome::Done => {
                state.shared.published = Some(revision);
                state.shared.failed = None;
                refresh_targets(state, events);
                return Ok(SceneStep::Published);
            }
            CommitOutcome::NeedsFull => {}
            // Another engine is preparing; try incrementally after it publishes.
            CommitOutcome::Blocked if !blocking => return Ok(SceneStep::Waiting),
            CommitOutcome::Blocked => {}
        },
        Err(e) if e.status == Status::Busy => return Ok(SceneStep::Waiting),
        Err(e) => {
            state.shared.failed = Some((revision, e.message.clone()));
            events.push(EngineEvent::Error {
                message: e.message.clone(),
            });
            return Ok(SceneStep::Failed(e.message));
        }
    }
    let (send, result) = mpsc::channel();
    let thread = std::thread::Builder::new()
        .name("MuTracer scene preparation".into())
        .spawn(move || {
            let outcome = loop {
                let mut ignored = CommitOutcome::Done;
                let mut message = [0 as std::ffi::c_char; 1024];
                let code = context::commit_path(
                    context,
                    &bytes,
                    &settings,
                    CommitPath::FullOnly,
                    &mut ignored,
                    &mut message,
                );
                match l0_result(code, &message) {
                    Err(e) if e.status == Status::Busy => {
                        std::thread::sleep(Duration::from_micros(200))
                    }
                    result => break result,
                }
            };
            let _ = send.send(outcome);
        })
        .map_err(|e| error(Status::Error, format!("Starting scene preparation: {e}")))?;
    state.shared.pending = Some(Pending {
        revision,
        result,
        thread: Some(thread),
    });
    events.push(EngineEvent::Progress {
        stage: ProgressStage::Preparation,
        progress: 0.,
    });
    Ok(SceneStep::Waiting)
}
/// Sets the target of every render that is not converging on the published scene.
fn refresh_targets(state: &mut State, events: &mut Vec<EngineEvent>) {
    let ids: Vec<u64> = state.renders.keys().copied().collect();
    for id in ids {
        if state.renders[&id].busy {
            continue;
        }
        if let Some(key) = desired(state, &state.renders[&id]) {
            if let Err(e) = target_step(state, id, &key, events) {
                state.renders.get_mut(&id).unwrap().error = true;
                events.push(EngineEvent::Error { message: e.message });
            }
        }
    }
}
/// Links the render's L0 context to the published shared scene with `key`.
fn target_step(
    state: &mut State,
    id: u64,
    key: &TargetKey,
    events: &mut Vec<EngineEvent>,
) -> Result<Step> {
    let scene_context = state.shared.context.expect("published shared scene");
    let generation = state.shared.generation;
    let camera = match key.camera_override.or(state.camera) {
        Some(camera) => camera,
        None => {
            let scene = state.scene.as_ref().expect("committed scene");
            let at = super::engine::camera_offset(scene)?;
            scene[at..at + 128].try_into().unwrap()
        }
    };
    let render = state.renders.get_mut(&id).unwrap();
    if render.published.as_ref() == Some(key) {
        return Ok(Step::Published);
    }
    if render
        .failed
        .as_ref()
        .is_some_and(|(failed, _)| failed == key)
    {
        render.error = true;
        return Ok(Step::Failed);
    }
    render.error = false;
    // An active L0 job blocks setting the target; its samples are never counted.
    if let Some(flight) = render.job.as_mut() {
        flight.cancelled = true;
        let job = flight.job;
        let _ = l0_blocking(|e, n| unsafe { context::mt_job_cancel(job, e, n) });
        drain(render)?;
    }
    let mut message = [0 as std::ffi::c_char; 1024];
    let code = context::set_target(
        render.context,
        scene_context,
        &key.settings,
        key.size,
        key.quality,
        &camera,
        &mut message,
    );
    match l0_result(code, &message) {
        Ok(()) => {
            let full = render.generation != generation
                || render.published.as_ref().is_none_or(|k| k.size != key.size);
            render.generation = generation;
            render.publish(key.clone(), full);
            Ok(Step::Published)
        }
        Err(e) if e.status == Status::Busy => Ok(Step::Waiting),
        Err(e) => {
            render.failed = Some((key.clone(), e.message.clone()));
            render.error = true;
            events.push(EngineEvent::Error { message: e.message });
            Ok(Step::Failed)
        }
    }
}
fn commit_step(
    state: &mut State,
    id: u64,
    key: &TargetKey,
    blocking: bool,
    events: &mut Vec<EngineEvent>,
) -> Result<Step> {
    let render = state.renders.get_mut(&id).unwrap();
    if render
        .failed
        .as_ref()
        .is_none_or(|(failed, _)| failed != key)
    {
        render.error = false;
    }
    match scene_step(state, blocking, events)? {
        SceneStep::Published => {}
        SceneStep::Waiting => return Ok(Step::Waiting),
        SceneStep::Failed(message) => {
            let render = state.renders.get_mut(&id).unwrap();
            render.failed = Some((key.clone(), message));
            render.error = true;
            return Ok(Step::Failed);
        }
    }
    if state.shared.published != Some(key.scene) {
        return Err(error(
            Status::InvalidState,
            "Engine inputs changed during the commit",
        ));
    }
    target_step(state, id, key, events)
}

enum Poll {
    Idle,
    Running,
    /// Completed samples of an uncancelled batch.
    Completed(u32, f64, f64),
}
/// Observes the in-flight batch without waiting for the GPU.
fn poll_job(render: &mut RenderState) -> Result<Poll> {
    let Some(flight) = render.job.as_ref() else {
        return Ok(Poll::Idle);
    };
    let job = flight.job;
    let budget = flight.count.min(MAX_BATCH);
    match l0(|e, n| unsafe { context::mt_job_poll(job, budget, e, n) }) {
        Ok(()) => {}
        Err(e) if e.status == Status::Busy => return Ok(Poll::Running),
        // A publication replaced the job.
        Err(e) if e.status == Status::InvalidHandle && flight.cancelled => {
            render.job = None;
            return Ok(Poll::Idle);
        }
        Err(e) => {
            render.job = None;
            return Err(e);
        }
    }
    let mut info = context::JobInfo {
        struct_size: std::mem::size_of::<context::JobInfo>() as u32,
        state: 0,
        requested_samples: 0,
        submitted_samples: 0,
        completed_samples: 0,
        base_samples: 0,
    };
    match l0(|e, n| unsafe { context::mt_job_info(job, &mut info, e, n) }) {
        Ok(()) => {}
        Err(e) if e.status == Status::Busy => return Ok(Poll::Running),
        Err(e) => {
            render.job = None;
            return Err(e);
        }
    }
    match info.state {
        2 | 3 => {
            let flight = render.job.take().unwrap();
            if flight.cancelled || info.state == 3 {
                return Ok(Poll::Idle);
            }
            Ok(Poll::Completed(
                info.completed_samples,
                flight.started.elapsed().as_secs_f64() * 1e3,
                flight.scale,
            ))
        }
        4 => {
            render.job = None;
            Err(error(Status::ContextFailed, "Native render job failed"))
        }
        _ => Ok(Poll::Running),
    }
}
/// Waits for the in-flight batch, if any.
fn drain(render: &mut RenderState) -> Result<Vec<SampleEvent>> {
    let mut events = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(120);
    while render.job.is_some() {
        if let Some(event) = observe(render)? {
            events.push(event);
        }
        if render.job.is_some() {
            if Instant::now() > deadline {
                return Err(error(Status::Timeout, "Render batch did not complete"));
            }
            std::thread::sleep(Duration::from_micros(100));
        }
    }
    Ok(events)
}
/// Polls the batch and accounts completed samples.
fn observe(render: &mut RenderState) -> Result<Option<SampleEvent>> {
    match poll_job(render)? {
        Poll::Completed(count, elapsed, scale) => {
            render.adaptive.frame = Some((elapsed, scale));
            render.samples += count;
            render.sample_ms = Some(elapsed / count.max(1) as f64);
            render.needs_capture = true;
            let event = SampleEvent {
                samples: render.samples,
                is_first_frame: render.first_frame,
                frame_time_ms: elapsed,
            };
            render.first_frame = false;
            Ok(Some(event))
        }
        _ => Ok(None),
    }
}
fn capture(render: &mut RenderState) -> Result<bool> {
    if !render.needs_capture {
        return Ok(true);
    }
    match context::capture_display(render.context, &mut render.capture) {
        Ok(true) => {
            render.needs_capture = false;
            render.capture_key = render.published.clone();
            render.captured = render.samples;
            // Progressive schedules keep presenting the last denoised image, which
            // the display holds on the GPU since its upload.
            let preserve = render
                .denoise
                .options
                .as_ref()
                .is_some_and(|o| o.schedule != DenoiseSchedule::Converged);
            if let (true, Some(_), Some(capture)) =
                (preserve, &render.denoise.denoised, render.capture.as_mut())
            {
                capture.show_denoised();
            }
            Ok(true)
        }
        Ok(false) => Ok(false),
        Err(message) => Err(error(Status::Error, message)),
    }
}
fn submit(render: &mut RenderState, count: u32) -> Result<()> {
    let mut job = 0;
    let context = render.context;
    match l0(|e, n| unsafe { context::mt_context_submit(context, count, &mut job, e, n) }) {
        Ok(()) => {}
        Err(e) if e.status == Status::Busy => return Ok(()),
        Err(e) => return Err(e),
    }
    let scale = render.adaptive.scale.min(render.adaptive.configured);
    render.job = Some(Flight {
        job,
        count,
        started: Instant::now(),
        cancelled: false,
        scale,
    });
    // Dispatch now; a busy registry dispatches at the next poll instead.
    match l0(|e, n| unsafe { context::mt_job_poll(job, count.min(MAX_BATCH), e, n) }) {
        Err(e) if e.status != Status::Busy => {
            render.job = None;
            Err(e)
        }
        _ => Ok(()),
    }
}
fn batch_size(render: &RenderState, remaining: u32) -> u32 {
    let count = match (
        render.settings.allow_multiple_samples_per_frame,
        render.sample_ms,
    ) {
        (true, Some(ms)) if ms > 0. => {
            ((render.settings.time_budget_ms / ms).floor() as u32).clamp(1, MAX_BATCH)
        }
        _ => 1,
    };
    count.min(remaining).max(1)
}
/// Advances one render by at most one batch toward `limit` without blocking.
fn advance(state: &mut State, id: u64, limit: u32) -> Result<()> {
    if collect(state, id)? {
        submit_toward(state.renders.get_mut(&id).unwrap(), limit)?;
    }
    Ok(())
}
/// Accounts a finished batch and captures it. Returns whether no batch is in
/// flight and the accumulation is captured.
fn collect(state: &mut State, id: u64) -> Result<bool> {
    let render = state.renders.get_mut(&id).unwrap();
    if let Some(event) = observe(render)? {
        state.sample_events.push((id, event));
    }
    let render = state.renders.get_mut(&id).unwrap();
    Ok(render.job.is_none() && capture(render)?)
}
fn submit_toward(render: &mut RenderState, limit: u32) -> Result<()> {
    if render.samples < limit {
        let count = batch_size(render, limit - render.samples);
        submit(render, count)?;
    }
    Ok(())
}
fn read_l0(context: u64, kind: u32) -> Result<Vec<f32>> {
    let mut size = 0;
    l0_blocking(|e, n| unsafe {
        context::mt_context_read_pixels(context, kind, std::ptr::null_mut(), 0, &mut size, e, n)
    })?;
    let mut bytes = vec![0u8; size];
    l0_blocking(|e, n| unsafe {
        context::mt_context_read_pixels(
            context,
            kind,
            bytes.as_mut_ptr(),
            bytes.len(),
            &mut size,
            e,
            n,
        )
    })?;
    Ok(bytes
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
        .collect())
}
fn context_size(context: u64) -> Result<[u32; 2]> {
    let info = context_info(context)?;
    Ok([info.width, info.height])
}
fn context_info(context: u64) -> Result<context::ContextInfo> {
    let mut info = context::ContextInfo {
        struct_size: std::mem::size_of::<context::ContextInfo>() as u32,
        width: 0,
        height: 0,
        samples: 0,
        state: 0,
        last_commit: 0,
    };
    l0_blocking(|e, n| unsafe { context::mt_context_info(context, &mut info, e, n) })?;
    Ok(info)
}
/// L0 images are bottom row first; L1 images are top row first.
pub(super) fn flip_rows(data: &[f32], width: u32, height: u32) -> Vec<f32> {
    let row = width as usize * 4;
    (0..height as usize)
        .rev()
        .flat_map(|y| data[y * row..(y + 1) * row].iter().copied())
        .collect()
}
fn denoised_samples(render: &RenderState) -> u32 {
    render.denoise.denoised.as_ref().map_or(0, |d| d.0)
}
fn next_target(render: &RenderState) -> u32 {
    sample_target(
        render.denoise.options.as_ref().map(|o| o.schedule),
        render.samples,
        render.settings.max_samples,
        denoised_samples(render),
        render.denoise.last.map(|t| t.elapsed()),
    )
}
/// Starts or collects OIDN filtering according to the denoise schedule; `force`
/// filters the current samples whatever the schedule (browser `_maybeDenoise(true)`).
fn denoise(state: &mut State, id: u64, force: bool) -> Result<()> {
    let render = state.renders.get_mut(&id).unwrap();
    let Some(options) = render.denoise.options.clone() else {
        return Ok(());
    };
    if let Some((samples, worker)) = &render.denoise.worker {
        let samples = *samples;
        let (outcome, backend, milliseconds) = match worker.try_recv() {
            Err(mpsc::TryRecvError::Empty) => return Ok(()),
            Ok(result) => result,
            Err(mpsc::TryRecvError::Disconnected) => (
                Err("Denoising thread stopped".to_owned()),
                String::new(),
                0.,
            ),
        };
        render.denoise.worker = None;
        render.denoise.report = Some(DenoiseReport {
            samples,
            backend,
            milliseconds,
            error: outcome.as_ref().err().cloned(),
        });
        match outcome {
            Ok(pixels) => {
                if let Some(capture) = render.capture.as_mut() {
                    capture
                        .upload(&pixels)
                        .map_err(|e| error(Status::Error, e.to_string()))?;
                }
                render.denoise.denoised = Some((samples, pixels));
                render.denoise.last = Some(Instant::now());
            }
            Err(message) => {
                render.denoise.failed = true;
                state.report(message);
            }
        }
        return Ok(());
    }
    let due = force
        || match options.schedule {
            DenoiseSchedule::Converged => render.samples >= render.settings.max_samples,
            DenoiseSchedule::Progressive => render.samples >= next_target(render),
            DenoiseSchedule::EverySample => true,
        };
    if !due
        || render.denoise.failed
        || render.samples == 0
        || render.job.is_some()
        || render.needs_capture
        || denoised_samples(render) == render.samples
    {
        return Ok(());
    }
    let (size, color, normal, albedo) = denoise_inputs(render.context)?;
    let filter = render.denoise.filter.clone();
    let (send, receive) = mpsc::channel();
    std::thread::Builder::new()
        .name("MuTracer OIDN".into())
        .spawn(move || {
            let _ = send.send(run_oidn(&filter, &options, size, &color, &normal, &albedo));
        })
        .map_err(|e| error(Status::Error, format!("Starting denoising: {e}")))?;
    render.denoise.worker = Some((render.samples, receive));
    Ok(())
}
type DenoiseInputs = ([u32; 2], Vec<f32>, Vec<f32>, Vec<f32>);
fn denoise_inputs(context: u64) -> Result<DenoiseInputs> {
    Ok((
        context_size(context)?,
        read_l0(context, 0)?,
        read_l0(context, 1)?,
        read_l0(context, 2)?,
    ))
}
fn run_oidn(
    filter: &Mutex<Option<crate::denoise::Denoiser>>,
    options: &DenoiserOptions,
    size: [u32; 2],
    color: &[f32],
    normal: &[f32],
    albedo: &[f32],
) -> DenoiseResult {
    let mut filter = filter.lock().unwrap_or_else(|e| e.into_inner());
    if filter.is_none() {
        let created = match &options.library {
            Some(path) => crate::denoise::Denoiser::from_library(path, options.backend),
            None => crate::denoise::Denoiser::with_backend(options.backend),
        };
        match created {
            Ok(created) => *filter = Some(created),
            Err(e) => return (Err(format!("{e:#}")), String::new(), 0.),
        }
    }
    let filter = filter.as_mut().unwrap();
    let started = Instant::now();
    let result = filter
        .run(size, color, normal, albedo)
        .map_err(|e| format!("{e:#}"));
    (
        result,
        filter.backend.to_owned(),
        started.elapsed().as_secs_f64() * 1e3,
    )
}

/// One independently configured image and its accumulation, owned by an engine.
/// Dropping a render releases it.
pub struct Render {
    engine: Engine,
    id: u64,
}
impl Render {
    pub fn new(engine: &Engine, settings: RenderSettings) -> Result<Self> {
        settings.validate()?;
        let adaptive = Adaptive::new(&settings);
        let mut state = engine.live()?;
        let context =
            context::create_with_gpu(engine.inner.gpu.clone(), engine.inner.backend.code())
                .map_err(|e| error(Status::Unavailable, e))?;
        let id = state.next_render;
        state.next_render += 1;
        state.renders.insert(
            id,
            RenderState {
                settings,
                fallback: None,
                context,
                published: None,
                generation: 0,
                failed: None,
                job: None,
                samples: 0,
                first_frame: true,
                sample_ms: None,
                capture: None,
                capture_key: None,
                captured: 0,
                needs_capture: false,
                status: RenderStatus::Preparing,
                error: false,
                busy: false,
                denoise: Denoise::default(),
                adaptive,
            },
        );
        Ok(Self {
            engine: engine.clone(),
            id,
        })
    }
    pub(super) fn id(&self) -> u64 {
        self.id
    }
    pub(super) fn engine(&self) -> &Engine {
        &self.engine
    }
    /// Browser `_complete`: a captured image of the current inputs.
    pub(super) fn complete(&self) -> bool {
        readiness(&self.engine.lock(), self.id).complete
    }
    pub(super) fn fallback_id(&self) -> Option<u64> {
        self.get(|_, r| r.fallback).flatten()
    }
    fn with<T>(&self, f: impl FnOnce(&mut State, u64) -> Result<T>) -> Result<T> {
        let result = {
            let mut state = self.engine.live()?;
            if !state.renders.contains_key(&self.id) {
                return Err(error(Status::InvalidHandle, "Render is disposed"));
            }
            f(&mut state, self.id)
        };
        self.engine.flush();
        result
    }
    fn get<T>(&self, f: impl FnOnce(&State, &RenderState) -> T) -> Option<T> {
        let state = self.engine.lock();
        state.renders.get(&self.id).map(|r| f(&state, r))
    }
    pub fn settings(&self) -> Result<RenderSettings> {
        self.with(|state, id| Ok(state.renders[&id].settings.clone()))
    }
    /// Validated, then applied at the next refine or engine update.
    pub fn set_settings(&self, settings: RenderSettings) -> Result<()> {
        settings.validate()?;
        self.with(|state, id| {
            let render = state.renders.get_mut(&id).unwrap();
            // As in the browser, only a new configured scale resets the adaptive one;
            // a new controller drops the batch not yet evaluated.
            if Adaptive::new(&settings).configured != render.adaptive.configured {
                render.adaptive = Adaptive::new(&settings);
            } else if settings.adaptive_resolution != render.settings.adaptive_resolution {
                render.adaptive.frame = None;
                render.adaptive.fast_frames = 0;
            }
            render.settings = settings;
            Ok(())
        })
    }
    /// Single-level fallback presented until this render has a complete image.
    /// It must belong to the same engine and have no fallback of its own. Default none.
    pub fn set_fallback(&self, fallback: Option<&Render>) -> Result<()> {
        if let Some(fallback) = fallback {
            if !Arc::ptr_eq(&fallback.engine.inner, &self.engine.inner) || fallback.id == self.id {
                return Err(error(
                    Status::InvalidArgument,
                    "Fallback must be another render on the same engine",
                ));
            }
        }
        self.with(|state, id| {
            if let Some(fallback) = fallback {
                let target = state
                    .renders
                    .get(&fallback.id)
                    .ok_or_else(|| error(Status::InvalidHandle, "Fallback render is disposed"))?;
                if target.fallback.is_some() {
                    return Err(error(
                        Status::InvalidArgument,
                        "A fallback render cannot have its own fallback",
                    ));
                }
                if state.renders.values().any(|r| r.fallback == Some(id)) {
                    return Err(error(
                        Status::InvalidArgument,
                        "Fallback renders cannot have their own fallback",
                    ));
                }
            }
            state.renders.get_mut(&id).unwrap().fallback = fallback.map(|f| f.id);
            Ok(())
        })
    }
    /// Replaces the denoiser; `None` disables denoising. Default none. A loaded
    /// OIDN device is kept while the library and backend stay the same.
    pub fn set_denoiser(&self, options: Option<DenoiserOptions>) -> Result<()> {
        if let Some(options) = &options {
            if options.backend > 4 {
                return Err(error(Status::InvalidArgument, "Unknown OIDN backend"));
            }
        }
        self.with(|state, id| {
            let render = state.renders.get_mut(&id).unwrap();
            if render.denoise.options == options {
                return Ok(());
            }
            cancel_denoise(render);
            let device = |o: &DenoiserOptions| (o.library.clone(), o.backend);
            let filter = match (&render.denoise.options, &options) {
                (Some(old), Some(new)) if device(old) != device(new) => Default::default(),
                _ => render.denoise.filter.clone(),
            };
            render.denoise = Denoise {
                options,
                filter,
                ..Default::default()
            };
            Ok(())
        })
    }
    /// Advances this render within its frame budget without waiting for the GPU:
    /// collects the finished batch, submits the next one and starts denoising when
    /// converged. Render failures return `Ok(RenderStatus::Error)` and an engine error event.
    pub fn refine(&self) -> Result<RenderStatus> {
        self.with(|state, id| {
            if state.renders[&id].busy {
                return Err(error(
                    Status::InvalidState,
                    "Cannot refine a render while converge is running",
                ));
            }
            match refine(state, id) {
                Ok(status) => Ok(status),
                Err(e) => {
                    let render = state.renders.get_mut(&id).unwrap();
                    render.error = true;
                    render.status = RenderStatus::Error;
                    state.report(e.message);
                    Ok(RenderStatus::Error)
                }
            }
        })
    }
    /// Renders exactly `options.samples` samples, blocking until they complete.
    /// The engine lock is released between batches, so the progress callback may
    /// use the API; refine on this render is rejected meanwhile.
    pub fn converge(&self, mut options: ConvergeOptions) -> Result<ConvergeResult> {
        if !(1..=MAX_TOTAL_SAMPLES).contains(&options.samples) {
            return Err(error(Status::InvalidArgument, "samples must be 1..4096"));
        }
        let started = Instant::now();
        let timeout = Duration::from_millis(options.timeout_ms.max(1));
        let batch = options.samples_per_batch.clamp(1, MAX_BATCH);
        let key = self.with(|state, id| {
            if state.renders[&id].busy {
                return Err(error(Status::InvalidState, "Converge is already running"));
            }
            let mut key = desired(state, &state.renders[&id]).ok_or_else(|| {
                error(
                    Status::InvalidState,
                    "Commit a scene with engine.update() before converge",
                )
            })?;
            let render = state.renders.get_mut(&id).unwrap();
            render.busy = true;
            cancel_denoise(render);
            key.settings = render.settings.l0(
                render.settings.sample_cap(options.samples),
                options.sample_sequence_offset,
            );
            key.camera_override = options.camera.map(|c| c.to_bytes());
            Ok(key)
        })?;
        let result = self.run_converge(&mut options, key, started, timeout, batch);
        let _ = self.with(|state, id| {
            let render = state.renders.get_mut(&id).unwrap();
            render.busy = false;
            match &result {
                Ok(_) => render.status = RenderStatus::Finished,
                Err(_) => {
                    render.status = RenderStatus::Error;
                    // A batch submitted before the failure must not count later.
                    if let Some(flight) = render.job.as_mut() {
                        flight.cancelled = true;
                        let job = flight.job;
                        let _ = l0_blocking(|e, n| unsafe { context::mt_job_cancel(job, e, n) });
                        drain(render)?;
                    }
                    // L0 keeps a cancelled batch that had already finished; the
                    // partial accumulation stays valid for the same key.
                    if render.published.is_some() {
                        render.samples = context_info(render.context)?.samples;
                        render.needs_capture = render.samples > 0;
                    }
                }
            }
            Ok(())
        });
        result
    }
    fn run_converge(
        &self,
        options: &mut ConvergeOptions,
        key: TargetKey,
        started: Instant,
        timeout: Duration,
        batch: u32,
    ) -> Result<ConvergeResult> {
        let target = options.samples;
        let cancel = options.cancel.clone();
        let check = |state: &State| -> Result<()> {
            if cancel.as_ref().is_some_and(|c| c.is_cancelled()) {
                return Err(error(Status::Cancelled, "Convergence cancelled"));
            }
            if started.elapsed() > timeout {
                return Err(error(Status::Timeout, "Timed out rendering convergence"));
            }
            if state.scene_revision != key.scene || state.camera_revision != key.camera {
                return Err(error(
                    Status::InvalidState,
                    "Engine inputs changed during converge",
                ));
            }
            Ok(())
        };
        // Commit (blocking through full preparation), then restart the accumulation.
        self.with(|state, id| {
            check(state)?;
            let render = state.renders.get_mut(&id).unwrap();
            if let Some(flight) = render.job.as_mut() {
                flight.cancelled = true;
            }
            drain(render)?;
            let was_published = render.published.as_ref() == Some(&key);
            if !commit(state, id, key.clone(), true)? {
                let render = &state.renders[&id];
                let message = render.failed.as_ref().map(|f| f.1.clone());
                return Err(error(
                    Status::Error,
                    message.unwrap_or_else(|| "Scene commit failed".into()),
                ));
            }
            let render = state.renders.get_mut(&id).unwrap();
            if was_published {
                let context = render.context;
                l0_blocking(|e, n| unsafe { context::mt_context_reset(context, e, n) })?;
                render.publish(key.clone(), false);
            }
            Ok(())
        })?;
        let mut reported = 0;
        loop {
            let (samples, done) = self.with(|state, id| {
                check(state)?;
                let render = state.renders.get_mut(&id).unwrap();
                if let Some(event) = observe(render)? {
                    state.sample_events.push((id, event));
                }
                let render = state.renders.get_mut(&id).unwrap();
                if render.job.is_none() && render.samples < target {
                    let count = batch.min(target - render.samples);
                    submit(render, count)?;
                }
                Ok((render.samples, render.samples >= target))
            })?;
            if samples != reported {
                reported = samples;
                if let Some(progress) = options.on_progress.as_mut() {
                    progress(ConvergeProgress {
                        stage: ConvergeStage::Final,
                        samples,
                        target_samples: target,
                    });
                }
            }
            if done {
                break;
            }
            std::thread::sleep(Duration::from_micros(100));
        }
        loop {
            let captured = self.with(|state, id| {
                check(state)?;
                capture(state.renders.get_mut(&id).unwrap())
            })?;
            if captured {
                break;
            }
            std::thread::sleep(Duration::from_micros(200));
        }
        let denoise = self.with(|state, id| {
            let render = &state.renders[&id];
            Ok(render.denoise.options.clone().map(|denoiser| {
                (
                    denoiser,
                    render.denoise.filter.clone(),
                    render.context,
                    render.samples,
                )
            }))
        })?;
        if let Some((denoiser, filter, context, samples)) = denoise {
            if let Some(progress) = options.on_progress.as_mut() {
                progress(ConvergeProgress {
                    stage: ConvergeStage::Denoising,
                    samples,
                    target_samples: target,
                });
            }
            let (size, color, normal, albedo) = denoise_inputs(context)?;
            let (outcome, backend, milliseconds) =
                run_oidn(&filter, &denoiser, size, &color, &normal, &albedo);
            let report = DenoiseReport {
                samples,
                backend,
                milliseconds,
                error: outcome.as_ref().err().cloned(),
            };
            let pixels = outcome.map_err(|message| error(Status::Error, message))?;
            self.with(|state, id| {
                check(state)?;
                let render = state.renders.get_mut(&id).unwrap();
                render.denoise.report = Some(report);
                render.denoise.last = Some(Instant::now());
                if let Some(capture) = render.capture.as_mut() {
                    capture
                        .upload(&pixels)
                        .map_err(|e| error(Status::Error, e.to_string()))?;
                }
                render.denoise.denoised = Some((samples, pixels));
                Ok(())
            })?;
        }
        Ok(ConvergeResult { samples: target })
    }
    /// Waits for the in-flight batch, then reads this render's linear RGBA f32
    /// image, top row first. During preparation it reads the previous image.
    pub fn read_pixels(&self, kind: PixelKind) -> Result<Image> {
        self.with(|state, id| {
            let render = state.renders.get_mut(&id).unwrap();
            for event in drain(render)? {
                state.sample_events.push((id, event));
            }
            let render = &state.renders[&id];
            if kind == PixelKind::Denoised {
                if let Some((_, pixels)) = &render.denoise.denoised {
                    {
                        let [width, height] = context_size(render.context)?;
                        return Ok(Image {
                            width,
                            height,
                            data: flip_rows(pixels, width, height),
                        });
                    }
                }
            }
            let code = match kind {
                PixelKind::Hdr | PixelKind::Denoised => 0,
                PixelKind::Normal => 1,
                PixelKind::Albedo => 2,
            };
            let [width, height] = context_size(render.context)?;
            let data = read_l0(render.context, code)?;
            Ok(Image {
                width,
                height,
                data: flip_rows(&data, width, height),
            })
        })
    }
    /// Accounts a finished batch and captures it without submitting another, so a
    /// host can present the last frame before committing new input. Returns
    /// whether no batch is in flight. Does not wait for the GPU.
    pub fn collect(&self) -> Result<bool> {
        self.with(|state, id| collect(state, id))
    }
    /// Filters the complete samples now without tracing, whatever the denoise
    /// schedule, like the browser's filter at the end of `converge`; a host calls
    /// it while it stops refining (for example when paused). Collects a finished
    /// batch first. The filter runs on a library thread; call again to collect its
    /// result, which is then presented like a scheduled one. Returns whether the
    /// denoised image is of the current samples. Needs a denoiser
    /// ([`Render::set_denoiser`]); does not wait for the GPU.
    pub fn denoise_current(&self) -> Result<bool> {
        self.with(|state, id| {
            if state.renders[&id].denoise.options.is_none() || !collect(state, id)? {
                return Ok(false);
            }
            denoise(state, id, true)?;
            let render = &state.renders[&id];
            Ok(render.samples > 0 && denoised_samples(render) == render.samples)
        })
    }
    /// Discards only this render's accumulation and denoised image.
    pub fn restart(&self) -> Result<()> {
        self.with(|state, id| {
            let render = state.renders.get_mut(&id).unwrap();
            if let Some(flight) = render.job.as_mut() {
                flight.cancelled = true;
                let job = flight.job;
                let _ = l0(|e, n| unsafe { context::mt_job_cancel(job, e, n) });
            }
            drain(render)?;
            if render.published.is_some() {
                let context = render.context;
                l0_blocking(|e, n| unsafe { context::mt_context_reset(context, e, n) })?;
                let key = render.published.clone().unwrap();
                render.publish(key, false);
                render.capture_key = None;
            }
            Ok(())
        })
    }
    /// Complete samples of the current inputs; 0 while preparing or stale.
    pub fn samples(&self) -> u32 {
        self.get(|state, r| {
            if r.current(state.scene_revision, state.camera_revision) {
                r.samples
            } else {
                0
            }
        })
        .unwrap_or(0)
    }
    pub fn status(&self) -> RenderStatus {
        self.get(|state, r| {
            if r.error {
                RenderStatus::Error
            } else if !r.current(state.scene_revision, state.camera_revision) {
                RenderStatus::Preparing
            } else {
                r.status
            }
        })
        .unwrap_or(RenderStatus::Error)
    }
    /// Actual width of the published image, else the requested width.
    pub fn width(&self) -> u32 {
        self.size()[0]
    }
    pub fn height(&self) -> u32 {
        self.size()[1]
    }
    fn size(&self) -> [u32; 2] {
        self.get(|state, r| {
            r.published
                .as_ref()
                .map(|k| k.size)
                .unwrap_or_else(|| r.settings.resolve_size(state.display.size))
        })
        .unwrap_or([0, 0])
    }
    pub fn converged(&self) -> bool {
        self.get(|state, r| {
            r.current(state.scene_revision, state.camera_revision)
                && r.samples >= r.settings.max_samples
        })
        .unwrap_or(false)
    }
    /// The last finished denoising run of this render's current inputs.
    pub fn denoise_report(&self) -> Option<DenoiseReport> {
        self.get(|_, r| r.denoise.report.clone()).flatten()
    }
    /// The denoiser configuration. Default none.
    pub fn denoiser(&self) -> Option<DenoiserOptions> {
        self.get(|_, r| r.denoise.options.clone()).flatten()
    }
    /// The intersection backend actually used by the published scene and, for
    /// a software fallback of a hardware engine, the reason.
    pub fn backend(&self) -> Result<(super::Backend, String)> {
        self.with(|state, _| {
            let context = state
                .shared
                .context()
                .ok_or_else(|| error(Status::InvalidState, "No committed scene"))?;
            let mut active = 0;
            let mut reason = [0 as std::ffi::c_char; 512];
            l0_blocking(|e, n| unsafe {
                context::mt_context_backend(
                    context,
                    &mut active,
                    reason.as_mut_ptr(),
                    reason.len(),
                    e,
                    n,
                )
            })?;
            let bytes: Vec<u8> = reason
                .iter()
                .take_while(|c| **c != 0)
                .map(|c| *c as u8)
                .collect();
            let backend = if active == 1 {
                super::Backend::Hardware
            } else {
                super::Backend::Software
            };
            Ok((backend, String::from_utf8_lossy(&bytes).into_owned()))
        })
    }
    /// How the last successful commit reached the published scene, if any. The
    /// scene is shared by the engine's renders; render settings never commit it.
    pub fn last_commit(&self) -> Result<Option<CommitKind>> {
        self.with(|state, _| {
            let Some(context) = state.shared.context() else {
                return Ok(None);
            };
            Ok(match context_info(context)?.last_commit {
                context::COMMIT_FULL => Some(CommitKind::Full),
                context::COMMIT_INCREMENTAL => Some(CommitKind::Incremental),
                _ => None,
            })
        })
    }
    /// Whether OIDN is running on this render's samples.
    pub fn denoising(&self) -> bool {
        self.get(|_, r| r.denoise.worker.is_some()).unwrap_or(false)
    }
    /// Subscribes to completed batches of this render.
    pub fn on_sample(&self, listener: impl FnMut(&SampleEvent) + Send + 'static) -> Subscription {
        self.engine.on_sample(self.id, listener)
    }
}
impl Drop for Render {
    fn drop(&mut self) {
        let removed = {
            let mut state = self.engine.lock();
            for render in state.renders.values_mut() {
                if render.fallback == Some(self.id) {
                    render.fallback = None;
                }
            }
            state.renders.remove(&self.id)
        };
        if let Some(render) = removed {
            render.release();
        }
    }
}

fn refine(state: &mut State, id: u64) -> Result<RenderStatus> {
    let Some(key) = desired(state, &state.renders[&id]) else {
        state.renders.get_mut(&id).unwrap().status = RenderStatus::Preparing;
        return Ok(RenderStatus::Preparing);
    };
    let ready = commit(state, id, key, false)?;
    // The fallback is refined while this render has no complete sample, including
    // while this render prepares.
    let render = &state.renders[&id];
    let can_complete = ready
        && render
            .sample_ms
            .is_some_and(|ms| ms <= render.settings.time_budget_ms);
    if let Some(fallback) = render.fallback {
        if (!ready || render.samples == 0)
            && !can_complete
            && !readiness(state, fallback).complete
            && !state.renders[&fallback].busy
        {
            // A fallback failure is reported but never stops the primary render.
            if let Err(e) = refine_one(state, fallback) {
                state.renders.get_mut(&fallback).unwrap().error = true;
                state.report(e.message);
            }
        }
    }
    if !ready {
        let render = &state.renders[&id];
        return Ok(if render.error {
            RenderStatus::Error
        } else {
            RenderStatus::Preparing
        });
    }
    // Collect the finished batch and start a due filter before tracing further;
    // samples may also have completed in read_pixels since the last refine.
    denoise(state, id, false)?;
    if state.renders[&id].denoise.worker.is_none() && collect(state, id)? {
        denoise(state, id, false)?;
        let render = state.renders.get_mut(&id).unwrap();
        if render.denoise.worker.is_none() {
            let limit = next_target(render);
            submit_toward(render, limit)?;
        }
    }
    let render = state.renders.get_mut(&id).unwrap();
    if render.denoise.worker.is_none() {
        render.adapt_resolution();
    }
    let converged = render.samples >= render.settings.max_samples;
    render.status = match (render.denoise.worker.is_some(), converged) {
        (true, true) => RenderStatus::Denoising,
        (false, true) => RenderStatus::Finished,
        _ => RenderStatus::Converging,
    };
    Ok(render.status)
}
/// One sample of a fallback render.
fn refine_one(state: &mut State, id: u64) -> Result<()> {
    let Some(key) = desired(state, &state.renders[&id]) else {
        return Ok(());
    };
    if commit(state, id, key, false)? {
        advance(state, id, 1)?;
        state.renders.get_mut(&id).unwrap().adapt_resolution();
    }
    Ok(())
}
