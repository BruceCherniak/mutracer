//! The process-global scriptc heap is accessed only by this dedicated thread.
//! Messages and replies own their data; no AOT pointer crosses the channel.
use super::*;
use std::sync::OnceLock;

type Task = Box<dyn FnOnce() + Send>;
static THREAD: OnceLock<mpsc::Sender<Task>> = OnceLock::new();
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
    let sender = sender();
    let (reply, result) = mpsc::sync_channel(1);
    sender
        .send(Box::new(move || {
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(body));
            let _ = reply.send(outcome);
        }))
        .expect("MuTracer AOT runtime stopped");
    match result.recv().expect("MuTracer AOT reply lost") {
        Ok(value) => value,
        Err(panic) => std::panic::resume_unwind(panic),
    }
}
pub(super) fn call<T: Send + 'static>(
    body: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    run(move || body().map_err(|e| e.to_string())).map_err(Into::into)
}
pub(super) fn init() {
    run(|| ());
}

/// Pack the complete bounded sample sequence through TS before publication.
/// Render submission therefore never waits behind a scene preparation message.
pub(super) fn frames(bounces: f32, seed: u32) -> Result<Vec<[u8; 16]>> {
    call(move || {
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
    })
}
