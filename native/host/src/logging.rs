//! Serialized application logging, independent of the AOT/context registries.
use std::{cell::Cell, ffi::c_void, sync::Mutex};
pub type Callback = unsafe extern "C" fn(*mut c_void, *const u8, usize);
struct Registration {
    callback: Option<Callback>,
    user: usize,
}
static LOG: Mutex<Registration> = Mutex::new(Registration {
    callback: None,
    user: 0,
});
thread_local! { static IN_CALLBACK: Cell<bool> = const { Cell::new(false) }; }

/// Register a callback, or None for silent operation. See mutracer-log.h.
/// # Safety
/// The callback and user payload must remain valid until replacement returns.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_set_log_callback(callback: Option<Callback>, user: *mut c_void) -> i32 {
    if IN_CALLBACK.get() {
        return crate::Status::InvalidState as i32;
    }
    let mut slot = LOG.lock().unwrap_or_else(|e| e.into_inner());
    *slot = Registration {
        callback,
        user: user as usize,
    };
    0
}
pub(crate) fn emit(message: &str) {
    if IN_CALLBACK.get() {
        return;
    }
    let slot = LOG.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(callback) = slot.callback {
        IN_CALLBACK.set(true);
        unsafe {
            callback(slot.user as *mut c_void, message.as_ptr(), message.len());
        }
        IN_CALLBACK.set(false);
    }
}
macro_rules! native_log { ($($argument:tt)*) => { crate::logging::emit(&format!($($argument)*)) }; }
/// Enable stderr output in standalone diagnostic executables.
pub fn stderr() {
    unsafe extern "C" fn write(_: *mut c_void, bytes: *const u8, length: usize) {
        use std::io::Write;
        let bytes = unsafe { std::slice::from_raw_parts(bytes, length) };
        let mut output = std::io::stderr().lock();
        let _ = output.write_all(bytes);
        let _ = output.write_all(b"\n");
    }
    unsafe {
        mt_set_log_callback(Some(write), std::ptr::null_mut());
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    #[test]
    fn callbacks_are_serialized_and_replacement_drains_borrowed_payload() {
        unsafe extern "C" fn callback(user: *mut c_void, bytes: *const u8, length: usize) {
            if unsafe { std::slice::from_raw_parts(bytes, length) } != b"payload" {
                return;
            }
            assert_eq!(
                unsafe { mt_set_log_callback(None, std::ptr::null_mut()) },
                crate::Status::InvalidState as i32
            );
            unsafe { &*user.cast::<AtomicUsize>() }.fetch_add(1, Ordering::Relaxed);
        }
        let count = Arc::new(AtomicUsize::new(0));
        unsafe {
            assert_eq!(
                mt_set_log_callback(Some(callback), Arc::as_ptr(&count).cast_mut().cast()),
                0
            );
        }
        let workers: Vec<_> = (0..4)
            .map(|_| {
                std::thread::spawn(|| {
                    for _ in 0..100 {
                        emit("payload");
                    }
                })
            })
            .collect();
        for worker in workers {
            worker.join().unwrap();
        }
        unsafe {
            assert_eq!(mt_set_log_callback(None, std::ptr::null_mut()), 0);
        }
        assert_eq!(count.load(Ordering::Relaxed), 400);
        emit("after-unregister");
        assert_eq!(count.load(Ordering::Relaxed), 400);
    }
}
