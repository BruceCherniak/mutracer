//! Shared CPU admission limits. GPU checks run before allocating any target.
use crate::Result;
pub(crate) const MAX_EDGE: u32 = 8192;
pub(crate) const MAX_PIXELS: u64 = 16_777_216;
pub(crate) fn valid(size: [u32; 2]) -> bool {
    size.iter().all(|&n| n > 0 && n <= MAX_EDGE)
        && u64::from(size[0]) * u64::from(size[1]) <= MAX_PIXELS
}
pub(crate) fn validate_target(size: [u32; 2], limits: &wgpu::Limits) -> Result<()> {
    if !valid(size) {
        return Err("Output dimensions require edges 1..8192 and at most 16,777,216 pixels".into());
    }
    let bytes = u64::from(size[0]) * u64::from(size[1]) * 48;
    if bytes > limits.max_buffer_size || bytes > u64::from(limits.max_storage_buffer_binding_size) {
        return Err(format!(
            "Output requires a {bytes}-byte storage buffer; this device allows {} bytes",
            limits
                .max_buffer_size
                .min(u64::from(limits.max_storage_buffer_binding_size))
        )
        .into());
    }
    if size.iter().any(|&n| {
        n > limits.max_texture_dimension_2d
            || n.div_ceil(8) > limits.max_compute_workgroups_per_dimension
    }) {
        return Err("Output dimensions exceed this device's texture or dispatch limits".into());
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn image_boundaries_and_gpu_limits() {
        for size in [[3840, 2160], [4096, 4096], [8192, 2048]] {
            assert!(valid(size));
        }
        for size in [[0, 1], [8193, 1], [8192, 2049], [u32::MAX, u32::MAX]] {
            assert!(!valid(size));
        }
        let mut limits = wgpu::Limits::default();
        assert!(validate_target([3840, 2160], &limits).is_err());
        limits.max_storage_buffer_binding_size = 1024 * 1024 * 1024;
        limits.max_buffer_size = 1024 * 1024 * 1024;
        assert!(validate_target([3840, 2160], &limits).is_ok());
        limits.max_texture_dimension_2d = 2048;
        assert!(validate_target([3840, 2160], &limits).is_err());
        limits.max_texture_dimension_2d = 8192;
        limits.max_compute_workgroups_per_dimension = 100;
        assert!(validate_target([3840, 2160], &limits).is_err());
    }
}
