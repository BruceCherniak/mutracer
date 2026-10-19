//! Fixed-sample software/HWRT first-hit records for the same primary rays.
fn main() -> Result<(), Box<dyn std::error::Error>> {
    mutracer_native_probe::logging::stderr();
    let args: Vec<_> = std::env::args_os().collect();
    if args.len() != 3 {
        return Err("Usage: hit-diagnostics INPUT_DESCRIPTOR OUTPUT_DIRECTORY".into());
    }
    mutracer_native_probe::hit_diagnostics::run(
        &std::fs::read(&args[1])?,
        std::path::Path::new(&args[2]),
    )
}
