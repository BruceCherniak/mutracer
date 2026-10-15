//! Owner-thread contexts retain actual wgpu resources, never AOT arena pointers.
use super::*;
use std::{panic::AssertUnwindSafe, thread::ThreadId};

const MAX_CONTEXTS: usize = 8;
struct Context {
    gpu: GpuDevice,
    scene: Option<GpuScene>,
    failed: bool,
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
        let gpu = GpuDevice::new(false)?;
        registry.contexts.insert(
            handle,
            Context {
                gpu,
                scene: None,
                failed: false,
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
        if input.is_null() || length > 64 * 1024 * 1024 {
            return Err("Null or oversized scene input".into());
        }
        let bytes = unsafe { std::slice::from_raw_parts(input, length) };
        let (scene, assets) = scene::prepare(bytes)?;
        let candidate = GpuScene::new(
            Path::new(""),
            scene,
            &RenderOptions::default(),
            Some(&assets),
            context.gpu.clone(),
        )?;
        // Commit is transactional: the previous scene survives any preparation/upload failure.
        context.scene = Some(candidate);
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
        let scene = ready(context)?;
        if additional == 0 || additional > 4096 - scene.samples {
            return Err("Total samples must be 1..4096".into());
        }
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
        ready(context)?;
        context.failed = true;
        context.scene.as_mut().unwrap().reset_raw()?;
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn caught_context_panic_does_not_poison_the_registry() {
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
