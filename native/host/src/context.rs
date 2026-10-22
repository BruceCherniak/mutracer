//! Context operations serialize publication; candidate preparation runs outside the registry lock.
use super::*;
use std::{
    panic::AssertUnwindSafe,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

struct Context {
    gpu: GpuDevice,
    backend: u32,
    render_seed: u32,
    render_bounces: f32,
    fallback_reason: String,
    scene: Option<GpuScene>,
    spare_buffers: HashMap<usize, wgpu::Buffer>,
    spare_hardware: HashMap<hardware::HardwareBufferId, wgpu::Buffer>,
    failed: bool,
    job: Option<RenderJob>,
    commit: Option<Arc<PendingCommit>>,
    /// Descriptor of the committed scene; incremental commits diff against it.
    descriptor: Option<Arc<Vec<u8>>>,
    /// Path of the last successful commit (`mt_commit_kind`).
    last_commit: u32,
}
struct PendingCommit {
    cancelled: AtomicBool,
    finished: Mutex<bool>,
    completed: std::sync::Condvar,
}
impl PendingCommit {
    fn new() -> Self {
        Self {
            cancelled: AtomicBool::new(false),
            finished: Mutex::new(false),
            completed: std::sync::Condvar::new(),
        }
    }
    fn wait(&self) {
        let mut finished = self.finished.lock().unwrap();
        while !*finished {
            finished = self.completed.wait(finished).unwrap();
        }
    }
}
struct Completion(Arc<PendingCommit>);
impl Drop for Completion {
    fn drop(&mut self) {
        *self.0.finished.lock().unwrap() = true;
        self.0.completed.notify_all();
    }
}
#[derive(Clone, Copy, PartialEq)]
#[repr(u32)]
enum JobState {
    Queued = 0,
    Running = 1,
    Complete = 2,
    Cancelled = 3,
    Failed = 4,
    Cancelling = 5,
}
struct Flight {
    end: u32,
    done: Arc<AtomicBool>,
}
struct RenderJob {
    id: u64,
    base: u32,
    requested: u32,
    submitted: u32,
    completed: u32,
    state: JobState,
    cancelled: bool,
    flight: Option<Flight>,
}
impl RenderJob {
    fn active(&self) -> bool {
        matches!(
            self.state,
            JobState::Queued | JobState::Running | JobState::Cancelling
        )
    }
}
fn idle(context: &Context) -> Result<()> {
    if !context.failed && context.job.as_ref().is_some_and(|j| j.active()) {
        return Err(fail(
            Status::InvalidState,
            "Context has an active render job; cancel and poll it first",
        ));
    }
    Ok(())
}
struct Registry {
    next: u64,
    contexts: HashMap<u64, Context>,
}
static REGISTRY: Mutex<Option<Registry>> = Mutex::new(None);
// The context an ABI call resolved, and whether it was already failed then.
thread_local! { static TOUCHED: std::cell::Cell<Option<(u64, bool)>> = const { std::cell::Cell::new(None) }; }

/// `mt_commit_kind` values reported in `ContextInfo::last_commit`.
pub const COMMIT_NONE: u32 = 0;
pub const COMMIT_FULL: u32 = 1;
pub const COMMIT_INCREMENTAL: u32 = 2;
/// `mt_context_snapshot` size before `last_commit` was appended.
const CONTEXT_INFO_ABI2_SIZE: usize = 20;
#[repr(C)]
#[derive(Clone, Copy)]
pub struct ContextInfo {
    pub struct_size: u32,
    pub width: u32,
    pub height: u32,
    pub samples: u32,
    pub state: u32,
    pub last_commit: u32,
}
fn action(
    error: *mut c_char,
    capacity: usize,
    operation: impl FnOnce(&mut Registry) -> Result<()>,
) -> i32 {
    let result = platform_scope(|| -> Result<()> {
        let mut slot = REGISTRY.try_lock().map_err(|error| match error {
            std::sync::TryLockError::WouldBlock => fail(Status::Busy, "Context registry is active"),
            std::sync::TryLockError::Poisoned(_) => "Context registry is poisoned".into(),
        })?;
        let registry = slot.get_or_insert_with(|| Registry {
            next: 1,
            contexts: HashMap::new(),
        });
        // Catch while guards remain in scope, avoiding mutex poisoning.
        TOUCHED.set(None);
        match std::panic::catch_unwind(AssertUnwindSafe(|| operation(registry))) {
            Ok(Ok(())) => Ok(()),
            // An unclassified error that left a healthy context failed came from
            // execution after validation; report the state change it caused.
            Ok(Err(error)) => {
                let newly_failed = TOUCHED.get().is_some_and(|(id, was_failed)| {
                    !was_failed && registry.contexts.get(&id).is_some_and(|c| c.failed)
                });
                if newly_failed && classify(error.as_ref(), Status::Error) == Status::Error {
                    Err(fail(Status::ContextFailed, error.to_string()))
                } else {
                    Err(error)
                }
            }
            Err(_) => {
                match TOUCHED
                    .get()
                    .and_then(|(id, _)| registry.contexts.get_mut(&id))
                {
                    Some(context) => {
                        context.failed = true;
                        Err(fail(
                            Status::ContextFailed,
                            "Native context operation panicked; context marked failed",
                        ))
                    }
                    None => Err("Native context operation panicked".into()),
                }
            }
        }
    });
    write_result(error, capacity, result)
}
fn write_result(error: *mut c_char, capacity: usize, result: Result<()>) -> i32 {
    match result {
        Ok(()) => status::write(error, capacity, Status::Ok, ""),
        Err(e) => status::write(
            error,
            capacity,
            classify(e.as_ref(), Status::Error),
            &e.to_string(),
        ),
    }
}
// Probes have their own owned inputs and use the same dedicated AOT runtime.
pub(super) fn check_owner() -> Result<()> {
    Ok(())
}
fn context(registry: &mut Registry, handle: u64) -> Result<&mut Context> {
    let context = registry
        .contexts
        .get_mut(&handle)
        .ok_or_else(|| fail(Status::InvalidHandle, "Invalid or destroyed native context"))?;
    if TOUCHED.get().is_none() {
        TOUCHED.set(Some((handle, context.failed)));
    }
    Ok(context)
}

fn ready(context: &mut Context) -> Result<&mut GpuScene> {
    if context.failed {
        return Err(fail(
            Status::InvalidState,
            "Scene failed; commit a new scene before rendering or reading",
        ));
    }
    context
        .scene
        .as_mut()
        .ok_or_else(|| fail(Status::InvalidState, "No committed scene"))
}
// Direct AS preparation deliberately omits the software BVH. Re-run the shared
// TS preparation only when hardware capture/upload fails, replacing its retained
// state too so later edits operate on the same representation as the fallback.
fn prepare_software_fallback(
    bytes: &[u8],
    mut scene: Scene,
    assets: &mut Assets,
    retained: &mut scene::PreparedState,
) -> Result<Scene> {
    if scene
        .native_layout
        .as_ref()
        .is_some_and(|layout| layout.indexed)
        || !assets.contains_key(&AssetId::Packet(30))
    {
        let settings = retained.settings;
        let (software, software_assets, software_retained) =
            scene::prepare_retained_with_settings(bytes, false, 0, &settings)?;
        *assets = software_assets;
        *retained = software_retained;
        Ok(software)
    } else {
        scene.hwrt = None;
        Ok(scene)
    }
}

// C pointer ownership and structure sizes are specified in mutracer-context.h.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_context_create(
    output: *mut u64,
    error: *mut c_char,
    capacity: usize,
) -> i32 {
    unsafe { mt_context_create_with_backend(1, output, error, capacity) }
}
/// Backend 0=software, 1=HWRT with reported software fallback.
/// Rust embedding bridge: presentation and tracing share the caller's device.
/// Request the adapter limits and optional ray-query feature when creating it.
pub fn create_on_device(
    adapter: &wgpu::Adapter,
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    backend: u32,
) -> std::result::Result<u64, String> {
    create_on_device_with_gate(adapter, device, queue, backend, None)
}
/// Shared-device embedding with an optional presentation submission gate.
pub fn create_on_device_with_gate(
    adapter: &wgpu::Adapter,
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    backend: u32,
    gate: Option<Arc<submission::SubmissionGate>>,
) -> std::result::Result<u64, String> {
    if backend > 1 {
        return Err("Unknown native intersection backend".into());
    }
    let gpu = GpuDevice {
        device: device.clone(),
        queue: GpuQueue::new(queue.clone(), gate),
        info: adapter.get_info(),
        hardware_ray_query: device
            .features()
            .contains(wgpu::Features::EXPERIMENTAL_RAY_QUERY),
        pipelines: Arc::new(Mutex::new(HashMap::new())),
        pipeline_cache: None,
    };
    let mut slot = REGISTRY.lock().map_err(|_| "Context registry poisoned")?;
    let registry = slot.get_or_insert_with(|| Registry {
        next: 1,
        contexts: HashMap::new(),
    });
    let handle = registry.next;
    registry.next = handle.checked_add(1).ok_or("Context handles exhausted")?;
    registry.contexts.insert(
        handle,
        Context {
            gpu,
            backend,
            render_seed: 12345,
            render_bounces: 6.,
            fallback_reason: String::new(),
            scene: None,
            spare_buffers: HashMap::new(),
            spare_hardware: HashMap::new(),
            failed: false,
            job: None,
            commit: None,
            descriptor: None,
            last_commit: COMMIT_NONE,
        },
    );
    Ok(handle)
}
/// Capture the last completed accumulation without a CPU image readback.
/// A busy publication returns false so the UI can retain its stable old frame.
pub fn capture_display(
    handle: u64,
    display: &mut Option<crate::display::Display>,
) -> std::result::Result<bool, String> {
    let Ok(mut slot) = REGISTRY.try_lock() else {
        return Ok(false);
    };
    let registry = slot.as_mut().ok_or("No context registry")?;
    let state = context(registry, handle).map_err(|e| e.to_string())?;
    let scene = ready(state).map_err(|e| e.to_string())?;
    if scene.samples == 0 {
        return Ok(false);
    }
    let size = [scene.scene.width, scene.scene.height];
    if display
        .as_ref()
        .is_none_or(|d| d.size != size || d.owner != handle)
    {
        // Resource IDs from independent wgpu Instances can compare equal.
        // Native context handles are process-unique and own a fixed device.
        let mut next = crate::display::Display::new(scene.gpu.clone(), size);
        next.owner = handle;
        *display = Some(next);
    }
    display.as_mut().unwrap().capture(
        &scene.buffers[&scene.scene.color_output],
        &scene.buffers[&scene.scene.normal_output.ok_or("No normal output")?],
        &scene.buffers[&scene.scene.albedo_output.ok_or("No albedo output")?],
        scene.samples,
    );
    Ok(true)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_context_create_with_backend(
    backend: u32,
    output: *mut u64,
    error: *mut c_char,
    capacity: usize,
) -> i32 {
    action(error, capacity, |registry| {
        if output.is_null() {
            return Err(fail(Status::InvalidArgument, "Null context output"));
        }
        unsafe {
            *output = 0;
        }
        let handle = registry.next;
        let next = handle
            .checked_add(1)
            .ok_or("Native context handles exhausted")?;
        if backend > 1 {
            return Err(fail(
                Status::InvalidArgument,
                "Unknown native intersection backend",
            ));
        }
        let gpu = GpuDevice::with_backend(backend)
            .map_err(|e| fail(Status::Unavailable, format!("GPU device unavailable: {e}")))?;
        registry.contexts.insert(
            handle,
            Context {
                gpu,
                backend,
                render_seed: 12345,
                render_bounces: 6.,
                fallback_reason: String::new(),
                scene: None,
                spare_buffers: HashMap::new(),
                spare_hardware: HashMap::new(),
                failed: false,
                job: None,
                commit: None,
                descriptor: None,
                last_commit: COMMIT_NONE,
            },
        );
        registry.next = next;
        unsafe {
            *output = handle;
        }
        Ok(())
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_context_destroy(
    handle: u64,
    error: *mut c_char,
    capacity: usize,
) -> i32 {
    let mut pending = None;
    let status = action(error, capacity, |registry| {
        let current = context(registry, handle)?;
        idle(current)?;
        pending = current.commit.clone();
        if let Some(commit) = &pending {
            commit.cancelled.store(true, Ordering::Release);
        }
        registry
            .contexts
            .remove(&handle)
            .ok_or("Invalid or destroyed native context")?;
        Ok(())
    });
    if status == 0 {
        if let Some(commit) = pending {
            commit.wait();
        }
        runtime::init(); // All root releases precede this owned barrier message.
    }
    status
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_context_commit(
    handle: u64,
    input: *const u8,
    length: usize,
    error: *mut c_char,
    capacity: usize,
) -> i32 {
    unsafe {
        mt_context_commit_with_settings(
            handle,
            input,
            length,
            &settings::RenderSettings::default(),
            error,
            capacity,
        )
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_context_commit_with_settings(
    handle: u64,
    input: *const u8,
    length: usize,
    settings: *const settings::RenderSettings,
    error: *mut c_char,
    capacity: usize,
) -> i32 {
    platform_scope(|| unsafe {
        commit_with_settings(handle, input, length, settings, error, capacity)
    })
}

unsafe fn commit_with_settings(
    handle: u64,
    input: *const u8,
    length: usize,
    settings: *const settings::RenderSettings,
    error: *mut c_char,
    capacity: usize,
) -> i32 {
    // Caller buffers are borrowed only by this synchronous invocation. Every
    // runtime message owns its input; the registry is free during preparation.
    if settings.is_null() || input.is_null() || length > scene::MAX_BYTES {
        return write_result(
            error,
            capacity,
            Err(fail(
                Status::InvalidArgument,
                "Null or oversized scene/settings input",
            )),
        );
    }
    let settings = unsafe { *settings };
    let bytes = unsafe { std::slice::from_raw_parts(input, length) };
    let mut snapshot = None;
    let cancel = Arc::new(PendingCommit::new());
    let _completion = Completion(cancel.clone());
    // Incremental attempt: like full preparation, the sync runs outside the registry
    // lock while the context is marked preparing, so render, poll, cancel and
    // destroy stay available. Only the retained GPU updates hold the lock.
    let mut candidate = None;
    let status = action(error, capacity, |registry| {
        let preparing = registry.contexts.values().any(|c| c.commit.is_some());
        let context = context(registry, handle)?;
        if context.commit.is_some() {
            return Err(fail(
                Status::InvalidState,
                "Scene commit is already preparing",
            ));
        }
        if !preparing {
            candidate = incremental_candidate(context, bytes, &settings);
            if candidate.is_some() {
                context.commit = Some(cancel.clone());
            }
        }
        Ok(())
    });
    if status != 0 {
        return status;
    }
    if let Some((retained, previous)) = candidate {
        // The TS core trusts validated descriptors only. Validation and sync
        // failures fall through to full preparation, which reports them.
        let started = std::time::Instant::now();
        // Records identical to the validated previous descriptor skip element scans.
        let unchanged = commit_plan::unchanged_records(&previous, bytes);
        let hinted = started.elapsed();
        let valid = scene::validate_changed(bytes, &unchanged).is_ok();
        let validated = started.elapsed();
        // One copy of the caller's descriptor serves the sync and, once applied, the context.
        let next = Arc::new(bytes.to_vec());
        let copied = started.elapsed();
        let sync = valid
            .then(|| {
                retained
                    .sync(previous.clone(), next.clone(), unchanged)
                    .ok()
            })
            .flatten();
        let synced = started.elapsed();
        let steps = sync.and_then(|sync| commit_plan::plan(&previous, bytes, &sync));
        let planned = started.elapsed();
        let mut finished = false;
        let status = action(error, capacity, |registry| {
            let context = context(registry, handle).or_else(|error| {
                cancelled(&cancel)?;
                Err(error)
            })?;
            context.commit = None;
            if let Err(error) = cancelled(&cancel) {
                retained.reset_sync()?;
                return Err(error);
            }
            match &steps {
                Some(steps) => finished = apply_incremental(context, &retained, &next, steps)?,
                None => retained.reset_sync()?,
            }
            if crate::profiling::enabled() {
                let ms = |d: std::time::Duration| d.as_secs_f64() * 1e3;
                native_log!(
                    "{}",
                    serde_json::json!({"nativeCommitProfile": {"bytes": bytes.len(),
                    "hintMs": ms(hinted), "validateMs": ms(validated - hinted), "copyMs": ms(copied - validated), "syncMs": ms(synced - copied),
                    "planMs": ms(planned - synced), "applyMs": ms(started.elapsed() - planned),
                    "steps": steps.as_ref().map(Vec::len), "incremental": finished}})
                );
            }
            Ok(())
        });
        if status != 0 || finished {
            return status;
        }
    }
    let status = action(error, capacity, |registry| {
        let context = context(registry, handle)?;
        if context.commit.is_some() {
            return Err(fail(
                Status::InvalidState,
                "Scene commit is already preparing",
            ));
        }
        snapshot = Some(CommitSnapshot {
            gpu: context.gpu.clone(),
            backend: context.backend,
            spare_buffers: std::mem::take(&mut context.spare_buffers),
            spare_hardware: std::mem::take(&mut context.spare_hardware),
        });
        context.commit = Some(cancel.clone());
        Ok(())
    });
    if status != 0 {
        return status;
    }
    let snapshot = snapshot.unwrap();
    let outcome = std::panic::catch_unwind(AssertUnwindSafe(|| -> Result<_> {
        let result = (|| -> Result<_> {
            let profile = std::env::var_os("MUTRACER_NATIVE_PROFILE").is_some_and(|v| v == "1");
            let started = Instant::now();
            let (mut scene, mut assets, mut retained) = scene::prepare_retained_with_settings(
                bytes,
                snapshot.backend == 1
                    && snapshot.gpu.hardware_ray_query
                    && hardware::direct_input_enabled(),
                snapshot.backend,
                &settings,
            )
            .map_err(rejected)?;
            cancelled(&cancel)?;
            let prepared = Instant::now();
            let uniform = assets
                .get(&AssetId::Packet(7))
                .ok_or("Missing normalized render settings")?;
            let seed = u32::from_le_bytes(
                uniform[layout::ray_uniform::SEQUENCE_SEED..layout::ray_uniform::SEQUENCE_SEED + 4]
                    .try_into()?,
            );
            let bounces = i32::from_le_bytes(
                uniform[layout::ray_uniform::BOUNCES..layout::ray_uniform::BOUNCES + 4]
                    .try_into()?,
            ) as f32;

            let mut options = RenderOptions {
                seed,
                bounces,
                ..Default::default()
            };
            let mut fallback_reason = String::new();
            if snapshot.backend != 0 {
                let capture = if snapshot.gpu.hardware_ray_query {
                    hardware::capture_from_resources(
                        &mut assets,
                        scene
                            .native_layout
                            .as_ref()
                            .ok_or("Missing native HWRT metadata")?,
                    )
                } else {
                    Err("Hardware ray queries unavailable on this device".into())
                };
                match capture {
                    Ok(capture) => {
                        scene.hwrt = Some(capture);
                        options.flags |= 4;
                    }
                    Err(error) => {
                        fallback_reason = error.to_string();
                        scene =
                            prepare_software_fallback(bytes, scene, &mut assets, &mut retained)?;
                    }
                }
            }
            cancelled(&cancel)?;
            let hardware_prepared = Instant::now();
            let mut software_scene = scene.clone();
            software_scene.hwrt = None;
            let candidate = GpuScene::new_reusing(
                scene,
                &options,
                &assets,
                snapshot.gpu.clone(),
                Some(&snapshot.spare_buffers),
                Some(&snapshot.spare_hardware),
            );
            let mut candidate = match candidate {
                Ok(candidate) => candidate,
                Err(error) if snapshot.backend == 1 && options.flags & 4 != 0 => {
                    fallback_reason = format!("HWRT upload unavailable: {error}");
                    let software_scene = prepare_software_fallback(
                        bytes,
                        software_scene,
                        &mut assets,
                        &mut retained,
                    )?;
                    GpuScene::new_reusing(
                        software_scene,
                        &RenderOptions {
                            flags: 0,
                            ..options
                        },
                        &assets,
                        snapshot.gpu.clone(),
                        Some(&snapshot.spare_buffers),
                        Some(&snapshot.spare_hardware),
                    )?
                }
                Err(error) => return Err(error),
            };
            if profile {
                // Host setup includes uploads, AS creation, bindings and validation.
                // Pipeline time is a subset; retries remain included in setup time.
                native_log!(
                    "{}",
                    serde_json::json!({
                        "nativeCommitProfile": {
                            "cpuPrepareMs": prepared.duration_since(started).as_secs_f64() * 1000.0,
                            "hardwareCaptureMs": hardware_prepared.duration_since(prepared).as_secs_f64() * 1000.0,
                            "gpuSetupMs": hardware_prepared.elapsed().as_secs_f64() * 1000.0,
                            "pipelineMs": candidate.compile_seconds * 1000.0,
                            "totalMs": started.elapsed().as_secs_f64() * 1000.0,
                            "uploadRetried": fallback_reason.starts_with("HWRT upload unavailable:"),
                        }
                    })
                );
            }
            cancelled(&cancel)?;
            candidate.retained = Some(retained);
            Ok((candidate, seed, bounces, fallback_reason))
        })();
        // write_buffer queues staging allocations until the next submission.
        // Flush even rejected/cancelled candidates; a client need not render.
        snapshot.gpu.queue.submit([]);
        snapshot.gpu.device.poll(wgpu::PollType::Poll)?;
        result
    }));
    let panicked = outcome.is_err();
    let result = outcome.unwrap_or_else(|_| {
        Err(fail(
            Status::ContextFailed,
            "Native commit preparation panicked; context marked failed",
        ))
    });
    // Publication waits for any currently executing ABI operation, but never
    // holds the registry while waiting for CPU preparation. Cancellation wins
    // until this point; after publication the new scene is committed atomically.
    let mut slot = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
    let registry = slot.as_mut().expect("initialized context registry");
    let result = std::panic::catch_unwind(AssertUnwindSafe(|| -> Result<()> {
        // Destroy cancels a pending commit before removing its context.
        let context = context(registry, handle).or_else(|error| {
            cancelled(&cancel)?;
            Err(error)
        })?;
        context.commit = None;
        if panicked {
            context.failed = true;
        }
        let (candidate, seed, bounces, fallback_reason) = result?;
        cancelled(&cancel)?;
        // A pending render batch owns the old scene until its fence completes.
        if let Some(job) = context.job.as_mut() {
            if job.active() {
                job.cancelled = true;
                while job_active(context) {
                    advance_job(context, 0)?;
                    std::thread::yield_now();
                }
            }
        }
        let previous = context.scene.replace(candidate);
        if let Some(previous) = previous {
            context.spare_buffers = previous.buffers;
            context.spare_hardware = previous.hardware.map_or_else(HashMap::new, |h| h.inputs);
        }
        context.render_seed = seed;
        context.render_bounces = bounces;
        context.fallback_reason = fallback_reason;
        context.descriptor = Some(Arc::new(bytes.to_vec()));
        context.last_commit = COMMIT_FULL;
        context.job = None;
        context.failed = false;
        Ok(())
    }))
    .unwrap_or_else(|_| {
        if let Some(context) = registry.contexts.get_mut(&handle) {
            context.failed = true;
            context.commit = None;
        }
        Err(fail(
            Status::ContextFailed,
            "Native commit publication panicked; context marked failed",
        ))
    });

    drop(slot);
    write_result(error, capacity, result)
}
/// State an incremental commit needs, or None when only full preparation applies.
fn incremental_candidate(
    context: &Context,
    bytes: &[u8],
    settings: &settings::RenderSettings,
) -> Option<(scene::PreparedState, Arc<Vec<u8>>)> {
    if context.failed || bytes.len() % 4 != 0 {
        return None;
    }
    let retained = context.scene.as_ref()?.retained.clone()?;
    if retained.settings != *settings {
        return None;
    }
    Some((retained, context.descriptor.clone()?))
}
/// Applies planned retained updates. Ok(false) leaves the scene for full preparation.
fn apply_incremental(
    context: &mut Context,
    retained: &scene::PreparedState,
    descriptor: &Arc<Vec<u8>>,
    steps: &[commit_plan::Step],
) -> Result<bool> {
    // As with full publication, an unfinished job is cancelled and drained first.
    if let Some(job) = context.job.as_mut() {
        if job.active() {
            job.cancelled = true;
            while job_active(context) {
                advance_job(context, 0)?;
                std::thread::yield_now();
            }
        }
    }
    for step in steps {
        let (input, length) = match step {
            commit_plan::Step::Geometry(b)
            | commit_plan::Step::Transform(b)
            | commit_plan::Step::Material(b)
            | commit_plan::Step::Light(b)
            | commit_plan::Step::Environment(b)
            | commit_plan::Step::Camera(b)
            | commit_plan::Step::LightList(b)
            | commit_plan::Step::InstanceColors(b)
            | commit_plan::Step::Atlas(b) => (b.as_ptr(), b.len()),
        };
        let applied = unsafe {
            match step {
                commit_plan::Step::Geometry(_) => update_geometry_in(context, input, length),
                commit_plan::Step::Transform(_) => update_transform_in(context, input, length),
                commit_plan::Step::Material(_) => update_material_in(context, input, length),
                commit_plan::Step::Light(_) => update_light_in(context, input, length),
                commit_plan::Step::Environment(_) => update_environment_in(context, input, length),
                commit_plan::Step::Camera(_) => update_camera_in(context, input, length),
                commit_plan::Step::LightList(bytes) => update_light_list_in(context, bytes),
                commit_plan::Step::InstanceColors(bytes) => {
                    update_instance_colors_in(context, bytes)
                }
                commit_plan::Step::Atlas(bytes) => update_atlas_in(context, bytes),
            }
        };
        match applied {
            Ok(()) => {}
            // Full preparation follows. Earlier steps already changed the scene, so
            // the descriptor no longer describes it if that preparation is rejected.
            Err(error)
                if classify(error.as_ref(), Status::Error) != Status::ContextFailed
                    && !context.failed =>
            {
                retained.reset_sync()?;
                context.descriptor = None;
                return Ok(false);
            }
            Err(error) => return Err(error),
        }
    }
    // A commit always restarts accumulation, including an identical descriptor;
    // every retained update step already did.
    if steps.is_empty() {
        context.failed = true;
        context.scene.as_mut().unwrap().reset_raw()?;
        context.failed = false;
    }
    retained.accept_sync()?;
    context.descriptor = Some(descriptor.clone());
    context.last_commit = COMMIT_INCREMENTAL;
    context.job = None;
    Ok(true)
}
struct CommitSnapshot {
    gpu: GpuDevice,
    backend: u32,
    spare_buffers: HashMap<usize, wgpu::Buffer>,
    spare_hardware: HashMap<hardware::HardwareBufferId, wgpu::Buffer>,
}
fn cancelled(cancel: &PendingCommit) -> Result<()> {
    if cancel.cancelled.load(Ordering::Acquire) {
        Err(fail(Status::Cancelled, "Scene commit cancelled"))
    } else {
        Ok(())
    }
}
fn job_active(context: &Context) -> bool {
    context.job.as_ref().is_some_and(|j| j.active())
}
/// Request cancellation. The synchronous committing caller drains preparation
/// and releases the private candidate before returning; the old scene survives.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_context_cancel_commit(
    handle: u64,
    error: *mut c_char,
    capacity: usize,
) -> i32 {
    action(error, capacity, |registry| {
        if let Some(cancel) = &context(registry, handle)?.commit {
            cancel.cancelled.store(true, Ordering::Release);
        }
        Ok(())
    })
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_context_render(
    handle: u64,
    additional: u32,
    error: *mut c_char,
    capacity: usize,
) -> i32 {
    action(error, capacity, |registry| {
        let context = context(registry, handle)?;
        idle(context)?;
        let scene = ready(context)?;
        if additional == 0 || additional > 4096 - scene.samples {
            return Err(fail(
                Status::InvalidArgument,
                "Total samples must be 1..4096",
            ));
        }
        context.job = None;
        context.failed = true;
        context.scene.as_mut().unwrap().add_samples(
            additional,
            context.render_bounces,
            context.render_seed,
        )?;
        context.failed = false;
        Ok(())
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_context_reset(handle: u64, error: *mut c_char, capacity: usize) -> i32 {
    action(error, capacity, |registry| {
        let context = context(registry, handle)?;
        idle(context)?;
        ready(context)?;
        context.failed = true;
        context.scene.as_mut().unwrap().reset_raw()?;
        context.job = None;
        context.failed = false;
        Ok(())
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_context_wait(
    handle: u64,
    timeout_ms: u32,
    error: *mut c_char,
    capacity: usize,
) -> i32 {
    action(error, capacity, |registry| {
        let context = context(registry, handle)?;
        idle(context)?;
        let scene = ready(context)?;
        // UINT32_MAX (MT_WAIT_INDEFINITELY) waits without a deadline.
        let timeout = (timeout_ms != u32::MAX).then(|| Duration::from_millis(timeout_ms.into()));
        match scene.gpu.device.poll(wgpu::PollType::Wait {
            submission_index: None,
            timeout,
        }) {
            Ok(_) => Ok(()),
            Err(wgpu::PollError::Timeout) => Err(fail(
                Status::Timeout,
                "Submitted GPU work did not complete before the timeout",
            )),
            Err(error) => Err(error.into()),
        }
    })
}
/// Validated camera update on an idle context; used by incremental commit.
unsafe fn update_camera_in(context: &mut Context, input: *const u8, length: usize) -> Result<()> {
    let scene = ready(context)?;
    if input.is_null() || length != 128 {
        return Err(fail(
            Status::InvalidArgument,
            "Camera descriptor must contain exactly 128 bytes",
        ));
    }
    let bytes = unsafe { std::slice::from_raw_parts(input, length) };
    let packed =
        scene::prepare_camera(bytes, scene.scene.width, scene.scene.height).map_err(rejected)?;
    context.failed = true;
    context.scene.as_mut().unwrap().update_camera(&packed)?;
    context.job = None;
    context.failed = false;
    Ok(())
}
/// Validated material update on an idle context; used by incremental commit.
unsafe fn update_material_in(context: &mut Context, input: *const u8, length: usize) -> Result<()> {
    let scene = ready(context)?;
    if input.is_null() || length != 48 {
        return Err(fail(
            Status::InvalidArgument,
            "Material descriptor must contain exactly 48 bytes",
        ));
    }
    let bytes = unsafe { std::slice::from_raw_parts(input, length) };
    let packed = scene
        .retained
        .as_ref()
        .ok_or("No retained material preparation")?
        .material(bytes)
        .map_err(rejected)?;
    context.failed = true;
    context.scene.as_mut().unwrap().update_material(&packed)?;
    context.job = None;
    context.failed = false;
    Ok(())
}
/// Validated environment update on an idle context; used by incremental commit.
unsafe fn update_environment_in(
    context: &mut Context,
    input: *const u8,
    length: usize,
) -> Result<()> {
    let scene = ready(context)?;
    if input.is_null() || length < 48 || length > scene::MAX_BYTES {
        return Err(fail(
            Status::InvalidArgument,
            "Invalid environment descriptor length",
        ));
    }
    let bytes = unsafe { std::slice::from_raw_parts(input, length) };
    let packed = scene
        .retained
        .as_ref()
        .ok_or("No retained environment preparation")?
        .environment(bytes)
        .map_err(rejected)?;
    scene.validate_lighting(&packed)?;
    context.failed = true;
    context.scene.as_mut().unwrap().update_lighting(&packed)?;
    context
        .scene
        .as_ref()
        .unwrap()
        .retained
        .as_ref()
        .unwrap()
        .accept_lighting()?;
    context.job = None;
    context.failed = false;
    Ok(())
}
/// Validated geometry update on an idle context; used by incremental commit.
unsafe fn update_geometry_in(context: &mut Context, input: *const u8, length: usize) -> Result<()> {
    let scene = ready(context)?;
    if input.is_null() || length < 16 || length > scene::MAX_BYTES {
        return Err(fail(
            Status::InvalidArgument,
            "Invalid geometry update length",
        ));
    }
    let bytes = unsafe { std::slice::from_raw_parts(input, length) };
    let packed = scene
        .retained
        .as_ref()
        .ok_or("No retained geometry preparation")?
        .geometry(bytes)
        .map_err(rejected)?;
    scene.validate_lighting(&packed)?;
    let hardware = scene.prepare_geometry_hardware(&packed)?;
    context.failed = true;
    let scene = context.scene.as_mut().unwrap();
    if let Some((resources, capture, group, attributes)) = hardware {
        if let Some(buffer) = attributes {
            scene.buffers.insert(3, buffer);
        }
        scene.hardware = Some(resources);
        scene.scene.hwrt = Some(capture);
        scene.groups[0] = group;
    }
    scene.update_lighting(&packed)?;
    scene.retained.as_ref().unwrap().accept_geometry()?;
    context.job = None;
    context.failed = false;
    Ok(())
}
/// Validated transform update on an idle context; used by incremental commit.
unsafe fn update_transform_in(
    context: &mut Context,
    input: *const u8,
    length: usize,
) -> Result<()> {
    let scene = ready(context)?;
    if input.is_null() || length != 80 {
        return Err(fail(
            Status::InvalidArgument,
            "Transform descriptor must contain exactly 80 bytes",
        ));
    }
    let bytes = unsafe { std::slice::from_raw_parts(input, length) };
    let packed = scene
        .retained
        .as_ref()
        .ok_or("No retained transform preparation")?
        .transform(bytes)
        .map_err(rejected)?;
    apply_instance_writes(context, &packed)
}
/// Material table and atlas repack after texture edits (incremental commit only).
fn update_atlas_in(context: &mut Context, bytes: &[u8]) -> Result<()> {
    let scene = ready(context)?;
    let retained = scene
        .retained
        .clone()
        .ok_or("No retained material preparation")?;
    let packed = retained.atlas(bytes).map_err(rejected)?;
    scene.validate_lighting(&packed)?;
    context.failed = true;
    context.scene.as_mut().unwrap().update_lighting(&packed)?;
    retained.accept_lighting()?;
    context.job = None;
    context.failed = false;
    Ok(())
}
/// Instance color update for one batch (incremental commit only).
fn update_instance_colors_in(context: &mut Context, bytes: &[u8]) -> Result<()> {
    let scene = ready(context)?;
    let packed = scene
        .retained
        .as_ref()
        .ok_or("No retained transform preparation")?
        .instance_colors(bytes)
        .map_err(rejected)?;
    apply_instance_writes(context, &packed)
}
/// Applies prepared TLAS, instance and lighting writes, then accepts the transform stage.
fn apply_instance_writes(context: &mut Context, packed: &scene::LightingUpdates) -> Result<()> {
    let scene = ready(context)?;
    scene.validate_lighting(packed)?;
    let hardware = scene
        .hardware
        .as_ref()
        .map(|hw| hw.transform_plan(scene.scene.hwrt.as_ref().unwrap(), packed))
        .transpose()?;
    context.failed = true;
    let scene = context.scene.as_mut().unwrap();
    if let Some(plan) = hardware {
        scene.hardware.as_mut().unwrap().update_transforms(
            &scene.gpu.device,
            &scene.gpu.queue,
            plan,
            scene.scene.hwrt.as_mut().unwrap(),
        )?;
    }
    scene.update_lighting(packed)?;
    scene.retained.as_ref().unwrap().accept_transform()?;
    context.job = None;
    context.failed = false;
    Ok(())
}
/// Validated light update on an idle context; used by incremental commit.
unsafe fn update_light_in(context: &mut Context, input: *const u8, length: usize) -> Result<()> {
    let scene = ready(context)?;
    if input.is_null() || length != 128 {
        return Err(fail(
            Status::InvalidArgument,
            "Light descriptor must contain exactly 128 bytes",
        ));
    }
    let bytes = unsafe { std::slice::from_raw_parts(input, length) };
    let packed = scene
        .retained
        .as_ref()
        .ok_or("No retained light preparation")?
        .light(bytes)
        .map_err(rejected)?;
    scene.validate_lighting(&packed)?;
    context.failed = true;
    context.scene.as_mut().unwrap().update_lighting(&packed)?;
    context
        .scene
        .as_ref()
        .unwrap()
        .retained
        .as_ref()
        .unwrap()
        .accept_lighting()?;
    context.job = None;
    context.failed = false;
    Ok(())
}
/// Replaces the analytic light list from a validated full descriptor.
fn update_light_list_in(context: &mut Context, bytes: &[u8]) -> Result<()> {
    let scene = ready(context)?;
    let retained = scene
        .retained
        .clone()
        .ok_or("No retained light preparation")?;
    let packed = retained.light_list(bytes)?;
    scene.validate_lighting(&packed)?;
    context.failed = true;
    context.scene.as_mut().unwrap().update_lighting(&packed)?;
    retained.accept_lighting()?;
    retained.set_light_count(u32::from_le_bytes(
        bytes[layout::header::LIGHT_COUNT * 4..][..4].try_into()?,
    ) as usize);
    context.job = None;
    context.failed = false;
    Ok(())
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_context_info(
    handle: u64,
    info: *mut ContextInfo,
    error: *mut c_char,
    capacity: usize,
) -> i32 {
    action(error, capacity, |registry| {
        let context = context(registry, handle)?;
        // ABI 2 snapshots end before last_commit; they receive the fields they have.
        let size = if info.is_null() {
            0
        } else {
            (unsafe { (*info).struct_size }) as usize
        };
        if size != std::mem::size_of::<ContextInfo>() && size != CONTEXT_INFO_ABI2_SIZE {
            return Err(fail(Status::InvalidArgument, "Context info size mismatch"));
        }
        let (width, height, samples) = context
            .scene
            .as_ref()
            .map(|s| (s.scene.width, s.scene.height, s.samples))
            .unwrap_or((0, 0, 0));
        let filled = ContextInfo {
            struct_size: size as u32,
            width,
            height,
            samples,
            state: if context.failed {
                2
            } else if context.job.as_ref().is_some_and(|j| j.active()) {
                3
            } else if context.scene.is_some() {
                1
            } else {
                0
            },
            last_commit: context.last_commit,
        };
        unsafe {
            std::ptr::copy_nonoverlapping(
                (&raw const filled).cast::<u8>(),
                info.cast::<u8>(),
                size,
            );
        }
        Ok(())
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_context_read_pixels(
    handle: u64,
    kind: u32,
    pixels: *mut u8,
    size: usize,
    written: *mut usize,
    error: *mut c_char,
    capacity: usize,
) -> i32 {
    action(error, capacity, |registry| {
        if written.is_null() {
            return Err(fail(Status::InvalidArgument, "Null pixel length output"));
        }
        unsafe {
            *written = 0;
        }
        let context = context(registry, handle)?;
        idle(context)?;
        let scene = ready(context)?;
        if kind > 2 {
            return Err(fail(Status::InvalidArgument, "Unknown image kind"));
        }
        if scene.samples == 0 {
            return Err(fail(Status::InvalidState, "No completed samples"));
        }
        let required = scene.scene.width as usize * scene.scene.height as usize * 16;
        unsafe {
            *written = required;
        }
        if pixels.is_null() && size == 0 {
            return Ok(());
        }
        if pixels.is_null() {
            return Err(fail(Status::InvalidArgument, "Null pixel destination"));
        }
        if size < required {
            return Err(fail(
                Status::BufferTooSmall,
                "Pixel destination is too small",
            ));
        }
        context.failed = true;
        let values = context.scene.as_ref().unwrap().read_pixels(kind)?;
        unsafe {
            std::ptr::copy_nonoverlapping(values.as_ptr(), pixels, values.len());
        }
        context.failed = false;
        Ok(())
    })
}

#[repr(C)]
pub struct JobInfo {
    pub struct_size: u32,
    pub state: u32,
    pub requested_samples: u32,
    pub submitted_samples: u32,
    pub completed_samples: u32,
    pub base_samples: u32,
}
fn job_context(registry: &mut Registry, id: u64) -> Result<&mut Context> {
    let (handle, context) = registry
        .contexts
        .iter_mut()
        .find(|(_, c)| c.job.as_ref().is_some_and(|j| j.id == id))
        .ok_or_else(|| fail(Status::InvalidHandle, "Invalid or expired render job"))?;
    if TOUCHED.get().is_none() {
        TOUCHED.set(Some((*handle, context.failed)));
    }
    Ok(context)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_context_submit(
    handle: u64,
    additional: u32,
    output: *mut u64,
    error: *mut c_char,
    capacity: usize,
) -> i32 {
    action(error, capacity, |registry| {
        if output.is_null() {
            return Err(fail(Status::InvalidArgument, "Null render job output"));
        }
        let id = registry.next;
        let next = id.checked_add(1).ok_or("Native handles exhausted")?;
        let context = context(registry, handle)?;
        idle(context)?;
        let scene = ready(context)?;
        if additional == 0 || additional > 4096 - scene.samples {
            return Err(fail(
                Status::InvalidArgument,
                "Total samples must be 1..4096",
            ));
        }
        let base = scene.samples;
        context.job = Some(RenderJob {
            id,
            base,
            requested: additional,
            submitted: 0,
            completed: 0,
            state: JobState::Queued,
            cancelled: false,
            flight: None,
        });
        registry.next = next;
        unsafe {
            *output = id;
        }
        Ok(())
    })
}
fn advance_job(context: &mut Context, budget: u32) -> Result<()> {
    let scene = context.scene.as_mut().ok_or("No committed scene")?;
    let job = context.job.as_mut().ok_or("Missing render job")?;
    if !job.active() {
        return Ok(());
    }
    scene.gpu.device.poll(wgpu::PollType::Poll)?;
    if job
        .flight
        .as_ref()
        .is_some_and(|f| f.done.load(Ordering::Acquire))
    {
        let flight = job.flight.take().unwrap();
        scene.samples = flight.end;
        job.completed = flight.end - job.base;
    }
    if job.flight.is_some() {
        return Ok(());
    }
    if job.completed == job.requested {
        job.state = JobState::Complete;
        return Ok(());
    }
    if job.cancelled {
        job.state = JobState::Cancelled;
        return Ok(());
    }
    if budget == 0 {
        return Ok(());
    }
    let count = budget.min(job.requested - job.submitted);
    scene.dispatch_samples(
        job.base + job.submitted,
        count,
        context.render_bounces,
        context.render_seed,
    )?;
    let done = Arc::new(AtomicBool::new(false));
    let signal = done.clone();
    scene
        .gpu
        .queue
        .on_submitted_work_done(move || signal.store(true, Ordering::Release));
    job.submitted += count;
    job.flight = Some(Flight {
        end: job.base + job.submitted,
        done,
    });
    job.state = JobState::Running;
    Ok(())
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_job_poll(
    id: u64,
    budget: u32,
    error: *mut c_char,
    capacity: usize,
) -> i32 {
    action(error, capacity, |registry| {
        if budget > 64 {
            return Err(fail(
                Status::InvalidArgument,
                "Poll dispatch budget must be 0..64 samples",
            ));
        }
        let context = job_context(registry, id)?;
        if context.failed {
            return Err(fail(
                Status::InvalidState,
                "Render scene failed; commit a new scene",
            ));
        }
        context.failed = true;
        let result = advance_job(context, budget);
        if result.is_err() {
            context.job.as_mut().unwrap().state = JobState::Failed;
        } else {
            context.failed = false;
        }
        result
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_job_info(
    id: u64,
    info: *mut JobInfo,
    error: *mut c_char,
    capacity: usize,
) -> i32 {
    action(error, capacity, |registry| {
        let context = job_context(registry, id)?;
        if info.is_null() || unsafe { (*info).struct_size } != std::mem::size_of::<JobInfo>() as u32
        {
            return Err(fail(Status::InvalidArgument, "Job info size mismatch"));
        }
        let job = context.job.as_ref().unwrap();
        unsafe {
            *info = JobInfo {
                struct_size: std::mem::size_of::<JobInfo>() as u32,
                state: if context.failed {
                    JobState::Failed as u32
                } else {
                    job.state as u32
                },
                requested_samples: job.requested,
                submitted_samples: job.submitted,
                completed_samples: job.completed,
                base_samples: job.base,
            };
        }
        Ok(())
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_job_cancel(id: u64, error: *mut c_char, capacity: usize) -> i32 {
    action(error, capacity, |registry| {
        let context = job_context(registry, id)?;
        let job = context.job.as_mut().unwrap();
        if !job.active() {
            return Ok(());
        }
        job.cancelled = true;
        job.state = if job.flight.is_some() {
            JobState::Cancelling
        } else {
            JobState::Cancelled
        };
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "requires a real GPU; run npm run native:ci:gpu"]
    fn preparation_does_not_block_render_and_cancellation_preserves_old_scene() {
        let _test = ABI_TEST_LOCK.lock().unwrap();
        let mut handle = 0;
        let mut error = [0i8; 512];
        unsafe {
            assert_eq!(
                mt_context_create_with_backend(0, &mut handle, error.as_mut_ptr(), error.len()),
                0,
                "GPU validation requires a working device"
            );
            let input = scene::tests::input();
            assert_eq!(
                mt_context_commit(
                    handle,
                    input.as_ptr(),
                    input.len(),
                    error.as_mut_ptr(),
                    error.len()
                ),
                0
            );
            let mut active = 99;
            let mut reason = [0i8; 128];
            assert_eq!(
                mt_context_backend(
                    handle,
                    &mut active,
                    reason.as_mut_ptr(),
                    reason.len(),
                    error.as_mut_ptr(),
                    error.len()
                ),
                0
            );
            assert_eq!(active, 0);
            // Software Vulkan drivers can compile the first dispatch lazily.
            // Warm that path before testing progress while preparation is blocked.
            assert_eq!(
                mt_context_render(handle, 1, error.as_mut_ptr(), error.len()),
                0
            );
            assert_eq!(mt_context_reset(handle, error.as_mut_ptr(), error.len()), 0);
        }
        let (started, entered) = mpsc::sync_channel(1);
        let (resume, resumed) = mpsc::sync_channel(1);
        runtime::enqueue(move || {
            started.send(()).unwrap();
            resumed.recv_timeout(Duration::from_secs(15)).unwrap();
        });
        entered.recv().unwrap();
        let committing = std::thread::spawn(move || {
            let input = scene::tests::input();
            let mut error = [0i8; 512];
            loop {
                let code = unsafe {
                    mt_context_commit(
                        handle,
                        input.as_ptr(),
                        input.len(),
                        error.as_mut_ptr(),
                        error.len(),
                    )
                };
                if code == 0
                    || !unsafe { CStr::from_ptr(error.as_ptr()) }
                        .to_string_lossy()
                        .contains("registry is active")
                {
                    return code;
                }
                std::thread::yield_now();
            }
        });
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let preparing = REGISTRY.lock().unwrap().as_ref().unwrap().contexts[&handle]
                .commit
                .is_some();
            if preparing {
                break;
            }
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(1));
        }
        unsafe {
            let mut job = 0;
            assert_eq!(
                mt_context_submit(handle, 1, &mut job, error.as_mut_ptr(), error.len()),
                0
            );
            assert_eq!(mt_job_poll(job, 1, error.as_mut_ptr(), error.len()), 0);
            assert_eq!(
                mt_context_cancel_commit(handle, error.as_mut_ptr(), error.len()),
                0
            );
            loop {
                assert_eq!(mt_job_poll(job, 0, error.as_mut_ptr(), error.len()), 0);
                if !job_active(&REGISTRY.lock().unwrap().as_ref().unwrap().contexts[&handle]) {
                    break;
                }
                assert!(Instant::now() < deadline);
                std::thread::sleep(Duration::from_millis(1));
            }
        }
        resume.send(()).unwrap();
        assert_eq!(committing.join().unwrap(), Status::Cancelled as i32);
        let mut before = vec![0u8; 8 * 8 * 16];
        let mut after = before.clone();
        let mut written = 0;
        unsafe {
            assert_eq!(
                mt_context_read_pixels(
                    handle,
                    0,
                    before.as_mut_ptr(),
                    before.len(),
                    &mut written,
                    error.as_mut_ptr(),
                    error.len()
                ),
                0
            );
            assert_eq!(mt_context_reset(handle, error.as_mut_ptr(), error.len()), 0);
            assert_eq!(
                mt_context_render(handle, 1, error.as_mut_ptr(), error.len()),
                0
            );
            assert_eq!(
                mt_context_read_pixels(
                    handle,
                    0,
                    after.as_mut_ptr(),
                    after.len(),
                    &mut written,
                    error.as_mut_ptr(),
                    error.len()
                ),
                0
            );
            assert_eq!(before, after);
            assert_eq!(
                mt_context_destroy(handle, error.as_mut_ptr(), error.len()),
                0
            );
        }
        // No creating-thread binding survives teardown, and eight is not a cap.
        std::thread::spawn(|| {
            let mut handles = Vec::new();
            let mut error = [0i8; 512];
            for _ in 0..9 {
                let mut handle = 0;
                unsafe {
                    assert_eq!(
                        mt_context_create_with_backend(
                            0,
                            &mut handle,
                            error.as_mut_ptr(),
                            error.len()
                        ),
                        0
                    );
                }
                handles.push(handle);
            }
            for handle in handles {
                unsafe {
                    assert_eq!(
                        mt_context_destroy(handle, error.as_mut_ptr(), error.len()),
                        0
                    );
                }
            }
        })
        .join()
        .unwrap();
    }
    #[test]
    #[ignore = "requires a real GPU; run npm run native:ci:gpu"]
    fn destroy_cancels_and_drains_an_unpublished_candidate() {
        let _test = ABI_TEST_LOCK.lock().unwrap();
        let mut handle = 0;
        let mut error = [0i8; 512];
        assert_eq!(
            unsafe {
                mt_context_create_with_backend(0, &mut handle, error.as_mut_ptr(), error.len())
            },
            0,
            "GPU validation requires a working device"
        );
        let (entered, started) = mpsc::sync_channel(1);
        let (resume, resumed) = mpsc::sync_channel(1);
        runtime::enqueue(move || {
            entered.send(()).unwrap();
            resumed.recv_timeout(Duration::from_secs(15)).unwrap();
        });
        started.recv().unwrap();
        let committing = std::thread::spawn(move || {
            let bytes = scene::tests::input();
            let mut error = [0i8; 512];
            loop {
                let code = unsafe {
                    mt_context_commit(
                        handle,
                        bytes.as_ptr(),
                        bytes.len(),
                        error.as_mut_ptr(),
                        error.len(),
                    )
                };
                if !unsafe { CStr::from_ptr(error.as_ptr()) }
                    .to_string_lossy()
                    .contains("registry is active")
                {
                    return code;
                }
                std::thread::yield_now();
            }
        });
        let deadline = Instant::now() + Duration::from_secs(5);
        let pending = loop {
            let pending = REGISTRY.lock().unwrap().as_ref().unwrap().contexts[&handle]
                .commit
                .clone();
            if let Some(pending) = pending {
                break pending;
            }
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(1));
        };
        let destroying = std::thread::spawn(move || {
            let mut error = [0i8; 512];
            unsafe { mt_context_destroy(handle, error.as_mut_ptr(), error.len()) }
        });
        while !pending.cancelled.load(Ordering::Acquire) {
            assert!(Instant::now() < deadline);
            std::thread::yield_now();
        }
        assert!(!destroying.is_finished());
        resume.send(()).unwrap();
        assert_eq!(committing.join().unwrap(), Status::Cancelled as i32);
        assert_eq!(destroying.join().unwrap(), 0);
        assert!(*pending.finished.lock().unwrap());
        assert!(
            !REGISTRY
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .contexts
                .contains_key(&handle)
        );
    }
    #[test]
    #[ignore = "requires a real GPU; run npm run native:ci:gpu"]
    fn shared_device_preview_survives_reset_and_context_destruction() {
        let _test = ABI_TEST_LOCK.lock().unwrap();
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            ..Default::default()
        }))
        .expect("GPU validation requires an adapter");
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            required_limits: adapter.limits(),
            ..Default::default()
        }))
        .unwrap();
        let handle = create_on_device(&adapter, &device, &queue, 0).unwrap();
        let mut input = scene::tests::input();
        input[118 * 4..119 * 4].copy_from_slice(&3f32.to_le_bytes());
        let mut error = [0i8; 4096];
        unsafe {
            assert_eq!(
                mt_context_commit(
                    handle,
                    input.as_ptr(),
                    input.len(),
                    error.as_mut_ptr(),
                    error.len()
                ),
                0
            );
            assert_eq!(
                mt_context_render(handle, 3, error.as_mut_ptr(), error.len()),
                0
            );
        }
        let mut display = None;
        assert!(capture_display(handle, &mut display).unwrap());
        let display = display.unwrap();
        let before = display.read_linear().unwrap();
        assert_eq!(before.len(), 8 * 8 * 4);
        unsafe {
            assert_eq!(mt_context_reset(handle, error.as_mut_ptr(), error.len()), 0);
        }
        assert_eq!(display.read_linear().unwrap(), before);
        unsafe {
            assert_eq!(
                mt_context_destroy(handle, error.as_mut_ptr(), error.len()),
                0
            );
        }
        display.compose(0.);
        assert_eq!(display.read_linear().unwrap(), before);
    }
    #[test]
    #[ignore = "requires a real GPU; run npm run native:ci:gpu"]
    fn changed_blas_and_tlas_are_ready_after_interleaved_retained_edits() {
        let _test = ABI_TEST_LOCK.lock().unwrap();
        let _entry = ENTRY_LOCK.lock().unwrap();
        let gpu = GpuDevice::with_backend(1).expect("GPU validation requires a working device");
        assert!(gpu.hardware_ray_query, "GPU validation requires HWRT");
        let make = |input: &[u8]| {
            let (mut scene, mut assets, retained) = scene::prepare_retained(input, true).unwrap();
            scene.hwrt = Some(
                hardware::capture_from_resources(
                    &mut assets,
                    scene.native_layout.as_ref().unwrap(),
                )
                .unwrap(),
            );
            sample_audit::install(&mut scene, &mut assets).unwrap();
            let mut result = GpuScene::new(
                scene,
                &RenderOptions {
                    flags: 4,
                    ..Default::default()
                },
                &assets,
                gpu.clone(),
            )
            .unwrap();
            assert!(result.hardware.is_some());
            result.retained = Some(retained);
            result
        };
        'attempts: for attempt in 0..=3 {
            for optional_refit in [false, true] {
                #[cfg(not(target_os = "macos"))]
                if optional_refit {
                    continue;
                }
                let mut input = scene::tests::input();
                input[118 * 4..119 * 4].copy_from_slice(&3f32.to_le_bytes());
                let mut state = make(&input);
                state.hardware.as_mut().unwrap().metal_refit_opt_in = optional_refit;
                let mut transform = [0u32; 20];
                transform[0] = 1;
                for index in [0, 5, 10, 15] {
                    transform[4 + index] = 1f32.to_bits();
                }
                transform[16] = 0.125f32.to_bits();
                let bytes: Vec<_> = transform.iter().flat_map(|v| v.to_le_bytes()).collect();
                let writes = state.retained.as_ref().unwrap().transform(&bytes).unwrap();
                let plan = state
                    .hardware
                    .as_ref()
                    .unwrap()
                    .transform_plan(state.scene.hwrt.as_ref().unwrap(), &writes)
                    .unwrap();
                state
                    .hardware
                    .as_mut()
                    .unwrap()
                    .update_transforms(
                        &state.gpu.device,
                        &state.gpu.queue,
                        plan,
                        state.scene.hwrt.as_mut().unwrap(),
                    )
                    .unwrap();
                state.update_lighting(&writes).unwrap();
                state.retained.as_ref().unwrap().accept_transform().unwrap();
                input[60 * 4..61 * 4].copy_from_slice(&0.125f32.to_le_bytes());
                let original = f32::from_le_bytes(input[120 * 4..121 * 4].try_into().unwrap());
                for (step, shift) in [0.05f32, 0.1, 0.0].into_iter().enumerate() {
                    input[120 * 4..121 * 4].copy_from_slice(&(original + shift).to_le_bytes());
                    let mut bytes: Vec<_> = [1u32, 0, 3, 0]
                        .iter()
                        .flat_map(|v| v.to_le_bytes())
                        .collect();
                    bytes.extend_from_slice(&input[120 * 4..129 * 4]);
                    let writes = state.retained.as_ref().unwrap().geometry(&bytes).unwrap();
                    assert_eq!(writes.changed_blases.as_deref(), Some(&[0][..]));
                    let (resources, capture, group, attributes) =
                        state.prepare_geometry_hardware(&writes).unwrap().unwrap();
                    assert!(attributes.is_none());
                    assert_eq!(resources.used_metal_refit, optional_refit && step > 0);
                    state.hardware = Some(resources);
                    state.scene.hwrt = Some(capture);
                    state.groups[0] = group;
                    state.update_lighting(&writes).unwrap();
                    state.retained.as_ref().unwrap().accept_geometry().unwrap();
                    let mut expected = make(&input);
                    for current in [&state, &expected] {
                        current.gpu.queue.write_buffer(
                            &current.buffers[&layout::resource::QUERY_COUNTS],
                            0,
                            &vec![
                                0;
                                current.scene.width as usize * current.scene.height as usize * 16
                            ],
                        );
                    }
                    for sample in 0..8 {
                        state.add_samples(1, 6., 12345).unwrap();
                        expected.add_samples(1, 6., 12345).unwrap();
                        let a = sample_audit::read(&state, sample).unwrap();
                        let b = sample_audit::read(&expected, sample).unwrap();
                        let evidence = sample_audit::evidence(&a, Some(&b));
                        let invalid = a.invalid_pixels > 0 || b.invalid_pixels > 0;
                        let mut changed = Vec::new();
                        for kind in 0..3 {
                            let actual = state.read_pixels(kind).unwrap();
                            let reference = expected.read_pixels(kind).unwrap();
                            if actual != reference
                                || !actual
                                    .chunks_exact(4)
                                    .chain(reference.chunks_exact(4))
                                    .all(|v| f32::from_le_bytes(v.try_into().unwrap()).is_finite())
                            {
                                changed.push(kind);
                            }
                        }
                        if invalid || evidence.is_some() || !changed.is_empty() {
                            let test = format!("interleaved-retained-edits-refit{optional_refit}");
                            let retry = sample_audit::retry_event(
                                &test,
                                attempt,
                                step,
                                sample,
                                evidence.as_ref(),
                                &input,
                                [&state, &expected],
                            )
                            .unwrap();
                            assert!(
                                retry,
                                "{test} step {step} sample {sample}: audit {a:?}/{b:?}, changed {changed:?}; no permitted rerun remains"
                            );
                            continue 'attempts;
                        }
                    }
                }
            }
            break;
        }
    }
    #[test]
    #[ignore = "requires a real GPU; run npm run native:ci:gpu"]
    fn rejected_hardware_candidate_can_render_the_rebuilt_software_scene() {
        let _test = ABI_TEST_LOCK.lock().unwrap();
        let _entry = ENTRY_LOCK.lock().unwrap();
        let gpu = GpuDevice::with_backend(1).expect("GPU validation requires a working device");
        assert!(gpu.hardware_ray_query, "GPU validation requires HWRT");
        let mut input = scene::tests::input();
        input[118 * 4..119 * 4].copy_from_slice(&3f32.to_le_bytes());
        let (mut direct, mut assets, mut retained) = scene::prepare_retained(&input, true).unwrap();
        let mut capture =
            hardware::capture_from_resources(&mut assets, direct.native_layout.as_ref().unwrap())
                .unwrap();
        capture.eligible = false;
        direct.hwrt = Some(capture);
        let fallback_source = direct.clone();
        let rejected = GpuScene::new(
            direct,
            &RenderOptions {
                flags: 4,
                ..Default::default()
            },
            &assets,
            gpu.clone(),
        );
        assert!(rejected.is_err());
        let software =
            prepare_software_fallback(&input, fallback_source, &mut assets, &mut retained).unwrap();
        let mut state =
            GpuScene::new(software, &RenderOptions::default(), &assets, gpu.clone()).unwrap();
        let (reference, reference_assets, _reference_retained) =
            scene::prepare_retained(&input, false).unwrap();
        let mut expected =
            GpuScene::new(reference, &RenderOptions::default(), &reference_assets, gpu).unwrap();
        state.add_samples(1, 6., 12345).unwrap();
        expected.add_samples(1, 6., 12345).unwrap();
        for kind in 0..3 {
            assert_eq!(
                state.read_pixels(kind).unwrap(),
                expected.read_pixels(kind).unwrap()
            );
        }
        assert!(
            state
                .read_pixels(2)
                .unwrap()
                .chunks_exact(4)
                .any(|b| f32::from_le_bytes(b.try_into().unwrap()) > 0.)
        );
    }
    #[test]
    fn direct_as_fallback_rebuilds_software_and_retained_edits() {
        let _test = ABI_TEST_LOCK.lock().unwrap();
        let _entry = ENTRY_LOCK.lock().unwrap();
        let input = scene::tests::input();
        let (direct, mut assets, mut retained) = scene::prepare_retained(&input, true).unwrap();
        assert!(direct.native_layout.as_ref().unwrap().indexed);
        let software =
            prepare_software_fallback(&input, direct, &mut assets, &mut retained).unwrap();
        let (expected, expected_assets, expected_retained) =
            scene::prepare_retained(&input, false).unwrap();
        assert!(!software.native_layout.as_ref().unwrap().indexed);
        assert!(software.hwrt.is_none());
        assert_eq!(software.shader, expected.shader);
        assert_eq!(assets, expected_assets);
        let patch: Vec<u8> = [
            1u32,
            0,
            0,
            0,
            0.2f32.to_bits(),
            0.4f32.to_bits(),
            0.8f32.to_bits(),
            0.3f32.to_bits(),
            0,
            0,
            1.5f32.to_bits(),
            0,
        ]
        .into_iter()
        .flat_map(u32::to_le_bytes)
        .collect();
        assert_eq!(
            retained.material(&patch).unwrap(),
            expected_retained.material(&patch).unwrap()
        );
    }
    #[test]
    #[ignore = "requires a real GPU; run npm run native:ci:gpu"]
    fn panic_marks_the_touched_context_failed_and_commit_recovers_it() {
        let _test = ABI_TEST_LOCK.lock().unwrap();
        let mut handle = 0;
        let mut error = [0i8; 512];
        assert_eq!(
            unsafe {
                mt_context_create_with_backend(0, &mut handle, error.as_mut_ptr(), error.len())
            },
            0,
            "GPU validation requires a working device"
        );
        assert_eq!(
            action(error.as_mut_ptr(), error.len(), |registry| {
                let _ = context(registry, handle)?;
                panic!("context-specific boundary probe");
            }),
            Status::ContextFailed as i32
        );
        assert!(REGISTRY.lock().unwrap().as_ref().unwrap().contexts[&handle].failed);
        let input = scene::tests::input();
        unsafe {
            assert_eq!(
                mt_context_commit(
                    handle,
                    input.as_ptr(),
                    input.len(),
                    error.as_mut_ptr(),
                    error.len()
                ),
                0
            );
            assert!(!REGISTRY.lock().unwrap().as_ref().unwrap().contexts[&handle].failed);
            assert_eq!(
                mt_context_destroy(handle, error.as_mut_ptr(), error.len()),
                0
            );
        }
    }
    #[test]
    #[ignore = "requires a real GPU; run npm run native:ci:gpu"]
    fn snapshot_reports_the_path_of_the_last_successful_commit() {
        let _test = ABI_TEST_LOCK.lock().unwrap();
        let mut handle = 0;
        let mut error = [0i8; 512];
        assert_eq!(
            unsafe {
                mt_context_create_with_backend(0, &mut handle, error.as_mut_ptr(), error.len())
            },
            0,
            "GPU validation requires a working device"
        );
        let info = |size: usize| {
            let mut info = ContextInfo {
                struct_size: size as u32,
                width: 0,
                height: 0,
                samples: 0,
                state: 0,
                last_commit: 99,
            };
            let mut error = [0i8; 128];
            let status =
                unsafe { mt_context_info(handle, &mut info, error.as_mut_ptr(), error.len()) };
            (status, info.last_commit)
        };
        let size = std::mem::size_of::<ContextInfo>();
        assert_eq!(info(size), (0, COMMIT_NONE));
        // An ABI 2 snapshot is filled up to its own size.
        assert_eq!(info(size - 4), (0, 99));
        assert_eq!(info(size + 4).0, Status::InvalidArgument as i32);
        let input = scene::tests::input();
        let commit = |bytes: &[u8]| {
            let mut error = [0i8; 512];
            unsafe {
                mt_context_commit(
                    handle,
                    bytes.as_ptr(),
                    bytes.len(),
                    error.as_mut_ptr(),
                    error.len(),
                )
            }
        };
        assert_eq!(commit(&input), 0);
        assert_eq!(info(size), (0, COMMIT_FULL));
        assert_eq!(commit(&input), 0);
        assert_eq!(info(size), (0, COMMIT_INCREMENTAL));
        // A rejected commit keeps the scene and the reported path.
        assert_ne!(commit(&input[..input.len() - 4]), 0);
        assert_eq!(info(size), (0, COMMIT_INCREMENTAL));
        unsafe {
            assert_eq!(
                mt_context_destroy(handle, error.as_mut_ptr(), error.len()),
                0
            );
        }
    }
    #[test]
    fn caught_context_panic_does_not_poison_the_registry() {
        let _test = ABI_TEST_LOCK.lock().unwrap();
        let mut error = [0i8; 128];
        assert_eq!(
            action(error.as_mut_ptr(), error.len(), |_| panic!(
                "context boundary probe"
            )),
            1
        );
        assert!(
            unsafe { CStr::from_ptr(error.as_ptr()) }
                .to_str()
                .unwrap()
                .contains("panicked")
        );
        assert_eq!(action(error.as_mut_ptr(), error.len(), |_| Ok(())), 0);
        assert_eq!(error[0], 0);
        assert_eq!(action(error.as_mut_ptr(), 3, |_| Err("中文".into())), 1);
        assert_eq!(error[0], 0); // A truncated message never contains half a UTF-8 character.
        assert_eq!(action(error.as_mut_ptr(), 4, |_| Err("中文".into())), 1);
        assert_eq!(
            unsafe { CStr::from_ptr(error.as_ptr()) }.to_str().unwrap(),
            "中"
        );
        assert_eq!(
            action(error.as_mut_ptr(), error.len(), |_| Err("".into())),
            1
        );
    }
    #[test]
    fn rejected_calls_report_specific_status_codes() {
        let _test = ABI_TEST_LOCK.lock().unwrap();
        let mut error = [0i8; 256];
        let (e, n) = (error.as_mut_ptr(), error.len());
        let full: Result<()> = Err("Full scene commit required: probe".into());
        assert_eq!(action(e, n, |_| full), Status::FullCommitRequired as i32);
        let mut handle = 7;
        unsafe {
            assert_eq!(
                mt_context_create_with_backend(2, &mut handle, e, n),
                Status::InvalidArgument as i32
            );
            assert_eq!(handle, 0);
            assert_eq!(
                mt_context_render(u64::MAX, 1, e, n),
                Status::InvalidHandle as i32
            );
            assert_eq!(
                mt_job_poll(u64::MAX, 65, e, n),
                Status::InvalidArgument as i32
            );
            assert_eq!(mt_job_poll(u64::MAX, 1, e, n), Status::InvalidHandle as i32);
            let mut written = 1;
            assert_eq!(
                mt_context_read_pixels(u64::MAX, 0, std::ptr::null_mut(), 0, &mut written, e, n),
                Status::InvalidHandle as i32
            );
            assert_eq!(written, 0);
            assert_eq!(
                settings::mt_render_settings_default(std::ptr::null_mut()),
                Status::InvalidArgument as i32
            );
        }
        // A held registry is reported as retryable busy work.
        let held = REGISTRY.lock().unwrap();
        assert_eq!(action(e, n, |_| Ok(())), Status::Busy as i32);
        drop(held);
    }
    #[test]
    #[ignore = "requires a real GPU; run npm run native:ci:gpu"]
    fn scene_state_errors_and_short_reads_report_status_codes() {
        let _test = ABI_TEST_LOCK.lock().unwrap();
        let mut handle = 0;
        let mut error = [0i8; 512];
        let (e, n) = (error.as_mut_ptr(), error.len());
        unsafe {
            assert_eq!(
                mt_context_create_with_backend(0, &mut handle, e, n),
                0,
                "GPU validation requires a working device"
            );
            assert_eq!(
                mt_context_render(handle, 1, e, n),
                Status::InvalidState as i32
            );
            let input = scene::tests::input();
            let mut bad = input.clone();
            bad[0] = 99;
            assert_eq!(
                mt_context_commit(handle, bad.as_ptr(), bad.len(), e, n),
                Status::InvalidArgument as i32
            );
            assert_eq!(
                mt_context_commit(handle, input.as_ptr(), input.len(), e, n),
                0
            );
            let mut written = 0;
            assert_eq!(
                mt_context_read_pixels(handle, 0, std::ptr::null_mut(), 0, &mut written, e, n),
                Status::InvalidState as i32
            );
            assert_eq!(mt_context_render(handle, 1, e, n), 0);
            let mut short = [0u8; 16];
            assert_eq!(
                mt_context_read_pixels(
                    handle,
                    0,
                    short.as_mut_ptr(),
                    short.len(),
                    &mut written,
                    e,
                    n
                ),
                Status::BufferTooSmall as i32
            );
            assert!(written > short.len());
            assert_eq!(
                mt_context_read_pixels(
                    handle,
                    3,
                    short.as_mut_ptr(),
                    short.len(),
                    &mut written,
                    e,
                    n
                ),
                Status::InvalidArgument as i32
            );
            assert_eq!(mt_context_destroy(handle, e, n), 0);
        }
    }
}

/// Actual backend: 0=software, 1=authoritative HWRT.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_context_backend(
    handle: u64,
    active: *mut u32,
    reason: *mut c_char,
    reason_capacity: usize,
    error: *mut c_char,
    capacity: usize,
) -> i32 {
    action(error, capacity, |registry| {
        if active.is_null() || reason.is_null() || reason_capacity == 0 {
            return Err(fail(Status::InvalidArgument, "Invalid backend info output"));
        }
        let context = context(registry, handle)?;
        let scene = ready(context)?;
        unsafe {
            *active = u32::from(scene.scene.hwrt.is_some());
        }
        let status = if scene.scene.hwrt.is_some() {
            "software BVH geometries: 0"
        } else {
            context.fallback_reason.as_str()
        };

        let bytes = status.as_bytes();
        let mut n = bytes.len().min(reason_capacity - 1);
        while !status.is_char_boundary(n) {
            n -= 1;
        }
        unsafe {
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), reason.cast(), n);
            *reason.add(n) = 0;
        }
        Ok(())
    })
}
