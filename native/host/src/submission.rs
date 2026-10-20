//! Coordinate a shared presentation queue with background native uploads.
use std::sync::{Arc, Condvar, Mutex};

#[derive(Default)]
struct State {
    paused: bool,
    active: usize,
}

/// Pause submissions outside the embedding UI's update callback, where its
/// framework may configure a surface. CPU preparation and pipeline compilation
/// continue while paused. Resume before issuing native GPU work or destroying
/// contexts. Surface configuration must not race queue submission (wgpu contract).
#[derive(Default)]
pub struct SubmissionGate {
    state: Mutex<State>,
    changed: Condvar,
}
impl SubmissionGate {
    pub fn pause(&self) {
        let mut state = self.state.lock().unwrap();
        state.paused = true;
        while state.active != 0 {
            state = self.changed.wait(state).unwrap();
        }
    }
    pub fn resume(&self) {
        self.state.lock().unwrap().paused = false;
        self.changed.notify_all();
    }
    fn enter(&self) -> Submission<'_> {
        let mut state = self.state.lock().unwrap();
        while state.paused {
            state = self.changed.wait(state).unwrap();
        }
        state.active += 1;
        Submission(self)
    }
}
struct Submission<'a>(&'a SubmissionGate);
impl Drop for Submission<'_> {
    fn drop(&mut self) {
        self.0.state.lock().unwrap().active -= 1;
        self.0.changed.notify_all();
    }
}

#[derive(Clone)]
pub(crate) struct GpuQueue {
    queue: wgpu::Queue,
    gate: Option<Arc<SubmissionGate>>,
}
impl GpuQueue {
    pub(crate) fn new(queue: wgpu::Queue, gate: Option<Arc<SubmissionGate>>) -> Self {
        Self { queue, gate }
    }
    pub(crate) fn submit(
        &self,
        commands: impl IntoIterator<Item = wgpu::CommandBuffer>,
    ) -> wgpu::SubmissionIndex {
        let _submission = self.gate.as_ref().map(|gate| gate.enter());
        self.queue.submit(commands)
    }
}
impl std::ops::Deref for GpuQueue {
    type Target = wgpu::Queue;
    fn deref(&self) -> &Self::Target {
        &self.queue
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{sync::mpsc, time::Duration};

    #[test]
    fn pause_drains_inflight_submissions_and_resume_releases_waiters() {
        let gate = Arc::new(SubmissionGate::default());
        let active = gate.enter();
        let (paused, did_pause) = mpsc::channel();
        let worker_gate = gate.clone();
        let worker = std::thread::spawn(move || {
            worker_gate.pause();
            paused.send(()).unwrap();
        });
        // Observe pause taking effect before releasing the active submission.
        while !gate.state.lock().unwrap().paused {
            std::thread::yield_now();
        }
        assert!(did_pause.try_recv().is_err());
        drop(active);
        did_pause.recv_timeout(Duration::from_secs(5)).unwrap();
        worker.join().unwrap();
        let (submitted, did_submit) = mpsc::channel();
        let worker_gate = gate.clone();
        let worker = std::thread::spawn(move || {
            let _submission = worker_gate.enter();
            submitted.send(()).unwrap();
        });
        assert!(did_submit.try_recv().is_err());
        gate.resume();
        did_submit.recv_timeout(Duration::from_secs(5)).unwrap();
        worker.join().unwrap();
        gate.pause();
    }
}
