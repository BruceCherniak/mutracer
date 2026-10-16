//! Background scheduling for the shared native library OIDN adapter.
use anyhow::{Context, Result, ensure};
pub use mutracer_native_probe::denoise::Denoiser;
use std::{sync::mpsc, thread, time::Instant};

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
