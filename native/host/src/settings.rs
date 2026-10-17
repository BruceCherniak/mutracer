//! C fields are copied into the TS settings record; normalization stays in TS.
use super::*;
use crate::layout::{WORD_BYTES, settings as wire};

#[repr(C)]
#[derive(Clone, Copy)]
pub struct RenderSettings {
    pub struct_size: u32,
    pub sampling_pattern: u32,
    pub seed: u32,
    pub max_samples: u32,
    pub bounces: f64,
    pub direct_light_candidates: f64,
    pub bevel_samples: f64,
    pub clamping: f64,
    pub transmissive_output_alpha_min: f64,
    pub sample_sequence_offset: u32,
    pub reserved: u32,
}
impl Default for RenderSettings {
    fn default() -> Self {
        Self {
            struct_size: std::mem::size_of::<Self>() as u32,
            sampling_pattern: 0,
            seed: 12345,
            max_samples: 64,
            bounces: 6.,
            direct_light_candidates: 2.,
            bevel_samples: 8.,
            clamping: 0.,
            transmissive_output_alpha_min: 1.,
            sample_sequence_offset: 0,
            reserved: 0,
        }
    }
}
impl RenderSettings {
    pub(super) fn wire(&self, variants: u32) -> Result<Vec<u8>> {
        if self.struct_size as usize != std::mem::size_of::<Self>() || self.reserved != 0 {
            return Err("Invalid render settings size/reserved field".into());
        }
        let mut bytes = vec![0; wire::WORDS * WORD_BYTES];
        for (field, value) in [
            (wire::STRUCT_SIZE, self.struct_size),
            (wire::SAMPLING_PATTERN, self.sampling_pattern),
            (wire::SEED, self.seed),
            (wire::MAX_SAMPLES, self.max_samples),
            (wire::SEQUENCE_OFFSET, self.sample_sequence_offset),
            (wire::VARIANTS, variants),
        ] {
            bytes[field * WORD_BYTES..(field + 1) * WORD_BYTES]
                .copy_from_slice(&value.to_le_bytes());
        }
        for (field, value) in [
            (wire::BOUNCES, self.bounces),
            (wire::DIRECT_LIGHT_CANDIDATES, self.direct_light_candidates),
            (wire::BEVEL_SAMPLES, self.bevel_samples),
            (wire::CLAMPING, self.clamping),
            (
                wire::TRANSMISSIVE_ALPHA_MIN,
                self.transmissive_output_alpha_min,
            ),
        ] {
            bytes[field * WORD_BYTES..(field + 2) * WORD_BYTES]
                .copy_from_slice(&value.to_le_bytes());
        }
        Ok(bytes)
    }
}
/// # Safety
/// Non-null output must be writable for a complete RenderSettings.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_render_settings_default(output: *mut RenderSettings) -> i32 {
    if output.is_null() {
        return 1;
    }
    unsafe {
        *output = RenderSettings::default();
    }
    0
}
