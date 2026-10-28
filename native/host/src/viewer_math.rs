//! Low-frequency viewer math from the existing shared TS AOT core.
use crate::Result;
unsafe extern "C" {
    fn mt_core_viewer_math(
        kind: u32,
        bytes: *const u8,
        length: usize,
        output: *mut *const u8,
        size: *mut usize,
    );
}
pub(crate) fn values(kind: u32, args: &[f64]) -> Result<Vec<f64>> {
    let bytes: Vec<u8> = bytemuck::cast_slice(args).to_vec();
    crate::runtime::call(move || {
        let mut pointer = std::ptr::null();
        let mut length = 0;
        unsafe {
            mt_core_viewer_math(kind, bytes.as_ptr(), bytes.len(), &mut pointer, &mut length)
        };
        let data = unsafe { crate::copy_core_result(pointer, length, length)? };
        unsafe { crate::mt_core_collect() };
        Ok(serde_json::from_slice(&data)?)
    })
}
pub fn sun_position(hours: f32) -> [f32; 2] {
    let v = values(0, &[hours as f64]).expect("Shared solar path");
    [v[0] as f32, v[1] as f32]
}
pub fn studio_panel(args: [f64; 14]) -> [f64; 15] {
    values(1, &args)
        .expect("Shared studio placement")
        .try_into()
        .expect("Studio panel shape")
}
pub fn studio_ambient() -> Vec<f32> {
    values(2, &[])
        .expect("Shared studio ambient")
        .into_iter()
        .map(|v| v as f32)
        .collect()
}
