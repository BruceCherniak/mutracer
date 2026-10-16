//! Thin owner-thread client of the same experimental native ABI used by C examples.
use anyhow::{Result, bail, ensure};
use glam::{Mat4, Vec3};
use mutracer_native_probe::context as native;
use std::{
    ffi::CStr,
    marker::PhantomData,
    rc::Rc,
    time::{Duration, Instant},
};

pub struct Renderer {
    handle: u64,
    pub mode: u32,
    job: Option<u64>,
    _owner: PhantomData<Rc<()>>,
}
fn check(operation: impl FnOnce(*mut i8, usize) -> i32) -> Result<()> {
    let mut error = [0i8; 4096];
    if operation(error.as_mut_ptr(), error.len()) != 0 {
        bail!(
            unsafe { CStr::from_ptr(error.as_ptr()) }
                .to_string_lossy()
                .into_owned()
        );
    }
    Ok(())
}
impl Renderer {
    pub fn new() -> Result<Self> {
        Self::with_backend(0)
    }
    pub fn with_backend(mode: u32) -> Result<Self> {
        let mut handle = 0;
        check(|e, n| unsafe { native::mt_context_create_with_backend(mode, &mut handle, e, n) })?;
        Ok(Self {
            handle,
            mode,
            job: None,
            _owner: PhantomData,
        })
    }
    pub fn backend(&self) -> Result<(u32, String)> {
        let mut active = 0;
        let mut reason = [0i8; 512];
        check(|e, n| unsafe {
            native::mt_context_backend(
                self.handle,
                &mut active,
                reason.as_mut_ptr(),
                reason.len(),
                e,
                n,
            )
        })?;
        Ok((
            active,
            unsafe { CStr::from_ptr(reason.as_ptr()) }
                .to_string_lossy()
                .into_owned(),
        ))
    }
    pub fn counts(&self) -> Result<[u32; 11]> {
        let mut counts = [0; 11];
        check(|e, n| unsafe {
            native::mt_context_hwrt_counts(self.handle, counts.as_mut_ptr(), counts.len(), e, n)
        })?;
        Ok(counts)
    }
    pub fn commit(&mut self, bytes: &[u8]) -> Result<()> {
        ensure!(self.job.is_none(), "Drain current job before committing");
        check(|e, n| unsafe {
            native::mt_context_commit(self.handle, bytes.as_ptr(), bytes.len(), e, n)
        })
    }
    pub fn camera(&mut self, bytes: &[u8]) -> Result<()> {
        check(|e, n| unsafe {
            native::mt_context_update_camera(self.handle, bytes.as_ptr(), bytes.len(), e, n)
        })
    }
    pub fn reset(&mut self) -> Result<()> {
        check(|e, n| unsafe { native::mt_context_reset(self.handle, e, n) })
    }
    pub fn samples(&self) -> Result<u32> {
        let mut info = native::ContextInfo {
            struct_size: 32,
            version: 0,
            width: 0,
            height: 0,
            samples: 0,
            state: 0,
            reserved: [0; 2],
        };
        check(|e, n| unsafe { native::mt_context_info(self.handle, &mut info, e, n) })?;
        Ok(info.samples)
    }
    pub fn busy(&self) -> bool {
        self.job.is_some()
    }
    pub fn cancel(&mut self) -> Result<()> {
        if let Some(job) = self.job {
            check(|e, n| unsafe { native::mt_job_cancel(job, e, n) })?;
        }
        Ok(())
    }
    pub fn start(&mut self, samples: u32) -> Result<()> {
        ensure!(self.job.is_none(), "Render job is already active");
        let mut job = 0;
        check(|e, n| unsafe { native::mt_context_submit(self.handle, samples, &mut job, e, n) })?;
        self.job = Some(job);
        Ok(())
    }
    /// Returns true when a job reached completion/cancellation and allows readback.
    pub fn poll(&mut self) -> Result<bool> {
        let Some(job) = self.job else {
            return Ok(false);
        };
        if let Err(error) = check(|e, n| unsafe { native::mt_job_poll(job, 1, e, n) }) {
            self.job = None;
            return Err(error);
        }
        let mut info = native::JobInfo {
            struct_size: 32,
            version: 0,
            state: 0,
            requested_samples: 0,
            submitted_samples: 0,
            completed_samples: 0,
            base_samples: 0,
            reserved: 0,
        };
        check(|e, n| unsafe { native::mt_job_info(job, &mut info, e, n) })?;
        match info.state {
            2 | 3 => {
                self.job = None;
                Ok(true)
            }
            4 => bail!("Native render job failed"),
            _ => Ok(false),
        }
    }
    pub fn image(&self, kind: u32) -> Result<Vec<f32>> {
        let mut bytes = 0;
        check(|e, n| unsafe {
            native::mt_context_read_pixels(
                self.handle,
                kind,
                std::ptr::null_mut(),
                0,
                &mut bytes,
                e,
                n,
            )
        })?;
        let mut pixels = vec![0u8; bytes];
        check(|e, n| unsafe {
            native::mt_context_read_pixels(
                self.handle,
                kind,
                pixels.as_mut_ptr(),
                pixels.len(),
                &mut bytes,
                e,
                n,
            )
        })?;
        let pixels: Vec<f32> = pixels
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
            .collect();
        ensure!(
            pixels.iter().all(|v| v.is_finite()),
            "Non-finite rendered pixels"
        );
        Ok(pixels)
    }
    pub fn pixels(&self) -> Result<Vec<f32>> {
        self.image(0)
    }
    pub fn finish(&mut self, samples: u32) -> Result<Vec<f32>> {
        self.start(samples)?;
        let deadline = Instant::now() + Duration::from_secs(120);
        while !self.poll()? {
            ensure!(Instant::now() < deadline, "Render timed out");
            std::thread::sleep(Duration::from_millis(1));
        }
        self.pixels()
    }
}
impl Drop for Renderer {
    fn drop(&mut self) {
        let _ = self.cancel();
        let deadline = Instant::now() + Duration::from_secs(10);
        while self.busy() && Instant::now() < deadline {
            if self.poll().is_err() {
                break;
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        let _ = check(|e, n| unsafe { native::mt_context_destroy(self.handle, e, n) });
    }
}
#[derive(Clone)]
pub struct Camera {
    pub target: Vec3,
    pub yaw: f32,
    pub pitch: f32,
    pub distance: f32,
    pub radius: f32,
    pub fov: f32,
}
impl Camera {
    pub fn fit(center: Vec3, radius: f32) -> Self {
        Self {
            target: center,
            yaw: 0.6,
            pitch: 0.3,
            distance: radius * 2.8,
            radius,
            fov: 45.,
        }
    }
    pub fn eye(&self) -> Vec3 {
        self.target
            + Vec3::new(
                self.yaw.sin() * self.pitch.cos(),
                self.pitch.sin(),
                self.yaw.cos() * self.pitch.cos(),
            ) * self.distance
    }
    pub fn orbit(&mut self, delta: [f32; 2]) {
        self.yaw -= delta[0] * 0.008;
        self.pitch = (self.pitch + delta[1] * 0.008).clamp(-1.5, 1.5);
    }
    pub fn pan(&mut self, delta: [f32; 2]) {
        let forward = (self.target - self.eye()).normalize();
        let right = forward.cross(Vec3::Y).normalize();
        let up = right.cross(forward);
        self.target += (-right * delta[0] + up * delta[1]) * self.distance * 0.002;
    }
    pub fn zoom(&mut self, delta: f32) {
        self.distance =
            (self.distance * (-delta * 0.002).exp()).clamp(self.radius * 0.03, self.radius * 100.);
    }
    pub fn bytes(&self) -> Vec<u8> {
        let mut f = [0f32; 32];
        f[1] = self.fov;
        f[2] = (self.radius * 0.0001).max(0.00001);
        f[3] = (self.radius * 1000.).max(100.);
        f[4] = -1.;
        f[5] = 1.;
        f[6] = -1.;
        f[7] = 1.;
        f[8] = 1.;
        f[10] = self.distance;
        f[11] = 24.;
        f[12] = 1.;
        let world = Mat4::look_at_rh(self.eye(), self.target, Vec3::Y).inverse();
        f[16..32].copy_from_slice(&world.to_cols_array());
        f.into_iter().flat_map(f32::to_le_bytes).collect()
    }
}
/// Display-only Reinhard/sRGB conversion; HDR stays unchanged for comparisons.
pub fn display(pixels: &[f32], size: [u32; 2], exposure: f32) -> Vec<u8> {
    let mut rgba = Vec::with_capacity(pixels.len());
    let gain = 2f32.powf(exposure);
    for y in (0..size[1] as usize).rev() {
        for x in 0..size[0] as usize {
            let o = (y * size[0] as usize + x) * 4;
            for c in 0..3 {
                let v = (pixels[o + c] * gain).max(0.);
                let v = v / (1. + v);
                let s = if v <= 0.0031308 {
                    12.92 * v
                } else {
                    1.055 * v.powf(1. / 2.4) - 0.055
                };
                rgba.push((s.clamp(0., 1.) * 255. + 0.5) as u8);
            }
            rgba.push(255);
        }
    }
    rgba
}
pub fn save(path: &std::path::Path, pixels: &[f32], size: [u32; 2], exposure: f32) -> Result<()> {
    image::save_buffer_with_format(
        path,
        &display(pixels, size, exposure),
        size[0],
        size[1],
        image::ColorType::Rgba8,
        image::ImageFormat::Png,
    )?;
    Ok(())
}
