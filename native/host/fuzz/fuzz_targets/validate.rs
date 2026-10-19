#![no_main]
libfuzzer_sys::fuzz_target!(|bytes: &[u8]| {
    mutracer_native_probe::fuzzing::validate(bytes);
});
