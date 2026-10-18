//! Owner-thread contexts retain actual wgpu resources, never AOT arena pointers.
use super::*;
use std::{
    panic::AssertUnwindSafe,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread::ThreadId,
};

const MAX_CONTEXTS: usize = 8;
struct Context {
    gpu: GpuDevice,
    backend: u32,
    render_seed: u32,
    render_bounces: f32,
    fallback_reason: String,
    scene: Option<GpuScene>,
    spare_buffers: HashMap<usize, wgpu::Buffer>,
    spare_hardware: HashMap<String, wgpu::Buffer>,
    failed: bool,
    job: Option<RenderJob>,
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
        return Err("Context has an active render job; cancel and poll it first".into());
    }
    Ok(())
}
struct Registry {
    next: u64,
    owner: Option<ThreadId>,
    contexts: HashMap<u64, Context>,
}
static REGISTRY: Mutex<Option<Registry>> = Mutex::new(None);

#[repr(C)]
#[derive(Clone, Copy)]
pub struct ContextInfo {
    pub struct_size: u32,
    pub version: u32,
    pub width: u32,
    pub height: u32,
    pub samples: u32,
    pub state: u32,
    pub reserved: [u32; 2],
}
fn action(
    error: *mut c_char,
    capacity: usize,
    operation: impl FnOnce(&mut Registry) -> Result<()>,
) -> i32 {
    let result = (|| -> Result<()> {
        let _entry = ENTRY_LOCK
            .try_lock()
            .map_err(|_| "Native core is active or poisoned")?;
        let mut slot = REGISTRY
            .try_lock()
            .map_err(|_| "Context registry is active or poisoned")?;
        let registry = slot.get_or_insert_with(|| Registry {
            next: 1,
            owner: None,
            contexts: HashMap::new(),
        });
        if registry
            .owner
            .is_some_and(|owner| owner != std::thread::current().id())
        {
            return Err("Native contexts must use their creating owner thread".into());
        }
        // Catch while guards remain in this stack frame, avoiding mutex poisoning.
        std::panic::catch_unwind(AssertUnwindSafe(|| operation(registry)))
            .map_err(|_| "Native context operation panicked")?
    })();
    let (status, message) = match result {
        Ok(()) => (0, String::new()),
        Err(e) => (1, e.to_string()),
    };
    if !error.is_null() && capacity > 0 {
        let mut count = message.len().min(capacity - 1);
        while !message.is_char_boundary(count) {
            count -= 1;
        }
        unsafe {
            std::ptr::copy_nonoverlapping(message.as_ptr(), error.cast(), count);
            *error.add(count) = 0;
        }
    }
    status
}
// Probe entries hold ENTRY_LOCK before consulting the context owner.
pub(super) fn check_owner() -> Result<()> {
    let registry = REGISTRY
        .try_lock()
        .map_err(|_| "Context registry is active or poisoned")?;
    if registry
        .as_ref()
        .and_then(|r| r.owner)
        .is_some_and(|owner| owner != std::thread::current().id())
    {
        return Err("Native core must use the context owner thread".into());
    }
    Ok(())
}
fn context(registry: &mut Registry, handle: u64) -> Result<&mut Context> {
    registry
        .contexts
        .get_mut(&handle)
        .ok_or_else(|| "Invalid or destroyed native context".into())
}
fn ready(context: &mut Context) -> Result<&mut GpuScene> {
    if context.failed {
        return Err("Scene failed; commit a new scene before rendering or reading".into());
    }
    context
        .scene
        .as_mut()
        .ok_or_else(|| "No committed scene".into())
}
// Direct AS preparation deliberately omits the software BVH. Re-run the shared
// TS preparation only when hardware capture/upload fails, replacing its retained
// state too so later edits operate on the same representation as the fallback.
fn prepare_software_fallback(
    bytes: &[u8],
    mut scene: Scene,
    assets: &mut HashMap<String, Vec<u8>>,
    retained: &mut scene::PreparedState,
) -> Result<Scene> {
    if scene
        .native_layout
        .as_ref()
        .is_some_and(|layout| layout.indexed)
        || !assets.contains_key("native-30")
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
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_context_create_with_backend(
    backend: u32,
    output: *mut u64,
    error: *mut c_char,
    capacity: usize,
) -> i32 {
    action(error, capacity, |registry| {
        if output.is_null() {
            return Err("Null context output".into());
        }
        unsafe {
            *output = 0;
        }
        if registry.contexts.len() >= MAX_CONTEXTS {
            return Err("At most eight native contexts are supported".into());
        }
        let handle = registry.next;
        let next = handle
            .checked_add(1)
            .ok_or("Native context handles exhausted")?;
        if backend > 1 {
            return Err("Unknown native intersection backend".into());
        }
        let gpu = GpuDevice::with_backend(backend)?;
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
            },
        );
        registry.next = next;
        registry.owner = Some(std::thread::current().id());
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
    action(error, capacity, |registry| {
        idle(context(registry, handle)?)?;
        registry
            .contexts
            .remove(&handle)
            .ok_or("Invalid or destroyed native context")?;
        Ok(())
    })
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
    action(error, capacity, |registry| {
        let context = context(registry, handle)?;
        idle(context)?;
        if settings.is_null() {
            return Err("Null render settings".into());
        }
        let settings = unsafe { *settings };
        if input.is_null() || length > scene::MAX_BYTES {
            return Err("Null or oversized scene input".into());
        }
        let bytes = unsafe { std::slice::from_raw_parts(input, length) };
        let profile = std::env::var_os("MUTRACER_NATIVE_PROFILE").is_some_and(|v| v == "1");
        let started = Instant::now();
        let (mut scene, mut assets, mut retained) = scene::prepare_retained_with_settings(
            bytes,
            context.backend == 1
                && context.gpu.hardware_ray_query
                && hardware::direct_input_enabled(),
            context.backend,
            &settings,
        )?;
        let prepared = Instant::now();
        let mut options = RenderOptions::default();
        let mut fallback_reason = String::new();
        if context.backend != 0 {
            let capture = if context.gpu.hardware_ray_query {
                hardware::capture_from_prepared(
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
                    scene = prepare_software_fallback(bytes, scene, &mut assets, &mut retained)?;
                }
            }
        }
        let hardware_prepared = Instant::now();
        let mut software_scene = scene.clone();
        software_scene.hwrt = None;
        let candidate = GpuScene::new_reusing(
            Path::new(""),
            scene,
            &options,
            Some(&assets),
            context.gpu.clone(),
            Some(&context.spare_buffers),
            Some(&context.spare_hardware),
        );
        let mut candidate = match candidate {
            Ok(candidate) => candidate,
            Err(error) if context.backend == 1 && options.flags & 4 != 0 => {
                fallback_reason = format!("HWRT upload unavailable: {error}");
                let software_scene =
                    prepare_software_fallback(bytes, software_scene, &mut assets, &mut retained)?;
                GpuScene::new_reusing(
                    Path::new(""),
                    software_scene,
                    &RenderOptions::default(),
                    Some(&assets),
                    context.gpu.clone(),
                    Some(&context.spare_buffers),
                    Some(&context.spare_hardware),
                )?
            }
            Err(error) => return Err(error),
        };
        if profile {
            // Host setup includes uploads, AS creation, bindings and validation.
            // Pipeline time is a subset; retries remain included in setup time.
            eprintln!(
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
        let uniform = assets
            .get("native-7")
            .ok_or("Missing normalized render settings")?;
        let seed = u32::from_le_bytes(
            uniform[layout::ray_uniform::SEQUENCE_SEED..layout::ray_uniform::SEQUENCE_SEED + 4]
                .try_into()?,
        );
        let bounces = i32::from_le_bytes(
            uniform[layout::ray_uniform::BOUNCES..layout::ray_uniform::BOUNCES + 4].try_into()?,
        ) as f32;
        candidate.retained = Some(retained);
        // Commit is transactional: the previous scene survives any preparation/upload failure.
        // Only retired buffers may be overwritten while preparing the next scene.
        // Keeping one spare generation preserves the live scene on failed commits.
        if let Some(previous) = context.scene.replace(candidate) {
            context.spare_buffers = previous.buffers;
            context.spare_hardware = previous.hardware.map_or_else(HashMap::new, |h| h.inputs);
        }
        context.render_seed = seed;
        context.render_bounces = bounces;
        context.fallback_reason = fallback_reason;
        context.job = None;
        context.failed = false;
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
            return Err("Total samples must be 1..4096".into());
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
pub unsafe extern "C" fn mt_context_wait(handle: u64, error: *mut c_char, capacity: usize) -> i32 {
    action(error, capacity, |registry| {
        let context = context(registry, handle)?;
        idle(context)?;
        let scene = ready(context)?;
        scene.gpu.device.poll(wgpu::PollType::Wait {
            submission_index: None,
            timeout: Some(Duration::from_secs(30)),
        })?;
        Ok(())
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_context_update_camera(
    handle: u64,
    input: *const u8,
    length: usize,
    error: *mut c_char,
    capacity: usize,
) -> i32 {
    action(error, capacity, |registry| {
        let context = context(registry, handle)?;
        idle(context)?;
        let scene = ready(context)?;
        if input.is_null() || length != 128 {
            return Err("Camera descriptor must contain exactly 128 bytes".into());
        }
        let bytes = unsafe { std::slice::from_raw_parts(input, length) };
        let packed = scene::prepare_camera(bytes, scene.scene.width, scene.scene.height)?;
        context.failed = true;
        context.scene.as_mut().unwrap().update_camera(&packed)?;
        context.job = None;
        context.failed = false;
        Ok(())
    })
}
/// Patch basic scalar material parameters through the retained original TS packer.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_context_update_material(
    handle: u64,
    input: *const u8,
    length: usize,
    error: *mut c_char,
    capacity: usize,
) -> i32 {
    action(error, capacity, |registry| {
        let context = context(registry, handle)?;
        idle(context)?;
        let scene = ready(context)?;
        if input.is_null() || length != 48 {
            return Err("Material descriptor must contain exactly 48 bytes".into());
        }
        let bytes = unsafe { std::slice::from_raw_parts(input, length) };
        let packed = scene
            .retained
            .as_ref()
            .ok_or("No retained material preparation")?
            .material(bytes)?;
        context.failed = true;
        context.scene.as_mut().unwrap().update_material(&packed)?;
        context.job = None;
        context.failed = false;
        Ok(())
    })
}
/// Refresh environment radiance, importance distribution and all light PMFs.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_context_update_environment(
    handle: u64,
    input: *const u8,
    length: usize,
    error: *mut c_char,
    capacity: usize,
) -> i32 {
    action(error, capacity, |registry| {
        let context = context(registry, handle)?;
        idle(context)?;
        let scene = ready(context)?;
        if input.is_null() || length < 48 || length > scene::MAX_BYTES {
            return Err("Invalid environment descriptor length".into());
        }
        let bytes = unsafe { std::slice::from_raw_parts(input, length) };
        let packed = scene
            .retained
            .as_ref()
            .ok_or("No retained environment preparation")?
            .environment(bytes)?;
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
    })
}
/// Update stable-topology vertices and all shared instances through original TS.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_context_update_geometry(
    handle: u64,
    input: *const u8,
    length: usize,
    error: *mut c_char,
    capacity: usize,
) -> i32 {
    action(error, capacity, |registry| {
        let context = context(registry, handle)?;
        idle(context)?;
        let scene = ready(context)?;
        if input.is_null() || length < 16 || length > scene::MAX_BYTES {
            return Err("Invalid geometry update length".into());
        }
        let bytes = unsafe { std::slice::from_raw_parts(input, length) };
        let packed = scene
            .retained
            .as_ref()
            .ok_or("No retained geometry preparation")?
            .geometry(bytes)?;
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
    })
}
/// Update a mesh world matrix or one local instance matrix through shared TS.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_context_update_transform(
    handle: u64,
    input: *const u8,
    length: usize,
    error: *mut c_char,
    capacity: usize,
) -> i32 {
    action(error, capacity, |registry| {
        let context = context(registry, handle)?;
        idle(context)?;
        let scene = ready(context)?;
        if input.is_null() || length != 80 {
            return Err("Transform descriptor must contain exactly 80 bytes".into());
        }
        let bytes = unsafe { std::slice::from_raw_parts(input, length) };
        let packed = scene
            .retained
            .as_ref()
            .ok_or("No retained transform preparation")?
            .transform(bytes)?;
        scene.validate_lighting(&packed)?;
        let hardware = scene
            .hardware
            .as_ref()
            .map(|hw| hw.transform_plan(scene.scene.hwrt.as_ref().unwrap(), &packed))
            .transpose()?;
        context.failed = true;
        let scene = context.scene.as_mut().unwrap();
        if let Some(plan) = hardware {
            scene.hardware.as_mut().unwrap().update_transforms(
                &scene.gpu.device,
                &scene.gpu.queue,
                plan,
                scene.scene.hwrt.as_mut().unwrap(),
            );
        }
        scene.update_lighting(&packed)?;
        scene.retained.as_ref().unwrap().accept_transform()?;
        context.job = None;
        context.failed = false;
        Ok(())
    })
}
/// Update one analytic light and refresh all light-selection probabilities.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_context_update_light(
    handle: u64,
    input: *const u8,
    length: usize,
    error: *mut c_char,
    capacity: usize,
) -> i32 {
    action(error, capacity, |registry| {
        let context = context(registry, handle)?;
        idle(context)?;
        let scene = ready(context)?;
        if input.is_null() || length != 128 {
            return Err("Light descriptor must contain exactly 128 bytes".into());
        }
        let bytes = unsafe { std::slice::from_raw_parts(input, length) };
        let packed = scene
            .retained
            .as_ref()
            .ok_or("No retained light preparation")?
            .light(bytes)?;
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
    })
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
        if info.is_null()
            || unsafe { (*info).struct_size } != std::mem::size_of::<ContextInfo>() as u32
        {
            return Err("Context info size mismatch".into());
        }
        let (width, height, samples) = context
            .scene
            .as_ref()
            .map(|s| (s.scene.width, s.scene.height, s.samples))
            .unwrap_or((0, 0, 0));
        unsafe {
            *info = ContextInfo {
                struct_size: std::mem::size_of::<ContextInfo>() as u32,
                version: 1,
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
                reserved: [0, 0],
            };
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
            return Err("Null pixel length output".into());
        }
        unsafe {
            *written = 0;
        }
        let context = context(registry, handle)?;
        idle(context)?;
        let scene = ready(context)?;
        if kind > 2 || scene.samples == 0 {
            return Err("Unknown image kind or no completed samples".into());
        }
        let required = scene.scene.width as usize * scene.scene.height as usize * 16;
        unsafe {
            *written = required;
        }
        if pixels.is_null() && size == 0 {
            return Ok(());
        }
        if pixels.is_null() || size < required {
            return Err("Pixel destination is null or too small".into());
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
    pub version: u32,
    pub state: u32,
    pub requested_samples: u32,
    pub submitted_samples: u32,
    pub completed_samples: u32,
    pub base_samples: u32,
    pub reserved: u32,
}
fn job_context(registry: &mut Registry, id: u64) -> Result<&mut Context> {
    registry
        .contexts
        .values_mut()
        .find(|c| c.job.as_ref().is_some_and(|j| j.id == id))
        .ok_or_else(|| "Invalid or expired render job".into())
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
            return Err("Null render job output".into());
        }
        let id = registry.next;
        let next = id.checked_add(1).ok_or("Native handles exhausted")?;
        let context = context(registry, handle)?;
        idle(context)?;
        let scene = ready(context)?;
        if additional == 0 || additional > 4096 - scene.samples {
            return Err("Total samples must be 1..4096".into());
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
            return Err("Poll dispatch budget must be 0..64 samples".into());
        }
        let context = job_context(registry, id)?;
        if context.failed {
            return Err("Render scene failed; commit a new scene".into());
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
            return Err("Job info size mismatch".into());
        }
        let job = context.job.as_ref().unwrap();
        unsafe {
            *info = JobInfo {
                struct_size: std::mem::size_of::<JobInfo>() as u32,
                version: 1,
                state: if context.failed {
                    JobState::Failed as u32
                } else {
                    job.state as u32
                },
                requested_samples: job.requested,
                submitted_samples: job.submitted,
                completed_samples: job.completed,
                base_samples: job.base,
                reserved: 0,
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
    fn changed_blas_and_tlas_are_ready_after_interleaved_retained_edits() {
        let _test = ABI_TEST_LOCK.lock().unwrap();
        let _entry = ENTRY_LOCK.lock().unwrap();
        let Ok(gpu) = GpuDevice::with_backend(1) else {
            return;
        };
        if !gpu.hardware_ray_query {
            return;
        }
        let make = |input: &[u8]| {
            let (mut scene, mut assets, retained) = scene::prepare_retained(input, true).unwrap();
            scene.hwrt = Some(
                hardware::capture_from_prepared(&mut assets, scene.native_layout.as_ref().unwrap())
                    .unwrap(),
            );
            let mut result = GpuScene::new(
                Path::new(""),
                scene,
                &RenderOptions {
                    flags: 4,
                    ..Default::default()
                },
                Some(&assets),
                gpu.clone(),
            )
            .unwrap();
            assert!(result.hardware.is_some());
            result.retained = Some(retained);
            result
        };
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
            state.hardware.as_mut().unwrap().update_transforms(
                &state.gpu.device,
                &state.gpu.queue,
                plan,
                state.scene.hwrt.as_mut().unwrap(),
            );
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
                state.add_samples(8, 6., 12345).unwrap();
                expected.add_samples(8, 6., 12345).unwrap();
                for kind in 0..3 {
                    assert_eq!(
                        state.read_pixels(kind).unwrap(),
                        expected.read_pixels(kind).unwrap()
                    );
                }
            }
        }
    }
    #[test]
    fn rejected_hardware_candidate_can_render_the_rebuilt_software_scene() {
        let _test = ABI_TEST_LOCK.lock().unwrap();
        let _entry = ENTRY_LOCK.lock().unwrap();
        let Ok(gpu) = GpuDevice::with_backend(1) else {
            return;
        };
        if !gpu.hardware_ray_query {
            return;
        }
        let mut input = scene::tests::input();
        input[118 * 4..119 * 4].copy_from_slice(&3f32.to_le_bytes());
        let (mut direct, mut assets, mut retained) = scene::prepare_retained(&input, true).unwrap();
        let mut capture =
            hardware::capture_from_prepared(&mut assets, direct.native_layout.as_ref().unwrap())
                .unwrap();
        capture.eligible = false;
        direct.hwrt = Some(capture);
        let fallback_source = direct.clone();
        let rejected = GpuScene::new(
            Path::new(""),
            direct,
            &RenderOptions {
                flags: 4,
                ..Default::default()
            },
            Some(&assets),
            gpu.clone(),
        );
        assert!(rejected.is_err());
        let software =
            prepare_software_fallback(&input, fallback_source, &mut assets, &mut retained).unwrap();
        let mut state = GpuScene::new(
            Path::new(""),
            software,
            &RenderOptions::default(),
            Some(&assets),
            gpu.clone(),
        )
        .unwrap();
        let (reference, reference_assets, _reference_retained) =
            scene::prepare_retained(&input, false).unwrap();
        let mut expected = GpuScene::new(
            Path::new(""),
            reference,
            &RenderOptions::default(),
            Some(&reference_assets),
            gpu,
        )
        .unwrap();
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
            return Err("Invalid backend info output".into());
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
