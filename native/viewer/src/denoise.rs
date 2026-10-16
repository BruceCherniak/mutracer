//! Native OIDN C API, kept off the window and AOT owner thread.
//! ABI reference: https://github.com/RenderKit/oidn/blob/v2.5.1/include/OpenImageDenoise/oidn.h
use anyhow::{Context, Result, bail, ensure};
use libloading::Library;
use std::{
    ffi::{CStr, c_char, c_void},
    path::PathBuf,
    ptr,
    sync::mpsc,
    thread,
    time::Instant,
};

type Handle = *mut c_void;
macro_rules! api {
    ($($name:ident: $ty:ty),+ $(,)?) => {
        #[allow(non_snake_case)]
        struct Api { $($name: $ty,)+ _library: Library }
        impl Api {
            unsafe fn load(path: &std::path::Path) -> Result<Self> {
                let library = unsafe { Library::new(path) }.context("Loading native Open Image Denoise")?;
                Ok(Self { $($name: unsafe { *library.get(concat!(stringify!($name), "\0").as_bytes())? },)+ _library: library })
            }
        }
    }
}
api! {
    oidnNewDevice: unsafe extern "C" fn(i32) -> Handle,
    oidnCommitDevice: unsafe extern "C" fn(Handle),
    oidnReleaseDevice: unsafe extern "C" fn(Handle),
    oidnGetDeviceError: unsafe extern "C" fn(Handle, *mut *const c_char) -> i32,
    oidnNewBuffer: unsafe extern "C" fn(Handle, usize) -> Handle,
    oidnGetBufferData: unsafe extern "C" fn(Handle) -> *mut c_void,
    oidnReleaseBuffer: unsafe extern "C" fn(Handle),
    oidnNewFilter: unsafe extern "C" fn(Handle, *const c_char) -> Handle,
    oidnReleaseFilter: unsafe extern "C" fn(Handle),
    oidnSetFilterImage: unsafe extern "C" fn(Handle, *const c_char, Handle, i32, usize, usize, usize, usize, usize),
    oidnSetFilterBool: unsafe extern "C" fn(Handle, *const c_char, bool),
    oidnCommitFilter: unsafe extern "C" fn(Handle),
    oidnExecuteFilter: unsafe extern "C" fn(Handle),
}
pub struct Denoiser {
    api: Api,
    device: Handle,
    filter: Handle,
    buffers: Vec<Handle>,
    size: [u32; 2],
    pub backend: &'static str,
}
impl Denoiser {
    pub fn new() -> Result<Self> {
        let path = std::env::var_os("MUTRACER_OIDN_LIBRARY")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                std::env::current_exe()
                    .unwrap()
                    .parent()
                    .unwrap()
                    .join("../Frameworks/libOpenImageDenoise.2.dylib")
            });
        let api = unsafe { Api::load(&path)? };
        for (kind, backend) in [(5, "OIDN Metal"), (1, "OIDN CPU")] {
            let device = unsafe { (api.oidnNewDevice)(kind) };
            if device.is_null() {
                let _ = error(&api, device);
                continue;
            }
            unsafe { (api.oidnCommitDevice)(device) };
            if error(&api, device).is_ok() {
                return Ok(Self {
                    api,
                    device,
                    filter: ptr::null_mut(),
                    buffers: vec![],
                    size: [0; 2],
                    backend,
                });
            }
            unsafe { (api.oidnReleaseDevice)(device) };
        }
        bail!("Native OIDN could not create a Metal or CPU device")
    }
    fn clear(&mut self) {
        unsafe {
            if !self.filter.is_null() {
                (self.api.oidnReleaseFilter)(self.filter);
                self.filter = ptr::null_mut();
            }
            for buffer in self.buffers.drain(..) {
                (self.api.oidnReleaseBuffer)(buffer);
            }
        }
        self.size = [0; 2];
    }
    pub fn run(
        &mut self,
        size: [u32; 2],
        color: &[f32],
        normal: &[f32],
        albedo: &[f32],
    ) -> Result<Vec<f32>> {
        let pixels = (size[0] as usize)
            .checked_mul(size[1] as usize)
            .filter(|count| *count > 0 && *count <= 4_194_304)
            .context("Invalid OIDN image size")?;
        let count = pixels * 4;
        ensure!(
            count > 0
                && count <= 4_194_304 * 4
                && [color, normal, albedo]
                    .iter()
                    .all(|v| v.len() == count && v.iter().all(|x| x.is_finite())),
            "Invalid OIDN input images"
        );
        if self.size != size {
            self.clear();
            unsafe {
                self.filter = (self.api.oidnNewFilter)(self.device, c"RT".as_ptr());
                error(&self.api, self.device)?;
                ensure!(!self.filter.is_null(), "OIDN filter allocation failed");
                for name in [c"color", c"normal", c"albedo", c"output"] {
                    let buffer = (self.api.oidnNewBuffer)(self.device, count * 4);
                    if !buffer.is_null() {
                        self.buffers.push(buffer);
                    }
                    error(&self.api, self.device)?;
                    ensure!(!buffer.is_null(), "OIDN buffer allocation failed");
                    // RGBA storage, RGB filter image; alpha is copied untouched below.
                    (self.api.oidnSetFilterImage)(
                        self.filter,
                        name.as_ptr(),
                        buffer,
                        3,
                        size[0] as usize,
                        size[1] as usize,
                        0,
                        16,
                        size[0] as usize * 16,
                    );
                }
                (self.api.oidnSetFilterBool)(self.filter, c"hdr".as_ptr(), true);
                // Accumulated guides contain sampling noise, so never mark them clean.
                (self.api.oidnSetFilterBool)(self.filter, c"cleanAux".as_ptr(), false);
                (self.api.oidnCommitFilter)(self.filter);
                error(&self.api, self.device)?;
            }
            self.size = size;
        }
        unsafe {
            // Float3 writes RGB only. Initialize output RGBA too, so copying
            // the result never reads uninitialized padding/alpha from the SDK.
            for (buffer, data) in self.buffers.iter().zip([color, normal, albedo, color]) {
                let destination = (self.api.oidnGetBufferData)(*buffer).cast::<f32>();
                error(&self.api, self.device)?;
                ensure!(!destination.is_null(), "OIDN buffer is not host-accessible");
                ptr::copy_nonoverlapping(data.as_ptr(), destination, count);
            }
            (self.api.oidnExecuteFilter)(self.filter);
            error(&self.api, self.device)?;
            let output = (self.api.oidnGetBufferData)(self.buffers[3]).cast::<f32>();
            error(&self.api, self.device)?;
            ensure!(!output.is_null(), "OIDN output is not host-accessible");
            let mut values = std::slice::from_raw_parts(output, count).to_vec();
            for (dst, src) in values.chunks_exact_mut(4).zip(color.chunks_exact(4)) {
                dst[3] = src[3];
            }
            ensure!(
                values.iter().all(|v| v.is_finite()),
                "OIDN returned non-finite pixels"
            );
            Ok(values)
        }
    }
}
fn error(api: &Api, device: Handle) -> Result<()> {
    let mut message = ptr::null();
    let code = unsafe { (api.oidnGetDeviceError)(device, &mut message) };
    if code != 0 {
        let message = if message.is_null() {
            format!("OIDN error {code}")
        } else {
            unsafe { CStr::from_ptr(message) }
                .to_string_lossy()
                .into_owned()
        };
        bail!(message);
    }
    Ok(())
}
impl Drop for Denoiser {
    fn drop(&mut self) {
        self.clear();
        unsafe { (self.api.oidnReleaseDevice)(self.device) };
    }
}

pub struct Request {
    pub generation: u64,
    pub samples: u32,
    pub size: [u32; 2],
    pub color: Vec<f32>,
    pub normal: Vec<f32>,
    pub albedo: Vec<f32>,
}
pub struct Output {
    pub generation: u64,
    pub samples: u32,
    pub pixels: Result<Vec<f32>, String>,
    pub backend: String,
    pub milliseconds: f64,
}
pub struct Worker {
    sender: mpsc::SyncSender<Request>,
    receiver: mpsc::Receiver<Output>,
    pub busy: bool,
}
impl Worker {
    pub fn new(ctx: eframe::egui::Context) -> Self {
        let (sender, requests) = mpsc::sync_channel::<Request>(1);
        let (results, receiver) = mpsc::channel();
        thread::Builder::new()
            .name("MuTracer native OIDN".into())
            .spawn(move || {
                let mut denoiser = Denoiser::new().map_err(|e| format!("{e:#}"));
                while let Ok(request) = requests.recv() {
                    let start = Instant::now();
                    let backend = denoiser
                        .as_ref()
                        .map(|d| d.backend)
                        .unwrap_or("OIDN unavailable")
                        .to_owned();
                    let pixels = match &mut denoiser {
                        Ok(d) => d
                            .run(
                                request.size,
                                &request.color,
                                &request.normal,
                                &request.albedo,
                            )
                            .map_err(|e| format!("{e:#}")),
                        Err(e) => Err(e.clone()),
                    };
                    if results
                        .send(Output {
                            generation: request.generation,
                            samples: request.samples,
                            pixels,
                            backend,
                            milliseconds: start.elapsed().as_secs_f64() * 1000.,
                        })
                        .is_err()
                    {
                        break;
                    }
                    ctx.request_repaint();
                }
            })
            .expect("Creating native denoising worker");
        Self {
            sender,
            receiver,
            busy: false,
        }
    }
    pub fn submit(&mut self, request: Request) -> Result<()> {
        ensure!(!self.busy, "OIDN is already busy");
        self.sender
            .try_send(request)
            .context("Submitting native denoise")?;
        self.busy = true;
        Ok(())
    }
    pub fn poll(&mut self) -> Option<Output> {
        let output = self.receiver.try_recv().ok()?;
        self.busy = false;
        Some(output)
    }
}
