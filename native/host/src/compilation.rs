//! Device-scoped observations. Never lock the pipeline cache from a query.
use std::sync::{
    Mutex,
    atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
};

#[derive(Default)]
pub(crate) struct Compilation {
    pub active: AtomicUsize,
    pub events_enabled: AtomicBool,
    #[cfg(test)]
    pub hold: Mutex<Option<(std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>)>>,
    pub started: AtomicU64,
    pub completed: AtomicU64,
    pub hits: AtomicU64,
    pub cached: AtomicUsize,
    pub events: Mutex<Vec<bool>>,
}
impl Compilation {
    pub fn begin(&self) -> Guard<'_> {
        self.started.fetch_add(1, Ordering::Relaxed);
        self.active.fetch_add(1, Ordering::Release);
        if self.events_enabled.load(Ordering::Relaxed) {
            self.events.lock().unwrap().push(false);
        }
        let guard = Guard(self);
        #[cfg(test)]
        if let Some((entered, resume)) = self.hold.lock().unwrap().take() {
            let _ = entered.send(());
            let _ = resume.recv_timeout(std::time::Duration::from_secs(30));
        }
        guard
    }
}
pub(crate) struct Guard<'a>(&'a Compilation);
impl Drop for Guard<'_> {
    fn drop(&mut self) {
        self.0.completed.fetch_add(1, Ordering::Relaxed);
        self.0.active.fetch_sub(1, Ordering::Release);
        if self.0.events_enabled.load(Ordering::Relaxed) {
            self.0.events.lock().unwrap().push(true);
        }
    }
}
