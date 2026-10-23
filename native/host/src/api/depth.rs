use super::{Engine, Result, Status, error};

/// Depth queries always return a 7×7 grid.
pub const DEPTH_SAMPLE_GRID: usize = 7;
/// Number of depths returned by one query.
pub const DEPTH_SAMPLE_COUNT: usize = DEPTH_SAMPLE_GRID * DEPTH_SAMPLE_GRID;

/// Square sampling area in viewport coordinates; all fields are required.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DepthSampleArea {
    /// Horizontal center, 0..1 from the left.
    pub x: f32,
    /// Vertical center, 0..1 from the top.
    pub y: f32,
    /// Half height as a fraction of viewport height; nonnegative, 0 queries one point.
    pub size: f32,
}
impl DepthSampleArea {
    pub(super) fn pack(self, aspect: f32) -> Result<[f32; 4]> {
        if ![self.x, self.y, self.size, aspect]
            .iter()
            .all(|v| v.is_finite())
            || !(0. ..=1.).contains(&self.x)
            || !(0. ..=1.).contains(&self.y)
            || self.size < 0.
            || aspect <= 0.
            || !(self.size / aspect).is_finite()
        {
            return Err(error(
                Status::InvalidArgument,
                "Depth sampling requires a center in 0..1, nonnegative size and positive aspect",
            ));
        }
        Ok([self.x, 1. - self.y, self.size / aspect, self.size])
    }
}
impl Engine {
    /// Queries 7×7 pinhole depths using the committed engine camera and display
    /// aspect, independently of render sizes and converge camera overrides.
    /// Returns None before a scene is committed or while preparing; call again
    /// later. Blocks for GPU compilation/readback (first query can cost more).
    /// Depths are distances along camera forward in scene units, top row first;
    /// misses/out-of-viewport rays are 0. Skips invisible catchers and alpha
    /// holes through at most 32 layers. No jitter/DOF, accumulation or denoising.
    pub fn read_depth_samples(
        &self,
        area: DepthSampleArea,
    ) -> Result<Option<[f32; DEPTH_SAMPLE_COUNT]>> {
        area.pack(1.)?;
        self.poll_device();
        let result = crate::runtime::with_loss(&self.inner.gpu, || {
            let (context, camera, size) = {
                let mut state = self.live()?;
                let Some(scene) = state.scene.clone() else {
                    return Ok(None);
                };
                let mut events = Vec::new();
                let step = super::render::scene_step(&mut state, false, &mut events);
                for event in events {
                    if let super::EngineEvent::Error { message } = &event {
                        state.last_error = Some(message.clone());
                    }
                    state.engine_events.push(event);
                }
                match step? {
                    super::render::SceneStep::Published => {}
                    super::render::SceneStep::Waiting => return Ok(None),
                    super::render::SceneStep::Failed(message) => {
                        return Err(error(Status::ContextFailed, message));
                    }
                }
                let camera = match state.camera {
                    Some(camera) => camera,
                    None => {
                        let offset = super::engine::camera_offset(&scene)?;
                        scene[offset..offset + 128].try_into().unwrap()
                    }
                };
                (state.shared.context().unwrap(), camera, state.display.size)
            };
            // Neither the engine state nor process registry is held during AOT
            // packing, lazy compilation or the GPU readback wait.
            let camera = crate::scene::prepare_camera(&camera, size[0], size[1]).map_err(|e| {
                error(
                    crate::status::classify(e.as_ref(), Status::InvalidArgument),
                    e.to_string(),
                )
            })?;
            let Some(query) = crate::context::depth_query(context).map_err(|e| {
                error(
                    crate::status::classify(e.as_ref(), Status::Error),
                    e.to_string(),
                )
            })?
            else {
                return Ok(None);
            };
            let samples = crate::platform_scope(|| {
                query.read(&camera, area.pack(size[0] as f32 / size[1] as f32)?)
            })
            .map_err(|e| {
                error(
                    crate::status::classify(e.as_ref(), Status::Error),
                    e.to_string(),
                )
            })?;
            self.check_device()?;
            Ok(Some(samples))
        });
        self.flush();
        result
    }
}
