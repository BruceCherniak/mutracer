//! Separate one-sample frames for resident temporal filters.
use super::*;
use crate::denoiser_inputs as frame;
pub use crate::denoiser_inputs::{
    CameraSnapshot as TemporalCamera, FrameMetadata as TemporalMetadata,
    GlassCapabilities as TemporalGlassCapabilities, Guide as TemporalGuide,
    InputCapabilities as TemporalCapabilities, Projection as TemporalProjection,
    ResetReason as TemporalResetReason, Support as TemporalSupport,
};
use std::sync::Arc;
use std::time::Instant;

/// Immutable separate 1-spp frame. Guide textures are top row first; raw pixel
/// records and stable RGBA32UI IDs are bottom row first. Keep this object alive
/// until submitted work completes; never destroy or write its borrowed resources.
#[derive(Clone)]
pub struct TemporalFrame {
    pub(crate) frame: Arc<frame::GpuFrame>,
}
impl TemporalFrame {
    pub fn metadata(&self) -> &TemporalMetadata {
        &self.frame.current.metadata
    }
    pub fn previous_metadata(&self) -> Option<&TemporalMetadata> {
        self.frame.previous.as_ref().map(|p| &p.metadata)
    }
    pub fn reset_reasons(&self) -> &[TemporalResetReason] {
        &self.frame.reset_reasons
    }
    pub fn guide(&self, kind: TemporalGuide) -> Option<&wgpu::Texture> {
        self.frame.current.resources.guide(kind).map(|g| &g.texture)
    }
    /// Object, local instance, material, source triangle; UINT32_MAX for background.
    pub fn stable_ids(&self) -> &wgpu::Buffer {
        self.frame.current.resources.stable_ids.as_ref().unwrap()
    }
    /// First-surface, optical and RNG records; each pixel occupies 240 bytes.
    pub fn pixel_records(&self) -> &wgpu::Buffer {
        &self.frame.current.resources.producer_buffers[6]
    }
}
pub(crate) struct Request<'a> {
    pub context: u64,
    pub size: [u32; 2],
    pub camera: &'a [u8],
    pub settings: &'a crate::settings::RenderSettings,
    pub quality: u32,
    pub alpha: u32,
    pub scene_revision: u64,
    pub camera_revision: u64,
}
pub(crate) struct State {
    history: frame::GpuFrameHistory,
    pending: Option<frame::FrameSubmission<frame::GpuFrameResources>>,
    producer: Option<frame::FrameProducer>,
    source: String,
    sequence: u32,
    last: Option<Instant>,
}
impl State {
    pub fn new(gpu: &crate::GpuDevice, size: [u32; 2]) -> Self {
        Self {
            history: frame::GpuFrameHistory::new(gpu.frame_device, size),
            pending: None,
            producer: None,
            source: String::new(),
            sequence: 0,
            last: None,
        }
    }
    pub fn reject(&mut self) {
        if let Some(receipt) = self.pending.take() {
            let _ = self.history.reject(receipt.key());
        }
    }
    pub fn accept(&mut self) -> crate::Result<()> {
        if let Some(receipt) = self.pending.take() {
            self.history.accept(&receipt)?;
        }
        Ok(())
    }
    pub fn reset(&mut self) {
        self.reject();
        self.history.invalidate(frame::ResetReason::Explicit);
    }
    pub fn produce(&mut self, request: Request<'_>) -> crate::Result<TemporalFrame> {
        self.history.resize(request.size);
        let (snapshot, retained) = crate::context::temporal_query(request.context)?;
        let packet = retained.target(
            request.settings,
            request.size,
            request.quality,
            request.alpha,
            snapshot.hwrt_shader,
            request.camera,
            &snapshot.gpu.loss,
            true,
        )?;
        let source = packet.shader.ok_or("Missing temporal frame shader")?;
        if self.producer.is_none() || self.source != source {
            self.producer = Some(frame::FrameProducer::new_snapshot(
                &snapshot,
                source.clone(),
            )?);
            self.source = source;
        }
        let camera_values: Vec<_> = packet
            .camera
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
            .collect();
        let raw = Camera::from_bytes(request.camera).ok_or("Invalid temporal camera")?;
        let world = glam::Mat4::from_cols_slice(&camera_values[16..32]);
        let view = world.inverse();
        let projection_inverse = view * glam::Mat4::from_cols_slice(&camera_values[..16]);
        let camera = frame::CameraSnapshot {
            view: view.to_cols_array(),
            projection: projection_inverse.inverse().to_cols_array(),
            view_inverse: world.to_cols_array(),
            projection_inverse: projection_inverse.to_cols_array(),
            near: raw.near_clip,
            far: raw.far_clip,
            kind: if raw.projection == 0 {
                frame::Projection::Perspective
            } else {
                frame::Projection::Orthographic
            },
            aperture_radius: camera_values[32],
        };
        let metadata = frame::FrameMetadata {
            scene_revision: request.scene_revision,
            camera_revision: request.camera_revision,
            seed: request.settings.seed,
            sample_index: self.sequence,
            sample_count: 1,
            jitter_pixels: [
                halton(self.sequence + 1, 2) - 0.5,
                halton(self.sequence + 1, 3) - 0.5,
            ],
            input_extent: request.size,
            output_extent: request.size,
            camera,
            delta_seconds: self
                .last
                .map_or(1. / 60., |t| t.elapsed().as_secs_f32().max(1e-6)),
            pre_exposure: 1.,
            capabilities: Default::default(),
        };
        let words = retained.aov_metadata(request.camera, request.size)?;
        if let Some(previous) = self.history.previous_snapshot() {
            let old = &previous.geometry.aov_words;
            let mut topology = std::collections::HashMap::new();
            if old.len() >= 36 {
                for o in (36..old[16] as usize).step_by(24) {
                    topology.insert((old[o], old[o + 1]), (old[o + 20], old[o + 22]));
                }
            }
            if (36..words[16] as usize).step_by(24).any(|o| {
                topology
                    .get(&(words[o], words[o + 1]))
                    .is_some_and(|v| *v != (words[o + 20], words[o + 22]))
            }) {
                self.history.invalidate(frame::ResetReason::TopologyChanged);
            }
        }
        let geometry = frame::GeometrySnapshot {
            aov_words: words,
            ..Default::default()
        };
        let (frame, dependency) = self.producer.as_ref().unwrap().produce_snapshot(
            &snapshot,
            &mut self.history,
            metadata,
            geometry,
            &packet.camera,
            &packet.trace,
        )?;
        let receipt = self
            .history
            .submit_pending(&snapshot.gpu, dependency, |_| {
                Ok(frame::EvaluatedCommands {
                    native: vec![],
                    consumer: vec![],
                })
            })?;
        self.pending = Some(receipt);
        self.sequence = self
            .sequence
            .checked_add(1)
            .ok_or("Temporal sample sequence exhausted")?;
        self.last = Some(Instant::now());
        Ok(TemporalFrame { frame })
    }
}
fn halton(mut index: u32, base: u32) -> f32 {
    let mut value = 0.;
    let mut scale = 1.;
    while index > 0 {
        scale /= base as f32;
        value += scale * (index % base) as f32;
        index /= base;
    }
    value
}

pub use crate::denoiser_inputs::FramePixelRecord as TemporalPixelRecord;
