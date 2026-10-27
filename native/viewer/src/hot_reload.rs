//! Dev-only function patching. Viewer, scene and GPU ownership stay in the host.
use eframe::egui;
use std::sync::Arc;

pub fn connect(ctx: &egui::Context) {
    dioxus_devtools::connect_subsecond();
    let ctx = ctx.clone();
    // A converged viewer is idle; a code patch must wake it without resetting
    // accumulation or requesting a scene commit.
    subsecond::register_handler(Arc::new(move || ctx.request_repaint()));
}

pub fn panels(viewer: &mut crate::Viewer, root: &mut egui::Ui) {
    // Keep GPU scheduling and initialization outside the patched call chain.
    // State-layout changes require a new process; Subsecond cannot migrate them.
    subsecond::call(|| viewer.panels(root));
}

pub fn startup_model() -> Option<std::path::PathBuf> {
    std::env::var_os("MUTRACER_VIEWER_DEV_MODEL").map(Into::into)
}
