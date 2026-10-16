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
    fallback_reason: String,
    scene: Option<GpuScene>,
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
// C pointer ownership and structure sizes are specified in mutracer-context.h.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_context_create(
    output: *mut u64,
    error: *mut c_char,
    capacity: usize,
) -> i32 {
    unsafe { mt_context_create_with_backend(0, output, error, capacity) }
}
/// Backend 0=software, 1=automatic, 2=require supported HWRT scene/device.
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
        if backend > 2 {
            return Err("Unknown native intersection backend".into());
        }
        let gpu = GpuDevice::with_backend(backend)?;
        registry.contexts.insert(
            handle,
            Context {
                gpu,
                backend,
                fallback_reason: String::new(),
                scene: None,
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
    action(error, capacity, |registry| {
        let context = context(registry, handle)?;
        idle(context)?;
        if input.is_null() || length > scene::MAX_BYTES {
            return Err("Null or oversized scene input".into());
        }
        let bytes = unsafe { std::slice::from_raw_parts(input, length) };
        let (mut scene, mut assets, retained) = scene::prepare_retained(bytes)?;
        let mut options = RenderOptions::default();
        let mut fallback_reason = String::new();
        if context.backend != 0 {
            let capture = if context.gpu.hardware_ray_query {
                hardware::from_raw(
                    &scene,
                    &mut assets,
                    u32::from_le_bytes(bytes[..4].try_into().unwrap()),
                )
            } else {
                Err("Hardware ray queries unavailable on this device".into())
            };
            match capture {
                Ok(capture) => {
                    scene.hwrt = Some(capture);
                    options.flags |= 4;
                }
                Err(error) if context.backend == 2 => return Err(error),
                Err(error) => fallback_reason = error.to_string(),
            }
        }
        let candidate = GpuScene::new(
            Path::new(""),
            scene,
            &options,
            Some(&assets),
            context.gpu.clone(),
        );
        let mut candidate = match candidate {
            Ok(candidate) => candidate,
            Err(error) if context.backend == 1 && options.flags & 4 != 0 => {
                fallback_reason = format!("HWRT upload unavailable: {error}");
                let (scene, assets) = scene::prepare(bytes)?;
                GpuScene::new(
                    Path::new(""),
                    scene,
                    &RenderOptions::default(),
                    Some(&assets),
                    context.gpu.clone(),
                )?
            }
            Err(error) => return Err(error),
        };
        candidate.retained = Some(retained);
        // Commit is transactional: the previous scene survives any preparation/upload failure.
        context.scene = Some(candidate);
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
        context
            .scene
            .as_mut()
            .unwrap()
            .add_samples(additional, 6.0, 12345)?;
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
        scene.validate_environment(&packed)?;
        context.failed = true;
        context
            .scene
            .as_mut()
            .unwrap()
            .update_environment(&packed)?;
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
    scene.dispatch_samples(job.base + job.submitted, count, 6.0, 12345)?;
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

/// Runtime backend: 0=software, 1=hardware shadows, 2=hardware closest+shadows.
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
            *active = if scene.hardware.is_none() {
                0
            } else if scene.scene.hwrt.as_ref().unwrap().hardware_closest {
                2
            } else {
                1
            };
        }
        let bytes = context.fallback_reason.as_bytes();
        let mut n = bytes.len().min(reason_capacity - 1);
        while !context.fallback_reason.is_char_boundary(n) {
            n -= 1;
        }
        unsafe {
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), reason.cast(), n);
            *reason.add(n) = 0;
        }
        Ok(())
    })
}
/// Diagnostic counters, valid only for an idle hardware context.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_context_hwrt_counts(
    handle: u64,
    output: *mut u32,
    length: usize,
    error: *mut c_char,
    capacity: usize,
) -> i32 {
    action(error, capacity, |registry| {
        if output.is_null() || length != 11 {
            return Err("Expected eleven HWRT counters".into());
        }
        let context = context(registry, handle)?;
        idle(context)?;
        ready(context)?;
        if context.scene.as_ref().unwrap().hardware.is_none() {
            return Err("Context uses software traversal".into());
        }
        context.failed = true;
        let scene = context.scene.as_ref().unwrap();
        let hardware = scene
            .hardware
            .as_ref()
            .ok_or("Context uses software traversal")?;
        let counts = hardware::counts(&scene.gpu.device, &scene.gpu.queue, hardware)?;
        unsafe {
            std::ptr::copy_nonoverlapping(counts.as_ptr(), output, 11);
        }
        context.failed = false;
        Ok(())
    })
}
