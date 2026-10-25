//! Every resident queue submission retains the snapshot and callback code,
//! including submissions made before an SDK evaluation fails to seal a result.
use super::{CustomDenoiser, DenoiseBuffers, DenoiseFrameStatus};
use crate::{GpuQueue, device_loss::DeviceLossNotifier};
use std::sync::{Arc, Mutex};

pub(super) struct SubmissionLease {
    pub status: DenoiseFrameStatus,
    pub buffers: Mutex<Vec<wgpu::Buffer>>,
    pub temporal: Mutex<Option<super::TemporalFrame>>,
    loss: DeviceLossNotifier,
    _filter: super::custom_denoise::Filter,
}
impl SubmissionLease {
    pub fn new(
        status: DenoiseFrameStatus,
        buffers: &DenoiseBuffers,
        loss: DeviceLossNotifier,
        filter: Arc<dyn CustomDenoiser>,
    ) -> Arc<Self> {
        Arc::new(Self {
            status,
            buffers: Mutex::new(Self::copies(buffers)),
            temporal: Mutex::new(None),
            loss,
            _filter: super::custom_denoise::Filter(Some(filter)),
        })
    }
    pub fn copies(buffers: &DenoiseBuffers) -> Vec<wgpu::Buffer> {
        vec![
            buffers.color.clone(),
            buffers.normal.clone(),
            buffers.albedo.clone(),
        ]
    }
    pub fn begin(self: &Arc<Self>, queue: &GpuQueue) -> SubmissionRetirement {
        self.loss
            .check()
            .expect("Custom GPU submission on a lost device");
        self.track(queue)
    }
    pub fn producer_submitted(self: &Arc<Self>, queue: &GpuQueue) {
        // This records already queued work. A concurrent device loss must not
        // turn construction of a library-owned input into a caller-thread panic.
        drop(self.track(queue));
    }
    fn track(self: &Arc<Self>, queue: &GpuQueue) -> SubmissionRetirement {
        assert!(
            self.status.begin(),
            "Custom GPU submission after closing the frame"
        );
        SubmissionRetirement {
            queue: queue.clone(),
            lease: Some(self.clone()),
        }
    }
}

pub(super) struct SubmissionRetirement {
    queue: GpuQueue,
    lease: Option<Arc<SubmissionLease>>,
}
impl Drop for SubmissionRetirement {
    fn drop(&mut self) {
        let Some(lease) = self.lease.take() else {
            return;
        };
        // Register even when queue.submit unwinds. Any work already enqueued
        // before that failure still owns its filter and input resources.
        self.queue.on_submitted_work_done(move || {
            lease.status.complete();
            // Filter's Drop also handles callback disposal on device loss; it
            // never runs foreign release code inside the wgpu poll callback.
            drop(lease);
        });
    }
}
