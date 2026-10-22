//! Device, committed scene/camera and the single commit point.
use super::display::DisplayState;
use super::render::{RenderState, SampleEvent};
use super::{Result, Status, error};
use crate::GpuDevice;
use crate::layout::{WORD_BYTES, camera as camera_wire, header};
use std::collections::BTreeMap;
use std::sync::{
    Arc, Mutex, MutexGuard,
    atomic::{AtomicBool, Ordering},
};

/// Intersection backend for every render of an engine.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Backend {
    /// Software BVH traversal.
    Software,
    /// Hardware ray queries when the device supports them, otherwise software.
    #[default]
    Hardware,
}
impl Backend {
    pub(super) fn code(self) -> u32 {
        match self {
            Self::Software => 0,
            Self::Hardware => 1,
        }
    }
}
/// Engine creation options.
#[derive(Clone, Debug, Default)]
pub struct EngineOptions {
    /// Intersection backend. Default [`Backend::Hardware`].
    pub backend: Backend,
}
/// Device information.
#[derive(Clone, Debug)]
pub struct EngineInfo {
    pub adapter_name: String,
    /// Requested backend; a render can still fall back to software per scene.
    pub backend: Backend,
    /// Whether the device has hardware ray queries enabled.
    pub hardware_ray_query: bool,
}
/// Progress stage reported by [`EngineEvent::Progress`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProgressStage {
    /// Full scene preparation of a render on a library thread (0 at start, 1 at publication).
    Preparation,
}
/// Engine notifications, delivered to [`Engine::on`] subscribers.
#[derive(Clone, Debug, PartialEq)]
pub enum EngineEvent {
    Progress {
        stage: ProgressStage,
        progress: f32,
    },
    Error {
        message: String,
    },
    /// Reserved: device loss is not recoverable yet and is not reported.
    DeviceLost {
        reason: String,
        recovering: bool,
    },
}

/// Camera record, identical to `mt_camera_v4` (128 bytes).
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Camera {
    /// 0 perspective, 1 orthographic.
    pub projection: u32,
    /// Vertical field of view in degrees.
    pub fov: f32,
    pub near_clip: f32,
    pub far_clip: f32,
    pub left: f32,
    pub right: f32,
    pub bottom: f32,
    pub top: f32,
    pub zoom: f32,
    /// 0 disables depth of field.
    pub f_stop: f32,
    pub focus_distance: f32,
    pub sensor_height: f32,
    pub meters_per_unit: f32,
    pub reserved: [u32; 3],
    /// Column-major camera-to-world matrix; the camera looks down -Z.
    pub world_matrix: [f32; 16],
}
const _: () = assert!(std::mem::size_of::<Camera>() == camera_wire::WORDS * WORD_BYTES);
impl Default for Camera {
    /// `mt_camera_v4_default()`: perspective, 45 degrees, no depth of field.
    fn default() -> Self {
        let mut world_matrix = [0.; 16];
        for i in [0, 5, 10, 15] {
            world_matrix[i] = 1.;
        }
        Self {
            projection: 0,
            fov: 45.,
            near_clip: 0.1,
            far_clip: 1000.,
            left: -1.,
            right: 1.,
            bottom: -1.,
            top: 1.,
            zoom: 1.,
            f_stop: 0.,
            focus_distance: 10.,
            sensor_height: 24.,
            meters_per_unit: 1.,
            reserved: [0; 3],
            world_matrix,
        }
    }
}
impl Camera {
    pub fn to_bytes(&self) -> [u8; 128] {
        let mut bytes = [0; 128];
        let mut word = |index: usize, value: u32| {
            bytes[index * 4..index * 4 + 4].copy_from_slice(&value.to_le_bytes())
        };
        word(camera_wire::PROJECTION, self.projection);
        for (index, value) in [
            self.fov,
            self.near_clip,
            self.far_clip,
            self.left,
            self.right,
            self.bottom,
            self.top,
            self.zoom,
            self.f_stop,
            self.focus_distance,
            self.sensor_height,
            self.meters_per_unit,
        ]
        .into_iter()
        .enumerate()
        {
            word(camera_wire::FOV + index, value.to_bits());
        }
        for (index, value) in self.reserved.into_iter().enumerate() {
            word(camera_wire::RESERVED + index, value);
        }
        for (index, value) in self.world_matrix.into_iter().enumerate() {
            word(camera_wire::TRANSFORM + index, value.to_bits());
        }
        bytes
    }
    pub fn from_bytes(bytes: &[u8]) -> Option<Self> {
        if bytes.len() != 128 {
            return None;
        }
        let word = |i: usize| u32::from_le_bytes(bytes[i * 4..i * 4 + 4].try_into().unwrap());
        let float = |i: usize| f32::from_bits(word(i));
        Some(Self {
            projection: word(camera_wire::PROJECTION),
            fov: float(1),
            near_clip: float(2),
            far_clip: float(3),
            left: float(4),
            right: float(5),
            bottom: float(6),
            top: float(7),
            zoom: float(8),
            f_stop: float(9),
            focus_distance: float(10),
            sensor_height: float(11),
            meters_per_unit: float(12),
            reserved: std::array::from_fn(|i| word(camera_wire::RESERVED + i)),
            world_matrix: std::array::from_fn(|i| float(camera_wire::TRANSFORM + i)),
        })
    }
}

pub(super) const QUALITY_BEVEL: u32 = 1;
pub(super) const QUALITY_DISPERSION: u32 = 2;

/// Byte offset of the camera record after checking the header fields the engine overrides.
/// Full validation happens when a render commits the descriptor.
pub(super) fn camera_offset(scene: &[u8]) -> Result<usize> {
    let word = |i: usize| u32::from_le_bytes(scene[i * 4..i * 4 + 4].try_into().unwrap());
    if scene.len() < header::WORDS * WORD_BYTES || scene.len() % WORD_BYTES != 0 {
        return Err(error(
            Status::InvalidArgument,
            "Scene descriptor must be a whole number of words with a complete header",
        ));
    }
    if word(header::VERSION) != crate::layout::version::SCENE as u32 {
        return Err(error(
            Status::InvalidArgument,
            "Scene descriptor version must be MT_VERSION_SCENE",
        ));
    }
    let offset = word(header::CAMERA_OFFSET) as usize;
    if offset < header::WORDS || offset + camera_wire::WORDS > scene.len() / WORD_BYTES {
        return Err(error(
            Status::InvalidArgument,
            "Scene camera record is outside the descriptor",
        ));
    }
    Ok(offset * WORD_BYTES)
}
/// The descriptor a render commits: the engine scene with this render's size,
/// bevel/dispersion quality bits and camera. Other quality bits stay the scene's.
pub(super) fn override_descriptor(
    scene: &[u8],
    size: [u32; 2],
    quality: u32,
    camera: Option<&[u8; 128]>,
) -> Result<Vec<u8>> {
    let camera_at = camera_offset(scene)?;
    let mut bytes = scene.to_vec();
    let mut word = |index: usize, value: u32| {
        bytes[index * 4..index * 4 + 4].copy_from_slice(&value.to_le_bytes())
    };
    word(header::WIDTH, size[0]);
    word(header::HEIGHT, size[1]);
    let flags = u32::from_le_bytes(
        scene[header::QUALITY_FLAGS * 4..header::QUALITY_FLAGS * 4 + 4]
            .try_into()
            .unwrap(),
    );
    word(
        header::QUALITY_FLAGS,
        (flags & !(QUALITY_BEVEL | QUALITY_DISPERSION)) | quality,
    );
    if let Some(camera) = camera {
        bytes[camera_at..camera_at + 128].copy_from_slice(camera);
    }
    Ok(bytes)
}

type EngineListener = Arc<Mutex<dyn FnMut(&EngineEvent) + Send>>;
type SampleListener = Arc<Mutex<dyn FnMut(&SampleEvent) + Send>>;
#[derive(Default)]
struct Listeners {
    next: u64,
    engine: Vec<(u64, EngineListener)>,
    samples: Vec<(u64, u64, SampleListener)>,
}
/// Removes a callback when dropped; [`Subscription::detach`] keeps it for the engine's lifetime.
#[must_use = "dropping a Subscription removes its callback"]
pub struct Subscription {
    inner: std::sync::Weak<Inner>,
    id: u64,
}
impl Subscription {
    pub fn detach(self) {
        std::mem::forget(self);
    }
}
impl Drop for Subscription {
    fn drop(&mut self) {
        if let Some(inner) = self.inner.upgrade() {
            let mut listeners = inner.listeners.lock().unwrap();
            listeners.engine.retain(|(id, _)| *id != self.id);
            listeners.samples.retain(|(id, _, _)| *id != self.id);
        }
    }
}

pub(super) struct State {
    pub(super) disposed: bool,
    source_scene: Option<Arc<Vec<u8>>>,
    source_camera: Option<Camera>,
    /// Committed by `update`; renders read only these.
    pub(super) scene: Option<Arc<Vec<u8>>>,
    pub(super) camera: Option<[u8; 128]>,
    pub(super) scene_revision: u64,
    pub(super) camera_revision: u64,
    pub(super) renders: BTreeMap<u64, RenderState>,
    pub(super) next_render: u64,
    pub(super) display: DisplayState,
    pub(super) last_error: Option<String>,
    pub(super) engine_events: Vec<EngineEvent>,
    pub(super) sample_events: Vec<(u64, SampleEvent)>,
}
impl State {
    pub(super) fn report(&mut self, message: String) {
        self.last_error = Some(message.clone());
        self.engine_events.push(EngineEvent::Error { message });
    }
}
pub(super) struct Inner {
    state: Mutex<State>,
    listeners: Mutex<Listeners>,
    /// Set while `flush` runs callbacks; nested flushes leave events to it.
    dispatching: AtomicBool,
    pub(super) gpu: GpuDevice,
    pub(super) backend: Backend,
}
impl Drop for Inner {
    fn drop(&mut self) {
        let state = self.state.get_mut().unwrap_or_else(|e| e.into_inner());
        for (_, render) in std::mem::take(&mut state.renders) {
            render.release();
        }
    }
}

/// Shared device, committed scene/camera and display. Cloning shares the engine.
#[derive(Clone)]
pub struct Engine {
    pub(super) inner: Arc<Inner>,
}
impl Engine {
    /// Creates a device of its own.
    pub fn new(options: EngineOptions) -> Result<Self> {
        let gpu = GpuDevice::with_backend(options.backend.code())
            .map_err(|e| error(Status::Unavailable, format!("GPU device unavailable: {e}")))?;
        Ok(Self::with_gpu(gpu, options))
    }
    /// Shares the caller's device and queue, for example an egui-wgpu render state.
    /// Request the adapter limits and the optional ray-query feature when creating
    /// the device. The optional gate coordinates submissions with surface configuration.
    pub fn on_device(
        adapter: &wgpu::Adapter,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        options: EngineOptions,
        gate: Option<Arc<crate::submission::SubmissionGate>>,
    ) -> Self {
        let gpu = GpuDevice {
            device: device.clone(),
            queue: crate::GpuQueue::new(queue.clone(), gate),
            info: adapter.get_info(),
            hardware_ray_query: device
                .features()
                .contains(wgpu::Features::EXPERIMENTAL_RAY_QUERY),
            pipelines: Arc::new(Mutex::new(Default::default())),
            pipeline_cache: None,
        };
        Self::with_gpu(gpu, options)
    }
    fn with_gpu(gpu: GpuDevice, options: EngineOptions) -> Self {
        Self {
            inner: Arc::new(Inner {
                state: Mutex::new(State {
                    disposed: false,
                    source_scene: None,
                    source_camera: None,
                    scene: None,
                    camera: None,
                    scene_revision: 0,
                    camera_revision: 0,
                    renders: BTreeMap::new(),
                    next_render: 1,
                    display: DisplayState::default(),
                    last_error: None,
                    engine_events: Vec::new(),
                    sample_events: Vec::new(),
                }),
                listeners: Mutex::new(Listeners::default()),
                dispatching: AtomicBool::new(false),
                gpu,
                backend: options.backend,
            }),
        }
    }
    pub(super) fn lock(&self) -> MutexGuard<'_, State> {
        self.inner.state.lock().unwrap_or_else(|e| e.into_inner())
    }
    pub(super) fn live(&self) -> Result<MutexGuard<'_, State>> {
        let state = self.lock();
        if state.disposed {
            return Err(error(Status::InvalidHandle, "Engine is disposed"));
        }
        Ok(state)
    }
    /// Delivers queued events on the calling thread without holding the engine lock.
    /// A callback may call back into the API: events it causes are queued and
    /// delivered by the outer call after the current ones, in order.
    pub(super) fn flush(&self) {
        if self.inner.dispatching.swap(true, Ordering::Acquire) {
            return;
        }
        // Cleared on return and if a callback panics.
        struct Dispatching<'a>(&'a AtomicBool);
        impl Drop for Dispatching<'_> {
            fn drop(&mut self) {
                self.0.store(false, Ordering::Release);
            }
        }
        let _dispatching = Dispatching(&self.inner.dispatching);
        loop {
            let (engine, samples) = {
                let mut state = self.lock();
                (
                    std::mem::take(&mut state.engine_events),
                    std::mem::take(&mut state.sample_events),
                )
            };
            if engine.is_empty() && samples.is_empty() {
                break;
            }
            let (engine_listeners, sample_listeners) = {
                let listeners = self.inner.listeners.lock().unwrap();
                (listeners.engine.clone(), listeners.samples.clone())
            };
            for event in &engine {
                for (_, listener) in &engine_listeners {
                    (listener.lock().unwrap())(event);
                }
            }
            for (render, event) in &samples {
                for (_, owner, listener) in &sample_listeners {
                    if owner == render {
                        (listener.lock().unwrap())(event);
                    }
                }
            }
        }
    }
    /// Records a scene descriptor (`mt_scene_header_v4` and its tables), copied.
    /// It takes effect at the next [`Engine::update`]. Width, height, the bevel and
    /// dispersion quality bits and (when [`Engine::set_camera`] was called) the camera
    /// record are replaced per render; the scene's other fields are used as given.
    pub fn set_scene(&self, descriptor: &[u8]) -> Result<()> {
        camera_offset(descriptor)?;
        self.live()?.source_scene = Some(Arc::new(descriptor.to_vec()));
        Ok(())
    }
    /// Records the camera for every render; `None` uses the scene's camera record.
    /// Takes effect at the next [`Engine::update`]. Default `None`.
    pub fn set_camera(&self, camera: Option<Camera>) -> Result<()> {
        self.live()?.source_camera = camera;
        Ok(())
    }
    /// The sole commit point. Returns whether the scene or camera changed.
    /// Incremental edits are applied to every render on this thread; a render that
    /// needs full preparation starts it on a library thread and reports
    /// [`super::RenderStatus::Preparing`] until it is published.
    pub fn update(&self) -> Result<bool> {
        let changed = {
            let mut state = self.live()?;
            state.last_error = None;
            let mut changed = false;
            if let Some(source) = state.source_scene.clone() {
                let same = state
                    .scene
                    .as_ref()
                    .is_some_and(|scene| Arc::ptr_eq(scene, &source) || **scene == *source);
                if !same {
                    state.scene = Some(source.clone());
                    state.scene_revision += 1;
                    changed = true;
                }
                // Keep the committed Arc so an unchanged scene compares by pointer next time.
                state.source_scene = state.scene.clone();
            }
            let camera = state.source_camera.map(|c| c.to_bytes());
            if camera != state.camera {
                state.camera = camera;
                state.camera_revision += 1;
                changed = true;
            }
            let ids: Vec<u64> = state.renders.keys().copied().collect();
            for id in ids {
                super::render::synchronize(&mut state, id, changed);
            }
            changed
        };
        self.flush();
        Ok(changed)
    }
    pub fn info(&self) -> EngineInfo {
        EngineInfo {
            adapter_name: self.inner.gpu.info.name.clone(),
            backend: self.inner.backend,
            hardware_ray_query: self.inner.gpu.hardware_ray_query,
        }
    }
    /// The engine's display; every call returns a handle to the same display.
    pub fn display(&self) -> super::Display {
        super::Display {
            engine: self.clone(),
        }
    }
    /// Subscribes to progress and error events.
    pub fn on(&self, listener: impl FnMut(&EngineEvent) + Send + 'static) -> Subscription {
        let mut listeners = self.inner.listeners.lock().unwrap();
        listeners.next += 1;
        let id = listeners.next;
        listeners.engine.push((id, Arc::new(Mutex::new(listener))));
        Subscription {
            inner: Arc::downgrade(&self.inner),
            id,
        }
    }
    pub(super) fn on_sample(
        &self,
        render: u64,
        listener: impl FnMut(&SampleEvent) + Send + 'static,
    ) -> Subscription {
        let mut listeners = self.inner.listeners.lock().unwrap();
        listeners.next += 1;
        let id = listeners.next;
        listeners
            .samples
            .push((id, render, Arc::new(Mutex::new(listener))));
        Subscription {
            inner: Arc::downgrade(&self.inner),
            id,
        }
    }
    /// Whether `set_scene`/`set_camera` recorded inputs that `update` has not committed.
    pub(super) fn inputs_pending(&self) -> bool {
        let state = self.lock();
        let scene = match (&state.source_scene, &state.scene) {
            (Some(source), Some(scene)) => !Arc::ptr_eq(source, scene),
            (source, _) => source.is_some(),
        };
        scene || state.source_camera.map(|c| c.to_bytes()) != state.camera
    }
    /// Message of the last error since the previous `update`, if any.
    pub fn last_error(&self) -> Option<String> {
        self.lock().last_error.clone()
    }
    /// Releases every render's resources. Later calls on the engine, its renders
    /// and display return [`Status::InvalidHandle`]. Dropping the last handle also releases.
    pub fn dispose(&self) {
        let renders = {
            let mut state = self.lock();
            state.disposed = true;
            state.display = DisplayState::default();
            std::mem::take(&mut state.renders)
        };
        for (_, render) in renders {
            render.release();
        }
        let mut listeners = self.inner.listeners.lock().unwrap();
        listeners.engine.clear();
        listeners.samples.clear();
    }
}
