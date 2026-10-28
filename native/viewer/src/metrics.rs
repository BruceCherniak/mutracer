//! Opt-in real-window measurements for native contributor checks.
use std::{path::PathBuf, time::Instant};
pub struct Metrics {
    pub frames: Vec<serde_json::Value>,
    pub commits: u32,
    pub commit_frames: u32,
    pub path: PathBuf,
    last: Instant,
}
impl Metrics {
    pub fn from_env() -> Option<Self> {
        std::env::var_os("MUTRACER_VIEWER_METRICS").map(|p| Self {
            frames: vec![],
            commits: 0,
            commit_frames: 0,
            path: p.into(),
            last: Instant::now(),
        })
    }
    pub fn record(
        &mut self,
        cpu_ms: f64,
        during_commit: bool,
        pick_ms: f64,
        has_gpu_frame: bool,
        zero_cpu_image: bool,
        error: &str,
    ) -> bool {
        let now = Instant::now();
        let interval = now.duration_since(self.last).as_secs_f64() * 1000.;
        self.last = now;
        self.frames.push(serde_json::json!({"cpuMs":cpu_ms,"intervalMs":interval,"duringCommit":during_commit,"pickMs":pick_ms,"gpuFrame":has_gpu_frame,"cpuImageEmpty":zero_cpu_image,"error":error}));
        if during_commit {
            self.commit_frames += 1;
        }
        let done = self.frames.len() >= 360
            && self.commits >= 3
            && self.commit_frames > 0
            && has_gpu_frame
            && !during_commit;
        if done || self.frames.len() % 30 == 0 {
            let out = serde_json::json!({"complete":done,"size":[1280,720],"commits":self.commits,"frames":self.frames});
            if let Some(parent) = self.path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::write(&self.path, serde_json::to_vec_pretty(&out).unwrap());
        }
        done
    }
}
