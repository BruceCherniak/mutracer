//! Independent synchronized OIDN handles; never enter the AOT/render registry.
use crate::denoise::Denoiser;
use anyhow::{Result, bail, ensure};
use std::{
    collections::HashMap,
    ffi::{CStr, c_char},
    panic::AssertUnwindSafe,
    path::Path,
    sync::{
        LazyLock, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

static DENOISERS: LazyLock<Mutex<HashMap<u64, Denoiser>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static NEXT: AtomicU64 = AtomicU64::new(1 << 63);
fn action(error: *mut c_char, capacity: usize, operation: impl FnOnce() -> Result<()>) -> i32 {
    let result = std::panic::catch_unwind(AssertUnwindSafe(|| crate::platform_scope(operation)));
    let message = match result {
        Ok(Ok(())) => String::new(),
        Ok(Err(error)) => format!("{error:#}"),
        Err(_) => "Native denoising operation panicked".into(),
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
    i32::from(!message.is_empty())
}
fn state<T>(handle: u64, operation: impl FnOnce(&mut Denoiser) -> Result<T>) -> Result<T> {
    (move || {
        let mut values = DENOISERS
            .try_lock()
            .map_err(|_| anyhow::anyhow!("Denoiser registry is busy"))?;
        let value = values
            .get_mut(&handle)
            .ok_or_else(|| anyhow::anyhow!("Invalid/destroyed denoiser handle"))?;
        operation(value)
    })()
}

/// # Safety
/// Pointers and ownership follow native/include/mutracer-denoise.h.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_denoiser_create(
    library: *const c_char,
    backend: u32,
    output: *mut u64,
    error: *mut c_char,
    capacity: usize,
) -> i32 {
    action(error, capacity, || {
        ensure!(
            !output.is_null() && (output as usize) % std::mem::align_of::<u64>() == 0,
            "Null or unaligned denoiser handle output"
        );
        ensure!(backend <= 3, "Invalid native OIDN backend preference");
        (|| -> Result<()> {
            let mut values = DENOISERS
                .try_lock()
                .map_err(|_| anyhow::anyhow!("Denoiser registry is busy"))?;
            let denoiser = if library.is_null() {
                Denoiser::with_backend(backend)?
            } else {
                let path = unsafe { CStr::from_ptr(library) }.to_str()?;
                ensure!(!path.is_empty(), "Empty native OIDN library path");
                Denoiser::from_library(Path::new(path), backend)?
            };
            let handle = NEXT
                .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |id| id.checked_add(1))
                .map_err(|_| anyhow::anyhow!("Denoiser handle space exhausted"))?;
            values.insert(handle, denoiser);
            unsafe { *output = handle };
            Ok(())
        })()
    })
}
/// # Safety
/// Pointers and ownership follow native/include/mutracer-denoise.h.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_denoiser_backend(
    handle: u64,
    output: *mut u32,
    error: *mut c_char,
    capacity: usize,
) -> i32 {
    action(error, capacity, || {
        ensure!(
            !output.is_null() && (output as usize) % std::mem::align_of::<u32>() == 0,
            "Null or unaligned denoiser backend output"
        );
        let backend = state(handle, |d| match d.backend {
            "OIDN Metal" => Ok(2),
            "OIDN CPU" => Ok(1),
            "OIDN CUDA" => Ok(3),
            _ => bail!("Unrecognized native OIDN backend"),
        })?;
        unsafe { *output = backend };
        Ok(())
    })
}
/// # Safety
/// Pointers and ownership follow native/include/mutracer-denoise.h.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_denoiser_run(
    handle: u64,
    width: u32,
    height: u32,
    color: *const f32,
    normal: *const f32,
    albedo: *const f32,
    output: *mut f32,
    count: usize,
    error: *mut c_char,
    capacity: usize,
) -> i32 {
    action(error, capacity, || {
        let pixels = (width as usize)
            .checked_mul(height as usize)
            .filter(|n| *n > 0 && *n <= 4_194_304)
            .ok_or_else(|| anyhow::anyhow!("Invalid OIDN image size"))?;
        ensure!(count == pixels * 4, "OIDN RGBA float count mismatch");
        ensure!(
            [color, normal, albedo, output.cast_const()]
                .iter()
                .all(|p| !p.is_null() && (*p as usize) % std::mem::align_of::<f32>() == 0),
            "Null or unaligned OIDN image pointer"
        );
        // No destination write until SDK success. Inputs may overlap each other
        // or the output: the adapter filters into its own initialized buffers.
        let values = {
            let color = unsafe { std::slice::from_raw_parts(color, count) };
            let normal = unsafe { std::slice::from_raw_parts(normal, count) };
            let albedo = unsafe { std::slice::from_raw_parts(albedo, count) };
            state(handle, |d| d.run([width, height], color, normal, albedo))?
        };
        unsafe { std::ptr::copy_nonoverlapping(values.as_ptr(), output, count) };
        Ok(())
    })
}
/// # Safety
/// Pointers and ownership follow native/include/mutracer-denoise.h.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_denoiser_destroy(
    handle: u64,
    error: *mut c_char,
    capacity: usize,
) -> i32 {
    action(error, capacity, || {
        (move || {
            if DENOISERS
                .try_lock()
                .map_err(|_| anyhow::anyhow!("Denoiser registry is busy"))?
                .remove(&handle)
                .is_none()
            {
                bail!("Invalid/destroyed denoiser handle");
            }
            Ok(())
        })()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    static TEST_LOCK: Mutex<()> = Mutex::new(());
    #[test]
    fn sdk_backends_filter_resize_and_preserve_aliased_output_on_failure() {
        let _test = TEST_LOCK.lock().unwrap();
        let Ok(path) = std::env::var("MUTRACER_OIDN_LIBRARY") else {
            return;
        };
        let path = std::ffi::CString::new(path).unwrap();
        let mut preferences = vec![1, 0];
        if std::env::var_os("MUTRACER_TEST_OIDN_CUDA").is_some() {
            preferences.push(3);
        }
        for preference in preferences {
            let mut error = [0 as c_char; 512];
            let mut handle = 0;
            let message = |error: &[c_char]| {
                unsafe { CStr::from_ptr(error.as_ptr()) }
                    .to_string_lossy()
                    .into_owned()
            };
            assert_eq!(
                unsafe {
                    mt_denoiser_create(
                        path.as_ptr(),
                        preference,
                        &mut handle,
                        error.as_mut_ptr(),
                        error.len(),
                    )
                },
                0,
                "{}",
                message(&error)
            );
            let mut backend = 0;
            assert_eq!(
                unsafe {
                    mt_denoiser_backend(handle, &mut backend, error.as_mut_ptr(), error.len())
                },
                0
            );
            if preference != 0 {
                assert_eq!(backend, preference);
            }
            if preference == 0 && std::env::var_os("MUTRACER_TEST_OIDN_CUDA").is_some() {
                assert_eq!(backend, 3);
            }
            for (width, height) in [(32, 24), (48, 32), (32, 24)] {
                let count = width as usize * height as usize;
                let mut color: Vec<f32> = (0..count)
                    .flat_map(|i| {
                        [
                            if i % 3 == 0 { 2. } else { 0.1 },
                            0.3,
                            0.6,
                            (i % 7) as f32 / 7.,
                        ]
                    })
                    .collect();
                let original = color.clone();
                let normal = [0., 0., 1., 1.].repeat(count);
                let albedo = [0.5, 0.5, 0.5, 1.].repeat(count);
                assert_eq!(
                    unsafe {
                        mt_denoiser_run(
                            handle,
                            width,
                            height,
                            color.as_ptr(),
                            normal.as_ptr(),
                            albedo.as_ptr(),
                            color.as_mut_ptr(),
                            color.len(),
                            error.as_mut_ptr(),
                            error.len(),
                        )
                    },
                    0,
                    "{}",
                    message(&error)
                );
                assert_ne!(color, original);
                assert!(color.iter().all(|v| v.is_finite()));
                assert!(
                    color
                        .chunks_exact(4)
                        .zip(original.chunks_exact(4))
                        .all(|(a, b)| a[3] == b[3])
                );
                let filtered = color.clone();
                let mut invalid = normal.clone();
                invalid[0] = f32::NAN;
                assert_ne!(
                    unsafe {
                        mt_denoiser_run(
                            handle,
                            width,
                            height,
                            color.as_ptr(),
                            invalid.as_ptr(),
                            albedo.as_ptr(),
                            color.as_mut_ptr(),
                            color.len(),
                            error.as_mut_ptr(),
                            error.len(),
                        )
                    },
                    0
                );
                assert_eq!(color, filtered);
            }
            assert_eq!(
                unsafe { mt_denoiser_destroy(handle, error.as_mut_ptr(), error.len()) },
                0
            );
        }
    }
    #[test]
    fn denoiser_can_be_queried_and_destroyed_from_another_thread() {
        let _test = TEST_LOCK.lock().unwrap();
        let Ok(path) = std::env::var("MUTRACER_OIDN_LIBRARY") else {
            return;
        };
        let path = std::ffi::CString::new(path).unwrap();
        let mut handle = 0;
        let mut error = [0 as c_char; 512];
        assert_eq!(
            unsafe {
                mt_denoiser_create(
                    path.as_ptr(),
                    1,
                    &mut handle,
                    error.as_mut_ptr(),
                    error.len(),
                )
            },
            0
        );
        std::thread::spawn(move || {
            let mut error = [0 as c_char; 512];
            let mut backend = 99;
            assert_eq!(
                unsafe {
                    mt_denoiser_backend(handle, &mut backend, error.as_mut_ptr(), error.len())
                },
                0
            );
            assert_eq!(backend, 1);
            assert_eq!(
                unsafe { mt_denoiser_destroy(handle, error.as_mut_ptr(), error.len()) },
                0
            );
            assert_ne!(
                unsafe { mt_denoiser_destroy(handle, error.as_mut_ptr(), error.len()) },
                0
            );
        })
        .join()
        .unwrap();
    }
    #[test]
    fn invalid_handles_and_options_preserve_outputs_without_sdk() {
        let _test = TEST_LOCK.lock().unwrap();
        let mut error = [0 as c_char; 128];
        let mut handle = 42;
        assert_ne!(
            unsafe {
                mt_denoiser_create(
                    std::ptr::null(),
                    99,
                    &mut handle,
                    error.as_mut_ptr(),
                    error.len(),
                )
            },
            0
        );
        assert_eq!(handle, 42);
        let mut backend = 17;
        assert_ne!(
            unsafe { mt_denoiser_backend(0, &mut backend, error.as_mut_ptr(), error.len()) },
            0
        );
        assert_eq!(backend, 17);
        let input = [0.5f32; 64];
        let mut output = [123.25f32; 64];
        for count in [0, 63, 64] {
            assert_ne!(
                unsafe {
                    mt_denoiser_run(
                        0,
                        4,
                        4,
                        input.as_ptr(),
                        input.as_ptr(),
                        input.as_ptr(),
                        output.as_mut_ptr(),
                        count,
                        error.as_mut_ptr(),
                        error.len(),
                    )
                },
                0
            );
            assert_eq!(output, [123.25; 64]);
        }
        assert_ne!(
            unsafe { mt_denoiser_destroy(0, std::ptr::null_mut(), 0) },
            0
        );
    }
    #[test]
    fn load_failure_preserves_handle_and_terminates_tiny_error_buffer() {
        let _test = TEST_LOCK.lock().unwrap();
        for capacity in 1..=128 {
            let mut error = [1 as c_char; 128];
            let mut handle = 42;
            assert_ne!(
                unsafe {
                    mt_denoiser_create(
                        c"/mutracer-missing/不存在/oidn.dylib".as_ptr(),
                        0,
                        &mut handle,
                        error.as_mut_ptr(),
                        capacity,
                    )
                },
                0
            );
            assert_eq!(handle, 42);
            assert!(error[..capacity].contains(&0));
            assert!(unsafe { CStr::from_ptr(error.as_ptr()) }.to_str().is_ok());
        }
    }
}
