//! The process-global scriptc heap is accessed only by this dedicated thread.
//! Messages and replies own their data; no AOT pointer crosses the channel.
use super::*;
use std::sync::OnceLock;

type Task = Box<dyn FnOnce() + Send>;
static THREAD: OnceLock<mpsc::Sender<Task>> = OnceLock::new();
/// Tests: pause the next synchronous AOT call after it reaches the runtime thread.
#[cfg(test)]
pub(crate) static CALL_GATE: Mutex<Option<(mpsc::SyncSender<()>, mpsc::Receiver<()>)>> =
    Mutex::new(None);
type LossScope = (crate::device_loss::DeviceLossNotifier, wgpu::Device);
thread_local! { static LOSS: std::cell::RefCell<Option<LossScope>> = const { std::cell::RefCell::new(None) }; }
// Only synchronous caller-side waits use this scope. Queued tasks own their data;
// root-release barriers still drain even after an engine has failed.
pub(super) fn with_loss<T>(gpu: &GpuDevice, body: impl FnOnce() -> T) -> T {
    struct Restore(Option<LossScope>);
    impl Drop for Restore {
        fn drop(&mut self) {
            LOSS.with(|slot| {
                *slot.borrow_mut() = self.0.take();
            });
        }
    }
    let _restore =
        Restore(LOSS.with(|slot| slot.replace(Some((gpu.loss.clone(), gpu.device.clone())))));
    body()
}
pub(super) fn check_loss() -> Result<()> {
    LOSS.with(|slot| match slot.borrow().as_ref() {
        Some((loss, device)) => {
            if loss.reason().is_none() {
                // wgpu delivers device-loss callbacks during polling, including
                // while this caller is waiting for unrelated AOT work.
                let _ = device.poll(wgpu::PollType::Poll);
            }
            loss.check()
        }
        None => Ok(()),
    })
}
thread_local! { static IS_RUNTIME: std::cell::Cell<bool> = const { std::cell::Cell::new(false) }; }

fn sender() -> &'static mpsc::Sender<Task> {
    THREAD.get_or_init(|| {
        let (sender, receiver) = mpsc::channel::<Task>();
        std::thread::Builder::new()
            .name("mutracer-aot".into())
            .spawn(move || {
                IS_RUNTIME.set(true);
                init_core();
                for task in receiver {
                    task();
                }
            })
            .expect("start MuTracer AOT runtime");
        sender
    })
}
pub(super) fn enqueue(body: impl FnOnce() + Send + 'static) {
    if IS_RUNTIME.get() {
        body();
    } else {
        sender()
            .send(Box::new(body))
            .expect("MuTracer AOT runtime stopped");
    }
}
pub(super) fn run<T: Send + 'static>(body: impl FnOnce() -> T + Send + 'static) -> T {
    if IS_RUNTIME.get() {
        return body();
    }
    match request(body).recv().expect("MuTracer AOT reply lost") {
        Ok(value) => value,
        Err(panic) => std::panic::resume_unwind(panic),
    }
}
fn request<T: Send + 'static>(
    body: impl FnOnce() -> T + Send + 'static,
) -> mpsc::Receiver<std::thread::Result<T>> {
    let sender = sender();
    let (reply, result) = mpsc::sync_channel(1);
    sender
        .send(Box::new(move || {
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                #[cfg(test)]
                {
                    let gate = CALL_GATE.lock().unwrap().take();
                    if let Some((entered, resume)) = gate {
                        entered.send(()).unwrap();
                        resume.recv_timeout(Duration::from_secs(15)).unwrap();
                    }
                }
                body()
            }));
            let _ = reply.send(outcome);
        }))
        .expect("MuTracer AOT runtime stopped");
    result
}
pub(super) fn call<T: Send + 'static>(
    body: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    let loss = LOSS.with(|slot| slot.borrow().as_ref().map(|(loss, _)| loss.clone()));
    match loss {
        Some(loss) => call_with_loss(&loss, body),
        None => run(move || body().map_err(|e| e.to_string())).map_err(Into::into),
    }
}
/// A queued task retains its inputs even when the waiting engine has failed.
/// Never wait for that task to drain before returning device loss to its caller.
pub(super) fn call_with_loss<T: Send + 'static>(
    loss: &crate::device_loss::DeviceLossNotifier,
    body: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    loss.check()?;
    if IS_RUNTIME.get() {
        return body();
    }
    let check = loss.clone();
    let result = request(move || {
        check.check().map_err(|e| e.to_string())?;
        body().map_err(|e| e.to_string())
    });
    loop {
        check_loss()?;
        loss.check()?;
        match result.recv_timeout(Duration::from_millis(2)) {
            Ok(Ok(value)) => {
                loss.check()?;
                return value.map_err(Into::into);
            }
            Ok(Err(panic)) => std::panic::resume_unwind(panic),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => panic!("MuTracer AOT reply lost"),
        }
    }
}
pub(super) fn init() {
    run(|| ());
}

/// Pack the complete bounded sample sequence through TS before publication.
/// Render submission therefore never waits behind a scene preparation message.
pub(super) fn frames(bounces: f32, seed: u32) -> Result<Vec<[u8; 16]>> {
    pack_frames(None, bounces, seed)
}
pub(super) fn frames_with_loss(
    loss: &crate::device_loss::DeviceLossNotifier,
    bounces: f32,
    seed: u32,
) -> Result<Vec<[u8; 16]>> {
    pack_frames(Some(loss), bounces, seed)
}
fn pack_frames(
    loss: Option<&crate::device_loss::DeviceLossNotifier>,
    bounces: f32,
    seed: u32,
) -> Result<Vec<[u8; 16]>> {
    let body = move || {
        let mut frames = Vec::with_capacity(4096);
        for sample in 0..4096 {
            let mut pointer = std::ptr::null();
            let mut size = 0;
            unsafe {
                mt_core_frame(sample as f64, bounces as f64, seed, &mut pointer, &mut size);
            }
            let bytes = unsafe { copy_core_result(pointer, size, 16)? };
            frames.push(bytes.try_into().unwrap());
        }
        unsafe {
            mt_core_collect();
        }
        Ok(frames)
    };
    match loss {
        Some(loss) => call_with_loss(loss, body),
        None => call(body),
    }
}
