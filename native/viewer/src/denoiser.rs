//! Viewer denoiser selection and its application to preview/final targets.
use mutracer_native_probe::api;
use std::sync::Arc;

#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
pub enum Choice {
    #[default]
    Oidn,
    Dlss,
}
impl Choice {
    pub fn label(self) -> &'static str {
        match self {
            Self::Oidn => "OIDN",
            Self::Dlss => "DLSS RR",
        }
    }
    pub fn temporal(self, available: bool, pinhole: bool) -> bool {
        self == Self::Dlss && available && pinhole
    }
}

pub fn configure(
    render_loop: &mut api::RenderLoop,
    enabled: bool,
    temporal: bool,
    filter: Option<&Arc<dyn api::CustomDenoiser>>,
) -> anyhow::Result<()> {
    render_loop.coalesce_scene_updates = enabled;
    if temporal {
        let filter = filter.ok_or_else(|| anyhow::anyhow!("DLSS RR is unavailable"))?;
        for render in [Some(render_loop.final_render()), render_loop.preview()]
            .into_iter()
            .flatten()
        {
            render.set_custom_denoiser(
                enabled.then(|| filter.clone()),
                api::DenoiseSchedule::EverySample,
            )?;
        }
    } else {
        if let Some(preview) = render_loop.preview() {
            preview.set_denoiser(if enabled {
                Some(preview_oidn_options()?)
            } else {
                None
            })?;
        }
        render_loop
            .final_render()
            .set_denoiser(enabled.then(|| api::DenoiserOptions {
                max_tile_size: 512,
                backend: api::DENOISE_OIDN_WEBGPU,
                schedule: api::DenoiseSchedule::Progressive,
                ..Default::default()
            }))?;
    }
    Ok(())
}

/// Browser viewer policy: one fresh sample per moving preview, with its smaller
/// OIDN network. Final convergence keeps the standard network.
pub fn preview_settings() -> api::RenderSettings {
    api::RenderSettings {
        max_samples: 1,
        ..api::RenderLoop::preview_settings()
    }
}
pub fn preview_oidn_options() -> anyhow::Result<api::DenoiserOptions> {
    let name = "rt_hdr_alb_nrm_small.tza";
    let path = crate::bundled_asset(
        name,
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../oidn/weights")
            .join(name),
    );
    anyhow::ensure!(
        path.is_file(),
        "Missing OIDN preview model; extract the complete application archive"
    );
    Ok(api::DenoiserOptions {
        backend: api::DENOISE_OIDN_WEBGPU,
        library: Some(path),
        max_tile_size: 512,
        schedule: api::DenoiseSchedule::EverySample,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selection_requires_available_rr_and_pinhole_without_losing_user_choice() {
        assert_eq!(Choice::default(), Choice::Oidn);
        assert!(!Choice::Oidn.temporal(true, true));
        let choice = Choice::Dlss;
        assert!(!choice.temporal(false, true));
        assert!(!choice.temporal(true, false));
        assert!(choice.temporal(true, true));
        assert_eq!(choice, Choice::Dlss);
    }
    #[test]
    fn moving_preview_uses_one_sample_and_the_small_every_sample_model() {
        let settings = preview_settings();
        assert_eq!(settings.max_samples, 1);
        assert_eq!(settings.size, api::RenderSize::Scale(0.5));
        assert_eq!(settings.bounces, 2);
        let filter = preview_oidn_options().unwrap();
        assert_eq!(filter.schedule, api::DenoiseSchedule::EverySample);
        assert_eq!(filter.backend, api::DENOISE_OIDN_WEBGPU);
        assert_eq!(
            filter.library.unwrap().file_name().unwrap(),
            "rt_hdr_alb_nrm_small.tza"
        );
    }
}
