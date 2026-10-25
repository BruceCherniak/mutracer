//! Display-pass recording without holding the engine or context registry locks.
use super::display::{Display, DisplaySettings, Presented, Selection, select};
use super::engine::{Engine, Inner};
use super::render::{Render, readiness};
use super::{Result, Status, error};
use std::sync::{Arc, Mutex, Weak};

/// Borrowed GPU image to inspect. There is no default; select a kind explicitly.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OutputKind {
    /// Resolved linear ray color and coverage before denoising/display composition.
    /// RGBA32Float, top row first; RGB uses hit normalization as on WebGPU.
    Hdr,
    /// Latest composition including display passes, at the actual render size.
    /// RGBA8Unorm, sRGB-encoded straight alpha, top row first.
    Display,
}
/// Images and encoder borrowed for one synchronous display pass. Do not retain,
/// destroy or write the input. Record into `encoder`; the library submits it.
pub struct PostProcessContext<'a> {
    /// Engine device for creating pass resources.
    pub device: &'a wgpu::Device,
    /// Record commands here; the library finishes and submits this encoder.
    pub encoder: &'a mut wgpu::CommandEncoder,
    // Native passes split recording into ordered wgpu/raw command buffers. They
    // stay unsubmitted until the entire display chain succeeds.
    #[cfg_attr(
        not(any(target_os = "linux", target_os = "windows", feature = "vulkan-interop")),
        allow(dead_code)
    )]
    pub(crate) commands: &'a mut Vec<wgpu::CommandBuffer>,
    /// Straight-alpha RGBA8Unorm for SDR registrations; linear RGBA16Float
    /// for add_hdr_post_process. Check input.format() when sharing pass code.
    pub input: &'a wgpu::Texture,
    /// Fully write this image. Same format/size as input; storage, render and copy writes supported.
    pub output: &'a wgpu::Texture,
    /// Actual selected render width, before display scaling.
    pub width: u32,
    /// Actual selected render height, before display scaling.
    pub height: u32,
    /// Selected complete render, including a selected fallback. May be inspected.
    pub render: &'a Render,
}
type Pass = Arc<Mutex<Box<dyn FnMut(PostProcessContext<'_>) -> Result<()> + Send>>>;
pub(super) type Entry = (u64, Pass);

/// Removes a display pass when dropped. Removal is idempotent and takes effect
/// on the next composition; the current chain uses its registration snapshot.
#[must_use = "dropping this handle removes the display pass"]
pub struct PostProcessSubscription {
    inner: Weak<Inner>,
    id: u64,
}
impl PostProcessSubscription {
    /// Removes the pass from the next composition. Repeated calls do nothing.
    pub fn remove(&self) {
        if let Some(inner) = self.inner.upgrade() {
            let engine = Engine { inner };
            let mut state = engine.lock();
            let display = &mut state.display;
            let count = display.passes.len() + display.hdr_passes.len();
            display.passes.retain(|(id, _)| *id != self.id);
            display.hdr_passes.retain(|(id, _)| *id != self.id);
            if display.passes.len() + display.hdr_passes.len() != count {
                display.pass_revision += 1;
            }
        }
    }
}
impl Drop for PostProcessSubscription {
    fn drop(&mut self) {
        self.remove();
    }
}
#[derive(Default)]
pub(super) struct OutputState {
    pub(super) epoch: u64,
    pub(super) latest: Option<(DisplaySettings, Option<wgpu::Texture>)>,
    targets: Option<[wgpu::Texture; 2]>,
    hdr_targets: Option<[wgpu::Texture; 2]>,
}
impl OutputState {
    pub(super) fn invalidate(&mut self) {
        self.epoch += 1;
        self.latest = None;
    }
}
pub(super) struct Composed {
    pub(super) id: u64,
    pub(super) texture: wgpu::Texture,
    pub(super) premultiplied: bool,
    pub(super) settings: DisplaySettings,
    pub(super) presented: Presented,
    pub(super) pass_revision: u64,
}
struct Processing(Engine);
impl Drop for Processing {
    fn drop(&mut self) {
        self.0.lock().display.processing = false;
    }
}
impl Display {
    /// Registers a pass in order. Default no passes. Runs after composition,
    /// before scaling, on every present/export without tracing or restarting denoising.
    /// A returned error or callback panic discards all recorded passes, uses the
    /// original image and emits an engine error. Nested composition is rejected; render inspection
    /// and pass registration/removal are allowed. Changing the image during a pass
    /// rejects that composition. Keep the returned subscription until removal.
    pub fn add_post_process(
        &self,
        pass: impl FnMut(PostProcessContext<'_>) -> Result<()> + Send + 'static,
    ) -> Result<PostProcessSubscription> {
        let mut state = self.engine.live()?;
        let display = &mut state.display;
        let id = display.next_pass;
        display.next_pass += 1;
        display
            .passes
            .push((id, Arc::new(Mutex::new(Box::new(pass)))));
        display.pass_revision += 1;
        Ok(PostProcessSubscription {
            inner: Arc::downgrade(&self.engine.inner),
            id,
        })
    }
    /// Registers a separate HDR-window pass. Input/output are straight-alpha
    /// linear scRGB RGBA16Float, including values above 1. Runs only for active
    /// HDR window presentation, after HDR composition and before scaling.
    /// Failure/reentry/removal follow add_post_process. SDR export and SDR passes
    /// remain independent. Keep the subscription until removal.
    pub fn add_hdr_post_process(
        &self,
        pass: impl FnMut(PostProcessContext<'_>) -> Result<()> + Send + 'static,
    ) -> Result<PostProcessSubscription> {
        let mut state = self.engine.live()?;
        let display = &mut state.display;
        let id = display.next_pass;
        display.next_pass += 1;
        display
            .hdr_passes
            .push((id, Arc::new(Mutex::new(Box::new(pass)))));
        display.pass_revision += 1;
        Ok(PostProcessSubscription {
            inner: Arc::downgrade(&self.engine.inner),
            id,
        })
    }
    pub(super) fn compose(&self, render: &Render, fallback: bool) -> Result<Option<Composed>> {
        self.compose_mode(render, fallback, false)
    }
    pub(super) fn compose_mode(
        &self,
        render: &Render,
        fallback: bool,
        hdr: bool,
    ) -> Result<Option<Composed>> {
        self.check(render)?;
        let mut state = self.engine.live()?;
        if state.display.processing {
            return Err(error(
                Status::InvalidState,
                "Display composition is already running",
            ));
        }
        let id = render.id();
        let primary = state
            .renders
            .get(&id)
            .ok_or_else(|| error(Status::InvalidHandle, "Render is disposed"))?;
        let selected = if fallback {
            match select(
                state.display.settings.channel == super::Channel::Final,
                readiness(&state, id),
                primary.fallback.map(|f| readiness(&state, f)),
            ) {
                None => return Ok(None),
                Some(Selection::Render) => id,
                Some(Selection::Fallback) => primary.fallback.unwrap(),
            }
        } else {
            if !readiness(&state, id).complete {
                return Err(error(Status::InvalidState, "Render has no complete image"));
            }
            id
        };
        let settings = state.display.settings;
        let passes = if hdr {
            state.display.hdr_passes.clone()
        } else {
            state.display.passes.clone()
        };
        let pass_revision = state.display.pass_revision;
        let r = state.renders.get_mut(&selected).unwrap();
        let samples = r.presented_samples();
        let capture = r.capture.as_mut().unwrap();
        let size = capture.size;
        let original = if hdr {
            capture.compose_hdr(&settings.composition())
        } else if passes.is_empty() {
            capture.compose_with(&settings.composition());
            capture.texture.clone()
        } else {
            capture.compose_straight(&settings.composition())
        };
        let format = if hdr {
            wgpu::TextureFormat::Rgba16Float
        } else {
            wgpu::TextureFormat::Rgba8Unorm
        };
        let target_cache = if hdr {
            &mut r.output.hdr_targets
        } else {
            &mut r.output.targets
        };
        let targets = if passes.is_empty() {
            None
        } else {
            if target_cache
                .as_ref()
                .is_none_or(|t| [t[0].width(), t[0].height()] != size)
            {
                *target_cache = Some(std::array::from_fn(|_| {
                    crate::display::image(&self.engine.inner.gpu.device, size, format)
                }));
            }
            target_cache.clone()
        };
        let epoch = r.output.epoch;
        state.display.processing = true;
        drop(state);
        let _processing = Processing(self.engine.clone());
        let gpu = &self.engine.inner.gpu;
        let mut image = original.clone();
        let mut failure = None;
        if let Some(targets) = targets {
            let view = Render::view(&self.engine, selected);
            let mut encoder = gpu.device.create_command_encoder(&Default::default());
            let mut commands = Vec::new();
            for (index, (_, pass)) in passes.iter().enumerate() {
                let output = &targets[index % 2];
                let mut pass = pass.lock().unwrap_or_else(|e| e.into_inner());
                let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    pass(PostProcessContext {
                        device: &gpu.device,
                        encoder: &mut encoder,
                        commands: &mut commands,
                        input: &image,
                        output,
                        width: size[0],
                        height: size[1],
                        render: &view,
                    })
                }));
                failure = match outcome {
                    Ok(Ok(())) => None,
                    Ok(Err(e)) => Some(e.message),
                    Err(_) => Some("Display pass panicked".into()),
                };
                if failure.is_some() {
                    break;
                }
                image = output.clone();
            }
            // API reentry may dispose, restart or refine the selected render.
            let state = self.engine.live()?;
            if !readiness(&state, selected).complete
                || state.renders[&selected].output.epoch != epoch
            {
                return Err(error(
                    Status::InvalidState,
                    "Render changed during a display pass",
                ));
            }
            drop(state);
            if failure.is_none() {
                commands.push(encoder.finish());
                gpu.queue.submit(commands);
            } else {
                image = original;
            }
        }
        let mut state = self.engine.live()?;
        let r = state
            .renders
            .get_mut(&selected)
            .ok_or_else(|| error(Status::InvalidHandle, "Render is disposed"))?;
        let premultiplied = !hdr && (passes.is_empty() || failure.is_some());
        if failure.is_some() && !hdr {
            // Keep native presentation bit-identical to the unfiltered path,
            // including premultiplication before RGBA8 quantization.
            let capture = r.capture.as_mut().unwrap();
            capture.compose_with(&settings.composition());
            image = capture.texture.clone();
        }
        if !hdr {
            r.output.latest = Some((settings, (!premultiplied).then(|| image.clone())));
        }
        if let Some(message) = failure {
            state.report(format!("Display post-process: {message}"));
        }
        Ok(Some(Composed {
            id: selected,
            texture: image,
            premultiplied,
            settings,
            pass_revision,
            presented: Presented {
                fallback: selected != id,
                width: size[0],
                height: size[1],
                samples,
            },
        }))
    }
}
