//! Incremental commit oracle: committing an edited descriptor over a committed
//! scene must render the same HDR, normal and albedo bytes as committing it to
//! a new context. Usage: incremental-oracle SAMPLES BACKEND SCENE.bin...
//! Prints one JSON line per fixture and edit; exits nonzero on any mismatch or
//! when an edit that should be incremental fell back to full preparation.
use mutracer_native_probe::context::{self as native, last_commit_incremental};
use mutracer_native_probe::layout::{
    camera as cam, geometry as g, header as h, light as l, material as mat, mesh as m, texture as t,
};

type Result<T> = std::result::Result<T, String>;

fn call(operation: impl FnOnce(*mut i8, usize) -> i32) -> Result<()> {
    let mut error = [0i8; 4096];
    if operation(error.as_mut_ptr(), error.len()) != 0 {
        let message = unsafe { std::ffi::CStr::from_ptr(error.as_ptr()) };
        return Err(message.to_string_lossy().into_owned());
    }
    Ok(())
}
fn u(bytes: &[u8], i: usize) -> usize {
    u32::from_le_bytes(bytes[i * 4..i * 4 + 4].try_into().unwrap()) as usize
}
fn set_f(bytes: &mut [u8], i: usize, value: f32) {
    bytes[i * 4..i * 4 + 4].copy_from_slice(&value.to_le_bytes());
}
/// Adds `delta` to the f32 word `i`.
fn add_f(bytes: &mut [u8], i: usize, delta: f32) {
    let value = get_f(bytes, i) + delta;
    set_f(bytes, i, value);
}
fn get_f(bytes: &[u8], i: usize) -> f32 {
    f32::from_le_bytes(bytes[i * 4..i * 4 + 4].try_into().unwrap())
}

struct Context(u64);
impl Context {
    fn new(backend: u32) -> Result<Self> {
        let mut handle = 0;
        call(|e, n| unsafe { native::mt_context_create_with_backend(backend, &mut handle, e, n) })?;
        Ok(Self(handle))
    }
    fn commit(&self, bytes: &[u8]) -> Result<()> {
        call(|e, n| unsafe { native::mt_context_commit(self.0, bytes.as_ptr(), bytes.len(), e, n) })
    }
    fn images(&self, samples: u32) -> Result<Vec<Vec<u8>>> {
        call(|e, n| unsafe { native::mt_context_render(self.0, samples, e, n) })?;
        (0..3)
            .map(|kind| {
                let mut written = 0;
                call(|e, n| unsafe {
                    native::mt_context_read_pixels(
                        self.0,
                        kind,
                        std::ptr::null_mut(),
                        0,
                        &mut written,
                        e,
                        n,
                    )
                })?;
                let mut pixels = vec![0u8; written];
                call(|e, n| unsafe {
                    native::mt_context_read_pixels(
                        self.0,
                        kind,
                        pixels.as_mut_ptr().cast(),
                        pixels.len(),
                        &mut written,
                        e,
                        n,
                    )
                })?;
                Ok(pixels)
            })
            .collect()
    }
}
impl Drop for Context {
    fn drop(&mut self) {
        let _ = call(|e, n| unsafe { native::mt_context_destroy(self.0, e, n) });
    }
}

/// Edits that keep the descriptor valid. `true`: expected to stay incremental.
type Edit = (&'static str, bool, fn(&mut Vec<u8>) -> bool);
fn instanced(bytes: &[u8], mesh: usize) -> bool {
    u(bytes, h::BATCH_OFFSET) != 0
        && u(bytes, u(bytes, h::BATCH_OFFSET) + mesh * 4) != u32::MAX as usize
}
fn edits() -> Vec<Edit> {
    vec![
        ("identical", true, |_| true),
        ("mesh transform", true, |b| {
            let i = (0..u(b, h::MESH_COUNT)).find(|&i| !instanced(b, i));
            let Some(i) = i else { return false };
            let o = u(b, h::MESH_OFFSET) + i * m::WORDS + m::TRANSFORM + 12;
            add_f(b, o, 0.25);
            true
        }),
        ("material roughness and color", true, |b| {
            let o = u(b, h::MATERIAL_OFFSET);
            set_f(b, o + mat::ROUGHNESS, 0.9);
            set_f(b, o + mat::BASE_COLOR, 0.25);
            true
        }),
        ("vertex position", true, |b| {
            let o = u(b, h::GEOMETRY_OFFSET);
            let p = u(b, o + g::POSITION);
            add_f(b, p + 1, 0.01);
            true
        }),
        ("light intensity", true, |b| {
            if u(b, h::LIGHT_COUNT) == 0 {
                return false;
            }
            let o = u(b, h::LIGHT_OFFSET) + l::INTENSITY;
            let value = get_f(b, o) * 2.0;
            set_f(b, o, value);
            true
        }),
        ("camera", true, |b| {
            let o = u(b, h::CAMERA_OFFSET);
            add_f(b, o + cam::FOV, 5.0);
            add_f(b, o + cam::TRANSFORM + 12, 0.1);
            true
        }),
        ("background color", true, |b| {
            set_f(b, h::BACKGROUND_COLOR + 1, 0.5);
            true
        }),
        ("mesh transform y", true, |b| {
            let i = (0..u(b, h::MESH_COUNT)).find(|&i| !instanced(b, i));
            let Some(i) = i else { return false };
            let o = u(b, h::MESH_OFFSET) + i * m::WORDS + m::TRANSFORM + 13;
            add_f(b, o, -0.2);
            true
        }),
        ("material metalness", true, |b| {
            let material = u(b, h::MATERIAL_OFFSET) + mat::METALNESS;
            set_f(b, material, 0.5);
            true
        }),
        ("camera y", true, |b| {
            let c = u(b, h::CAMERA_OFFSET);
            add_f(b, c + cam::TRANSFORM + 13, 0.05);
            true
        }),
        ("transform and material", true, |b| {
            let i = (0..u(b, h::MESH_COUNT)).find(|&i| !instanced(b, i));
            let Some(i) = i else { return false };
            let o = u(b, h::MESH_OFFSET) + i * m::WORDS + m::TRANSFORM + 13;
            add_f(b, o, -0.2);
            let material = u(b, h::MATERIAL_OFFSET) + mat::METALNESS;
            set_f(b, material, 0.5);
            true
        }),
        ("transform and camera", true, |b| {
            let i = (0..u(b, h::MESH_COUNT)).find(|&i| !instanced(b, i));
            let Some(i) = i else { return false };
            let o = u(b, h::MESH_OFFSET) + i * m::WORDS + m::TRANSFORM + 13;
            add_f(b, o, -0.2);
            let c = u(b, h::CAMERA_OFFSET);
            add_f(b, c + cam::TRANSFORM + 13, 0.05);
            true
        }),
        ("material and camera", true, |b| {
            let material = u(b, h::MATERIAL_OFFSET) + mat::METALNESS;
            set_f(b, material, 0.5);
            let c = u(b, h::CAMERA_OFFSET);
            add_f(b, c + cam::TRANSFORM + 13, 0.05);
            true
        }),
        ("transform, material and camera", true, |b| {
            let i = (0..u(b, h::MESH_COUNT)).find(|&i| !instanced(b, i));
            let Some(i) = i else { return false };
            let o = u(b, h::MESH_OFFSET) + i * m::WORDS + m::TRANSFORM + 13;
            add_f(b, o, -0.2);
            let material = u(b, h::MATERIAL_OFFSET) + mat::METALNESS;
            set_f(b, material, 0.5);
            let c = u(b, h::CAMERA_OFFSET);
            add_f(b, c + cam::TRANSFORM + 13, 0.05);
            true
        }),
        // Out of scope for this phase: these must fall back to full preparation.
        ("texture pixel", false, |b| {
            if u(b, h::TEXTURE_COUNT) == 0 {
                return false;
            }
            let o = u(b, h::TEXTURE_OFFSET);
            let p = u(b, o + t::PIXELS);
            b[p * 4] ^= 0x10;
            true
        }),
    ]
}

fn main() -> std::result::Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 4 {
        return Err("usage: incremental-oracle SAMPLES BACKEND SCENE.bin...".into());
    }
    let samples: u32 = args[1].parse()?;
    let backend: u32 = args[2].parse()?;
    let mut failures = 0;
    let mut skipped = 0;
    for path in &args[3..] {
        let base = std::fs::read(path)?;
        for (name, expect_incremental, edit) in edits() {
            let mut edited = base.clone();
            if !edit(&mut edited) {
                continue;
            }
            // The reference is a full commit of the edited descriptor to a new context.
            // An edit the renderer cannot render at all is reported, not counted.
            let stage = |name: &'static str| move |error: String| format!("{name}: {error}");
            let reference = (|| -> Result<Vec<Vec<u8>>> {
                let full = Context::new(backend)?;
                full.commit(&edited).map_err(stage("full commit"))?;
                full.images(samples).map_err(stage("full render"))
            })();
            let b = match reference {
                Ok(images) => images,
                Err(error) => {
                    skipped += 1;
                    println!(
                        "{}",
                        serde_json::json!({"scene": path, "edit": name, "referenceError": error, "skipped": true})
                    );
                    continue;
                }
            };
            let outcome = (|| -> Result<(bool, [bool; 3])> {
                let incremental = Context::new(backend)?;
                incremental.commit(&base).map_err(stage("base commit"))?;
                incremental
                    .commit(&edited)
                    .map_err(stage("edited commit"))?;
                let path_incremental = last_commit_incremental(incremental.0)?;
                let a = incremental
                    .images(samples)
                    .map_err(stage("incremental render"))?;
                Ok((path_incremental, [a[0] == b[0], a[1] == b[1], a[2] == b[2]]))
            })();
            let (pass, json) = match outcome {
                Ok((path_incremental, same)) => {
                    let pass = same.iter().all(|s| *s) && path_incremental == expect_incremental;
                    (
                        pass,
                        serde_json::json!({"scene": path, "edit": name, "incremental": path_incremental,
                        "expectedIncremental": expect_incremental, "hdr": same[0], "normal": same[1], "albedo": same[2], "pass": pass}),
                    )
                }
                Err(error) => (
                    false,
                    serde_json::json!({"scene": path, "edit": name, "error": error, "pass": false}),
                ),
            };
            if !pass {
                failures += 1;
            }
            println!("{json}");
        }
    }
    eprintln!("{failures} failed, {skipped} skipped because the full-commit reference failed");
    if failures > 0 {
        return Err(format!("{failures} incremental oracle cases failed").into());
    }
    Ok(())
}
