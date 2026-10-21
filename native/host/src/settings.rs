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
    pub bounces: u32,
    pub direct_light_candidates: u32,
    pub bevel_samples: u32,
    pub sample_sequence_offset: u32,
    pub clamping: f64,
    pub transmissive_output_alpha_min: f64,
}
impl Default for RenderSettings {
    fn default() -> Self {
        Self {
            struct_size: std::mem::size_of::<Self>() as u32,
            sampling_pattern: 0,
            seed: 12345,
            max_samples: 64,
            bounces: 6,
            direct_light_candidates: 2,
            bevel_samples: 8,
            sample_sequence_offset: 0,
            clamping: 0.,
            transmissive_output_alpha_min: 1.,
        }
    }
}
impl RenderSettings {
    // The internal wire record keeps f64 counts and its own size; TS clamps them.
    pub(super) fn wire(&self, variants: u32) -> Result<Vec<u8>> {
        if self.struct_size as usize != std::mem::size_of::<Self>() {
            return Err(fail(
                Status::InvalidArgument,
                "mt_render_settings.struct_size must be sizeof(mt_render_settings)",
            ));
        }
        let mut bytes = vec![0; wire::WORDS * WORD_BYTES];
        for (field, value) in [
            (wire::STRUCT_SIZE, (wire::WORDS * WORD_BYTES) as u32),
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
            (wire::BOUNCES, f64::from(self.bounces)),
            (
                wire::DIRECT_LIGHT_CANDIDATES,
                f64::from(self.direct_light_candidates),
            ),
            (wire::BEVEL_SAMPLES, f64::from(self.bevel_samples)),
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
        return crate::Status::InvalidArgument as i32;
    }
    unsafe {
        *output = RenderSettings::default();
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn c_struct_layout_and_wire_conversion() {
        // Mirrors the _Static_assert in mutracer-context.h.
        assert_eq!(std::mem::size_of::<RenderSettings>(), 48);
        assert_eq!(std::mem::offset_of!(RenderSettings, clamping), 32);
        let settings = RenderSettings {
            bounces: 7,
            ..Default::default()
        };
        let bytes = settings.wire(0).unwrap();
        let word = |i: usize| u32::from_le_bytes(bytes[i * 4..i * 4 + 4].try_into().unwrap());
        let double = |i: usize| f64::from_le_bytes(bytes[i * 4..i * 4 + 8].try_into().unwrap());
        assert_eq!(word(wire::STRUCT_SIZE) as usize, wire::WORDS * WORD_BYTES);
        assert_eq!(double(wire::BOUNCES), 7.);
        assert_eq!(double(wire::TRANSMISSIVE_ALPHA_MIN), 1.);
        let wrong = RenderSettings {
            struct_size: 64,
            ..Default::default()
        };
        assert!(wrong.wire(0).is_err());
    }
}
