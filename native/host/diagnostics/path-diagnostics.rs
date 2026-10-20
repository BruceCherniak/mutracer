fn main() -> Result<(), Box<dyn std::error::Error>> {
    mutracer_native_probe::logging::stderr();
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 4 {
        return Err(
            "Usage: path-diagnostics INPUT_DESCRIPTOR OUTPUT_DIRECTORY BACKEND(0|1)".into(),
        );
    }
    mutracer_native_probe::path_diagnostics::run(
        &std::fs::read(&args[1])?,
        std::path::Path::new(&args[2]),
        args[3].parse()?,
    )
}
