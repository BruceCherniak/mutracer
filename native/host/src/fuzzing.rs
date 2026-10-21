//! Fuzz-only entry points, excluded from production builds.
use crate::{context, scene};
use std::sync::OnceLock;

pub fn seed() -> Vec<u8> {
    scene::small_fixture()
}
pub fn validate(bytes: &[u8]) {
    let _ = scene::validate(bytes);
}
pub fn commit(bytes: &[u8]) {
    if bytes.len() > 65536 || scene::validate(bytes).is_err() || !scene::fuzz_budget(bytes) {
        return;
    }
    static HANDLES: OnceLock<[u64; 2]> = OnceLock::new();
    let handles = HANDLES.get_or_init(|| {
        std::array::from_fn(|backend| {
            let mut handle = 0;
            let mut error = [0i8; 512];
            assert_eq!(
                unsafe {
                    context::mt_context_create_with_backend(
                        backend as u32,
                        &mut handle,
                        error.as_mut_ptr(),
                        error.len(),
                    )
                },
                0,
                "GPU adapter required for full-commit fuzzing"
            );
            handle
        })
    });
    for (backend, &handle) in handles.iter().enumerate() {
        let mut error = [0i8; 4096];
        let status = unsafe {
            context::mt_context_commit(
                handle,
                bytes.as_ptr(),
                bytes.len(),
                error.as_mut_ptr(),
                error.len(),
            )
        };
        if status == 0 {
            let mut active = 99;
            let mut reason = [0i8; 128];
            assert_eq!(
                unsafe {
                    context::mt_context_backend(
                        handle,
                        &mut active,
                        reason.as_mut_ptr(),
                        reason.len(),
                        error.as_mut_ptr(),
                        error.len(),
                    )
                },
                0
            );
            assert_eq!(
                active, backend as u32,
                "unexpected backend fallback in fuzzing"
            );
            assert_eq!(
                unsafe {
                    context::mt_context_wait(handle, 30_000, error.as_mut_ptr(), error.len())
                },
                0,
                "complete commit must reach GPU completion"
            );
        } else {
            let message = unsafe { std::ffi::CStr::from_ptr(error.as_ptr()) }.to_string_lossy();
            assert!(!message.contains("panicked"), "{message}");
        }
    }
}
