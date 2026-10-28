use crate::{Result, Status, fail};
use std::sync::{Arc, OnceLock};

/// Thread-safe device-loss signal for an engine on a caller-owned device.
/// Clones share the first reported reason; the handle owns no engine or device.
#[derive(Clone, Default)]
pub struct DeviceLossNotifier(Arc<OnceLock<String>>);
impl DeviceLossNotifier {
    /// Records a terminal device loss. The first reason wins; later notifications
    /// do nothing. No user callbacks run here, so this is safe in a wgpu callback.
    pub fn notify(&self, reason: impl Into<String>) {
        let _ = self.0.set(reason.into());
    }
    pub(crate) fn reason(&self) -> Option<&str> {
        self.0.get().map(String::as_str)
    }
    pub(crate) fn message(&self) -> Option<String> {
        self.reason()
            .map(|reason| format!("GPU device lost: {reason}; create a new engine"))
    }
    pub(crate) fn check(&self) -> Result<()> {
        match self.message() {
            Some(message) => Err(fail(Status::Unavailable, message)),
            None => Ok(()),
        }
    }
}
